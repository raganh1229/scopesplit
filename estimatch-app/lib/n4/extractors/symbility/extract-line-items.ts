// ─────────────────────────────────────────────────────────────────────────────
// N4 Pipeline — Symbility extractor: extract-line-items (per-side)
//
// Line item extraction for Symbility-format PDFs. Uses Symbility-specific
// extraction prompts (lib/n4/extractors/symbility/prompts/extraction.ts).
// Everything else — Zod schemas, AI call mechanics, large-zone chunking,
// normalizeDescription, DB row shape — mirrors the Xactimate extractor.
//
// Symbility-specific field mapping:
//   t  = Total Cost column
//   q  = Qty column
//   u  = Per column (unit code)
//   up = Unit Price column
//   code, rm, rp, rs, tx, op — always null
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import prisma from '@/lib/prisma';
import { supabaseAdmin } from '@/lib/supabase';
import { loadPdf, slicePages } from '@/lib/n2/utils/pdf-slicer';
import { parseAndValidate, withRetry, isTruncated, AIResponseError } from '@/lib/n2/utils/ai-response';
import { normalizeDescription, tokenizeDescription } from '@/lib/n3/normalization';
import { buildSymbilityExtractionPrompt } from './prompts/extraction';
import type { StepLogger, ExtractLineItemsResult } from '@/lib/n4/extractors/types';

// ── Constants ─────────────────────────────────────────────────────────────────

const ESTIMATES_BUCKET = 'estimates';
const SONNET_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const BASE_MAX_TOKENS = 32768;
const MAX_TOKENS_CAP = 32768;
const TOKENS_PER_PAGE = 2400;
const CONCURRENT_ZONE_CALLS = 9;
const FETCH_TIMEOUT_MS = 180_000;
const ITEM_SPLIT_THRESHOLD = 60;
const MAX_PAGES_PER_CHUNK = 2;
const CHUNK_OVERLAP_PAGES = 1;

// ── Zod schema for AI response ────────────────────────────────────────────────

const SymbilityExtractedItemSchema = z.object({
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
  items: z.array(SymbilityExtractedItemSchema),
});

type ExtractedZoneResult = {
  zoneId: string;
  source: string;
  items: z.input<typeof SymbilityExtractedItemSchema>[];
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key?.trim()) {
    throw new Error('[n4/symbility/extract-line-items] ANTHROPIC_API_KEY is not configured.');
  }
  return key.trim();
}

async function downloadPdfBytes(storagePath: string): Promise<Uint8Array> {
  const { data, error } = await supabaseAdmin.storage
    .from(ESTIMATES_BUCKET)
    .download(storagePath);
  if (error || !data) {
    throw new Error(
      `[n4/symbility/extract-line-items] Failed to download PDF at '${storagePath}': ${error?.message ?? 'Unknown error'}`,
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
  items: z.input<typeof SymbilityExtractedItemSchema>[],
): z.input<typeof SymbilityExtractedItemSchema>[] {
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

// ── Single-zone extraction call ───────────────────────────────────────────────

type ZoneCallSpec = {
  zoneId: string;
  zoneName: string;
  source: string;
  startPage: number;
  endPage: number;
  chunkBytes: Uint8Array;
  context: string;
  maxTokens: number;
};

async function extractZone(spec: ZoneCallSpec): Promise<ExtractedZoneResult> {
  const { zoneId, zoneName, source, startPage, endPage, chunkBytes, context, maxTokens } = spec;

  return withRetry(
    async () => {
      const prompts = buildSymbilityExtractionPrompt({
        zoneName,
        startPage,
        endPage,
        side: source === 'yours' ? 'contractor' : 'adjuster',
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
          `[n4/symbility/extract-line-items] Anthropic ${response.status} for ${context}: ${response.statusText}`,
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
          `[n4/symbility/extract-line-items] Response truncated for ${context} (maxTokens=${maxTokens})`,
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
      logger.warn('[n4/symbility/extract-line-items] Failed to slice sub-chunk — skipping', {
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
      chunkBytes,
      context: `${zone.source}-${zone.name.slice(0, 20).replace(/\s+/g, '_')}-p${chunkStart}-${chunkEnd}`,
      maxTokens: computeMaxTokens(chunkPageSpan),
    });
  }

  logger.info('[n4/symbility/extract-line-items] Splitting large zone into sub-chunks', {
    comparisonId, zoneName: zone.name, pageSpan, subChunks: subSpecs.length,
  });

  const subResults = await Promise.all(subSpecs.map(spec => extractZone(spec)));

  const allItems: z.input<typeof SymbilityExtractedItemSchema>[] = [];
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
 * Extract all line items for ONE side of a Symbility comparison.
 * Idempotent: deletes only this side's existing rows before writing.
 */
export async function symbilityExtractLineItems(
  comparisonId: string,
  side: 'yours' | 'adjuster',
  logger: StepLogger,
  reextractSource?: 'yours' | 'adjuster' | 'both',
): Promise<ExtractLineItemsResult> {
  const comparison = await prisma.comparison.findUnique({
    where: { id: comparisonId },
    select: {
      yourEstimateStoragePath: true,
      adjusterEstimateStoragePath: true,
    },
  });
  if (!comparison) {
    throw new Error(`[n4/symbility/extract-line-items] Comparison ${comparisonId} not found`);
  }

  const sourceFilter = reextractSource && reextractSource !== 'both'
    ? { source: reextractSource }
    : { source: side };

  const zones = await prisma.n3Zone.findMany({
    where: { comparisonId, ...sourceFilter },
    select: { id: true, source: true, name: true, startPage: true, endPage: true, approxItems: true },
    orderBy: [{ source: 'asc' }, { startPage: 'asc' }],
  });

  if (zones.length === 0) {
    logger.warn('[n4/symbility/extract-line-items] No zones found for side', { comparisonId, side });
    return { itemCount: 0 };
  }

  const storagePath = side === 'yours'
    ? comparison.yourEstimateStoragePath
    : comparison.adjusterEstimateStoragePath;

  const pdfBytes = await downloadPdfBytes(storagePath);
  const doc = await loadPdf(pdfBytes);
  const totalPages = doc.getPageCount();

  logger.info('[n4/symbility/extract-line-items] Building zone call specs', {
    comparisonId, side, zones: zones.length, totalPages,
  });

  const smallZones: typeof zones = [];
  const largeZones: typeof zones = [];
  for (const zone of zones) {
    if ((zone.approxItems ?? 0) > ITEM_SPLIT_THRESHOLD) {
      largeZones.push(zone);
    } else {
      smallZones.push(zone);
    }
  }

  const specs: ZoneCallSpec[] = [];
  for (const zone of smallZones) {
    const pageSpan = zone.endPage - zone.startPage + 1;
    const startInternal = printedToInternal(zone.startPage, totalPages);
    const endInternal = printedToInternal(zone.endPage + 1, totalPages);

    let chunkBytes: Uint8Array;
    try {
      chunkBytes = await slicePages(doc, startInternal, endInternal);
    } catch (err) {
      logger.warn('[n4/symbility/extract-line-items] Failed to slice zone pages — skipping', {
        comparisonId, zoneId: zone.id, zoneName: zone.name, error: (err as Error).message,
      });
      continue;
    }

    specs.push({
      zoneId: zone.id,
      zoneName: zone.name,
      source: zone.source,
      startPage: zone.startPage,
      endPage: zone.endPage,
      chunkBytes,
      context: `${zone.source}-${zone.name.slice(0, 20).replace(/\s+/g, '_')}`,
      maxTokens: computeMaxTokens(pageSpan),
    });
  }

  const largeZoneResults: ExtractedZoneResult[] = [];
  for (const zone of largeZones) {
    const result = await extractLargeZone(zone, doc, totalPages, logger, comparisonId);
    largeZoneResults.push(result);
  }

  const allSettled = await runWithConcurrencyLimit(
    specs.map(s => () => extractZone(s)),
    CONCURRENT_ZONE_CALLS,
  );

  const zoneResults: ExtractedZoneResult[] = [...largeZoneResults];
  for (let i = 0; i < allSettled.length; i++) {
    const settled = allSettled[i]!;
    const spec = specs[i]!;
    if (settled.status === 'rejected') {
      throw new Error(
        `[n4/symbility/extract-line-items] Zone "${spec.zoneName}" (${spec.source}) failed after retries: ${(settled.reason as Error).message}`,
      );
    }
    zoneResults.push(settled.value);
  }

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

  logger.info('[n4/symbility/extract-line-items] Extraction complete', {
    comparisonId, side, itemCount: lineItemRows.length,
  });

  const deleteFilter = reextractSource && reextractSource !== 'both'
    ? { comparisonId, source: reextractSource }
    : { comparisonId, source: side };

  await prisma.$transaction([
    prisma.n3LineItem.deleteMany({ where: deleteFilter }),
    prisma.n3LineItem.createMany({ data: lineItemRows }),
  ]);

  logger.info('[n4/symbility/extract-line-items] n3_line_items written', {
    comparisonId, side, rows: lineItemRows.length,
  });

  return { itemCount: lineItemRows.length };
}
