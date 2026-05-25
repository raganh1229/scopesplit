// ─────────────────────────────────────────────────────────────────────────────
// N2 Pipeline — Step 4: extract-and-match orchestrator
//             + Step 5: persist-results
//
// extractAndMatch():
//   Reads n2:zones_matched, downloads both PDFs, slices per-zone sub-PDFs,
//   fans out Pass 4A (matched zones) and Pass 4B (unmatched zones) calls under
//   a concurrency cap of 8, runs splitMispaired on each zone result, and writes
//   n2:zones_extracted to ComparisonProcessingState.
//
// persistResults():
//   Reads n2:zones_extracted, sorts zones by E1 start page (E2-only zones
//   interleaved at end), sorts items within each zone by item number, computes
//   aggregate totals, atomically writes LineItems + updates Comparison status
//   to COMPLETED, clears N2 state.
//
// Architecture refs: N2_SPEED_CAPACITY_ACCURACY.md §Pass 4, Issues 14/16/17/21/29/30/34
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma } from '@/app/generated/prisma/client';
import prisma from '@/lib/prisma';
import { supabaseAdmin } from '@/lib/supabase';
import { loadPdf, slicePages, printedToInternal } from '@/lib/n2/utils/pdf-slicer';
import { PDFDocument } from 'pdf-lib';
import { parseAndValidate, withRetry, isTruncated, AIResponseError } from '@/lib/n2/utils/ai-response';
import { buildPass4APrompt } from '@/lib/n2/prompts/pass4a-extract-match';
import { buildPass4BPrompt } from '@/lib/n2/prompts/pass4b-extract-only';
import { Pass4AResponseSchema, Pass4BResponseSchema } from '@/lib/n2/schemas/pass-responses';
import {
  readZonesMatched,
  readZonesExtracted,
  writeN2Stage,
  clearN2Stage,
  N2_STAGE_ZONES_EXTRACTED,
} from '@/lib/n2/utils/n2-state';
import { zoneKey } from '@/lib/n2/schemas/types';
import type {
  N2ZoneSliceInfo,
  N2MatchedZonePair,
  N2UnmatchedZone,
  N2ZoneResult,
  N2ZoneMeta,
  N2ItemPair,
  N2ExtractedItem,
} from '@/lib/n2/schemas/types';
import { splitMispaired } from '@/lib/n2/n2-split-mispaired';
import { reconcileCrossZone } from '@/lib/n2/passes/cross-zone-reconcile';
import type { StepLogger } from '@/lib/n2/passes/detect-zones';

// ── Constants ─────────────────────────────────────────────────────────────────

const ESTIMATES_BUCKET = 'estimates';
// Pass 4 was previously on Haiku for cost. Moved to Sonnet 4.6 because Haiku
// occasionally drops items in long structured-enumeration tasks (e.g. merged
// zones with 25+ line items) even when nominally within its output budget.
// Tier 2 rate limits are identical for Sonnet and Haiku at the 4.x generation
// (1,000 RPM / 450K ITPM / 90K OTPM), so throughput is unaffected.
const SONNET_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Output token budget per zone call.
 * Sonnet 4.x supports up to 64K output tokens. Set to 16K — ample headroom for
 * a zone with 200 items at ~80 tokens/item (~16,000 tokens) while still capping
 * runaway responses. Increase if dense commercial zones ever truncate.
 */
const PASS4_MAX_TOKENS = 16384;

/**
 * Maximum number of Anthropic API calls that may be in-flight simultaneously.
 * Each zone call sends 1–2 document blocks; 8 parallel calls is within Tier 2
 * rate limits while keeping total wall-clock time for Pass 4 under ~3 minutes.
 */
const CONCURRENT_ZONE_CALLS = 8;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function downloadPdfBytes(storagePath: string): Promise<Uint8Array> {
  const { data, error } = await supabaseAdmin.storage
    .from(ESTIMATES_BUCKET)
    .download(storagePath);
  if (error || !data) {
    throw new Error(
      `[n2/extract-and-match] Failed to download PDF at '${storagePath}': ${error?.message ?? 'Unknown error'}`,
    );
  }
  const buffer = await data.arrayBuffer();
  return new Uint8Array(buffer);
}

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.trim().length === 0) {
    throw new Error('[n2/extract-and-match] ANTHROPIC_API_KEY is not configured.');
  }
  return key.trim();
}

// ── Deterministic MATCH/MODIFIED classification ──────────────────────────────

/** Parse a quantity string into a number; null on unparseable / blank. */
function parseQty(q: string | null | undefined): number | null {
  if (q == null) return null;
  const trimmed = String(q).trim();
  if (trimmed === '') return null;
  // Strip thousand separators and obvious unit suffixes the model sometimes
  // appends (e.g. "120.00 SF"). The unit comparison happens separately on
  // the dedicated `u` field.
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
 * Deterministic MATCH/MODIFIED classifier. Returns MATCH when:
 *   - both totals are present and within 1% (or $0.01, whichever is larger)
 *   - units agree case-insensitively (or are both empty/null)
 *   - quantities agree numerically within 1% (or are both null/blank)
 * Returns MODIFIED otherwise.
 *
 * Per Issue 41: pairing is the AI's job, classification is mechanical.
 * Sonnet 4.6 observed misclassifying obvious matches as MODIFIED purely
 * because the qty string literal differed ("1" vs "1.00") even when the
 * numeric value, unit, and total were identical. This classifier removes
 * that brittleness.
 */
function reclassifyPairFromFields(
  e1: N2ExtractedItem,
  e2: N2ExtractedItem,
): 'MATCH' | 'MODIFIED' {
  // Total: required for MATCH. If either is missing, MODIFIED.
  const t1 = e1.t ?? null;
  const t2 = e2.t ?? null;
  if (t1 == null || t2 == null) return 'MODIFIED';
  const totalTolerance = Math.max(0.01, Math.abs(t1) * 0.01);
  if (Math.abs(t1 - t2) > totalTolerance) return 'MODIFIED';

  // Unit: case-insensitive trim. Both blank/null is OK.
  const u1 = normalizeUnit(e1.u);
  const u2 = normalizeUnit(e2.u);
  if (u1 !== u2) return 'MODIFIED';

  // Quantity: numeric comparison with 1% tolerance. Both null/blank is OK.
  const q1 = parseQty(e1.q);
  const q2 = parseQty(e2.q);
  const q1Blank = q1 === null;
  const q2Blank = q2 === null;
  if (q1Blank && q2Blank) return 'MATCH';
  if (q1Blank !== q2Blank) return 'MODIFIED'; // one side has a qty, the other doesn't
  // Both present and parseable: numeric tolerance.
  const qTolerance = Math.max(0.01, Math.abs(q1!) * 0.01);
  if (Math.abs(q1! - q2!) > qTolerance) return 'MODIFIED';

  return 'MATCH';
}

/**
 * Build a single sub-PDF from one or more page ranges within a source doc.
 * Used for 1:many zones where the many-side has multiple non-contiguous ranges.
 */
async function sliceMultipleRanges(
  srcDoc: PDFDocument,
  ranges: Array<[number, number]>, // [startInternal, endInternal] pairs
): Promise<Uint8Array> {
  const newDoc = await PDFDocument.create();
  for (const [start, end] of ranges) {
    const totalPages = srcDoc.getPageCount();
    const safeStart = Math.max(0, start);
    const safeEnd = Math.min(totalPages - 1, end);
    if (safeStart > safeEnd) continue;
    const indices = Array.from({ length: safeEnd - safeStart + 1 }, (_, i) => safeStart + i);
    const pages = await newDoc.copyPages(srcDoc, indices);
    for (const page of pages) {
      newDoc.addPage(page);
    }
  }
  return newDoc.save();
}

// ── Zone call specs ───────────────────────────────────────────────────────────

type MatchedZoneSpec = {
  type: 'matched';
  pair: N2MatchedZonePair;
  e1SliceInfos: N2ZoneSliceInfo[];
  e2SliceInfos: N2ZoneSliceInfo[];
  resultKey: string; // zoneKey(canonical, e1StartPage)
};

type UnmatchedE1Spec = {
  type: 'unmatchedE1';
  zone: N2UnmatchedZone;
  sliceInfo: N2ZoneSliceInfo;
  resultKey: string; // 'e1_' + zoneKey(name, startPage)
};

type UnmatchedE2Spec = {
  type: 'unmatchedE2';
  zone: N2UnmatchedZone;
  sliceInfo: N2ZoneSliceInfo;
  resultKey: string; // 'e2_' + zoneKey(name, startPage)
};

type ZoneCallSpec = MatchedZoneSpec | UnmatchedE1Spec | UnmatchedE2Spec;

// ── Zone AI call — Pass 4A (matched) ─────────────────────────────────────────

async function callPass4A(
  spec: MatchedZoneSpec,
  e1Doc: PDFDocument,
  e2Doc: PDFDocument,
  context: string,
): Promise<N2ZoneResult> {
  return withRetry(async () => {
    const e1Ranges = spec.e1SliceInfos.map(
      (m): [number, number] => [
        printedToInternal(m.startPage, m.chunkOffset),
        printedToInternal(m.endPage, m.endPageChunkOffset),
      ],
    );
    const e2Ranges = spec.e2SliceInfos.map(
      (m): [number, number] => [
        printedToInternal(m.startPage, m.chunkOffset),
        printedToInternal(m.endPage, m.endPageChunkOffset),
      ],
    );

    const e1Bytes = await sliceMultipleRanges(e1Doc, e1Ranges);
    const e2Bytes = await sliceMultipleRanges(e2Doc, e2Ranges);

    const e1StartPage = spec.e1SliceInfos[0]!.startPage;
    const e1EndPage = spec.e1SliceInfos[spec.e1SliceInfos.length - 1]!.endPage;
    const e2StartPage = spec.e2SliceInfos[0]!.startPage;
    const e2EndPage = spec.e2SliceInfos[spec.e2SliceInfos.length - 1]!.endPage;

    // Extract every contractor and adjuster zone name represented in this
    // call's stitched PDFs. For 1:1 pairings these arrays each have one entry;
    // for merged (N:1, 1:N, N:M) pairings they list every constituent zone
    // whose pages were concatenated. The prompt uses these to scope extraction
    // explicitly, replacing the older single-canonical-name heuristic that
    // caused Haiku to stop reading at the first 'foreign' header inside a
    // merged document.
    const e1ZoneNames = spec.pair.e1Zones.map(z => z.zone);
    const e2ZoneNames = spec.pair.e2Zones.map(z => z.zone);

    const prompts = buildPass4APrompt({
      canonicalZoneName: spec.pair.canonical,
      e1ZoneNames,
      e2ZoneNames,
      e1StartPage,
      e1EndPage,
      e2StartPage,
      e2EndPage,
    });

    const apiKey = getApiKey();
    const e1Base64 = Buffer.from(e1Bytes).toString('base64');
    const e2Base64 = Buffer.from(e2Bytes).toString('base64');

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: SONNET_MODEL,
        max_tokens: PASS4_MAX_TOKENS,
        temperature: 0,
        system: prompts.system,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: e1Base64 },
              },
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: e2Base64 },
              },
              { type: 'text', text: prompts.user },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new AIResponseError(
        `[n2/extract-and-match] Anthropic ${response.status} for ${context}: ${response.statusText}`,
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
        `[n2/extract-and-match] Pass 4A response truncated for ${context} — output may be too large`,
        true,
        context,
      );
    }

    const parsed = parseAndValidate(text, Pass4AResponseSchema, context);

    const rawPairs: N2ItemPair[] = parsed.pairs.map(p => ({
      status: p.status,
      e1: p.e1 ? normalizeItem(p.e1) : null,
      e2: p.e2 ? normalizeItem(p.e2) : null,
    }));

    // Coerce pairs where AI gave an inconsistent status vs. null sides.
    // MATCH/MODIFIED requires both sides; if one is missing, downgrade to unilateral status.
    const coercedPairs: N2ItemPair[] = rawPairs
      .map(pair => {
        const needsBoth = pair.status === 'MATCH' || pair.status === 'MODIFIED';
        if (!needsBoth) return pair;
        if (pair.e1 !== null && pair.e2 !== null) return pair;
        if (pair.e1 !== null && pair.e2 === null) {
          return { ...pair, status: 'MISSING_FROM_ADJUSTER' as const };
        }
        if (pair.e1 === null && pair.e2 !== null) {
          return { ...pair, status: 'ADDED_BY_ADJUSTER' as const };
        }
        return null; // both null — drop entirely
      })
      .filter((p): p is N2ItemPair => p !== null);

    // Deterministic MATCH/MODIFIED classification override. Per Issue 41
    // ("pairing is the AI's job, classification is mechanical"), we recompute
    // status from the structured numeric fields after the AI returns its
    // pairing decisions. Sonnet is observably too strict on this judgement —
    // it flags "Building permit" qty=1 EA $1,485 vs "Commercial building permit"
    // qty=1.00 EA $1,485 as MODIFIED because the qty string literal differs.
    // The deterministic classifier handles trivial format differences correctly.
    const pairs: N2ItemPair[] = coercedPairs.map(pair => {
      if (pair.status !== 'MATCH' && pair.status !== 'MODIFIED') return pair;
      if (pair.e1 === null || pair.e2 === null) return pair;
      const determined = reclassifyPairFromFields(pair.e1, pair.e2);
      if (determined === pair.status) return pair;
      return { ...pair, status: determined };
    });

    return { pairs };
  }, 3, context);
}

// ── Zone AI call — Pass 4B (unmatched) ───────────────────────────────────────

async function callPass4B(
  spec: UnmatchedE1Spec | UnmatchedE2Spec,
  srcDoc: PDFDocument,
  context: string,
): Promise<N2ZoneResult> {
  return withRetry(async () => {
    const sliceInfo = spec.sliceInfo;
    const startInternal = printedToInternal(sliceInfo.startPage, sliceInfo.chunkOffset);
    const endInternal = printedToInternal(sliceInfo.endPage, sliceInfo.endPageChunkOffset);

    const zoneBytes = await slicePages(srcDoc, startInternal, endInternal);

    const side: 'contractor' | 'adjuster' = spec.type === 'unmatchedE1' ? 'contractor' : 'adjuster';
    const prompts = buildPass4BPrompt({
      canonicalZoneName: spec.zone.zone,
      startPage: sliceInfo.startPage,
      endPage: sliceInfo.endPage,
      side,
    });

    const apiKey = getApiKey();
    const pdfBase64 = Buffer.from(zoneBytes).toString('base64');

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: SONNET_MODEL,
        max_tokens: PASS4_MAX_TOKENS,
        temperature: 0,
        system: prompts.system,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
              },
              { type: 'text', text: prompts.user },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new AIResponseError(
        `[n2/extract-and-match] Anthropic ${response.status} for ${context}: ${response.statusText}`,
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
        `[n2/extract-and-match] Pass 4B response truncated for ${context}`,
        true,
        context,
      );
    }

    const parsed = parseAndValidate(text, Pass4BResponseSchema, context);

    const matchStatus = spec.type === 'unmatchedE1' ? 'MISSING_FROM_ADJUSTER' : 'ADDED_BY_ADJUSTER';
    const normalizedItems = parsed.items.map(normalizeItem);
    const pairs: N2ItemPair[] = normalizedItems.map(item => ({
      status: matchStatus,
      e1: spec.type === 'unmatchedE1' ? item : null,
      e2: spec.type === 'unmatchedE2' ? item : null,
    }));

    return { pairs };
  }, 3, context);
}

// ── Normalise parsed item → strict N2ExtractedItem ──────────────────────────
// Zod's .optional().transform(v => v ?? null) yields `T | null | undefined`
// in the inferred type. Collapse undefined→null here so callers see the
// canonical N2ExtractedItem shape.

function normalizeItem(raw: {
  n: number;
  d: string;
  q?: string | null;
  u?: string | null;
  rm?: number | null;
  rp?: number | null;
  rs?: number | null;
  tx?: number | null;
  op?: number | null;
  t?: number | null;
}): N2ExtractedItem {
  return {
    n: raw.n,
    d: raw.d,
    q: raw.q ?? null,
    u: raw.u ?? null,
    rm: raw.rm ?? null,
    rp: raw.rp ?? null,
    rs: raw.rs ?? null,
    tx: raw.tx ?? null,
    op: raw.op ?? null,
    t: raw.t ?? null,
  };
}

// ── Concurrency-limited fan-out ───────────────────────────────────────────────

async function runWithConcurrencyLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const idx = nextIdx++;
      if (idx >= tasks.length) return;
      try {
        results[idx] = { status: 'fulfilled', value: await tasks[idx]!() };
      } catch (reason) {
        results[idx] = { status: 'rejected', reason };
      }
    }
  }

  const workerCount = Math.min(limit, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

// ── Dispatch per zone spec ────────────────────────────────────────────────────

async function dispatchZoneSpec(
  spec: ZoneCallSpec,
  e1Doc: PDFDocument,
  e2Doc: PDFDocument,
): Promise<N2ZoneResult> {
  switch (spec.type) {
    case 'matched':
      return callPass4A(spec, e1Doc, e2Doc, `zone-4A:${spec.pair.canonical}`);
    case 'unmatchedE1':
      return callPass4B(spec, e1Doc, `zone-4B-e1:${spec.zone.zone}`);
    case 'unmatchedE2':
      return callPass4B(spec, e2Doc, `zone-4B-e2:${spec.zone.zone}`);
  }
}

// ── extractAndMatch (Step 4) ──────────────────────────────────────────────────

/**
 * Run per-zone extraction + matching for all zones and write n2:zones_extracted.
 * Called from Inngest Step 4 ("extract-and-match").
 *
 * Throws on unrecoverable errors. The Inngest step will retry the entire step.
 */
export async function extractAndMatch(
  comparisonId: string,
  logger: StepLogger,
): Promise<void> {
  // ── 1. Read zones_matched state ───────────────────────────────────────────
  const state = await readZonesMatched(comparisonId);
  if (!state) {
    throw new Error(`[n2/extract-and-match] No zones_matched state for comparison ${comparisonId}`);
  }

  // ── 2. Load comparison storage paths ─────────────────────────────────────
  const comparison = await prisma.comparison.findUnique({
    where: { id: comparisonId },
    select: {
      yourEstimateStoragePath: true,
      adjusterEstimateStoragePath: true,
    },
  });
  if (!comparison) {
    throw new Error(`[n2/extract-and-match] Comparison ${comparisonId} not found`);
  }

  // ── 3. Download both PDFs ─────────────────────────────────────────────────
  const [e1Bytes, e2Bytes] = await Promise.all([
    downloadPdfBytes(comparison.yourEstimateStoragePath),
    downloadPdfBytes(comparison.adjusterEstimateStoragePath),
  ]);

  // ── 4. Load into pdf-lib (once per estimate — reused for all zone slices) ─
  const [e1Doc, e2Doc] = await Promise.all([loadPdf(e1Bytes), loadPdf(e2Bytes)]);

  logger.info('[n2/extract-and-match] PDFs loaded', {
    comparisonId,
    matchedZones: state.matched.length,
    unmatchedE1: state.unmatchedE1.length,
    unmatchedE2: state.unmatchedE2.length,
  });

  // ── 5. Build zone call specs ───────────────────────────────────────────────

  const zoneSpecs: ZoneCallSpec[] = [];

  // 5a. Matched zone pairs (Pass 4A)
  for (const pair of state.matched) {
    const e1SliceInfos = pair.e1Zones.map(z => {
      const key = zoneKey(z.zone, z.pages[0]);
      const meta = state.e1ZoneMeta[key];
      if (!meta) {
        throw new Error(
          `[n2/extract-and-match] Missing e1ZoneMeta for key '${key}' on comparison ${comparisonId}`,
        );
      }
      return meta;
    });

    const e2SliceInfos = pair.e2Zones.map(z => {
      const key = zoneKey(z.zone, z.pages[0]);
      const meta = state.e2ZoneMeta[key];
      if (!meta) {
        throw new Error(
          `[n2/extract-and-match] Missing e2ZoneMeta for key '${key}' on comparison ${comparisonId}`,
        );
      }
      return meta;
    });

    const e1StartPage = e1SliceInfos[0]!.startPage;
    zoneSpecs.push({
      type: 'matched',
      pair,
      e1SliceInfos,
      e2SliceInfos,
      resultKey: zoneKey(pair.canonical, e1StartPage),
    });
  }

  // 5b. Unmatched E1 zones (Pass 4B → MISSING_FROM_ADJUSTER)
  for (const zone of state.unmatchedE1) {
    const key = zoneKey(zone.zone, zone.pages[0]);
    const meta = state.e1ZoneMeta[key];
    if (!meta) {
      logger.warn('[n2/extract-and-match] Missing e1ZoneMeta for unmatched zone — skipping', {
        comparisonId,
        zone: zone.zone,
        key,
      });
      continue;
    }
    zoneSpecs.push({
      type: 'unmatchedE1',
      zone,
      sliceInfo: meta,
      resultKey: 'e1_' + key,
    });
  }

  // 5c. Unmatched E2 zones (Pass 4B → ADDED_BY_ADJUSTER)
  for (const zone of state.unmatchedE2) {
    const key = zoneKey(zone.zone, zone.pages[0]);
    const meta = state.e2ZoneMeta[key];
    if (!meta) {
      logger.warn('[n2/extract-and-match] Missing e2ZoneMeta for unmatched zone — skipping', {
        comparisonId,
        zone: zone.zone,
        key,
      });
      continue;
    }
    zoneSpecs.push({
      type: 'unmatchedE2',
      zone,
      sliceInfo: meta,
      resultKey: 'e2_' + key,
    });
  }

  logger.info('[n2/extract-and-match] Firing zone extraction calls', {
    comparisonId,
    totalZones: zoneSpecs.length,
    concurrencyCap: CONCURRENT_ZONE_CALLS,
  });

  // ── 6. Fan out all zone calls under concurrency cap ───────────────────────
  const allSettled = await runWithConcurrencyLimit(
    zoneSpecs.map(spec => () => dispatchZoneSpec(spec, e1Doc, e2Doc)),
    CONCURRENT_ZONE_CALLS,
  );

  // ── 7. Collect results — fail fast on any zone failure ────────────────────
  const zoneResults: Record<string, N2ZoneResult> = {};
  const zoneMeta: Record<string, N2ZoneMeta> = {};

  for (let i = 0; i < allSettled.length; i++) {
    const settled = allSettled[i]!;
    const spec = zoneSpecs[i]!;

    if (settled.status === 'rejected') {
      throw new Error(
        `[n2/extract-and-match] Zone '${spec.resultKey}' failed after retries: ` +
          `${(settled.reason as Error).message}`,
      );
    }

    const rawResult = settled.value;
    const processedPairs = splitMispaired(rawResult.pairs);
    zoneResults[spec.resultKey] = { pairs: processedPairs };

    // Build zoneMeta for this zone
    if (spec.type === 'matched') {
      const { pair } = spec;
      const e1Names = pair.e1Zones.map(z => z.zone);
      const e2Names = pair.e2Zones.map(z => z.zone);
      zoneMeta[spec.resultKey] = {
        canonical: pair.canonical,
        zoneYours: e1Names.length === 1 ? e1Names[0]! : e1Names,
        zoneAdjuster: e2Names.length === 1 ? e2Names[0]! : e2Names,
        confidence: pair.confidence,
        isMerged: pair.isMerged,
      };
    } else if (spec.type === 'unmatchedE1') {
      zoneMeta[spec.resultKey] = {
        canonical: spec.zone.zone,
        zoneYours: spec.zone.zone,
        zoneAdjuster: null,
        confidence: 100,
        isMerged: false,
      };
    } else {
      zoneMeta[spec.resultKey] = {
        canonical: spec.zone.zone,
        zoneYours: null,
        zoneAdjuster: spec.zone.zone,
        confidence: 100,
        isMerged: false,
      };
    }
  }

  logger.info('[n2/extract-and-match] All zones extracted', {
    comparisonId,
    zoneCount: Object.keys(zoneResults).length,
  });

  // ── 7.5. Pass 5 — cross-zone item reconciliation ───────────────────────
  // Sweeps MISSING_FROM_ADJUSTER + ADDED_BY_ADJUSTER orphans across all zones,
  // sends them to Opus, accepts only high-confidence cross-zone pairs (≥ 75),
  // and files accepted pairs into a synthetic CROSS ZONE MATCHES zone.
  // Mutates zoneResults / zoneMeta in place. Fails open on any error — a Pass 5
  // failure must never block the comparison from completing. See Issues 39–41.
  await reconcileCrossZone(comparisonId, zoneResults, zoneMeta, logger);

  // ── 8. Write zones_extracted to state ───────────────────────────────
  await writeN2Stage(comparisonId, N2_STAGE_ZONES_EXTRACTED, {
    zoneResults,
    zoneMeta,
    routingDecision: state.routingDecision,
  });
}

// ── persistResults (Step 5) ───────────────────────────────────────────────────

/**
 * Read n2:zones_extracted, sort + flatten to LineItems, atomically persist,
 * update Comparison status to COMPLETED, and clear N2 state.
 * Called from Inngest Step 5 ("persist-results").
 *
 * Returns the number of line items written.
 */
export async function persistResults(
  comparisonId: string,
  logger: StepLogger,
): Promise<{ lineItemCount: number }> {
  // ── 1. Read zones_extracted state ─────────────────────────────────────────
  const state = await readZonesExtracted(comparisonId);
  if (!state) {
    throw new Error(`[n2/persist-results] No zones_extracted state for comparison ${comparisonId}`);
  }

  // ── 2. Sort zone keys: matched + unmatched-E1 first (by E1 start page),
  //       then unmatched-E2 (by E2 start page, interleaved at end).
  //
  //       The start page is encoded in the key suffix: _p<N>
  //       e.g. "Kitchen_p5", "e1_Garage_p12", "e2_Detached_p18"
  function parseStartPage(key: string): number {
    const m = key.match(/_p(\d+)$/);
    return m ? parseInt(m[1]!, 10) : 0;
  }

  const sortedKeys = Object.keys(state.zoneResults).sort((a, b) => {
    const aIsE2Only = a.startsWith('e2_');
    const bIsE2Only = b.startsWith('e2_');
    if (aIsE2Only !== bIsE2Only) return aIsE2Only ? 1 : -1;
    return parseStartPage(a) - parseStartPage(b);
  });

  // ── 3. Flatten to LineItem create-data ────────────────────────────────────
  const lineItemData: Prisma.LineItemCreateManyInput[] = [];
  let sortOrder = 1;

  let totalYoursAcc = 0;
  let totalAdjusterAcc = 0;
  let matchCount = 0;
  let modifiedCount = 0;
  let missingCount = 0;
  let addedCount = 0;

  for (const zk of sortedKeys) {
    const zoneResult = state.zoneResults[zk]!;
    const meta = state.zoneMeta[zk]!;

    const metaZoneYours = Array.isArray(meta.zoneYours)
      ? meta.zoneYours.join(' / ')
      : meta.zoneYours;
    const metaZoneAdjuster = Array.isArray(meta.zoneAdjuster)
      ? meta.zoneAdjuster.join(' / ')
      : meta.zoneAdjuster;

    // Sort pairs: E1 item number first; ADDED_BY_ADJUSTER (no E1) use E2 item number
    const sortedPairs = [...zoneResult.pairs].sort((a, b) => {
      const aNum = a.e1?.n ?? a.e2?.n ?? 0;
      const bNum = b.e1?.n ?? b.e2?.n ?? 0;
      return aNum - bNum;
    });

    for (const pair of sortedPairs) {
      // For Pass 5 cross-zone matches, prefer the per-item original zone names
      // carried on pair.crossZoneOrigin over the synthetic CROSS ZONE MATCHES
      // zone's null meta. This way LineItem.zoneYours / zoneAdjuster reflect
      // each item's actual home zones, while LineItem.zoneCanonical is the
      // synthetic CROSS ZONE MATCHES grouping label.
      const zoneYours = pair.crossZoneOrigin
        ? pair.crossZoneOrigin.e1Zone
        : metaZoneYours;
      const zoneAdjuster = pair.crossZoneOrigin
        ? pair.crossZoneOrigin.e2Zone
        : metaZoneAdjuster;

      const totalYours = pair.e1?.t ?? null;
      const totalAdjuster = pair.e2?.t ?? null;

      let diffAmount: number | null = null;
      if (totalYours != null && totalAdjuster != null) {
        diffAmount = totalAdjuster - totalYours;
      } else if (totalAdjuster != null) {
        diffAmount = totalAdjuster;
      } else if (totalYours != null) {
        diffAmount = -totalYours;
      }

      if (totalYours != null) totalYoursAcc += totalYours;
      if (totalAdjuster != null) totalAdjusterAcc += totalAdjuster;

      switch (pair.status) {
        case 'MATCH': matchCount++; break;
        case 'MODIFIED': modifiedCount++; break;
        case 'MISSING_FROM_ADJUSTER': missingCount++; break;
        case 'ADDED_BY_ADJUSTER': addedCount++; break;
      }

      lineItemData.push({
        comparisonId,
        matchStatus: pair.status,
        zoneYours,
        zoneAdjuster,
        zoneCanonical: meta.canonical,
        zoneConfidence: meta.confidence,
        descriptionYours: pair.e1?.d ?? null,
        descriptionAdjuster: pair.e2?.d ?? null,
        qtyYours: pair.e1?.q ?? null,
        qtyAdjuster: pair.e2?.q ?? null,
        unitYours: pair.e1?.u ?? null,
        unitAdjuster: pair.e2?.u ?? null,
        removeYours: pair.e1?.rm ?? null,
        removeAdjuster: pair.e2?.rm ?? null,
        replaceYours: pair.e1?.rp ?? null,
        replaceAdjuster: pair.e2?.rp ?? null,
        resetYours: pair.e1?.rs ?? null,
        resetAdjuster: pair.e2?.rs ?? null,
        taxYours: pair.e1?.tx ?? null,
        taxAdjuster: pair.e2?.tx ?? null,
        opYours: pair.e1?.op ?? null,
        opAdjuster: pair.e2?.op ?? null,
        totalYours: totalYours ?? null,
        totalAdjuster: totalAdjuster ?? null,
        diffAmount: diffAmount ?? null,
        category: null,
        sortOrder: sortOrder++,
        groupId: null,
      });
    }
  }

  logger.info('[n2/persist-results] Writing line items', {
    comparisonId,
    lineItemCount: lineItemData.length,
    matchCount,
    modifiedCount,
    missingCount,
    addedCount,
    totalGap: totalAdjusterAcc - totalYoursAcc,
  });

  // ── 4. Atomic persist (Issue 29 Layer 2: wrap in try/catch for P2025/P2003) ─
  try {
    await prisma.$transaction([
      prisma.lineItem.deleteMany({ where: { comparisonId } }),
      prisma.lineItem.createMany({ data: lineItemData }),
      prisma.comparison.update({
        where: { id: comparisonId },
        data: {
          status: 'COMPLETED',
          totalGap: totalAdjusterAcc - totalYoursAcc,
          yourEstimateTotal: totalYoursAcc,
          adjusterEstimateTotal: totalAdjusterAcc,
          matchCount,
          modifiedCount,
          missingCount,
          addedCount,
        },
      }),
    ]);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'P2025' || code === 'P2003') {
      logger.warn('[n2/persist-results] Comparison deleted mid-flight — skipping persist', {
        comparisonId,
        code,
      });
      return { lineItemCount: 0 };
    }
    throw err;
  }

  // ── 5. Clear N2 processing state ──────────────────────────────────────────
  await clearN2Stage(comparisonId);

  logger.info('[n2/persist-results] Complete', { comparisonId, lineItemCount: lineItemData.length });
  return { lineItemCount: lineItemData.length };
}
