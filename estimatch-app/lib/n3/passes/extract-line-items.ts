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
const SONNET_MODEL = 'claude-sonnet-4-5';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const EXTRACTION_MAX_TOKENS = 4096;
const CONCURRENT_ZONE_CALLS = 5;

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
  items: z.infer<typeof N3ExtractedItemSchema>[];
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
};

async function extractZone(spec: ZoneCallSpec): Promise<ExtractedZoneResult> {
  const { zoneId, zoneName, source, startPage, endPage, format, chunkBytes, context } = spec;

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
          max_tokens: EXTRACTION_MAX_TOKENS,
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
          `[n3/extract-line-items] Response truncated for ${context} — increase max_tokens`,
          true,
          context,
        );
      }

      const parsed = parseAndValidate(text, ZoneExtractionResponseSchema, context);
      return { zoneId, source, items: parsed.items };
    },
    3,
    context,
  );
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

  const zones = await prisma.n3Zone.findMany({
    where: { comparisonId },
    select: { id: true, source: true, name: true, startPage: true, endPage: true },
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

  // ── 3. Build call specs (slice zone sub-PDFs) ───────────────────────────────
  const specs: ZoneCallSpec[] = [];

  for (const zone of zones) {
    const doc = zone.source === 'yours' ? yoursDoc : adjDoc;
    const totalPages = zone.source === 'yours' ? yoursTotalPages : adjTotalPages;
    const format = zone.source === 'yours' ? yoursFormat : adjFormat;

    const startInternal = printedToInternal(zone.startPage, totalPages);
    const endInternal = printedToInternal(zone.endPage, totalPages);

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
    });
  }

  logger.info('[n3/extract-line-items] Firing extraction calls', {
    comparisonId,
    calls: specs.length,
  });

  // ── 4. Fan out with concurrency cap ─────────────────────────────────────────
  const allSettled = await runWithConcurrencyLimit(
    specs.map(s => () => extractZone(s)),
    CONCURRENT_ZONE_CALLS,
  );

  // ── 5. Collect results — fail fast ─────────────────────────────────────────
  const zoneResults: ExtractedZoneResult[] = [];
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
  await prisma.$transaction([
    prisma.n3LineItem.deleteMany({ where: { comparisonId } }),
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
