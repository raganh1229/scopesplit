// ─────────────────────────────────────────────────────────────────────────────
// N2 Pipeline — Pass 4B prompt: per-zone extraction only (unmatched zones)
//
// Used when a zone exists on only ONE side of the comparison — either only in
// E1 (contractor) or only in E2 (adjuster). One PDF document block is sent.
// The AI extracts all line items. Classification (MISSING_FROM_ADJUSTER or
// ADDED_BY_ADJUSTER) is applied in code by the extract-and-match orchestrator.
//
// Architecture refs: N2_SPEED_CAPACITY_ACCURACY.md §Pass 4B, Issue 34
// ─────────────────────────────────────────────────────────────────────────────

export type Pass4BPromptParams = {
  canonicalZoneName: string;
  startPage: number;
  endPage: number;
  side: 'contractor' | 'adjuster';
};

export function buildPass4BPrompt(p: Pass4BPromptParams): { system: string; user: string } {
  const system =
    'You are an expert insurance estimate analyst. You extract line items from an insurance estimate PDF. ' +
    'Return ONLY valid JSON — no markdown fences, no explanation, no extra text.';

  const user =
    `You are extracting line items from one insurance estimate. ` +
    `This document covers the zone: **${p.canonicalZoneName}**. ` +
    `This zone exists only in this estimate and has no counterpart in the other estimate.\n\n` +

    `This is the ${p.side}'s estimate (pages ${p.startPage}–${p.endPage} of the original document).\n\n` +

    `Context: Insurance estimates for property damage claims group line items by zone/room. ` +
    `You are extracting all line items from one zone that appears in only one of the two estimates.\n\n` +

    `EXTRACTION RULES:\n` +
    `1. Extract ONLY numbered line items — items beginning with an integer followed by a period ` +
    `(e.g. "1.", "47.", "203.").\n` +
    `2. SKIP: zone headers, section headers, measurement summaries, sub-totals, totals, grand totals, and notes.\n` +
    `3. Extract ONLY items within the zone "${p.canonicalZoneName}". ` +
    `Stop if you encounter a header for a different zone.\n` +
    `4. Cost values must be exact numbers from the PDF — do not round, estimate, or calculate.\n` +
    `5. If a cost column has no value for an item, return null for that field.\n` +
    `6. If a description spans multiple lines, concatenate all lines into one string.\n` +
    `7. Do not invent items. If you are not certain an item exists in the PDF, do not include it.\n\n` +

    `For each item extract:\n` +
    `- n: item number (integer)\n` +
    `- d: full description text (concatenated if multi-line)\n` +
    `- q: quantity as a string (e.g. "120.35") or null\n` +
    `- u: unit code (SF, LF, EA, SY, CY, HR, etc.) or null\n` +
    `- rm: remove cost (number or null)\n` +
    `- rp: replace cost (number or null)\n` +
    `- rs: reset cost (number or null)\n` +
    `- tx: tax (number or null)\n` +
    `- op: overhead & profit (number or null)\n` +
    `- t: total — always the rightmost cost value for this line item (number or null)\n\n` +

    `Return this exact JSON — nothing else:\n` +
    `{\n` +
    `  "zone": "${p.canonicalZoneName}",\n` +
    `  "items": [\n` +
    `    {"n":1,"d":"Insulation - blown-in attic","q":"800.00","u":"SF","rm":null,"rp":1240.00,"rs":null,"tx":116.00,"op":245.60,"t":1601.60},\n` +
    `    {"n":2,"d":"R&R Attic access door","q":"1.00","u":"EA","rm":45.00,"rp":120.00,"rs":null,"tx":15.42,"op":32.70,"t":213.12}\n` +
    `  ]\n` +
    `}`;

  return { system, user };
}
