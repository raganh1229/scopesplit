// ─────────────────────────────────────────────────────────────────────────────
// N2 Pipeline — Step 2: detect-zones orchestrator
//
// Implements the "detect-zones" Inngest step. Given a comparisonId, produces
// an `n2:zones_detected` state payload and writes it to ComparisonProcessingState.
//
// Algorithm:
//   1. Load comparison → get storage paths for both PDFs
//   2. Download both PDFs from Supabase Storage
//   3. Load into pdf-lib PDFDocument → get internal page counts
//   4. Build overlapping 10-page chunks for each estimate
//   5. Slice all chunk sub-PDFs (sequential per doc; fast CPU work)
//   6. Fan out ALL chunk AI calls simultaneously (Pass 1/2 to Sonnet 4.6)
//      Chunk 0 of each → Pass1Chunk1 (format detection included)
//      Chunks 1+ of each → Pass1ChunkN (zone detection only)
//   7. Collect results; fail fast if any chunk exhausted its retries
//   8. mergeChunkZones → sorted, offset-annotated N2DetectedZone[]
//   9. preDeduplicateZones → collapse floor-prefix duplicates
//  10. Zero-zone fallback → synthesizeGeneralZone for flat-list estimates
//  11. Compute routing decision (zoned-zoned / flat-flat / zoned-flat / flat-zoned)
//  12. Write n2:zones_detected to ComparisonProcessingState
//
// Architecture refs: N2_SPEED_CAPACITY_ACCURACY.md §Pass 1/2, Issues 1/2/6/35/36
// ─────────────────────────────────────────────────────────────────────────────

import prisma from '@/lib/prisma';
import { supabaseAdmin } from '@/lib/supabase';
import { buildChunks } from '@/lib/n2/utils/chunk-pdf';
import { loadPdf, slicePages } from '@/lib/n2/utils/pdf-slicer';
import { parseAndValidate, withRetry, isTruncated, AIResponseError } from '@/lib/n2/utils/ai-response';
import {
  mergeChunkZones,
  preDeduplicateZones,
  synthesizeGeneralZone,
  type ChunkZoneDetectionResult,
} from '@/lib/n2/utils/zone-merge';
import { buildPass1Chunk1Prompt } from '@/lib/n2/prompts/pass1-chunk1';
import { buildPass1ChunkNPrompt } from '@/lib/n2/prompts/pass1-chunk-n';
import { Pass1Chunk1ResponseSchema, Pass2ChunkNResponseSchema } from '@/lib/n2/schemas/pass-responses';
import { writeN2Stage, N2_STAGE_ZONES_DETECTED } from '@/lib/n2/utils/n2-state';
import type { N2DetectedZone, EstimateFormat, RoutingDecision } from '@/lib/n2/schemas/types';
import type { PdfChunk } from '@/lib/n2/utils/chunk-pdf';

// ── Logger interface ──────────────────────────────────────────────────────────
// Structural interface — compatible with Inngest's logger passed from step
// handlers. Using a local interface avoids importing Inngest types here.
export type StepLogger = {
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const ESTIMATES_BUCKET = 'estimates';
const SONNET_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/** Max tokens for zone detection response. Zones-only output: very small. */
const ZONE_DETECTION_MAX_TOKENS = 2000;

/** Chunk parameters: 10 pages per chunk, 1-page overlap at boundaries. */
const CHUNK_SIZE = 10;
const CHUNK_OVERLAP = 1;

/**
 * Maximum number of Anthropic API calls that may be in-flight simultaneously.
 * Keeps large documents (100+ pages = 20+ chunks) within Anthropic's
 * requests-per-minute rate limit even on Tier 2 plans.
 */
const CONCURRENT_CHUNK_CALLS = 5;

/**
 * An estimate with fewer than this many detected zones is classified as a
 * flat-list (no zones) for routing purposes.
 */
const FLAT_LIST_THRESHOLD = 2;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function downloadPdfBytes(storagePath: string): Promise<Uint8Array> {
  const { data, error } = await supabaseAdmin.storage
    .from(ESTIMATES_BUCKET)
    .download(storagePath);
  if (error || !data) {
    throw new Error(
      `[n2/detect-zones] Failed to download PDF at '${storagePath}': ${error?.message ?? 'Unknown error'}`,
    );
  }
  const buffer = await data.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Extract candidate header lines from a chunk's PDF text using pdf-parse.
 * Returns a deduplicated list of lines that LOOK like zone/section headers
 * based on simple deterministic heuristics:
 *   - 3–80 chars
 *   - does not start with a digit followed by a period (rules out "47. Tear off ...")
 *   - does not contain $ or % or large numbers (rules out cost/qty rows)
 *   - more letters than digits
 *
 * The list is passed to the AI prompt as additional grounding so the model
 * sees deterministically-extracted potential headers alongside the visual
 * PDF. Reduces zone-detection variance dramatically on borderline PDFs.
 *
 * Fail-safe: if pdf-parse throws (encrypted PDF, malformed text streams,
 * scanned image, etc.), returns an empty array. The pipeline degrades to
 * vision-only without breaking.
 */
async function extractCandidateHeaders(chunkBytes: Uint8Array): Promise<string[]> {
  try {
    // Dynamic import — keeps module load light and isolates failure mode.
    // pdf-parse exports a CJS default function that takes a Buffer.
    const pdfParseModule = (await import('pdf-parse')) as unknown as {
      default: (buf: Buffer) => Promise<{ text: string }>;
    };
    const pdfParse = pdfParseModule.default;
    const result = await pdfParse(Buffer.from(chunkBytes));
    const text = result.text ?? '';
    if (!text.trim()) return [];

    const lines = text.split(/\r?\n/);
    const seen = new Set<string>();
    const candidates: string[] = [];

    for (const raw of lines) {
      const line = raw.trim();
      if (line.length < 3 || line.length > 80) continue;
      if (/^\d+\./.test(line)) continue; // numbered line item
      if (/[$%]/.test(line)) continue; // cost/percent
      if (/\d{3,}/.test(line)) continue; // big numbers
      // letter-to-digit ratio favors words over data
      const letters = (line.match(/[A-Za-z]/g) ?? []).length;
      const digits = (line.match(/\d/g) ?? []).length;
      if (letters < 3 || letters <= digits) continue;
      // Reject lines that look like noise (only punctuation/spaces between letter groups)
      if (!/[A-Za-z]{3,}/.test(line)) continue;

      if (seen.has(line)) continue;
      seen.add(line);
      candidates.push(line);
      if (candidates.length >= 60) break; // cap to keep prompt tight
    }

    return candidates;
  } catch {
    // Any failure → degrade to vision-only.
    return [];
  }
}

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.trim().length === 0) {
    throw new Error('[n2/detect-zones] ANTHROPIC_API_KEY is not configured.');
  }
  return key.trim();
}

// ── Single-chunk AI call ──────────────────────────────────────────────────────

type ChunkCallSpec = {
  chunk: PdfChunk;
  chunkBytes: Uint8Array;
  isFirstChunk: boolean;
  /** Estimated first printed page (internal index + 1 — approximate context for model). */
  estimatedStartPage: number;
  /** Estimated last printed page (internal index + 1 — approximate). */
  estimatedEndPage: number;
  /** Total internal pages of the full PDF. */
  totalPages: number;
  /** Short label for logging and error messages. */
  context: string;
  /**
   * Deterministically-extracted candidate header lines from the chunk's PDF
   * text. Empty if pdf-parse failed or PDF was scanned-image only. Passed
   * to the prompt as additional grounding alongside the vision input.
   */
  textHints: string[];
};

async function processOneChunk(spec: ChunkCallSpec): Promise<ChunkZoneDetectionResult> {
  const {
    chunk,
    chunkBytes,
    isFirstChunk,
    estimatedStartPage,
    estimatedEndPage,
    totalPages,
    context,
  } = spec;

  const textHints = spec.textHints;

  return withRetry(
    async () => {
      const basePrompts = isFirstChunk
        ? buildPass1Chunk1Prompt({ startPage: estimatedStartPage, endPage: estimatedEndPage, totalPages })
        : buildPass1ChunkNPrompt({ startPage: estimatedStartPage, endPage: estimatedEndPage, totalPages });

      // Layer 3 grounding: append candidate header lines pulled from the
      // chunk's PDF text streams. The model sees these alongside the
      // visual PDF so it can anchor its decisions on real document text
      // rather than recognizing layout from images alone. Empty list
      // (e.g. scanned PDF) is fine — model degrades to vision-only.
      const userPrompt = textHints.length > 0
        ? `${basePrompts.user}\n\n━━━ CANDIDATE HEADERS EXTRACTED FROM PDF TEXT ━━━\nThe following lines were pulled from this chunk's embedded PDF text using a deterministic regex filter. They are NOT a list of zones — they are POTENTIAL header candidates that may include real headers, sub-category names, room labels, or noise. Cross-reference each one against the rules above before reporting. Do NOT report a candidate as a zone unless it satisfies the WHAT IS A VALID ZONE HEADER criteria. The list is provided to ensure no real header is missed.\n\n${textHints.map((h, i) => `${i + 1}. ${h}`).join('\n')}`
        : basePrompts.user;

      const prompts = { system: basePrompts.system, user: userPrompt };

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
                  source: {
                    type: 'base64',
                    media_type: 'application/pdf',
                    data: pdfBase64,
                  },
                },
                { type: 'text', text: prompts.user },
              ],
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new AIResponseError(
          `[n2/detect-zones] Anthropic ${response.status} for ${context}: ${response.statusText}`,
          response.status >= 500 || response.status === 429, // 5xx + rate-limit are retryable
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
        // Zone detection output is tiny (~50–200 tokens) — truncation is unexpected
        throw new AIResponseError(
          `[n2/detect-zones] Response truncated for ${context} — max_tokens may be too low`,
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

      // ── Sanity gate ───────────────────────────────────────────────────
      // Two structural-failure patterns force a retry:
      //   (a) chunk reports items but ZERO zones — items must belong to
      //       some zone, so an empty zones array contradicts the count
      //   (b) chunk collapses many items into a SINGLE zone — typical of
      //       trade-grouped adjuster PDFs (Set3 case) where the model
      //       lazily reports the whole document as one section instead
      //       of the 5 trade categories actually present
      // The threshold for (b) is intentionally high (≥50 items in 1 zone)
      // so it does NOT fire on legitimate large single-room chunks
      // (e.g. a contractor "Master Bedroom" with 25–35 items per chunk).
      // Anthropic's per-call variance typically resolves the issue on
      // retry; if 5 attempts all fail, withRetry surfaces the error.
      const suspiciouslyEmpty = result.zones.length === 0 && result.approxItemsOnPages >= 5;
      const suspiciouslyCollapsed = result.zones.length === 1 && result.approxItemsOnPages >= 50;
      if (suspiciouslyEmpty || suspiciouslyCollapsed) {
        throw new AIResponseError(
          `[n2/detect-zones] ${context}: structural sanity check failed (zones=${result.zones.length}, items=${result.approxItemsOnPages}) — retrying`,
          true, // retryable
          context,
        );
      }

      return result;
    },
    5,
    context,
  );
}

// ── Chunk spec builder (sequential slice, fast CPU) ───────────────────────────

async function buildChunkSpecs(
  chunks: PdfChunk[],
  doc: Awaited<ReturnType<typeof loadPdf>>,
  totalInternalPages: number,
  side: 'e1' | 'e2',
): Promise<ChunkCallSpec[]> {
  const specs: ChunkCallSpec[] = [];
  for (const chunk of chunks) {
    const chunkBytes = await slicePages(doc, chunk.startIndex, chunk.endIndex);
    // Layer 3: extract candidate header lines from the chunk's PDF text
    // for prompt grounding. Best-effort — returns [] on any failure.
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

// ── Concurrency-limited fan-out ─────────────────────────────────────────────

/**
 * Runs an array of thunks with at most `limit` inflight at any moment.
 * Returns results in original order as PromiseSettledResult[], matching the
 * shape of Promise.allSettled() so call-sites need no changes.
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

// ── Routing decision ───────────────────────────────────────────────────────────

function routingDecision(e1Flat: boolean, e2Flat: boolean): RoutingDecision {
  if (!e1Flat && !e2Flat) return 'zoned-zoned';
  if (e1Flat && e2Flat) return 'flat-flat';
  if (!e1Flat && e2Flat) return 'zoned-flat';
  return 'flat-zoned';
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Run zone detection for both estimates and write `n2:zones_detected` state.
 * Called from Inngest Step 2 ("detect-zones").
 *
 * Throws on any unrecoverable error (chunk failure after retries, download
 * failure, schema validation failure). The Inngest step will retry the entire
 * step on throw.
 */
export async function detectZones(comparisonId: string, logger: StepLogger): Promise<void> {
  // ── 1. Load comparison ────────────────────────────────────────────────────
  const comparison = await prisma.comparison.findUnique({
    where: { id: comparisonId },
    select: {
      yourEstimateStoragePath: true,
      adjusterEstimateStoragePath: true,
    },
  });
  if (!comparison) {
    throw new Error(`[n2/detect-zones] Comparison ${comparisonId} not found`);
  }

  // ── 2. Download both PDFs ─────────────────────────────────────────────────
  const [e1Bytes, e2Bytes] = await Promise.all([
    downloadPdfBytes(comparison.yourEstimateStoragePath),
    downloadPdfBytes(comparison.adjusterEstimateStoragePath),
  ]);

  // ── 3. Load into pdf-lib ──────────────────────────────────────────────────
  const [e1Doc, e2Doc] = await Promise.all([loadPdf(e1Bytes), loadPdf(e2Bytes)]);
  const e1PageCount = e1Doc.getPageCount();
  const e2PageCount = e2Doc.getPageCount();

  logger.info('[n2/detect-zones] PDFs loaded', {
    comparisonId,
    e1Pages: e1PageCount,
    e2Pages: e2PageCount,
  });

  // ── 4+5. Build chunk call specs (slice sub-PDFs per estimate) ─────────────
  const e1Chunks = buildChunks(e1PageCount, CHUNK_SIZE, CHUNK_OVERLAP);
  const e2Chunks = buildChunks(e2PageCount, CHUNK_SIZE, CHUNK_OVERLAP);

  // E1 and E2 slicing happen concurrently (different PDFDocuments); within
  // each estimate, slicing is sequential (safe for pdf-lib internal state).
  const [e1Specs, e2Specs] = await Promise.all([
    buildChunkSpecs(e1Chunks, e1Doc, e1PageCount, 'e1'),
    buildChunkSpecs(e2Chunks, e2Doc, e2PageCount, 'e2'),
  ]);

  logger.info('[n2/detect-zones] Firing chunk AI calls', {
    comparisonId,
    e1Chunks: e1Specs.length,
    e2Chunks: e2Specs.length,
    total: e1Specs.length + e2Specs.length,
  });

  // ── 6. Fan out chunk calls with concurrency cap ───────────────────────────
  const allSpecs = [...e1Specs, ...e2Specs];
  const allSettled = await runWithConcurrencyLimit(
    allSpecs.map(s => () => processOneChunk(s)),
    CONCURRENT_CHUNK_CALLS,
  );

  // ── 7. Collect results — fail fast on any chunk failure ───────────────────
  const e1Results: ChunkZoneDetectionResult[] = [];
  const e2Results: ChunkZoneDetectionResult[] = [];

  for (let i = 0; i < allSettled.length; i++) {
    const settled = allSettled[i]!;
    const spec = allSpecs[i]!;
    if (settled.status === 'rejected') {
      throw new Error(
        `[n2/detect-zones] ${spec.context} failed after retries: ${(settled.reason as Error).message}`,
      );
    }
    if (i < e1Specs.length) {
      e1Results.push(settled.value);
    } else {
      e2Results.push(settled.value);
    }
  }

  // ── 8. Merge chunk results into zone arrays ───────────────────────────────
  let e1Zones: N2DetectedZone[] = mergeChunkZones(e1Results, e1PageCount);
  let e2Zones: N2DetectedZone[] = mergeChunkZones(e2Results, e2PageCount);

  // ── 9. Pre-dedup (floor-prefix duplicates within each estimate) ───────────
  e1Zones = preDeduplicateZones(e1Zones);
  e2Zones = preDeduplicateZones(e2Zones);

  // ── 10. Zero-zone fallback ────────────────────────────────────────────────
  const e1Flat = e1Zones.length < FLAT_LIST_THRESHOLD;
  const e2Flat = e2Zones.length < FLAT_LIST_THRESHOLD;

  if (e1Flat) {
    logger.info('[n2/detect-zones] E1 classified as flat-list — synthesizing General zone', {
      comparisonId,
      detectedZones: e1Zones.length,
    });
    e1Zones = [synthesizeGeneralZone(e1Results, e1PageCount)];
  }
  if (e2Flat) {
    logger.info('[n2/detect-zones] E2 classified as flat-list — synthesizing General zone', {
      comparisonId,
      detectedZones: e2Zones.length,
    });
    e2Zones = [synthesizeGeneralZone(e2Results, e2PageCount)];
  }

  // ── 11. Extract format + compute routing ──────────────────────────────────
  const e1Format: EstimateFormat =
    e1Results.find(r => r.chunk.chunkIndex === 0)?.detectedFormat ?? 'unknown';
  const e2Format: EstimateFormat =
    e2Results.find(r => r.chunk.chunkIndex === 0)?.detectedFormat ?? 'unknown';

  const routing = routingDecision(e1Flat, e2Flat);

  logger.info('[n2/detect-zones] Detection complete', {
    comparisonId,
    e1Zones: e1Zones.length,
    e2Zones: e2Zones.length,
    e1Format,
    e2Format,
    routing,
  });

  // ── 12. Write state ───────────────────────────────────────────────────────
  await writeN2Stage(comparisonId, N2_STAGE_ZONES_DETECTED, {
    e1Zones,
    e2Zones,
    e1Format,
    e2Format,
    routingDecision: routing,
  });
}
