// ─────────────────────────────────────────────────────────────────────────────
// N4 Pipeline — Xactimate extractor: detect-zones (per-side)
//
// Per-side port of lib/n3/passes/detect-zones.ts.
//
// Key differences from N3:
//   - Operates on ONE side at a time (side: 'yours' | 'adjuster')
//   - Downloads only the PDF for that side
//   - Writes only that side's n3_zones rows (per-side idempotent delete)
//   - Concurrency cap reduced to 9 (two sides run in parallel → 18 total,
//     approximately equal to N3's single-pass cap of 17)
//
// Everything else — prompts, chunk building, merge, dedup, AI call logic —
// is imported verbatim from N2/N3 and remains unchanged. N3 is never modified.
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
import { buildPass1Chunk1Prompt } from '@/lib/n2/prompts/pass1-chunk1';
import { buildPass1ChunkNPrompt } from '@/lib/n2/prompts/pass1-chunk-n';
import {
  Pass1Chunk1ResponseSchema,
  Pass2ChunkNResponseSchema,
} from '@/lib/n2/schemas/pass-responses';
import { normalizeDescription } from '@/lib/n3/normalization';
import type { N3EstimateSource } from '@/lib/n3/types';
import type { PdfChunk } from '@/lib/n2/utils/chunk-pdf';
import type { EstimateFormat } from '@/lib/n2/schemas/types';
import type { StepLogger, DetectZonesResult } from '@/lib/n4/extractors/types';

// ── Constants ─────────────────────────────────────────────────────────────────

const ESTIMATES_BUCKET = 'estimates';
const SONNET_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ZONE_DETECTION_MAX_TOKENS = 2000;
const CHUNK_SIZE = 10;
const CHUNK_OVERLAP = 1;
const CONCURRENT_CHUNK_CALLS = 9; // N4: per-side cap (2 sides × 9 = 18 ≈ N3's 17)
const FLAT_LIST_THRESHOLD = 2;

// ── Private helpers ───────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key?.trim()) {
    throw new Error('[n4/xactimate/detect-zones] ANTHROPIC_API_KEY is not configured.');
  }
  return key.trim();
}

async function downloadPdfBytes(storagePath: string): Promise<Uint8Array> {
  const { data, error } = await supabaseAdmin.storage
    .from(ESTIMATES_BUCKET)
    .download(storagePath);
  if (error || !data) {
    throw new Error(
      `[n4/xactimate/detect-zones] Failed to download PDF at '${storagePath}': ${error?.message ?? 'Unknown error'}`,
    );
  }
  return new Uint8Array(await data.arrayBuffer());
}

async function extractCandidateHeaders(chunkBytes: Uint8Array): Promise<string[]> {
  try {
    const pdfParseModule = (await import('pdf-parse')) as unknown as {
      default: (buf: Buffer) => Promise<{ text: string }>;
    };
    const result = await pdfParseModule.default(Buffer.from(chunkBytes));
    const text = result.text ?? '';
    if (!text.trim()) return [];

    const seen = new Set<string>();
    const candidates: string[] = [];

    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.length < 3 || line.length > 80) continue;
      if (/^\d+\./.test(line)) continue;
      if (/[$%]/.test(line)) continue;
      if (/\d{3,}/.test(line)) continue;
      const letters = (line.match(/[A-Za-z]/g) ?? []).length;
      const digits = (line.match(/\d/g) ?? []).length;
      if (letters < 3 || letters <= digits) continue;
      if (!/[A-Za-z]{3,}/.test(line)) continue;
      if (seen.has(line)) continue;
      seen.add(line);
      candidates.push(line);
      if (candidates.length >= 60) break;
    }
    return candidates;
  } catch {
    return [];
  }
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
  textHints: string[];
};

async function processOneChunk(spec: ChunkCallSpec): Promise<ChunkZoneDetectionResult> {
  const {
    chunk, chunkBytes, isFirstChunk, estimatedStartPage,
    estimatedEndPage, totalPages, context, textHints,
  } = spec;

  return withRetry(
    async () => {
      const basePrompts = isFirstChunk
        ? buildPass1Chunk1Prompt({ startPage: estimatedStartPage, endPage: estimatedEndPage, totalPages })
        : buildPass1ChunkNPrompt({ startPage: estimatedStartPage, endPage: estimatedEndPage, totalPages });

      const userPrompt = textHints.length > 0
        ? `${basePrompts.user}\n\n━━━ CANDIDATE HEADERS EXTRACTED FROM PDF TEXT ━━━\nThe following lines were pulled from this chunk's embedded PDF text using a deterministic regex filter. They are NOT a list of zones — they are POTENTIAL header candidates that may include real headers, sub-category names, room labels, or noise. Cross-reference each one against the rules above before reporting. Do NOT report a candidate as a zone unless it satisfies the WHAT IS A VALID ZONE HEADER criteria.\n\n${textHints.map((h, i) => `${i + 1}. ${h}`).join('\n')}`
        : basePrompts.user;

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
          system: basePrompts.system,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'document',
                  source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
                },
                { type: 'text', text: userPrompt },
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
          `[n4/xactimate/detect-zones] Anthropic ${response.status} for ${context}: ${response.statusText} — ${errBody.slice(0, 500)}`,
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
          `[n4/xactimate/detect-zones] Response truncated for ${context} — max_tokens may be too low`,
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
              detectedFormat: parsed.format as EstimateFormat,
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
          `[n4/xactimate/detect-zones] ${context}: sanity check failed (zones=${result.zones.length}, items=${result.approxItemsOnPages}) — retrying`,
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
    const textHints = await extractCandidateHeaders(chunkBytes);
    specs.push({
      chunk,
      chunkBytes,
      isFirstChunk: chunk.chunkIndex === 0,
      estimatedStartPage: chunk.startIndex + 1,
      estimatedEndPage: chunk.endIndex + 1,
      totalPages: totalInternalPages,
      context: `${side}-chunk-${chunk.chunkIndex}`,
      textHints,
    });
  }
  return specs;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Detect zones for ONE side of a comparison and write n3_zones rows.
 *
 * Idempotent: deletes only this side's existing rows before writing.
 * Throws on unrecoverable error — the Inngest step will retry.
 */
export async function xactimateDetectZones(
  comparisonId: string,
  side: 'yours' | 'adjuster',
  logger: StepLogger,
): Promise<DetectZonesResult> {
  // ── 1. Load comparison ──────────────────────────────────────────────────────
  const comparison = await prisma.comparison.findUnique({
    where: { id: comparisonId },
    select: {
      yourEstimateStoragePath: true,
      adjusterEstimateStoragePath: true,
    },
  });
  if (!comparison) {
    throw new Error(`[n4/xactimate/detect-zones] Comparison ${comparisonId} not found`);
  }

  const storagePath = side === 'yours'
    ? comparison.yourEstimateStoragePath
    : comparison.adjusterEstimateStoragePath;

  // ── 2. Download PDF for this side ───────────────────────────────────────────
  const pdfBytes = await downloadPdfBytes(storagePath);
  const doc = await loadPdf(pdfBytes);
  const pageCount = doc.getPageCount();

  logger.info('[n4/xactimate/detect-zones] PDF loaded', {
    comparisonId, side, pages: pageCount,
  });

  // ── 3. Build chunk call specs ───────────────────────────────────────────────
  const chunks = buildChunks(pageCount, CHUNK_SIZE, CHUNK_OVERLAP);
  const specs = await buildChunkSpecs(chunks, doc, pageCount, side);

  logger.info('[n4/xactimate/detect-zones] Firing chunk AI calls', {
    comparisonId, side, chunks: specs.length,
  });

  // ── 4. Fan out with per-side concurrency cap ────────────────────────────────
  const allSettled = await runWithConcurrencyLimit(
    specs.map(s => () => processOneChunk(s)),
    CONCURRENT_CHUNK_CALLS,
  );

  // ── 5. Collect results — fail fast ─────────────────────────────────────────
  const results: ChunkZoneDetectionResult[] = [];
  for (let i = 0; i < allSettled.length; i++) {
    const settled = allSettled[i]!;
    const spec = specs[i]!;
    if (settled.status === 'rejected') {
      throw new Error(
        `[n4/xactimate/detect-zones] ${spec.context} failed after retries: ${(settled.reason as Error).message}`,
      );
    }
    results.push(settled.value);
  }

  // ── 6. Merge + dedup ────────────────────────────────────────────────────────
  let zones = mergeChunkZones(results, pageCount);
  zones = preDeduplicateZones(zones);

  // ── 7. Zero-zone fallback ───────────────────────────────────────────────────
  const flat = zones.length < FLAT_LIST_THRESHOLD;
  if (flat) {
    logger.info('[n4/xactimate/detect-zones] Flat-list detected — synthesizing General zone', {
      comparisonId, side, detectedZones: zones.length,
    });
    zones = [synthesizeGeneralZone(results, pageCount)];
  }

  const detectedFormat: EstimateFormat =
    results.find(r => r.chunk.chunkIndex === 0)?.detectedFormat ?? 'unknown';

  logger.info('[n4/xactimate/detect-zones] Detection complete', {
    comparisonId, side, zoneCount: zones.length, detectedFormat,
  });

  // ── 8. Per-side idempotent DB write ─────────────────────────────────────────
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

  logger.info('[n4/xactimate/detect-zones] n3_zones written', {
    comparisonId, side, rows: zoneRows.length,
  });

  return { zoneCount: zones.length, flat, detectedFormat };
}
