/**
 * N2 Pipeline — Batch Smoke Test
 *
 * Runs the full Phases 2+3 pipeline (zone detection → zone matching) against
 * every PDF pair in the Accurate Comparisons folder, then prints a summary
 * table showing detected zones, match results, and (where an .md cheat sheet
 * exists) whether the detected zone names align with the expected layout.
 *
 * Usage:
 *   npx tsx scripts/n2-smoke-batch.ts
 *   npx tsx scripts/n2-smoke-batch.ts Set8          # run a single set by name
 *   npx tsx scripts/n2-smoke-batch.ts --no-match    # skip match-zones (faster)
 *
 * Requires only ANTHROPIC_API_KEY in .env.local.
 * No DB, no Supabase, no Inngest — runs entirely offline against local PDFs.
 *
 * PDF folder expected at:
 *   ../../PDFS/Accurate Comparisons/
 * relative to this script's directory (estimatch-app/scripts/).
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import fs from 'node:fs/promises';
import { z } from 'zod';

loadEnv({ path: path.resolve(__dirname, '..', '.env') });
loadEnv({ path: path.resolve(__dirname, '..', '.env.local'), override: true });

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌  ANTHROPIC_API_KEY missing from .env.local — aborting.');
  process.exit(1);
}

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const filterSet = args.find(a => !a.startsWith('--')) ?? null;
const skipMatch = args.includes('--no-match');

// ── Constants ─────────────────────────────────────────────────────────────────

const PDFS_ROOT = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'PDFS',
  'Accurate Comparisons',
);
const SONNET_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ZONE_DETECTION_MAX_TOKENS = 2000;
const MATCH_MAX_TOKENS = 4096;
const CHUNK_SIZE = 10;
const OVERLAP = 1;

// ── Imports (after env is loaded) ─────────────────────────────────────────────

import { loadPdf, slicePages } from '@/lib/n2/utils/pdf-slicer';
import { buildChunks } from '@/lib/n2/utils/chunk-pdf';
import { mergeChunkZones, preDeduplicateZones, synthesizeGeneralZone } from '@/lib/n2/utils/zone-merge';
import { buildPass1Chunk1Prompt } from '@/lib/n2/prompts/pass1-chunk1';
import { buildPass1ChunkNPrompt } from '@/lib/n2/prompts/pass1-chunk-n';
import { buildMatchZonesPrompt } from '@/lib/n2/prompts/match-zones';
import { parseAndValidate, withRetry, isTruncated, AIResponseError } from '@/lib/n2/utils/ai-response';
import { Pass1Chunk1ResponseSchema, Pass2ChunkNResponseSchema } from '@/lib/n2/schemas/pass-responses';
import type { ChunkZoneDetectionResult } from '@/lib/n2/utils/zone-merge';
import type { PdfChunk } from '@/lib/n2/utils/chunk-pdf';
import type { N2DetectedZone } from '@/lib/n2/schemas/types';

// ── Match-zones response schema (mirrors match-zones.ts) ──────────────────────

const ZoneRefRaw = z.object({
  zone: z.string().min(1),
  pages: z.tuple([z.number().int(), z.number().int()]),
});

const MatchZonesResponseSchema = z.object({
  matched: z.array(z.object({
    e1Zones: z.array(ZoneRefRaw).min(1),
    e2Zones: z.array(ZoneRefRaw).min(1),
    canonical: z.string().min(1),
    isMerged: z.boolean(),
    confidence: z.number().int().min(50).max(100),
  })),
  unmatchedE1: z.array(ZoneRefRaw),
  unmatchedE2: z.array(ZoneRefRaw),
});

type MatchResult = z.infer<typeof MatchZonesResponseSchema>;

// ── Zone detection helpers (copied from n2-smoke-local-pdfs.ts) ───────────────

async function processChunk(
  chunk: PdfChunk,
  chunkBytes: Uint8Array,
  isFirstChunk: boolean,
  startPage: number,
  endPage: number,
  totalPages: number,
  context: string,
): Promise<ChunkZoneDetectionResult> {
  return withRetry(async () => {
    const prompts = isFirstChunk
      ? buildPass1Chunk1Prompt({ startPage, endPage, totalPages })
      : buildPass1ChunkNPrompt({ startPage, endPage, totalPages });

    const pdfBase64 = Buffer.from(chunkBytes).toString('base64');

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: SONNET_MODEL,
        max_tokens: ZONE_DETECTION_MAX_TOKENS,
        temperature: 0,
        system: prompts.system,
        messages: [{ role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: prompts.user },
        ]}],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new AIResponseError(
        `Anthropic ${response.status} — ${context}: ${errBody.slice(0, 300) || response.statusText}`,
        response.status >= 500 || response.status === 429,
        context,
      );
    }

    const body = (await response.json()) as { content?: Array<{ text?: string }>; stop_reason?: string | null };
    const text = body.content?.[0]?.text ?? '';
    if (isTruncated(body.stop_reason, text)) {
      throw new AIResponseError(`Response truncated — ${context}`, true, context);
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
  }, 5, context);
}

async function detectZones(pdfBytes: Uint8Array, side: string, setName: string): Promise<{
  zones: N2DetectedZone[];
  format: string;
  pageCount: number;
}> {
  const doc = await loadPdf(pdfBytes);
  const pageCount = doc.getPageCount();
  const chunks = buildChunks(pageCount, CHUNK_SIZE, OVERLAP);

  const specs = await Promise.all(
    chunks.map(async (chunk) => {
      const bytes = await slicePages(doc, chunk.startIndex, chunk.endIndex);
      return { chunk, bytes };
    }),
  );

  const results = await Promise.all(
    specs.map(({ chunk, bytes }, i) =>
      processChunk(chunk, bytes, i === 0, chunk.startIndex + 1, chunk.endIndex + 1, pageCount, `${setName}/${side}-c${i}`),
    ),
  );

  let zones = mergeChunkZones(results, pageCount);
  zones = preDeduplicateZones(zones);
  if (zones.length === 0) zones = [synthesizeGeneralZone(results, pageCount)];

  return { zones, format: results[0]?.detectedFormat ?? 'unknown', pageCount };
}

// ── Match-zones call ──────────────────────────────────────────────────────────

async function runMatchZones(
  e1Zones: N2DetectedZone[],
  e2Zones: N2DetectedZone[],
  setName: string,
): Promise<MatchResult> {
  const userMessage = buildMatchZonesPrompt(e1Zones, e2Zones, [], []);

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: SONNET_MODEL,
      max_tokens: MATCH_MAX_TOKENS,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    throw new Error(`[match-zones/${setName}] Anthropic ${response.status}: ${response.statusText}`);
  }

  const aiData = (await response.json()) as { content?: { type: string; text: string }[] };
  const rawText = aiData?.content?.find(b => b.type === 'text')?.text ?? '';
  const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  const obj: unknown = JSON.parse(jsonText);
  const result = MatchZonesResponseSchema.safeParse(obj);
  if (!result.success) {
    throw new Error(`[match-zones/${setName}] Schema error: ${result.error.message.slice(0, 300)}`);
  }
  return result.data;
}

// ── Cheat sheet parser ────────────────────────────────────────────────────────

/**
 * Tries to extract expected zone names from a markdown cheat sheet.
 * Looks for a ZONE LAYOUT table with a pipe-separated format.
 * Returns null if no zone table found.
 */
function parseCheatSheetZones(content: string): { e1: string[]; e2: string[] } | null {
  // Find the ZONE LAYOUT section
  const zoneSection = content.match(/##?\s+ZONE LAYOUT[\s\S]*?(?=\n##|\n---|\n#[^#]|$)/i)?.[0];
  if (!zoneSection) return null;

  const e1Zones: string[] = [];
  const e2Zones: string[] = [];

  for (const line of zoneSection.split('\n')) {
    // Match table rows like: | Zone 2: Living Area (12 items) | Zone 2: Master Bedroom (10 items) |
    const match = line.match(/^\|\s*(?:Zone\s*\d+:|—|)\s*([^|]+?)\s*\|\s*(?:Zone\s*\d+:|—|)\s*([^|]+?)\s*\|/i);
    if (!match) continue;

    const left = match[1]!.trim();
    const right = match[2]!.trim();

    // Skip header rows, separator rows, or metadata rows
    if (/^-+$/.test(left) || /^Contractor/i.test(left) || /^E1/i.test(left)) continue;
    if (left === '—' || left === '') { /* skip blank left */ } else {
      // Extract zone name: remove "Zone N: " prefix and item count suffix
      const zoneName = left
        .replace(/^Zone\s*\d+:\s*/i, '')
        .replace(/\s*\(\d+\s*items?\)/i, '')
        .replace(/\*\*/g, '')
        .trim();
      if (zoneName && zoneName !== '—') e1Zones.push(zoneName);
    }

    if (right === '—' || right === '') { /* skip blank right */ } else {
      const zoneName = right
        .replace(/^Zone\s*\d+:\s*/i, '')
        .replace(/\s*\(\d+\s*items?\)/i, '')
        .replace(/\*\*/g, '')
        .trim();
      if (zoneName && zoneName !== '—') e2Zones.push(zoneName);
    }
  }

  if (e1Zones.length === 0 && e2Zones.length === 0) return null;
  return { e1: e1Zones, e2: e2Zones };
}

// ── Set discovery ─────────────────────────────────────────────────────────────

type SetInfo = {
  name: string;
  contractorPdf: string;
  adjusterPdf: string;
  cheatSheetMd: string | null;
};

async function discoverSets(): Promise<SetInfo[]> {
  const entries = await fs.readdir(PDFS_ROOT, { withFileTypes: true });
  const sets: SetInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (filterSet && entry.name !== filterSet) continue;

    const dir = path.join(PDFS_ROOT, entry.name);
    const files = await fs.readdir(dir);

    const contractorPdf = files.find(f => /contractor/i.test(f) && f.endsWith('.pdf'));
    const adjusterPdf = files.find(f => /adjuster/i.test(f) && f.endsWith('.pdf'));
    const cheatSheetMd = files.find(f => f.endsWith('.md')) ?? null;

    if (!contractorPdf || !adjusterPdf) {
      console.warn(`⚠  ${entry.name}: could not identify contractor/adjuster PDFs — skipping`);
      continue;
    }

    sets.push({
      name: entry.name,
      contractorPdf: path.join(dir, contractorPdf),
      adjusterPdf: path.join(dir, adjusterPdf),
      cheatSheetMd: cheatSheetMd ? path.join(dir, cheatSheetMd) : null,
    });
  }

  return sets.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// ── Result types ──────────────────────────────────────────────────────────────

type SetResult = {
  setName: string;
  status: 'ok' | 'failed';
  error?: string;
  e1: { zones: N2DetectedZone[]; format: string; pageCount: number } | null;
  e2: { zones: N2DetectedZone[]; format: string; pageCount: number } | null;
  matchResult: MatchResult | null;
  expectedZones: { e1: string[]; e2: string[] } | null;
  elapsedMs: number;
};

// ── Zone match scoring ────────────────────────────────────────────────────────

/**
 * Fuzzy-check: does the detected zone list contain a zone that looks like
 * the expected zone name? Uses case-insensitive substring matching.
 */
function zonesAlignWithExpected(detected: N2DetectedZone[], expected: string[]): {
  matched: string[];
  missing: string[];
} {
  const detectedNames = detected.map(z => z.name.toLowerCase());
  const matched: string[] = [];
  const missing: string[] = [];

  for (const exp of expected) {
    const expLower = exp.toLowerCase();
    const found = detectedNames.some(
      d => d.includes(expLower) || expLower.includes(d) || d === expLower,
    );
    if (found) matched.push(exp);
    else missing.push(exp);
  }

  return { matched, missing };
}

// ── Per-set runner ────────────────────────────────────────────────────────────

async function runSet(set: SetInfo): Promise<SetResult> {
  const start = Date.now();
  const result: SetResult = {
    setName: set.name,
    status: 'ok',
    e1: null,
    e2: null,
    matchResult: null,
    expectedZones: null,
    elapsedMs: 0,
  };

  try {
    // Read expected zones from cheat sheet (if MD)
    if (set.cheatSheetMd) {
      const mdContent = await fs.readFile(set.cheatSheetMd, 'utf-8');
      result.expectedZones = parseCheatSheetZones(mdContent);
    }

    // Zone detection (parallel)
    const [e1Bytes, e2Bytes] = await Promise.all([
      fs.readFile(set.contractorPdf).then(b => new Uint8Array(b)),
      fs.readFile(set.adjusterPdf).then(b => new Uint8Array(b)),
    ]);

    [result.e1, result.e2] = await Promise.all([
      detectZones(e1Bytes, 'e1', set.name),
      detectZones(e2Bytes, 'e2', set.name),
    ]);

    // Zone matching (sequential, depends on detection)
    if (!skipMatch && result.e1 && result.e2) {
      result.matchResult = await runMatchZones(result.e1.zones, result.e2.zones, set.name);
    }
  } catch (err) {
    result.status = 'failed';
    result.error = err instanceof Error ? err.message : String(err);
  }

  result.elapsedMs = Date.now() - start;
  return result;
}

// ── Pretty print helpers ──────────────────────────────────────────────────────

function printSetDetail(r: SetResult) {
  const hr = '─'.repeat(70);
  console.log(`\n${hr}`);
  console.log(`📁  ${r.setName}  (${(r.elapsedMs / 1000).toFixed(1)}s)`);
  console.log(hr);

  if (r.status === 'failed') {
    console.log(`  ❌  FAILED: ${r.error}`);
    return;
  }

  if (r.e1 && r.e2) {
    const e1Expected = r.expectedZones?.e1 ?? null;
    const e2Expected = r.expectedZones?.e2 ?? null;

    console.log(`  E1 (Contractor): ${r.e1.pageCount}pp, ${r.e1.format}, ${r.e1.zones.length} zones detected`);
    for (const z of r.e1.zones) {
      const flag = e1Expected
        ? (e1Expected.some(e => e.toLowerCase().includes(z.name.toLowerCase()) || z.name.toLowerCase().includes(e.toLowerCase())) ? '✅' : '❓')
        : ' ';
      console.log(`    ${flag}  ${z.name}  (pp. ${z.startPage}–${z.endPage}, ~${z.approxItems} items)`);
    }

    if (e1Expected) {
      const { missing } = zonesAlignWithExpected(r.e1.zones, e1Expected);
      for (const m of missing) console.log(`    ⚠️  EXPECTED but not found: "${m}"`);
    }

    console.log('');
    console.log(`  E2 (Adjuster):   ${r.e2.pageCount}pp, ${r.e2.format}, ${r.e2.zones.length} zones detected`);
    for (const z of r.e2.zones) {
      const flag = e2Expected
        ? (e2Expected.some(e => e.toLowerCase().includes(z.name.toLowerCase()) || z.name.toLowerCase().includes(e.toLowerCase())) ? '✅' : '❓')
        : ' ';
      console.log(`    ${flag}  ${z.name}  (pp. ${z.startPage}–${z.endPage}, ~${z.approxItems} items)`);
    }

    if (e2Expected) {
      const { missing } = zonesAlignWithExpected(r.e2.zones, e2Expected);
      for (const m of missing) console.log(`    ⚠️  EXPECTED but not found: "${m}"`);
    }
  }

  if (r.matchResult) {
    console.log('');
    console.log(`  🔗  Match-zones result:`);
    for (const pair of r.matchResult.matched) {
      const e1Names = pair.e1Zones.map(z => `"${z.zone}"`).join(' + ');
      const e2Names = pair.e2Zones.map(z => `"${z.zone}"`).join(' + ');
      const conf = pair.confidence;
      const badge = conf >= 90 ? '🟢' : conf >= 75 ? '🟡' : '🔴';
      const merged = pair.isMerged ? ' [merged]' : '';
      console.log(`    ${badge}  ${e1Names}  ↔  ${e2Names}  (${conf}%)${merged}`);
    }
    if (r.matchResult.unmatchedE1.length > 0) {
      console.log(`    ⬜ E1 unmatched: ${r.matchResult.unmatchedE1.map(z => `"${z.zone}"`).join(', ')}`);
    }
    if (r.matchResult.unmatchedE2.length > 0) {
      console.log(`    ⬜ E2 unmatched: ${r.matchResult.unmatchedE2.map(z => `"${z.zone}"`).join(', ')}`);
    }
  }
}

function printSummaryTable(results: SetResult[]) {
  console.log('\n\n' + '═'.repeat(90));
  console.log('  BATCH SUMMARY');
  console.log('═'.repeat(90));

  const header = [
    'Set'.padEnd(20),
    'Status'.padEnd(8),
    'E1 zones'.padEnd(10),
    'E2 zones'.padEnd(10),
    'Pairs'.padEnd(7),
    'Unmatched'.padEnd(12),
    'Avg conf'.padEnd(10),
    'Time'.padEnd(6),
  ].join('  ');
  console.log(header);
  console.log('─'.repeat(90));

  let totalSets = 0;
  let passedSets = 0;

  for (const r of results) {
    totalSets++;
    if (r.status === 'ok') passedSets++;

    const e1Count = r.e1 ? String(r.e1.zones.length) : '—';
    const e2Count = r.e2 ? String(r.e2.zones.length) : '—';
    const pairs = r.matchResult ? String(r.matchResult.matched.length) : skipMatch ? '—' : '—';
    const unmatched = r.matchResult
      ? String(r.matchResult.unmatchedE1.length + r.matchResult.unmatchedE2.length)
      : skipMatch ? '—' : '—';
    const avgConf = r.matchResult && r.matchResult.matched.length > 0
      ? Math.round(r.matchResult.matched.reduce((s, p) => s + p.confidence, 0) / r.matchResult.matched.length) + '%'
      : '—';

    const statusIcon = r.status === 'ok' ? '✅' : '❌';

    const row = [
      r.setName.padEnd(20),
      (statusIcon + ' ' + r.status).padEnd(8),
      e1Count.padEnd(10),
      e2Count.padEnd(10),
      pairs.padEnd(7),
      unmatched.padEnd(12),
      avgConf.padEnd(10),
      `${(r.elapsedMs / 1000).toFixed(1)}s`.padEnd(6),
    ].join('  ');
    console.log(row);
  }

  console.log('─'.repeat(90));
  console.log(`  ${passedSets}/${totalSets} sets completed successfully`);
  if (!skipMatch) {
    const withMatch = results.filter(r => r.matchResult);
    const totalPairs = withMatch.reduce((s, r) => s + (r.matchResult?.matched.length ?? 0), 0);
    const totalUnmatched = withMatch.reduce((s, r) => s + (r.matchResult?.unmatchedE1.length ?? 0) + (r.matchResult?.unmatchedE2.length ?? 0), 0);
    console.log(`  ${totalPairs} zone pairs matched, ${totalUnmatched} unmatched zones across all sets`);
  }
  console.log('═'.repeat(90));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const sets = await discoverSets();

  if (sets.length === 0) {
    console.error(`❌  No sets found at ${PDFS_ROOT}`);
    if (filterSet) console.error(`   (filter was: "${filterSet}")`);
    process.exit(1);
  }

  const mode = skipMatch ? 'zone detection only' : 'zone detection + match-zones';
  console.log(`\n🚀  N2 Batch Smoke Test — ${mode}`);
  console.log(`    ${sets.length} set(s) to run: ${sets.map(s => s.name).join(', ')}`);
  console.log(`    PDFs root: ${PDFS_ROOT}\n`);

  const startAll = Date.now();
  const results: SetResult[] = [];

  // Run sets sequentially to avoid Anthropic rate limits.
  // A 15s cooldown between sets lets the rate-limit window partially reset
  // before the next set fires its first batch of chunks.
  const INTER_SET_COOLDOWN_MS = sets.length > 1 ? 15_000 : 0;

  for (let i = 0; i < sets.length; i++) {
    if (i > 0 && INTER_SET_COOLDOWN_MS > 0) {
      process.stdout.write(`  ⏳ cooling down ${INTER_SET_COOLDOWN_MS / 1000}s ... `);
      await new Promise(res => setTimeout(res, INTER_SET_COOLDOWN_MS));
      process.stdout.write('done\n');
    }
    const set = sets[i]!;
    process.stdout.write(`  [${i + 1}/${sets.length}] ${set.name} ... `);
    const result = await runSet(set);
    results.push(result);
    const icon = result.status === 'ok' ? '✅' : '❌';
    console.log(`${icon}  ${(result.elapsedMs / 1000).toFixed(1)}s`);
  }

  const totalMs = Date.now() - startAll;

  // Print per-set details
  for (const r of results) {
    printSetDetail(r);
  }

  // Print summary table
  printSummaryTable(results);
  console.log(`\nTotal time: ${(totalMs / 1000).toFixed(1)}s\n`);
}

main().catch(err => {
  console.error('\n💥  Fatal:', err);
  process.exit(1);
});
