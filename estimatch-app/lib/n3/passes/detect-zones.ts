// ─────────────────────────────────────────────────────────────────────────────
// N3 Pipeline — Phase 4: detect-zones
//
// Detects zone boundaries in both estimate PDFs and writes N3Zone rows to the
// `n3_zones` table. Triggered from Inngest step `p4-detect-zones`.
//
// Algorithm (mirrors N2's detect-zones.ts; output target is the key difference):
//   1. Load comparison → get Supabase storage paths for both PDFs
//   2. Download both PDFs
//   3. Load into pdf-lib → get internal page counts
//   4. Build overlapping 10-page chunks per estimate
//   5. Slice all chunk sub-PDFs + extract candidate header hints from text
//   6. Fan out all chunk AI calls (Sonnet) with concurrency cap
//   7. Collect results; fail fast on any chunk exhausting retries
//   8. mergeChunkZones → sorted, endPage-annotated N2DetectedZone[] per side
//   9. preDeduplicateZones → collapse floor-prefix duplicates
//  10. Zero-zone fallback → synthesizeGeneralZone for flat-list estimates
//  11. Idempotent write: deleteMany existing n3_zones → createMany new rows
//
// Reuses from N2 (no duplication of logic):
//   - buildChunks / PdfChunk (chunk-pdf.ts)
//   - loadPdf / slicePages (pdf-slicer.ts)
//   - withRetry / AIResponseError / parseAndValidate / isTruncated (ai-response.ts)
//   - mergeChunkZones / preDeduplicateZones / synthesizeGeneralZone (zone-merge.ts)
//   - Pass 1 chunk 1/N prompts (pass1-chunk1.ts / pass1-chunk-n.ts)
//   - Pass1Chunk1ResponseSchema / Pass2ChunkNResponseSchema (pass-responses.ts)
//
// N3-specific additions:
//   - normalizedName: normalizeDescription(name) from lib/n3/normalization.ts
//   - verificationStatus: 'ai_proposed' (to be changed by Phase 5 UI)
//   - source: 'yours' | 'adjuster' (N3's asymmetric side identity)
//   - Output target: n3_zones table (not ComparisonProcessingState JSON)
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

// ── Logger interface ───────────────────────────────────────────────────────────
// Structural interface compatible with Inngest's logger passed from step handlers.
export type StepLogger = {
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const ESTIMATES_BUCKET = 'estimates';
const SONNET_MODEL = 'claude-sonnet-4-5';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ZONE_DETECTION_MAX_TOKENS = 2000;
const CHUNK_SIZE = 10;
const CHUNK_OVERLAP = 1;
const CONCURRENT_CHUNK_CALLS = 5;
const FLAT_LIST_THRESHOLD = 2;

// ── Return type ───────────────────────────────────────────────────────────────

export type DetectZonesN3Result = {
  yoursZoneCount: number;
  adjusterZoneCount: number;
  yoursFlat: boolean;
  adjusterFlat: boolean;
  yoursFormat: EstimateFormat;
  adjusterFormat: EstimateFormat;
};

// ── Private helpers ───────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key?.trim()) {
    throw new Error('[n3/detect-zones] ANTHROPIC_API_KEY is not configured.');
  }
  return key.trim();
}

async function downloadPdfBytes(storagePath: string): Promise<Uint8Array> {
  const { data, error } = await supabaseAdmin.storage
    .from(ESTIMATES_BUCKET)
    .download(storagePath);
  if (error || !data) {
    throw new Error(
      `[n3/detect-zones] Failed to download PDF at '${storagePath}': ${error?.message ?? 'Unknown error'}`,
    );
  }
  return new Uint8Array(await data.arrayBuffer());
}

/**
 * Extract candidate header lines from a chunk's PDF text using pdf-parse.
 * Best-effort: returns [] on any failure (encrypted PDFs, scanned images, etc.)
 * so the pipeline degrades gracefully to vision-only without breaking.
 */
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

/**
 * Runs an array of thunks with at most `limit` in-flight simultaneously.
 * Returns results in original order as PromiseSettledResult[].
 */
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
      });

      if (!response.ok) {
        throw new AIResponseError(
          `[n3/detect-zones] Anthropic ${response.status} for ${context}: ${response.statusText}`,
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
          `[n3/detect-zones] Response truncated for ${context} — max_tokens may be too low`,
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

      // Structural sanity checks
      const suspiciouslyEmpty = result.zones.length === 0 && result.approxItemsOnPages >= 5;
      const suspiciouslyCollapsed = result.zones.length === 1 && result.approxItemsOnPages >= 50;
      if (suspiciouslyEmpty || suspiciouslyCollapsed) {
        throw new AIResponseError(
          `[n3/detect-zones] ${context}: sanity check failed (zones=${result.zones.length}, items=${result.approxItemsOnPages}) — retrying`,
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
 * Run zone detection for both estimates and write N3Zone rows to `n3_zones`.
 *
 * Idempotent: deletes all existing n3_zones for this comparisonId before
 * writing so Inngest step retries are clean.
 *
 * Throws on any unrecoverable error. The calling Inngest step will retry.
 */
export async function detectZonesN3(
  comparisonId: string,
  logger: StepLogger,
): Promise<DetectZonesN3Result> {
  // ── 1. Load comparison ──────────────────────────────────────────────────────
  const comparison = await prisma.comparison.findUnique({
    where: { id: comparisonId },
    select: {
      yourEstimateStoragePath: true,
      adjusterEstimateStoragePath: true,
    },
  });
  if (!comparison) {
    throw new Error(`[n3/detect-zones] Comparison ${comparisonId} not found`);
  }

  // ── 2. Download both PDFs ───────────────────────────────────────────────────
  const [yoursBytes, adjBytes] = await Promise.all([
    downloadPdfBytes(comparison.yourEstimateStoragePath),
    downloadPdfBytes(comparison.adjusterEstimateStoragePath),
  ]);

  // ── 3. Load into pdf-lib ────────────────────────────────────────────────────
  const [yoursDoc, adjDoc] = await Promise.all([loadPdf(yoursBytes), loadPdf(adjBytes)]);
  const yoursPageCount = yoursDoc.getPageCount();
  const adjPageCount = adjDoc.getPageCount();

  logger.info('[n3/detect-zones] PDFs loaded', {
    comparisonId,
    yoursPages: yoursPageCount,
    adjPages: adjPageCount,
  });

  // ── 4+5. Build chunk call specs ─────────────────────────────────────────────
  const yoursChunks = buildChunks(yoursPageCount, CHUNK_SIZE, CHUNK_OVERLAP);
  const adjChunks = buildChunks(adjPageCount, CHUNK_SIZE, CHUNK_OVERLAP);

  const [yoursSpecs, adjSpecs] = await Promise.all([
    buildChunkSpecs(yoursChunks, yoursDoc, yoursPageCount, 'yours'),
    buildChunkSpecs(adjChunks, adjDoc, adjPageCount, 'adjuster'),
  ]);

  logger.info('[n3/detect-zones] Firing chunk AI calls', {
    comparisonId,
    yoursChunks: yoursSpecs.length,
    adjChunks: adjSpecs.length,
    total: yoursSpecs.length + adjSpecs.length,
  });

  // ── 6. Fan out with concurrency cap ─────────────────────────────────────────
  const allSpecs = [...yoursSpecs, ...adjSpecs];
  const allSettled = await runWithConcurrencyLimit(
    allSpecs.map(s => () => processOneChunk(s)),
    CONCURRENT_CHUNK_CALLS,
  );

  // ── 7. Collect results — fail fast ─────────────────────────────────────────
  const yoursResults: ChunkZoneDetectionResult[] = [];
  const adjResults: ChunkZoneDetectionResult[] = [];

  for (let i = 0; i < allSettled.length; i++) {
    const settled = allSettled[i]!;
    const spec = allSpecs[i]!;
    if (settled.status === 'rejected') {
      throw new Error(
        `[n3/detect-zones] ${spec.context} failed after retries: ${(settled.reason as Error).message}`,
      );
    }
    if (i < yoursSpecs.length) {
      yoursResults.push(settled.value);
    } else {
      adjResults.push(settled.value);
    }
  }

  // ── 8. Merge chunk results ──────────────────────────────────────────────────
  let yoursZones = mergeChunkZones(yoursResults, yoursPageCount);
  let adjZones = mergeChunkZones(adjResults, adjPageCount);

  // ── 9. Pre-dedup ────────────────────────────────────────────────────────────
  yoursZones = preDeduplicateZones(yoursZones);
  adjZones = preDeduplicateZones(adjZones);

  // ── 10. Zero-zone fallback ──────────────────────────────────────────────────
  const yoursFlat = yoursZones.length < FLAT_LIST_THRESHOLD;
  const adjFlat = adjZones.length < FLAT_LIST_THRESHOLD;

  if (yoursFlat) {
    logger.info('[n3/detect-zones] yours classified as flat-list — synthesizing General zone', {
      comparisonId,
      detectedZones: yoursZones.length,
    });
    yoursZones = [synthesizeGeneralZone(yoursResults, yoursPageCount)];
  }
  if (adjFlat) {
    logger.info('[n3/detect-zones] adjuster classified as flat-list — synthesizing General zone', {
      comparisonId,
      detectedZones: adjZones.length,
    });
    adjZones = [synthesizeGeneralZone(adjResults, adjPageCount)];
  }

  const yoursFormat: EstimateFormat =
    yoursResults.find(r => r.chunk.chunkIndex === 0)?.detectedFormat ?? 'unknown';
  const adjFormat: EstimateFormat =
    adjResults.find(r => r.chunk.chunkIndex === 0)?.detectedFormat ?? 'unknown';

  logger.info('[n3/detect-zones] Detection complete', {
    comparisonId,
    yoursZones: yoursZones.length,
    adjZones: adjZones.length,
    yoursFormat,
    adjFormat,
  });

  // ── 11. Idempotent DB write ─────────────────────────────────────────────────
  const toN3ZoneRows = (
    zones: typeof yoursZones,
    source: N3EstimateSource,
  ) =>
    zones.map(z => ({
      comparisonId,
      source,
      name: z.name,
      normalizedName: normalizeDescription(z.name),
      startPage: z.startPage,
      endPage: z.endPage,
      approxItems: z.approxItems,
      verificationStatus: 'ai_proposed',
    }));

  await prisma.$transaction([
    prisma.n3Zone.deleteMany({ where: { comparisonId } }),
    prisma.n3Zone.createMany({
      data: [
        ...toN3ZoneRows(yoursZones, 'yours'),
        ...toN3ZoneRows(adjZones, 'adjuster'),
      ],
    }),
  ]);

  logger.info('[n3/detect-zones] n3_zones written', {
    comparisonId,
    yoursRows: yoursZones.length,
    adjRows: adjZones.length,
  });

  return {
    yoursZoneCount: yoursZones.length,
    adjusterZoneCount: adjZones.length,
    yoursFlat,
    adjusterFlat: adjFlat,
    yoursFormat,
    adjusterFormat: adjFormat,
  };
}
