// ─────────────────────────────────────────────────────────────────────────────
// N3 Pipeline — Phase 6: propose-correspondences
//
// Reads N3Zone rows for both sides, calls Sonnet to propose zone
// correspondences, and writes N3ZoneCorrespondence rows to the DB.
//
// Zone correspondences are PRIORS that add a small score boost to candidate
// edges crossing corresponding zone pairs (Phase 13). A wrong correspondence
// is a penalty of ~0.05, not a hard failure — N3 can recover from it.
//
// Algorithm:
//   1. Load n3_zones for this comparison from DB (both sides)
//   2. Assign short keys: Y1…Yn (yours) and A1…Am (adjuster)
//   3. Call Sonnet with the zone list and correspondence prompt
//   4. Parse + validate JSON response
//   5. Map key references back to zone IDs
//   6. Idempotent write: deleteMany existing + createMany new correspondences
//
// Architecture refs: N3.md §14, §16.2 (zone boost as prior, not wall)
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import prisma from '@/lib/prisma';
import { parseAndValidate, withRetry, isTruncated, AIResponseError } from '@/lib/n2/utils/ai-response';
import { buildZoneCorrespondencePrompt } from '@/lib/n3/prompts/zone-correspondence';
import type { StepLogger } from '@/lib/n3/passes/detect-zones';

// ── Constants ─────────────────────────────────────────────────────────────────

const SONNET_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const CORRESPONDENCE_MAX_TOKENS = 1500;

// ── Zod schema for AI response ────────────────────────────────────────────────

const CorrespondenceItemSchema = z.object({
  yourKeys: z.array(z.string().regex(/^Y\d+$/)).min(1),
  adjusterKeys: z.array(z.string().regex(/^A\d+$/)).min(1),
  type: z.enum(['one_to_one', 'one_to_many', 'many_to_one']),
  confidence: z.number().min(0).max(1),
});

const ZoneCorrespondenceResponseSchema = z.object({
  correspondences: z.array(CorrespondenceItemSchema),
  unmatchedYours: z.array(z.string().regex(/^Y\d+$/)),
  unmatchedAdjuster: z.array(z.string().regex(/^A\d+$/)),
});

// ── Return type ───────────────────────────────────────────────────────────────

export type ProposeCorrespondencesN3Result = {
  correspondenceCount: number;
  unmatchedYoursCount: number;
  unmatchedAdjusterCount: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key?.trim()) {
    throw new Error('[n3/propose-correspondences] ANTHROPIC_API_KEY is not configured.');
  }
  return key.trim();
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Propose zone correspondences for both sides and write N3ZoneCorrespondence rows.
 *
 * Idempotent: deletes all existing n3_zone_correspondences for this
 * comparisonId before writing, so Inngest step retries are clean.
 *
 * Throws on unrecoverable error. The calling Inngest step will retry.
 */
export async function proposeCorrespondencesN3(
  comparisonId: string,
  logger: StepLogger,
): Promise<ProposeCorrespondencesN3Result> {
  // ── 1. Load zones from DB ───────────────────────────────────────────────────
  const zones = await prisma.n3Zone.findMany({
    where: { comparisonId },
    select: { id: true, source: true, name: true, startPage: true, endPage: true, approxItems: true },
    orderBy: [{ source: 'asc' }, { startPage: 'asc' }],
  });

  const yoursZones = zones.filter(z => z.source === 'yours');
  const adjZones = zones.filter(z => z.source === 'adjuster');

  if (yoursZones.length === 0 || adjZones.length === 0) {
    logger.warn('[n3/propose-correspondences] One or both sides have no zones — skipping', {
      comparisonId,
      yoursCount: yoursZones.length,
      adjCount: adjZones.length,
    });
    return { correspondenceCount: 0, unmatchedYoursCount: yoursZones.length, unmatchedAdjusterCount: adjZones.length };
  }

  // ── 2. Assign short keys ────────────────────────────────────────────────────
  const yoursInputs = yoursZones.map((z, i) => ({
    key: `Y${i + 1}`,
    name: z.name,
    startPage: z.startPage,
    endPage: z.endPage,
    approxItems: z.approxItems,
  }));

  const adjInputs = adjZones.map((z, i) => ({
    key: `A${i + 1}`,
    name: z.name,
    startPage: z.startPage,
    endPage: z.endPage,
    approxItems: z.approxItems,
  }));

  // Build lookup: key → zone ID
  const yoursKeyToId = new Map(yoursZones.map((z, i) => [`Y${i + 1}`, z.id]));
  const adjKeyToId = new Map(adjZones.map((z, i) => [`A${i + 1}`, z.id]));

  logger.info('[n3/propose-correspondences] Calling Sonnet', {
    comparisonId,
    yoursZones: yoursInputs.length,
    adjZones: adjInputs.length,
  });

  // ── 3. Call Sonnet ──────────────────────────────────────────────────────────
  const context = `${comparisonId}/zone-correspondence`;
  const prompts = buildZoneCorrespondencePrompt({ yoursZones: yoursInputs, adjusterZones: adjInputs });

  const parsed = await withRetry(
    async () => {
      const apiKey = getApiKey();
      const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: SONNET_MODEL,
          max_tokens: CORRESPONDENCE_MAX_TOKENS,
          temperature: 0,
          system: prompts.system,
          messages: [{ role: 'user', content: prompts.user }],
        }),
      });

      if (!response.ok) {
        throw new AIResponseError(
          `[n3/propose-correspondences] Anthropic ${response.status}: ${response.statusText}`,
          response.status >= 500 || response.status === 429,
          context,
        );
      }

      const body = (await response.json()) as {
        content?: Array<{ text?: string }>;
        stop_reason?: string | null;
      };
      const text = body.content?.[0]?.text ?? '';
      const stopReason = body.stop_reason ?? null;

      if (isTruncated(stopReason, text)) {
        throw new AIResponseError(
          `[n3/propose-correspondences] Response truncated — increase max_tokens`,
          true,
          context,
        );
      }

      return parseAndValidate(text, ZoneCorrespondenceResponseSchema, context);
    },
    3,
    context,
  );

  logger.info('[n3/propose-correspondences] Sonnet response parsed', {
    comparisonId,
    correspondences: parsed.correspondences.length,
    unmatchedYours: parsed.unmatchedYours.length,
    unmatchedAdjuster: parsed.unmatchedAdjuster.length,
  });

  // ── 4. Validate key references ──────────────────────────────────────────────
  for (const corr of parsed.correspondences) {
    for (const k of corr.yourKeys) {
      if (!yoursKeyToId.has(k)) {
        throw new Error(`[n3/propose-correspondences] Unknown yours key "${k}" in response`);
      }
    }
    for (const k of corr.adjusterKeys) {
      if (!adjKeyToId.has(k)) {
        throw new Error(`[n3/propose-correspondences] Unknown adjuster key "${k}" in response`);
      }
    }
  }

  // ── 5. Idempotent DB write ──────────────────────────────────────────────────
  await prisma.$transaction(async tx => {
    await tx.n3ZoneCorrespondence.deleteMany({ where: { comparisonId } });

    for (const corr of parsed.correspondences) {
      await tx.n3ZoneCorrespondence.create({
        data: {
          comparisonId,
          correspondenceType: corr.type,
          verificationStatus: 'ai_proposed',
          confidence: corr.confidence,
          yourZones: {
            connect: corr.yourKeys.map(k => ({ id: yoursKeyToId.get(k)! })),
          },
          adjusterZones: {
            connect: corr.adjusterKeys.map(k => ({ id: adjKeyToId.get(k)! })),
          },
        },
      });
    }
  });

  logger.info('[n3/propose-correspondences] n3_zone_correspondences written', {
    comparisonId,
    rows: parsed.correspondences.length,
  });

  return {
    correspondenceCount: parsed.correspondences.length,
    unmatchedYoursCount: parsed.unmatchedYours.length,
    unmatchedAdjusterCount: parsed.unmatchedAdjuster.length,
  };
}
