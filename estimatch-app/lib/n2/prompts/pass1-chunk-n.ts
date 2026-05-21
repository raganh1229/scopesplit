// ─────────────────────────────────────────────────────────────────────────────
// N2 Pipeline — Pass 1 / Chunk N prompt (zone detection, chunks 2+)
//
// Used for all chunks after the first (chunkIndex > 0) of EVERY PDF processed
// in Step 2 (detect-zones). No format detection — format was captured in
// chunk 1 (pass1-chunk1.ts) at zero extra cost.
//
// Architecture refs: N2_SPEED_CAPACITY_ACCURACY.md §Pass 2, Issues 1/2/35
// ─────────────────────────────────────────────────────────────────────────────

export type Pass1ChunkNPromptParams = {
  /** Estimated first printed page number of this chunk (context only). */
  startPage: number;
  /** Estimated last printed page number of this chunk (context only). */
  endPage: number;
  /** Total internal page count of the full PDF (from pdf-lib). */
  totalPages: number;
};

/**
 * Build the system + user prompts for zone detection on chunk N (N > 0) of a PDF.
 *
 * Identical contract to pass1-chunk1.ts except no format detection task.
 */
export function buildPass1ChunkNPrompt(p: Pass1ChunkNPromptParams): {
  system: string;
  user: string;
} {
  return {
    system:
      'You are analyzing a section of an insurance estimate PDF. Your only job is to locate all zone/section headers on these pages. Do not extract line items, costs, or any other data. Return only valid JSON — no markdown fences, no explanation, no preamble, no PDF text. If the pages contain non-estimate content (appendices, settlement agreements, diagrams, maps, signature pages, etc.) with no line-item zones, return the JSON with an empty zones array. NEVER return raw page text or prose — ALWAYS return the JSON structure.',

    user: `You are processing a section of a ${p.totalPages}-page insurance estimate PDF. This section covers approximately pages ${p.startPage}–${p.endPage} of the original document.
Use whichever page numbers are PRINTED on each page of this sub-document for all page references — do not renumber from 1.

Context: Insurance estimates for property damage claims group line items under zone/room headers. You are identifying where each zone begins in this section of the document.

Find all zone or section headers on these pages that mark the beginning of a group of line items for a specific room or area of the property.

APPROACH — two passes:
PASS 1 (quick scan): Read through all pages and note anything that MIGHT be a zone header — any bold or prominent heading that names a room or area.
PASS 2 (thorough examination): For each candidate from Pass 1, apply the criteria below to make a confident final determination before reporting it.

WHAT IS A VALID ZONE HEADER:
A standalone heading in the body of the estimate that names a room, area, or section of the building (e.g. "Kitchen", "1st Floor - Master Bedroom", "Mstr Bthrm", "Entry/Foyer"). The header is followed — possibly after a dimensions block (SF Walls, SF Ceiling, "Missing Wall", "Door" rows) and/or one or more "Subroom:" lines with their own dimensions — by numbered line items or a cost table. The line items do NOT have to appear on the same line as the header; they typically appear after the dimensions section.

CONFIDENCE SIGNALS — use these to validate candidates:
- STRONGEST — two related forms:
  • "Totals: <name>" (plural) closes an individual zone. Every Xactimate zone ends with this line and <name> matches the zone header verbatim. When you see this, the zone IS real. Use the spelling after "Totals:" as authoritative.
  • "Total: <name>" (singular) closes an area rollup containing multiple zones (e.g. "Total: Main Level", "Total: Master Suite"). This confirms <name> existed in the document. If <name> also has its own line items directly beneath its header before any sub-zone starts, it IS also a zone in its own right. Note: intermediate sub-totals like "Dwelling Totals:" or "Building Code Upgrades Totals:" are NOT zone closers — they are coverage-bucket sub-totals within a single zone.
- A small floorplan thumbnail or floor sketch in the top-left corner of the page with the zone name displayed next to it.
- A "Height:" indicator appearing on the same horizontal line as the heading name (Xactimate-specific indicator). The value can be a numeric measurement ("8'", "9' 4"") or a non-numeric descriptor ("Peaked"). Both qualify.

STRUCTURAL STYLE — adjuster (trade-grouped) vs contractor (room-grouped):
Not every estimate organizes by room. Insurance adjusters frequently organize work by TRADE CATEGORY rather than by physical room — the entire document is split into a small number of trade-bundled sections, each containing items from many different rooms. Trade-grouped zones look like this and ARE valid zones:
  • "Demolition & Debris Hauling" / "Demolition" / "Debris Removal"
  • "Roofing Systems" / "Roofing"
  • "Carpentry & Misc." / "Carpentry" / "Framing & Carpentry"
  • "Exterior Finishes" / "Exterior" / "Siding & Exterior"
  • "General & Site" / "General Conditions" / "Site Work"
  • "Plumbing" / "Electrical" / "HVAC" (when used as top-level document sections, not as sub-categories within a room)
  • "Painting" / "Flooring" / "Drywall"
An estimate using this style typically has 3–8 of these top-level trade sections covering the entire document. EACH such section is a separate zone — report all of them. A 4-page document with 5 trade sections has 5 zones, not 1. Trade-grouped zones do NOT need Xactimate-style "Totals:" closers, dimensions blocks, or floorplan thumbnails to qualify; the trade name itself plus numbered line items below is sufficient evidence.

Distinguishing top-level trade zones from sub-category headers (rule of thumb): if a heading like "PLUMBING" appears INSIDE a room zone (e.g. under "Master Bathroom" alongside "WALLS", "FLOORING", "CABINETS"), it's a sub-category and NOT a zone. If "Plumbing" appears as a TOP-LEVEL document section with line items pulled from multiple rooms (no parent room zone), it IS a zone. Check the document structure, not just the word.

SPECIAL HANDLING — non-room sections (DO report these as zones):
Some sections appear at the start or end of an estimate that are NOT physical rooms but ARE valid zones because they have their own line items and a closer:
- "General Items" / "General Conditions" — front-of-document misc charges (debris, dumpsters, supervision)
- "Labor Minimums Applied" — end-of-document trade minimum-hour charges
- Testing sections such as "Mold Sample"
- Trade categories or coverage groupings used as standalone zones with placeholder dimensions (e.g. "Electrical" or "Plants, Trees & Shrubs" or "Sprinklers & Controllers" with Height: 1' and 1.00 SF Floor). These have real line items and a "Totals:" closer — report them using their verbatim name. Placeholder/unrealistic dimensions are NOT a disqualifier.
Treat all of these like any other zone: report them with their verbatim name, evidence item, and approx item count.

WHAT IS NOT A VALID ZONE HEADER:
- "Subroom: X" lines. These appear under a parent zone (often with their own Height: and dimensions block) but are NOT independent zones — line items beneath a Subroom belong to the PARENT zone above it. Never report a Subroom as a zone.
- Sub-category headers within a zone such as "PLUMBING", "ELECTRICAL", "HVAC", "CABINETS", "TRIMWORK", "CEILINGS", "WALLS", "FLOORING", "APPLIANCES", "APPLIANCES/PLUMBING", "FINAL CLEANING". These are trade/category groupings within a single zone, not zones.
- Coverage subdividers within a zone such as "DWELLING", "BUILDING CODE UPGRADES", "OTHER STRUCTURES", "TREES & SHRUBS", "LANDSCAPING" appearing as ALL-CAPS section dividers between line items. These split a single zone's items into coverage buckets and are followed by per-coverage sub-totals like "Dwelling Totals:" or "Building Code Upgrades Totals:" BEFORE the actual zone closer. Do NOT treat coverage subdividers as zones, and do NOT treat their sub-totals as zone closers.
- A header reading "CONTINUED - X" (or "CONT. - X", "(continued)", etc.) at the top of a page. Zone X already started on an earlier page — it is a continuation marker, NOT a new zone. Do NOT report "CONTINUED - X" entries as zones. IMPORTANT: a CONTINUED marker does NOT claim the whole page — keep scanning down, because a brand-new zone often begins lower on the same page after the previous zone's items finish.
- Floor-level or area labels such as "Main Level", "Second Floor", "Basement", "Upper Level", "Lower Level", "Master Suite" appearing as grouping headers for the zones below. These are NOT zones themselves. EXCEPTION: if the label has its own numbered line items directly beneath it before any other zone header starts, AND either a "Totals: <Name>" or "Total: <Name>" closer is visible somewhere in the document, then it IS a real zone (e.g. "Main Level" with items 8–17 below before "Entry" begins; "Master Suite" with one final-cleaning item before "Hallway" begins; "Attic" with items 16–25 before the next zone).
- Page headers / footers (company name, date, page number).
- Subtotal rows that are not "Totals: <name>" closers.
- Headings not followed by any line items on these pages.
- Garbled or overlapping text appearing inside or near a floorplan thumbnail/sketch (e.g. "LiHviang llway Room"). These are OCR artifacts of overlapping floorplan labels, not real zone headers.
- Zone names listed in a "Recap by Room", table of contents, or summary section near the end of the document.

RULES:
1. Search the body of the estimate only. Do not report zone names from any "Recap by Room", table of contents, or summary section.
2. A valid zone header must be followed by numbered line items within this chunk — possibly after a dimensions block or Subroom lines. If no line items appear beneath, do not report it.
3. For each valid zone header, return the first numbered line item visible beneath it as evidence. No evidence = do not report the header. Line item numbers are GLOBAL across the entire document and do NOT reset per zone — the "first item" under a zone is the lowest-numbered item visible beneath that zone's header (e.g. "16. Content Manipulation charge - per hour", not "1. ..."). When a zone is split across chunk boundaries and only later items are visible in this chunk, return the lowest-numbered item visible in this chunk — that is sufficient evidence.
4. Return zone names VERBATIM — character for character exactly as they appear in the PDF. Do NOT abbreviate, shorten, rephrase, or paraphrase. Always include floor prefixes exactly as shown. When a "Totals: <name>" line is visible for the zone, the <name> after "Totals:" is the authoritative spelling.
5. If the same zone name appears more than once on these pages (after excluding CONTINUED - markers, which are already filtered by the rules above), report only the FIRST occurrence (the original header). Subsequent appearances are recap entries.
6. Use the page numbers PRINTED on each page of this sub-document for all page references — do not use sub-document numbering (1, 2, 3...). The approximate range in the original document is ${p.startPage}–${p.endPage}.
7. If no valid zone headers are found on these pages — including chunks that consist entirely of CONTINUED pages from zones that started earlier — return an empty zones array. This is valid, expected, and correct. Do NOT output prose, page text, or any non-JSON content in this case.
8. For each zone, count line items by reading the printed item numbers (e.g. items 16 through 29 = 14 items). Do NOT visually count rows — printed numbers are explicit and reliable. Count only items visible on these pages; if the zone continues past this chunk, count only what is visible here.
9. Also count the total number of numbered line items visible on ALL pages in this chunk, regardless of which zone they belong to. Return this as approx_items_on_pages.

Return this exact JSON — nothing else:
{
  "first_page_printed_number": <integer — the page number printed on the very first page of this chunk>,
  "approx_items_on_pages": <integer — total approximate count of ALL numbered line items visible on these pages>,
  "zones": [
    {
      "name": "<verbatim zone name exactly as it appears in the PDF>",
      "start_page": <integer — original printed page number where this header appears>,
      "evidence_item": "<text of the first numbered line item visible beneath this header>",
      "approx_items": <integer — approximate count of numbered line items visible under this zone on these pages>
    }
  ]
}`,
  };
}
