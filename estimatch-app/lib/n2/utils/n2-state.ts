// ─────────────────────────────────────────────────────────────────────────────
// N2 Pipeline — ComparisonProcessingState helpers
//
// Parallel to lib/comparison-processing-state.ts (N1 version), but uses N2
// stage keys and N2 payload schemas for validation. N1's file is read-only.
//
// N2 stage keys are prefixed with 'n2:' to prevent any collision with N1
// stage rows if both pipelines ever process the same comparison (shouldn't
// happen in production, but the prefix guarantees safety during testing).
//
// Lifecycle:
//   Step 2 (detect-zones)         → writeN2Stage(id, 'n2:zones_detected',  payload)
//   Step 3 (match-zones)          → writeN2Stage(id, 'n2:zones_matched',   payload)
//   Step 4 (extract-and-match)    → writeN2Stage(id, 'n2:zones_extracted', payload)
//   Step 5 (persist-results)      → readN2Stage(id, 'n2:zones_extracted') then clearN2Stage(id)
//
// The ComparisonProcessingState table uses a @unique on comparisonId, so each
// upsert overwrites the previous stage. Downstream steps carry forward all
// fields they need — they never read an earlier stage.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma } from '@/app/generated/prisma/client';
import prisma from '@/lib/prisma';
import {
  N2ZonesDetectedPayloadSchema,
  N2ZonesCorrectedPayloadSchema,
  N2ZonesMatchedPayloadSchema,
  N2ZonesExtractedPayloadSchema,
  type N2ZonesDetectedPayloadParsed,
  type N2ZonesCorrectedPayloadParsed,
  type N2ZonesMatchedPayloadParsed,
  type N2ZonesExtractedPayloadParsed,
} from '@/lib/n2/schemas/state-payloads';

// ── Stage Key Literals ────────────────────────────────────────────────────────

export const N2_STAGE_ZONES_DETECTED = 'n2:zones_detected' as const;
export const N2_STAGE_ZONES_CORRECTED = 'n2:zones_corrected' as const;
export const N2_STAGE_ZONES_MATCHED = 'n2:zones_matched' as const;
export const N2_STAGE_ZONES_EXTRACTED = 'n2:zones_extracted' as const;

export type N2ProcessingStage =
  | typeof N2_STAGE_ZONES_DETECTED
  | typeof N2_STAGE_ZONES_CORRECTED
  | typeof N2_STAGE_ZONES_MATCHED
  | typeof N2_STAGE_ZONES_EXTRACTED;

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Upsert the per-comparison N2 processing state. If a row already exists for
 * `comparisonId`, both `stage` and `payload` are replaced atomically.
 *
 * Callers MUST call this only after a step's logic has fully succeeded.
 * A partial write would corrupt the resume point for any subsequent retry.
 */
export async function writeN2Stage(
  comparisonId: string,
  stage: N2ProcessingStage,
  payload: unknown,
): Promise<void> {
  await prisma.comparisonProcessingState.upsert({
    where: { comparisonId },
    create: {
      comparisonId,
      stage,
      payload: payload as Prisma.InputJsonValue,
    },
    update: {
      stage,
      payload: payload as Prisma.InputJsonValue,
    },
  });
}

// ── Read (typed per stage) ────────────────────────────────────────────────────

/**
 * Read and validate the zones_detected payload.
 * Returns null if the row is missing or the stage does not match.
 * Throws if the payload fails Zod validation (indicates state corruption).
 */
export async function readZonesDetected(
  comparisonId: string,
): Promise<N2ZonesDetectedPayloadParsed | null> {
  return readN2Stage(comparisonId, N2_STAGE_ZONES_DETECTED, N2ZonesDetectedPayloadSchema);
}

/**
 * Read and validate the zones_corrected payload.
 * Returns null if no corrections have been applied yet (common case — user skipped review).
 */
export async function readZonesCorrected(
  comparisonId: string,
): Promise<N2ZonesCorrectedPayloadParsed | null> {
  return readN2Stage(comparisonId, N2_STAGE_ZONES_CORRECTED, N2ZonesCorrectedPayloadSchema);
}

/**
 * Read and validate the zones_matched payload.
 */
export async function readZonesMatched(
  comparisonId: string,
): Promise<N2ZonesMatchedPayloadParsed | null> {
  return readN2Stage(comparisonId, N2_STAGE_ZONES_MATCHED, N2ZonesMatchedPayloadSchema);
}

/**
 * Read and validate the zones_extracted payload.
 */
export async function readZonesExtracted(
  comparisonId: string,
): Promise<N2ZonesExtractedPayloadParsed | null> {
  return readN2Stage(comparisonId, N2_STAGE_ZONES_EXTRACTED, N2ZonesExtractedPayloadSchema);
}

// ── Clear ─────────────────────────────────────────────────────────────────────

/**
 * Delete the N2 processing state row after Step 5 successfully persists
 * all LineItems. Safe to call even if no row exists.
 */
export async function clearN2Stage(comparisonId: string): Promise<void> {
  await prisma.comparisonProcessingState.deleteMany({
    where: { comparisonId },
  });
}

// ── Internal generic read ─────────────────────────────────────────────────────

async function readN2Stage<T>(
  comparisonId: string,
  expectedStage: N2ProcessingStage,
  schema: { safeParse: (data: unknown) => { success: true; data: T } | { success: false; error: { message: string } } },
): Promise<T | null> {
  const row = await prisma.comparisonProcessingState.findUnique({
    where: { comparisonId },
    select: { stage: true, payload: true },
  });

  if (!row) return null;
  if (row.stage !== expectedStage) return null;

  const result = schema.safeParse(row.payload);
  if (!result.success) {
    throw new Error(
      `[n2-state] Payload validation failed for stage '${expectedStage}' ` +
        `on comparison ${comparisonId}: ${result.error.message.slice(0, 300)}`,
    );
  }

  return result.data;
}
