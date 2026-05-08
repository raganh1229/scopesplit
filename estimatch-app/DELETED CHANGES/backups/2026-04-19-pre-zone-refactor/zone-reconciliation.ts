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

function getAnthropicModel(): string {
  const model = process.env.ANTHROPIC_MODEL;
  if (!model || model.trim().length === 0) return 'claude-sonnet-4-6';
  return model.trim();
}

function extractJsonFromText(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) return text.slice(start, end + 1);

  return text.trim();
}

// ── Prompt ───────────────────────────────────────────────────────────────────

function buildZoneReconciliationPrompt(
  yourZones: string[],
  adjusterZones: string[]
): { system: string; user: string } {
  const system = [
    'You are an expert at matching room/zone names from two independent Xactimate insurance estimates for the SAME property.',
    '',
    'RULES:',
    '1. BEST 1:1 MATCH: Each zone on one side can match at most one zone on the other side. Pick the match you are MOST confident in, even if other candidates exist.',
    '2. NUMBERED ROOMS ARE DISTINCT: "Bedroom 1", "Bedroom 2", "Bedroom 3" are different physical rooms. Match by number — never merge them.',
    '3. SYNONYMS: "Master Bedroom" = "Primary Suite" = "Primary Bedroom". "Hall Bath" = "Hallway Bathroom". "Living Area" = "Living Room" = "Family Room" (sometimes). Use your domain knowledge.',
    '4. CANONICAL NAME: For each pair, choose the clearest, most common name for that room. Prefer the name that a homeowner would understand.',
    '5. CONFIDENCE: Return a confidence score 0-100 for each pair. 100 = identical names, 90+ = obvious synonym, 75-89 = likely match with some ambiguity, <75 = uncertain.',
    '6. DO NOT FORCE BAD MATCHES: If a zone has no reasonable counterpart, leave it unmatched. An unmatched zone is better than a wrong match.',
    '7. GENERAL / GENERAL ITEMS: These are catch-all zones. "General" and "General Items" on opposite sides should match with high confidence.',
    '',
    'OUTPUT FORMAT (JSON only, no commentary):',
    '{',
    '  "pairs": [',
    '    { "yours": "exact zone name from list A", "adjuster": "exact zone name from list B", "canonical": "clean display name", "confidence": 95 }',
    '  ],',
    '  "unmatchedYours": ["zone names from A with no match"],',
    '  "unmatchedAdjuster": ["zone names from B with no match"]',
    '}',
  ].join('\n');

  const user = [
    'Match the zones between these two estimates for the same property.',
    '',
    `Estimate A (Contractor) zones:\n${yourZones.map((z, i) => `  ${i + 1}. ${z}`).join('\n')}`,
    '',
    `Estimate B (Adjuster) zones:\n${adjusterZones.map((z, i) => `  ${i + 1}. ${z}`).join('\n')}`,
  ].join('\n');

  return { system, user };
}

// ── API call ─────────────────────────────────────────────────────────────────

async function callClaudeForZoneReconciliation(
  yourZones: string[],
  adjusterZones: string[],
  comparisonId: string
): Promise<ZoneReconciliationResult> {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured.');

  const { system, user } = buildZoneReconciliationPrompt(yourZones, adjusterZones);

  const startMs = Date.now();
  console.log(
    `[comparison:${comparisonId}] Zone reconciliation: ${yourZones.length} yours + ${adjusterZones.length} adjuster zones → Claude.`
  );

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: getAnthropicModel(),
      max_tokens: 1024,
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
    return buildFallbackResult(yourZones, adjusterZones);
  }

  return parseReconciliationResponse(parsed, yourZones, adjusterZones, comparisonId);
}

// ── Response parsing ─────────────────────────────────────────────────────────

function parseReconciliationResponse(
  parsed: unknown,
  yourZones: string[],
  adjusterZones: string[],
  comparisonId: string
): ZoneReconciliationResult {
  if (!parsed || typeof parsed !== 'object') {
    return buildFallbackResult(yourZones, adjusterZones);
  }

  const data = parsed as {
    pairs?: unknown[];
    unmatchedYours?: string[];
    unmatchedAdjuster?: string[];
  };

  const zoneMap = new Map<string, { canonical: string; confidence: number }>();
  const pairs: ZonePair[] = [];
  const usedYours = new Set<string>();
  const usedAdjuster = new Set<string>();

  if (Array.isArray(data.pairs)) {
    for (const raw of data.pairs) {
      if (!raw || typeof raw !== 'object') continue;
      const p = raw as { yours?: string; adjuster?: string; canonical?: string; confidence?: number };

      const yours = typeof p.yours === 'string' ? p.yours.trim() : '';
      const adjuster = typeof p.adjuster === 'string' ? p.adjuster.trim() : '';
      const canonical = typeof p.canonical === 'string' ? p.canonical.trim() : yours || adjuster;
      const confidence = typeof p.confidence === 'number' ? Math.round(p.confidence) : 0;

      if (!yours && !adjuster) continue;

      // Enforce 1:1
      if (yours && usedYours.has(yours.toLowerCase())) continue;
      if (adjuster && usedAdjuster.has(adjuster.toLowerCase())) continue;

      if (confidence >= ZONE_CONFIDENCE_THRESHOLD) {
        pairs.push({ yours, adjuster, canonical, confidence });
        if (yours) {
          usedYours.add(yours.toLowerCase());
          zoneMap.set(yours.toLowerCase(), { canonical, confidence });
        }
        if (adjuster) {
          usedAdjuster.add(adjuster.toLowerCase());
          zoneMap.set(adjuster.toLowerCase(), { canonical, confidence });
        }
      }
    }
  }

  // Collect unmatched zones (from AI response + anything the AI missed)
  const unmatchedYours: string[] = [];
  const unmatchedAdjuster: string[] = [];

  for (const z of yourZones) {
    if (!usedYours.has(z.toLowerCase())) {
      unmatchedYours.push(z);
      // Unmatched zones get themselves as canonical
      zoneMap.set(z.toLowerCase(), { canonical: z, confidence: 0 });
    }
  }

  for (const z of adjusterZones) {
    if (!usedAdjuster.has(z.toLowerCase())) {
      unmatchedAdjuster.push(z);
      zoneMap.set(z.toLowerCase(), { canonical: z, confidence: 0 });
    }
  }

  console.log(
    `[comparison:${comparisonId}] Zone reconciliation result: ${pairs.length} matched pairs, ${unmatchedYours.length} unmatched yours, ${unmatchedAdjuster.length} unmatched adjuster.`
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
  yourZones: string[],
  adjusterZones: string[],
  comparisonId: string
): Promise<ZoneReconciliationResult> {
  // Filter out __UNZONED__ — it's a catch-all, not a real zone
  const yourReal = yourZones.filter((z) => z.toLowerCase() !== UNZONED_KEY);
  const adjReal = adjusterZones.filter((z) => z.toLowerCase() !== UNZONED_KEY);

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
    const allZones = yourReal.length > 0 ? yourReal : adjReal;
    for (const z of allZones) {
      zoneMap.set(z.toLowerCase(), { canonical: z, confidence: 100 });
    }
    return {
      pairs: [],
      unmatchedYours: yourReal.length > 0 ? yourReal : [],
      unmatchedAdjuster: adjReal.length > 0 ? adjReal : [],
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
