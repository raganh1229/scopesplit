// ─────────────────────────────────────────────────────────────────────────────
// N2 Pipeline — Step 3: match-zones
//
// Single Sonnet call. Reads zones_corrected (falls back to zones_detected),
// sends both zone lists as text to the model, parses the matched-pair JSON,
// builds the n2:zones_matched payload (including carry-forward zone slice
// metadata), and writes state.
//
// On completion the Inngest step flips comparison.status →
// AWAITING_MATCH_REVIEW so the user can review / adjust pairings before
// extraction begins.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { buildMatchZonesPrompt } from '@/lib/n2/prompts/match-zones';
import {
  readZonesCorrected,
  readZonesDetected,
  writeN2Stage,
  N2_STAGE_ZONES_MATCHED,
} from '@/lib/n2/utils/n2-state';
import { zoneKey } from '@/lib/n2/schemas/types';
import type {
  N2DetectedZone,
  N2ZonesMatchedPayload,
  N2ZoneSliceInfo,
} from '@/lib/n2/schemas/types';
import type { StepLogger } from '@/lib/n2/passes/detect-zones';

// ── Constants ──────────────────────────────────────────────────────────────

const MATCH_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MATCH_MAX_TOKENS = 4096;

// ── Zod schema for raw AI response ────────────────────────────────────────

const ZoneRefRawSchema = z.object({
  zone: z.string().min(1),
  pages: z.tuple([z.number().int(), z.number().int()]),
});

const MatchedPairRawSchema = z.object({
  e1Zones: z.array(ZoneRefRawSchema).min(1),
  e2Zones: z.array(ZoneRefRawSchema).min(1),
  canonical: z.string().min(1),
  isMerged: z.boolean(),
  confidence: z.number().int().min(50).max(100),
});

const MatchZonesResponseSchema = z.object({
  matched: z.array(MatchedPairRawSchema),
  unmatchedE1: z.array(ZoneRefRawSchema),
  unmatchedE2: z.array(ZoneRefRawSchema),
});

type MatchZonesResponse = z.infer<typeof MatchZonesResponseSchema>;

// ── Helpers ───────────────────────────────────────────────────────────────

function buildZoneMeta(zones: N2DetectedZone[]): Record<string, N2ZoneSliceInfo> {
  const map: Record<string, N2ZoneSliceInfo> = {};
  for (const z of zones) {
    map[zoneKey(z.name, z.startPage)] = {
      startPage: z.startPage,
      endPage: z.endPage,
      approxItems: z.approxItems,
      chunkOffset: z.chunkOffset,
      endPageChunkOffset: z.endPageChunkOffset,
    };
  }
  return map;
}

// ── Main export ───────────────────────────────────────────────────────────

export async function matchZones(
  comparisonId: string,
  logger: StepLogger,
): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('[match-zones] ANTHROPIC_API_KEY not set');

  // ── 1. Read source zones (corrected wins over detected) ─────────────────
  const corrected = await readZonesCorrected(comparisonId);
  const detected = await readZonesDetected(comparisonId);
  const source = corrected ?? detected;

  if (!source) {
    throw new Error(`[match-zones] No zone state found for comparison ${comparisonId}`);
  }

  const { e1Zones, e2Zones, e1Format, e2Format, routingDecision } = source;
  const matchHints = corrected?.matchHints ?? [];
  const confirmedUniqueZones = corrected?.confirmedUniqueZones ?? [];

  logger.info('[match-zones] Starting zone matching', {
    comparisonId,
    e1Count: e1Zones.length,
    e2Count: e2Zones.length,
    hintCount: matchHints.length,
    uniqueCount: confirmedUniqueZones.length,
  });

  // ── 2. Build prompt and call Sonnet ────────────────────────────────────
  const userMessage = buildMatchZonesPrompt(e1Zones, e2Zones, matchHints, confirmedUniqueZones);

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MATCH_MODEL,
      max_tokens: MATCH_MAX_TOKENS,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `[match-zones] Anthropic API error ${response.status}: ${body.slice(0, 300)}`,
    );
  }

  const aiData = (await response.json()) as { content?: { type: string; text: string }[] };
  const rawText = aiData?.content?.find(b => b.type === 'text')?.text ?? '';

  // ── 3. Strip optional markdown fences and parse JSON ──────────────────
  const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  let parsed: MatchZonesResponse;
  try {
    const obj: unknown = JSON.parse(jsonText);
    const result = MatchZonesResponseSchema.safeParse(obj);
    if (!result.success) {
      throw new Error(result.error.message.slice(0, 400));
    }
    parsed = result.data;
  } catch (err) {
    throw new Error(
      `[match-zones] Failed to parse AI response: ${err instanceof Error ? err.message : String(err)}` +
        ` — raw: ${rawText.slice(0, 200)}`,
    );
  }

  // ── 4. Build zones_matched payload ────────────────────────────────────
  const payload: N2ZonesMatchedPayload = {
    matched: parsed.matched.map(p => ({
      e1Zones: p.e1Zones.map(r => ({ zone: r.zone, pages: r.pages as [number, number] })),
      e2Zones: p.e2Zones.map(r => ({ zone: r.zone, pages: r.pages as [number, number] })),
      canonical: p.canonical,
      isMerged: p.isMerged,
      confidence: p.confidence,
    })),
    unmatchedE1: parsed.unmatchedE1.map(r => ({
      zone: r.zone,
      pages: r.pages as [number, number],
    })),
    unmatchedE2: parsed.unmatchedE2.map(r => ({
      zone: r.zone,
      pages: r.pages as [number, number],
    })),
    e1Format,
    e2Format,
    routingDecision,
    e1ZoneMeta: buildZoneMeta(e1Zones),
    e2ZoneMeta: buildZoneMeta(e2Zones),
  };

  // ── 5. Persist state ──────────────────────────────────────────────────
  await writeN2Stage(comparisonId, N2_STAGE_ZONES_MATCHED, payload);

  logger.info('[match-zones] Zone matching complete', {
    comparisonId,
    matchedPairs: payload.matched.length,
    unmatchedE1: payload.unmatchedE1.length,
    unmatchedE2: payload.unmatchedE2.length,
  });
}
