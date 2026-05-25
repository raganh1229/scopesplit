// ─────────────────────────────────────────────────────────────────────────────
// N4 Pipeline — Xactimate extractor: extract-line-items (per-side)
//
// Per-side port of lib/n3/passes/extract-line-items.ts.
//
// Key differences from N3:
//   - Operates on ONE side at a time (side: 'yours' | 'adjuster')
//   - Downloads only the PDF for that side
//   - Writes only that side's n3_line_items rows (per-side idempotent delete)
//   - Concurrency cap reduced to 9 (two sides run in parallel via orchestrator)
//   - hasNumberedLineItems regex extended: also matches Symbility-style integer
//     item numbers without a trailing period (e.g. "2  Tear Out - Shingles")
//
// Everything else — Zod schemas, extraction prompt, merge logic, DB row shape —
// is imported from or mirrors N3 exactly. N3 is never modified.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import prisma from '@/lib/prisma';
import { supabaseAdmin } from '@/lib/supabase';
import { loadPdf, slicePages } from '@/lib/n2/utils/pdf-slicer';
import { parseAndValidate, withRetry, isTruncated, AIResponseError } from '@/lib/n2/utils/ai-response';
import { buildExtractionPrompt } from '@/lib/n3/prompts/extraction';
import { normalizeDescription, tokenizeDescription } from '@/lib/n3/normalization';
import type { EstimateFormat } from '@/lib/n2/schemas/types';
import type { StepLogger, ExtractLineItemsResult } from '@/lib/n4/extractors/types';

// ── Constants ─────────────────────────────────────────────────────────────────

const ESTIMATES_BUCKET = 'estimates';
const SONNET_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const BASE_MAX_TOKENS = 32768;
const MAX_TOKENS_CAP = 32768;
const TOKENS_PER_PAGE = 2400;
const CONCURRENT_ZONE_CALLS = 9; // N4: per-side cap (two sides run in parallel)
const FETCH_TIMEOUT_MS = 180_000;
const ITEM_SPLIT_THRESHOLD = 60;
const MAX_PAGES_PER_CHUNK = 2;
const CHUNK_OVERLAP_PAGES = 1;

// ── Zod schema for AI response ────────────────────────────────────────────────

const N4ExtractedItemSchema = z.object({
  n:    z.number().int().positive(),
  p:    z.number().int().positive(),
  d:    z.string().min(1),
  code: z.string().nullable().default(null),
  q:    z.string().nullable().default(null),
  u:    z.string().nullable().default(null),
  up:   z.number().nullable().default(null),
  rm:   z.number().nullable().default(null),
  rp:   z.number().nullable().default(null),
  rs:   z.number().nullable().default(null),
  tx:   z.number().nullable().default(null),
  op:   z.number().nullable().default(null),
  t:    z.number().nullable().default(null),
});

const ZoneExtractionResponseSchema = z.object({
  zone:  z.string().min(1),
  items: z.array(N4ExtractedItemSchema),
});

type ExtractedZoneResult = {
  zoneId: string;
  source: string;
  items: z.input<typeof N4ExtractedItemSchema>[];
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key?.trim()) {
    throw new Error('[n4/xactimate/extract-line-items] ANTHROPIC_API_KEY is not configured.');
  }
  return key.trim();
}

async function downloadPdfBytes(storagePath: string): Promise<Uint8Array> {
  const { data, error } = await supabaseAdmin.storage
    .from(ESTIMATES_BUCKET)
    .download(storagePath);
  if (error || !data) {
    throw new Error(
      `[n4/xactimate/extract-line-items] Failed to download PDF at '${storagePath}': ${error?.message ?? 'Unknown error'}`,
    );
  }
  return new Uint8Array(await data.arrayBuffer());
}

function printedToInternal(printedPage: number, totalPages: number): number {
  return Math.max(0, Math.min(printedPage - 1, totalPages - 1));
}

function computeMaxTokens(pageSpan: number): number {
  return Math.max(BASE_MAX_TOKENS, Math.min(pageSpan * TOKENS_PER_PAGE, MAX_TOKENS_CAP));
}

function deduplicateItems(
  items: z.input<typeof N4ExtractedItemSchema>[],
): z.input<typeof N4ExtractedItemSchema>[] {
  const seen = new Set<number>();
  return items.filter(item => {
    if (seen.has(item.n)) return false;
    seen.add(item.n);
    return true;
  });
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

// ── Pre-flight: numbered item detection ───────────────────────────────────────

/**
 * Returns true if the PDF appears to contain numbered line items.
 *
 * Recognises BOTH Xactimate style (e.g. "1.  Remove drywall") AND
 * Symbility style (e.g. "2  Tear Out - Shingles") so mixed-format
 * comparisons aren't blocked by the pre-flight check.
 *
 * Returns true (don't block) on pdf-parse failure or very short text.
 * Returns false (block) only when text is extractable AND has no numbered items.
 */
async function hasNumberedLineItems(pdfBytes: Uint8Array | Buffer): Promise<boolean> {
  try {
    const pdfParseModule = (await import('pdf-parse')) as unknown as {
      default: (buf: Buffer) => Promise<{ text: string }>;
    };
    const result = await pdfParseModule.default(Buffer.from(pdfBytes));
    const text = result.text ?? '';
    if (text.trim().length < 200) return true;

    // Xactimate: "1.  Description" — period required
    const xactimatePat = /\b[1-9]\d{0,3}\.\s{1,4}[A-Za-z$]/g;
    // Symbility: "2  Description" — two+ spaces, no period
    const symbilityPat = /\b[1-9]\d{0,3}\s{2,5}[A-Za-z]/g;

    const xacMatches = text.match(xactimatePat) ?? [];
    const symMatches = text.match(symbilityPat) ?? [];

    return xacMatches.length >= 3 || symMatches.length >= 3;
  } catch {
    return true;
  }
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
          `[n4/xactimate/extract-line-items] Anthropic ${response.status} for ${context}: ${response.statusText}`,
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
          `[n4/xactimate/extract-line-items] Response truncated for ${context} (maxTokens=${maxTokens})`,
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
    const endInternal = printedToInternal(chunkEnd + 1, totalPages);

    let chunkBytes: Uint8Array;
    try {
      chunkBytes = await slicePages(doc, startInternal, endInternal);
    } catch (err) {
      logger.warn('[n4/xactimate/extract-line-items] Failed to slice sub-chunk — skipping', {
        comparisonId, zoneName: zone.name, chunkStart, chunkEnd,
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

  logger.info('[n4/xactimate/extract-line-items] Splitting large zone into sub-chunks', {
    comparisonId, zoneName: zone.name, pageSpan, subChunks: subSpecs.length,
  });

  const subResults = await Promise.all(subSpecs.map(spec => extractZone(spec)));

  const allItems: z.input<typeof N4ExtractedItemSchema>[] = [];
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

  return { zoneId: zone.id, source: zone.source, items: allItems };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Extract all line items for ONE side and write n3_line_items rows.
 *
 * Idempotent: deletes only this side's existing rows before writing
 * (unless reextractSource narrows the scope further).
 * Throws on unrecoverable error — the Inngest step will retry.
 */
export async function xactimateExtractLineItems(
  comparisonId: string,
  side: 'yours' | 'adjuster',
  logger: StepLogger,
  reextractSource?: 'yours' | 'adjuster' | 'both',
): Promise<ExtractLineItemsResult> {
  // ── 1. Load comparison + zones for this side ────────────────────────────────
  const comparison = await prisma.comparison.findUnique({
    where: { id: comparisonId },
    select: {
      yourEstimateStoragePath: true,
      adjusterEstimateStoragePath: true,
      yourEstimateFormat: true,
      adjusterEstimateFormat: true,
    },
  });
  if (!comparison) {
    throw new Error(`[n4/xactimate/extract-line-items] Comparison ${comparisonId} not found`);
  }

  // When re-extracting, scope to the requested side only
  const sourceFilter = reextractSource && reextractSource !== 'both'
    ? { source: reextractSource }
    : { source: side };

  const zones = await prisma.n3Zone.findMany({
    where: { comparisonId, ...sourceFilter },
    select: { id: true, source: true, name: true, startPage: true, endPage: true, approxItems: true },
    orderBy: [{ source: 'asc' }, { startPage: 'asc' }],
  });

  if (zones.length === 0) {
    logger.warn('[n4/xactimate/extract-line-items] No zones found for side — Phase 4 may not have run', {
      comparisonId, side,
    });
    return { itemCount: 0 };
  }

  // ── 2. Download PDF for this side ───────────────────────────────────────────
  const storagePath = side === 'yours'
    ? comparison.yourEstimateStoragePath
    : comparison.adjusterEstimateStoragePath;

  const pdfBytes = await downloadPdfBytes(storagePath);
  const doc = await loadPdf(pdfBytes);
  const totalPages = doc.getPageCount();

  // ── Pre-flight: confirm PDF contains numbered line items ────────────────────
  const hasNumbers = await hasNumberedLineItems(pdfBytes);
  if (!hasNumbers) {
    throw new Error(
      `[n4/xactimate/extract-line-items] Pre-flight failed: the ${side === 'yours' ? 'contractor' : "adjuster's"} estimate ` +
      `does not appear to contain numbered line items (e.g. "1.", "2." or "2  Description"). ` +
      `Please ensure the file is a valid Xactimate or Symbility estimate and re-upload.`,
    );
  }

  // Resolve format for this side
  const VALID_FORMATS = new Set(['xactimate', 'symbility', 'unknown']);
  const rawFormat = side === 'yours' ? comparison.yourEstimateFormat : comparison.adjusterEstimateFormat;
  const format: EstimateFormat = VALID_FORMATS.has(rawFormat)
    ? (rawFormat as EstimateFormat)
    : 'unknown';

  logger.info('[n4/xactimate/extract-line-items] Building zone call specs', {
    comparisonId, side, zones: zones.length, totalPages, format,
  });

  // ── 3. Partition zones: small vs large ──────────────────────────────────────
  const smallZones: typeof zones = [];
  const largeZones: typeof zones = [];
  for (const zone of zones) {
    if ((zone.approxItems ?? 0) > ITEM_SPLIT_THRESHOLD) {
      largeZones.push(zone);
    } else {
      smallZones.push(zone);
    }
  }

  // ── 4a. Build call specs for small zones ────────────────────────────────────
  const specs: ZoneCallSpec[] = [];
  for (const zone of smallZones) {
    const pageSpan = zone.endPage - zone.startPage + 1;
    const startInternal = printedToInternal(zone.startPage, totalPages);
    const endInternal = printedToInternal(zone.endPage + 1, totalPages);

    let chunkBytes: Uint8Array;
    try {
      chunkBytes = await slicePages(doc, startInternal, endInternal);
    } catch (err) {
      logger.warn('[n4/xactimate/extract-line-items] Failed to slice zone pages — skipping', {
        comparisonId, zoneId: zone.id, zoneName: zone.name,
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

  // ── 4b. Extract large zones ─────────────────────────────────────────────────
  const largeZoneResults: ExtractedZoneResult[] = [];
  for (const zone of largeZones) {
    const result = await extractLargeZone(zone, doc, totalPages, format, logger, comparisonId);
    largeZoneResults.push(result);
  }

  // ── 4c. Fan out small zones with per-side concurrency cap ───────────────────
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
        `[n4/xactimate/extract-line-items] Zone "${spec.zoneName}" (${spec.source}) failed after retries: ${(settled.reason as Error).message}`,
      );
    }
    zoneResults.push(settled.value);
  }

  // ── 6. Map to n3_line_items row shape ───────────────────────────────────────
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
    }
  }

  logger.info('[n4/xactimate/extract-line-items] Extraction complete', {
    comparisonId, side, itemCount: lineItemRows.length,
  });

  // ── 7. Per-side idempotent DB write ─────────────────────────────────────────
  const deleteFilter = reextractSource && reextractSource !== 'both'
    ? { comparisonId, source: reextractSource }
    : { comparisonId, source: side };

  await prisma.$transaction([
    prisma.n3LineItem.deleteMany({ where: deleteFilter }),
    prisma.n3LineItem.createMany({ data: lineItemRows }),
  ]);

  logger.info('[n4/xactimate/extract-line-items] n3_line_items written', {
    comparisonId, side, rows: lineItemRows.length,
  });

  return { itemCount: lineItemRows.length };
}
