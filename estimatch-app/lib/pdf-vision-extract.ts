/**
 * PDF Vision Extraction — sends raw PDF bytes to Claude Haiku as a document
 * block and receives structured line-item data back. Replaces pdf-parse + regex
 * with visual understanding of the actual table layout.
 *
 * Output is converted to ExtractedLineRecord[] + Map<number, ParsedScopeFields>
 * so it plugs directly into the existing Sonnet comparison pipeline.
 */

import fs from 'node:fs';
import { Agent, fetch as undiciFetch } from 'undici';
import type { ParsedScopeFields, ExtractedCosts } from '@/lib/deterministic-prematch';
import { traceStep } from '@/lib/debug-trace';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_EXTRACTION_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_EXTRACTION_MAX_TOKENS = 64000;
const DEFAULT_EXTRACTION_TIMEOUT_MS = 180000;

// ── Types ────────────────────────────────────────────────────────────────────

type HaikuItem = {
  n: number;
  d: string;
  q: string | null;
  u: string | null;
  z: string | null;
  rm: number | null;
  rp: number | null;
  rs: number | null;
  tx: number | null;
  op: number | null;
  t: number | null;
};

export type ExtractedLineRecord = {
  lineNumber: number;
  text: string;
};

export type VisionExtractionResult = {
  lines: ExtractedLineRecord[];
  parsedMap: Map<number, ParsedScopeFields>;
};

// ── Config ───────────────────────────────────────────────────────────────────

function getExtractionModel(): string {
  const model = process.env.ANTHROPIC_EXTRACTION_MODEL;
  return model && model.trim().length > 0 ? model.trim() : DEFAULT_EXTRACTION_MODEL;
}

function getExtractionMaxTokens(): number {
  const raw = process.env.ANTHROPIC_EXTRACTION_MAX_TOKENS;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 1000 ? Math.floor(parsed) : DEFAULT_EXTRACTION_MAX_TOKENS;
}

function getExtractionTimeoutMs(): number {
  const raw = process.env.ANTHROPIC_EXTRACTION_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 15000 ? Math.floor(parsed) : DEFAULT_EXTRACTION_TIMEOUT_MS;
}

// Memoized undici dispatcher — Node's built-in fetch has a 5-min default
// headersTimeout that kills long-running Haiku PDF requests before Anthropic
// can respond. We extend it to match the configured extraction timeout so the
// AbortController is the authoritative deadline (not undici's internal one).
let cachedDispatcher: Agent | null = null;
let cachedDispatcherTimeoutMs: number | null = null;
function getExtractionDispatcher(): Agent {
  const timeoutMs = getExtractionTimeoutMs();
  if (cachedDispatcher && cachedDispatcherTimeoutMs === timeoutMs) {
    return cachedDispatcher;
  }
  cachedDispatcher = new Agent({
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    connectTimeout: 30_000,
  });
  cachedDispatcherTimeoutMs = timeoutMs;
  return cachedDispatcher;
}

// ── Prompt ────────────────────────────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You extract structured line-item data from Xactimate insurance estimate PDFs.
You return ONLY valid JSON — no markdown fences, no explanation, no extra text.`;

const EXTRACTION_USER_PROMPT = `Extract every numbered line item from this Xactimate estimate PDF.

Each item starts with a number followed by a period (e.g. "1.", "2.", "247.").

For each item return:
- n: item number (integer)
- d: full description text
- q: quantity as a string (e.g. "120.35") or null
- u: unit code (SF, LF, EA, HR, etc.) or null
- z: the room/zone this item belongs to — CRITICAL: see ZONE RULES below
- rm: remove cost (number or null)
- rp: replace cost (number or null)
- rs: reset cost (number or null if no RESET column exists)
- tx: tax (number or null)
- op: overhead & profit (number or null)
- t: total — use the RCV (Replacement Cost Value) column if both RCV and ACV columns are present. Do NOT use ACV. If only a single TOTAL column exists, use that.

Return JSON in this exact format:
{"total_count":91,"items":[{"n":1,"d":"Dumpster load","q":"2.00","u":"EA","z":"General Items","rm":0,"rp":731.00,"rs":null,"tx":68.41,"op":142.40,"t":941.81}]}

ZONE RULES — READ CAREFULLY:
- Zone/room names appear as SECTION HEADERS above groups of numbered items (e.g. "1st Floor - Common Lobby", "Exterior Envelope", "2nd Floor - Office Suite 201")
- You MUST copy the section header text VERBATIM as the z value. Character-for-character. Do NOT abbreviate, rephrase, shorten, or paraphrase.
- WRONG: "Common Lobby" when the PDF says "1st Floor - Common Lobby"
- WRONG: "Exterior" when the PDF says "Exterior Envelope"
- WRONG: "Office / Suite A" when the PDF says "2nd Floor - Office Suite 201"
- WRONG: "Roofing" when the PDF says "Roof System"
- ALWAYS include floor prefixes if the PDF header has them (e.g. "1st Floor -", "2nd Floor -")
- Every item under the same section header MUST have the IDENTICAL z string — no variation allowed
- Before returning, verify: for each unique z value you used, confirm it matches a section header you actually saw in the PDF word-for-word

EXTRACTION RULES:
- Extract ONLY numbered line items — skip headers, measurement summaries, notes, totals, and grand totals
- Cost values must be exact numbers from the PDF — do not round or calculate
- Use null for any column that does not exist or has no value for that item
- Include ALL numbered items — do not skip any. Scan every page carefully.
- total_count must equal the highest item number in the PDF. Count all numbered items BEFORE extracting to ensure none are skipped.
- If an item's description spans multiple lines, concatenate them`;

// ── Continuation prompt (for truncated responses) ────────────────────────────

function buildContinuationPrompt(lastItemNumber: number): string {
  return `Continue extracting numbered line items from this same PDF.
Start from item number ${lastItemNumber + 1} onward. Skip all items up to and including #${lastItemNumber}.

Return the same JSON format:
{"items":[{"n":${lastItemNumber + 1},"d":"...","q":"...","u":"...","z":"...","rm":...,"rp":...,"rs":...,"tx":...,"op":...,"t":...}]}

Same rules as before: exact values, only numbered items.
CRITICAL REMINDER — zone names (z field): Copy each section header VERBATIM from the PDF. Include floor prefixes like "1st Floor -" or "2nd Floor -". Do NOT abbreviate, shorten, or rephrase. Every item under the same section header must use the identical z string.`;
}

// ── API call ─────────────────────────────────────────────────────────────────

async function callHaikuExtraction(
  pdfBase64: string,
  userPrompt: string,
  context: { comparisonId: string; side: string }
): Promise<{ text: string; truncated: boolean }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured.');

  const model = getExtractionModel();
  const maxTokens = getExtractionMaxTokens();
  const timeoutMs = getExtractionTimeoutMs();

  console.log(
    `[comparison:${context.comparisonId}] Vision extraction (${context.side}) starting — model=${model} max_tokens=${maxTokens}`
  );

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  const dispatcher = getExtractionDispatcher();

  try {
    const response = await undiciFetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0,
        system: EXTRACTION_SYSTEM_PROMPT,
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
              {
                type: 'text',
                text: userPrompt,
              },
            ],
          },
        ],
      }),
      signal: controller.signal,
      dispatcher,
    });

    clearTimeout(timeoutHandle);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(
        `Haiku extraction failed (${response.status}): ${errorBody.slice(0, 500)}`
      );
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const text = data.content?.find((c) => c.type === 'text')?.text ?? '';
    const truncated = data.stop_reason === 'max_tokens';

    console.log(
      `[comparison:${context.comparisonId}] Vision extraction (${context.side}) done — ` +
        `input=${data.usage?.input_tokens ?? '?'} output=${data.usage?.output_tokens ?? '?'} ` +
        `truncated=${truncated}`
    );

    return { text, truncated };
  } catch (error) {
    clearTimeout(timeoutHandle);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(
        `Haiku extraction (${context.side}) timed out after ${timeoutMs}ms.`
      );
    }
    throw error;
  }
}

// ── JSON parsing ─────────────────────────────────────────────────────────────

function extractJsonFromText(text: string): string {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch && fencedMatch[1]) return fencedMatch[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) return text.slice(start, end + 1);

  return text.trim();
}

interface ParsedHaikuResponse {
  items: HaikuItem[];
  totalCount: number | null;
}

/**
 * Attempt to repair truncated JSON from a Haiku response.
 * When max_tokens is hit mid-item, the JSON is invalid.
 * We find the last complete item object and close the array/object.
 */
function repairTruncatedJson(text: string): string | null {
  // Find the start of the items array
  const itemsStart = text.indexOf('"items"');
  if (itemsStart === -1) return null;
  const bracketStart = text.indexOf('[', itemsStart);
  if (bracketStart === -1) return null;

  // Find the last complete item object: look for },{ or },] or }]
  // Work backwards from the end to find the last complete }
  let lastComplete = -1;
  let depth = 0;
  for (let i = bracketStart + 1; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) lastComplete = i;
    }
  }

  if (lastComplete === -1) return null;

  // Rebuild: everything up to and including the last complete item, then close
  const itemsContent = text.substring(bracketStart + 1, lastComplete + 1);
  // Also try to extract total_count from the beginning
  const countMatch = text.match(/"total_count"\s*:\s*(\d+)/);
  const countPart = countMatch ? `"total_count":${countMatch[1]},` : '';

  return `{${countPart}"items":[${itemsContent}]}`;
}

function parseHaikuResponse(text: string): ParsedHaikuResponse {
  const jsonStr = extractJsonFromText(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Try to repair truncated JSON before giving up
    const repaired = repairTruncatedJson(text);
    if (repaired) {
      try {
        parsed = JSON.parse(repaired);
        console.warn(`[VisionExtract] Repaired truncated JSON — recovered partial response`);
      } catch {
        console.error('[VisionExtract] Failed to parse JSON even after repair attempt');
        console.error(`[VisionExtract] First 200 chars: ${text.substring(0, 200)}`);
        return { items: [], totalCount: null };
      }
    } else {
      console.error('[VisionExtract] Failed to parse JSON from Haiku response');
      console.error(`[VisionExtract] First 200 chars: ${text.substring(0, 200)}`);
      return { items: [], totalCount: null };
    }
  }

  if (!parsed || typeof parsed !== 'object') return { items: [], totalCount: null };
  const rawItems = (parsed as { items?: unknown }).items;
  const rawCount = (parsed as { total_count?: unknown }).total_count;
  const totalCount = typeof rawCount === 'number' ? rawCount : null;
  if (!Array.isArray(rawItems)) return { items: [], totalCount };

  const items = rawItems
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item) => ({
      n: typeof item.n === 'number' ? item.n : 0,
      d: typeof item.d === 'string' ? item.d : '',
      q: typeof item.q === 'string' ? item.q : null,
      u: typeof item.u === 'string' ? item.u.toUpperCase() : null,
      z: typeof item.z === 'string' ? item.z : null,
      rm: typeof item.rm === 'number' ? item.rm : null,
      rp: typeof item.rp === 'number' ? item.rp : null,
      rs: typeof item.rs === 'number' ? item.rs : null,
      tx: typeof item.tx === 'number' ? item.tx : null,
      op: typeof item.op === 'number' ? item.op : null,
      t: typeof item.t === 'number' ? item.t : null,
    }));

  return { items, totalCount };
}

// ── Convert Haiku items to pipeline-compatible format ────────────────────────

function haikuItemToParsedFields(item: HaikuItem, lineNumber: number): ParsedScopeFields {
  const costs: ExtractedCosts = {
    remove: item.rm,
    replace: item.rp,
    reset: item.rs,
    tax: item.tx,
    op: item.op,
    total: item.t,
  };

  return {
    lineNumber,
    rawText: item.d,
    description: item.d,
    descriptionTokens: item.d
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((t) => t.length > 0),
    quantity: item.q,
    unit: item.u,
    costs,
    zone: item.z,
    category: null,
  };
}

function haikuItemToLineRecord(item: HaikuItem, lineNumber: number): ExtractedLineRecord {
  // Build a synthetic text line that formatLineForClaude / formatCompactLine can use
  const parts: string[] = [`${item.n}.`, item.d];
  if (item.q && item.u) parts.push(`${item.q} ${item.u}`);
  if (item.t !== null) parts.push(`$${item.t.toFixed(2)}`);
  return {
    lineNumber,
    text: parts.join(' '),
  };
}

// ── Pre-flight: numbered item detection ───────────────────────────────────────

/**
 * Returns true if the PDF appears to contain numbered line items (e.g. "1.", "247.").
 * Uses pdf-parse text extraction — cheap, no API call required.
 *
 * Returns true (don't block) when:
 *   - pdf-parse fails (encrypted / scanned PDF — let vision handle it)
 *   - Extracted text is too short to be reliable (<200 chars — likely scanned)
 *   - At least 3 numbered item patterns are found
 *
 * Returns false (block + throw) only when text is extractable AND has no numbered items.
 */
async function hasNumberedLineItems(pdfBytes: Buffer): Promise<boolean> {
  try {
    const pdfParseModule = (await import('pdf-parse')) as unknown as {
      default: (buf: Buffer) => Promise<{ text: string }>;
    };
    const result = await pdfParseModule.default(pdfBytes);
    const text = result.text ?? '';
    // Scanned / image-only PDF — let vision handle it
    if (text.trim().length < 200) return true;
    // Match patterns like "1. Remove" or "247. R&R" — digit(s) + period + space + letter/$
    const matches = text.match(/\b[1-9]\d{0,3}\.\s{1,4}[A-Za-z$]/g) ?? [];
    return matches.length >= 3;
  } catch {
    // pdf-parse failure is non-fatal — let vision attempt extraction
    return true;
  }
}

// ── Gap detection ─────────────────────────────────────────────────────────────

/**
 * Detect gaps in the item numbering sequence (e.g., items go 1,2,...,67,69,...
 * means item 68 was skipped).  Returns the missing item numbers.
 */
function detectItemGaps(items: HaikuItem[]): number[] {
  if (items.length === 0) return [];
  const nums = new Set(items.map((it) => it.n));
  const maxNum = Math.max(...nums);
  const missing: number[] = [];
  for (let i = 1; i <= maxNum; i++) {
    if (!nums.has(i)) missing.push(i);
  }
  return missing;
}

function buildGapExtractionPrompt(missingNums: number[]): string {
  const numList = missingNums.join(', ');
  return `The following numbered line items were missed in a previous extraction from this PDF.
Extract ONLY the items with these specific numbers: ${numList}

Return the same JSON format:
{"items":[{"n":${missingNums[0]},"d":"...","q":"...","u":"...","z":"...","rm":...,"rp":...,"rs":...,"tx":...,"op":...,"t":...}]}

Same rules: exact values from the PDF, include zone names.`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract structured line items from a PDF using Claude Haiku vision.
 * Returns ExtractedLineRecord[] and a ParsedScopeFields map that plug
 * directly into the existing Sonnet comparison pipeline.
 */
export async function extractWithVision(
  pdfBytes: Buffer,
  context: { comparisonId: string; side: 'yours' | 'adjuster' }
): Promise<VisionExtractionResult> {
  const pdfBase64 = pdfBytes.toString('base64');
  const tag = `[comparison:${context.comparisonId}]`;

  // ── Pre-flight: confirm PDF contains numbered line items before calling Haiku ─
  const numberedItemsFound = await hasNumberedLineItems(pdfBytes);
  if (!numberedItemsFound) {
    throw new Error(
      `[VisionExtract] Pre-flight failed (${context.side}): this PDF does not appear to contain ` +
      `numbered line items (e.g. "1.", "2.", "247."). Xactimate estimates include numbered items ` +
      `by default — please ensure your estimate is exported with line item numbering enabled and re-upload.`
    );
  }

  // First extraction call
  const { text, truncated } = await callHaikuExtraction(
    pdfBase64,
    EXTRACTION_USER_PROMPT,
    context
  );

  traceStep(context.comparisonId, `HAIKU RAW RESPONSE — ${context.side.toUpperCase()}`, text);

  const firstResult = parseHaikuResponse(text);
  let allItems = firstResult.items;
  console.log(
    `${tag} Vision extraction (${context.side}) parsed ${allItems.length} items` +
      (firstResult.totalCount !== null ? ` (model reported total_count=${firstResult.totalCount})` : '')
  );

  // Handle truncation — send same full PDF with continuation prompt
  if (truncated && allItems.length > 0) {
    let lastItemNum = allItems[allItems.length - 1]!.n;
    const maxContinuations = 3;
    for (let cont = 0; cont < maxContinuations; cont++) {
      console.log(
        `${tag} Vision extraction (${context.side}) truncated at item #${lastItemNum}, requesting continuation ${cont + 1}...`
      );

      const { text: contText, truncated: contTruncated } = await callHaikuExtraction(
        pdfBase64,
        buildContinuationPrompt(lastItemNum),
        { comparisonId: context.comparisonId, side: `${context.side}-cont${cont + 1}` }
      );

      const contResult = parseHaikuResponse(contText);
      console.log(
        `${tag} Vision extraction (${context.side}) continuation ${cont + 1} got ${contResult.items.length} more items`
      );

      if (contResult.items.length === 0) break;
      allItems = [...allItems, ...contResult.items];
      lastItemNum = allItems[allItems.length - 1]!.n;
      if (!contTruncated) break;
    }
  } else if (truncated && allItems.length === 0) {
    // Truncation was so severe that even repair couldn't recover items.
    // Retry with a higher max_tokens hint — this is a last resort.
    console.warn(
      `${tag} Vision extraction (${context.side}) truncated with 0 parseable items — retrying full extraction...`
    );
    const { text: retryText } = await callHaikuExtraction(
      pdfBase64,
      EXTRACTION_USER_PROMPT,
      { comparisonId: context.comparisonId, side: `${context.side}-retry` }
    );
    const retryResult = parseHaikuResponse(retryText);
    allItems = retryResult.items;
    console.log(
      `${tag} Vision extraction (${context.side}) retry parsed ${allItems.length} items`
    );
  }

  // ── Gap detection: check for missing item numbers in the sequence ──────
  const missingNums = detectItemGaps(allItems);

  // Also check if model's self-reported total_count disagrees with extracted count
  if (firstResult.totalCount !== null && firstResult.totalCount > allItems.length) {
    const selfReportedGap = firstResult.totalCount - allItems.length;
    console.warn(
      `${tag} Vision extraction (${context.side}) total_count mismatch: model reported ${firstResult.totalCount} but only ${allItems.length} items extracted (${selfReportedGap} missing)`
    );
  }

  if (missingNums.length > 0 && missingNums.length <= 10) {
    // Targeted re-extraction for a small number of gaps
    console.warn(
      `${tag} Vision extraction (${context.side}) detected ${missingNums.length} gap(s) in item numbering: [${missingNums.join(', ')}]. Attempting targeted re-extraction...`
    );

    const { text: gapText } = await callHaikuExtraction(
      pdfBase64,
      buildGapExtractionPrompt(missingNums),
      { comparisonId: context.comparisonId, side: `${context.side}-gap` }
    );

    const gapResult = parseHaikuResponse(gapText);
    if (gapResult.items.length > 0) {
      console.log(
        `${tag} Vision extraction (${context.side}) gap fill recovered ${gapResult.items.length} items`
      );
      // Merge and re-sort by original item number
      allItems = [...allItems, ...gapResult.items];
      allItems.sort((a, b) => a.n - b.n);
    } else {
      console.warn(
        `${tag} Vision extraction (${context.side}) gap fill returned 0 items — gaps remain`
      );
    }

    // Log remaining gaps after retry
    const remainingGaps = detectItemGaps(allItems);
    if (remainingGaps.length > 0) {
      console.warn(
        `${tag} Vision extraction (${context.side}) still has ${remainingGaps.length} gap(s) after retry: [${remainingGaps.join(', ')}]`
      );
    }
  } else if (missingNums.length > 10) {
    console.warn(
      `${tag} Vision extraction (${context.side}) detected ${missingNums.length} gaps — too many for targeted retry, possible numbering anomaly`
    );
  }

  // ── Debug: dump raw Haiku zone assignments ──────────────────────────────────
  // Hard-guarded against production: Vercel's filesystem is read-only outside
  // /tmp, so any writeFileSync to `scripts/...` in prod would throw EROFS.
  if (process.env.NODE_ENV !== 'production' && process.env.DUMP_HAIKU_ZONES === 'true') {
    const zoneSummary = new Map<string, number>();
    for (const item of allItems) {
      const z = item.z ?? '__NULL__';
      zoneSummary.set(z, (zoneSummary.get(z) ?? 0) + 1);
    }
    const dumpData = {
      side: context.side,
      totalItems: allItems.length,
      uniqueZones: [...zoneSummary.entries()].sort((a, b) => b[1] - a[1]).map(([z, c]) => ({ zone: z, count: c })),
      items: allItems.map(it => ({ n: it.n, zone: it.z, desc: it.d.substring(0, 60) })),
    };
    const path = `scripts/haiku-raw-zones-${context.side}.json`;
    fs.writeFileSync(path, JSON.stringify(dumpData, null, 2));
    console.log(`${tag} Dumped raw Haiku zones for ${context.side} → ${path}`);
  }

  // Convert to pipeline-compatible formats
  const lines: ExtractedLineRecord[] = [];
  const parsedMap = new Map<number, ParsedScopeFields>();

  for (let i = 0; i < allItems.length; i++) {
    const item = allItems[i]!;
    const lineNumber = i + 1;
    lines.push(haikuItemToLineRecord(item, lineNumber));
    parsedMap.set(lineNumber, haikuItemToParsedFields(item, lineNumber));
  }

  return { lines, parsedMap };
}
