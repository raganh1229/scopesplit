// ─────────────────────────────────────────────────────────────────────────
// Intermediate state store for the multi-step Inngest comparison pipeline
// (N1 conversion). Each comparison has at most ONE row in the
// `comparison_processing_state` table; the `stage` column tracks which
// pipeline phase last completed and `payload` holds the JSON output of that
// stage so the next step can read it without exceeding Inngest's 4 MB
// step-output limit.
//
// Lifecycle:
//   Stage A (extract)              → writeStage(id, 'extracted',   payload)
//   Stage B (reconcile + prematch) → readStage(id, 'extracted')   then writeStage(id, 'prematched', payload)
//   Stage C (sonnet pair)          → readStage(id, 'prematched')  then writeStage(id, 'paired',     payload)
//   Stage D (finalize + persist)   → readStage(id, 'paired')      then clearStage(id)  (final DB write done)
//
// `clearStage` is intentionally called only after Stage D succeeds. If a
// pipeline run fails partway through, the row is preserved so a future
// retry can resume from the last completed stage. The cascade-delete on
// the foreign key cleans up rows automatically when a comparison is
// deleted.
// ─────────────────────────────────────────────────────────────────────────

import type { Prisma } from '@/app/generated/prisma/client';
import { prisma } from '@/lib/prisma';

export type ProcessingStage = 'extracted' | 'prematched' | 'paired';

/**
 * Upsert the per-comparison processing state. If a row already exists for
 * `comparisonId`, both `stage` and `payload` are replaced. The unique index
 * on `comparison_id` guarantees there is at most one row per comparison.
 *
 * Callers should invoke this only after a stage's logic has fully succeeded;
 * a partial-write would corrupt the resume point for retries.
 */
export async function writeStage(
  comparisonId: string,
  stage: ProcessingStage,
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

/**
 * Read the processing state for `comparisonId` if and only if the stored
 * stage equals `expectedStage`. Returns the parsed payload typed as `T`,
 * or `null` if the row is missing OR the stored stage does not match.
 *
 * The expected-stage check is a defensive guard: it prevents a step from
 * accidentally consuming output from a different stage in the pipeline
 * (e.g. if a manual retry skipped a stage or if state machine ordering
 * was corrupted).
 *
 * The caller is responsible for runtime validation of the payload shape.
 * The generic `T` is a type assertion only — Prisma stores `payload` as
 * `Json`, which TS surfaces as `Prisma.JsonValue`.
 */
export async function readStage<T = unknown>(
  comparisonId: string,
  expectedStage: ProcessingStage,
): Promise<T | null> {
  const row = await prisma.comparisonProcessingState.findUnique({
    where: { comparisonId },
    select: { stage: true, payload: true },
  });

  if (!row) return null;
  if (row.stage !== expectedStage) return null;

  return row.payload as T;
}

/**
 * Returns true if a row exists for `comparisonId` AND its stored stage
 * matches `expectedStage`. Useful for short-circuit checks before doing
 * expensive work (e.g. "did Stage B already complete? skip re-running.").
 */
export async function hasStage(
  comparisonId: string,
  expectedStage: ProcessingStage,
): Promise<boolean> {
  const row = await prisma.comparisonProcessingState.findUnique({
    where: { comparisonId },
    select: { stage: true },
  });

  return row?.stage === expectedStage;
}

/**
 * Delete the processing state row for `comparisonId`, if any. Called after
 * Stage D (finalize + persist) succeeds — the per-stage payloads are no
 * longer needed once the final `lineItems` rows are persisted to the
 * `comparisons` and `line_items` tables.
 *
 * Safe to call even if no row exists (Prisma's `deleteMany` with a unique
 * filter returns count 0 instead of throwing).
 */
export async function clearStage(comparisonId: string): Promise<void> {
  await prisma.comparisonProcessingState.deleteMany({
    where: { comparisonId },
  });
}
