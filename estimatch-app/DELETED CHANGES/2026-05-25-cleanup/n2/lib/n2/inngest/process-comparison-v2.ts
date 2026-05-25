// ─────────────────────────────────────────────────────────────────────────────
// N2 Pipeline — Inngest function: process-comparison-v2
//
// 5-step durable pipeline for the N2 zone-first architecture.
// Triggered by 'comparison/process-v2.requested'.
//
// Step map:
//   1. store-run-id         — persist Inngest run ID for cancellation support
//   2. detect-zones         — Pass 1/2: chunk PDFs, detect zone boundaries
//   3. match-zones          — Pass 3: Opus zone matching (text-only)
//   4. extract-and-match    — Pass 4: per-zone extraction + item matching
//   5. persist-results      — atomic LineItem write + status flip to COMPLETED
//
// Each step is an independent Lambda invocation with its own maxDuration
// budget and retry policy. State flows via ComparisonProcessingState table
// (NOT via Inngest step outputs — those would exceed the 4 MB limit for
// large comparisons).
//
// Every step begins with a comparison-existence check. If the comparison was
// deleted while the pipeline was running, the step returns cleanly — no
// throw, no retry loop, no wasted API calls.
//
// Phase 1: This is a skeleton. Steps 2-5 are no-ops that return status
// strings. Logic will be wired in Phases 2-6.
// ─────────────────────────────────────────────────────────────────────────────

import type { GetFunctionInput } from 'inngest';
import { inngest } from '@/lib/inngest/client';
import prisma from '@/lib/prisma';
import type { N2ProcessRequestedEvent } from '@/lib/n2/n2-routing';
import { detectZones } from '@/lib/n2/passes/detect-zones';
import { matchZones } from '@/lib/n2/passes/match-zones';
import { extractAndMatch, persistResults } from '@/lib/n2/passes/extract-and-match';

type HandlerArgs = GetFunctionInput<typeof inngest>;

const RETRY_COUNT = 3;

export const processComparisonV2 = inngest.createFunction(
  {
    id: 'process-comparison-v2',
    name: 'Process comparison (N2 zone-first pipeline)',
    retries: RETRY_COUNT,
    // One active run per comparison — prevents concurrent retries from
    // corrupting the ComparisonProcessingState row mid-pipeline.
    concurrency: {
      key: 'event.data.comparisonId',
      limit: 1,
    },
    triggers: [{ event: 'comparison/process-v2.requested' }],
  },
  async ({ event, step, logger }: HandlerArgs) => {
    const { comparisonId, trigger, force } =
      event.data as N2ProcessRequestedEvent['data'];

    logger.info('[n2] process-comparison-v2 invoked', {
      comparisonId,
      trigger,
      force: !!force,
    });

    // ── Idempotency guard ──────────────────────────────────────────────────
    // Short-circuit if the comparison is already in a terminal state and
    // this is not a forced reprocess. Protects user-authored notes, version
    // edits, and summaries from accidental destruction.
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
      logger.info('[n2] short-circuited (already terminal)', {
        comparisonId,
        reason: skip.reason,
      });
      return { skipped: true as const, reason: skip.reason };
    }

    // ── Real 5-step pipeline ───────────────────────────────────────────────
    try {
      // ── Step 1: Store Run ID ─────────────────────────────────────────────
      await step.run('store-run-id', async () => {
        const exists = await prisma.comparison.findUnique({
          where: { id: comparisonId },
          select: { id: true },
        });
        if (!exists) {
          logger.info('[n2] store-run-id: comparison deleted — skipping', { comparisonId });
          return { step: 'store-run-id', skipped: true };
        }

        await prisma.comparison.update({
          where: { id: comparisonId },
          data: { pipelineVersion: 'n2' },
        });

        // TODO(Phase 6): persist actual Inngest run ID via run.id once
        // the run-cancellation mechanism is wired (Issue 29 Layer 3).
        logger.info('[n2] store-run-id: complete, pipelineVersion=n2 written', { comparisonId });
        return { step: 'store-run-id', skipped: false };
      });

      // ── Step 2: Detect Zones ─────────────────────────────────────────────
      // Pass 1 (E1) + Pass 2 (E2) in parallel: chunk PDFs, fire all Haiku
      // calls simultaneously, merge per-chunk offsets, pre-dedup, write
      // n2:zones_detected to ComparisonProcessingState.
      await step.run('detect-zones', async () => {
        const exists = await prisma.comparison.findUnique({
          where: { id: comparisonId },
          select: { id: true },
        });
        if (!exists) {
          logger.info('[n2] detect-zones: comparison deleted — skipping', { comparisonId });
          return { step: 'detect-zones', skipped: true };
        }

        await detectZones(comparisonId, logger);

        await prisma.comparison.update({
          where: { id: comparisonId },
          data: { status: 'AWAITING_ZONE_REVIEW' },
        });

        logger.info('[n2] detect-zones: complete, awaiting zone review', { comparisonId });
        return { step: 'detect-zones', skipped: false };
      });

      // ── Zone Review Gate ───────────────────────────────────────────
      // Pause here until the user reviews detected zones and clicks
      // 'Looks good →'. If they applied corrections, those are already
      // persisted to n2:zones_corrected before this event fires.
      // Timeout: 24 h — auto-proceed with originally detected zones.
      await step.waitForEvent('zone-review-complete', {
        event: 'comparison/zone-review.completed',
        timeout: '24h',
        match: 'data.comparisonId',
      });

      // ── Step 3: Match Zones ──────────────────────────────────────────────
      // Single Sonnet call (text-only). Reads n2:zones_corrected if present,
      // falls back to n2:zones_detected. Writes n2:zones_matched and flips
      // status to AWAITING_MATCH_REVIEW for the second human review gate.
      await step.run('match-zones', async () => {
        const exists = await prisma.comparison.findUnique({
          where: { id: comparisonId },
          select: { id: true },
        });
        if (!exists) {
          logger.info('[n2] match-zones: comparison deleted — skipping', { comparisonId });
          return { step: 'match-zones', skipped: true };
        }

        try {
          await matchZones(comparisonId, logger);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('No zone state found')) {
            logger.warn('[n2] match-zones: no zone state — marking comparison FAILED', { comparisonId, msg });
            await prisma.comparison.update({
              where: { id: comparisonId },
              data: { status: 'FAILED', errorMessage: 'Zone detection state not found. Please resubmit.' },
            });
            return { step: 'match-zones', skipped: true, reason: 'no-zone-state' };
          }
          throw err;
        }

        // Use $executeRaw to bypass Prisma client-side enum validation.
        // The DB enum was extended with ALTER TYPE; the Prisma runtime JS
        // may still have a cached/bundled copy without AWAITING_MATCH_REVIEW.
        await prisma.$executeRaw`
          UPDATE comparisons
          SET status = 'AWAITING_MATCH_REVIEW'::comparison_status, updated_at = NOW()
          WHERE id = ${comparisonId}
        `;

        logger.info('[n2] match-zones: complete, awaiting match review', { comparisonId });
        return { step: 'match-zones', skipped: false };
      });

      // ── Match Review Gate ──────────────────────────────────────────────
      // Pause here until the user reviews AI-produced zone pairings and
      // clicks 'Confirm pairings →'. Any manual re-arrangements are already
      // persisted to n2:zones_matched before this event fires.
      // Timeout: 24 h — auto-proceed with AI-produced pairings.
      await step.waitForEvent('match-review-complete', {
        event: 'comparison/match-review.completed',
        timeout: '24h',
        match: 'data.comparisonId',
      });

      // ── Step 4: Extract and Match ─────────────────────────────────────────
      // Fetch both PDFs once, slice per-zone sub-PDFs, fan out Pass 4A
      // (matched zones) + Pass 4B (unmatched zones) under concurrency cap 8,
      // run splitMispaired on each zone result, write n2:zones_extracted.
      await step.run('extract-and-match', async () => {
        const exists = await prisma.comparison.findUnique({
          where: { id: comparisonId },
          select: { id: true },
        });
        if (!exists) {
          logger.info('[n2] extract-and-match: comparison deleted — skipping', { comparisonId });
          return { step: 'extract-and-match', skipped: true };
        }

        await extractAndMatch(comparisonId, logger);

        logger.info('[n2] extract-and-match: complete', { comparisonId });
        return { step: 'extract-and-match', skipped: false };
      });

      // ── Step 5: Persist Results ───────────────────────────────────────────
      // Read n2:zones_extracted, sort zones + items, atomic createMany,
      // flip comparison.status → COMPLETED, clear N2 state row.
      const finalResult = await step.run('persist-results', async () => {
        const exists = await prisma.comparison.findUnique({
          where: { id: comparisonId },
          select: { id: true },
        });
        if (!exists) {
          logger.info('[n2] persist-results: comparison deleted — skipping', { comparisonId });
          return { step: 'persist-results', skipped: true, lineItemCount: 0 };
        }

        const result = await persistResults(comparisonId, logger);

        logger.info('[n2] persist-results: complete', { comparisonId, lineItemCount: result.lineItemCount });
        return { step: 'persist-results', skipped: false, lineItemCount: result.lineItemCount };
      });

      logger.info('[n2] process-comparison-v2 completed', { comparisonId, finalResult });
      return finalResult;

    } catch (error) {
      // Capture the failure message before Inngest swallows it. This step
      // is what surfaces a useful error to the UI's polling loop.
      const message =
        error instanceof Error ? error.message.slice(0, 400) : 'Unknown N2 processing error.';

      await step.run('mark-failed', async () => {
        try {
          await prisma.comparison.update({
            where: { id: comparisonId },
            data: { status: 'FAILED', errorMessage: `[N2] ${message}` },
          });
        } catch {
          // Comparison may have been deleted — ignore Prisma not-found errors
        }
        logger.error('[n2] comparison flipped to FAILED after exhausted retries', {
          comparisonId,
          message,
        });
        return { step: 'mark-failed', message };
      });

      // Re-throw so Inngest records this run as failed (not silently swallowed).
      // Inngest has already exhausted retries by the time we reach this catch.
      throw error;
    }
  },
);
