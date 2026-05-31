// ─────────────────────────────────────────────────────────────────────────────
// N4 Pipeline — XLS extractor: AI column detection
//
// Makes a single cheap LLM call at the start of P4 (detect-zones) to map a
// spreadsheet's actual column headers to the pipeline's expected field roles.
//
// Why AI instead of a static alias list:
//   - XLS exports vary widely across software (Symbility, CoreLogic, custom)
//   - A growing alias list is a maintenance trap
//   - The header row + 3 sample rows is ~150 tokens — negligible cost
//
// The result is persisted to Comparison.xlsColumnMapYours / xlsColumnMapAdj
// so P8 (extract-items) can reuse it without a second LLM call.
//
// This file is XLS-ONLY. It is not imported by any PDF extractor.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { parseAndValidate, withRetry, isTruncated } from '@/lib/n2/utils/ai-response';
import type { WorkbookRow } from './parse-workbook';

// ── Constants ─────────────────────────────────────────────────────────────────

const MODEL          = 'claude-sonnet-4-6';
const API_URL        = 'https://api.anthropic.com/v1/messages';
const API_VERSION    = '2023-06-01';
const MAX_TOKENS     = 300;
const SAMPLE_ROWS    = 3;   // number of data rows to show the model

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Maps each pipeline field role to the exact header string from the spreadsheet,
 * or null if that column is not present in the file.
 */
export type XlsColumnMap = {
  description: string | null; // line item work description (required)
  zone:        string | null; // room / area / group / location (zone grouping key)
  quantity:    string | null; // numeric quantity / units
  unitCost:    string | null; // cost per unit
  total:       string | null; // total line item cost (RCV / replacement cost / extended price)
  salesTax:    string | null; // tax amount
  itemCode:    string | null; // trade category, item code, or category code
};

// ── Zod schema for AI response ────────────────────────────────────────────────

const XlsColumnMapSchema = z.object({
  description: z.string().nullable(),
  zone:        z.string().nullable(),
  quantity:    z.string().nullable(),
  unitCost:    z.string().nullable(),
  total:       z.string().nullable(),
  salesTax:    z.string().nullable(),
  itemCode:    z.string().nullable(),
});

// ── Prompts ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are analyzing column headers from an insurance property-damage \
estimate spreadsheet. Your task is to identify which column corresponds to each of the \
following field roles used by the comparison pipeline:

- description  : the line item's work description (what is being done)
- zone         : room, area, group, or location that groups items (e.g. "Kitchen", "Roof")
- quantity     : numeric quantity or units for the line item
- unitCost     : cost per single unit
- total        : the total line item cost (may be called RCV, replacement cost, extended price, etc.)
- salesTax     : sales tax or tax amount for the line item
- itemCode     : trade category, item code, or category identifier

Respond ONLY with valid JSON using exactly these keys. Each value must be the EXACT column \
header string from the input (case-sensitive), or null if no column clearly matches that role.
Do not invent column names — only use strings that appear verbatim in the provided header list.`;

function buildUserPrompt(headers: string[], sampleRows: WorkbookRow[]): string {
  const headerLine = `Column headers: ${JSON.stringify(headers)}`;

  const rowLines = sampleRows.map((row, i) => {
    const cells = headers.map(h => {
      const v = row[h];
      return v === null || v === undefined ? '' : String(v).slice(0, 40);
    });
    return `Row ${i + 1}: ${JSON.stringify(cells)}`;
  });

  return [
    headerLine,
    '',
    'Sample data rows (first value per cell, max 40 chars):',
    ...rowLines,
  ].join('\n');
}

// ── API key ───────────────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key?.trim()) throw new Error('[n4/xls/detect-columns] ANTHROPIC_API_KEY is not configured.');
  return key.trim();
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Uses Claude to map a spreadsheet's actual column headers to pipeline field roles.
 *
 * @param headers   The header strings detected by parse-workbook.
 * @param rows      All parsed data rows (only the first SAMPLE_ROWS are sent to the LLM).
 * @returns         An XlsColumnMap where each value is an exact header string or null.
 *                  On failure (network, API, parse error) returns an all-null map so the
 *                  caller can fall back to alias-based detection without crashing.
 */
export async function detectXlsColumns(
  headers: string[],
  rows: WorkbookRow[],
): Promise<XlsColumnMap> {
  const nullMap: XlsColumnMap = {
    description: null, zone: null, quantity: null,
    unitCost: null, total: null, salesTax: null, itemCode: null,
  };

  if (headers.length === 0) return nullMap;

  const sampleRows = rows.slice(0, SAMPLE_ROWS);
  const userPrompt = buildUserPrompt(headers, sampleRows);

  try {
    const apiKey = getApiKey();

    const rawText = await withRetry(async () => {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify({
          model:      MODEL,
          max_tokens: MAX_TOKENS,
          system:     SYSTEM_PROMPT,
          messages:   [{ role: 'user', content: userPrompt }],
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`[n4/xls/detect-columns] Anthropic API error ${res.status}: ${body}`);
      }

      const json = await res.json() as {
        content: { type: string; text: string }[];
        stop_reason?: string | null;
      };

      const text = json.content?.[0]?.text ?? '';

      if (isTruncated(json.stop_reason, text)) {
        throw new Error('[n4/xls/detect-columns] Response was truncated — retrying');
      }

      return text;
    }, 3, 'xls-detect-columns');

    // parseAndValidate throws AIResponseError on failure — caught below
    const result = parseAndValidate(rawText, XlsColumnMapSchema, 'xls-detect-columns');

    // Validate that all non-null values are actual headers in the file
    const headerSet = new Set(headers);
    const validated: XlsColumnMap = { ...nullMap };
    for (const [key, val] of Object.entries(result)) {
      if (val !== null && headerSet.has(val)) {
        (validated as Record<string, string | null>)[key] = val;
      }
    }

    return validated;

  } catch {
    // Non-fatal — fall back to alias matching in detect-zones and extract-items
    return nullMap;
  }
}
