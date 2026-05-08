// ─────────────────────────────────────────────────────────────────────────────
// N3 Pipeline — Phase 6: zone correspondence prompt
//
// Builds the Sonnet prompt for proposing zone correspondences between the
// contractor (yours) estimate zones and the adjuster estimate zones.
//
// Zone correspondences are PRIORS — they add a score boost to candidate edges
// that cross corresponding zones. A wrong correspondence is a small penalty,
// not a hard failure. The model is instructed to prefer under-confident
// proposals over false-confidence ones.
//
// Architecture refs: N3.md §16.2 (zone boost), §14 (correspondence as prior)
// ─────────────────────────────────────────────────────────────────────────────

export type ZoneInput = {
  key: string;       // short index key: 'Y1', 'Y2', ... or 'A1', 'A2', ...
  name: string;      // verbatim zone name from PDF
  startPage: number;
  endPage: number;
  approxItems: number;
};

export type ZoneCorrespondencePromptParams = {
  yoursZones: ZoneInput[];
  adjusterZones: ZoneInput[];
};

export function buildZoneCorrespondencePrompt(p: ZoneCorrespondencePromptParams): {
  system: string;
  user: string;
} {
  const yoursBlock = p.yoursZones
    .map(z => `${z.key}: "${z.name}" (pages ${z.startPage}–${z.endPage}, ~${z.approxItems} items)`)
    .join('\n');

  const adjBlock = p.adjusterZones
    .map(z => `${z.key}: "${z.name}" (pages ${z.startPage}–${z.endPage}, ~${z.approxItems} items)`)
    .join('\n');

  return {
    system:
      'You are analyzing two insurance estimate zone lists for the same property damage claim. Your job is to propose which contractor zones correspond to which adjuster zones. Return only valid JSON — no markdown fences, no explanation.',

    user: `Two insurance estimates cover the same property damage. One is from the contractor (yours), one from the insurance adjuster. The estimates may organize work differently — contractors group by ROOM, adjusters often group by TRADE CATEGORY.

Your task: propose which contractor zones correspond to which adjuster zones for the purpose of finding matching line items.

━━━ CONTRACTOR (YOURS) ZONES ━━━
${yoursBlock}

━━━ ADJUSTER ZONES ━━━
${adjBlock}

━━━ CORRESPONDENCE RULES ━━━
1. A "correspondence" means: items in these zones are LIKELY to be compared against each other. It does NOT mean the zones are identical — just that line items from both sides will be paired together during matching.

2. CORRESPONDENCE TYPES:
   • "one_to_one" — one contractor zone pairs against one adjuster zone (same room/area)
   • "many_to_one" — multiple contractor zones pair against one adjuster zone (adjuster bundled many rooms into one trade category)
   • "one_to_many" — one contractor zone pairs against multiple adjuster zones (rare — adjuster split one room into separate trade sections)

3. TRADE-GROUPED ADJUSTERS: If the adjuster uses trade categories ("Demolition", "Carpentry", "Painting", etc.) and the contractor uses rooms ("Kitchen", "Bedroom", etc.), then MOST contractor zones will map to MOST adjuster zones. In that case, propose broad many_to_one correspondences rather than trying to force one_to_one pairings that don't exist.

4. UNMATCHED zones: Some zones may have no counterpart. For example:
   • Contractor "General Site Conditions" may have no adjuster equivalent
   • Adjuster "Labor Minimums Applied" may cover no contractor zone
   List these in unmatchedYours / unmatchedAdjuster instead of forcing a low-confidence correspondence.

5. CONFIDENCE: Score 0.0–1.0.
   • 0.9–1.0: High — names are semantically identical or near-identical (e.g., "Kitchen" ↔ "Kitchen")
   • 0.7–0.8: Good — clearly the same area by context (e.g., "Mstr Bthrm" ↔ "Master Bathroom")
   • 0.5–0.6: Moderate — trade category that likely covers this room (e.g., "Carpentry & Misc." covering multiple rooms)
   • 0.3–0.4: Low — weak signal, possible but uncertain
   • Below 0.3: Do not propose — omit or put in unmatched instead

6. COVERAGE: Every zone key should appear exactly once — either in a correspondence's yourKeys/adjusterKeys or in unmatchedYours/unmatchedAdjuster.

━━━ OUTPUT FORMAT ━━━
Return this exact JSON:
{
  "correspondences": [
    {
      "yourKeys": ["Y1", "Y2"],
      "adjusterKeys": ["A3"],
      "type": "many_to_one",
      "confidence": 0.75
    }
  ],
  "unmatchedYours": ["Y5"],
  "unmatchedAdjuster": ["A4"]
}`,
  };
}
