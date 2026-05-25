// ─────────────────────────────────────────────────────────────────────────────
// N2 Pipeline — Pass 4A prompt: per-zone extraction + matching (matched zones)
//
// Used when both E1 and E2 have a counterpart for this zone. Two PDF document
// blocks are sent (E1 slice + E2 slice). The AI extracts ALL line items from
// both documents and pairs them across estimates in one call.
//
// For 1:many zones (isMerged=true), the caller concatenates all zone ranges
// from the many-side into a single sub-PDF before calling this prompt.
//
// Architecture refs: N2_SPEED_CAPACITY_ACCURACY.md §Pass 4A, Issue 34
// ─────────────────────────────────────────────────────────────────────────────

export type Pass4APromptParams = {
  canonicalZoneName: string;
  /**
   * All contractor (E1) zone names whose pages have been concatenated into
   * Document 1 for this call. For 1:1 pairings this is a single name; for
   * N:1 / N:M pairings (merged zones) this contains every contractor zone
   * whose pages were stitched together.
   *
   * Used to scope extraction: the AI extracts items under any of these
   * headers in Document 1 and ignores items under any other zone header
   * (defensive against page-boundary spillover).
   */
  e1ZoneNames: string[];
  /**
   * All adjuster (E2) zone names whose pages have been concatenated into
   * Document 2 for this call. Same semantics as e1ZoneNames but for the
   * adjuster side.
   */
  e2ZoneNames: string[];
  e1StartPage: number;
  e1EndPage: number;
  e2StartPage: number;
  e2EndPage: number;
};

export function buildPass4APrompt(p: Pass4APromptParams): { system: string; user: string } {
  // Format zone-name lists as quoted, comma-separated strings for the prompt.
  const formatZoneList = (names: string[]): string =>
    names.length === 0 ? '(none)' : names.map(n => `"${n}"`).join(', ');
  const e1ZoneList = formatZoneList(p.e1ZoneNames);
  const e2ZoneList = formatZoneList(p.e2ZoneNames);
  const e1IsMerged = p.e1ZoneNames.length > 1;
  const e2IsMerged = p.e2ZoneNames.length > 1;
  const anyMerged = e1IsMerged || e2IsMerged;

  const system =
    'You are an expert insurance estimate analyst. You extract and compare line items ' +
    'from two insurance estimate PDFs zone by zone. ' +
    'Return ONLY valid JSON — no markdown fences, no explanation, no extra text.';

  const user =
    `You are comparing two insurance estimates written for the same property damage claim. ` +
    `Both documents below correspond to the same logical area of work: **${p.canonicalZoneName}**.\n\n` +

    `Document 1 is the contractor's estimate (pages ${p.e1StartPage}–${p.e1EndPage} of the original document).\n` +
    `Document 1 covers these contractor zones: ${e1ZoneList}.\n` +
    `Document 2 is the insurance adjuster's estimate (pages ${p.e2StartPage}–${p.e2EndPage} of the original document).\n` +
    `Document 2 covers these adjuster zones: ${e2ZoneList}.\n` +
    (anyMerged
      ? `\nNote: One or both documents have had multiple zones concatenated together — ` +
        `treat every line item under ANY of the listed zone headers as in-scope for this comparison.\n\n`
      : `\n`) +

    `Context: The contractor and adjuster each wrote independent repair estimates for the same property damage. ` +
    `The same work frequently appears with different wording, abbreviations, units, or prices. ` +
    `The two estimates will almost never have the same number of items — unmatched items are normal and expected. ` +
    `Do not force matches to reduce the unmatched count.\n\n` +

    `━━━ STEP 1: EXTRACT LINE ITEMS FROM BOTH DOCUMENTS ━━━\n\n` +

    `Apply these rules to BOTH Document 1 and Document 2:\n\n` +

    `1. Extract ONLY numbered line items. A numbered line item begins with an integer ` +
    `followed by a period (e.g. "1.", "47.", "203.").\n` +
    `2. SKIP everything that is not a numbered line item: zone headers, section headers, ` +
    `measurement summaries, sub-totals, totals, grand totals, and notes.\n` +
    `3. For Document 1, extract every numbered line item appearing under any of these contractor zone headers: ${e1ZoneList}. ` +
    `For Document 2, extract every numbered line item appearing under any of these adjuster zone headers: ${e2ZoneList}. ` +
    `If you encounter a header for a zone NOT in the relevant list, ignore everything under it (this is a defensive guard against page-boundary spillover and should rarely fire).\n` +
    `4. Cost values must be exact numbers from the PDF — do not round, estimate, or calculate.\n` +
    `5. If a cost column has no value for an item, return null for that field.\n` +
    `6. If a description spans multiple lines, concatenate all lines into one string.\n` +
    `7. Do not invent items. If you are not certain an item exists in the PDF, do not include it.\n\n` +

    `For each line item extract:\n` +
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

    `━━━ STEP 2: MATCH AND CLASSIFY ━━━\n\n` +

    `After extracting all items from both documents, match items across the two estimates.\n\n` +

    `MATCHING GUIDANCE:\n` +
    `- Match items describing the same trade or work, even with different wording. ` +
    `Examples: "R&R Base cabinets" ↔ "Remove & replace lower cabinets", ` +
    `"Tear out ceiling drywall" ↔ "Demo ceiling drywall".\n` +
    `- R&R = Remove & Replace. Common units: SF=Square Feet, LF=Linear Feet, EA=Each, SY=Square Yard, CY=Cubic Yard.\n` +
    `- "Detach & reset" and "R&R" are equivalent for fixtures (faucets, light fixtures, etc.).\n` +
    `- Grade or finish differences are normal and should still match: ` +
    `"standard grade" ↔ "economy grade", "satin" ↔ "eggshell".\n` +
    `- If two items have similar descriptions AND similar total costs, they are very likely the same item.\n` +
    `- If descriptions are similar but costs differ significantly, they are likely still the same item ` +
    `with a pricing dispute — classify as MODIFIED, not unmatched.\n` +
    `- Each item must appear in exactly one pair. Never use the same item number twice across any pairs.\n` +
    `- Items describing completely different work must NEVER be paired, ` +
    `even if they are the only remaining unmatched items in the zone.\n\n` +

    `Classify each pairing as:\n` +
    `- MATCH: Same work, same or near-identical quantity and cost. Minor wording differences acceptable.\n` +
    `- MODIFIED: Same type of work but different quantity, unit, or cost values.\n` +
    `- MISSING_FROM_ADJUSTER: Item exists in Document 1 (contractor) with no counterpart in Document 2 (adjuster).\n` +
    `- ADDED_BY_ADJUSTER: Item exists in Document 2 (adjuster) with no counterpart in Document 1 (contractor).\n\n` +

    `BEFORE RETURNING, VERIFY:\n` +
    `- Every item in your output actually appears in the PDF — no invented items\n` +
    `- All cost values match the PDF exactly — no rounding\n` +
    `- Every extracted item from both documents appears exactly once in your output\n\n` +

    `Return this exact JSON — nothing else:\n` +
    `{\n` +
    `  "zone": "${p.canonicalZoneName}",\n` +
    `  "pairs": [\n` +
    `    {\n` +
    `      "status": "MATCH",\n` +
    `      "e1": {"n":1,"d":"R&R Drywall 5/8 inch","q":"120.00","u":"SF","rm":0,"rp":234.50,"rs":null,"tx":21.93,"op":46.54,"t":302.97},\n` +
    `      "e2": {"n":3,"d":"R&R Drywall 5/8\\"","q":"120.00","u":"SF","rm":0,"rp":234.50,"rs":null,"tx":21.93,"op":46.54,"t":302.97}\n` +
    `    },\n` +
    `    {\n` +
    `      "status": "MISSING_FROM_ADJUSTER",\n` +
    `      "e1": {"n":5,"d":"Floor leveling compound","q":"1.00","u":"EA","rm":null,"rp":450.00,"rs":null,"tx":42.08,"op":89.20,"t":581.28},\n` +
    `      "e2": null\n` +
    `    },\n` +
    `    {\n` +
    `      "status": "ADDED_BY_ADJUSTER",\n` +
    `      "e1": null,\n` +
    `      "e2": {"n":7,"d":"Cleaning - general","q":"1.00","u":"EA","rm":null,"rp":85.00,"rs":null,"tx":7.95,"op":16.85,"t":109.80}\n` +
    `    }\n` +
    `  ]\n` +
    `}`;

  return { system, user };
}
