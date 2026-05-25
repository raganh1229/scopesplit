// ─────────────────────────────────────────────────────────────────────────────
// N2 Pipeline — Pass 5 prompt: cross-zone item reconciliation (Opus, text only)
//
// Pass 5 runs after Pass 4 has finished extracting and pairing items
// zone-by-zone. It receives the full list of MISSING_FROM_ADJUSTER items
// (contractor orphans) and the full list of ADDED_BY_ADJUSTER items
// (adjuster orphans) collected across every zone, and decides which orphans
// are actually the same line of work that the two estimators filed under
// different zones (e.g. contractor groups demolition by room, adjuster
// bundles all demolition into a single zone).
//
// The prompt is uncompromisingly conservative: a wrong cross-zone pairing
// silently corrupts the user's report, while a missed pairing leaves the
// existing recoverable MISSING / ADDED disposition. The asymmetry justifies
// strict thresholds and a hesitant posture.
//
// Architecture refs: N2_SPEED_CAPACITY_ACCURACY.md §Pass 5, Issues 39–41
// ─────────────────────────────────────────────────────────────────────────────

import type { N2ExtractedItem } from '@/lib/n2/schemas/types';

/**
 * One contractor orphan presented to Opus. The id is a stable reference Opus
 * uses in its returned pairs (e.g. "C7").
 */
export type Pass5ContractorOrphan = {
  id: string; // "C1", "C2", ...
  zone: string; // home zone name (where the orphan was extracted)
  item: N2ExtractedItem;
};

/**
 * One adjuster orphan presented to Opus. Same shape but with id "A1", "A2", ...
 */
export type Pass5AdjusterOrphan = {
  id: string; // "A1", "A2", ...
  zone: string;
  item: N2ExtractedItem;
};

export type Pass5PromptParams = {
  contractorOrphans: Pass5ContractorOrphan[];
  adjusterOrphans: Pass5AdjusterOrphan[];
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatItemLine(orphan: Pass5ContractorOrphan | Pass5AdjusterOrphan): string {
  const { id, zone, item } = orphan;
  const qty = item.q ?? '—';
  const unit = item.u ?? '';
  const qtyUnit = unit ? `${qty} ${unit}` : `${qty}`;
  const total = item.t != null ? `$${item.t.toFixed(2)}` : '$—';
  // Truncate description to keep the prompt token-efficient on dense estimates.
  const desc = item.d.length > 160 ? `${item.d.slice(0, 157)}...` : item.d;
  return `${id} | zone: "${zone}" | qty: ${qtyUnit} | total: ${total} | desc: ${desc}`;
}

// ── Prompt builder ───────────────────────────────────────────────────────────

export function buildPass5Prompt(p: Pass5PromptParams): { system: string; user: string } {
  const system =
    'You are an expert insurance estimate analyst performing a careful, conservative ' +
    'cross-zone reconciliation pass on items that two different estimators left unpaired.\n\n' +
    'Your job is to identify the small subset of items that are clearly the same line of work, ' +
    "even though one estimator filed them under a different zone than the other. The two estimates " +
    'have already been compared zone-by-zone; the items in front of you are the leftovers — items ' +
    'that found no counterpart inside their own zone.\n\n' +
    'Be deliberately careful. A wrong cross-zone pairing silently corrupts the report. A missed ' +
    'cross-zone pairing leaves both items as MISSING / ADDED, which the user must reconcile manually. ' +
    'Both errors have real cost. The right posture is: pair when the evidence is clear, refuse to pair ' +
    'when the evidence is genuinely ambiguous, and do not refuse to pair simply because some signal is ' +
    'imperfect (e.g. quantity differs by 25%).\n\n' +
    'Note: items with identical totals to the cent and overlapping descriptions have already been paired ' +
    'by a deterministic upstream pass. The orphans you see below are the residual cases where total or ' +
    'description signals are imperfect — your cross-zone reasoning is what they need.\n\n' +
    'Return ONLY valid JSON — no markdown fences, no explanation, no extra text.';

  const contractorBlock = p.contractorOrphans.length === 0
    ? '(none)'
    : p.contractorOrphans.map(formatItemLine).join('\n');

  const adjusterBlock = p.adjusterOrphans.length === 0
    ? '(none)'
    : p.adjusterOrphans.map(formatItemLine).join('\n');

  const user =
    'Two contractors wrote independent insurance estimates for the same property damage. ' +
    'They organized their work differently — for example, one may have grouped demolition by room ' +
    'while the other bundled all demolition into a single zone. After zone-by-zone comparison, ' +
    'the following items were left unpaired on each side. Many of them are genuinely unique to ' +
    'their estimate. A small minority describe the same physical work and were misfiled into ' +
    'different zones; those are the candidates you must identify.\n\n' +

    `━━━ CONTRACTOR ORPHANS (items with no adjuster counterpart in their home zone) ━━━\n` +
    `${contractorBlock}\n\n` +

    `━━━ ADJUSTER ORPHANS (items with no contractor counterpart in their home zone) ━━━\n` +
    `${adjusterBlock}\n\n` +

    `━━━ HOW TO DECIDE A CROSS-ZONE PAIR ━━━\n\n` +

    `For each potential pair, weigh ALL of these signals and form a confidence score 0–100:\n\n` +

    `1. DESCRIPTION SEMANTIC MATCH (highest weight)\n` +
    `   - The two descriptions must describe the same physical work, not just superficially similar trades.\n` +
    `   - Common synonyms are valid: "Tear out" / "Demo" / "Strip" / "Remove" all denote demolition. ` +
    `"R&R" = "Remove & replace". "Detach & reset" ≈ "R&R" for fixtures. "ACT" = "acoustical ceiling tile".\n` +
    `   - Different work types must NEVER pair. "Demo wet ACT" must not pair with "Replace ACT" — ` +
    `one is demolition, the other is installation. "Paint walls" must not pair with "Patch drywall."\n` +
    `   - Quality / grade variants are acceptable matches: "satin" ↔ "eggshell", "standard grade" ↔ "economy grade".\n\n` +

    `2. QUANTITY + UNIT MATCH (moderate weight)\n` +
    `   - Identical quantity with the same unit is a strong positive signal.\n` +
    `   - Different units (SF vs LF) is a strong negative signal — usually different work.\n` +
    `   - Different quantities with the SAME unit are NORMAL in cross-zone reconciliation. The\n` +
    `     contractor and adjuster frequently disagree on how much demolition / dumpster capacity /\n` +
    `     debris-hauling load count was actually required. A 25-50% quantity difference between\n` +
    `     two items that otherwise describe the same trade and unit is a textbook MOD-QTY pair,\n` +
    `     not a reason to refuse pairing. Pair them and let the downstream classifier mark them MODIFIED.\n\n` +

    `3. TOTAL COST MATCH (high weight)\n` +
    `   - Totals within 1% of each other reinforce a match.\n` +
    `   - Totals differing significantly do NOT veto a pair (legitimate pricing disputes are common ` +
    `in insurance estimates) — but they do reduce confidence.\n\n` +

    `4. ZONE PROXIMITY (moderate weight)\n` +
    `   - A contractor item from "Lobby" pairing with an adjuster item from "Demolition & Debris Hauling" ` +
    `is a believable structural-mismatch pattern when the descriptions clearly describe demolition work.\n` +
    `   - A contractor item from "Roof" pairing with an adjuster item from a kitchen-related zone is ` +
    `implausible — flag heavy doubt.\n` +
    `   - Trade-bundling zones on the adjuster side ("Demolition", "General Conditions", "Carpentry") ` +
    `are common cross-zone pairing destinations.\n\n` +

    `5. ONE-TO-ONE PAIRING ENFORCEMENT (constraint)\n` +
    `   - Each contractor orphan can be paired with at most ONE adjuster orphan, and vice versa.\n` +
    `   - If two contractor items both look like the same adjuster item, choose the BEST single pair ` +
    `and leave the other contractor item unpaired.\n\n` +

    `━━━ DECISION POLICY ━━━\n\n` +

    `- If your confidence is < 75, DO NOT pair. Return the items as unpaired.\n` +
    `- Pair when description + unit + (quantity OR total) signals coherently point to the same work.\n` +
    `- A pairing must be defensible on description AND (quantity OR total). Description alone is never sufficient.\n` +
    `- Identical descriptions with vastly different totals AND different units = different work. Do not pair.\n` +
    `- Examples of pairs you SHOULD propose (the residual cases this pass exists for):\n` +
    `    • "Haul debris - per dump truck load" qty 8 EA $4,656 vs "Construction debris hauling per truck load" qty 6 EA $3,492\n` +
    `      → same trade, same unit, different quantity → PAIR as MOD-QTY (~confidence 88).\n` +
    `    • "Dumpster - 30 yard, commercial" qty 6 EA $4,212 vs "30 yard commercial dumpster" qty 5 EA $3,510\n` +
    `      → same item, different quantity → PAIR as MOD-QTY (~confidence 90).\n` +
    `    • "Tear off composition shingles" $372 vs "Strip 3-tab composition shingles" $372\n` +
    `      → same demolition work, identical total → PAIR (note: this case is normally caught by the\n` +
    `      upstream prematch and would not appear in your input).\n` +
    `- When uncertain whether items represent the same work or two different lines of similar work, ` +
    `default to leaving them unpaired.\n\n` +

    `━━━ STEP 2: CLASSIFY ACCEPTED PAIRS ━━━\n\n` +

    `For each pair you accept:\n` +
    `- If quantity AND unit AND total match within 1% → status: "MATCH"\n` +
    `- Otherwise → status: "MODIFIED"\n\n` +

    `(The orchestrator may override this classification deterministically after parsing — your judgment ` +
    `on PAIRING is what matters most.)\n\n` +

    `━━━ OUTPUT FORMAT ━━━\n\n` +

    `Return this exact JSON — nothing else:\n` +
    `{\n` +
    `  "pairs": [\n` +
    `    {\n` +
    `      "contractorId": "C3",\n` +
    `      "adjusterId": "A7",\n` +
    `      "confidence": 92,\n` +
    `      "status": "MATCH",\n` +
    `      "rationale": "Both describe demolition of wet acoustical ceiling tiles, identical 320 SF qty, totals match within $0.50."\n` +
    `    }\n` +
    `  ]\n` +
    `}\n\n` +

    `Items not appearing in \`pairs\` remain unpaired. If you accept zero cross-zone pairings, return ` +
    `{"pairs": []}. This is a valid and expected outcome for many comparisons.`;

  return { system, user };
}
