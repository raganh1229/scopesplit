// ─────────────────────────────────────────────────────────────────────────────
// N3 Verification Dashboard — Metrics computation engine
//
// Reads all n3_* tables for a given comparison and produces the full
// N3DashboardMetrics blob. No writes. Designed to run in <500ms for a
// 150-item / 3,400-edge comparison.
// ─────────────────────────────────────────────────────────────────────────────

import prisma from '@/lib/prisma';
import { SCORE_WEIGHTS, SCORE_THRESHOLDS, COMPONENT_SIZE } from '@/lib/n3/constants';
import type {
  N3DashboardMetrics, PhaseSummary, FeatureStats, DecisionDetail,
  Phase4Metrics, Phase6Metrics, Phase8Metrics, Phase9Metrics,
  Phase11Metrics, Phase12Metrics, Phase13Metrics, Phase14Metrics,
  Phase15Metrics, Phase16Metrics, Phase17Metrics, Phase18Metrics,
} from './types';

// ── Helpers ───────────────────────────────────────────────────────────────────

const num = (v: { toNumber?: () => number } | null | undefined): number => {
  if (v == null) return 0;
  return typeof v.toNumber === 'function' ? v.toNumber() : Number(v);
};

const numOrNull = (v: { toNumber?: () => number } | null | undefined): number | null => {
  if (v == null) return null;
  return typeof v.toNumber === 'function' ? v.toNumber() : Number(v);
};

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function std(arr: number[]): number {
  if (arr.length === 0) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

function histogram(values: number[], min: number, max: number, bins: number): number[] {
  const out = new Array(bins).fill(0);
  const range = max - min;
  for (const v of values) {
    if (v < min || v > max) continue;
    let i = Math.floor(((v - min) / range) * bins);
    if (i >= bins) i = bins - 1;
    out[i]++;
  }
  return out;
}

function topN<T extends string>(items: T[], n = 5): Array<{ value: T; count: number }> {
  const counts = new Map<T, number>();
  for (const i of items) counts.set(i, (counts.get(i) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function computePipelineMetrics(comparisonId: string): Promise<N3DashboardMetrics | null> {
  // Verify comparison exists
  const cmp = await prisma.comparison.findUnique({
    where: { id: comparisonId },
    select: { id: true },
  });
  if (!cmp) return null;

  // Load everything we need in parallel
  const [zones, correspondences, lineItems, edges, components, decisions, llmCalls] = await Promise.all([
    prisma.n3Zone.findMany({ where: { comparisonId } }),
    prisma.n3ZoneCorrespondence.findMany({
      where: { comparisonId },
      include: { yourZones: true, adjusterZones: true },
    }),
    prisma.n3LineItem.findMany({ where: { comparisonId } }),
    prisma.n3CandidateEdge.findMany({ where: { comparisonId } }),
    prisma.n3MatchComponent.findMany({
      where: { comparisonId },
      include: { _count: { select: { edges: true } } },
    }),
    prisma.n3MatchDecision.findMany({ where: { comparisonId } }),
    prisma.n3LlmCall.findMany({ where: { comparisonId } }),
  ]);

  // Index lookups
  const itemMap = new Map(lineItems.map(i => [i.id, i]));

  // Pre-check whether embeddings were written (by querying raw count)
  let embeddedCount = 0;
  try {
    const result = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint as count FROM n3_line_items
      WHERE comparison_id = ${comparisonId}::uuid AND embedding IS NOT NULL`;
    embeddedCount = Number(result[0]?.count ?? 0);
  } catch {
    embeddedCount = 0;
  }

  // ── Phase 4 ────────────────────────────────────────────────────────────────
  const yoursZones = zones.filter(z => z.source === 'yours');
  const adjZones   = zones.filter(z => z.source === 'adjuster');

  const p4: Phase4Metrics = {
    yoursZoneCount: yoursZones.length,
    adjZoneCount:   adjZones.length,
    yoursFormat:    null,    // not stored directly on zone rows; left null
    adjFormat:      null,
    yoursPagesCovered: yoursZones.length > 0
      ? Math.max(...yoursZones.map(z => z.endPage)) - Math.min(...yoursZones.map(z => z.startPage)) + 1
      : 0,
    adjPagesCovered: adjZones.length > 0
      ? Math.max(...adjZones.map(z => z.endPage)) - Math.min(...adjZones.map(z => z.startPage)) + 1
      : 0,
    emptyZones:     zones.filter(z => z.approxItems === 0).length,
    oversizedZones: zones.filter(z => (z.endPage - z.startPage) > 3).length,
    flatZones:      (yoursZones.length === 1 ? 1 : 0) + (adjZones.length === 1 ? 1 : 0),
    zones: zones.map(z => ({
      side:        z.source as 'yours' | 'adjuster',
      name:        z.name,
      startPage:   z.startPage,
      endPage:     z.endPage,
      approxItems: z.approxItems,
    })),
  };

  // ── Phase 6 ────────────────────────────────────────────────────────────────
  const correspYoursIds = new Set(correspondences.flatMap(c => c.yourZones.map(z => z.id)));
  const correspAdjIds   = new Set(correspondences.flatMap(c => c.adjusterZones.map(z => z.id)));

  const p6: Phase6Metrics = {
    correspondenceCount: correspondences.length,
    unmatchedYoursZones: yoursZones.filter(z => !correspYoursIds.has(z.id)).length,
    unmatchedAdjZones:   adjZones.filter(z => !correspAdjIds.has(z.id)).length,
    avgConfidence:       correspondences.length > 0
      ? mean(correspondences.map(c => num(c.confidence))) : 0,
    byType: {
      one_to_one:  correspondences.filter(c => c.correspondenceType === 'one_to_one').length,
      one_to_many: correspondences.filter(c => c.correspondenceType === 'one_to_many').length,
      many_to_one: correspondences.filter(c => c.correspondenceType === 'many_to_one').length,
    },
    correspondences: correspondences.map(c => ({
      type:       c.correspondenceType,
      confidence: num(c.confidence),
      yoursZones: c.yourZones.map(z => z.name),
      adjZones:   c.adjusterZones.map(z => z.name),
    })),
  };

  // ── Phase 8 ────────────────────────────────────────────────────────────────
  const yoursItems = lineItems.filter(i => i.source === 'yours');
  const adjItems   = lineItems.filter(i => i.source === 'adjuster');

  // items per zone
  const itemsPerZoneMap = new Map<string, number>();
  for (const item of lineItems) {
    if (item.zoneId) itemsPerZoneMap.set(item.zoneId, (itemsPerZoneMap.get(item.zoneId) ?? 0) + 1);
  }
  const itemsPerZoneArr = [...itemsPerZoneMap.values()];

  const yoursTotal = yoursItems.reduce((s, i) => s + num(i.totalAmount), 0);
  const adjTotal   = adjItems.reduce((s, i) => s + num(i.totalAmount), 0);

  const p8: Phase8Metrics = {
    yoursItemCount: yoursItems.length,
    adjItemCount:   adjItems.length,
    totalItems:     lineItems.length,
    itemsPerZone: {
      min:    itemsPerZoneArr.length > 0 ? Math.min(...itemsPerZoneArr) : 0,
      median: median(itemsPerZoneArr),
      max:    itemsPerZoneArr.length > 0 ? Math.max(...itemsPerZoneArr) : 0,
    },
    avgExtractionConfidence: mean(lineItems.map(i => num(i.extractionConfidence))),
    itemsMissingTotal:    lineItems.filter(i => i.totalAmount == null).length,
    itemsMissingQuantity: lineItems.filter(i => i.normalizedQuantity == null).length,
    itemsLowConfidence:   lineItems.filter(i => num(i.extractionConfidence) < 0.7).length,
    yoursTotalAmount:     yoursTotal,
    adjTotalAmount:       adjTotal,
    estimateGap:          adjTotal - yoursTotal,
  };

  // ── Phase 9 ────────────────────────────────────────────────────────────────
  const total = lineItems.length || 1;
  const allTrades  = lineItems.map(i => i.trade).filter((v): v is string => Boolean(v));
  const allActions = lineItems.map(i => i.action).filter((v): v is string => Boolean(v));
  const allFlags   = lineItems.flatMap(i => i.specialFlags);

  const p9: Phase9Metrics = {
    totalRows: lineItems.length,
    pctWithQuantity:     lineItems.filter(i => i.normalizedQuantity != null).length / total,
    pctWithUnit:         lineItems.filter(i => i.normalizedUnit       != null).length / total,
    pctWithTrade:        allTrades.length / total,
    pctWithAction:       allActions.length / total,
    pctWithSpecialFlags: lineItems.filter(i => i.specialFlags.length > 0).length / total,
    distinctTrades:      new Set(allTrades).size,
    distinctActions:     new Set(allActions).size,
    topTrades:  topN(allTrades, 5),
    topActions: topN(allActions, 5),
    topFlags:   topN(allFlags, 5),
  };

  // ── Phase 11 ───────────────────────────────────────────────────────────────
  const p11: Phase11Metrics = {
    totalRows:   lineItems.length,
    embedded:    embeddedCount,
    missing:     lineItems.length - embeddedCount,
    pctEmbedded: lineItems.length > 0 ? embeddedCount / lineItems.length : 0,
  };

  // ── Phase 12 ───────────────────────────────────────────────────────────────
  const candidatesPerYours = new Map<string, number>();
  const candidatesPerAdj   = new Map<string, number>();
  const sourceCounts: Record<string, number> = {};

  for (const e of edges) {
    candidatesPerYours.set(e.sourceItemId, (candidatesPerYours.get(e.sourceItemId) ?? 0) + 1);
    candidatesPerAdj.set(e.targetItemId,   (candidatesPerAdj.get(e.targetItemId)   ?? 0) + 1);
    for (const src of e.retrievalSources) {
      sourceCounts[src] = (sourceCounts[src] ?? 0) + 1;
    }
  }

  const yoursCandsArr = yoursItems.map(i => candidatesPerYours.get(i.id) ?? 0);
  const adjCandsArr   = adjItems.map(i => candidatesPerAdj.get(i.id) ?? 0);

  const bucketize = (n: number) => n === 0 ? 0 : n <= 5 ? 1 : n <= 15 ? 2 : n <= 30 ? 3 : 4;
  const yoursHist = [0, 0, 0, 0, 0];
  const adjHist   = [0, 0, 0, 0, 0];
  yoursCandsArr.forEach(n => yoursHist[bucketize(n)]++);
  adjCandsArr.forEach(n => adjHist[bucketize(n)]++);

  const p12: Phase12Metrics = {
    totalEdges: edges.length,
    bySource:   sourceCounts,
    itemsWithZeroCandidates:
      yoursItems.filter(i => !candidatesPerYours.has(i.id)).length +
      adjItems.filter(i => !candidatesPerAdj.has(i.id)).length,
    yoursCandidatesHistogram: yoursHist,
    adjCandidatesHistogram:   adjHist,
    avgCandidatesPerYours:    mean(yoursCandsArr),
    avgCandidatesPerAdj:      mean(adjCandsArr),
  };

  // ── Phase 13 ──────────────────────────────────────────────────────── ⭐
  const featureNames = Object.keys(SCORE_WEIGHTS) as (keyof typeof SCORE_WEIGHTS)[];
  const finalScores  = edges.map(e => num(e.finalScore));

  // Bucket edges
  const buckets = {
    highConfidence: 0,
    possibleMatch:  0,
    weakCandidate:  0,
    rejected:       0,
  };
  for (const fs of finalScores) {
    if      (fs >= SCORE_THRESHOLDS.HIGH_CONFIDENCE) buckets.highConfidence++;
    else if (fs >= SCORE_THRESHOLDS.POSSIBLE_MATCH)  buckets.possibleMatch++;
    else if (fs >= SCORE_THRESHOLDS.WEAK_CANDIDATE)  buckets.weakCandidate++;
    else                                              buckets.rejected++;
  }

  // Per-feature stats
  const featureStats: FeatureStats[] = [];
  for (const name of featureNames) {
    const allVals = edges.map(e => {
      const f = (e.featuresJson as Record<string, number> | null);
      return f?.[name] ?? 0;
    });
    const highVals = edges
      .filter(e => num(e.finalScore) >= SCORE_THRESHOLDS.HIGH_CONFIDENCE)
      .map(e => ((e.featuresJson as Record<string, number> | null)?.[name] ?? 0));
    const rejVals  = edges
      .filter(e => num(e.finalScore) <  SCORE_THRESHOLDS.WEAK_CANDIDATE)
      .map(e => ((e.featuresJson as Record<string, number> | null)?.[name] ?? 0));

    const meanAll  = mean(allVals);
    const meanHigh = mean(highVals);
    const meanRej  = mean(rejVals);

    featureStats.push({
      name,
      weight:   SCORE_WEIGHTS[name],
      meanAll,
      meanHighConf:        meanHigh,
      meanRejected:        meanRej,
      std:                 std(allVals),
      min:                 allVals.length > 0 ? Math.min(...allVals) : 0,
      max:                 allVals.length > 0 ? Math.max(...allVals) : 0,
      pctZero:             allVals.length > 0 ? allVals.filter(v => v === 0).length / allVals.length : 0,
      weightedContribAll:  meanAll * SCORE_WEIGHTS[name],
      discriminativePower: Math.abs(meanHigh - meanRej),
    });
  }

  // Borderline
  const eps = 0.02;
  const nearReject   = finalScores.filter(s => Math.abs(s - SCORE_THRESHOLDS.REJECT)         < eps).length;
  const nearPossible = finalScores.filter(s => Math.abs(s - SCORE_THRESHOLDS.POSSIBLE_MATCH) < eps).length;
  const nearHighConf = finalScores.filter(s => Math.abs(s - SCORE_THRESHOLDS.HIGH_CONFIDENCE) < eps).length;

  // Boost stats
  const edgesWithBoost = edges.filter(e => {
    const b = e.boostsJson as Array<{ value?: number }> | null;
    return Array.isArray(b) && b.length > 0;
  });
  const boostMagnitudes = edgesWithBoost.map(e => {
    const b = (e.boostsJson as Array<{ value?: number }>);
    return Math.abs(b.reduce((s, x) => s + (x.value ?? 0), 0));
  });

  const p13: Phase13Metrics = {
    scoredCount:  edges.length,
    bucketCounts: buckets,
    survivalRate: edges.length > 0 ? edges.filter(e => !e.isRejected).length / edges.length : 0,
    scoreHistogram: histogram(finalScores, 0, 1, 10),
    featureStats: featureStats.sort((a, b) => b.discriminativePower - a.discriminativePower),
    borderline: { nearReject, nearPossible, nearHighConf },
    boostStats: {
      edgesWithBoost:    edgesWithBoost.length,
      avgBoostMagnitude: mean(boostMagnitudes),
      bucketChangedByBoost: 0,   // would require pre-boost score; left as future enhancement
    },
  };

  // ── Phase 14 ───────────────────────────────────────────────────────────────
  const p14: Phase14Metrics = {
    componentCount: components.length,
    bySize: {
      small:  components.filter(c => c.size === 'small').length,
      medium: components.filter(c => c.size === 'medium').length,
      large:  components.filter(c => c.size === 'large').length,
    },
    largestComponentSize: components.length > 0
      ? Math.max(...components.map(c => c.sourceItemIds.length + c.targetItemIds.length)) : 0,
    singletonsYours: 0,    // singletons aren't currently persisted as components — left at 0
    singletonsAdj:   0,
    components: components.map((c, idx) => {
      const y = c.sourceItemIds.length;
      const a = c.targetItemIds.length;
      const e = c._count.edges;
      return {
        idx,
        yoursCount:  y,
        adjCount:    a,
        edgeCount:   e,
        size:        c.size,
        isAmbiguous: c.isAmbiguous,
        edgeDensity: y * a > 0 ? e / (y * a) : 0,
      };
    }),
  };

  // ── Phase 15 ───────────────────────────────────────────────────────────────
  const matchedDecisions = decisions.filter(d => d.decisionType === 'one_to_one');
  const possibleDecisions = decisions.filter(d => d.decisionType === 'possible');
  const matchedScores  = matchedDecisions.map(d => num(d.finalScore));
  const possibleScores = possibleDecisions.map(d => num(d.finalScore));

  const p15: Phase15Metrics = {
    decisionCount:   decisions.length,
    matchedCount:    matchedDecisions.length,
    possibleCount:   possibleDecisions.length,
    unmatchedYours:  decisions.filter(d => d.decisionType === 'unmatched' && d.yourItemIds.length > 0).length,
    unmatchedAdj:    decisions.filter(d => d.decisionType === 'unmatched' && d.adjusterItemIds.length > 0).length,
    matchedScores: {
      min:  matchedScores.length > 0 ? Math.min(...matchedScores) : 0,
      mean: mean(matchedScores),
      max:  matchedScores.length > 0 ? Math.max(...matchedScores) : 0,
    },
    possibleScores: {
      min:  possibleScores.length > 0 ? Math.min(...possibleScores) : 0,
      mean: mean(possibleScores),
      max:  possibleScores.length > 0 ? Math.max(...possibleScores) : 0,
    },
    scoreHistogramMatched:  histogram(matchedScores, 0, 1, 10),
    scoreHistogramPossible: histogram(possibleScores, 0, 1, 10),
  };

  // ── Phase 16 ───────────────────────────────────────────────────────────────
  const p16: Phase16Metrics = {
    groupedCount:    decisions.filter(d => d.decisionType === 'grouped').length,
    relinquishedAdj: decisions.filter(d => d.decidedBy === 'group_match' && d.decisionType === 'unmatched').length,
  };

  // ── Phase 17 ───────────────────────────────────────────────────────────────
  const adjudicationCalls = llmCalls.filter(c => c.phase === 'adjudication');
  const adjCall = adjudicationCalls[adjudicationCalls.length - 1];   // latest call
  const llmDecisions = decisions.filter(d => d.decidedBy === 'llm_adjudication');
  const llmAccepted  = llmDecisions.filter(d => d.decisionType === 'one_to_one');
  const llmRejected  = llmDecisions.filter(d => d.decisionType === 'unmatched');

  // Algo vs LLM confusion (split at POSSIBLE_MATCH threshold = 0.55)
  const cm = { algoHigh_llmAccept: 0, algoHigh_llmReject: 0, algoLow_llmAccept: 0, algoLow_llmReject: 0 };
  for (const d of llmDecisions) {
    const score = num(d.finalScore);
    const algoHigh = score >= SCORE_THRESHOLDS.POSSIBLE_MATCH;
    const llmAccept = d.decisionType === 'one_to_one';
    if      (algoHigh  && llmAccept)  cm.algoHigh_llmAccept++;
    else if (algoHigh  && !llmAccept) cm.algoHigh_llmReject++;
    else if (!algoHigh && llmAccept)  cm.algoLow_llmAccept++;
    else                              cm.algoLow_llmReject++;
  }

  // Reasoning samples — most extreme accepts and rejects
  const samplesSrc = llmDecisions
    .map((d, idx) => {
      const yoursId = d.yourItemIds[0];
      const adjId   = d.adjusterItemIds[0] ?? d.yourItemIds[0];   // fallback
      return {
        pairIndex:  idx,
        finalScore: num(d.finalScore),
        decision:   (d.decisionType === 'one_to_one' ? 'match' : 'no_match') as 'match' | 'no_match',
        reasoning:  d.llmReasoning ?? '',
        yoursDesc:  itemMap.get(yoursId)?.rawDescription?.slice(0, 120) ?? '',
        adjDesc:    itemMap.get(adjId)?.rawDescription?.slice(0, 120) ?? '',
      };
    });

  const reasoningSamples = [
    ...samplesSrc.filter(s => s.decision === 'match').sort((a, b) => b.finalScore - a.finalScore).slice(0, 3),
    ...samplesSrc.filter(s => s.decision === 'no_match').sort((a, b) => b.finalScore - a.finalScore).slice(0, 3),
  ];

  const p17: Phase17Metrics = {
    adjudicatedCount: llmDecisions.length,
    acceptedCount:    llmAccepted.length,
    rejectedCount:    llmRejected.length,
    estimatedCostUsd: adjCall ? num(adjCall.estimatedCostUsd) : 0,
    durationMs:       adjCall?.durationMs ?? 0,
    confusionMatrix:  cm,
    agreementRate:    llmDecisions.length > 0
      ? (cm.algoHigh_llmAccept + cm.algoLow_llmReject) / llmDecisions.length : 0,
    reasoningSamples,
  };

  // ── Phase 18 ───────────────────────────────────────────────────────────────
  const persistedItems = await prisma.lineItem.findMany({
    where: { comparisonId },
    select: { matchStatus: true, totalYours: true, totalAdjuster: true },
  });

  const byStatus = {
    MATCH:                  persistedItems.filter(i => i.matchStatus === 'MATCH').length,
    MODIFIED:               persistedItems.filter(i => i.matchStatus === 'MODIFIED').length,
    MISSING_FROM_ADJUSTER:  persistedItems.filter(i => i.matchStatus === 'MISSING_FROM_ADJUSTER').length,
    ADDED_BY_ADJUSTER:      persistedItems.filter(i => i.matchStatus === 'ADDED_BY_ADJUSTER').length,
    GROUPED:                persistedItems.filter(i => i.matchStatus === 'GROUPED').length,
  };

  const matchedDollars = persistedItems
    .filter(i => i.matchStatus === 'MATCH')
    .reduce((s, i) => s + num(i.totalYours), 0);

  const yoursTotalP18 = persistedItems.reduce((s, i) => s + num(i.totalYours), 0);
  const adjTotalP18   = persistedItems.reduce((s, i) => s + num(i.totalAdjuster), 0);

  const provenance: Record<string, number> = {};
  for (const d of decisions) provenance[d.decidedBy] = (provenance[d.decidedBy] ?? 0) + 1;

  const p18: Phase18Metrics = {
    lineItemCount: persistedItems.length,
    byStatus,
    byProvenance:        provenance,
    totalGap:            adjTotalP18 - yoursTotalP18,
    yourEstimateTotal:   yoursTotalP18,
    adjEstimateTotal:    adjTotalP18,
    matchedDollars,
    matchedDollarPct:    yoursTotalP18 > 0 ? matchedDollars / yoursTotalP18 : 0,
  };

  // ── Per-decision drill-down ────────────────────────────────────────────────
  const decisionDetails: DecisionDetail[] = decisions
    .map(d => {
      const yoursItem = d.yourItemIds[0]      ? itemMap.get(d.yourItemIds[0])      : null;
      const adjItem   = d.adjusterItemIds[0]  ? itemMap.get(d.adjusterItemIds[0])  : null;
      const ty = yoursItem ? numOrNull(yoursItem.totalAmount) : null;
      const ta = adjItem   ? numOrNull(adjItem.totalAmount)   : null;
      return {
        id:           d.id,
        decisionType: d.decisionType,
        decidedBy:    d.decidedBy,
        finalScore:   num(d.finalScore),
        yoursDesc:    yoursItem?.rawDescription ?? null,
        adjDesc:      adjItem?.rawDescription ?? null,
        yoursTotal:   ty,
        adjTotal:     ta,
        diff:         ta != null && ty != null ? ta - ty : null,
        llmReasoning: d.llmReasoning ?? null,
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore);

  // ── Pipeline health summary ────────────────────────────────────────────────
  const health: PhaseSummary[] = [
    buildHealth4(p4),
    buildHealth6(p6),
    buildHealth8(p8),
    buildHealth9(p9),
    buildHealth11(p11),
    buildHealth12(p12),
    buildHealth13(p13),
    buildHealth14(p14),
    buildHealth15(p15),
    buildHealth16(p16),
    buildHealth17(p17),
    buildHealth18(p18),
  ];

  return {
    comparisonId,
    generatedAt: new Date().toISOString(),
    health,
    p4, p6, p8, p9, p11, p12, p13, p14, p15, p16, p17, p18,
    decisions: decisionDetails,
  };
}

// ── Per-phase health summary builders ─────────────────────────────────────────

function buildHealth4(p: Phase4Metrics): PhaseSummary {
  const flags: string[] = [];
  if (p.flatZones > 0) flags.push(`${p.flatZones} flat side(s) — single zone covering all pages`);
  if (p.emptyZones > 0) flags.push(`${p.emptyZones} zone(s) with 0 items`);
  if (p.oversizedZones > 0) flags.push(`${p.oversizedZones} zone(s) span >3 pages`);
  if (p.yoursZoneCount === 0 || p.adjZoneCount === 0) flags.push('one side has 0 zones');
  return {
    phase: 'p4', label: 'Zones',
    status: p.yoursZoneCount === 0 || p.adjZoneCount === 0 ? 'red' : flags.length > 0 ? 'yellow' : 'green',
    headline: `${p.yoursZoneCount} yours · ${p.adjZoneCount} adj`,
    flags,
  };
}

function buildHealth6(p: Phase6Metrics): PhaseSummary {
  const flags: string[] = [];
  if (p.unmatchedYoursZones > 0) flags.push(`${p.unmatchedYoursZones} yours zone(s) unmatched`);
  if (p.unmatchedAdjZones   > 0) flags.push(`${p.unmatchedAdjZones} adj zone(s) unmatched`);
  if (p.avgConfidence < 0.7 && p.correspondenceCount > 0) flags.push(`avg confidence ${p.avgConfidence.toFixed(2)} (<0.70)`);
  return {
    phase: 'p6', label: 'Corresps',
    status: p.correspondenceCount === 0 ? 'red' : flags.length > 0 ? 'yellow' : 'green',
    headline: `${p.correspondenceCount} corresps · ${p.unmatchedYoursZones + p.unmatchedAdjZones} unmatched`,
    flags,
  };
}

function buildHealth8(p: Phase8Metrics): PhaseSummary {
  const flags: string[] = [];
  if (p.itemsMissingTotal > 0) flags.push(`${p.itemsMissingTotal} item(s) missing total`);
  if (p.itemsMissingQuantity > 0) flags.push(`${p.itemsMissingQuantity} item(s) missing quantity`);
  if (p.itemsLowConfidence > 0) flags.push(`${p.itemsLowConfidence} item(s) low extraction confidence`);
  return {
    phase: 'p8', label: 'Extract',
    status: p.totalItems === 0 ? 'red' : flags.length > 0 ? 'yellow' : 'green',
    headline: `${p.yoursItemCount} + ${p.adjItemCount} = ${p.totalItems} items`,
    flags,
  };
}

function buildHealth9(p: Phase9Metrics): PhaseSummary {
  const flags: string[] = [];
  if (p.pctWithQuantity < 0.95) flags.push(`only ${(p.pctWithQuantity * 100).toFixed(0)}% have qty`);
  if (p.pctWithUnit     < 0.95) flags.push(`only ${(p.pctWithUnit     * 100).toFixed(0)}% have unit`);
  if (p.pctWithTrade    < 0.50) flags.push(`only ${(p.pctWithTrade    * 100).toFixed(0)}% have trade`);
  return {
    phase: 'p9', label: 'Normalize',
    status: flags.length > 0 ? 'yellow' : 'green',
    headline: `${(p.pctWithQuantity * 100).toFixed(0)}% qty · ${(p.pctWithTrade * 100).toFixed(0)}% trade`,
    flags,
  };
}

function buildHealth11(p: Phase11Metrics): PhaseSummary {
  const flags: string[] = [];
  if (p.missing > 0) flags.push(`${p.missing} item(s) missing embeddings`);
  return {
    phase: 'p11', label: 'Embed',
    status: p.missing > 0 ? 'red' : 'green',
    headline: `${p.embedded}/${p.totalRows} embedded`,
    flags,
  };
}

function buildHealth12(p: Phase12Metrics): PhaseSummary {
  const flags: string[] = [];
  if (p.itemsWithZeroCandidates > 0) flags.push(`${p.itemsWithZeroCandidates} item(s) with 0 candidates — pipeline-killer`);
  if (p.totalEdges < 100) flags.push(`only ${p.totalEdges} total edges — graph too sparse`);
  return {
    phase: 'p12', label: 'Candidates',
    status: p.itemsWithZeroCandidates > 0 ? 'red' : flags.length > 0 ? 'yellow' : 'green',
    headline: `${p.totalEdges} edges`,
    flags,
  };
}

function buildHealth13(p: Phase13Metrics): PhaseSummary {
  const flags: string[] = [];
  if (p.bucketCounts.highConfidence === 0) flags.push('0 highConfidence edges — calibration may be off');
  if (p.survivalRate < 0.05) flags.push(`only ${(p.survivalRate * 100).toFixed(1)}% edges survived REJECT`);
  if (p.borderline.nearReject > 50) flags.push(`${p.borderline.nearReject} edges within 0.02 of REJECT — fragile`);
  // dead features
  const deadFeatures = p.featureStats.filter(f => f.discriminativePower < 0.05).map(f => f.name);
  if (deadFeatures.length > 0) flags.push(`dead/weak features: ${deadFeatures.join(', ')}`);
  return {
    phase: 'p13', label: 'Score',
    status: p.bucketCounts.highConfidence === 0 ? 'yellow' : flags.length > 0 ? 'yellow' : 'green',
    headline: `${p.bucketCounts.highConfidence} hi · ${p.bucketCounts.possibleMatch} pos · ${p.bucketCounts.weakCandidate} weak · ${p.bucketCounts.rejected} rej`,
    flags,
  };
}

function buildHealth14(p: Phase14Metrics): PhaseSummary {
  const flags: string[] = [];
  if (p.largestComponentSize > COMPONENT_SIZE.MEDIUM_MAX) {
    flags.push(`largest component ${p.largestComponentSize} > MEDIUM_MAX (${COMPONENT_SIZE.MEDIUM_MAX})`);
  }
  if (p.singletonsYours + p.singletonsAdj > 0) {
    flags.push(`${p.singletonsYours + p.singletonsAdj} singleton(s) — items disconnected from graph`);
  }
  return {
    phase: 'p14', label: 'Components',
    status: flags.length > 0 ? 'yellow' : 'green',
    headline: `${p.componentCount} components · largest=${p.largestComponentSize}`,
    flags,
  };
}

function buildHealth15(p: Phase15Metrics): PhaseSummary {
  const flags: string[] = [];
  if (p.unmatchedYours > p.matchedCount * 0.10) flags.push(`${p.unmatchedYours} unmatched yours — high`);
  if (p.possibleCount > p.matchedCount) flags.push(`${p.possibleCount} possible > ${p.matchedCount} matched — calibration off`);
  return {
    phase: 'p15', label: 'Assign',
    status: flags.length > 0 ? 'yellow' : 'green',
    headline: `${p.matchedCount} matched · ${p.possibleCount} possible · ${p.unmatchedYours} unmatched`,
    flags,
  };
}

function buildHealth16(p: Phase16Metrics): PhaseSummary {
  return {
    phase: 'p16', label: 'Group',
    status: 'green',
    headline: `${p.groupedCount} groups`,
    flags: [],
  };
}

function buildHealth17(p: Phase17Metrics): PhaseSummary {
  const flags: string[] = [];
  if (p.agreementRate < 0.7 && p.adjudicatedCount > 0) {
    flags.push(`agreement rate ${(p.agreementRate * 100).toFixed(0)}% — algo and LLM disagree often`);
  }
  return {
    phase: 'p17', label: 'LLM',
    status: flags.length > 0 ? 'yellow' : 'green',
    headline: p.adjudicatedCount > 0
      ? `${p.acceptedCount} acc · ${p.rejectedCount} rej · $${p.estimatedCostUsd.toFixed(4)}`
      : 'skipped (no possible decisions)',
    flags,
  };
}

function buildHealth18(p: Phase18Metrics): PhaseSummary {
  const flags: string[] = [];
  if (p.lineItemCount === 0) flags.push('0 line items persisted');
  return {
    phase: 'p18', label: 'Persist',
    status: p.lineItemCount === 0 ? 'red' : 'green',
    headline: `${p.lineItemCount} items · gap $${p.totalGap.toFixed(2)}`,
    flags,
  };
}
