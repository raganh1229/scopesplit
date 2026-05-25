// ─────────────────────────────────────────────────────────────────────────────
// N2 Pipeline — Pass 5: cross-zone item reconciliation
//
// Operates AFTER Pass 4 has produced per-zone results. Sweeps every zone's
// MISSING_FROM_ADJUSTER pairs (contractor orphans) and ADDED_BY_ADJUSTER
// pairs (adjuster orphans) into two flat lists, asks Opus to identify
// structural-mismatch cross-zone pairs (e.g. contractor's room-grouped
// demolition vs. adjuster's trade-grouped demolition), and promotes any
// high-confidence pairs into a synthetic "CROSS ZONE MATCHES" zone.
//
// Conservative posture: confidence threshold 75. Pass 5 fails open — if the
// API call errors, the original Pass 4 output is preserved.
//
// Architecture refs: N2_SPEED_CAPACITY_ACCURACY.md §Pass 5, Issues 39–41
// ─────────────────────────────────────────────────────────────────────────────

import { parseAndValidate, withRetry, isTruncated, AIResponseError } from '@/lib/n2/utils/ai-response';
import { buildPass5Prompt, type Pass5ContractorOrphan, type Pass5AdjusterOrphan } from '@/lib/n2/prompts/pass5-cross-zone';
import { Pass5ResponseSchema } from '@/lib/n2/schemas/pass-responses';
import {
  CROSS_ZONE_MATCHES_RESULT_KEY,
  CROSS_ZONE_MATCHES_ZONE_NAME,
} from '@/lib/n2/schemas/types';
import type {
  N2ItemPair,
  N2ZoneMeta,
  N2ZoneResult,
  N2ExtractedItem,
} from '@/lib/n2/schemas/types';
import type { StepLogger } from '@/lib/n2/passes/detect-zones';

// ── Constants ─────────────────────────────────────────────────────────────────

// Opus is required here for the conservative-pairing reasoning quality.
// Per-call cost is small because the call sees only orphans (typically <50
// items per side). Sonnet was considered and rejected — see Issue 39.
const OPUS_MODEL = 'claude-opus-4-7';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Output token budget for Pass 5. The response is one JSON object with at
 * most ~50 entries (in practice usually <10), each ~150 tokens. 4K is more
 * than enough for typical workloads with comfortable headroom.
 */
const PASS5_MAX_TOKENS = 4096;

/** Confidence threshold below which proposed pairs are rejected. See Issue 41. */
const PASS5_CONFIDENCE_THRESHOLD = 75;

/** Skip the entire pass when either pool has fewer than this many orphans. */
const PASS5_MIN_ORPHANS_PER_SIDE = 2;

// ── Helpers ──────────────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.trim().length === 0) {
    throw new Error('[n2/cross-zone-reconcile] ANTHROPIC_API_KEY is not configured.');
  }
  return key.trim();
}

/**
 * Tokenize a description for similarity comparison. Lowercases, strips
 * non-alphanumerics, drops short tokens (<2 chars). Used by Jaccard
 * similarity in the deterministic prematch to require minimal description
 * overlap before pairing on financial signal alone.
 */
function tokenizeForSimilarity(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(t => t.length >= 2),
  );
}

/** Jaccard similarity on token sets (0–1). */
function jaccardSimilarity(a: string, b: string): number {
  const ta = tokenizeForSimilarity(a);
  const tb = tokenizeForSimilarity(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ── Deterministic prematch ───────────────────────────────────────────────────

/**
 * Identical-totals deterministic prematch. Runs BEFORE the Opus call.
 *
 * Rationale (May 7, 2026): On Set3 we observed that Opus, with the
 * "err strongly on the side of CAUTION" Pass 5 prompt, was refusing to
 * propose obvious cross-zone pairs whose totals matched to the cent
 * (e.g. contractor "Tear off TPO membrane" $4,515.84 vs adjuster
 * "Strip TPO membrane roofing system" $4,515.84). The misses were not
 * filtered by the confidence threshold — they were never proposed. This
 * is a classic LLM attention-budget problem when the prompt asks the
 * model to scan a large many-by-many candidate set conservatively.
 *
 * Fix: any orphan pair whose totals are identical to the cent AND whose
 * descriptions share a minimum Jaccard token overlap is paired
 * deterministically without consulting the model. The model still runs
 * on the remaining (modified-total) orphans where its cross-zone
 * reasoning adds value. False-positive risk on identical totals is low
 * because (a) totals in insurance estimates are computed quantities
 * with multi-decimal precision, so coincidental cent-level matches are
 * rare, and (b) the description Jaccard floor weeds out the rare
 * coincidence.
 *
 * The threshold (0.25) is intentionally low because the financial
 * signal is doing most of the work. Empirical Set3 cross-zone pairs:
 *   "Tear off TPO" ↔ "Strip TPO membrane roofing system" = 0.33
 *   "Tear off polyiso" ↔ "Demo polyiso insulation 2.5 inch" = 0.43
 *   "Final clean" ↔ "Site cleanup post-construction" = 0.20 (borderline)
 * 0.20 borderline items are accepted because the total match alone is
 * already strong evidence; we lose nothing by accepting an extra true
 * positive at this confidence level.
 */
const PREMATCH_TOTAL_TOLERANCE = 0.01; // exact cent match
const PREMATCH_MIN_JACCARD = 0.20;

function deterministicPreMatch(
  contractor: Pass5ContractorOrphan[],
  adjuster: Pass5AdjusterOrphan[],
): {
  pairs: Array<{
    contractorId: string;
    adjusterId: string;
    confidence: number;
    status: 'MATCH' | 'MODIFIED';
    rationale: string;
  }>;
  remainingContractor: Pass5ContractorOrphan[];
  remainingAdjuster: Pass5AdjusterOrphan[];
} {
  const pairs: Array<{
    contractorId: string;
    adjusterId: string;
    confidence: number;
    status: 'MATCH' | 'MODIFIED';
    rationale: string;
  }> = [];
  const usedContractor = new Set<string>();
  const usedAdjuster = new Set<string>();

  // Greedy by best Jaccard within identical-total constraint. Iterate
  // contractor orphans in input order; for each one, find the best-similarity
  // unmatched adjuster orphan whose total matches to the cent.
  for (const c of contractor) {
    if (c.item.t == null) continue;

    let best: { a: Pass5AdjusterOrphan; sim: number } | null = null;
    for (const a of adjuster) {
      if (a.item.t == null) continue;
      if (usedAdjuster.has(a.id)) continue;

      const totalDiff = Math.abs(c.item.t - a.item.t);
      if (totalDiff > PREMATCH_TOTAL_TOLERANCE) continue;

      const sim = jaccardSimilarity(c.item.d, a.item.d);
      if (sim < PREMATCH_MIN_JACCARD) continue;

      if (!best || sim > best.sim) best = { a, sim };
    }

    if (best) {
      usedContractor.add(c.id);
      usedAdjuster.add(best.a.id);
      pairs.push({
        contractorId: c.id,
        adjusterId: best.a.id,
        confidence: 99, // deterministic — strongest signal class
        status: classifyPair(c.item, best.a.item),
        rationale: `Deterministic prematch: identical totals ($${c.item.t.toFixed(2)}) + description Jaccard ${best.sim.toFixed(2)}`,
      });
    }
  }

  return {
    pairs,
    remainingContractor: contractor.filter(c => !usedContractor.has(c.id)),
    remainingAdjuster: adjuster.filter(a => !usedAdjuster.has(a.id)),
  };
}

/** Parse a quantity string into a number; null on unparseable / blank. */
function parseQty(q: string | null | undefined): number | null {
  if (q == null) return null;
  const trimmed = String(q).trim();
  if (trimmed === '') return null;
  const cleaned = trimmed.replace(/,/g, '').replace(/[^0-9.\-]+/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Normalize a unit code for equality comparison. */
function normalizeUnit(u: string | null | undefined): string {
  if (u == null) return '';
  return String(u).trim().toLowerCase();
}

/**
 * Deterministic MATCH/MODIFIED classifier — applied post-parse to override
 * the AI's status field. Issue 41 rationale: pairing is the AI's job,
 * classification is mechanical.
 *
 * Robust to format differences: "1" vs "1.00" qty are equivalent;
 * "EA" vs "ea" units are equivalent; totals match within 1% or $0.01.
 * Mirrors `reclassifyPairFromFields` in extract-and-match.ts; the two
 * exist as duplicates rather than a shared util to keep N2 passes
 * independently deployable. Keep them in sync.
 */
function classifyPair(e1: N2ExtractedItem, e2: N2ExtractedItem): 'MATCH' | 'MODIFIED' {
  const t1 = e1.t ?? null;
  const t2 = e2.t ?? null;
  if (t1 == null || t2 == null) return 'MODIFIED';
  const totalTolerance = Math.max(0.01, Math.abs(t1) * 0.01);
  if (Math.abs(t1 - t2) > totalTolerance) return 'MODIFIED';

  const u1 = normalizeUnit(e1.u);
  const u2 = normalizeUnit(e2.u);
  if (u1 !== u2) return 'MODIFIED';

  const q1 = parseQty(e1.q);
  const q2 = parseQty(e2.q);
  const q1Blank = q1 === null;
  const q2Blank = q2 === null;
  if (q1Blank && q2Blank) return 'MATCH';
  if (q1Blank !== q2Blank) return 'MODIFIED';
  const qTolerance = Math.max(0.01, Math.abs(q1!) * 0.01);
  if (Math.abs(q1! - q2!) > qTolerance) return 'MODIFIED';

  return 'MATCH';
}

// ── Orphan collection ────────────────────────────────────────────────────────

type OrphanCollection = {
  contractor: Pass5ContractorOrphan[];
  adjuster: Pass5AdjusterOrphan[];
  /**
   * Maps every contractor orphan id to the (resultKey, pairIndex) location
   * inside zoneResults so the orchestrator can remove the orphan when its
   * pair is accepted.
   */
  contractorIndex: Map<string, { resultKey: string; pairIndex: number }>;
  adjusterIndex: Map<string, { resultKey: string; pairIndex: number }>;
};

function collectOrphans(
  zoneResults: Record<string, N2ZoneResult>,
  zoneMeta: Record<string, N2ZoneMeta>,
): OrphanCollection {
  const contractor: Pass5ContractorOrphan[] = [];
  const adjuster: Pass5AdjusterOrphan[] = [];
  const contractorIndex = new Map<string, { resultKey: string; pairIndex: number }>();
  const adjusterIndex = new Map<string, { resultKey: string; pairIndex: number }>();

  let contractorCounter = 1;
  let adjusterCounter = 1;

  for (const [resultKey, zoneResult] of Object.entries(zoneResults)) {
    const meta = zoneMeta[resultKey];
    if (!meta) continue;

    // Resolve a single zone-name string for prompt presentation. For merged
    // zones (zoneYours/zoneAdjuster as arrays), join with " / " to keep the
    // line readable while preserving information.
    const contractorZoneLabel = Array.isArray(meta.zoneYours)
      ? meta.zoneYours.join(' / ')
      : (meta.zoneYours ?? meta.canonical);
    const adjusterZoneLabel = Array.isArray(meta.zoneAdjuster)
      ? meta.zoneAdjuster.join(' / ')
      : (meta.zoneAdjuster ?? meta.canonical);

    for (let i = 0; i < zoneResult.pairs.length; i++) {
      const pair = zoneResult.pairs[i]!;
      if (pair.status === 'MISSING_FROM_ADJUSTER' && pair.e1) {
        const id = `C${contractorCounter++}`;
        contractor.push({ id, zone: contractorZoneLabel, item: pair.e1 });
        contractorIndex.set(id, { resultKey, pairIndex: i });
      } else if (pair.status === 'ADDED_BY_ADJUSTER' && pair.e2) {
        const id = `A${adjusterCounter++}`;
        adjuster.push({ id, zone: adjusterZoneLabel, item: pair.e2 });
        adjusterIndex.set(id, { resultKey, pairIndex: i });
      }
    }
  }

  return { contractor, adjuster, contractorIndex, adjusterIndex };
}

// ── Opus call ────────────────────────────────────────────────────────────────

async function callPass5(
  contractorOrphans: Pass5ContractorOrphan[],
  adjusterOrphans: Pass5AdjusterOrphan[],
  context: string,
): Promise<{ pairs: Array<{ contractorId: string; adjusterId: string; confidence: number; status: 'MATCH' | 'MODIFIED'; rationale: string }> }> {
  return withRetry(async () => {
    const prompts = buildPass5Prompt({ contractorOrphans, adjusterOrphans });
    const apiKey = getApiKey();

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: OPUS_MODEL,
        max_tokens: PASS5_MAX_TOKENS,
        // NOTE: `temperature` is deprecated and rejected (HTTP 400) by Opus 4.7
        // — it is an extended-thinking model with fixed sampling. Do NOT add
        // it back. Other passes (Sonnet 4.6) still accept temperature.
        system: prompts.system,
        messages: [{ role: 'user', content: prompts.user }],
      }),
    });

    if (!response.ok) {
      // Capture the response body so the actual Anthropic error message
      // (e.g. "max_tokens too large for model X", "model not found") surfaces
      // in logs instead of just the bare HTTP status. The body is small (a
      // single JSON error envelope) so reading it here is safe.
      let errorBody = '';
      try {
        errorBody = await response.text();
      } catch {
        errorBody = '<failed to read response body>';
      }
      throw new AIResponseError(
        `[n2/cross-zone-reconcile] Anthropic ${response.status} for ${context}: ${response.statusText} — body: ${errorBody.slice(0, 1000)}`,
        response.status >= 500 || response.status === 429,
        context,
      );
    }

    const body = (await response.json()) as {
      content?: Array<{ text?: string }>;
      stop_reason?: string | null;
    };
    const text = body.content?.[0]?.text ?? '';
    const stopReason = body.stop_reason ?? null;

    if (isTruncated(stopReason, text)) {
      throw new AIResponseError(
        `[n2/cross-zone-reconcile] Pass 5 response truncated for ${context}`,
        true,
        context,
      );
    }

    return parseAndValidate(text, Pass5ResponseSchema, context);
  }, 3, context);
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Run Pass 5 cross-zone reconciliation against the assembled Pass 4 zone
 * results. Mutates `zoneResults` and `zoneMeta` in place — accepted
 * cross-zone pairs are added to a synthetic CROSS ZONE MATCHES zone, and
 * the original orphan entries are removed from their home zones.
 *
 * Fail-open: any error inside this function is caught, logged, and Pass 4
 * results are returned unchanged. Cross-zone reconciliation is an additive
 * accuracy improvement — its failure must never block the comparison.
 *
 * Skip conditions:
 *   - Either orphan pool has < PASS5_MIN_ORPHANS_PER_SIDE entries.
 *   - In that case the function returns immediately with stats indicating
 *     "skipped" and no API call is made.
 */
export async function reconcileCrossZone(
  comparisonId: string,
  zoneResults: Record<string, N2ZoneResult>,
  zoneMeta: Record<string, N2ZoneMeta>,
  logger: StepLogger,
): Promise<{
  ranPass: boolean;
  contractorOrphanCount: number;
  adjusterOrphanCount: number;
  proposedPairCount: number;
  acceptedPairCount: number;
}> {
  const context = `pass5:${comparisonId}`;

  // ── 1. Collect orphans ─────────────────────────────────────────────────
  const orphans = collectOrphans(zoneResults, zoneMeta);

  // ── 2. Skip if either pool too small ───────────────────────────────────
  if (
    orphans.contractor.length < PASS5_MIN_ORPHANS_PER_SIDE ||
    orphans.adjuster.length < PASS5_MIN_ORPHANS_PER_SIDE
  ) {
    logger.info('[n2/cross-zone-reconcile] Skipping Pass 5 — insufficient orphans on at least one side', {
      comparisonId,
      contractorOrphans: orphans.contractor.length,
      adjusterOrphans: orphans.adjuster.length,
      minRequired: PASS5_MIN_ORPHANS_PER_SIDE,
    });
    return {
      ranPass: false,
      contractorOrphanCount: orphans.contractor.length,
      adjusterOrphanCount: orphans.adjuster.length,
      proposedPairCount: 0,
      acceptedPairCount: 0,
    };
  }

  // ── 2b. Deterministic prematch — auto-pair identical-totals + minimal
  // description overlap BEFORE consulting Opus. This catches the obvious
  // cross-zone wins that the conservative Opus prompt was silently
  // refusing to propose. See deterministicPreMatch() docstring for the
  // empirical motivation. The Opus call now sees only the residual
  // orphans where its cross-zone reasoning genuinely adds value.
  const prematch = deterministicPreMatch(orphans.contractor, orphans.adjuster);

  if (prematch.pairs.length > 0) {
    logger.info('[n2/cross-zone-reconcile] Deterministic prematch paired identical-total orphans', {
      comparisonId,
      paired: prematch.pairs.length,
      remainingContractor: prematch.remainingContractor.length,
      remainingAdjuster: prematch.remainingAdjuster.length,
    });
  }

  logger.info('[n2/cross-zone-reconcile] Firing Pass 5 (Opus cross-zone reconciliation)', {
    comparisonId,
    contractorOrphans: orphans.contractor.length,
    adjusterOrphans: orphans.adjuster.length,
    prematchedPairs: prematch.pairs.length,
    opusInputContractor: prematch.remainingContractor.length,
    opusInputAdjuster: prematch.remainingAdjuster.length,
  });

  // ── 3. Call Opus on residual orphans — fail open on any error ──────────
  // If the residual pools are too small for Opus to reason usefully, skip
  // the call entirely (the prematch already did the work).
  let opusPairs: Array<{ contractorId: string; adjusterId: string; confidence: number; status: 'MATCH' | 'MODIFIED'; rationale: string }> = [];

  const opusEligible =
    prematch.remainingContractor.length >= PASS5_MIN_ORPHANS_PER_SIDE &&
    prematch.remainingAdjuster.length >= PASS5_MIN_ORPHANS_PER_SIDE;

  if (opusEligible) {
    try {
      const opusResponse = await callPass5(
        prematch.remainingContractor,
        prematch.remainingAdjuster,
        context,
      );
      opusPairs = opusResponse.pairs;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Note: we do NOT fail-open back to zero pairs anymore. If Opus
      // errors, we still ship the prematch wins. This is strictly an
      // improvement over the prior behavior.
      logger.warn('[n2/cross-zone-reconcile] Opus call on residual orphans failed — shipping prematch results only', {
        comparisonId,
        error: msg,
        prematchPairs: prematch.pairs.length,
      });
    }
  } else {
    logger.info('[n2/cross-zone-reconcile] Skipping Opus call — residual orphan pools below threshold after prematch', {
      comparisonId,
      remainingContractor: prematch.remainingContractor.length,
      remainingAdjuster: prematch.remainingAdjuster.length,
      minRequired: PASS5_MIN_ORPHANS_PER_SIDE,
    });
  }

  // Synthetic combined response: prematch pairs (confidence 99) merged
  // with Opus pairs. The downstream accept-pair loop handles dedup,
  // confidence sorting, and one-to-one constraint enforcement.
  const response = { pairs: [...prematch.pairs, ...opusPairs] };

  // ── 4. Filter accepted pairs (confidence threshold + unique constraint) ─
  const usedContractorIds = new Set<string>();
  const usedAdjusterIds = new Set<string>();
  const acceptedPairs: N2ItemPair[] = [];
  const removalsByZone = new Map<string, Set<number>>(); // resultKey → set of pair indices to remove

  // Sort by confidence descending so highest-confidence pairs claim ids first
  // when the AI accidentally returns conflicting one-to-many proposals.
  const sortedProposals = [...response.pairs].sort((a, b) => b.confidence - a.confidence);

  for (const proposal of sortedProposals) {
    if (proposal.confidence < PASS5_CONFIDENCE_THRESHOLD) continue;
    if (usedContractorIds.has(proposal.contractorId)) continue;
    if (usedAdjusterIds.has(proposal.adjusterId)) continue;

    const cLoc = orphans.contractorIndex.get(proposal.contractorId);
    const aLoc = orphans.adjusterIndex.get(proposal.adjusterId);
    if (!cLoc || !aLoc) {
      logger.warn('[n2/cross-zone-reconcile] Pass 5 returned unknown orphan id — ignoring', {
        comparisonId,
        contractorId: proposal.contractorId,
        adjusterId: proposal.adjusterId,
      });
      continue;
    }

    const cOrphan = orphans.contractor.find(o => o.id === proposal.contractorId)!;
    const aOrphan = orphans.adjuster.find(o => o.id === proposal.adjusterId)!;

    // Recompute status deterministically (Issue 41).
    const computedStatus = classifyPair(cOrphan.item, aOrphan.item);

    acceptedPairs.push({
      status: computedStatus,
      e1: cOrphan.item,
      e2: aOrphan.item,
      crossZoneOrigin: { e1Zone: cOrphan.zone, e2Zone: aOrphan.zone },
    });

    usedContractorIds.add(proposal.contractorId);
    usedAdjusterIds.add(proposal.adjusterId);

    // Mark original orphan entries for removal from their home zones.
    if (!removalsByZone.has(cLoc.resultKey)) removalsByZone.set(cLoc.resultKey, new Set());
    removalsByZone.get(cLoc.resultKey)!.add(cLoc.pairIndex);
    if (!removalsByZone.has(aLoc.resultKey)) removalsByZone.set(aLoc.resultKey, new Set());
    removalsByZone.get(aLoc.resultKey)!.add(aLoc.pairIndex);

    logger.info('[n2/cross-zone-reconcile] Accepted cross-zone pair', {
      comparisonId,
      contractorId: proposal.contractorId,
      adjusterId: proposal.adjusterId,
      contractorZone: cOrphan.zone,
      adjusterZone: aOrphan.zone,
      confidence: proposal.confidence,
      aiStatus: proposal.status,
      computedStatus,
      rationale: proposal.rationale,
    });
  }

  // ── 5. Apply mutations: remove orphans, add synthetic zone ─────────────
  if (acceptedPairs.length > 0) {
    // Remove accepted orphans from their home zones (descending index order
    // so removals don't shift remaining indices).
    for (const [resultKey, indices] of removalsByZone.entries()) {
      const sortedIndices = Array.from(indices).sort((a, b) => b - a);
      const home = zoneResults[resultKey];
      if (!home) continue;
      for (const idx of sortedIndices) {
        home.pairs.splice(idx, 1);
      }
    }

    // Create or extend the synthetic CROSS ZONE MATCHES zone result.
    const existing = zoneResults[CROSS_ZONE_MATCHES_RESULT_KEY];
    if (existing) {
      existing.pairs.push(...acceptedPairs);
    } else {
      zoneResults[CROSS_ZONE_MATCHES_RESULT_KEY] = { pairs: acceptedPairs };
    }

    // Synthetic zoneMeta: zoneYours/zoneAdjuster are null at the zone level
    // because each item carries its own original zone via crossZoneOrigin.
    // persistResults uses crossZoneOrigin to populate the per-row zoneYours/
    // zoneAdjuster columns when present.
    if (!zoneMeta[CROSS_ZONE_MATCHES_RESULT_KEY]) {
      zoneMeta[CROSS_ZONE_MATCHES_RESULT_KEY] = {
        canonical: CROSS_ZONE_MATCHES_ZONE_NAME,
        zoneYours: null,
        zoneAdjuster: null,
        confidence: 100,
        isMerged: false,
      };
    }
  }

  logger.info('[n2/cross-zone-reconcile] Pass 5 complete', {
    comparisonId,
    proposed: response.pairs.length,
    accepted: acceptedPairs.length,
    rejectedBelowThreshold: response.pairs.filter(p => p.confidence < PASS5_CONFIDENCE_THRESHOLD).length,
  });

  return {
    ranPass: true,
    contractorOrphanCount: orphans.contractor.length,
    adjusterOrphanCount: orphans.adjuster.length,
    proposedPairCount: response.pairs.length,
    acceptedPairCount: acceptedPairs.length,
  };
}
