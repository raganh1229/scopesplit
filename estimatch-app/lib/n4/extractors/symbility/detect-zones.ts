// ─────────────────────────────────────────────────────────────────────────────
// N4 Pipeline — Symbility extractor: detect-zones (per-side)
//
// Zone detection for Symbility-format PDFs. Uses Symbility-specific prompts
// instead of the N2 pass1-chunk1/N prompts. Everything else (chunk building,
// AI call mechanics, merge/dedup, DB write) mirrors the Xactimate extractor.
//
// Symbility zone header pattern: "AREATYPE: Descriptive Name"
// (e.g. "ROOFPLAN: Main Roof", "FLOORPLAN: Kitchen", "EXTERIOR: Front Elevation")
//
// The AI response schema reuses Pass1Chunk1ResponseSchema / Pass2ChunkNResponseSchema
// from N2 because the JSON shape (zones[].name, zones[].start_page, etc.) is the
// same — only the prompt changes.
// ─────────────────────────────────────────────────────────────────────────────

import prisma from '@/lib/prisma';
import { supabaseAdmin } from '@/lib/supabase';
import { buildChunks } from '@/lib/n2/utils/chunk-pdf';
import { loadPdf, slicePages } from '@/lib/n2/utils/pdf-slicer';
import {
  parseAndValidate,
  withRetry,
  isTruncated,
  AIResponseError,
} from '@/lib/n2/utils/ai-response';
import {
  mergeChunkZones,
  preDeduplicateZones,
  synthesizeGeneralZone,
  type ChunkZoneDetectionResult,
} from '@/lib/n2/utils/zone-merge';
import {
  Pass1Chunk1ResponseSchema,
  Pass2ChunkNResponseSchema,
} from '@/lib/n2/schemas/pass-responses';
import { normalizeDescription } from '@/lib/n3/normalization';
import type { N3EstimateSource } from '@/lib/n3/types';
import type { PdfChunk } from '@/lib/n2/utils/chunk-pdf';
import type { EstimateFormat } from '@/lib/n2/schemas/types';
import { buildSymbilityChunk1Prompt, buildSymbilityChunkNPrompt } from './prompts/zone-detection';
import type { StepLogger, DetectZonesResult } from '@/lib/n4/extractors/types';

// ── Constants ─────────────────────────────────────────────────────────────────

const ESTIMATES_BUCKET = 'estimates';
const SONNET_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ZONE_DETECTION_MAX_TOKENS = 2000;
const CHUNK_SIZE = 10;
const CHUNK_OVERLAP = 1;
const CONCURRENT_CHUNK_CALLS = 9;
const FLAT_LIST_THRESHOLD = 2;

// ── Private helpers ───────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key?.trim()) {
    throw new Error('[n4/symbility/detect-zones] ANTHROPIC_API_KEY is not configured.');
  }
  return key.trim();
}

async function downloadPdfBytes(storagePath: string): Promise<Uint8Array> {
  const { data, error } = await supabaseAdmin.storage
    .from(ESTIMATES_BUCKET)
    .download(storagePath);
  if (error || !data) {
    throw new Error(
      `[n4/symbility/detect-zones] Failed to download PDF at '${storagePath}': ${error?.message ?? 'Unknown error'}`,
    );
  }
  return new Uint8Array(await data.arrayBuffer());
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

// ── Single-chunk AI call ──────────────────────────────────────────────────────

type ChunkCallSpec = {
  chunk: PdfChunk;
  chunkBytes: Uint8Array;
  isFirstChunk: boolean;
  estimatedStartPage: number;
  estimatedEndPage: number;
  totalPages: number;
  context: string;
};

async function processOneChunk(spec: ChunkCallSpec): Promise<ChunkZoneDetectionResult> {
  const { chunk, chunkBytes, isFirstChunk, estimatedStartPage, estimatedEndPage, totalPages, context } = spec;

  return withRetry(
    async () => {
      const prompts = isFirstChunk
        ? buildSymbilityChunk1Prompt({ startPage: estimatedStartPage, endPage: estimatedEndPage, totalPages })
        : buildSymbilityChunkNPrompt({ startPage: estimatedStartPage, endPage: estimatedEndPage, totalPages });

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
          max_tokens: ZONE_DETECTION_MAX_TOKENS,
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
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        let errBody = '';
        try { errBody = await response.text(); } catch { /* ignore */ }
        throw new AIResponseError(
          `[n4/symbility/detect-zones] Anthropic ${response.status} for ${context}: ${response.statusText} — ${errBody.slice(0, 500)}`,
          response.status >= 500 || response.status === 429 || response.status === 400,
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
          `[n4/symbility/detect-zones] Response truncated for ${context}`,
          true,
          context,
        );
      }

      const result = isFirstChunk
        ? (() => {
            const parsed = parseAndValidate(text, Pass1Chunk1ResponseSchema, context);
            return {
              chunk,
              firstPagePrintedNumber: parsed.first_page_printed_number,
              approxItemsOnPages: parsed.approx_items_on_pages,
              detectedFormat: 'symbility' as EstimateFormat,
              zones: parsed.zones.map(z => ({
                name: z.name,
                startPage: z.start_page,
                evidenceItem: z.evidence_item,
                approxItems: z.approx_items,
              })),
            };
          })()
        : (() => {
            const parsed = parseAndValidate(text, Pass2ChunkNResponseSchema, context);
            return {
              chunk,
              firstPagePrintedNumber: parsed.first_page_printed_number,
              approxItemsOnPages: parsed.approx_items_on_pages,
              zones: parsed.zones.map(z => ({
                name: z.name,
                startPage: z.start_page,
                evidenceItem: z.evidence_item,
                approxItems: z.approx_items,
              })),
            };
          })();

      const suspiciouslyEmpty = result.zones.length === 0 && result.approxItemsOnPages >= 5;
      const suspiciouslyCollapsed = result.zones.length === 1 && result.approxItemsOnPages >= 50;
      if (suspiciouslyEmpty || suspiciouslyCollapsed) {
        throw new AIResponseError(
          `[n4/symbility/detect-zones] ${context}: sanity check failed (zones=${result.zones.length}, items=${result.approxItemsOnPages}) — retrying`,
          true,
          context,
        );
      }

      return result;
    },
    5,
    context,
  );
}

// ── Chunk spec builder ────────────────────────────────────────────────────────

async function buildChunkSpecs(
  chunks: PdfChunk[],
  doc: Awaited<ReturnType<typeof loadPdf>>,
  totalInternalPages: number,
  side: 'yours' | 'adjuster',
): Promise<ChunkCallSpec[]> {
  const specs: ChunkCallSpec[] = [];
  for (const chunk of chunks) {
    const chunkBytes = await slicePages(doc, chunk.startIndex, chunk.endIndex);
    specs.push({
      chunk,
      chunkBytes,
      isFirstChunk: chunk.chunkIndex === 0,
      estimatedStartPage: chunk.startIndex + 1,
      estimatedEndPage: chunk.endIndex + 1,
      totalPages: totalInternalPages,
      context: `${side}-chunk-${chunk.chunkIndex}`,
    });
  }
  return specs;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Detect zones for ONE side of a Symbility comparison.
 * Always writes detectedFormat = 'symbility' (the AI prompt enforces this).
 */
export async function symbilityDetectZones(
  comparisonId: string,
  side: 'yours' | 'adjuster',
  logger: StepLogger,
): Promise<DetectZonesResult> {
  const comparison = await prisma.comparison.findUnique({
    where: { id: comparisonId },
    select: {
      yourEstimateStoragePath: true,
      adjusterEstimateStoragePath: true,
    },
  });
  if (!comparison) {
    throw new Error(`[n4/symbility/detect-zones] Comparison ${comparisonId} not found`);
  }

  const storagePath = side === 'yours'
    ? comparison.yourEstimateStoragePath
    : comparison.adjusterEstimateStoragePath;

  const pdfBytes = await downloadPdfBytes(storagePath);
  const doc = await loadPdf(pdfBytes);
  const pageCount = doc.getPageCount();

  logger.info('[n4/symbility/detect-zones] PDF loaded', { comparisonId, side, pages: pageCount });

  const chunks = buildChunks(pageCount, CHUNK_SIZE, CHUNK_OVERLAP);
  const specs = await buildChunkSpecs(chunks, doc, pageCount, side);

  logger.info('[n4/symbility/detect-zones] Firing chunk AI calls', {
    comparisonId, side, chunks: specs.length,
  });

  const allSettled = await runWithConcurrencyLimit(
    specs.map(s => () => processOneChunk(s)),
    CONCURRENT_CHUNK_CALLS,
  );

  const results: ChunkZoneDetectionResult[] = [];
  for (let i = 0; i < allSettled.length; i++) {
    const settled = allSettled[i]!;
    const spec = specs[i]!;
    if (settled.status === 'rejected') {
      throw new Error(
        `[n4/symbility/detect-zones] ${spec.context} failed after retries: ${(settled.reason as Error).message}`,
      );
    }
    results.push(settled.value);
  }

  let zones = mergeChunkZones(results, pageCount);
  zones = preDeduplicateZones(zones);

  const flat = zones.length < FLAT_LIST_THRESHOLD;
  if (flat) {
    logger.info('[n4/symbility/detect-zones] Flat-list detected — synthesizing General zone', {
      comparisonId, side, detectedZones: zones.length,
    });
    zones = [synthesizeGeneralZone(results, pageCount)];
  }

  logger.info('[n4/symbility/detect-zones] Detection complete', {
    comparisonId, side, zoneCount: zones.length,
  });

  const zoneRows = zones.map(z => ({
    comparisonId,
    source: side as N3EstimateSource,
    name: z.name,
    normalizedName: normalizeDescription(z.name),
    startPage: z.startPage,
    endPage: z.endPage,
    approxItems: z.approxItems,
    verificationStatus: 'ai_proposed',
  }));

  await prisma.$transaction([
    prisma.n3Zone.deleteMany({ where: { comparisonId, source: side } }),
    prisma.n3Zone.createMany({ data: zoneRows }),
  ]);

  logger.info('[n4/symbility/detect-zones] n3_zones written', {
    comparisonId, side, rows: zoneRows.length,
  });

  return { zoneCount: zones.length, flat, detectedFormat: 'symbility' };
}
