// ─────────────────────────────────────────────────────────────────────────────
// N4 Pipeline — Symbility extraction prompts
//
// Builds system + user prompts for per-zone Symbility line item extraction.
//
// Symbility line item structure:
//   Column order:  [Item#]  Description  |  Qty  |  Unit Price  |  Per  |  Total Cost
//   Item number:   plain integer, no trailing period  (e.g. "2", "17", "134")
//   Description:   "{Action} - {Material}, {Specification}"
//                  e.g. "Tear Out - Shingles, Laminated/Architectural Good"
//   Qty:           numeric value  (e.g. "17.60")
//   Unit Price:    cost per unit  (e.g. "61.51")  — NOTE: comes BEFORE Per column
//   Per:           unit code      (e.g. "SQ", "SF", "LF", "EA", "HR")
//   Total Cost:    line total     (e.g. "1,082.58")
//
// Fields always null for Symbility: rm, rp, rs, tx, op, code
// Field mapping: t = Total Cost, q = Qty, u = Per, up = Unit Price
//
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
  [Item#]  Description  |  Qty  |  Unit Price  |  Per  |  Total Cost

- Item#:       A plain integer with NO trailing period (e.g. 1, 2, 17, 134)
- Description: Free-form text, often "{Action} - {Material}, {Specification}"
               but NOT always — some items have no action prefix
               (e.g., "Dumpster 10 Yard", "Dump Trailer, Tandem Axle")
- Qty:         Numeric quantity (may include decimal places)
- Unit Price:  Dollar amount per unit — comes BEFORE the Per/unit-code column
               (strip $ and commas)
- Per:         Unit code (SQ, SF, LF, EA, HR, LS, RM, LD, etc.) — comes AFTER Unit Price
- Total Cost:  Line total (strip $ and commas in output)

ZONE HEADERS:
Zone headers in Symbility match exactly one of these patterns:
  - "ROOFPLAN: <name>"
  - "EXTERIOR PLAN: <name>"    (note the space between EXTERIOR and PLAN)
  - "FLOORPLAN: <name>"

Stop extraction at the next zone header or end of document.

WHAT TO EXTRACT:
✓ Every numbered line item (rows with a plain integer at the start)
✓ Both single-line and multi-line descriptions (combine continuation lines with a space)
✓ Items with no action prefix (e.g., "Dumpster 10 Yard", "Satellite Dish, Recalibrate")
✓ Numbered general-statement items even when they have no numeric columns (see SPECIAL CASE below)

SPECIAL CASE — NUMBERED GENERAL STATEMENTS:
Symbility sometimes uses a numbered item to convey a general statement rather than a costed line item. Example:
  "1  To the best of our ability based on data available, this Estimate has been prepared to adhere with current, local building codes, based on the property's location."
These have an item number and description but NO quantity, unit price, unit code, or total cost.
Extract them with q, up, u, t all set to null. DO NOT hallucinate values for these items.

WHAT TO SKIP (do NOT include in output):

✗ Sub-category labels within a roof or sub-area:
   "Shingles", "Underlayment", "Steep and High Charges", "Drip Edge",
   "Flashings", "Ventilation", "Ice & Water"

✗ Standardized notes below items:
   "Includes X% waste on quantity.", "Includes X% waste on material price.",
   "Conversion: X SQ per LF"

✗ Free-form contextual justification notes following items (full sentences that follow
  a numbered item and have no numeric columns). Examples:
   - "This is needed to facilitate work on the ceiling."
   - "One wall shares a tape joint with the ceiling. If one wall is repainted, then all walls will need to be repainted to maintain uniformity."
   - "224 LF of eave gutters and 120 LF of downspouts."
   - "Walls will need to be protected from overspray when new texture is applied to the ceiling."

✗ Roof measurement summary block:
   "Roof area: X SF", "Squares: X SQ", "Ridge: X LF", "Gutters: X LF",
   "Eaves: X LF", "Soffit: X SF", "Pitch: X/12"

✗ Room measurement blocks within FLOORPLAN zones:
   "Length: X'X\"", "Width: X'X\"", "Height: X' Flat"
   "Walls: X SF", "Walls-subs: X SF", "Walls-subs-cas-bsbd: X SF"
   "Doors: X SF", "Windows: X SF", "Openings: X SF", "Missing Walls: X SF"
   "Floor: X SF", "Ceiling: X SF", "Perim (F): X LF", "Perim (C): X LF"

✗ Roof container headers within a ROOFPLAN zone:
   "Roof", "Roof, Roof, Roof 2", or any comma-separated list of "Roof" labels

✗ Sub-area container headers within EXTERIOR PLAN:
   "Gutters & Downspouts", "Windows", "Debris Removal"

✗ Room names within FLOORPLAN zones (e.g. "Garage", "Bedroom 3", "Kitchen")
   AND their continuation markers: "Garage(con't)", "Bedroom 3(con't)"

✗ Section sub-headers within a room (always uppercase, ending in colon):
   "CEILING:", "WALLS:", "FLOOR:", "WINDOWS:", "MISCELLANEOUS:", "ELECTRICAL:", "PLUMBING:"

✗ Subtotal/closer lines at ALL tiers — pattern "{name} - Subtotal (N items)":
   "Gutters & Downspouts - Subtotal (2 items)", "Garage - Subtotal (14 items)",
   "Roof, Roof, Roof 2 - Subtotal (20 items)", "Roofplan - Subtotal (20 items)"
   Note: Some subtotals appear twice (top and bottom of a section). Skip both.

✗ Recap summary sections (near end of document):
   "Recap by Area", "Recap by Category" (rows like "RFG - Roofing - RFG - Shingles"),
   "Recap by Coverage"

✗ MATERIALS recap table (column headers: "Quantity | Purchase Qty | Total").
  Re-lists items WITHOUT numbered prefixes. Treat the entire MATERIALS section as off-limits.

✗ LABOR recap table (rows like "1 CARPENTER", "1 ROOFER", "1 ROOFER & 1 LABORER"
  with hours and hourly rates).

✗ Finalization block:
   "Total Materials:", "Total Labor:", "Total Equipment:", "Total Market Conditions:",
   "Subtotal:", "Tax 1 X.000%", "Add X.00% overhead:", "Add X.00% profit:",
   "Estimate Subtotal:", "Deductible:", "Estimate Total:", "Finalization"

✗ Column header row: "Description", "Quantity", "Unit Price", "Per", "Total Cost"

✗ Repeating page header (appears on every page):
   "ESTIMATE: Structure" or "ESTIMATE: Structure (Claim Connection)"
   followed by "Claim #<number>, <FirstName> <LastName>" and "In progress"

✗ Repeating page footer: "Claim <ClaimNumber>    Page X of Y    MM/DD/YYYY"

✗ Cover/info pages, diagram pages (drawings only, no line items)

RULES:
1. n  = item number (integer, exactly as printed — no renumbering)
2. p  = page number in the ORIGINAL PDF where this item appears (integer)
3. d  = full description text — concatenate continuation lines with a space
4. q  = quantity as a string (e.g. "24.00") or null if blank
5. up = Unit Price as a number — SECOND numeric column (after Qty), before unit code — strip $ and commas, or null if blank
6. u  = Per unit code (e.g. "SQ", "SF", "LF", "EA", "RM", "LD") — THIRD column, after Unit Price — or null if blank
7. t  = Total Cost as a number (strip $ and commas) — rightmost cost column — or null if blank
8. code, rm, rp, rs, tx, op — always null for Symbility
9. Stop at the NEXT zone header ("ROOFPLAN:", "EXTERIOR PLAN:", or "FLOORPLAN:") or end of document
10. Numbered general-statement items: extract with q, up, u, t all null. DO NOT skip, DO NOT invent values.
11. Strip $ signs and commas from all numeric output fields.
12. Item numbering is GLOBAL across the entire estimate — numbers do NOT restart at zone boundaries. Use numbers exactly as printed.

OUTPUT FORMAT (JSON only, no other text):
{
  "zone": "${zoneName}",
  "items": [
    { "n": 2, "p": 3, "d": "Tear Out - Shingles, Laminated/Architectural Good", "q": "17.60", "up": 61.51, "u": "SQ", "t": 1082.58, "code": null, "rm": null, "rp": null, "rs": null, "tx": null, "op": null },
    ...
  ]
}`;

  const user = `Extract all numbered line items from zone "${zoneName}" (${side === 'contractor' ? 'contractor' : 'adjuster'} estimate, pages ${startPage}–${endPage}).

Apply all rules from the system prompt exactly. Return ONLY valid JSON.`;

  return { system, user };
}
