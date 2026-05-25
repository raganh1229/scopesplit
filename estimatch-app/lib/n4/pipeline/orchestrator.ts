// ─────────────────────────────────────────────────────────────────────────────
// N4 Pipeline — Orchestrator
//
// Provides typed wrappers that the Inngest function calls as step bodies.
// Each wrapper resolves the correct Extractor for each side (based on the
// user-selected format stored on the Comparison row), then dispatches both
// sides in parallel.
//
// Format-agnostic phases (normalize → embeddings → candidates → scoring →
// components → assignment → group-matching → LLM adjudication → persist)
// are imported directly from lib/n3/passes/* — they are NOT duplicated.
//
// Architecture: SHARED model
//   • Format-specific:  extractors/* (detect-zones + extract-line-items per side)
//   • Format-agnostic:  all N3 phases from Phase 9 onward (untouched imports)
// ─────────────────────────────────────────────────────────────────────────────

import prisma from '@/lib/prisma';
import { resolveExtractor } from '@/lib/n4/extractors/registry';
import type { StepLogger } from '@/lib/n4/extractors/types';

// ── Helper: load formats from DB ─────────────────────────────────────────────

async function loadFormats(comparisonId: string): Promise<{
  yoursFormat: string;
  adjusterFormat: string;
}> {
  const row = await prisma.comparison.findUnique({
    where: { id: comparisonId },
    select: { yourEstimateFormat: true, adjusterEstimateFormat: true },
  });
  if (!row) throw new Error(`[n4/orchestrator] Comparison ${comparisonId} not found`);
  return {
    yoursFormat:    row.yourEstimateFormat    ?? 'unknown',
    adjusterFormat: row.adjusterEstimateFormat ?? 'unknown',
  };
}

// ── Phase 4 dispatcher ────────────────────────────────────────────────────────

export type DetectZonesBothResult = {
  yours: { zoneCount: number; flat: boolean; detectedFormat: string };
  adjuster: { zoneCount: number; flat: boolean; detectedFormat: string };
};

/**
 * Run zone detection for both sides in parallel.
 * Each side uses its own format-specific extractor.
 * Called inside the 'p4-detect-zones' Inngest step.
 */
export async function orchestrateDetectZones(
  comparisonId: string,
  logger: StepLogger,
): Promise<DetectZonesBothResult> {
  const { yoursFormat, adjusterFormat } = await loadFormats(comparisonId);

  logger.info('[n4/orchestrator] Dispatching zone detection', {
    comparisonId,
    yoursFormat,
    adjusterFormat,
  });

  const yoursExtractor    = resolveExtractor(yoursFormat);
  const adjusterExtractor = resolveExtractor(adjusterFormat);

  const [yoursResult, adjusterResult] = await Promise.all([
    yoursExtractor.detectZones(comparisonId, 'yours', logger),
    adjusterExtractor.detectZones(comparisonId, 'adjuster', logger),
  ]);

  logger.info('[n4/orchestrator] Zone detection complete', {
    comparisonId,
    yoursZones:    yoursResult.zoneCount,
    adjusterZones: adjusterResult.zoneCount,
    yoursFlat:     yoursResult.flat,
    adjusterFlat:  adjusterResult.flat,
    yoursDetected:    yoursResult.detectedFormat,
    adjusterDetected: adjusterResult.detectedFormat,
  });

  return { yours: yoursResult, adjuster: adjusterResult };
}

// ── Phase 8 dispatcher ────────────────────────────────────────────────────────

export type ExtractLineItemsBothResult = {
  yours: { itemCount: number };
  adjuster: { itemCount: number };
};

/**
 * Run line item extraction for both sides in parallel.
 * Each side uses its own format-specific extractor.
 * Called inside the 'p8-extract-line-items' Inngest step.
 *
 * @param reextractSource  When re-extracting after the line-item review gate,
 *   the UI specifies which side(s) to re-run. Passed through to extractors.
 */
export async function orchestrateExtractLineItems(
  comparisonId: string,
  logger: StepLogger,
  reextractSource?: 'yours' | 'adjuster' | 'both',
): Promise<ExtractLineItemsBothResult> {
  const { yoursFormat, adjusterFormat } = await loadFormats(comparisonId);

  logger.info('[n4/orchestrator] Dispatching line item extraction', {
    comparisonId,
    yoursFormat,
    adjusterFormat,
    reextractSource: reextractSource ?? 'both',
  });

  const yoursExtractor    = resolveExtractor(yoursFormat);
  const adjusterExtractor = resolveExtractor(adjusterFormat);

  // When re-extracting only one side, skip the other to preserve its rows.
  const [yoursResult, adjusterResult] = await Promise.all([
    (reextractSource === 'adjuster')
      ? Promise.resolve({ itemCount: 0 })
      : yoursExtractor.extractLineItems(comparisonId, 'yours', logger, reextractSource),
    (reextractSource === 'yours')
      ? Promise.resolve({ itemCount: 0 })
      : adjusterExtractor.extractLineItems(comparisonId, 'adjuster', logger, reextractSource),
  ]);

  logger.info('[n4/orchestrator] Line item extraction complete', {
    comparisonId,
    yoursItems:    yoursResult.itemCount,
    adjusterItems: adjusterResult.itemCount,
  });

  return { yours: yoursResult, adjuster: adjusterResult };
}
