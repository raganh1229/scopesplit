// ─────────────────────────────────────────────────────────────────────────────
// N3 Pipeline — Phase 17: llm-adjudication
//
// For every `possible` decision remaining after Phase 16 (finalScore 0.30–0.55),
// asks Claude Sonnet to rule accept or reject in a single batched call.
//
// Algorithm:
//   1. Load all `possible` decisions.
//   2. Load source (yours) and target (adj) line items for each pair.
//   3. Build a single Sonnet prompt listing all pairs with their key features.
//   4. Parse structured JSON response:
//        { adjudications: [{index, decision, confidence, reasoning}] }
//   5. Apply decisions:
//        match    → decisionType one_to_one, decidedBy llm_adjudication
//        no_match → decisionType unmatched,  decidedBy llm_adjudication
//        (llmReasoning written to both outcomes for audit trail)
//   6. Write one N3LlmCall telemetry row.
//
// If there are no `possible` decisions this phase is a no-op.
//
// Architecture refs: N3.md §Phase 17, §A.3 (LLM as fallback, not primary).
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import prisma from '@/lib/prisma';
import { parseAndValidate, withRetry, isTruncated, AIResponseError } from '@/lib/n2/utils/ai-response';
import type { StepLogger } from '@/lib/n3/passes/detect-zones';
import { SCORE_THRESHOLDS } from '@/lib/n3/constants';

// ── Constants ─────────────────────────────────────────────────────────────────

const SONNET_MODEL      = 'claude-sonnet-4-6';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
// Output token budget.
// Each adjudication ruling is at most ~130 tokens of structured JSON:
//   index (~2 t) + decision (~3 t) + confidence (~2 t)
//   + reasoning (≤400 chars ≈ 100 t) + JSON field names/brackets/commas (~23 t).
// The outer {"adjudications":[...]} envelope adds a fixed ~50 tokens.
// Using 80 t/pair underestimates verbose batches; 130 t/pair is the true worst-case.
// When max_tokens is too small the response is truncated mid-JSON — the isTruncated
// retry cannot recover because the input is identical on every attempt.
// Ceiling at 32 768 to bound API cost; Sonnet 4-6 supports up to 64 000 output tokens.
const MAX_TOKENS_BASE     = 2_000;
const MAX_TOKENS_PER_PAIR = 130;    // ≤400-char reasoning (~100 t) + JSON structure (~30 t) per pair
const MAX_TOKENS_ENVELOPE = 50;     // outer {"adjudications":[...]} wrapper
const MAX_TOKENS_CEIL     = 32_768; // hard cap; well below Sonnet 4-6's 64 000-token output limit
function computeMaxTokens(pairCount: number): number {
  return Math.min(
    MAX_TOKENS_CEIL,
    Math.max(MAX_TOKENS_BASE, MAX_TOKENS_ENVELOPE + pairCount * MAX_TOKENS_PER_PAIR),
  );
}
// Claude Sonnet 4-6 pricing (per million tokens, USD)
const COST_PER_M_INPUT  = 3.0;
const COST_PER_M_OUTPUT = 15.0;

// ── Return type ───────────────────────────────────────────────────────────────

export type LlmAdjudicationN3Result = {
  adjudicatedCount:      number;
  acceptedCount:         number;
  rejectedCount:         number;
  autoRejectedCount:     number;  // cross-zone possibles auto-rejected before LLM (Tier 2)
  postLlmRescueCount:    number;  // pairs rescued after LLM rejection by mutual-best pass
  skippedByLlmCount:     number;  // pairs the LLM omitted from its JSON response (converted to unmatched)
  skipped:               boolean; // true when no `possible` decisions exist
};

// ── Zod schema for AI response ────────────────────────────────────────────────

const AdjudicationItemSchema = z.object({
  index:      z.number().int().min(0),
  decision:   z.enum(['match', 'no_match']),
  confidence: z.number().min(0).max(1),
  reasoning:  z.string().max(400),
});

const AdjudicationResponseSchema = z.object({
  adjudications: z.array(AdjudicationItemSchema),
});

// ── Prompt builder ────────────────────────────────────────────────────────────

type PairContext = {
  index:         number;
  decisionId:    string;
  yoursDesc:     string;
  yoursTrade:    string | null;
  yoursAction:   string | null;
  yoursQty:      string;
  yoursUnit:     string;
  yoursTotal:    string;
  yoursZone:     string | null;
  adjDesc:       string;
  adjTrade:      string | null;
  adjAction:     string | null;
  adjQty:        string;
  adjUnit:       string;
  adjTotal:      string;
  adjZone:       string | null;
  finalScore:    number;
};

function buildSystemPrompt(): string {
  return `You are a specialist in insurance property-damage estimates. \
Your task is to decide whether each pair of line items — one from a contractor's estimate \
("yours") and one from an insurance adjuster's estimate — represents the same scope of work.

Rules:
- Identical or near-identical descriptions → match
- Same trade/action with proportional quantities → match
- Fundamentally different work scopes → no_match
- ZONE RULE: If both items have a zone listed and the zones are different rooms/areas with
  no obvious equivalence, treat the zone mismatch as a strong signal against matching.
  Different zones + different quantities + different totals = no_match unless the description
  match is overwhelming and the zone names are near-synonyms.
- When genuinely ambiguous with matching zones, prefer match over no_match.

Respond ONLY with valid JSON matching this schema exactly:
{"adjudications":[{"index":0,"decision":"match","confidence":0.85,"reasoning":"brief explanation"},...]}`;
}

function buildUserPrompt(pairs: PairContext[]): string {
  const lines = pairs.map(p =>
    `[${p.index}]
  YOUR  | "${p.yoursDesc}" | zone: ${p.yoursZone ?? '—'} | trade: ${p.yoursTrade ?? '—'} | action: ${p.yoursAction ?? '—'} | qty: ${p.yoursQty} ${p.yoursUnit} | total: $${p.yoursTotal}
  ADJ   | "${p.adjDesc}" | zone: ${p.adjZone ?? '—'} | trade: ${p.adjTrade ?? '—'} | action: ${p.adjAction ?? '—'} | qty: ${p.adjQty} ${p.adjUnit} | total: $${p.adjTotal}
  score: ${p.finalScore.toFixed(3)}`
  );
  return `Evaluate the following ${pairs.length} candidate pair(s):\n\n${lines.join('\n\n')}`;
}

// ── API key helper ────────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key?.trim()) throw new Error('[n3/llm-adjudication] ANTHROPIC_API_KEY is not configured.');
  return key.trim();
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function llmAdjudicationN3(
  comparisonId: string,
  logger: StepLogger,
): Promise<LlmAdjudicationN3Result> {

  // ── 1. Load possible decisions ─────────────────────────────────────────────
  const possibleDecisions = await prisma.n3MatchDecision.findMany({
    where: { comparisonId, decisionType: 'possible' },
    select: { id: true, yourItemIds: true, adjusterItemIds: true, finalScore: true, topEdgeId: true },
  });

  if (possibleDecisions.length === 0) {
    logger.info('[n3/llm-adjudication] no possible decisions — skipping', { comparisonId });
    return { adjudicatedCount: 0, acceptedCount: 0, rejectedCount: 0, autoRejectedCount: 0, postLlmRescueCount: 0, skippedByLlmCount: 0, skipped: true };
  }

  // ── 2. Load line items (with zone name for Tier 1 zone-aware prompting) ─────────────
  const allItemIds = [
    ...possibleDecisions.flatMap(d => d.yourItemIds),
    ...possibleDecisions.flatMap(d => d.adjusterItemIds),
  ];
  const items = await prisma.n3LineItem.findMany({
    where: { id: { in: allItemIds } },
    select: {
      id: true, rawDescription: true, trade: true, action: true,
      normalizedQuantity: true, normalizedUnit: true, totalAmount: true,
      zone: { select: { name: true } },
    },
  });
  const itemMap = new Map(items.map(li => [li.id, li]));

  // ── 2b. Pre-LLM cross-zone auto-rejection (Tier 2) ───────────────────────────
  // Possible decisions whose assigned edge has an outside_verified penalty AND whose
  // yours item has a better non-rejected edge to a different adj item are rejected
  // algorithmically — without calling the LLM — freeing the rescue pass to find
  // the correct in-zone partner.
  const autoRejectedIds = new Set<string>();
  {
    const topEdgeIds = possibleDecisions
      .map(d => d.topEdgeId)
      .filter((id): id is string => id != null);

    const topEdges = topEdgeIds.length > 0
      ? await prisma.n3CandidateEdge.findMany({
          where: { id: { in: topEdgeIds } },
          select: { id: true, boostsJson: true },
        })
      : [];

    const topEdgeBoosts = new Map(topEdges.map(e => [e.id, e.boostsJson]));

    type BoostEntry = { type: string; value: number };
    const isCrossZone = (boostsJson: unknown): boolean =>
      Array.isArray(boostsJson) &&
      (boostsJson as BoostEntry[]).some(b => b.type === 'outside_verified');

    const crossZoneDecisions = possibleDecisions.filter(
      d => d.topEdgeId != null && isCrossZone(topEdgeBoosts.get(d.topEdgeId!)),
    );

    if (crossZoneDecisions.length > 0) {
      const crossZoneYoursIds = [...new Set(
        crossZoneDecisions.map(d => d.yourItemIds[0]).filter(Boolean),
      )];
      const altEdges = await prisma.n3CandidateEdge.findMany({
        where: { comparisonId, isRejected: false, sourceItemId: { in: crossZoneYoursIds } },
        select: { sourceItemId: true, targetItemId: true, finalScore: true },
      });

      const bestEdgeForYours = new Map<string, { adjId: string; score: number }>();
      for (const e of altEdges) {
        const score = Number(e.finalScore);
        const cur = bestEdgeForYours.get(e.sourceItemId);
        if (!cur || score > cur.score) {
          bestEdgeForYours.set(e.sourceItemId, { adjId: e.targetItemId, score });
        }
      }

      for (const d of crossZoneDecisions) {
        const yoursId  = d.yourItemIds[0];
        const curAdjId = d.adjusterItemIds[0];
        const best     = bestEdgeForYours.get(yoursId);
        if (best && best.adjId !== curAdjId && best.score > Number(d.finalScore)) {
          await prisma.n3MatchDecision.update({
            where: { id: d.id },
            data: {
              decisionType:    'unmatched',
              adjusterItemIds: [],
              finalScore:      0,
              topEdgeId:       null,
              decidedBy:       'pre_llm_zone_filter',
            },
          });
          autoRejectedIds.add(d.id);
        }
      }

      if (autoRejectedIds.size > 0) {
        logger.info('[n3/llm-adjudication] pre-LLM cross-zone auto-rejection', {
          comparisonId,
          autoRejected: autoRejectedIds.size,
        });
      }
    }
  }

  // ── 3. Build pair contexts (excluding auto-rejected decisions) ─────────────────
  const pairs: PairContext[] = [];
  for (const [i, d] of possibleDecisions.entries()) {
    if (autoRejectedIds.has(d.id)) continue;
    const yours = itemMap.get(d.yourItemIds[0]);
    const adj   = itemMap.get(d.adjusterItemIds[0]);
    if (!yours || !adj) continue;
    pairs.push({
      index:       i,
      decisionId:  d.id,
      yoursDesc:   yours.rawDescription,
      yoursTrade:  yours.trade,
      yoursAction: yours.action,
      yoursQty:    String(yours.normalizedQuantity ?? '?'),
      yoursUnit:   yours.normalizedUnit ?? '?',
      yoursTotal:  yours.totalAmount != null ? Number(yours.totalAmount).toFixed(2) : '?',
      yoursZone:   yours.zone?.name ?? null,
      adjDesc:     adj.rawDescription,
      adjTrade:    adj.trade,
      adjAction:   adj.action,
      adjQty:      String(adj.normalizedQuantity ?? '?'),
      adjUnit:     adj.normalizedUnit ?? '?',
      adjTotal:    adj.totalAmount != null ? Number(adj.totalAmount).toFixed(2) : '?',
      adjZone:     adj.zone?.name ?? null,
      finalScore:  Number(d.finalScore),
    });
  }

  if (pairs.length === 0) {
    logger.info('[n3/llm-adjudication] no valid pairs to adjudicate', { comparisonId });
    return { adjudicatedCount: 0, acceptedCount: 0, rejectedCount: 0, autoRejectedCount: autoRejectedIds.size, postLlmRescueCount: 0, skippedByLlmCount: 0, skipped: autoRejectedIds.size === 0 };
  }

  logger.info('[n3/llm-adjudication] calling Sonnet', { comparisonId, pairs: pairs.length });

  // ── 4. Call Sonnet ─────────────────────────────────────────────────────────
  const context  = `${comparisonId}/llm-adjudication`;
  const startMs  = Date.now();
  let promptTokens = 0, completionTokens = 0, callSuccess = true, callError: string | null = null;

  const parsed = await withRetry(
    async () => {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'content-type':     'application/json',
          'x-api-key':        getApiKey(),
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model:       SONNET_MODEL,
          max_tokens:  computeMaxTokens(pairs.length),
          temperature: 0,
          system:      buildSystemPrompt(),
          messages:    [{ role: 'user', content: buildUserPrompt(pairs) }],
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        throw new AIResponseError(
          `[n3/llm-adjudication] Anthropic ${response.status}: ${response.statusText}`,
          response.status >= 500 || response.status === 429,
          context,
        );
      }

      const body = (await response.json()) as {
        content?: Array<{ text?: string }>;
        stop_reason?: string | null;
        usage?: { input_tokens: number; output_tokens: number };
      };

      promptTokens     = body.usage?.input_tokens  ?? 0;
      completionTokens = body.usage?.output_tokens ?? 0;

      const text = body.content?.[0]?.text ?? '';
      if (isTruncated(body.stop_reason ?? null, text)) {
        throw new AIResponseError(
          '[n3/llm-adjudication] Response truncated — increase max_tokens',
          true,
          context,
        );
      }

      return parseAndValidate(text, AdjudicationResponseSchema, context);
    },
    3,
    context,
  ).catch(err => {
    callSuccess = false;
    callError   = err instanceof Error ? err.message.slice(0, 400) : String(err);
    throw err;
  });

  const durationMs = Date.now() - startMs;

  // ── 5. Write N3LlmCall telemetry ───────────────────────────────────────────
  const totalTokens = promptTokens + completionTokens;
  const estimatedCostUsd =
    (promptTokens / 1_000_000) * COST_PER_M_INPUT +
    (completionTokens / 1_000_000) * COST_PER_M_OUTPUT;

  await prisma.n3LlmCall.create({
    data: {
      comparisonId,
      phase:            'adjudication',
      model:            SONNET_MODEL,
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedCostUsd,
      durationMs,
      success:          callSuccess,
      errorMessage:     callError,
    },
  });

  // ── 6. Apply decisions ─────────────────────────────────────────────────────
  // Build index → decision row lookup
  const adjMap = new Map(parsed.adjudications.map(a => [a.index, a]));

  let acceptedCount = 0, rejectedCount = 0, skippedCount = 0;

  for (const pair of pairs) {
    const ruling = adjMap.get(pair.index);
    if (!ruling) {
      // Sonnet omitted this index. Convert to `unmatched` rather than leaving
      // the row as `possible`, which would silently default to MODIFIED in
      // Phase 18 (persist-decisions.ts:186) and surface to the user as a
      // confirmed price-different match.
      await prisma.n3MatchDecision.update({
        where: { id: pair.decisionId },
        data: {
          decisionType:    'unmatched',
          adjusterItemIds: [],
          finalScore:      0,
          topEdgeId:       null,
          decidedBy:       'llm_adjudication',
          llmReasoning:    'LLM did not return a ruling for this pair; treated as no_match.',
        },
      });
      skippedCount++;
      rejectedCount++;
      continue;
    }

    if (ruling.decision === 'match') {
      await prisma.n3MatchDecision.update({
        where: { id: pair.decisionId },
        data: {
          decisionType: 'one_to_one',
          decidedBy:    'llm_adjudication',
          llmReasoning: ruling.reasoning,
        },
      });
      acceptedCount++;
    } else {
      await prisma.n3MatchDecision.update({
        where: { id: pair.decisionId },
        data: {
          decisionType:    'unmatched',
          adjusterItemIds: [],
          finalScore:      0,
          topEdgeId:       null,
          decidedBy:       'llm_adjudication',
          llmReasoning:    ruling.reasoning,
        },
      });
      rejectedCount++;
    }
  }

  if (skippedCount > 0) {
    logger.info('[n3/llm-adjudication] LLM skipped some indices — converted to unmatched', {
      comparisonId,
      skippedCount,
    });
  }

  // ── 7. Post-LLM mutual-best rescue pass ───────────────────────────────────
  // Items whose `possible` decisions were rejected by LLM are now unmatched.
  // Some of those items may still have a mutual-best HIGH_CONFIDENCE edge to
  // another unmatched item — the LLM only evaluated them against wrong partners.
  // Rescue such pairs as one_to_one decisions without re-calling LLM.
  let postLlmRescueCount = 0;
  {
    // Load all contractor-unmatched decisions
    const unmatchedContrDecisions = await prisma.n3MatchDecision.findMany({
      where: { comparisonId, decisionType: 'unmatched' },
      select: { id: true, yourItemIds: true, adjusterItemIds: true },
    });
    const unmatchedYoursList = unmatchedContrDecisions.filter(
      d => d.yourItemIds.length > 0 && d.adjusterItemIds.length === 0,
    );
    const unmatchedYoursIds = unmatchedYoursList.map(d => d.yourItemIds[0]);

    // Find all adjuster item IDs currently claimed (non-empty adjusterItemIds)
    const allDecisions = await prisma.n3MatchDecision.findMany({
      where: { comparisonId },
      select: { adjusterItemIds: true },
    });
    const claimedAdjIds = new Set<string>();
    for (const d of allDecisions) {
      for (const id of d.adjusterItemIds) claimedAdjIds.add(id);
    }

    // All adjuster items not in any non-empty decision = unmatched adj
    const adjLineItems = await prisma.n3LineItem.findMany({
      where: { comparisonId, source: 'adjuster' },
      select: { id: true },
    });
    const unmatchedAdjIds = new Set(adjLineItems.map(a => a.id).filter(id => !claimedAdjIds.has(id)));

    if (unmatchedYoursIds.length > 0 && unmatchedAdjIds.size > 0) {
      // Load all non-rejected edges from unmatched contractor items
      const rescueEdges = await prisma.n3CandidateEdge.findMany({
        where: { comparisonId, isRejected: false, sourceItemId: { in: unmatchedYoursIds } },
        select: { id: true, sourceItemId: true, targetItemId: true, finalScore: true },
      });

      // Build best-edge maps (only considering edges to unmatched adj items)
      const bestYoursToAdj = new Map<string, { adjId: string; score: number; edgeId: string }>();
      for (const e of rescueEdges) {
        if (!unmatchedAdjIds.has(e.targetItemId)) continue;
        const score = Number(e.finalScore);
        const cur = bestYoursToAdj.get(e.sourceItemId);
        if (!cur || score > cur.score) bestYoursToAdj.set(e.sourceItemId, { adjId: e.targetItemId, score, edgeId: e.id });
      }
      const bestAdjToYours = new Map<string, { yoursId: string; score: number }>();
      for (const e of rescueEdges) {
        if (!unmatchedAdjIds.has(e.targetItemId)) continue;
        const score = Number(e.finalScore);
        const cur = bestAdjToYours.get(e.targetItemId);
        if (!cur || score > cur.score) bestAdjToYours.set(e.targetItemId, { yoursId: e.sourceItemId, score });
      }

      const rescuedAdjIds = new Set<string>();
      for (const d of unmatchedYoursList) {
        const yoursId = d.yourItemIds[0];
        const yBest = bestYoursToAdj.get(yoursId);
        if (!yBest || yBest.score < SCORE_THRESHOLDS.POSSIBLE_MATCH) continue;
        if (rescuedAdjIds.has(yBest.adjId)) continue;
        const aBest = bestAdjToYours.get(yBest.adjId);
        if (!aBest || aBest.yoursId !== yoursId) continue;  // not mutual-best

        // Mutual-best with sufficient confidence — rescue as one_to_one
        await prisma.n3MatchDecision.update({
          where: { id: d.id },
          data: {
            decisionType:    'one_to_one',
            adjusterItemIds: [yBest.adjId],
            finalScore:      yBest.score,
            topEdgeId:       yBest.edgeId,
            decidedBy:       'post_llm_rescue',
          },
        });
        rescuedAdjIds.add(yBest.adjId);
        postLlmRescueCount++;
      }
    }
  }

  if (postLlmRescueCount > 0) {
    logger.info('[n3/llm-adjudication] post-LLM rescue', { comparisonId, postLlmRescueCount });
  }

  logger.info('[n3/llm-adjudication] complete', {
    comparisonId,
    adjudicatedCount: pairs.length,
    acceptedCount,
    rejectedCount,
    postLlmRescueCount,
    promptTokens,
    completionTokens,
    estimatedCostUsd: estimatedCostUsd.toFixed(4),
    durationMs,
  });

  return {
    adjudicatedCount:  pairs.length,
    acceptedCount,
    rejectedCount,
    autoRejectedCount: autoRejectedIds.size,
    postLlmRescueCount,
    skippedByLlmCount: skippedCount,
    skipped: false,
  };
}
