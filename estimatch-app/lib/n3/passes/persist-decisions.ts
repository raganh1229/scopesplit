// ─────────────────────────────────────────────────────────────────────────────
// N3 Pipeline — Phase 18: persist-decisions
//
// Projects N3MatchDecision rows onto the existing `LineItem` table so the
// comparison page can display N3 results without any UI changes.
//
// Decision → MatchStatus mapping:
//   one_to_one (amounts equal ±1%)  → MATCH
//   one_to_one (amounts differ)     → MODIFIED
//   grouped                         → GROUPED
//   unmatched  (yourItemIds only)   → MISSING_FROM_ADJUSTER
//   orphaned adj (no decision)      → ADDED_BY_ADJUSTER
//
// Algorithm:
//   1. Load all N3MatchDecision rows for the comparison.
//   2. Load all N3LineItem rows with zone data.
//   3. Load all N3Zone rows for zone name lookups.
//   4. Detect orphaned adj items (adj items not referenced by any decision).
//   5. Build PersistableLineItem rows in zone/page order.
//   6. Compute aggregates (totals, counts).
//   7. Atomic transaction: deleteMany existing + createMany new + update Comparison.
//   8. Return stats.
//
// Idempotent: deleteMany before createMany makes retries safe.
//
// Architecture refs: N3.md §Phase 18, §A.1 (output table unchanged).
// ─────────────────────────────────────────────────────────────────────────────

import prisma from '@/lib/prisma';
import type { StepLogger } from '@/lib/n3/passes/detect-zones';

// ── Return type ───────────────────────────────────────────────────────────────

export type PersistDecisionsN3Result = {
  lineItemCount:   number;
  matchCount:      number;
  modifiedCount:   number;
  missingCount:    number;
  addedCount:      number;
  groupedCount:    number;
  totalGap:        number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function toDecimalOrNull(v: { toNumber?: () => number } | null | undefined): number | null {
  if (v == null) return null;
  return typeof v.toNumber === 'function' ? v.toNumber() : Number(v);
}

function toNum(v: { toNumber?: () => number } | null | undefined): number {
  if (v == null) return 0;
  return typeof v.toNumber === 'function' ? v.toNumber() : Number(v);
}

function formatQty(qty: { toNumber?: () => number } | null | undefined, unit: string | null | undefined): string | null {
  const q = qty != null ? Number(qty).toString() : null;
  if (!q) return null;
  return unit ? `${q} ${unit}` : q;
}

/** ±1% tolerance for MATCH vs MODIFIED classification. */
function amountsMatch(a: { toNumber?: () => number } | null | undefined, b: { toNumber?: () => number } | null | undefined): boolean {
  const na = a != null ? Number(a) : null;
  const nb = b != null ? Number(b) : null;
  if (na === null || nb === null) return false;
  if (na === 0 && nb === 0) return true;
  const denom = Math.max(Math.abs(na), Math.abs(nb));
  if (denom === 0) return true;
  return Math.abs(na - nb) / denom < 0.01;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function persistDecisionsN3(
  comparisonId: string,
  logger: StepLogger,
): Promise<PersistDecisionsN3Result> {

  // ── 1. Load decisions ──────────────────────────────────────────────────────
  const decisions = await prisma.n3MatchDecision.findMany({
    where: { comparisonId },
    select: {
      id: true,
      decisionType: true,
      yourItemIds: true,
      adjusterItemIds: true,
      finalScore: true,
      componentId: true,
    },
  });

  if (decisions.length === 0) {
    logger.warn('[n3/persist-decisions] no decisions found — nothing to persist', { comparisonId });
    return { lineItemCount: 0, matchCount: 0, modifiedCount: 0, missingCount: 0, addedCount: 0, groupedCount: 0, totalGap: 0 };
  }

  // ── 2. Load N3LineItems with zone ──────────────────────────────────────────
  const n3Items = await prisma.n3LineItem.findMany({
    where: { comparisonId },
    select: {
      id: true, source: true, zoneId: true,
      rawDescription: true, normalizedUnit: true,
      normalizedQuantity: true, rawQuantity: true,
      removeAmount: true, replaceAmount: true, resetAmount: true,
      taxAmount: true, opAmount: true, totalAmount: true,
      pageNumber: true, sourceLineNumber: true,
    },
  });
  const itemMap = new Map(n3Items.map(i => [i.id, i]));

  // ── 3. Load N3Zones for zone name lookups ──────────────────────────────────
  const zones = await prisma.n3Zone.findMany({
    where: { comparisonId },
    select: { id: true, name: true, normalizedName: true, source: true },
  });
  const zoneMap = new Map(zones.map(z => [z.id, z]));

  // ── 4. Detect orphaned items on both sides ─────────────────────────────────
  const claimedAdjIds   = new Set(decisions.flatMap(d => d.adjusterItemIds));
  const claimedYoursIds = new Set(decisions.flatMap(d => d.yourItemIds));
  const adjItemIds    = new Set(n3Items.filter(i => i.source === 'adjuster').map(i => i.id));
  const yoursItemIds  = new Set(n3Items.filter(i => i.source === 'yours').map(i => i.id));
  const orphanedAdjIds   = [...adjItemIds].filter(id => !claimedAdjIds.has(id));
  const orphanedYoursIds = [...yoursItemIds].filter(id => !claimedYoursIds.has(id));

  logger.info('[n3/persist-decisions] loaded', {
    comparisonId,
    decisions: decisions.length,
    orphanedAdj: orphanedAdjIds.length,
    orphanedYours: orphanedYoursIds.length,
  });

  // ── 5. Build LineItem rows ─────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = [];

  let sortOrder    = 0;
  let matchCount   = 0;
  let modifiedCount = 0;
  let missingCount = 0;
  let addedCount   = 0;
  let groupedCount = 0;
  let totalYoursAcc   = 0;
  let totalAdjAcc     = 0;

  // Sort decisions: yours items first, in page/line order
  const sortedDecisions = [...decisions].sort((a, b) => {
    const ya = a.yourItemIds[0] ? itemMap.get(a.yourItemIds[0]) : null;
    const yb = b.yourItemIds[0] ? itemMap.get(b.yourItemIds[0]) : null;
    const pageA = ya ? ya.pageNumber * 10000 + ya.sourceLineNumber : 999999;
    const pageB = yb ? yb.pageNumber * 10000 + yb.sourceLineNumber : 999999;
    return pageA - pageB;
  });

  for (const decision of sortedDecisions) {
    const yours = decision.yourItemIds[0] ? itemMap.get(decision.yourItemIds[0]) : null;
    const adj   = decision.adjusterItemIds[0] ? itemMap.get(decision.adjusterItemIds[0]) : null;

    const yoursZone = yours?.zoneId ? zoneMap.get(yours.zoneId) : null;
    const adjZone   = adj?.zoneId   ? zoneMap.get(adj.zoneId)   : null;

    const totalYours = yours ? toNum(yours.totalAmount) : 0;
    const totalAdj   = adj   ? toNum(adj.totalAmount)   : 0;

    const diffAmount = adj && yours
      ? totalAdj - totalYours
      : adj   ? totalAdj
      : yours ? -totalYours
      : 0;

    // MatchStatus classification
    let matchStatus: 'MATCH' | 'MODIFIED' | 'MISSING_FROM_ADJUSTER' | 'ADDED_BY_ADJUSTER' | 'GROUPED';
    switch (decision.decisionType) {
      case 'one_to_one':
        matchStatus = amountsMatch(yours?.totalAmount, adj?.totalAmount) ? 'MATCH' : 'MODIFIED';
        break;
      case 'grouped':
        matchStatus = 'GROUPED';
        break;
      case 'unmatched':
        matchStatus = decision.yourItemIds.length > 0 ? 'MISSING_FROM_ADJUSTER' : 'ADDED_BY_ADJUSTER';
        break;
      default:
        // possible (defensive — shouldn't reach here after Phase 17)
        matchStatus = 'MODIFIED';
    }

    // Accumulators
    if (yours) totalYoursAcc += totalYours;
    if (adj)   totalAdjAcc   += totalAdj;

    switch (matchStatus) {
      case 'MATCH':    matchCount++;    break;
      case 'MODIFIED': modifiedCount++; break;
      case 'GROUPED':  groupedCount++;  break;
      case 'MISSING_FROM_ADJUSTER': missingCount++; break;
      case 'ADDED_BY_ADJUSTER':     addedCount++;   break;
    }

    // For grouped decisions, collapse adj items into a summary adj description
    let adjDesc: string | null = adj?.rawDescription ?? null;
    let adjQty:  string | null = adj ? formatQty(adj.normalizedQuantity, adj.normalizedUnit) : null;
    if (decision.decisionType === 'grouped' && decision.adjusterItemIds.length > 1) {
      const adjItems = decision.adjusterItemIds.map(id => itemMap.get(id)).filter(Boolean) as NonNullable<ReturnType<typeof itemMap.get>>[];
      adjDesc = adjItems.map(a => a.rawDescription).join(' + ');
      adjQty  = adjItems.map(a => formatQty(a.normalizedQuantity, a.normalizedUnit)).filter(Boolean).join(' + ');
      const adjTotal = adjItems.reduce((s, a) => s + toNum(a.totalAmount), 0);
      totalAdjAcc += adjTotal - totalAdj;  // replace single adj total with combined
    }

    rows.push({
      comparisonId,
      matchStatus,
      zoneYours:       yoursZone?.name ?? null,
      zoneAdjuster:    adjZone?.name ?? null,
      zoneCanonical:   yoursZone?.normalizedName ?? adjZone?.normalizedName ?? null,
      zoneConfidence:  null,
      descriptionYours:    yours?.rawDescription ?? null,
      descriptionAdjuster: adjDesc,
      qtyYours:    yours ? formatQty(yours.normalizedQuantity, yours.normalizedUnit) : null,
      qtyAdjuster: adjQty,
      unitYours:   yours?.normalizedUnit ?? null,
      unitAdjuster: adj?.normalizedUnit ?? null,
      removeYours:  toDecimalOrNull(yours?.removeAmount),
      removeAdjuster: toDecimalOrNull(adj?.removeAmount),
      replaceYours:  toDecimalOrNull(yours?.replaceAmount),
      replaceAdjuster: toDecimalOrNull(adj?.replaceAmount),
      resetYours:  toDecimalOrNull(yours?.resetAmount),
      resetAdjuster: toDecimalOrNull(adj?.resetAmount),
      taxYours:  toDecimalOrNull(yours?.taxAmount),
      taxAdjuster: toDecimalOrNull(adj?.taxAmount),
      opYours:  toDecimalOrNull(yours?.opAmount),
      opAdjuster: toDecimalOrNull(adj?.opAmount),
      totalYours:  toDecimalOrNull(yours?.totalAmount),
      totalAdjuster: toDecimalOrNull(adj?.totalAmount),
      diffAmount:  Number(diffAmount.toFixed(2)),
      category:   null,
      sortOrder:  sortOrder++,
      groupId:    null,
    });
  }

  // ── 5b. Orphaned yours items → MISSING_FROM_ADJUSTER ──────────────────────
  // Contractor items with no decision (Phase 15/16 silently dropped them).
  // Defensive fallback — ensures every extracted item is persisted.
  const sortedOrphanedYours = orphanedYoursIds
    .map(id => itemMap.get(id))
    .filter(Boolean) as NonNullable<ReturnType<typeof itemMap.get>>[];
  sortedOrphanedYours.sort((a, b) =>
    (a.pageNumber * 10000 + a.sourceLineNumber) - (b.pageNumber * 10000 + b.sourceLineNumber)
  );

  for (const yours of sortedOrphanedYours) {
    const yoursZone = yours.zoneId ? zoneMap.get(yours.zoneId) : null;
    const totalYours = toNum(yours.totalAmount);
    totalYoursAcc += totalYours;
    missingCount++;

    rows.push({
      comparisonId,
      matchStatus: 'MISSING_FROM_ADJUSTER',
      zoneYours:       yoursZone?.name ?? null,
      zoneAdjuster:    null,
      zoneCanonical:   yoursZone?.normalizedName ?? null,
      zoneConfidence:  null,
      descriptionYours:    yours.rawDescription,
      descriptionAdjuster: null,
      qtyYours:    formatQty(yours.normalizedQuantity, yours.normalizedUnit),
      qtyAdjuster: null,
      unitYours:   yours.normalizedUnit ?? null,
      unitAdjuster: null,
      removeYours:  toDecimalOrNull(yours.removeAmount),
      removeAdjuster: null,
      replaceYours:  toDecimalOrNull(yours.replaceAmount),
      replaceAdjuster: null,
      resetYours:  toDecimalOrNull(yours.resetAmount),
      resetAdjuster: null,
      taxYours:  toDecimalOrNull(yours.taxAmount),
      taxAdjuster: null,
      opYours:  toDecimalOrNull(yours.opAmount),
      opAdjuster: null,
      totalYours:  toDecimalOrNull(yours.totalAmount),
      totalAdjuster: null,
      diffAmount:  Number((-totalYours).toFixed(2)),
      category:   null,
      sortOrder:  sortOrder++,
      groupId:    null,
    });
  }

  // ── 5c. Orphaned adj items → ADDED_BY_ADJUSTER ────────────────────────────
  const sortedOrphanedAdj = orphanedAdjIds
    .map(id => itemMap.get(id))
    .filter(Boolean) as NonNullable<ReturnType<typeof itemMap.get>>[];
  sortedOrphanedAdj.sort((a, b) =>
    (a.pageNumber * 10000 + a.sourceLineNumber) - (b.pageNumber * 10000 + b.sourceLineNumber)
  );

  for (const adj of sortedOrphanedAdj) {
    const adjZone = adj.zoneId ? zoneMap.get(adj.zoneId) : null;
    const totalAdj = toNum(adj.totalAmount);
    totalAdjAcc += totalAdj;
    addedCount++;

    rows.push({
      comparisonId,
      matchStatus: 'ADDED_BY_ADJUSTER',
      zoneYours:       null,
      zoneAdjuster:    adjZone?.name ?? null,
      zoneCanonical:   adjZone?.normalizedName ?? null,
      zoneConfidence:  null,
      descriptionYours:    null,
      descriptionAdjuster: adj.rawDescription,
      qtyYours:    null,
      qtyAdjuster: formatQty(adj.normalizedQuantity, adj.normalizedUnit),
      unitYours:   null,
      unitAdjuster: adj.normalizedUnit ?? null,
      removeYours:  null,
      removeAdjuster: toDecimalOrNull(adj.removeAmount),
      replaceYours:  null,
      replaceAdjuster: toDecimalOrNull(adj.replaceAmount),
      resetYours:  null,
      resetAdjuster: toDecimalOrNull(adj.resetAmount),
      taxYours:  null,
      taxAdjuster: toDecimalOrNull(adj.taxAmount),
      opYours:  null,
      opAdjuster: toDecimalOrNull(adj.opAmount),
      totalYours:  null,
      totalAdjuster: toDecimalOrNull(adj.totalAmount),
      diffAmount:  Number(totalAdj.toFixed(2)),
      category:   null,
      sortOrder:  sortOrder++,
      groupId:    null,
    });
  }

  const totalGap = totalAdjAcc - totalYoursAcc;

  logger.info('[n3/persist-decisions] writing line items', {
    comparisonId,
    lineItemCount: rows.length,
    matchCount,
    modifiedCount,
    missingCount,
    addedCount,
    groupedCount,
    totalGap: totalGap.toFixed(2),
  });

  // ── 6. Atomic persist ──────────────────────────────────────────────────────
  try {
    await prisma.$transaction([
      prisma.lineItem.deleteMany({ where: { comparisonId } }),
      prisma.lineItem.createMany({ data: rows }),
      prisma.comparison.update({
        where: { id: comparisonId },
        data: {
          status:               'COMPLETED',
          totalGap:             Number(totalGap.toFixed(2)),
          yourEstimateTotal:    Number(totalYoursAcc.toFixed(2)),
          adjusterEstimateTotal: Number(totalAdjAcc.toFixed(2)),
          matchCount,
          modifiedCount,
          missingCount,
          addedCount,
        },
      }),
    ]);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'P2025' || code === 'P2003') {
      logger.warn('[n3/persist-decisions] comparison deleted mid-flight — skipping', { comparisonId, code });
      return { lineItemCount: 0, matchCount: 0, modifiedCount: 0, missingCount: 0, addedCount: 0, groupedCount: 0, totalGap: 0 };
    }
    throw err;
  }

  logger.info('[n3/persist-decisions] complete', {
    comparisonId,
    lineItemCount: rows.length,
    matchCount,
    modifiedCount,
    missingCount,
    addedCount,
    groupedCount,
    totalGap: totalGap.toFixed(2),
  });

  return { lineItemCount: rows.length, matchCount, modifiedCount, missingCount, addedCount, groupedCount, totalGap };
}
