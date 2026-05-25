// ─────────────────────────────────────────────────────────────────────────────
// N4 Pipeline — Symbility zone-detection prompts
//
// These prompts replace the N2 pass1-chunk1/pass1-chunk-n prompts for
// Symbility-format PDFs. Key structural differences from Xactimate:
//
//   Zone header format:  "ROOFPLAN: {descriptive name}" (prefixed with area type)
//                        Also: "FLOORPLAN:", "ELEVATION:", "EXTERIOR:", etc.
//   Zone closer:         "{name} - Subtotal (N items)"
//   Sub-category labels: "Shingles", "Underlayment", etc. — NOT zone headers
//   Measurement block:   "Roof area: X SF  Squares: X SQ" — skip entirely
//   Summary sections:    "Recap by Area", "Recap by Category" — not zones
//   Item format:         Integer item number, no trailing period
//
// Phase 2 (Symbility Extractor) will replace this stub with production prompts.
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
 *
 * TODO (Phase 2): Replace stub system/user prompt with production Symbility prompt.
 */
export function buildSymbilityChunk1Prompt(params: SymbilityChunk1Params): SymbilityChunkPrompts {
  const { startPage, endPage, totalPages } = params;

  const system = `You are a precise insurance estimate parser specialising in Symbility-format estimates.

SYMBILITY FORMAT IDENTIFICATION SIGNALS:
- Document header contains "ESTIMATE: Structure" or similar
- Zone headers follow the pattern: "ROOFPLAN: {name}", "FLOORPLAN: {name}", "ELEVATION: {name}", "EXTERIOR: {name}", etc.
- Line items are numbered with plain integers (no trailing period): "1  Tear Out - Shingles..."
- Columns: Description | Qty | Per | Unit Price | Total Cost
- Each zone closes with: "{name} - Subtotal (N items)"
- Summary sections: "Recap by Area", "Recap by Category", "Recap by Coverage"

WHAT IS A VALID ZONE HEADER (Symbility):
✓ Lines matching the pattern "AREATYPE: Descriptive Name" where AREATYPE is a construction area prefix (ROOFPLAN, FLOORPLAN, ELEVATION, EXTERIOR, INTERIOR, etc.)
✓ The colon + space separator is mandatory

WHAT IS NOT A ZONE HEADER (skip these):
✗ Sub-category labels: "Shingles", "Underlayment", "Steep and High Charges", "Drip Edge", "Flashings", "Ventilation", "Ice & Water", "Gutters & Downspouts", "Miscellaneous"
✗ Measurement summary lines: "Roof area: X SF", "Squares: X SQ", "Ridge length: X LF"
✗ Zone closer lines: "{name} - Subtotal (N items)"
✗ Section headers: "Recap by Area", "Recap by Category", "Recap by Coverage", "MATERIALS", "LABOR"
✗ Column headers: "Description", "Qty", "Per", "Unit Price", "Total Cost"
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
 *
 * TODO (Phase 2): Replace stub with production Symbility prompt.
 */
export function buildSymbilityChunkNPrompt(params: SymbilityChunkNParams): SymbilityChunkPrompts {
  const { startPage, endPage, totalPages } = params;

  const system = `You are a precise insurance estimate parser specialising in Symbility-format estimates.

VALID ZONE HEADER (Symbility): Lines matching "AREATYPE: Descriptive Name" (e.g. "ROOFPLAN: Main Roof", "FLOORPLAN: Kitchen").

NOT A ZONE HEADER: Sub-category labels (Shingles, Underlayment, etc.), zone closers "{name} - Subtotal (N items)", measurement blocks, recap sections, column headers, or any line starting with an integer.

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
