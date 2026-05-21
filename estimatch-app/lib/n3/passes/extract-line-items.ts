// ─────────────────────────────────────────────────────────────────────────────
// N3 Pipeline — Phase 8: extract-line-items
//
// Extracts all numbered line items from every zone (both sides) using Sonnet
// vision and writes N3LineItem rows to `n3_line_items`.
//
// Algorithm:
//   1. Load both PDFs from Supabase storage
//   2. Load all n3_zones for this comparison
//   3. Build one call spec per zone (slice zone pages → sub-PDF bytes)
//   4. Fan out all extraction calls with concurrency cap (Sonnet vision)
//   5. Collect results; fail fast on any zone exhausting retries
//   6. Map extracted items → N3LineItem data rows (run normalizeDescription +
//      tokenizeDescription here so Phase 12 has tokens ready)
//   7. Idempotent write: deleteMany existing + createMany new rows
//
// Page offset assumption:
//   Zone startPage/endPage are PRINTED page numbers. This pass converts them
//   to 0-based pdf-lib internal indices via (printedPage - 1). This is correct
//   for PDFs whose first printed page is "1" (the vast majority of estimates).
//   For multi-volume PDFs that start at a higher page number, slices will be
//   wrong — a TODO to add chunkOffset to n3_zones when this case is encountered.
//
// Architecture refs: N3.md §Phase 8, §16.1 (feature extraction), §16.2
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import prisma from '@/lib/prisma';
import { supabaseAdmin } from '@/lib/supabase';
import { loadPdf, slicePages } from '@/lib/n2/utils/pdf-slicer';
import { parseAndValidate, withRetry, isTruncated, AIResponseError } from '@/lib/n2/utils/ai-response';
import { buildExtractionPrompt } from '@/lib/n3/prompts/extraction';
import { normalizeDescription, tokenizeDescription } from '@/lib/n3/normalization';
import type { StepLogger } from '@/lib/n3/passes/detect-zones';
import type { EstimateFormat } from '@/lib/n2/schemas/types';

// ── Constants ─────────────────────────────────────────────────────────────────

const ESTIMATES_BUCKET = 'estimates';
const SONNET_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const BASE_MAX_TOKENS = 16384;          // full cap — prevents truncation on any chunk size
const MAX_TOKENS_CAP = 16384;           // hard cap
const TOKENS_PER_PAGE = 2400;           // ~25 items/page × ~95 tokens/item (informational)
const CONCURRENT_ZONE_CALLS = 5;        // concurrency for single-zone calls
const FETCH_TIMEOUT_MS = 180_000;       // 3 min per vision call
const ITEM_SPLIT_THRESHOLD = 60;        // zones with more approxItems get page-chunked
const MAX_PAGES_PER_CHUNK = 2;          // max pages per chunk — keeps items ~50/call, safe for 16384 cap
const CHUNK_OVERLAP_PAGES = 1;          // overlap between chunks to catch boundary items

// ── Zod schema for AI response ────────────────────────────────────────────────

const N3ExtractedItemSchema = z.object({
  n: z.number().int().positive(),
  p: z.number().int().positive(),
  d: z.string().min(1),
  code: z.string().nullable().default(null),
  q: z.string().nullable().default(null),
  u: z.string().nullable().default(null),
  up: z.number().nullable().default(null),
  rm: z.number().nullable().default(null),
  rp: z.number().nullable().default(null),
  rs: z.number().nullable().default(null),
  tx: z.number().nullable().default(null),
  op: z.number().nullable().default(null),
  t: z.number().nullable().default(null),
});

const ZoneExtractionResponseSchema = z.object({
  zone: z.string().min(1),
  items: z.array(N3ExtractedItemSchema),
});

type ExtractedZoneResult = {
  zoneId: string;
  source: string;
  // Match the type returned by `parseAndValidate<T>(...schema: z.ZodSchema<T>): T`,
  // which binds T from the schema's *input* shape. With `.nullable().default(null)`
  // the input type is `string | null | undefined` (the default fills missing keys at
  // runtime, so values are actually `string | null` after parsing). Downstream
  // consumption coalesces with `?? null` so `undefined` is handled safely.
  items: z.input<typeof N3ExtractedItemSchema>[];
};

// ── Return type ───────────────────────────────────────────────────────────────

export type ExtractLineItemsN3Result = {
  yoursItemCount: number;
  adjusterItemCount: number;
  totalItemCount: number;
  zoneCount: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key?.trim()) {
    throw new Error('[n3/extract-line-items] ANTHROPIC_API_KEY is not configured.');
  }
  return key.trim();
}

async function downloadPdfBytes(storagePath: string): Promise<Uint8Array> {
  const { data, error } = await supabaseAdmin.storage
    .from(ESTIMATES_BUCKET)
    .download(storagePath);
  if (error || !data) {
    throw new Error(
      `[n3/extract-line-items] Failed to download PDF at '${storagePath}': ${error?.message ?? 'Unknown error'}`,
    );
  }
  return new Uint8Array(await data.arrayBuffer());
}

/**
 * Convert a printed page number to a 0-based pdf-lib internal index.
 * Assumes the PDF's first printed page is "1" (standard for most estimates).
 * Clamped to [0, totalPages-1] to prevent out-of-bounds slices.
 */
function printedToInternal(printedPage: number, totalPages: number): number {
  return Math.max(0, Math.min(printedPage - 1, totalPages - 1));
}

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

// ── Single-zone extraction call ───────────────────────────────────────────────

type ZoneCallSpec = {
  zoneId: string;
  zoneName: string;
  source: string;
  startPage: number;
  endPage: number;
  format: EstimateFormat;
  chunkBytes: Uint8Array;
  context: string;
  maxTokens: number;
};

/**
 * Compute dynamic max_tokens based on zone page span.
 * Larger page chunks need more output tokens to avoid truncation.
 */
function computeMaxTokens(pageSpan: number): number {
  return Math.max(BASE_MAX_TOKENS, Math.min(pageSpan * TOKENS_PER_PAGE, MAX_TOKENS_CAP));
}

/**
 * Deduplicate extracted items by source line number, keeping the first occurrence.
 * Prevents doubles when overlapping page chunks return the same item.
 */
function deduplicateItems(
  items: z.input<typeof N3ExtractedItemSchema>[],
): z.input<typeof N3ExtractedItemSchema>[] {
  const seen = new Set<number>();
  return items.filter(item => {
    if (seen.has(item.n)) return false;
    seen.add(item.n);
    return true;
  });
}

/**
 * Single Claude vision call for one page chunk.
 * All extraction — small zones and sub-chunks alike — flows through here.
 */
async function extractZone(spec: ZoneCallSpec): Promise<ExtractedZoneResult> {
  const { zoneId, zoneName, source, startPage, endPage, format, chunkBytes, context, maxTokens } = spec;

  return withRetry(
    async () => {
      const prompts = buildExtractionPrompt({
        zoneName,
        startPage,
        endPage,
        side: source === 'yours' ? 'contractor' : 'adjuster',
        format,
      });

      const apiKey = getApiKey();
      const pdfBase64 = Buffer.from(chunkBytes).toString('base64');

      const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: SONNET_MODEL,
          max_tokens: maxTokens,
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
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new AIResponseError(
          `[n3/extract-line-items] Anthropic ${response.status} for ${context}: ${response.statusText}`,
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
          `[n3/extract-line-items] Response truncated for ${context} (maxTokens=${maxTokens})`,
          true,
          context,
        );
      }

      const parsed = parseAndValidate(text, ZoneExtractionResponseSchema, context);
      return { zoneId, source, items: deduplicateItems(parsed.items) };
    },
    3,
    context,
  );
}

/**
 * For large zones (approxItems > ITEM_SPLIT_THRESHOLD), split the zone's pages
 * into MAX_PAGES_PER_CHUNK-page chunks with CHUNK_OVERLAP_PAGES overlap and
 * run all chunks as concurrent Claude vision calls. Results are merged and
 * deduplicated by line number.
 */
async function extractLargeZone(
  zone: { id: string; source: string; name: string; startPage: number; endPage: number },
  doc: Awaited<ReturnType<typeof loadPdf>>,
  totalPages: number,
  format: EstimateFormat,
  logger: StepLogger,
  comparisonId: string,
): Promise<ExtractedZoneResult> {
  const pageSpan = zone.endPage - zone.startPage + 1;
  const subSpecs: ZoneCallSpec[] = [];

  for (
    let chunkStart = zone.startPage;
    chunkStart <= zone.endPage;
    chunkStart += MAX_PAGES_PER_CHUNK - CHUNK_OVERLAP_PAGES
  ) {
    const chunkEnd = Math.min(chunkStart + MAX_PAGES_PER_CHUNK - 1, zone.endPage);
    const startInternal = printedToInternal(chunkStart, totalPages);
    const endInternal = printedToInternal(chunkEnd + 1, totalPages); // +1 buffer

    let chunkBytes: Uint8Array;
    try {
      chunkBytes = await slicePages(doc, startInternal, endInternal);
    } catch (err) {
      logger.warn('[n3/extract-line-items] Failed to slice sub-chunk — skipping', {
        comparisonId,
        zoneName: zone.name,
        chunkStart,
        chunkEnd,
        error: (err as Error).message,
      });
      continue;
    }

    const chunkPageSpan = chunkEnd - chunkStart + 1;
    subSpecs.push({
      zoneId: zone.id,
      zoneName: zone.name,
      source: zone.source,
      startPage: chunkStart,
      endPage: chunkEnd,
      format,
      chunkBytes,
      context: `${zone.source}-${zone.name.slice(0, 20).replace(/\s+/g, '_')}-p${chunkStart}-${chunkEnd}`,
      maxTokens: computeMaxTokens(chunkPageSpan),
    });
  }

  logger.info('[n3/extract-line-items] Splitting large zone into parallel sub-chunks', {
    comparisonId,
    zoneName: zone.name,
    pageSpan,
    subChunks: subSpecs.length,
  });

  // Run all sub-chunks in parallel — each is a small, fast vision call
  const subResults = await Promise.all(subSpecs.map(spec => extractZone(spec)));

  // Merge and deduplicate by line number (overlap pages may produce duplicates)
  const allItems: z.input<typeof N3ExtractedItemSchema>[] = [];
  const seenLineNumbers = new Set<number>();
  for (const result of subResults) {
    for (const item of result.items) {
      if (!seenLineNumbers.has(item.n)) {
        seenLineNumbers.add(item.n);
        allItems.push(item);
      }
    }
  }
  allItems.sort((a, b) => a.n - b.n);

  logger.info('[n3/extract-line-items] Large zone chunked extraction complete', {
    comparisonId,
    zoneName: zone.name,
    totalItems: allItems.length,
    subChunks: subSpecs.length,
  });

  return { zoneId: zone.id, source: zone.source, items: allItems };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Extract all line items for every zone and write N3LineItem rows.
 *
 * Idempotent: deletes all existing n3_line_items for this comparisonId
 * before writing so Inngest step retries are clean.
 *
 * Throws on unrecoverable error. The calling Inngest step will retry.
 */
export async function extractLineItemsN3(
  comparisonId: string,
  logger: StepLogger,
  reextractSource?: 'yours' | 'adjuster' | 'both',
): Promise<ExtractLineItemsN3Result> {
  // ── 1. Load comparison + zones ──────────────────────────────────────────────
  const comparison = await prisma.comparison.findUnique({
    where: { id: comparisonId },
    select: {
      yourEstimateStoragePath: true,
      adjusterEstimateStoragePath: true,
    },
  });
  if (!comparison) {
    throw new Error(`[n3/extract-line-items] Comparison ${comparisonId} not found`);
  }

  // When re-extracting for one estimate side only, filter zones to that side.
  // The opposite side's existing n3_line_items rows are left untouched.
  const sourceFilter = reextractSource && reextractSource !== 'both'
    ? { source: reextractSource }
    : {};

  const zones = await prisma.n3Zone.findMany({
    where: { comparisonId, ...sourceFilter },
    select: { id: true, source: true, name: true, startPage: true, endPage: true, approxItems: true  },
    orderBy: [{ source: 'asc' }, { startPage: 'asc' }],
  });

  if (zones.length === 0) {
    logger.warn('[n3/extract-line-items] No zones found — Phase 4 may not have run', { comparisonId });
    return { yoursItemCount: 0, adjusterItemCount: 0, totalItemCount: 0, zoneCount: 0 };
  }

  // ── 2. Download both PDFs ───────────────────────────────────────────────────
  const [yoursBytes, adjBytes] = await Promise.all([
    downloadPdfBytes(comparison.yourEstimateStoragePath),
    downloadPdfBytes(comparison.adjusterEstimateStoragePath),
  ]);

  const [yoursDoc, adjDoc] = await Promise.all([loadPdf(yoursBytes), loadPdf(adjBytes)]);
  const yoursTotalPages = yoursDoc.getPageCount();
  const adjTotalPages = adjDoc.getPageCount();

  // Pull format from Phase 4 detection (stored in the zone table's source — best proxy is first chunk)
  // Format is not stored in n3_zones; default to 'unknown' and let the prompt handle it gracefully.
  const yoursFormat: EstimateFormat = 'unknown';
  const adjFormat: EstimateFormat = 'unknown';

  logger.info('[n3/extract-line-items] Building zone call specs', {
    comparisonId,
    zones: zones.length,
    yoursPages: yoursTotalPages,
    adjPages: adjTotalPages,
  });

  // ── 3. Partition zones: small (single call) vs large (sub-chunked) ──────────
  const smallZones: typeof zones = [];
  const largeZones: typeof zones = [];

  for (const zone of zones) {
    if ((zone.approxItems ?? 0) > ITEM_SPLIT_THRESHOLD) {
      largeZones.push(zone);
    } else {
      smallZones.push(zone);
    }
  }

  logger.info('[n3/extract-line-items] Zone routing', {
    comparisonId,
    smallZones: smallZones.length,
    largeZones: largeZones.length,
  });

  // ── 4a. Build call specs for small zones ────────────────────────────────────
  const specs: ZoneCallSpec[] = [];

  for (const zone of smallZones) {
    const doc = zone.source === 'yours' ? yoursDoc : adjDoc;
    const totalPages = zone.source === 'yours' ? yoursTotalPages : adjTotalPages;
    const format = zone.source === 'yours' ? yoursFormat : adjFormat;
    const pageSpan = zone.endPage - zone.startPage + 1;

    const startInternal = printedToInternal(zone.startPage, totalPages);
    // +1 page buffer: ensures items that flow past the detected endPage boundary
    // are still captured. The extraction prompt Rule 3 ("stop at next zone header")
    // prevents false positives. printedToInternal clamps to [0, totalPages-1] so
    // the last zone automatically extends to the actual final PDF page.
    const endInternal = printedToInternal(zone.endPage + 1, totalPages);

    let chunkBytes: Uint8Array;
    try {
      chunkBytes = await slicePages(doc, startInternal, endInternal);
    } catch (err) {
      logger.warn('[n3/extract-line-items] Failed to slice zone pages — skipping zone', {
        comparisonId,
        zoneId: zone.id,
        zoneName: zone.name,
        startInternal,
        endInternal,
        error: (err as Error).message,
      });
      continue;
    }

    specs.push({
      zoneId: zone.id,
      zoneName: zone.name,
      source: zone.source,
      startPage: zone.startPage,
      endPage: zone.endPage,
      format,
      chunkBytes,
      context: `${zone.source}-${zone.name.slice(0, 20).replace(/\s+/g, '_')}`,
      maxTokens: computeMaxTokens(pageSpan),
    });
  }

  // ── 4b. Extract large zones (parallel sub-chunks per zone) ─────────────────
  const largeZoneResults: ExtractedZoneResult[] = [];
  for (const zone of largeZones) {
    const doc = zone.source === 'yours' ? yoursDoc : adjDoc;
    const totalPages = zone.source === 'yours' ? yoursTotalPages : adjTotalPages;
    const format = zone.source === 'yours' ? yoursFormat : adjFormat;
    const result = await extractLargeZone(zone, doc, totalPages, format, logger, comparisonId);
    largeZoneResults.push(result);
  }

  // ── 4c. Fan out small zones with concurrency cap ────────────────────────────
  logger.info('[n3/extract-line-items] Firing small-zone extraction calls', {
    comparisonId,
    calls: specs.length,
  });

  const allSettled = await runWithConcurrencyLimit(
    specs.map(s => () => extractZone(s)),
    CONCURRENT_ZONE_CALLS,
  );

  // ── 5. Collect results — fail fast ─────────────────────────────────────────
  const zoneResults: ExtractedZoneResult[] = [...largeZoneResults];
  for (let i = 0; i < allSettled.length; i++) {
    const settled = allSettled[i]!;
    const spec = specs[i]!;
    if (settled.status === 'rejected') {
      throw new Error(
        `[n3/extract-line-items] Zone "${spec.zoneName}" (${spec.source}) failed after retries: ${(settled.reason as Error).message}`,
      );
    }
    zoneResults.push(settled.value);
  }

  // ── 6. Map to N3LineItem data rows ──────────────────────────────────────────
  type LineItemRow = {
    comparisonId: string;
    zoneId: string;
    source: string;
    sourceLineNumber: number;
    pageNumber: number;
    rawDescription: string;
    normalizedDescription: string;
    descriptionTokens: string[];
    itemCode: string | null;
    rawQuantity: string | null;
    rawUnit: string | null;
    removeAmount: number | null;
    replaceAmount: number | null;
    resetAmount: number | null;
    taxAmount: number | null;
    opAmount: number | null;
    totalAmount: number | null;
    unitPrice: number | null;
    specialFlags: string[];
    extractionConfidence: number;
  };

  const lineItemRows: LineItemRow[] = [];
  let yoursCount = 0;
  let adjCount = 0;

  for (const result of zoneResults) {
    for (const item of result.items) {
      const normalized = normalizeDescription(item.d);
      const tokens = tokenizeDescription(normalized);
      lineItemRows.push({
        comparisonId,
        zoneId: result.zoneId,
        source: result.source,
        sourceLineNumber: item.n,
        pageNumber: item.p,
        rawDescription: item.d,
        normalizedDescription: normalized,
        descriptionTokens: tokens,
        itemCode: item.code ?? null,
        rawQuantity: item.q ?? null,
        rawUnit: item.u ?? null,
        removeAmount: item.rm ?? null,
        replaceAmount: item.rp ?? null,
        resetAmount: item.rs ?? null,
        taxAmount: item.tx ?? null,
        opAmount: item.op ?? null,
        totalAmount: item.t ?? null,
        unitPrice: item.up ?? null,
        specialFlags: [],
        extractionConfidence: 1,
      });
      if (result.source === 'yours') yoursCount++;
      else adjCount++;
    }
  }

  logger.info('[n3/extract-line-items] Extraction complete', {
    comparisonId,
    yoursItems: yoursCount,
    adjItems: adjCount,
    totalItems: lineItemRows.length,
  });

  // ── 7. Idempotent DB write ──────────────────────────────────────────────────
  // When re-extracting for a specific side only, delete only that side's rows
  // so the opposite side's existing items are preserved.
  const deleteFilter = reextractSource && reextractSource !== 'both'
    ? { comparisonId, source: reextractSource }
    : { comparisonId };

  await prisma.$transaction([
    prisma.n3LineItem.deleteMany({ where: deleteFilter }),
    prisma.n3LineItem.createMany({ data: lineItemRows }),
  ]);

  logger.info('[n3/extract-line-items] n3_line_items written', {
    comparisonId,
    rows: lineItemRows.length,
  });

  return {
    yoursItemCount: yoursCount,
    adjusterItemCount: adjCount,
    totalItemCount: lineItemRows.length,
    zoneCount: zoneResults.length,
  };
}
