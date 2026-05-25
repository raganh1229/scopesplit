// ─────────────────────────────────────────────────────────────────────────────
// N3 Pipeline — Inngest function: process-comparison-v3
//
// 16-step durable pipeline for the N3 global-candidate architecture.
// Triggered by 'comparison/process-v3.requested'.
//
// Step map (each is a separate Vercel Lambda invocation via Inngest):
//   1.  store-run-id               — mark pipelineVersion='n3', flip PROCESSING
//   2.  p4-detect-zones            — Phase 4: detect zone boundaries from PDFs
//   3.  p5-zone-review-gate        — Phase 5: wait for user zone confirmation (UI gate)
//   4.  p6-propose-correspondences — Phase 6: AI-propose zone correspondences
//   5.  p7-correspondence-gate     — Phase 7: wait for correspondence confirmation
//   6.  p8-extract-line-items      — Phase 8: extract raw line items per zone
//   7.  p9-normalize-line-items    — Phase 9: normalize + tokenize all items
//   8.  p10-extraction-validation  — Phase 10: write N3ExtractionWarning rows
//   9.  p11-generate-embeddings    — Phase 11: Voyage AI embeddings (voyage-3-lite) → pgvector
//   10. p12-generate-candidates    — Phase 12: 9 retrieval sources → candidate edges
//   11. p13-score-candidates       — Phase 13: weighted score + zone boosts
//   12. p14-build-components       — Phase 14: connected components of sparse graph
//   13. p15-assign-matches         — Phase 15: Hungarian / greedy assignment
//   14. p16-group-matching         — Phase 16: one-to-many / many-to-one resolution
//   15. p17-llm-adjudication       — Phase 17: LLM for ambiguous components
//   16. p18-persist-decisions      — Phase 18: write LineItem rows, flip COMPLETED
//
// Vercel / Inngest constraints respected:
//   • Each step.run() is a single Lambda invocation (maxDuration 300s on route).
//   • Step outputs are tiny status objects — large payloads live in n3_* tables.
//   • Concurrency key per comparisonId prevents concurrent retries from racing.
//   • mark-failed step records the error so the UI polling loop sees FAILED.
//
// SCAFFOLD NOTE: All phase steps (p4–p18) are stubs that write a log line
// and return immediately. Logic will be wired phase-by-phase starting at
// Phase 4. The zone-review gates (p5, p7) auto-proceed in the scaffold;
// they will be replaced with step.waitForEvent() when the UI is built.
// ─────────────────────────────────────────────────────────────────────────────

import type { GetFunctionInput } from 'inngest';
import { inngest } from '@/lib/inngest/client';
import prisma from '@/lib/prisma';
import type { N3ProcessRequestedEvent } from '@/lib/n3/n3-routing';
import { detectZonesN3 } from '@/lib/n3/passes/detect-zones';
import { proposeCorrespondencesN3 } from '@/lib/n3/passes/propose-correspondences';
import { extractLineItemsN3 } from '@/lib/n3/passes/extract-line-items';
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

export const processComparisonV3 = inngest.createFunction(
  {
    id: 'process-comparison-v3',
    name: 'Process comparison (N3 global-candidate pipeline)',
    retries: RETRY_COUNT,
    // One active run per comparison — prevents concurrent retries from
    // corrupting n3_* table rows mid-pipeline.
    concurrency: {
      key: 'event.data.comparisonId',
      limit: 1,
    },
    triggers: [{ event: 'comparison/process-v3.requested' }],
  },
  async ({ event, step, logger }: HandlerArgs) => {
    const { comparisonId, trigger, force } =
      event.data as N3ProcessRequestedEvent['data'];

    logger.info('[n3] process-comparison-v3 invoked', {
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
      logger.info('[n3] short-circuited (already terminal)', {
        comparisonId,
        reason: skip.reason,
      });
      return { skipped: true as const, reason: skip.reason };
    }

    // ── 16-step pipeline ───────────────────────────────────────────────────
    try {

      // ── Step 1: Store Run ID ───────────────────────────────────────────
      await step.run('store-run-id', async () => {
        const exists = await prisma.comparison.findUnique({
          where: { id: comparisonId },
          select: { id: true },
        });
        if (!exists) {
          logger.info('[n3] store-run-id: comparison deleted — skipping', { comparisonId });
          return { step: 'store-run-id', skipped: true };
        }
        await prisma.comparison.update({
          where: { id: comparisonId },
          data: { pipelineVersion: 'n3', status: 'PROCESSING' },
        });
        logger.info('[n3] store-run-id: pipelineVersion=n3 written', { comparisonId });
        return { step: 'store-run-id', skipped: false };
      });

      // ── Step 2: Phase 4 — Detect Zones ────────────────────────────────
      // Detects zone boundaries in both PDFs using Sonnet vision + pdf-parse
      // text grounding. Writes N3Zone rows (verificationStatus='ai_proposed')
      // to `n3_zones`. Idempotent — deletes existing rows before each write.
      await step.run('p4-detect-zones', async () => {
        const exists = await prisma.comparison.findUnique({
          where: { id: comparisonId },
          select: { id: true },
        });
        if (!exists) return { step: 'p4-detect-zones', skipped: true };

        const result = await detectZonesN3(comparisonId, logger);
        logger.info('[n3] p4-detect-zones complete', { comparisonId, ...result });
        return { step: 'p4-detect-zones', ...result };
      });

      // ── Step 3: Phase 5 — Zone Review Gate ───────────────────────────
      // Flips status to AWAITING_ZONE_REVIEW so the UI renders the zone
      // detection review card. Waits for the user to confirm (or the
      // pipeline to be skipped via N3_SKIP_ZONE_REVIEW=true).
      const skipZoneReview = process.env.N3_SKIP_ZONE_REVIEW === 'true';
      if (!skipZoneReview) {
        await step.run('p5-zone-review-flip', async () => {
          await prisma.comparison.update({
            where: { id: comparisonId },
            data: { status: 'AWAITING_ZONE_REVIEW' },
          });
          logger.info('[n3] p5: flipped to AWAITING_ZONE_REVIEW', { comparisonId });
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
          logger.info('[n3] p5: zone review confirmed, resuming', { comparisonId });
          return { step: 'p5-zone-review-resume' };
        });
      } else {
        logger.info('[n3] p5-zone-review-gate: skipped (N3_SKIP_ZONE_REVIEW=true)', { comparisonId });
      }

      // ── Step 4: Phase 6 — Propose Zone Correspondences ────────────────
      // Reads n3_zones rows, calls Sonnet to propose which contractor zones
      // correspond to which adjuster zones. Writes N3ZoneCorrespondence rows
      // (verificationStatus='ai_proposed') to `n3_zone_correspondences`.
      // Correspondences are PRIORS (score boost in Phase 13), not hard walls.
      await step.run('p6-propose-correspondences', async () => {
        const result = await proposeCorrespondencesN3(comparisonId, logger);
        logger.info('[n3] p6-propose-correspondences complete', { comparisonId, ...result });
        return { step: 'p6-propose-correspondences', ...result };
      });

      // ── Step 5: Phase 7 — Correspondence Review Gate ─────────────────
      // Flips status to AWAITING_MATCH_REVIEW so the UI renders the zone
      // correspondence review card. Waits for the user to confirm.
      // Skip via N3_SKIP_ZONE_REVIEW=true (same flag as zone review).
      if (!skipZoneReview) {
        await step.run('p7-correspondence-flip', async () => {
          await prisma.comparison.update({
            where: { id: comparisonId },
            data: { status: 'AWAITING_MATCH_REVIEW' },
          });
          logger.info('[n3] p7: flipped to AWAITING_MATCH_REVIEW', { comparisonId });
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
          logger.info('[n3] p7: correspondence review confirmed, resuming', { comparisonId });
          return { step: 'p7-correspondence-resume' };
        });
      } else {
        logger.info('[n3] p7-correspondence-gate: skipped (N3_SKIP_ZONE_REVIEW=true)', { comparisonId });
      }

      // ── Step 6: Phase 8 — Extract Line Items ─────────────────────────
      // Slices each zone's PDF pages, calls Sonnet vision to extract numbered
      // line items, runs normalizeDescription + tokenizeDescription, and writes
      // N3LineItem rows to `n3_line_items`. Both sides processed independently.
      await step.run('p8-extract-line-items', async () => {
        const result = await extractLineItemsN3(comparisonId, logger);
        logger.info('[n3] p8-extract-line-items complete', { comparisonId, ...result });
        return { step: 'p8-extract-line-items', ...result };
      });

      // ── Step 6.5: Phase 8.5 — Line Item Review Gate ──────────────────
      // Flips status to AWAITING_LINE_ITEM_REVIEW so the UI renders the
      // per-zone item-count review card. Waits for the user to confirm (or
      // trigger a re-extract). On confirm the UI calls
      // POST /api/comparisons/[id]/line-item-review/confirm which fires
      // 'comparison/n3-line-item-review.completed'. On re-extract it fires
      // 'comparison/n3-line-item-reextract.requested' which this step also
      // handles by looping back to p8-extract-line-items before continuing.
      //
      // Skip in automated runs by setting N3_SKIP_LINE_ITEM_REVIEW=true.
      const skipLineItemReview = process.env.N3_SKIP_LINE_ITEM_REVIEW === 'true';
      if (!skipLineItemReview) {
        await step.run('p8-5-line-item-review-flip', async () => {
          await prisma.comparison.update({
            where: { id: comparisonId },
            data: { status: 'AWAITING_LINE_ITEM_REVIEW' },
          });
          logger.info('[n3] p8.5: flipped to AWAITING_LINE_ITEM_REVIEW', { comparisonId });
          return { step: 'p8-5-line-item-review-flip', status: 'waiting' };
        });

        const reviewEvent = await step.waitForEvent('p8-5-line-item-review-gate', {
          event: 'comparison/n3-line-item-review.completed',
          timeout: '24h',
          match: 'data.comparisonId',
        });

        if (reviewEvent?.data?.action === 'reextract') {
          // User flagged missing items — re-run Phase 8 before continuing.
          await step.run('p8-reextract-line-items', async () => {
            await prisma.comparison.update({
              where: { id: comparisonId },
              data: { status: 'PROCESSING' },
            });
            const result = await extractLineItemsN3(comparisonId, logger, reviewEvent.data.reextractSource);
            logger.info('[n3] p8-reextract-line-items complete', { comparisonId, ...result });
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

      // ── Step 7: Phase 9 — Normalize Line Items ────────────────────────
      // Pure deterministic normalization — no LLM. Fills normalizedQuantity,
      // normalizedUnit, specialFlags, trade, action on every n3_line_items row
      // using the Phase 0 helpers + local keyword classifiers.
      await step.run('p9-normalize-line-items', async () => {
        const result = await normalizeLineItemsN3(comparisonId, logger);
        logger.info('[n3] p9-normalize-line-items complete', { comparisonId, ...result });
        return { step: 'p9-normalize-line-items', ...result };
      });

      // ── Step 8: Phase 10 — Extraction Validation ─────────────────────
      await step.run('p10-extraction-validation', async () => {
        const result = await validateExtractionN3(comparisonId, logger);
        return { step: 'p10-extraction-validation', ...result };
      });

      // ── Step 9: Phase 11 — Generate Embeddings ────────────────────────
      // Voyage AI voyage-3-lite: 512-dim vectors for each normalizedDescription.
      // Vectors written to n3_line_items.embedding via raw SQL (pgvector type).
      // Idempotent — skips rows that already have embeddings unless force=true.
      await step.run('p11-generate-embeddings', async () => {
        const result = await generateEmbeddingsN3(comparisonId, logger, force);
        logger.info('[n3] p11-generate-embeddings complete', { comparisonId, ...result });
        return { step: 'p11-generate-embeddings', ...result };
      });

      // ── Step 10: Phase 12 — Generate Candidate Edges ─────────────────
      // Five retrieval sources implemented in v1: ai_proposed_zone, semantic
      // (cosine ANN), fuzzy_description (Jaccard), total_similarity, item_code.
      // Sources are unioned and deduplicated; placeholder feature/score values
      // are written for Phase 13 to overwrite.
      await step.run('p12-generate-candidates', async () => {
        const result = await generateCandidatesN3(comparisonId, logger);
        logger.info('[n3] p12-generate-candidates complete', { comparisonId, ...result });
        return { step: 'p12-generate-candidates', ...result };
      });

      // ── Step 11: Phase 13 — Score Candidates ─────────────────────────
      const p13Result = await step.run('p13-score-candidates', async () => {
        return scoreCandidatesN3(comparisonId, logger);
      });
      logger.info('[n3] p13-score-candidates complete', {
        comparisonId,
        scoredCount: p13Result.scoredCount,
        rejectedCount: p13Result.rejectedCount,
        byBucket: p13Result.byBucket,
      });

      // ── Step 12: Phase 14 — Build Connected Components ───────────────────
      const p14Result = await step.run('p14-build-components', async () => {
        return buildComponentsN3(comparisonId, logger);
      });
      logger.info('[n3] p14-build-components complete', {
        comparisonId,
        componentCount: p14Result.componentCount,
        bySize: p14Result.bySize,
        singletonYours: p14Result.singletonYours,
        singletonAdj: p14Result.singletonAdj,
      });

      // ── Step 13: Phase 15 — Assign Matches ───────────────────────────────
      const p15Result = await step.run('p15-assign-matches', async () => {
        return assignMatchesN3(comparisonId, logger);
      });
      logger.info('[n3] p15-assign-matches complete', {
        comparisonId,
        decisionCount:   p15Result.decisionCount,
        matchedCount:    p15Result.matchedCount,
        possibleCount:   p15Result.possibleCount,
        unmatchedYours:  p15Result.unmatchedYours,
        unmatchedAdj:    p15Result.unmatchedAdj,
        zoneRepairCount: p15Result.zoneRepairCount,
      });

      // ── Step 14: Phase 16 — Group Matching ───────────────────────────────
      const p16Result = await step.run('p16-group-matching', async () => {
        return groupMatchingN3(comparisonId, logger);
      });
      logger.info('[n3] p16-group-matching complete', {
        comparisonId,
        groupedCount:    p16Result.groupedCount,
        relinquishedAdj: p16Result.relinquishedAdj,
      });

      // ── Step 15: Phase 17 — LLM Adjudication ─────────────────────────────
      const p17Result = await step.run('p17-llm-adjudication', async () => {
        return llmAdjudicationN3(comparisonId, logger);
      });
      logger.info('[n3] p17-llm-adjudication complete', {
        comparisonId,
        adjudicatedCount:  p17Result.adjudicatedCount,
        acceptedCount:     p17Result.acceptedCount,
        rejectedCount:     p17Result.rejectedCount,
        autoRejectedCount: p17Result.autoRejectedCount,
        skipped:           p17Result.skipped,
      });

      // ── Step 16: Phase 18 — Persist Decisions ────────────────────────────
      const finalResult = await step.run('p18-persist-decisions', async () => {
        return persistDecisionsN3(comparisonId, logger, trigger ?? 'unknown');
      });
      logger.info('[n3] p18-persist-decisions complete', {
        comparisonId,
        lineItemCount:  finalResult.lineItemCount,
        matchCount:     finalResult.matchCount,
        modifiedCount:  finalResult.modifiedCount,
        missingCount:   finalResult.missingCount,
        addedCount:     finalResult.addedCount,
        groupedCount:   finalResult.groupedCount,
        totalGap:       finalResult.totalGap,
      });

      // ── Step 17: Dump metrics snapshot to disk (dev analysis) ────────────
      await step.run('dump-metrics-snapshot', async () => {
        if (process.env.NODE_ENV !== 'production') {
          try {
            const { computePipelineMetrics } = await import('@/lib/n3/metrics/compute-metrics');
            const fs = await import('fs');
            const path = await import('path');
            const metrics = await computePipelineMetrics(comparisonId);
            if (metrics) {
              const dir = path.resolve(process.cwd(), 'run-results');
              fs.mkdirSync(dir, { recursive: true });
              const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}_${comparisonId.slice(0, 8)}.json`;
              fs.writeFileSync(path.join(dir, filename), JSON.stringify(metrics, null, 2));
              fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(metrics, null, 2));
              logger.info('[n3] metrics snapshot written', { file: filename });
            }
          } catch (err) {
            logger.warn('[n3] metrics snapshot failed (non-fatal)', { err: String(err) });
          }
        }
        return { step: 'dump-metrics-snapshot' };
      });

      logger.info('[n3] process-comparison-v3 completed', {
        comparisonId,
        finalResult,
      });
      return finalResult;

    } catch (error) {
      const message =
        error instanceof Error ? error.message.slice(0, 400) : 'Unknown N3 processing error.';

      await step.run('mark-failed', async () => {
        try {
          await prisma.comparison.update({
            where: { id: comparisonId },
            data: { status: 'FAILED', errorMessage: `[N3] ${message}` },
          });
        } catch {
          // Comparison may have been deleted — ignore Prisma not-found errors
        }
        logger.error('[n3] comparison flipped to FAILED after exhausted retries', {
          comparisonId,
          message,
        });
        return { step: 'mark-failed', message };
      });

      throw error;
    }
  },
);
