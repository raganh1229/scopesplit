// ─────────────────────────────────────────────────────────────────────────────
// N4 Pipeline — Symbility extraction prompts
//
// Builds system + user prompts for per-zone Symbility line item extraction.
//
// Symbility line item structure:
//   Column order:  [Item#]  Description  |  Qty  |  Per  |  Unit Price  |  Total Cost
//   Item number:   plain integer, no trailing period  (e.g. "2", "17", "134")
//   Description:   "{Action} - {Material}, {Specification}"
//                  e.g. "Tear Out - Shingles, Laminated/Architectural Good"
//   Qty:           numeric value  (e.g. "24.00")
//   Per:           unit code      (e.g. "SQ", "SF", "LF", "EA", "HR")
//   Unit Price:    cost per unit  (e.g. "63.52")
//   Total Cost:    line total     (e.g. "1,524.48")
//
// Fields always null for Symbility: rm, rp, rs, tx, op, code
// Field mapping: t = Total Cost, q = Qty, u = Per, up = Unit Price
//
// Phase 2 will harden these prompts with real sample data.
// ─────────────────────────────────────────────────────────────────────────────

export type SymbilityExtractionParams = {
  zoneName: string;
  startPage: number;
  endPage: number;
  side: 'contractor' | 'adjuster';
};

export type SymbilityExtractionPrompts = {
  system: string;
  user: string;
};

/**
 * Build system + user prompts for Symbility line item extraction.
 */
export function buildSymbilityExtractionPrompt(
  params: SymbilityExtractionParams,
): SymbilityExtractionPrompts {
  const { zoneName, startPage, endPage, side } = params;

  const system = `You are a precise parser for Symbility insurance estimate PDFs.

SYMBILITY LINE ITEM FORMAT:
Each line item occupies one row and has the following column structure:
  [Item#]  Description  |  Qty  |  Per  |  Unit Price  |  Total Cost

- Item#:       A plain integer with NO trailing period (e.g. 1, 2, 17, 134)
- Description: Free-form text, often "{Action} - {Material}, {Specification}"
- Qty:         Numeric quantity (may include decimal places)
- Per:         Unit code (SQ, SF, LF, EA, HR, LS, etc.)
- Unit Price:  Dollar amount per unit (no $ sign in output)
- Total Cost:  Line total (no $ or commas in output)

WHAT TO EXTRACT:
✓ Every numbered line item (rows with a plain integer at the start)
✓ Both single-line and multi-line descriptions (combine continuation lines)

WHAT TO SKIP (do NOT include in output):
✗ Sub-category label lines: "Shingles", "Underlayment", "Steep and High Charges", "Drip Edge", "Flashings", "Ventilation", "Ice & Water", "Gutters & Downspouts"
✗ Note/annotation lines below items: "Includes X% waste on quantity.", "Conversion: X SQ per LF", any line starting with lowercase after an item
✗ Measurement summary block: "Roof area: X SF", "Squares: X SQ", "Ridge length: X LF", "Pitch: X/12", etc.
✗ Zone closer lines: "{name} - Subtotal (N items)"
✗ Section headers: "Recap by Area", "Recap by Category", "Recap by Coverage", "MATERIALS", "LABOR"
✗ Column header row: "Description", "Qty", "Per", "Unit Price", "Total Cost"
✗ Page numbers, footers, document headers

RULES:
1. n  = item number (integer, exactly as printed — no renumbering)
2. p  = page number in the ORIGINAL PDF where this item appears (integer)
3. d  = full description text — concatenate continuation lines with a space
4. q  = quantity as a string (e.g. "24.00") or null if blank
5. u  = Per unit code (e.g. "SQ", "SF") or null if blank
6. up = Unit Price as a number (no $ sign) or null if blank
7. t  = Total Cost as a number (no $ sign, no commas) or null if blank
8. code, rm, rp, rs, tx, op — always null for Symbility
9. Stop at the NEXT zone header or end of document

OUTPUT FORMAT (JSON only, no other text):
{
  "zone": "${zoneName}",
  "items": [
    { "n": 1, "p": 3, "d": "Tear Out - Shingles, Laminated/Architectural Good", "q": "24.00", "u": "SQ", "up": 63.52, "t": 1524.48, "code": null, "rm": null, "rp": null, "rs": null, "tx": null, "op": null },
    ...
  ]
}`;

  const user = `Extract all numbered line items from zone "${zoneName}" (${side === 'contractor' ? 'contractor' : 'adjuster'} estimate, pages ${startPage}–${endPage}).

Apply all rules from the system prompt exactly. Return ONLY valid JSON.`;

  return { system, user };
}
