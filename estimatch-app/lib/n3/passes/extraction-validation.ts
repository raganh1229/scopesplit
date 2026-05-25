// ─────────────────────────────────────────────────────────────────────────────
// N3 Pipeline — Phase 10: extraction-validation
//
// Runs after Phase 9 normalization. Compares the actual extracted item counts
// per zone against the `approxItems` estimate recorded by Phase 4 zone
// detection, and flags individual items with suspicious financial data.
//
// Warning types written to N3ExtractionWarning:
//   item_count_delta   — Zone extracted count differs from approxItems by more
//                        than ITEM_COUNT_DELTA_THRESHOLD (default 30 %).
//   missing_total      — N3LineItem has component amounts (remove/replace/tax/
//                        op) that sum to a non-zero value but totalAmount is
//                        null, indicating a failed amount parse.
//   low_confidence     — extractionConfidence < LOW_CONFIDENCE_THRESHOLD (0.5).
//
// Idempotent: deletes existing warnings for the comparison before re-inserting,
// so the step can be retried safely by Inngest.
//
// Architecture refs: N3.md §Phase 10, OUTSTANDING_WORK.md §N3-3
// ─────────────────────────────────────────────────────────────────────────────

import prisma from '@/lib/prisma';
import type { StepLogger } from '@/lib/n3/passes/detect-zones';

const ITEM_COUNT_DELTA_THRESHOLD = 0.3;
const LOW_CONFIDENCE_THRESHOLD = 0.5;

export type ExtractionValidationN3Result = {
  zonesChecked: number;
  itemCountWarnings: number;
  missingTotalWarnings: number;
  lowConfidenceWarnings: number;
  totalWarnings: number;
};

type WarningInput = {
  comparisonId: string;
  source: string;
  warningType: string;
  pageNumber?: number;
  lineItemId?: string;
  zoneId?: string;
  detail: string;
};

/**
 * Validate extraction completeness for all zones in a comparison and write
 * N3ExtractionWarning rows for anomalies found.
 *
 * Idempotent: prior warnings for this comparison are deleted before re-insert.
 * Throws on unrecoverable error — the calling Inngest step will retry.
 */
export async function validateExtractionN3(
  comparisonId: string,
  logger: StepLogger,
): Promise<ExtractionValidationN3Result> {
  // ── 1. Load zones with their extracted item counts ─────────────────────────
  const zones = await prisma.n3Zone.findMany({
    where: { comparisonId },
    select: {
      id: true,
      source: true,
      name: true,
      approxItems: true,
      _count: { select: { lineItems: true } },
    },
  });

  // ── 2. Load all line items for financial + confidence checks ───────────────
  const lineItems = await prisma.n3LineItem.findMany({
    where: { comparisonId },
    select: {
      id: true,
      source: true,
      zoneId: true,
      pageNumber: true,
      removeAmount: true,
      replaceAmount: true,
      taxAmount: true,
      opAmount: true,
      totalAmount: true,
      extractionConfidence: true,
    },
  });

  const warnings: WarningInput[] = [];

  // ── 3. Item count delta warnings ───────────────────────────────────────────
  for (const zone of zones) {
    const extracted = zone._count.lineItems;
    const approx = zone.approxItems;

    if (approx > 0) {
      const delta = Math.abs(extracted - approx) / approx;
      if (delta > ITEM_COUNT_DELTA_THRESHOLD) {
        warnings.push({
          comparisonId,
          source: zone.source,
          warningType: 'item_count_delta',
          zoneId: zone.id,
          detail:
            `Zone "${zone.name}" (${zone.source}): expected ~${approx} items, ` +
            `extracted ${extracted} (${Math.round(delta * 100)}% delta).`,
        });
      }
    } else if (extracted === 0) {
      warnings.push({
        comparisonId,
        source: zone.source,
        warningType: 'item_count_delta',
        zoneId: zone.id,
        detail: `Zone "${zone.name}" (${zone.source}): no items extracted and approxItems=0.`,
      });
    }
  }

  // ── 4. Missing total + low confidence warnings per line item ───────────────
  for (const item of lineItems) {
    const componentSum =
      toNumber(item.removeAmount) +
      toNumber(item.replaceAmount) +
      toNumber(item.taxAmount) +
      toNumber(item.opAmount);

    if (componentSum > 0 && item.totalAmount === null) {
      warnings.push({
        comparisonId,
        source: item.source,
        warningType: 'missing_total',
        pageNumber: item.pageNumber,
        lineItemId: item.id,
        zoneId: item.zoneId ?? undefined,
        detail:
          `Item has component amounts summing to ${componentSum.toFixed(2)} but totalAmount is null.`,
      });
    }

    if (toNumber(item.extractionConfidence) < LOW_CONFIDENCE_THRESHOLD) {
      warnings.push({
        comparisonId,
        source: item.source,
        warningType: 'low_confidence',
        pageNumber: item.pageNumber,
        lineItemId: item.id,
        zoneId: item.zoneId ?? undefined,
        detail:
          `Extraction confidence ${toNumber(item.extractionConfidence).toFixed(2)} is below threshold ${LOW_CONFIDENCE_THRESHOLD}.`,
      });
    }
  }

  // ── 5. Persist warnings (idempotent: delete-then-insert) ──────────────────
  await prisma.$transaction([
    prisma.n3ExtractionWarning.deleteMany({ where: { comparisonId } }),
    ...(warnings.length > 0
      ? [
          prisma.n3ExtractionWarning.createMany({
            data: warnings.map((w) => ({
              comparisonId: w.comparisonId,
              source: w.source,
              warningType: w.warningType,
              pageNumber: w.pageNumber ?? null,
              lineItemId: w.lineItemId ?? null,
              zoneId: w.zoneId ?? null,
              detail: w.detail,
            })),
          }),
        ]
      : []),
  ]);

  const itemCountWarnings = warnings.filter((w) => w.warningType === 'item_count_delta').length;
  const missingTotalWarnings = warnings.filter((w) => w.warningType === 'missing_total').length;
  const lowConfidenceWarnings = warnings.filter((w) => w.warningType === 'low_confidence').length;

  logger.info('[n3] p10-extraction-validation: complete', {
    comparisonId,
    zonesChecked: zones.length,
    itemCountWarnings,
    missingTotalWarnings,
    lowConfidenceWarnings,
    totalWarnings: warnings.length,
  });

  return {
    zonesChecked: zones.length,
    itemCountWarnings,
    missingTotalWarnings,
    lowConfidenceWarnings,
    totalWarnings: warnings.length,
  };
}

function toNumber(v: unknown): number {
  if (v === null || v === undefined) return 0;
  return Number(v);
}
