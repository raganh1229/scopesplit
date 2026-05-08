/**
 * Phase 2 smoke test — local PDF files (no DB, no Supabase required).
 *
 * Usage:
 *   npx tsx scripts/n2-smoke-local-pdfs.ts <pdfPath>
 *   npx tsx scripts/n2-smoke-local-pdfs.ts <e1Path> <e2Path>
 *
 * Example:
 *   npx tsx scripts/n2-smoke-local-pdfs.ts "../../PDFS/Fire Damage -Medium.pdf"
 *
 * Requires only ANTHROPIC_API_KEY in .env.local.
 *
 * What it does:
 *   1. Reads both PDFs from disk
 *   2. Chunks them (10 pages, 1-page overlap)
 *   3. Fires Haiku AI calls in parallel — each chunk identifies zone headers
 *   4. Merges + deduplicates zones per estimate
 *   5. Prints the full zone table + JSON payload
 *
 * Nothing is written to the database.
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import fs from 'node:fs/promises';

loadEnv({ path: path.resolve(__dirname, '..', '.env') });
loadEnv({ path: path.resolve(__dirname, '..', '.env.local'), override: true });

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌  ANTHROPIC_API_KEY is missing from .env.local — aborting.');
  process.exit(1);
}

const e1Path = process.argv[2];
const e2Path = process.argv[3] ?? null;

if (!e1Path) {
  console.error('Usage: npx tsx scripts/n2-smoke-local-pdfs.ts <pdfPath> [secondPdfPath]');
  process.exit(1);
}

// ── Imports (after env is loaded) ─────────────────────────────────────────────

import { loadPdf, slicePages } from '@/lib/n2/utils/pdf-slicer';
import { buildChunks } from '@/lib/n2/utils/chunk-pdf';
import { mergeChunkZones, preDeduplicateZones, synthesizeGeneralZone } from '@/lib/n2/utils/zone-merge';
import { buildPass1Chunk1Prompt } from '@/lib/n2/prompts/pass1-chunk1';
import { buildPass1ChunkNPrompt } from '@/lib/n2/prompts/pass1-chunk-n';
import { parseAndValidate, withRetry, isTruncated, AIResponseError } from '@/lib/n2/utils/ai-response';
import { Pass1Chunk1ResponseSchema, Pass2ChunkNResponseSchema } from '@/lib/n2/schemas/pass-responses';
import type { ChunkZoneDetectionResult } from '@/lib/n2/utils/zone-merge';
import type { PdfChunk } from '@/lib/n2/utils/chunk-pdf';

const HAIKU_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ZONE_DETECTION_MAX_TOKENS = 2000;
const CHUNK_SIZE = 10;
const OVERLAP = 1;

// ── Single chunk AI call ──────────────────────────────────────────────────────

async function processChunk(
  chunk: PdfChunk,
  chunkBytes: Uint8Array,
  isFirstChunk: boolean,
  estimatedStartPage: number,
  estimatedEndPage: number,
  totalPages: number,
  context: string,
): Promise<ChunkZoneDetectionResult> {
  return withRetry(async () => {
    const prompts = isFirstChunk
      ? buildPass1Chunk1Prompt({ startPage: estimatedStartPage, endPage: estimatedEndPage, totalPages })
      : buildPass1ChunkNPrompt({ startPage: estimatedStartPage, endPage: estimatedEndPage, totalPages });

    const pdfBase64 = Buffer.from(chunkBytes).toString('base64');

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: ZONE_DETECTION_MAX_TOKENS,
        temperature: 0,
        system: prompts.system,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
              { type: 'text', text: prompts.user },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new AIResponseError(
        `Anthropic ${response.status} for ${context}: ${response.statusText}`,
        response.status >= 500 || response.status === 429,
        context,
      );
    }

    const body = (await response.json()) as { content?: Array<{ text?: string }>; stop_reason?: string | null };
    const text = body.content?.[0]?.text ?? '';
    const stopReason = body.stop_reason ?? null;

    if (isTruncated(stopReason, text)) {
      throw new AIResponseError(`Response truncated for ${context}`, true, context);
    }

    if (isFirstChunk) {
      const parsed = parseAndValidate(text, Pass1Chunk1ResponseSchema, context);
      return {
        chunk,
        firstPagePrintedNumber: parsed.first_page_printed_number,
        approxItemsOnPages: parsed.approx_items_on_pages,
        detectedFormat: parsed.format as 'xactimate' | 'symbility' | 'unknown',
        zones: parsed.zones.map(z => ({ name: z.name, startPage: z.start_page, evidenceItem: z.evidence_item, approxItems: z.approx_items })),
      };
    }

    const parsed = parseAndValidate(text, Pass2ChunkNResponseSchema, context);
    return {
      chunk,
      firstPagePrintedNumber: parsed.first_page_printed_number,
      approxItemsOnPages: parsed.approx_items_on_pages,
      zones: parsed.zones.map(z => ({ name: z.name, startPage: z.start_page, evidenceItem: z.evidence_item, approxItems: z.approx_items })),
    };
  }, 3, context);
}

// ── Run detection for one PDF ─────────────────────────────────────────────────

async function detectZonesLocal(pdfBytes: Uint8Array, side: string) {
  const doc = await loadPdf(pdfBytes);
  const pageCount = doc.getPageCount();
  const chunks = buildChunks(pageCount, CHUNK_SIZE, OVERLAP);

  console.log(`  [${side}] ${pageCount} pages → ${chunks.length} chunks`);

  const specs = await Promise.all(
    chunks.map(async (chunk) => {
      const bytes = await slicePages(doc, chunk.startIndex, chunk.endIndex);
      return { chunk, bytes };
    })
  );

  const results = await Promise.all(
    specs.map(({ chunk, bytes }, i) =>
      processChunk(
        chunk, bytes,
        i === 0,
        chunk.startIndex + 1,
        chunk.endIndex + 1,
        pageCount,
        `${side}-chunk-${i}`,
      )
    )
  );

  let zones = mergeChunkZones(results, pageCount);
  zones = preDeduplicateZones(zones);
  if (zones.length === 0) {
    console.log(`  [${side}] No zones detected — applying General zone fallback`);
    zones = [synthesizeGeneralZone(results, pageCount)];
  }

  const format = results[0]?.detectedFormat ?? 'unknown';
  return { zones, format, pageCount };
}

// ── Print helpers ─────────────────────────────────────────────────────────────

function printZoneTable(zones: Awaited<ReturnType<typeof detectZonesLocal>>['zones']) {
  if (!zones.length) { console.log(`  (none)`); return; }
  const colW = Math.max(...zones.map(z => z.name.length), 4);
  console.log(`${'Zone'.padEnd(colW)}  Start  End   ~Items  Offset`);
  for (const z of zones) {
    console.log(
      `${z.name.padEnd(colW)}  ${String(z.startPage).padStart(5)}  ${String(z.endPage).padEnd(4)}  ${String(z.approxItems).padStart(6)}  ${z.chunkOffset}`
    );
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const absE1 = path.resolve(e1Path!);
  console.log(`\nPDF: ${absE1}`);
  if (e2Path) console.log(`E2:  ${path.resolve(e2Path)}`);
  console.log('');

  console.log('🚀  Running zone detection...\n');
  const startMs = Date.now();

  const e1Bytes = new Uint8Array(await fs.readFile(absE1));
  const e1Result = await detectZonesLocal(e1Bytes, 'e1');

  let e2Result: Awaited<ReturnType<typeof detectZonesLocal>> | null = null;
  if (e2Path) {
    const e2Bytes = new Uint8Array(await fs.readFile(path.resolve(e2Path)));
    e2Result = await detectZonesLocal(e2Bytes, 'e2');
  }

  const elapsedMs = Date.now() - startMs;
  console.log(`\n✅  Completed in ${(elapsedMs / 1000).toFixed(1)}s`);

  console.log('\n━━━ SUMMARY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Format    : ${e1Result.format}  (${e1Result.pageCount} pages, ${e1Result.zones.length} zones)`);

  console.log('\n─── Zones ───────────────────────────────────────────────────────');
  printZoneTable(e1Result.zones);

  if (e2Result) {
    console.log(`\nE2 Format : ${e2Result.format}  (${e2Result.pageCount} pages, ${e2Result.zones.length} zones)`);
    console.log('\n─── E2 Zones ────────────────────────────────────────────────────');
    printZoneTable(e2Result.zones);
  }

  console.log('\n─── Full JSON ───────────────────────────────────────────────────');
  const output = e2Result
    ? { e1Zones: e1Result.zones, e2Zones: e2Result.zones, e1Format: e1Result.format, e2Format: e2Result.format }
    : { zones: e1Result.zones, format: e1Result.format, pageCount: e1Result.pageCount };
  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => { console.error('\n💥  Fatal:', err); process.exit(1); });
