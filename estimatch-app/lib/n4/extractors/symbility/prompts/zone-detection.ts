// ─────────────────────────────────────────────────────────────────────────────
// N4 Pipeline — Symbility zone-detection prompts
//
// These prompts replace the N2 pass1-chunk1/pass1-chunk-n prompts for
// Symbility-format PDFs. Key structural differences from Xactimate:
//
//   Zone header format:  "ROOFPLAN: {descriptive name}" (prefixed with area type)
//                        Also: "FLOORPLAN:", "EXTERIOR PLAN:" (with space!), "ELEVATION:", "INTERIOR:", etc.
//   Zone closer:         "{name} - Subtotal (N items)"
//   Sub-category labels: "Shingles", "Underlayment", etc. — NOT zone headers
//   Room names in FLOORPLAN: "Garage", "Bedroom 3" — NOT zone headers
//   Section sub-headers:  "CEILING:", "WALLS:", "FLOOR:", "MISCELLANEOUS:" — NOT zone headers
//   Measurement block:   "Roof area: X SF  Squares: X SQ" — skip entirely
//   Summary sections:    "Recap by Area", "Recap by Category" — not zones
//   Item format:         Integer item number, no trailing period
// ─────────────────────────────────────────────────────────────────────────────

export type SymbilityChunkPrompts = {
  system: string;
  user: string;
};

export type SymbilityChunk1Params = {
  startPage: number;
  endPage: number;
  totalPages: number;
};

/**
 * Build prompts for the FIRST chunk of a Symbility PDF.
 * Detects zone boundaries using Symbility-specific structural signals.
 */
export function buildSymbilityChunk1Prompt(params: SymbilityChunk1Params): SymbilityChunkPrompts {
  const { startPage, endPage, totalPages } = params;

  const system = `You are a precise insurance estimate parser specialising in Symbility-format estimates.

SYMBILITY FORMAT IDENTIFICATION SIGNALS:
- Document header contains "ESTIMATE: Structure" or similar
- Zone headers follow exactly one of these patterns: "ROOFPLAN: {name}", "EXTERIOR PLAN: {name}" (note the SPACE between EXTERIOR and PLAN), "FLOORPLAN: {name}". Less common: "ELEVATION: {name}", "INTERIOR: {name}".
- Line items are numbered with plain integers (no trailing period): "2  Tear Out - Shingles..."
- Columns (left to right): Description | Quantity | Unit Price | Per | Total Cost
- Each zone closes with: "{name} - Subtotal (N items)"
- Summary sections: "Recap by Area", "Recap by Category", "Recap by Coverage"

WHAT IS A VALID ZONE HEADER (Symbility):
✓ Lines matching the pattern "AREATYPE: Descriptive Name" where AREATYPE is one of: ROOFPLAN, FLOORPLAN, "EXTERIOR PLAN" (two words with a space), ELEVATION, INTERIOR, GARAGE
✓ The colon + space separator is mandatory — e.g. "ROOFPLAN: Roofplan", "EXTERIOR PLAN: Exterior Plan", "FLOORPLAN: Main Level"
✓ "EXTERIOR PLAN" specifically has a space between the two words — do NOT collapse it to "EXTERIORPLAN"

WHAT IS NOT A ZONE HEADER (skip these):
✗ Sub-category labels within a zone: "Shingles", "Underlayment", "Steep and High Charges", "Drip Edge", "Flashings", "Ventilation", "Ice & Water", "Gutters & Downspouts", "Miscellaneous"
✗ Room names within a FLOORPLAN zone: "Garage", "Bedroom 3", "Kitchen", "Bathroom" — these are sub-area headings, not top-level zone headers
✗ Section sub-headers within a room (even though they contain a colon): "CEILING:", "WALLS:", "FLOOR:", "MISCELLANEOUS:", "ELECTRICAL:", "PLUMBING:" — note these are ALL-CAPS single words followed by a colon at the start of a line, with no descriptive name after the colon
✗ Measurement summary lines: "Roof area: X SF", "Squares: X SQ", "Ridge length: X LF", "Soffit: X SF", "Eaves: X LF"
✗ Room dimension lines: "Length: X'X\"", "Width: X'X\"", "Height: X'", "Flat Walls: X SF", "Floor: X SF", "Ceiling: X SF"
✗ Zone closer / subtotal lines: "{name} - Subtotal (N items)"
✗ Summary section headers: "Recap by Area", "Recap by Category", "Recap by Coverage"
✗ Column header rows: "Description", "Quantity", "Unit Price", "Per", "Total Cost"
✗ Any line that starts with an integer (those are line items, not zone headers)

OUTPUT FORMAT (JSON only, no other text):
{
  "format": "symbility",
  "first_page_printed_number": <integer or null>,
  "approx_items_on_pages": <integer>,
  "zones": [
    {
      "name": "<full zone header text including prefix, e.g. 'ROOFPLAN: Main Roof'>",
      "start_page": <printed page number>,
      "evidence_item": "<first line item description under this zone>",
      "approx_items": <integer>
    }
  ]
}`;

  const user = `Analyse pages ${startPage}–${endPage} of ${totalPages} of this Symbility insurance estimate PDF.

Identify all ZONE HEADERS on these pages using the Symbility-specific rules in the system prompt.

Return ONLY valid JSON. Include every zone whose header STARTS on these pages.`;

  return { system, user };
}

export type SymbilityChunkNParams = {
  startPage: number;
  endPage: number;
  totalPages: number;
};

/**
 * Build prompts for SUBSEQUENT chunks (chunk index > 0) of a Symbility PDF.
 * Same logic as chunk 1 but without format detection (format is already known).
 */
export function buildSymbilityChunkNPrompt(params: SymbilityChunkNParams): SymbilityChunkPrompts {
  const { startPage, endPage, totalPages } = params;

  const system = `You are a precise insurance estimate parser specialising in Symbility-format estimates.

VALID ZONE HEADER (Symbility): Lines matching "AREATYPE: Descriptive Name" where AREATYPE is one of: ROOFPLAN, FLOORPLAN, "EXTERIOR PLAN" (two words with a SPACE), ELEVATION, INTERIOR — followed by colon + descriptive name. E.g. "ROOFPLAN: Roofplan", "EXTERIOR PLAN: Exterior Plan", "FLOORPLAN: Main Level". "EXTERIOR PLAN" has a space — do NOT collapse it to "EXTERIORPLAN".

NOT A ZONE HEADER (skip all of these):
- Sub-category labels: Shingles, Underlayment, Gutters & Downspouts, etc.
- Room names inside FLOORPLAN: Garage, Bedroom 3, Kitchen, etc.
- Section sub-headers (ALL-CAPS single word + colon, no name after): CEILING:, WALLS:, FLOOR:, MISCELLANEOUS:
- Measurement lines: Roof area, Squares, Soffit, Eaves, Length, Width, Height, Flat Walls
- Zone closer lines: "{name} - Subtotal (N items)"
- Recap sections, column headers, any line starting with an integer.

OUTPUT FORMAT (JSON only):
{
  "first_page_printed_number": <integer or null>,
  "approx_items_on_pages": <integer>,
  "zones": [
    {
      "name": "<full header text including prefix>",
      "start_page": <printed page number>,
      "evidence_item": "<first item under this zone>",
      "approx_items": <integer>
    }
  ]
}`;

  const user = `Analyse pages ${startPage}–${endPage} of ${totalPages} of this Symbility insurance estimate PDF.

Identify all ZONE HEADERS that START on these pages. Return ONLY valid JSON.`;

  return { system, user };
}
