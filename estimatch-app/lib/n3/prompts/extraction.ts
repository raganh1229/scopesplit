// ─────────────────────────────────────────────────────────────────────────────
// N3 Pipeline — Phase 8: per-zone line item extraction prompt
//
// Builds the Sonnet system + user prompt for extracting all numbered line
// items from a single zone's sub-PDF. One call per zone per side.
//
// N3 extends N2's Pass 4B extraction schema with:
//   - p  (page number)  — powers page_proximity feature in Phase 13
//   - up (unit price)   — direct feature input for Phase 13
//   - code (item code)  — Xactimate code for item_code_match feature in Phase 13
//
// Architecture refs: N3.md §16.1, §16.2 (extraction_confidence, unit_price_similarity)
// ─────────────────────────────────────────────────────────────────────────────

export type ExtractionPromptParams = {
  zoneName: string;
  startPage: number;
  endPage: number;
  side: 'contractor' | 'adjuster';
  format: 'xactimate' | 'symbility' | 'unknown';
};

/**
 * Build the system + user prompts for extracting line items from one zone's
 * sub-PDF. The sub-PDF contains only the pages belonging to this zone.
 */
export function buildExtractionPrompt(p: ExtractionPromptParams): {
  system: string;
  user: string;
} {
  const formatHint =
    p.format === 'xactimate'
      ? 'This is an Xactimate estimate. Line items have a numeric item number, a description that may include an Xactimate trade code (e.g. "DRY218"), optional quantity and unit columns, and cost columns (Remove, Replace/Repair, Reset, Tax, O&P, Total).'
      : p.format === 'symbility'
        ? 'This is a Symbility estimate. Line items have a numeric item number, a description, optional quantity/unit, and a total cost column.'
        : 'The estimate format is unknown. Extract all numbered line items with whatever cost columns are visible.';

  const system =
    'You are an expert insurance estimate analyst. Extract line items from the insurance estimate PDF exactly as they appear. ' +
    'Return ONLY valid JSON — no markdown fences, no explanation, no extra text.';

  const user =
    `Extract all numbered line items from the zone "${p.zoneName}" in this ${p.side}'s insurance estimate.\n\n` +
    `This sub-document covers pages ${p.startPage}–${p.endPage} of the original estimate.\n` +
    `${formatHint}\n\n` +

    `EXTRACTION RULES:\n` +
    `1. Extract ONLY numbered line items — items beginning with an integer followed by a period (e.g. "1.", "47.", "203.").\n` +
    `2. SKIP: zone headers, section sub-headers (WALLS, CEILINGS, etc.), dimension rows, Subroom lines, sub-totals, totals, grand totals, and page headers/footers.\n` +
    `3. Extract ONLY items within the zone "${p.zoneName}". Stop when you encounter a header for a different zone.\n` +
    `4. Cost values must be exact numbers from the PDF — do not round, estimate, or calculate.\n` +
    `5. If a cost column has no value for an item, return null for that field.\n` +
    `6. If a description spans multiple lines, concatenate all lines into a single string with a space separator.\n` +
    `7. Do not invent items. If you are not certain an item exists in the PDF, do not include it.\n` +
    `8. Use the page numbers PRINTED on each page of this sub-document — do not renumber from 1.\n\n` +

    `For each item extract:\n` +
    `- n: item number (integer, as printed in the PDF)\n` +
    `- p: page number (printed) where this item appears\n` +
    `- d: full description text (concatenated if multi-line)\n` +
    `- code: Xactimate trade code if visible adjacent to the description (e.g. "DRY218", "WIN2") — null if not visible or not an Xactimate estimate\n` +
    `- q: quantity as a string (e.g. "120.35") or null\n` +
    `- u: unit code (SF, LF, EA, SY, CY, HR, etc.) or null\n` +
    `- up: unit price (number or null)\n` +
    `- rm: remove cost (number or null)\n` +
    `- rp: replace/repair cost (number or null)\n` +
    `- rs: reset cost (number or null)\n` +
    `- tx: tax (number or null)\n` +
    `- op: overhead & profit (number or null)\n` +
    `- t: total — the rightmost cost value for this line item (number or null)\n\n` +

    `Return this exact JSON — nothing else:\n` +
    `{\n` +
    `  "zone": "${p.zoneName}",\n` +
    `  "items": [\n` +
    `    {"n":16,"p":${p.startPage},"d":"R&R Drywall - per SF","code":"DRY218","q":"450.00","u":"SF","up":0.52,"rm":null,"rp":234.00,"rs":null,"tx":21.96,"op":51.19,"t":307.15},\n` +
    `    {"n":17,"p":${p.startPage},"d":"Texture drywall - light orange peel","code":null,"q":"450.00","u":"SF","up":0.38,"rm":null,"rp":171.00,"rs":null,"tx":16.04,"op":37.40,"t":224.44}\n` +
    `  ]\n` +
    `}`;

  return { system, user };
}
