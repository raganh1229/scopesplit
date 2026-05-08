/**
 * N2 Pipeline — Zone Detection Accuracy Check
 *
 * Validates AI zone detection accuracy by comparing detected zones against:
 *   1. Ground truth extracted from cheat sheets (CSV or MD)
 *   2. Zone headers extracted directly from PDF text (pdfjs-dist)
 *
 * Runs completely offline — no AI calls by default.
 * Use --with-ai to also run AI detection and include it in the comparison.
 *
 * Usage:
 *   npx tsx scripts/n2-zone-accuracy.ts              # text vs cheat sheet only
 *   npx tsx scripts/n2-zone-accuracy.ts --with-ai    # + AI detection
 *   npx tsx scripts/n2-zone-accuracy.ts Set10        # single set
 *
 * Requires only ANTHROPIC_API_KEY in .env.local when using --with-ai.
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

loadEnv({ path: path.resolve(__dirname, '..', '.env') });
loadEnv({ path: path.resolve(__dirname, '..', '.env.local'), override: true });

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const filterSet = args.find(a => !a.startsWith('--')) ?? null;
const withAI = args.includes('--with-ai');

// ── Constants ─────────────────────────────────────────────────────────────────

const PDFS_ROOT = path.resolve(
  __dirname, '..', '..', '..', 'PDFS', 'Accurate Comparisons',
);

// ── AI imports (only loaded when --with-ai) ───────────────────────────────────

let buildChunks: typeof import('@/lib/n2/utils/chunk-pdf').buildChunks;
let loadPdf: typeof import('@/lib/n2/utils/pdf-slicer').loadPdf;
let slicePages: typeof import('@/lib/n2/utils/pdf-slicer').slicePages;
let mergeChunkZones: typeof import('@/lib/n2/utils/zone-merge').mergeChunkZones;
let preDeduplicateZones: typeof import('@/lib/n2/utils/zone-merge').preDeduplicateZones;
let synthesizeGeneralZone: typeof import('@/lib/n2/utils/zone-merge').synthesizeGeneralZone;
let buildPass1Chunk1Prompt: typeof import('@/lib/n2/prompts/pass1-chunk1').buildPass1Chunk1Prompt;
let buildPass1ChunkNPrompt: typeof import('@/lib/n2/prompts/pass1-chunk-n').buildPass1ChunkNPrompt;
let parseAndValidate: typeof import('@/lib/n2/utils/ai-response').parseAndValidate;
let withRetry: typeof import('@/lib/n2/utils/ai-response').withRetry;
let isTruncated: typeof import('@/lib/n2/utils/ai-response').isTruncated;
let AIResponseError: typeof import('@/lib/n2/utils/ai-response').AIResponseError;
let Pass1Chunk1ResponseSchema: typeof import('@/lib/n2/schemas/pass-responses').Pass1Chunk1ResponseSchema;
let Pass2ChunkNResponseSchema: typeof import('@/lib/n2/schemas/pass-responses').Pass2ChunkNResponseSchema;

// ── PDF text extraction (pdfjs-dist legacy build) ─────────────────────────────

type PdfjsLib = {
  getDocument: (opts: { data: Uint8Array }) => { promise: Promise<PdfjsDoc> };
  GlobalWorkerOptions: { workerSrc: string };
};
type PdfjsDoc = { numPages: number; getPage: (n: number) => Promise<PdfjsPage> };
type PdfjsPage = { getTextContent: () => Promise<{ items: Array<{ str: string; transform: number[] }> }> };

let pdfjsLib: PdfjsLib | null = null;

async function getPdfjs(): Promise<PdfjsLib> {
  if (!pdfjsLib) {
    const mod = await import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as PdfjsLib;
    mod.GlobalWorkerOptions.workerSrc = pathToFileURL(
      path.resolve(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs'),
    ).href;
    pdfjsLib = mod;
  }
  return pdfjsLib;
}

/**
 * Extracts all text from a PDF as an array of page strings.
 */
async function extractPdfText(pdfBytes: Uint8Array): Promise<string[]> {
  const pdfjs = await getPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBytes) }).promise;
  const pages: string[] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();

    // Group text items into lines by their Y coordinate (transform[5])
    const lineMap = new Map<number, string[]>();
    for (const item of content.items) {
      const y = Math.round(item.transform[5]!);
      if (!lineMap.has(y)) lineMap.set(y, []);
      lineMap.get(y)!.push(item.str);
    }

    // Sort lines top-to-bottom (higher Y = higher on page in PDF coords)
    const sorted = [...lineMap.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, parts]) => parts.join(' ').trim())
      .filter(l => l.length > 0);

    pages.push(sorted.join('\n'));
  }

  return pages;
}

// ── Zone header extraction from PDF text ─────────────────────────────────────

/**
 * Lines to filter out when looking for zone headers.
 * These are common Xactimate/Symbility page elements that are NOT zone names.
 */
const NON_ZONE_PATTERNS = [
  /^totals?:/i,
  /^continued\s*[-–]/i,
  /^page\s*:\s*\d/i,
  /^(date|claim|policy|insured|adjuster|estimator|inspector|file|job|ref|estimate)/i,
  /^\d+\/\d+\/\d{4}/, // dates
  /^(sf|lf|sy|ea|hr|mo|yd|cy)\s+/i, // dimension lines
  /^\d+\.\d{2}$/, // bare dollar amounts
  /^(remove|replace|r&r|clean|seal|paint|install|demo)/i, // line item descriptions
  /^(tax|overhead|profit|o&p|subtotal|total|grand total)/i,
  /^(scope\s+summary|line\s+item|description|unit\s+cost|rcv|acv)/i,
  /^(estimate\s+(id|#|no)|coverage|loss\s+(date|location|type))/i,
];

/**
 * After a zone header, these patterns on the following line confirm it's a room.
 * Xactimate always follows room names with dimension data.
 */
const DIMENSION_LINE_PATTERNS = [
  /\bSF\s+(Wall|Ceil|Floor)/i,
  /\b(LF|SY|SF)\s+\w+/i,
  /\bL\s*x\s*W\s*x\s*H/i,
  /\d+\.\d+\s+X\s+\d+\.\d+/i,
  /Surface\s+Area/i,
];

function isLikelyZoneHeader(line: string, nextLine: string | undefined): boolean {
  const trimmed = line.trim();

  // Must be non-empty and reasonably short (room names < 60 chars)
  if (!trimmed || trimmed.length > 60 || trimmed.length < 2) return false;

  // Filter out known non-zone patterns
  for (const pat of NON_ZONE_PATTERNS) {
    if (pat.test(trimmed)) return false;
  }

  // Must not start with a number or special characters (not a line item)
  if (/^[\d\-\*\#\(\[\{]/.test(trimmed)) return false;

  // Must not be ALL CAPS single word that's a keyword (likely a column header)
  if (/^[A-Z]{3,}$/.test(trimmed)) return false;

  // Strong signal: next line has dimension data
  if (nextLine && DIMENSION_LINE_PATTERNS.some(p => p.test(nextLine))) return true;

  // Weaker signal: looks like a proper noun / title-cased room name
  const isTitleCase = /^[A-Z][a-zA-Z]/.test(trimmed);
  const hasOnlyWordChars = /^[A-Za-z\s\-\/&']+$/.test(trimmed);
  const wordCount = trimmed.split(/\s+/).length;

  return isTitleCase && hasOnlyWordChars && wordCount <= 5 && wordCount >= 1;
}

/**
 * Extract unique zone names from PDF text pages.
 * Returns zone names in the order they first appear, deduped by normalized name.
 */
function extractZonesFromText(pages: string[]): string[] {
  const found = new Map<string, string>(); // normalized → original

  for (const pageText of pages) {
    const lines = pageText.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      const nextLine = lines[i + 1]?.trim();

      if (isLikelyZoneHeader(line, nextLine)) {
        // Strip "CONTINUED - " prefix if present
        const clean = line.replace(/^CONTINUED\s*[-–]\s*/i, '').trim();
        const normalized = clean.toLowerCase().replace(/\s+/g, ' ');
        if (!found.has(normalized)) {
          found.set(normalized, clean);
        }
      }
    }
  }

  return [...found.values()];
}

// ── Cheat sheet parsers ───────────────────────────────────────────────────────

/**
 * Parse unique zone names from a CSV cheat sheet.
 * Looks for columns named pdf1_zone and pdf2_zone.
 */
function parseCSVZones(csv: string): { e1: string[]; e2: string[] } {
  const lines = csv.split('\n').filter(l => l.trim());
  if (lines.length === 0) return { e1: [], e2: [] };

  // Parse header to find zone column indices
  const header = lines[0]!.split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));
  const e1Col = header.indexOf('pdf1_zone');
  const e2Col = header.indexOf('pdf2_zone');

  if (e1Col === -1 && e2Col === -1) return { e1: [], e2: [] };

  const e1Set = new Set<string>();
  const e2Set = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    // Handle quoted fields
    const fields = parseCSVLine(lines[i]!);
    if (e1Col !== -1 && fields[e1Col]) {
      const z = fields[e1Col]!.trim();
      if (z && z !== '—' && z !== 'N/A') e1Set.add(z);
    }
    if (e2Col !== -1 && fields[e2Col]) {
      const z = fields[e2Col]!.trim();
      if (z && z !== '—' && z !== 'N/A') e2Set.add(z);
    }
  }

  return { e1: [...e1Set], e2: [...e2Set] };
}

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Parse zone names from a markdown cheat sheet ZONE LAYOUT table.
 */
function parseMDZones(content: string): { e1: string[]; e2: string[] } | null {
  const zoneSection = content.match(/##?\s+ZONE LAYOUT[\s\S]*?(?=\n##|\n---|\n#[^#]|$)/i)?.[0];
  if (!zoneSection) return null;

  const e1Zones: string[] = [];
  const e2Zones: string[] = [];

  for (const line of zoneSection.split('\n')) {
    const match = line.match(/^\|\s*(?:Zone\s*\d+:|—|)\s*([^|]+?)\s*\|\s*(?:Zone\s*\d+:|—|)\s*([^|]+?)\s*\|/i);
    if (!match) continue;

    const left = match[1]!.trim();
    const right = match[2]!.trim();

    if (/^-+$/.test(left) || /^Contractor/i.test(left) || /^E1/i.test(left)) continue;

    const clean = (s: string) => s.replace(/^Zone\s*\d+:\s*/i, '').replace(/\s*\(\d+\s*items?\)/i, '').replace(/\*\*/g, '').trim();

    const l = clean(left);
    const r = clean(right);
    if (l && l !== '—') e1Zones.push(l);
    if (r && r !== '—') e2Zones.push(r);
  }

  return e1Zones.length > 0 || e2Zones.length > 0 ? { e1: e1Zones, e2: e2Zones } : null;
}

// ── Fuzzy zone matching ───────────────────────────────────────────────────────

function normalizeZoneName(name: string): string {
  return name.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function zoneNamesMatch(a: string, b: string): boolean {
  const na = normalizeZoneName(a);
  const nb = normalizeZoneName(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;

  // Word overlap: if they share ≥50% of words, consider a match
  const wa = new Set(na.split(' ').filter(w => w.length > 2));
  const wb = new Set(nb.split(' ').filter(w => w.length > 2));
  const intersection = [...wa].filter(w => wb.has(w)).length;
  const minSize = Math.min(wa.size, wb.size);
  if (minSize > 0 && intersection / minSize >= 0.5) return true;

  return false;
}

/**
 * Compute precision/recall comparing a detected set against an expected set.
 */
function computeAccuracy(
  detected: string[],
  expected: string[],
): {
  truePositives: string[];
  falsePositives: string[];
  falseNegatives: string[];
  precision: number;
  recall: number;
  f1: number;
} {
  const matched = new Set<number>();
  const truePositives: string[] = [];
  const falsePositives: string[] = [];

  for (const det of detected) {
    const idx = expected.findIndex((exp, i) => !matched.has(i) && zoneNamesMatch(det, exp));
    if (idx !== -1) {
      matched.add(idx);
      truePositives.push(det);
    } else {
      falsePositives.push(det);
    }
  }

  const falseNegatives = expected.filter((_, i) => !matched.has(i));

  const tp = truePositives.length;
  const fp = falsePositives.length;
  const fn = falseNegatives.length;

  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return { truePositives, falsePositives, falseNegatives, precision, recall, f1 };
}

// ── AI detection (optional) ───────────────────────────────────────────────────

async function loadAIModules() {
  const chunkPdf = await import('@/lib/n2/utils/chunk-pdf');
  const pdfSlicer = await import('@/lib/n2/utils/pdf-slicer');
  const zoneMerge = await import('@/lib/n2/utils/zone-merge');
  const p1c1 = await import('@/lib/n2/prompts/pass1-chunk1');
  const p1cn = await import('@/lib/n2/prompts/pass1-chunk-n');
  const aiResp = await import('@/lib/n2/utils/ai-response');
  const passResp = await import('@/lib/n2/schemas/pass-responses');

  buildChunks = chunkPdf.buildChunks;
  loadPdf = pdfSlicer.loadPdf;
  slicePages = pdfSlicer.slicePages;
  mergeChunkZones = zoneMerge.mergeChunkZones;
  preDeduplicateZones = zoneMerge.preDeduplicateZones;
  synthesizeGeneralZone = zoneMerge.synthesizeGeneralZone;
  buildPass1Chunk1Prompt = p1c1.buildPass1Chunk1Prompt;
  buildPass1ChunkNPrompt = p1cn.buildPass1ChunkNPrompt;
  parseAndValidate = aiResp.parseAndValidate;
  withRetry = aiResp.withRetry;
  isTruncated = aiResp.isTruncated;
  AIResponseError = aiResp.AIResponseError;
  Pass1Chunk1ResponseSchema = passResp.Pass1Chunk1ResponseSchema;
  Pass2ChunkNResponseSchema = passResp.Pass2ChunkNResponseSchema;
}

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const SONNET_MODEL = 'claude-sonnet-4-6';
const CHUNK_SIZE = 10;
const OVERLAP = 1;
const CONCURRENT_CHUNK_CALLS = 5;

async function runWithConcurrencyLimit<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIdx = 0;
  async function worker() {
    for (;;) {
      const idx = nextIdx++;
      if (idx >= tasks.length) return;
      try { results[idx] = { status: 'fulfilled', value: await tasks[idx]!() }; }
      catch (reason) { results[idx] = { status: 'rejected', reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

async function detectZonesAI(pdfBytes: Uint8Array, side: string, setName: string): Promise<string[]> {
  const doc = await loadPdf(pdfBytes);
  const pageCount = doc.getPageCount();
  const chunks = buildChunks(pageCount, CHUNK_SIZE, OVERLAP);

  const specs = await Promise.all(chunks.map(async (chunk, i) => {
    const bytes = await slicePages(doc, chunk.startIndex, chunk.endIndex);
    return { chunk, bytes, isFirst: i === 0, context: `${setName}/${side}-c${i}` };
  }));

  const settled = await runWithConcurrencyLimit(specs.map(spec => () => withRetry(async () => {
    const prompts = spec.isFirst
      ? buildPass1Chunk1Prompt({ startPage: spec.chunk.startIndex + 1, endPage: spec.chunk.endIndex + 1, totalPages: pageCount })
      : buildPass1ChunkNPrompt({ startPage: spec.chunk.startIndex + 1, endPage: spec.chunk.endIndex + 1, totalPages: pageCount });

    const pdfBase64 = Buffer.from(spec.bytes).toString('base64');
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify({ model: SONNET_MODEL, max_tokens: 2000, temperature: 0, system: prompts.system, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } }, { type: 'text', text: prompts.user }] }] }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AIResponseError(`Anthropic ${response.status}: ${body.slice(0, 200)}`, response.status >= 500 || response.status === 429, spec.context);
    }

    const body = (await response.json()) as { content?: Array<{ text?: string }>; stop_reason?: string | null };
    const text = body.content?.[0]?.text ?? '';
    if (isTruncated(body.stop_reason, text)) throw new AIResponseError('Truncated', true, spec.context);

    if (spec.isFirst) {
      const p = parseAndValidate(text, Pass1Chunk1ResponseSchema, spec.context);
      return { chunk: spec.chunk, firstPagePrintedNumber: p.first_page_printed_number, approxItemsOnPages: p.approx_items_on_pages, detectedFormat: p.format as 'xactimate' | 'symbility' | 'unknown', zones: p.zones.map(z => ({ name: z.name, startPage: z.start_page, evidenceItem: z.evidence_item, approxItems: z.approx_items })) };
    }
    const p = parseAndValidate(text, Pass2ChunkNResponseSchema, spec.context);
    return { chunk: spec.chunk, firstPagePrintedNumber: p.first_page_printed_number, approxItemsOnPages: p.approx_items_on_pages, zones: p.zones.map(z => ({ name: z.name, startPage: z.start_page, evidenceItem: z.evidence_item, approxItems: z.approx_items })) };
  }, 5, spec.context)), CONCURRENT_CHUNK_CALLS);

  const rawResults = settled
    .map(s => s.status === 'fulfilled' ? s.value : null)
    .filter(Boolean) as Parameters<typeof mergeChunkZones>[0];

  let zones = mergeChunkZones(rawResults, pageCount);
  zones = preDeduplicateZones(zones);
  if (zones.length === 0) zones = [synthesizeGeneralZone(rawResults, pageCount)];
  return zones.map(z => z.name);
}

// ── Set discovery ─────────────────────────────────────────────────────────────

type SetInfo = {
  name: string;
  contractorPdf: string;
  adjusterPdf: string;
  cheatSheetMd: string | null;
  cheatSheetCsv: string | null;
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
    const cheatSheetCsv = files.find(f => f.endsWith('.csv')) ?? null;

    if (!contractorPdf || !adjusterPdf) continue;

    sets.push({
      name: entry.name,
      contractorPdf: path.join(dir, contractorPdf),
      adjusterPdf: path.join(dir, adjusterPdf),
      cheatSheetMd: cheatSheetMd ? path.join(dir, cheatSheetMd) : null,
      cheatSheetCsv: cheatSheetCsv ? path.join(dir, cheatSheetCsv) : null,
    });
  }

  return sets.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// ── Per-set runner ────────────────────────────────────────────────────────────

type SideResult = {
  textZones: string[];
  aiZones: string[] | null;
  expected: string[] | null;
  textVsExpected: ReturnType<typeof computeAccuracy> | null;
  aiVsExpected: ReturnType<typeof computeAccuracy> | null;
  textVsAI: ReturnType<typeof computeAccuracy> | null;
};

type SetResult = {
  name: string;
  e1: SideResult;
  e2: SideResult;
  error?: string;
};

async function runSet(set: SetInfo): Promise<SetResult> {
  const result: SetResult = {
    name: set.name,
    e1: { textZones: [], aiZones: null, expected: null, textVsExpected: null, aiVsExpected: null, textVsAI: null },
    e2: { textZones: [], aiZones: null, expected: null, textVsExpected: null, aiVsExpected: null, textVsAI: null },
  };

  try {
    // Load expected zones from cheat sheet
    let expected: { e1: string[]; e2: string[] } | null = null;
    if (set.cheatSheetMd) {
      const md = await fs.readFile(set.cheatSheetMd, 'utf-8');
      expected = parseMDZones(md);
    }
    if (!expected && set.cheatSheetCsv) {
      const csv = await fs.readFile(set.cheatSheetCsv, 'utf-8');
      expected = parseCSVZones(csv);
    }

    result.e1.expected = expected?.e1 ?? null;
    result.e2.expected = expected?.e2 ?? null;

    // Extract text and detect zones from PDFs
    const [e1Bytes, e2Bytes] = await Promise.all([
      fs.readFile(set.contractorPdf).then(b => new Uint8Array(b)),
      fs.readFile(set.adjusterPdf).then(b => new Uint8Array(b)),
    ]);

    const [e1Pages, e2Pages] = await Promise.all([
      extractPdfText(e1Bytes),
      extractPdfText(e2Bytes),
    ]);

    result.e1.textZones = extractZonesFromText(e1Pages);
    result.e2.textZones = extractZonesFromText(e2Pages);

    // AI detection (optional)
    if (withAI) {
      [result.e1.aiZones, result.e2.aiZones] = await Promise.all([
        detectZonesAI(e1Bytes, 'e1', set.name),
        detectZonesAI(e2Bytes, 'e2', set.name),
      ]);
    }

    // Compute accuracy metrics
    if (result.e1.expected) {
      result.e1.textVsExpected = computeAccuracy(result.e1.textZones, result.e1.expected);
      if (result.e1.aiZones) result.e1.aiVsExpected = computeAccuracy(result.e1.aiZones, result.e1.expected);
    }
    if (result.e2.expected) {
      result.e2.textVsExpected = computeAccuracy(result.e2.textZones, result.e2.expected);
      if (result.e2.aiZones) result.e2.aiVsExpected = computeAccuracy(result.e2.aiZones, result.e2.expected);
    }
    if (result.e1.aiZones) result.e1.textVsAI = computeAccuracy(result.e1.textZones, result.e1.aiZones);
    if (result.e2.aiZones) result.e2.textVsAI = computeAccuracy(result.e2.textZones, result.e2.aiZones);

  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

// ── Printing ──────────────────────────────────────────────────────────────────

function pct(n: number): string { return `${Math.round(n * 100)}%`; }

function printSide(label: string, side: SideResult) {
  const textLine = `text: [${side.textZones.join(', ')}]`;
  const expLine = side.expected ? `expected: [${side.expected.join(', ')}]` : 'expected: (none)';
  const aiLine = side.aiZones ? `ai: [${side.aiZones.join(', ')}]` : '';

  console.log(`\n  ── ${label} ──`);
  console.log(`     ${expLine}`);
  console.log(`     ${textLine}`);
  if (aiLine) console.log(`     ${aiLine}`);

  if (side.textVsExpected) {
    const a = side.textVsExpected;
    console.log(`     Text vs Expected → P:${pct(a.precision)} R:${pct(a.recall)} F1:${pct(a.f1)}`);
    if (a.falseNegatives.length) console.log(`       ⚠️  Missed by text: ${a.falseNegatives.join(', ')}`);
    if (a.falsePositives.length) console.log(`       ➕ Extra in text:  ${a.falsePositives.join(', ')}`);
  }

  if (side.aiVsExpected) {
    const a = side.aiVsExpected;
    console.log(`     AI vs Expected   → P:${pct(a.precision)} R:${pct(a.recall)} F1:${pct(a.f1)}`);
    if (a.falseNegatives.length) console.log(`       ⚠️  Missed by AI:   ${a.falseNegatives.join(', ')}`);
    if (a.falsePositives.length) console.log(`       ➕ Extra in AI:    ${a.falsePositives.join(', ')}`);
  }
}

function printSummaryTable(results: SetResult[]) {
  console.log('\n\n' + '═'.repeat(100));
  console.log('  ACCURACY SUMMARY');
  console.log('═'.repeat(100));

  const setsWithExpected = results.filter(r => r.e1.expected || r.e2.expected);
  if (setsWithExpected.length === 0) {
    console.log('  (no sets had parseable cheat sheets for ground truth comparison)');
    return;
  }

  const header = [
    'Set'.padEnd(24),
    'Side'.padEnd(4),
    'Expected'.padEnd(10),
    'TextFound'.padEnd(10),
    'Text P'.padEnd(8),
    'Text R'.padEnd(8),
    'Text F1'.padEnd(8),
    ...(withAI ? ['AI P'.padEnd(8), 'AI R'.padEnd(8), 'AI F1'.padEnd(8)] : []),
  ].join('  ');

  console.log(header);
  console.log('─'.repeat(100));

  let totalTextF1 = 0;
  let totalAiF1 = 0;
  let rowCount = 0;

  for (const r of results) {
    if (r.error) {
      console.log(`${r.name.padEnd(24)}  ❌ ${r.error.slice(0, 60)}`);
      continue;
    }

    for (const [side, label] of [[r.e1, 'E1'], [r.e2, 'E2']] as [SideResult, string][]) {
      if (!side.expected) continue;
      rowCount++;

      const tv = side.textVsExpected;
      const av = side.aiVsExpected;

      const row = [
        r.name.padEnd(24),
        label.padEnd(4),
        String(side.expected.length).padEnd(10),
        String(side.textZones.length).padEnd(10),
        (tv ? pct(tv.precision) : '—').padEnd(8),
        (tv ? pct(tv.recall) : '—').padEnd(8),
        (tv ? pct(tv.f1) : '—').padEnd(8),
        ...(withAI ? [
          (av ? pct(av.precision) : '—').padEnd(8),
          (av ? pct(av.recall) : '—').padEnd(8),
          (av ? pct(av.f1) : '—').padEnd(8),
        ] : []),
      ].join('  ');

      if (tv) totalTextF1 += tv.f1;
      if (av) totalAiF1 += av.f1;
      console.log(row);
    }
  }

  console.log('─'.repeat(100));
  if (rowCount > 0) {
    console.log(`  Avg Text F1: ${pct(totalTextF1 / rowCount)}  (across ${rowCount} sides with ground truth)`);
    if (withAI) console.log(`  Avg AI F1:   ${pct(totalAiF1 / rowCount)}`);
  }
  console.log('═'.repeat(100));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (withAI) {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('❌  ANTHROPIC_API_KEY missing — required for --with-ai');
      process.exit(1);
    }
    await loadAIModules();
  }

  const sets = await discoverSets();
  if (sets.length === 0) {
    console.error(`❌  No sets found at ${PDFS_ROOT}`);
    process.exit(1);
  }

  const mode = withAI ? 'text extraction + AI detection vs cheat sheet' : 'text extraction vs cheat sheet (no AI)';
  console.log(`\n🔬  N2 Zone Accuracy Check — ${mode}`);
  console.log(`    ${sets.length} set(s): ${sets.map(s => s.name).join(', ')}\n`);

  const results: SetResult[] = [];

  for (let i = 0; i < sets.length; i++) {
    const set = sets[i]!;
    process.stdout.write(`  [${i + 1}/${sets.length}] ${set.name} ... `);
    const result = await runSet(set);
    results.push(result);
    if (result.error) console.log(`❌  ${result.error.slice(0, 80)}`);
    else console.log('✅');
  }

  // Per-set detail
  for (const r of results) {
    const hr = '─'.repeat(80);
    console.log(`\n${hr}`);
    console.log(`📁  ${r.name}`);
    console.log(hr);
    if (r.error) { console.log(`  ❌  ${r.error}`); continue; }
    printSide('E1 (Contractor)', r.e1);
    printSide('E2 (Adjuster)', r.e2);
  }

  printSummaryTable(results);
}

main().catch(err => {
  console.error('\n💥  Fatal:', err);
  process.exit(1);
});
