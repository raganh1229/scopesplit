// ─────────────────────────────────────────────────────────────────────────────
// N2 Pipeline — Pass 3: zone-matching prompt builder
//
// Produces the single user-turn message sent to Sonnet for zone matching.
// Text-only (no PDF images). The model receives both zone lists with page
// ranges, optional match hints from the zone-correction agent, and confirmed
// unique zones that must NOT be paired.
//
// Expected JSON response shape (no markdown fences):
// {
//   "matched": [
//     {
//       "e1Zones": [{ "zone": "...", "pages": [startPage, endPage] }],
//       "e2Zones": [{ "zone": "...", "pages": [startPage, endPage] }],
//       "canonical": "...",
//       "isMerged": false,
//       "confidence": 92
//     }
//   ],
//   "unmatchedE1": [{ "zone": "...", "pages": [startPage, endPage] }],
//   "unmatchedE2": [{ "zone": "...", "pages": [startPage, endPage] }]
// }
// ─────────────────────────────────────────────────────────────────────────────

import type { N2DetectedZone } from '@/lib/n2/schemas/types';
import type { MatchHint, ConfirmedUniqueZone } from '@/lib/n2/schemas/state-payloads';

export function buildMatchZonesPrompt(
  e1Zones: N2DetectedZone[],
  e2Zones: N2DetectedZone[],
  matchHints: MatchHint[],
  confirmedUniqueZones: ConfirmedUniqueZone[],
): string {
  const e1List = e1Zones
    .map(z => `  - "${z.name}" (pp. ${z.startPage}–${z.endPage}, ~${z.approxItems} items)`)
    .join('\n');

  const e2List = e2Zones
    .map(z => `  - "${z.name}" (pp. ${z.startPage}–${z.endPage}, ~${z.approxItems} items)`)
    .join('\n');

  const hintsSection =
    matchHints.length > 0
      ? `\nSTRONG MATCH HINTS (confirmed by the contractor — treat these as near-certain pairings):\n` +
        matchHints
          .map(h => {
            const b = Array.isArray(h.pdfB) ? h.pdfB.join('", "') : h.pdfB;
            return `  - E1 "${h.pdfA}" ↔ E2 "${b}" — ${h.reason}`;
          })
          .join('\n')
      : '';

  const uniqueSection =
    confirmedUniqueZones.length > 0
      ? `\nCONFIRMED UNIQUE ZONES (these zones exist in only one estimate — do NOT pair them):\n` +
        confirmedUniqueZones
          .map(u => `  - ${u.pdf === 'A' ? 'E1' : 'E2'} "${u.zone}" — ${u.reason}`)
          .join('\n')
      : '';

  return `You are matching zones between two property damage estimates for the same property.

E1 is the contractor's estimate. E2 is the adjuster's estimate. Both describe the same physical property but may use different room names, split or merge areas differently, or omit zones the other includes.

YOUR TASK: Match each E1 zone to the corresponding E2 zone that covers the same physical area of the property.

MATCHING RULES:
1. Match zones that represent the same physical location even when named differently (e.g., "Master Suite" ↔ "Master Bedroom", "Kitchen" ↔ "Kitchen/Dining").
2. One zone from one estimate may match multiple zones from the other (e.g., E1 "Master Suite" ↔ E2 "Master Bedroom" + "Master Bath"). Set isMerged=true for these.
3. Leave a zone unmatched only if it truly has no counterpart in the other estimate.
4. Assign confidence 50–100:
   - 95–100: Identical or near-identical names, obvious match
   - 80–94: Same room, different naming convention
   - 60–79: Probable match with some ambiguity
   - 50–59: Possible match, significant uncertainty
5. For "canonical", choose the most descriptive/specific name between the two.
6. Every zone from both estimates must appear exactly once — either in "matched" or in "unmatchedE1"/"unmatchedE2".
${hintsSection}${uniqueSection}

E1 ZONES (contractor's estimate):
${e1List}

E2 ZONES (adjuster's estimate):
${e2List}

Respond with ONLY a JSON object — no markdown, no code fences, no explanation. Use this exact structure:
{
  "matched": [
    {
      "e1Zones": [{ "zone": "verbatim E1 zone name", "pages": [startPage, endPage] }],
      "e2Zones": [{ "zone": "verbatim E2 zone name", "pages": [startPage, endPage] }],
      "canonical": "most descriptive display name",
      "isMerged": false,
      "confidence": 95
    }
  ],
  "unmatchedE1": [{ "zone": "verbatim E1 zone name", "pages": [startPage, endPage] }],
  "unmatchedE2": [{ "zone": "verbatim E2 zone name", "pages": [startPage, endPage] }]
}`;
}
