/**
 * Zone Reconciliation — AI-powered zone matching between two Xactimate estimates.
 *
 * Sends the two lists of detected zone names to Claude and receives back
 * 1:1 zone pairings with confidence scores.  Zones with confidence ≥ 75%
 * are considered matched; lower-confidence or unmatched zones are kept
 * separate in the UI.
 *
 * This module does NOT touch the regex-based zone *detection* in
 * deterministic-prematch.ts.  It only handles the *semantic matching*
 * of already-detected zone names across the two PDFs.
 */

import { traceStep } from '@/lib/debug-trace';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ZONE_CONFIDENCE_THRESHOLD = 75;

// ── Types ────────────────────────────────────────────────────────────────────

export type ZonePair = {
  yours: string;
  adjuster: string;
  canonical: string;
  confidence: number;
};

export type ZoneReconciliationResult = {
  /** Matched zone pairs (confidence ≥ threshold) */
  pairs: ZonePair[];
  /** Your-side zones that could not be confidently matched */
  unmatchedYours: string[];
  /** Adjuster-side zones that could not be confidently matched */
  unmatchedAdjuster: string[];
  /** Full mapping: raw zone name → canonical zone name */
  zoneMap: Map<string, { canonical: string; confidence: number }>;
  /** True if the reconciliation was skipped (e.g. one side had no zones) */
  skipped: boolean;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function getAnthropicApiKey(): string | null {
  const key = process.env.ANTHROPIC_API_KEY;
  return key && key.trim().length > 0 ? key : null;
}

const ZONE_RECONCILIATION_MODEL = 'claude-sonnet-4-6';

function extractJsonFromText(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) return text.slice(start, end + 1);

  return text.trim();
}

// ── Deterministic pre-dedup ──────────────────────────────────────────────────
//
// Haiku frequently simplifies zone names (drops floor prefixes, truncates,
// uses synonyms).  This function merges obvious duplicates on each side
// BEFORE the AI call, using purely structural rules — no word lists needed.

type ZoneWithCount = { name: string; count: number };

/**
 * Rough English stemmer: strip common suffixes so "Roofing" → "roof",
 * "Administrative" → "administr", etc.  Only used for fuzzy comparison.
 */
function roughStem(word: string): string {
  let w = word.toLowerCase();
  // Order matters: strip longer suffixes first
  for (const suffix of ['ative', 'tion', 'sion', 'ment', 'ness', 'able', 'ible', 'ling', 'ical', 'ing', 'ous', 'ive', 'ful', 'ial', 'al', 'ed', 'er', 'ly']) {
    if (w.length > suffix.length + 2 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w;
}

/**
 * Extract all numbers from a string. "2nd Floor - Office Suite 201" → [2, 201]
 */
function extractNumbers(s: string): number[] {
  return (s.match(/\d+/g) ?? []).map(Number);
}

/**
 * Normalize a zone name for comparison: lowercase, collapse whitespace,
 * strip punctuation like / - ( ), trim.
 */
function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/[\/\-\(\)]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Check if two sets of numbers are compatible.
 * Compatible means: no conflicting numbers.
 * "Suite 1" (nums=[1]) vs "Suite 201" (nums=[201]) → compatible (1 is a simplification of 201)
 * "Restroom 1" (nums=[1]) vs "Restroom 2" (nums=[2]) → NOT compatible (different rooms)
 */
function numbersCompatible(shortNums: number[], longNums: number[]): boolean {
  if (shortNums.length === 0) return true; // no numbers in short → always fine
  
  // For each number in the short name, check it has a plausible match in the long name
  for (const sn of shortNums) {
    const hasMatch = longNums.some(ln => {
      if (sn === ln) return true;
      // "1" matches "201" — the short number appears as a trailing digit
      if (String(ln).endsWith(String(sn))) return true;
      return false;
    });
    if (!hasMatch) return false;
  }
  return true;
}

/**
 * Check if shortName is a simplified version of longName using multiple strategies.
 */
function isSimplifiedVersion(shortName: string, longName: string): boolean {
  if (shortName === longName) return false; // identical, not a simplification
  
  const shortNorm = normalizeForCompare(shortName);
  const longNorm = normalizeForCompare(longName);
  
  // Strategy 1: Direct substring — "Common Lobby" inside "1st Floor  Common Lobby"
  if (longNorm.includes(shortNorm)) return true;
  
  // Strategy 2: Strip numbers from both and check substring, then verify numbers are compatible
  const shortNoNums = shortNorm.replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
  const longNoNums = longNorm.replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
  
  if (shortNoNums.length >= 3 && longNoNums.includes(shortNoNums)) {
    const shortNums = extractNumbers(shortName);
    const longNums = extractNumbers(longName);
    if (numbersCompatible(shortNums, longNums)) return true;
  }
  
  // Strategy 3: Stem-based word overlap — "Roofing" and "Roof System"
  // All stems in the short name must appear in the long name's stems
  const shortWords = shortNorm.split(/\s+/).filter(w => w.length > 2);
  const longWords = longNorm.split(/\s+/).filter(w => w.length > 2);
  const longStems = new Set(longWords.map(roughStem));
  
  if (shortWords.length > 0) {
    const allStemsMatch = shortWords.every(sw => longStems.has(roughStem(sw)));
    if (allStemsMatch) {
      // Verify numbers are still compatible
      const shortNums = extractNumbers(shortName);
      const longNums = extractNumbers(longName);
      if (numbersCompatible(shortNums, longNums)) return true;
    }
  }
  
  return false;
}

/**
 * Deduplicate zone names on ONE side. Returns a map from original name → canonical (longer) name.
 * Only merges zones where the shorter is clearly a simplified version of the longer.
 */
function deduplicateOneSide(zones: ZoneWithCount[]): Map<string, string> {
  const mergeMap = new Map<string, string>(); // original → canonical
  
  // Sort by name length descending so longer names come first
  const sorted = [...zones].sort((a, b) => b.name.length - a.name.length);
  
  // Track which zones have been absorbed into another
  const absorbed = new Set<string>();
  
  for (let i = 0; i < sorted.length; i++) {
    if (absorbed.has(sorted[i].name)) continue;
    
    for (let j = i + 1; j < sorted.length; j++) {
      if (absorbed.has(sorted[j].name)) continue;
      
      const longer = sorted[i].name;
      const shorter = sorted[j].name;
      
      if (isSimplifiedVersion(shorter, longer)) {
        mergeMap.set(shorter, longer);
        absorbed.add(shorter);
      }
    }
  }
  
  return mergeMap;
}

/**
 * Pre-deduplicate zone names from Haiku extraction on both sides.
 * Returns the merge maps and applies them to the zone-with-count arrays.
 *
 * Call this AFTER Haiku extraction, BEFORE zone reconciliation.
 */
export function preDeduplicateZones(
  yourZones: ZoneWithCount[],
  adjZones: ZoneWithCount[]
): {
  yourDeduped: ZoneWithCount[];
  adjDeduped: ZoneWithCount[];
  yourMergeMap: Map<string, string>;
  adjMergeMap: Map<string, string>;
} {
  const yourMergeMap = deduplicateOneSide(yourZones);
  const adjMergeMap = deduplicateOneSide(adjZones);
  
  // Merge counts into canonical zones
  function applyMerge(zones: ZoneWithCount[], mergeMap: Map<string, string>): ZoneWithCount[] {
    const countMap = new Map<string, number>();
    for (const z of zones) {
      const canonical = mergeMap.get(z.name) ?? z.name;
      countMap.set(canonical, (countMap.get(canonical) ?? 0) + z.count);
    }
    return [...countMap.entries()].map(([name, count]) => ({ name, count }));
  }
  
  return {
    yourDeduped: applyMerge(yourZones, yourMergeMap),
    adjDeduped: applyMerge(adjZones, adjMergeMap),
    yourMergeMap,
    adjMergeMap,
  };
}

// ── Prompt ───────────────────────────────────────────────────────────────────

function buildZoneReconciliationPrompt(
  yourZones: ZoneWithCount[],
  adjusterZones: ZoneWithCount[]
): { system: string; user: string } {
  const system = [
    'You are an expert at matching room/zone names from two Xactimate insurance estimates for the SAME property.',
    '',
    'PROBLEM: Zone names were extracted by AI and it FREQUENTLY SIMPLIFIES names. The simplified version is ALWAYS shorter/simpler than the real PDF header. Specific patterns:',
    '- DROPS FLOOR PREFIXES: "Common Lobby" is a simplified version of "1st Floor - Common Lobby"',
    '- TRUNCATES NAMES: "Exterior" is a simplified version of "Exterior Envelope"',
    '- TRUNCATES SUFFIXES: "General" is a simplified version of "General / Administrative"',
    '- RENAMES WITH SIMPLER LABELS: "Office Suite 1" is a simplified version of "2nd Floor - Office Suite 201"',
    '- SWAPS SYNONYMS: "Roofing" is a simplified version of "Roof System"',
    '- REWORDS: "Parking/Site" is a simplified version of "Site Work / Parking"',
    '',
    'This means the SAME estimate can have BOTH "Common Lobby" (simplified) AND "1st Floor - Common Lobby" (correct) — these are the SAME ROOM and MUST be grouped together.',
    '',
    'YOUR JOB: Group ALL zone names (from BOTH estimates) that refer to the same physical room/area.',
    '',
    '═══ STEP 1: WITHIN-SIDE DEDUP ═══',
    'For EACH estimate separately, look for zone names that are simplified versions of other zone names in the SAME estimate.',
    'If a short name looks like a simplified version of a longer name on the same side, they are the SAME ROOM.',
    'Example: Estimate A has "Common Lobby" (21 items) and "1st Floor - Common Lobby" (3 items) → SAME ROOM.',
    'Clue: The simplified version often has MORE items (the AI used the wrong name more often).',
    '',
    '═══ STEP 2: CROSS-SIDE MATCHING ═══',
    'After dedup, match rooms across the two estimates. Same logic: if names share key words, they are likely the same room.',
    'Example: "Roof System" (Estimate A) and "Roofing" (Estimate B) → SAME ROOM.',
    '',
    '═══ RULES ═══',
    '1. NUMBERS ARE SACRED: "Restroom 1" ≠ "Restroom 2". "Suite 201" ≠ "Suite 202". "Floor 1" ≠ "Floor 2". NEVER merge zones with different numbers. But "Office Suite 1" CAN match "Office Suite 201" (simplified number).',
    '2. CANONICAL NAME = THE LONGEST, MOST SPECIFIC VERSION. Always pick the most complete name with floor prefix if one exists. "1st Floor - Common Lobby" beats "Common Lobby". "Exterior Envelope" beats "Exterior". "General / Administrative" beats "General".',
    '3. CONFIDENCE: 100 = identical, 95 = obvious prefix/suffix variant, 90 = clear synonym, 80 = likely match, <75 = uncertain.',
    '4. EVERY input zone name must appear in exactly one group. No zone left behind.',
    '5. DO NOT force unrelated zones together. An unmatched zone is better than a wrong grouping.',
    '',
    'OUTPUT FORMAT (JSON only, no commentary):',
    '{',
    '  "groups": [',
    '    {',
    '      "canonical": "longest most specific name for this room",',
    '      "yours": ["all Estimate A zone names for this room"],',
    '      "adjuster": ["all Estimate B zone names for this room"],',
    '      "confidence": 95',
    '    }',
    '  ]',
    '}',
  ].join('\n');

  const user = [
    'Group these zone names into canonical rooms. Pay close attention to within-side duplicates — shorter names are likely simplified versions of longer names on the same side.',
    '',
    `Estimate A (Contractor) — ${yourZones.length} zone names:`,
    ...yourZones.map((z, i) => `  ${i + 1}. "${z.name}" (${z.count} items)`),
    '',
    `Estimate B (Adjuster) — ${adjusterZones.length} zone names:`,
    ...adjusterZones.map((z, i) => `  ${i + 1}. "${z.name}" (${z.count} items)`),
  ].join('\n');

  return { system, user };
}

// ── API call ─────────────────────────────────────────────────────────────────

async function callClaudeForZoneReconciliation(
  yourZones: ZoneWithCount[],
  adjusterZones: ZoneWithCount[],
  comparisonId: string
): Promise<ZoneReconciliationResult> {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured.');

  const yourNames = yourZones.map((z) => z.name);
  const adjNames = adjusterZones.map((z) => z.name);

  const { system, user } = buildZoneReconciliationPrompt(yourZones, adjusterZones);

  traceStep(comparisonId, 'SONNET 1 (ZONE RECONCILIATION) — INPUT', `SYSTEM PROMPT:\n${system}\n\nUSER PROMPT:\n${user}`);

  const startMs = Date.now();
  console.log(
    `[comparison:${comparisonId}] Zone reconciliation: ${yourZones.length} yours + ${adjusterZones.length} adjuster zones → Sonnet.`
  );

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ZONE_RECONCILIATION_MODEL,
      max_tokens: 2048,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Zone reconciliation API call failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const payload = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };

  const rawText = (payload.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');

  traceStep(comparisonId, 'SONNET 1 (ZONE RECONCILIATION) — RAW RESPONSE', rawText);

  const elapsedMs = Date.now() - startMs;
  console.log(
    `[comparison:${comparisonId}] Zone reconciliation completed in ${elapsedMs}ms.`
  );

  const jsonStr = extractJsonFromText(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    console.warn(
      `[comparison:${comparisonId}] Zone reconciliation response was not valid JSON. Raw: ${rawText.slice(0, 300)}`
    );
    return buildFallbackResult(yourNames, adjNames);
  }

  return parseGroupedResponse(parsed, yourNames, adjNames, comparisonId);
}

// ── Response parsing (groups format) ─────────────────────────────────────────

type RawGroup = {
  canonical?: string;
  yours?: string[];
  adjuster?: string[];
  confidence?: number;
};

function parseGroupedResponse(
  parsed: unknown,
  yourZones: string[],
  adjusterZones: string[],
  comparisonId: string
): ZoneReconciliationResult {
  if (!parsed || typeof parsed !== 'object') {
    return buildFallbackResult(yourZones, adjusterZones);
  }

  // Support both new "groups" format and legacy "pairs" format
  const data = parsed as { groups?: unknown[]; pairs?: unknown[] };
  const rawGroups: RawGroup[] = [];

  if (Array.isArray(data.groups)) {
    for (const g of data.groups) {
      if (!g || typeof g !== 'object') continue;
      rawGroups.push(g as RawGroup);
    }
  } else if (Array.isArray(data.pairs)) {
    // Legacy format fallback: convert pairs to groups
    for (const p of data.pairs) {
      if (!p || typeof p !== 'object') continue;
      const lp = p as { yours?: string; adjuster?: string; canonical?: string; confidence?: number };
      rawGroups.push({
        canonical: lp.canonical,
        yours: lp.yours ? [lp.yours] : [],
        adjuster: lp.adjuster ? [lp.adjuster] : [],
        confidence: lp.confidence,
      });
    }
  }

  const zoneMap = new Map<string, { canonical: string; confidence: number }>();
  const pairs: ZonePair[] = [];
  const mappedYours = new Set<string>();
  const mappedAdjuster = new Set<string>();

  for (const g of rawGroups) {
    const canonical = typeof g.canonical === 'string' ? g.canonical.trim() : '';
    if (!canonical) continue;

    const confidence = typeof g.confidence === 'number' ? Math.round(g.confidence) : 0;
    if (confidence < ZONE_CONFIDENCE_THRESHOLD) continue;

    const yNames = Array.isArray(g.yours) ? g.yours.filter((s): s is string => typeof s === 'string').map(s => s.trim()) : [];
    const aNames = Array.isArray(g.adjuster) ? g.adjuster.filter((s): s is string => typeof s === 'string').map(s => s.trim()) : [];

    if (yNames.length === 0 && aNames.length === 0) continue;

    // Map every variant name to the canonical name
    for (const y of yNames) {
      if (y && !mappedYours.has(y.toLowerCase())) {
        mappedYours.add(y.toLowerCase());
        zoneMap.set(y.toLowerCase(), { canonical, confidence });
      }
    }
    for (const a of aNames) {
      if (a && !mappedAdjuster.has(a.toLowerCase())) {
        mappedAdjuster.add(a.toLowerCase());
        zoneMap.set(a.toLowerCase(), { canonical, confidence });
      }
    }

    // Build pairs for backward compatibility (use first name from each side)
    if (yNames.length > 0 && aNames.length > 0) {
      pairs.push({ yours: yNames[0]!, adjuster: aNames[0]!, canonical, confidence });
    }
  }

  // Collect unmatched zones (anything the AI missed)
  const unmatchedYours: string[] = [];
  const unmatchedAdjuster: string[] = [];

  for (const z of yourZones) {
    if (!mappedYours.has(z.toLowerCase())) {
      unmatchedYours.push(z);
      zoneMap.set(z.toLowerCase(), { canonical: z, confidence: 0 });
    }
  }

  for (const z of adjusterZones) {
    if (!mappedAdjuster.has(z.toLowerCase())) {
      unmatchedAdjuster.push(z);
      zoneMap.set(z.toLowerCase(), { canonical: z, confidence: 0 });
    }
  }

  console.log(
    `[comparison:${comparisonId}] Zone reconciliation result: ${pairs.length} cross-side pairs, ` +
      `${zoneMap.size} total mappings, ${unmatchedYours.length} unmatched yours, ${unmatchedAdjuster.length} unmatched adjuster.`
  );

  return { pairs, unmatchedYours, unmatchedAdjuster, zoneMap, skipped: false };
}

// ── Fallback (no AI, exact-match only) ───────────────────────────────────────

function buildFallbackResult(
  yourZones: string[],
  adjusterZones: string[]
): ZoneReconciliationResult {
  const zoneMap = new Map<string, { canonical: string; confidence: number }>();
  const pairs: ZonePair[] = [];
  const usedAdjuster = new Set<string>();

  // Exact case-insensitive matching as fallback
  for (const yz of yourZones) {
    const match = adjusterZones.find(
      (az) => az.toLowerCase() === yz.toLowerCase() && !usedAdjuster.has(az.toLowerCase())
    );
    if (match) {
      const canonical = yz; // prefer yours name
      pairs.push({ yours: yz, adjuster: match, canonical, confidence: 100 });
      usedAdjuster.add(match.toLowerCase());
      zoneMap.set(yz.toLowerCase(), { canonical, confidence: 100 });
      zoneMap.set(match.toLowerCase(), { canonical, confidence: 100 });
    }
  }

  const unmatchedYours = yourZones.filter(
    (z) => !pairs.some((p) => p.yours.toLowerCase() === z.toLowerCase())
  );
  const unmatchedAdjuster = adjusterZones.filter(
    (z) => !usedAdjuster.has(z.toLowerCase())
  );

  for (const z of unmatchedYours) {
    zoneMap.set(z.toLowerCase(), { canonical: z, confidence: 0 });
  }
  for (const z of unmatchedAdjuster) {
    zoneMap.set(z.toLowerCase(), { canonical: z, confidence: 0 });
  }

  return { pairs, unmatchedYours, unmatchedAdjuster, zoneMap, skipped: false };
}

// ── Public API ───────────────────────────────────────────────────────────────

const UNZONED_KEY = '__unzoned__';

/**
 * Reconcile zone names between two Xactimate estimates.
 *
 * Edge cases handled:
 * - Both sides have zones → full AI reconciliation
 * - One side has no zones → skip reconciliation, zones inherited from paired items later
 * - Neither side has zones → skip, everything goes to "General"
 */
export async function reconcileZones(
  yourZones: string[] | ZoneWithCount[],
  adjusterZones: string[] | ZoneWithCount[],
  comparisonId: string
): Promise<ZoneReconciliationResult> {
  // Normalize input: accept both string[] and ZoneWithCount[]
  const yourWithCounts: ZoneWithCount[] = yourZones.map((z) =>
    typeof z === 'string' ? { name: z, count: 0 } : z
  );
  const adjWithCounts: ZoneWithCount[] = adjusterZones.map((z) =>
    typeof z === 'string' ? { name: z, count: 0 } : z
  );

  // Filter out __UNZONED__ — it's a catch-all, not a real zone
  const yourReal = yourWithCounts.filter((z) => z.name.toLowerCase() !== UNZONED_KEY);
  const adjReal = adjWithCounts.filter((z) => z.name.toLowerCase() !== UNZONED_KEY);

  const yourRealNames = yourReal.map((z) => z.name);
  const adjRealNames = adjReal.map((z) => z.name);

  // Edge case: neither side has zones
  if (yourReal.length === 0 && adjReal.length === 0) {
    console.log(`[comparison:${comparisonId}] Zone reconciliation skipped — no zones detected on either side.`);
    return {
      pairs: [],
      unmatchedYours: [],
      unmatchedAdjuster: [],
      zoneMap: new Map(),
      skipped: true,
    };
  }

  // Edge case: one side has no zones
  if (yourReal.length === 0 || adjReal.length === 0) {
    const hasZones = yourReal.length > 0 ? 'yours' : 'adjuster';
    console.log(
      `[comparison:${comparisonId}] Zone reconciliation skipped — only ${hasZones} side has zones. Zones will be inherited from paired items.`
    );
    const zoneMap = new Map<string, { canonical: string; confidence: number }>();
    const allZoneNames = yourReal.length > 0 ? yourRealNames : adjRealNames;
    for (const z of allZoneNames) {
      zoneMap.set(z.toLowerCase(), { canonical: z, confidence: 100 });
    }
    return {
      pairs: [],
      unmatchedYours: yourReal.length > 0 ? yourRealNames : [],
      unmatchedAdjuster: adjReal.length > 0 ? adjRealNames : [],
      zoneMap,
      skipped: true,
    };
  }

  // Happy path: both sides have zones
  return callClaudeForZoneReconciliation(yourReal, adjReal, comparisonId);
}

/**
 * Resolve the canonical zone name for a line item using the reconciliation map.
 *
 * Priority:
 * 1. Look up zoneYours in the map
 * 2. Look up zoneAdjuster in the map
 * 3. Fall back to raw zone name
 * 4. "Unzoned" if nothing
 */
export function resolveCanonicalZone(
  zoneYours: string | null,
  zoneAdjuster: string | null,
  zoneMap: Map<string, { canonical: string; confidence: number }>
): { canonical: string; confidence: number } {
  if (zoneYours && zoneYours.toLowerCase() !== UNZONED_KEY) {
    const entry = zoneMap.get(zoneYours.toLowerCase());
    if (entry) return entry;
  }

  if (zoneAdjuster && zoneAdjuster.toLowerCase() !== UNZONED_KEY) {
    const entry = zoneMap.get(zoneAdjuster.toLowerCase());
    if (entry) return entry;
  }

  // Fall back to raw name
  const rawName = zoneYours ?? zoneAdjuster ?? null;
  if (rawName && rawName.toLowerCase() !== UNZONED_KEY) {
    return { canonical: rawName, confidence: 0 };
  }

  return { canonical: 'Unzoned', confidence: 0 };
}

export { ZONE_CONFIDENCE_THRESHOLD };
export type { ZoneWithCount };
