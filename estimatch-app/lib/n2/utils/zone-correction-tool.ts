// ─────────────────────────────────────────────────────────────────────────────
// N2 Pipeline — Zone Correction: examine_pdf_pages tool
//
// Anthropic tool-use definition + handler for the zone correction agent.
// The agent calls this tool when a correction requires verifying a page range
// (missed zone, wrong start page, wrong name, merged/split zone).
//
// Blind edits (delete false-positive, merge duplicates, add matchHint,
// add confirmedUniqueZone) never trigger this tool.
// ─────────────────────────────────────────────────────────────────────────────

import { supabaseAdmin } from '@/lib/supabase';
import { loadPdf, slicePages } from '@/lib/n2/utils/pdf-slicer';
import type { N2DetectedZone } from '@/lib/n2/schemas/types';

// ── Anthropic tool definition ─────────────────────────────────────────────────

export const EXAMINE_PDF_PAGES_TOOL = {
  name: 'examine_pdf_pages',
  description:
    'Re-examine a specific page range of one estimate PDF to answer a targeted factual ' +
    'question about zone headers, verbatim names, or line items visible on those pages. ' +
    'Use printed page numbers (as they appear on the document), not internal PDF indices.',
  input_schema: {
    type: 'object' as const,
    properties: {
      pdf: {
        type: 'string',
        enum: ['e1', 'e2'],
        description: 'Which estimate PDF to examine: e1 (user\'s) or e2 (adjuster\'s)',
      },
      startPage: {
        type: 'integer',
        description: 'First printed page number to examine (inclusive)',
      },
      endPage: {
        type: 'integer',
        description: 'Last printed page number to examine (inclusive)',
      },
      question: {
        type: 'string',
        description:
          'Specific factual question to answer from the PDF pages, e.g. "Is there a Kitchen ' +
          'zone header on these pages? If yes, what is its exact verbatim name and the printed ' +
          'page number it appears on?"',
      },
    },
    required: ['pdf', 'startPage', 'endPage', 'question'],
  },
} as const;

// ── Tool input type ───────────────────────────────────────────────────────────

export type ExaminePdfPagesInput = {
  pdf: 'e1' | 'e2';
  startPage: number;
  endPage: number;
  question: string;
};

// ── Handler ───────────────────────────────────────────────────────────────────

const ESTIMATES_BUCKET = 'estimates';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const EXAMINE_MODEL = 'claude-sonnet-4-6';
const EXAMINE_MAX_TOKENS = 500;

function printedPageToInternalIndex(
  printedPage: number,
  zones: N2DetectedZone[],
  totalInternalPages: number,
): number {
  if (zones.length === 0) return Math.max(0, printedPage - 1);
  const firstZone = zones[0]!;
  const offset = firstZone.chunkOffset;
  const idx = printedPage + offset;
  return Math.max(0, Math.min(totalInternalPages - 1, idx));
}

export async function handleExaminePdfPages(
  input: ExaminePdfPagesInput,
  e1StoragePath: string,
  e2StoragePath: string,
  e1Zones: N2DetectedZone[],
  e2Zones: N2DetectedZone[],
  anthropicApiKey: string,
): Promise<string> {
  const storagePath = input.pdf === 'e1' ? e1StoragePath : e2StoragePath;
  const zones = input.pdf === 'e1' ? e1Zones : e2Zones;

  const { data, error } = await supabaseAdmin.storage
    .from(ESTIMATES_BUCKET)
    .download(storagePath);

  if (error || !data) {
    return JSON.stringify({ error: `Could not download PDF: ${error?.message ?? 'unknown'}` });
  }

  const buffer = await data.arrayBuffer();
  const pdfBytes = new Uint8Array(buffer);
  const doc = await loadPdf(pdfBytes);
  const totalPages = doc.getPageCount();

  const startIdx = printedPageToInternalIndex(input.startPage, zones, totalPages);
  const endIdx = printedPageToInternalIndex(input.endPage, zones, totalPages);
  const safeStart = Math.min(startIdx, endIdx);
  const safeEnd = Math.min(Math.max(startIdx, endIdx), totalPages - 1);

  const sliceBytes = await slicePages(doc, safeStart, safeEnd);
  const pdfBase64 = Buffer.from(sliceBytes).toString('base64');

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': anthropicApiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: EXAMINE_MODEL,
      max_tokens: EXAMINE_MAX_TOKENS,
      temperature: 0,
      system:
        'You are examining specific pages of an insurance estimate PDF to answer a single ' +
        'factual question. Return only the answer as plain JSON — no explanation, no markdown. ' +
        'If the answer requires text, use { "answer": "..." }. ' +
        'If you find a zone header, use { "found": true, "name": "...", "printedPage": N }. ' +
        'If not found, use { "found": false }.',
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
              text: `Pages shown: printed pages ${input.startPage}–${input.endPage}.\n\nQuestion: ${input.question}`,
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    return JSON.stringify({ error: `Anthropic API error: ${response.status} ${response.statusText}` });
  }

  const body = (await response.json()) as { content?: Array<{ text?: string }> };
  return body.content?.[0]?.text ?? JSON.stringify({ error: 'Empty response from model' });
}
