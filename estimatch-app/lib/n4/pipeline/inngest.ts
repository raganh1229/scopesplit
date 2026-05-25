// ─────────────────────────────────────────────────────────────────────────────
// N4 Pipeline — Inngest function: process-comparison-v4
//
// Multi-format durable pipeline. Triggered by 'comparison/process-v4.requested'.
//
// Step map (each is a separate Vercel Lambda invocation via Inngest):
//   1.  store-run-id               — mark pipelineVersion='n4', flip PROCESSING
//   2.  p4-detect-zones            — Phase 4: per-side, format-aware zone detection
//   3.  p5-zone-review-gate        — Phase 5: wait for user zone confirmation
//   4.  p6-propose-correspondences — Phase 6: AI-propose zone correspondences
//   5.  p7-correspondence-gate     — Phase 7: wait for correspondence confirmation
//   6.  p8-extract-line-items      — Phase 8: per-side, format-aware extraction
//   7.  p8.5-line-item-review-gate — Phase 8.5: wait for item count confirmation
//   8.  p9-normalize-line-items    — Phase 9: shared N3 normalization (untouched)
//   9.  p10-extraction-validation  — Phase 10: shared N3 validation
//  10.  p11-generate-embeddings    — Phase 11: shared N3 Voyage AI embeddings
//  11.  p12-generate-candidates    — Phase 12: shared N3 candidate generation
//  12.  p13-score-candidates       — Phase 13: shared N3 scoring
//  13.  p14-build-components       — Phase 14: shared N3 connected components
//  14.  p15-assign-matches         — Phase 15: shared N3 Hungarian assignment
//  15.  p16-group-matching         — Phase 16: shared N3 group matching
//  16.  p17-llm-adjudication       — Phase 17: shared N3 LLM adjudication
//  17.  p18-persist-decisions      — Phase 18: shared N3 persist decisions
//
// N4-specific steps:  p4, p8 (via orchestrator — format-aware dispatch)
// Shared N3 steps:    p6, p9–p18 (imported directly, never duplicated)
//
// Vercel / Inngest constraints:
//   • Each step.run() is one Lambda invocation (maxDuration 300s on route).
//   • Step outputs are tiny status objects — large payloads live in n3_* tables.
//   • Concurrency key per comparisonId prevents concurrent retries from racing.
// ─────────────────────────────────────────────────────────────────────────────

import type { GetFunctionInput } from 'inngest';
import { inngest } from '@/lib/inngest/client';
import prisma from '@/lib/prisma';
import type { N4ProcessRequestedEvent } from '@/lib/n4/n4-routing';
import { orchestrateDetectZones, orchestrateExtractLineItems } from './orchestrator';

// ── Shared N3 phases (imported verbatim — NOT duplicated) ─────────────────────
import { proposeCorrespondencesN3 } from '@/lib/n3/passes/propose-correspondences';
import { normalizeLineItemsN3 } from '@/lib/n3/passes/normalize-line-items';
import { validateExtractionN3 } from '@/lib/n3/passes/extraction-validation';
import { generateEmbeddingsN3 } from '@/lib/n3/passes/generate-embeddings';
import { generateCandidatesN3 } from '@/lib/n3/passes/generate-candidates';
import { scoreCandidatesN3 } from '@/lib/n3/passes/score-candidates';
import { buildComponentsN3 } from '@/lib/n3/passes/build-components';
import { assignMatchesN3 } from '@/lib/n3/passes/assign-matches';
import { groupMatchingN3 } from '@/lib/n3/passes/group-matching';
import { llmAdjudicationN3 } from '@/lib/n3/passes/llm-adjudication';
import { persistDecisionsN3 } from '@/lib/n3/passes/persist-decisions';

type HandlerArgs = GetFunctionInput<typeof inngest>;

const RETRY_COUNT = 3;

export const processComparisonV4 = inngest.createFunction(
  {
    id: 'process-comparison-v4',
    name: 'Process comparison (N4 multi-format pipeline)',
    retries: RETRY_COUNT,
    concurrency: {
      key: 'event.data.comparisonId',
      limit: 1,
    },
    triggers: [{ event: 'comparison/process-v4.requested' }],
  },
  async ({ event, step, logger }: HandlerArgs) => {
    const { comparisonId, trigger, force } =
      event.data as N4ProcessRequestedEvent['data'];

    logger.info('[n4] process-comparison-v4 invoked', {
      comparisonId,
      trigger,
      force: !!force,
    });

    // ── Idempotency guard ──────────────────────────────────────────────────
    const skip = await step.run('check-already-terminal', async () => {
      const row = await prisma.comparison.findUnique({
        where: { id: comparisonId },
        select: { status: true },
      });
      if (!row) return { skip: false as const, reason: 'row-missing' };
      const isTerminal = row.status === 'COMPLETED' || row.status === 'FAILED';
      if (isTerminal && !force) {
        return { skip: true as const, reason: `already-${row.status.toLowerCase()}` };
      }
      return { skip: false as const, reason: 'proceeding' };
    });

    if (skip.skip) {
      logger.info('[n4] short-circuited (already terminal)', {
        comparisonId,
        reason: skip.reason,
      });
      return { skipped: true as const, reason: skip.reason };
    }

    // ── Pipeline ───────────────────────────────────────────────────────────
    try {

      // ── Step 1: Store Run ID ─────────────────────────────────────────────
      await step.run('store-run-id', async () => {
        const exists = await prisma.comparison.findUnique({
          where: { id: comparisonId },
          select: { id: true },
        });
        if (!exists) {
          logger.info('[n4] store-run-id: comparison deleted — skipping', { comparisonId });
          return { step: 'store-run-id', skipped: true };
        }
        await prisma.comparison.update({
          where: { id: comparisonId },
          data: { pipelineVersion: 'n4', status: 'PROCESSING' },
        });
        logger.info('[n4] store-run-id: pipelineVersion=n4 written', { comparisonId });
        return { step: 'store-run-id', skipped: false };
      });

      // ── Step 2: Phase 4 — Detect Zones (format-aware, both sides) ───────
      // Resolves the correct Extractor for each side based on the user-selected
      // format stored on the Comparison row, then runs both sides in parallel.
      await step.run('p4-detect-zones', async () => {
        const exists = await prisma.comparison.findUnique({
          where: { id: comparisonId },
          select: { id: true },
        });
        if (!exists) return { step: 'p4-detect-zones', skipped: true };

        const result = await orchestrateDetectZones(comparisonId, logger);
        logger.info('[n4] p4-detect-zones complete', { comparisonId, ...result });
        return { step: 'p4-detect-zones', ...result };
      });

      // ── Step 3: Phase 5 — Zone Review Gate ──────────────────────────────
      const skipZoneReview = process.env.N3_SKIP_ZONE_REVIEW === 'true';
      if (!skipZoneReview) {
        await step.run('p5-zone-review-flip', async () => {
          await prisma.comparison.update({
            where: { id: comparisonId },
            data: { status: 'AWAITING_ZONE_REVIEW' },
          });
          logger.info('[n4] p5: flipped to AWAITING_ZONE_REVIEW', { comparisonId });
          return { step: 'p5-zone-review-flip', status: 'waiting' };
        });

        await step.waitForEvent('p5-zone-review-gate', {
          event: 'comparison/n3-zone-review.completed',
          timeout: '24h',
          match: 'data.comparisonId',
        });

        await step.run('p5-zone-review-resume', async () => {
          await prisma.comparison.update({
            where: { id: comparisonId },
            data: { status: 'PROCESSING' },
          });
          logger.info('[n4] p5: zone review confirmed, resuming', { comparisonId });
          return { step: 'p5-zone-review-resume' };
        });
      } else {
        logger.info('[n4] p5-zone-review-gate: skipped (N3_SKIP_ZONE_REVIEW=true)', { comparisonId });
      }

      // ── Step 4: Phase 6 — Propose Zone Correspondences ──────────────────
      // Shared N3 pass — operates on n3_zones rows regardless of format.
      await step.run('p6-propose-correspondences', async () => {
        const result = await proposeCorrespondencesN3(comparisonId, logger);
        logger.info('[n4] p6-propose-correspondences complete', { comparisonId, ...result });
        return { step: 'p6-propose-correspondences', ...result };
      });

      // ── Step 5: Phase 7 — Correspondence Review Gate ────────────────────
      if (!skipZoneReview) {
        await step.run('p7-correspondence-flip', async () => {
          await prisma.comparison.update({
            where: { id: comparisonId },
            data: { status: 'AWAITING_MATCH_REVIEW' },
          });
          logger.info('[n4] p7: flipped to AWAITING_MATCH_REVIEW', { comparisonId });
          return { step: 'p7-correspondence-flip', status: 'waiting' };
        });

        await step.waitForEvent('p7-correspondence-gate', {
          event: 'comparison/n3-correspondence-review.completed',
          timeout: '24h',
          match: 'data.comparisonId',
        });

        await step.run('p7-correspondence-resume', async () => {
          await prisma.comparison.update({
            where: { id: comparisonId },
            data: { status: 'PROCESSING' },
          });
          logger.info('[n4] p7: correspondence review confirmed, resuming', { comparisonId });
          return { step: 'p7-correspondence-resume' };
        });
      } else {
        logger.info('[n4] p7-correspondence-gate: skipped (N3_SKIP_ZONE_REVIEW=true)', { comparisonId });
      }

      // ── Step 6: Phase 8 — Extract Line Items (format-aware, both sides) ─
      await step.run('p8-extract-line-items', async () => {
        const result = await orchestrateExtractLineItems(comparisonId, logger);
        logger.info('[n4] p8-extract-line-items complete', { comparisonId, ...result });
        return { step: 'p8-extract-line-items', ...result };
      });

      // ── Step 6.5: Phase 8.5 — Line Item Review Gate ─────────────────────
      const skipLineItemReview = process.env.N3_SKIP_LINE_ITEM_REVIEW === 'true';
      if (!skipLineItemReview) {
        await step.run('p8-5-line-item-review-flip', async () => {
          await prisma.comparison.update({
            where: { id: comparisonId },
            data: { status: 'AWAITING_LINE_ITEM_REVIEW' },
          });
          logger.info('[n4] p8.5: flipped to AWAITING_LINE_ITEM_REVIEW', { comparisonId });
          return { step: 'p8-5-line-item-review-flip', status: 'waiting' };
        });

        const reviewEvent = await step.waitForEvent('p8-5-line-item-review-gate', {
          event: 'comparison/n3-line-item-review.completed',
          timeout: '24h',
          match: 'data.comparisonId',
        });

        if (reviewEvent?.data?.action === 'reextract') {
          await step.run('p8-reextract-line-items', async () => {
            await prisma.comparison.update({
              where: { id: comparisonId },
              data: { status: 'PROCESSING' },
            });
            const result = await orchestrateExtractLineItems(
              comparisonId,
              logger,
              reviewEvent.data.reextractSource,
            );
            logger.info('[n4] p8-reextract-line-items complete', { comparisonId, ...result });
            return { step: 'p8-reextract-line-items', ...result };
          });
        } else {
          await step.run('p8-5-line-item-review-resume', async () => {
            await prisma.comparison.update({
              where: { id: comparisonId },
              data: { status: 'PROCESSING' },
            });
            return { step: 'p8-5-line-item-review-resume', status: 'confirmed' };
          });
        }
      }

      // ── Steps 7–16: Shared N3 phases (format-agnostic) ──────────────────

      // Step 7: Phase 9 — Normalize Line Items
      await step.run('p9-normalize-line-items', async () => {
        const result = await normalizeLineItemsN3(comparisonId, logger);
        logger.info('[n4] p9-normalize-line-items complete', { comparisonId, ...result });
        return { step: 'p9-normalize-line-items', ...result };
      });

      // Step 8: Phase 10 — Extraction Validation
      await step.run('p10-extraction-validation', async () => {
        const result = await validateExtractionN3(comparisonId, logger);
        return { step: 'p10-extraction-validation', ...result };
      });

      // Step 9: Phase 11 — Generate Embeddings
      await step.run('p11-generate-embeddings', async () => {
        const result = await generateEmbeddingsN3(comparisonId, logger, force);
        logger.info('[n4] p11-generate-embeddings complete', { comparisonId, ...result });
        return { step: 'p11-generate-embeddings', ...result };
      });

      // Step 10: Phase 12 — Generate Candidate Edges
      await step.run('p12-generate-candidates', async () => {
        const result = await generateCandidatesN3(comparisonId, logger);
        logger.info('[n4] p12-generate-candidates complete', { comparisonId, ...result });
        return { step: 'p12-generate-candidates', ...result };
      });

      // Step 11: Phase 13 — Score Candidates
      const p13Result = await step.run('p13-score-candidates', async () => {
        return scoreCandidatesN3(comparisonId, logger);
      });
      logger.info('[n4] p13-score-candidates complete', {
        comparisonId,
        scoredCount:   p13Result.scoredCount,
        rejectedCount: p13Result.rejectedCount,
        byBucket:      p13Result.byBucket,
      });

      // Step 12: Phase 14 — Build Connected Components
      const p14Result = await step.run('p14-build-components', async () => {
        return buildComponentsN3(comparisonId, logger);
      });
      logger.info('[n4] p14-build-components complete', {
        comparisonId,
        componentCount: p14Result.componentCount,
        bySize:         p14Result.bySize,
        singletonYours: p14Result.singletonYours,
        singletonAdj:   p14Result.singletonAdj,
      });

      // Step 13: Phase 15 — Assign Matches
      const p15Result = await step.run('p15-assign-matches', async () => {
        return assignMatchesN3(comparisonId, logger);
      });
      logger.info('[n4] p15-assign-matches complete', {
        comparisonId,
        decisionCount:   p15Result.decisionCount,
        matchedCount:    p15Result.matchedCount,
        possibleCount:   p15Result.possibleCount,
        unmatchedYours:  p15Result.unmatchedYours,
        unmatchedAdj:    p15Result.unmatchedAdj,
        zoneRepairCount: p15Result.zoneRepairCount,
      });

      // Step 14: Phase 16 — Group Matching
      const p16Result = await step.run('p16-group-matching', async () => {
        return groupMatchingN3(comparisonId, logger);
      });
      logger.info('[n4] p16-group-matching complete', {
        comparisonId,
        groupedCount:    p16Result.groupedCount,
        relinquishedAdj: p16Result.relinquishedAdj,
      });

      // Step 15: Phase 17 — LLM Adjudication
      const p17Result = await step.run('p17-llm-adjudication', async () => {
        return llmAdjudicationN3(comparisonId, logger);
      });
      logger.info('[n4] p17-llm-adjudication complete', {
        comparisonId,
        adjudicatedCount:  p17Result.adjudicatedCount,
        acceptedCount:     p17Result.acceptedCount,
        rejectedCount:     p17Result.rejectedCount,
        autoRejectedCount: p17Result.autoRejectedCount,
        skipped:           p17Result.skipped,
      });

      // Step 16: Phase 18 — Persist Decisions
      const finalResult = await step.run('p18-persist-decisions', async () => {
        return persistDecisionsN3(comparisonId, logger, trigger ?? 'unknown');
      });
      logger.info('[n4] p18-persist-decisions complete', {
        comparisonId,
        lineItemCount:  finalResult.lineItemCount,
        matchCount:     finalResult.matchCount,
        modifiedCount:  finalResult.modifiedCount,
        missingCount:   finalResult.missingCount,
        addedCount:     finalResult.addedCount,
        groupedCount:   finalResult.groupedCount,
        totalGap:       finalResult.totalGap,
      });

      // ── Metrics snapshot (dev only) ──────────────────────────────────────
      await step.run('dump-metrics-snapshot', async () => {
        if (process.env.NODE_ENV !== 'production') {
          try {
            const { computePipelineMetrics } = await import('@/lib/n3/metrics/compute-metrics');
            const fs   = await import('fs');
            const path = await import('path');
            const metrics = await computePipelineMetrics(comparisonId);
            if (metrics) {
              const dir = path.resolve(process.cwd(), 'run-results');
              fs.mkdirSync(dir, { recursive: true });
              const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}_${comparisonId.slice(0, 8)}_n4.json`;
              fs.writeFileSync(path.join(dir, filename), JSON.stringify(metrics, null, 2));
              fs.writeFileSync(path.join(dir, 'latest-n4.json'), JSON.stringify(metrics, null, 2));
              logger.info('[n4] metrics snapshot written', { file: filename });
            }
          } catch (err) {
            logger.warn('[n4] metrics snapshot failed (non-fatal)', { err: String(err) });
          }
        }
        return { step: 'dump-metrics-snapshot' };
      });

      logger.info('[n4] process-comparison-v4 completed', { comparisonId, finalResult });
      return finalResult;

    } catch (error) {
      const message =
        error instanceof Error ? error.message.slice(0, 400) : 'Unknown N4 processing error.';

      await step.run('mark-failed', async () => {
        try {
          await prisma.comparison.update({
            where: { id: comparisonId },
            data: { status: 'FAILED', errorMessage: `[N4] ${message}` },
          });
        } catch {
          // Comparison may have been deleted — ignore Prisma not-found errors
        }
        logger.error('[n4] comparison flipped to FAILED after exhausted retries', {
          comparisonId,
          message,
        });
        return { step: 'mark-failed', message };
      });

      throw error;
    }
  },
);
