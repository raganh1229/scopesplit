// ─────────────────────────────────────────────────────────────────────────
// Inngest worker: process-comparison (N1 conversion — Phase 6)
//
// Replaces the in-process `runRealProcessing()` orchestrator with a durable
// 4-step Inngest function. Each step:
//   • runs as its own serverless invocation (own `maxDuration`, own retries)
//   • takes only `comparisonId` and reads/writes the
//     comparison_processing_state table (Phase 4 contract)
//   • returns a tiny status object (NOT the full payload) — Inngest persists
//     step outputs and they must stay well under the 4 MB step-output limit.
//     Stage payloads (which can be hundreds of KB) live in Postgres, not in
//     the Inngest step output.
//
// Behavior parity with the legacy fire-and-forget path:
//   • On unrecoverable failure (after Inngest exhausts retries), the
//     comparison row is flipped to status='FAILED' with errorMessage set,
//     mirroring the catch-block in `runComparisonProcessing()`. We do this
//     in a `step.run('mark-failed', ...)` inside a try/catch wrapping the
//     stage chain so the failure recording is itself durable.
//   • On success, Stage D's `finalizeAndPersistStageImpl` already flips the
//     comparison row to status='COMPLETED' with the persisted aggregates
//     and clears the intermediate state row.
//   • The stub-mode gate (`shouldRunComparisonProcessingStub` /
//     `isRealProcessingEnabled`) is honored at the front of the function so
//     dev-mode comparisons don't hit Anthropic.
// ─────────────────────────────────────────────────────────────────────────

import type { GetFunctionInput } from 'inngest';
import prisma from '@/lib/prisma';
import { inngest, type ComparisonProcessRequestedEvent } from '@/lib/inngest/client';
import {
  extractStage,
  reconcileAndPrematchStage,
  pairStage,
  finalizeAndPersistStage,
  isRealProcessingEnabled,
} from '@/lib/comparison-processing';
import {
  runComparisonProcessingStub,
  shouldRunComparisonProcessingStub,
} from '@/lib/comparison-processing-stub';
import { maybeFailStageOnce, maybeFailStageAlways } from '@/lib/inngest/debug-fail-once';

type HandlerArgs = GetFunctionInput<typeof inngest>;

// Retry policy: Inngest's default is 4 retries with exponential backoff.
// That's right for the Anthropic-calling stages (B/C are flaky-ish under
// rate limits) and for the DB-only stages (transient pooler hiccups).
// Stage A (download + Haiku extraction) also benefits from the default.
// We set this explicitly so future tuning is centralized here, not
// scattered.
const RETRY_COUNT = 4;

export const processComparison = inngest.createFunction(
  {
    id: 'process-comparison',
    name: 'Process comparison (4-stage pipeline)',
    retries: RETRY_COUNT,
    // Concurrency cap per comparisonId so a manual replay can't race a
    // still-running execution. The intermediate-state table's unique
    // constraint already protects against payload corruption, but the
    // concurrency key gives Inngest a clean serialization point.
    concurrency: {
      key: 'event.data.comparisonId',
      limit: 1,
    },
    triggers: [{ event: 'comparison/process.requested' }],
  },
  async ({ event, step, logger }: HandlerArgs) => {
    // Inngest v4 dropped the EventSchemas client-typing API, so we cast
    // the data here against our documented event-payload contract. The
    // trade-off is a single localized cast in exchange for keeping all
    // call sites typed against `ComparisonProcessRequestedEvent['data']`.
    const { comparisonId, trigger, force } =
      event.data as ComparisonProcessRequestedEvent['data'];
    logger.info('process-comparison invoked', { comparisonId, trigger, force: !!force });

    // ── Idempotency guard ─────────────────────────────────────────────────
    // If the comparison row is already in a terminal state (COMPLETED or
    // FAILED) and this event did NOT explicitly opt into reprocessing via
    // `force: true`, short-circuit. This protects against:
    //   • Inngest webhook delivery dedupe gaps (rare — Inngest already
    //     memoizes step outputs for in-flight retries)
    //   • Future "Reprocess" buttons or admin tools accidentally re-firing
    //   • Bugs that send the event twice for the same comparisonId
    // The destructive risk we're protecting against is Stage D's
    // wipe-and-rewrite of line items + creation of a new
    // comparison_versions row, which would orphan/destroy any
    // user-authored notes, inline edits, executive summaries, or LLM-Edit
    // versions on the comparison.
    const skip = await step.run('check-already-terminal', async () => {
      const row = await prisma.comparison.findUnique({
        where: { id: comparisonId },
        select: { status: true },
      });
      if (!row) {
        return { skip: false as const, reason: 'row-missing' };
      }
      const isTerminal = row.status === 'COMPLETED' || row.status === 'FAILED';
      if (isTerminal && !force) {
        return { skip: true as const, reason: `already-${row.status.toLowerCase()}` };
      }
      return { skip: false as const, reason: 'proceeding' };
    });
    if (skip.skip) {
      logger.info('process-comparison short-circuited (already terminal).', {
        comparisonId,
        reason: skip.reason,
      });
      return { skipped: true as const, reason: skip.reason };
    }

    // ── Mode gate (mirrors `runComparisonProcessing` precedence exactly) ──
    // Real processing wins if `ENABLE_REAL_COMPARISON_PROCESSING=true`. If
    // not, the stub runs in any non-production environment (or wherever
    // `ENABLE_COMPARISON_PROCESSING_STUB=true`). If neither path applies,
    // we leave the row in PROCESSING and exit cleanly — same fallback as
    // the legacy in-process function.
    if (!isRealProcessingEnabled()) {
      if (shouldRunComparisonProcessingStub()) {
        return step.run('stub-processing', async () => {
          const updated = await runComparisonProcessingStub(comparisonId, {});
          return { mode: 'stub', status: updated.status };
        });
      }
      return step.run('processing-disabled', async () => {
        logger.warn('Comparison processing is disabled — leaving row unchanged.', {
          comparisonId,
        });
        return { mode: 'disabled', status: 'PROCESSING' as const };
      });
    }

    // ── Real 4-stage pipeline ──────────────────────────────────────────────
    // Each step.run is an independent durable invocation. If any step
    // throws, Inngest applies the configured retry policy. After retries
    // are exhausted, the wrapping try/catch records the failure on the
    // comparison row (so the UI's polling loop sees FAILED instead of
    // hanging forever).
    try {
      await step.run('extract', async () => {
        maybeFailStageOnce('extract');
        maybeFailStageAlways('extract');
        await extractStage(comparisonId);
        return { stage: 'extracted' as const };
      });

      await step.run('reconcile-and-prematch', async () => {
        maybeFailStageOnce('reconcile-and-prematch');
        maybeFailStageAlways('reconcile-and-prematch');
        await reconcileAndPrematchStage(comparisonId);
        return { stage: 'prematched' as const };
      });

      await step.run('pair', async () => {
        maybeFailStageOnce('pair');
        maybeFailStageAlways('pair');
        await pairStage(comparisonId);
        return { stage: 'paired' as const };
      });

      const finalResult = await step.run('finalize-and-persist', async () => {
        maybeFailStageOnce('finalize-and-persist');
        maybeFailStageAlways('finalize-and-persist');
        const result = await finalizeAndPersistStage(comparisonId);
        return {
          stage: 'completed' as const,
          lineItemCount: result.lineItemCount,
        };
      });

      logger.info('process-comparison completed', { comparisonId, finalResult });
      return finalResult;
    } catch (error) {
      // Capture the message before Inngest swallows it into its own retry
      // bookkeeping. This step.run is what the UI relies on to surface a
      // useful error to the user.
      const message =
        error instanceof Error ? error.message.slice(0, 400) : 'Unknown processing error.';

      await step.run('mark-failed', async () => {
        await prisma.comparison.update({
          where: { id: comparisonId },
          data: {
            status: 'FAILED',
            errorMessage: message,
          },
        });
        logger.error('Comparison flipped to FAILED after exhausted retries.', {
          comparisonId,
          message,
        });
        return { stage: 'failed' as const, message };
      });

      // Re-throw so the run is recorded as failed in the Inngest dashboard
      // (not silently swallowed). Inngest has already exhausted retries by
      // the time we reach this catch, so this won't trigger another retry.
      throw error;
    }
  },
);
