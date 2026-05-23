// ─────────────────────────────────────────────────────────────────────────────
// N3 Pipeline — Phase 12: generate-candidates
//
// Generates the candidate-edge graph for matching. Runs five retrieval sources
// over normalized `n3_line_items` rows and unions their results. Each yours
// item ends up associated with a deduplicated set of adjuster items it MIGHT
// match, tagged with which source(s) suggested the pair.
//
// Retrieval sources implemented in v1:
//   1. ai_proposed_zone   — items in zones paired by Phase 6 correspondences
//   2. semantic           — top-K cosine ANN on Phase 11 embeddings (bidir.)
//   3. fuzzy_description  — Jaccard token overlap on descriptionTokens
//   4. total_similarity   — totalAmount within 25% (ratio ≥ 0.75)
//   5. item_code          — exact normalized item-code match
//
// Deferred to v2 (lower expected impact): verified_zone (no UI yet),
// trade_action_material, quantity_unit, sequence_nearby.
//
// Output: rows in `n3_candidate_edges`. Each row has retrievalSources populated
// and placeholder featuresJson/boostsJson/scores. Phase 13 fills in the actual
// feature scores; Phase 14+ consumes the graph.
//
// Idempotent: deletes any prior edges for the comparison before inserting.
//
// Architecture refs: N3.md §Phase 12, §15.2–§15.4 (retrieval sources, dedup).
// ─────────────────────────────────────────────────────────────────────────────

import prisma from '@/lib/prisma';
import type { StepLogger } from '@/lib/n3/passes/detect-zones';
import type { N3RetrievalSource } from '@/lib/n3/types';
import { CANDIDATE_BUDGETS } from '@/lib/n3/constants';

// ── Return type ───────────────────────────────────────────────────────────────

export type GenerateCandidatesN3Result = {
  totalEdges: number;
  bySource: Record<N3RetrievalSource, number>;
};

// ── Internal accumulator ──────────────────────────────────────────────────────

type EdgeKey = `${string}__${string}`;

type EdgeRecord = {
  yoursId: string;
  adjusterId: string;
  sources: Set<N3RetrievalSource>;
};

type EdgeAccumulator = Map<EdgeKey, EdgeRecord>;

const edgeKey = (yoursId: string, adjusterId: string): EdgeKey =>
  `${yoursId}__${adjusterId}`;

function addCandidate(
  acc: EdgeAccumulator,
  yoursId: string,
  adjusterId: string,
  source: N3RetrievalSource,
): void {
  const key = edgeKey(yoursId, adjusterId);
  const existing = acc.get(key);
  if (existing) {
    existing.sources.add(source);
    return;
  }
  acc.set(key, { yoursId, adjusterId, sources: new Set([source]) });
}

// ── Retrieval source: ai_proposed_zone ────────────────────────────────────────
// For each Phase 6 zone correspondence, take the cross-product of items in
// the corresponding zones. Keeps the candidate-explosion bounded by zone size.

async function retrieveAiProposedZone(
  comparisonId: string,
  acc: EdgeAccumulator,
  logger: StepLogger,
): Promise<number> {
  const correspondences = await prisma.n3ZoneCorrespondence.findMany({
    where: { comparisonId },
    include: {
      yourZones: { select: { id: true } },
      adjusterZones: { select: { id: true } },
    },
  });

  const perItemBudget = CANDIDATE_BUDGETS.ai_proposed_zone;
  let pairCount = 0;
  for (const corr of correspondences) {
    const yourZoneIds = corr.yourZones.map(z => z.id);
    const adjZoneIds = corr.adjusterZones.map(z => z.id);
    if (yourZoneIds.length === 0 || adjZoneIds.length === 0) continue;

    const [yoursItems, adjItems] = await Promise.all([
      prisma.n3LineItem.findMany({
        where: { comparisonId, source: 'yours', zoneId: { in: yourZoneIds } },
        select: { id: true, sourceLineNumber: true },
        orderBy: { sourceLineNumber: 'asc' },
      }),
      prisma.n3LineItem.findMany({
        where: { comparisonId, source: 'adjuster', zoneId: { in: adjZoneIds } },
        select: { id: true, sourceLineNumber: true },
        orderBy: { sourceLineNumber: 'asc' },
      }),
    ]);

    const adjCount = adjItems.length;
    for (let yi = 0; yi < yoursItems.length; yi++) {
      const y = yoursItems[yi];
      const anchor = Math.round((yi / Math.max(yoursItems.length - 1, 1)) * (adjCount - 1));
      const half = Math.floor(perItemBudget / 2);
      const lo = Math.max(0, anchor - half);
      const hi = Math.min(adjCount - 1, lo + perItemBudget - 1);
      for (let ai = lo; ai <= hi; ai++) {
        addCandidate(acc, y.id, adjItems[ai].id, 'ai_proposed_zone');
        pairCount++;
      }
    }
  }

  logger.info('[n3/generate-candidates] ai_proposed_zone', {
    comparisonId,
    correspondences: correspondences.length,
    pairs: pairCount,
  });
  return pairCount;
}

// ── Retrieval source: semantic (bidirectional cosine ANN) ─────────────────────
// One SQL: top-K adjuster per yours UNION top-K yours per adjuster, then both
// directions normalized to (yours, adjuster) edges in the accumulator.

async function retrieveSemantic(
  comparisonId: string,
  acc: EdgeAccumulator,
  topK: number,
  logger: StepLogger,
): Promise<number> {
  type Row = { yours_id: string; adj_id: string };
  const rows = await prisma.$queryRaw<Row[]>`
    WITH y AS (
      SELECT id, embedding FROM n3_line_items
      WHERE comparison_id::text = ${comparisonId}
        AND source = 'yours'
        AND embedding IS NOT NULL
    ),
    a AS (
      SELECT id, embedding FROM n3_line_items
      WHERE comparison_id::text = ${comparisonId}
        AND source = 'adjuster'
        AND embedding IS NOT NULL
    ),
    forward AS (
      SELECT y.id AS yours_id, a.id AS adj_id,
             ROW_NUMBER() OVER (PARTITION BY y.id ORDER BY y.embedding <=> a.embedding) AS rnk
      FROM y CROSS JOIN a
    ),
    reverse AS (
      SELECT y.id AS yours_id, a.id AS adj_id,
             ROW_NUMBER() OVER (PARTITION BY a.id ORDER BY a.embedding <=> y.embedding) AS rnk
      FROM y CROSS JOIN a
    )
    SELECT yours_id, adj_id FROM forward WHERE rnk <= ${topK}
    UNION
    SELECT yours_id, adj_id FROM reverse WHERE rnk <= ${topK}
  `;

  for (const r of rows) {
    addCandidate(acc, r.yours_id, r.adj_id, 'semantic');
  }
  logger.info('[n3/generate-candidates] semantic', {
    comparisonId,
    pairs: rows.length,
    topK,
  });
  return rows.length;
}

// ── Retrieval source: fuzzy_description (Jaccard) ─────────────────────────────
// Pure JS — descriptionTokens are already populated by Phase 8/9.

async function retrieveFuzzyDescription(
  comparisonId: string,
  acc: EdgeAccumulator,
  topK: number,
  logger: StepLogger,
): Promise<number> {
  const items = await prisma.n3LineItem.findMany({
    where: { comparisonId },
    select: { id: true, source: true, descriptionTokens: true },
  });

  const yours = items.filter(i => i.source === 'yours');
  const adjs = items.filter(i => i.source === 'adjuster');

  let pairCount = 0;
  for (const y of yours) {
    if (y.descriptionTokens.length === 0) continue;
    const ySet = new Set(y.descriptionTokens);

    const scored: Array<{ id: string; score: number }> = [];
    for (const a of adjs) {
      if (a.descriptionTokens.length === 0) continue;
      let intersection = 0;
      for (const tok of a.descriptionTokens) {
        if (ySet.has(tok)) intersection++;
      }
      const union = ySet.size + a.descriptionTokens.length - intersection;
      const j = union === 0 ? 0 : intersection / union;
      if (j > 0) scored.push({ id: a.id, score: j });
    }
    scored.sort((p, q) => q.score - p.score);
    for (const r of scored.slice(0, topK)) {
      addCandidate(acc, y.id, r.id, 'fuzzy_description');
      pairCount++;
    }
  }

  logger.info('[n3/generate-candidates] fuzzy_description', {
    comparisonId,
    pairs: pairCount,
    topK,
  });
  return pairCount;
}

// ── Retrieval source: total_similarity ────────────────────────────────────────
// Items with totalAmount within 25% of each other (ratio ≥ 0.75).

const TOTAL_SIMILARITY_RATIO_THRESHOLD = 0.75;

async function retrieveTotalSimilarity(
  comparisonId: string,
  acc: EdgeAccumulator,
  topK: number,
  logger: StepLogger,
): Promise<number> {
  const items = await prisma.n3LineItem.findMany({
    where: { comparisonId, totalAmount: { not: null } },
    select: { id: true, source: true, totalAmount: true },
  });

  const yours = items.filter(i => i.source === 'yours');
  const adjs = items.filter(i => i.source === 'adjuster');

  let pairCount = 0;
  for (const y of yours) {
    const yTotal = Number(y.totalAmount);
    if (!Number.isFinite(yTotal) || yTotal <= 0) continue;

    const scored: Array<{ id: string; ratio: number }> = [];
    for (const a of adjs) {
      const aTotal = Number(a.totalAmount);
      if (!Number.isFinite(aTotal) || aTotal <= 0) continue;
      const ratio = Math.min(yTotal, aTotal) / Math.max(yTotal, aTotal);
      if (ratio >= TOTAL_SIMILARITY_RATIO_THRESHOLD) {
        scored.push({ id: a.id, ratio });
      }
    }
    scored.sort((p, q) => q.ratio - p.ratio);
    for (const r of scored.slice(0, topK)) {
      addCandidate(acc, y.id, r.id, 'total_similarity');
      pairCount++;
    }
  }

  logger.info('[n3/generate-candidates] total_similarity', {
    comparisonId,
    pairs: pairCount,
    topK,
    ratioThreshold: TOTAL_SIMILARITY_RATIO_THRESHOLD,
  });
  return pairCount;
}

// ── Retrieval source: item_code (exact normalized match) ──────────────────────

async function retrieveItemCode(
  comparisonId: string,
  acc: EdgeAccumulator,
  logger: StepLogger,
): Promise<number> {
  const items = await prisma.n3LineItem.findMany({
    where: { comparisonId, itemCode: { not: null } },
    select: { id: true, source: true, itemCode: true },
  });

  const yoursByCode = new Map<string, string[]>();
  const adjByCode = new Map<string, string[]>();
  for (const i of items) {
    if (!i.itemCode) continue;
    const code = i.itemCode.trim().toUpperCase();
    const map = i.source === 'yours' ? yoursByCode : adjByCode;
    const arr = map.get(code) ?? [];
    arr.push(i.id);
    map.set(code, arr);
  }

  let pairCount = 0;
  for (const [code, yoursIds] of yoursByCode) {
    const adjIds = adjByCode.get(code);
    if (!adjIds) continue;
    for (const y of yoursIds) {
      for (const a of adjIds) {
        addCandidate(acc, y, a, 'item_code');
        pairCount++;
      }
    }
  }

  logger.info('[n3/generate-candidates] item_code', {
    comparisonId,
    pairs: pairCount,
    distinctCodes: [...yoursByCode.keys()].filter(c => adjByCode.has(c)).length,
  });
  return pairCount;
}

// ── Placeholder feature object for Phase 12 → Phase 13 handoff ────────────────
// Phase 13 will overwrite this with computed features.

const PLACEHOLDER_FEATURES = {
  descriptionFuzzySimilarity: 0,
  descriptionSemanticSimilarity: 0,
  tradeActionSimilarity: 0,
  materialObjectSimilarity: 0,
  quantityUnitSimilarity: 0,
  totalSimilarity: 0,
  unitPriceSimilarity: 0,
  itemCodeSimilarity: 0,
  zoneCorrespondenceSimilarity: 0,
  sequenceSimilarity: 0,
  specialFlagCompatibility: 0,
};

// ── Main entry ────────────────────────────────────────────────────────────────

export async function generateCandidatesN3(
  comparisonId: string,
  logger: StepLogger,
): Promise<GenerateCandidatesN3Result> {
  // Existence guard — comparison may have been deleted mid-pipeline.
  const exists = await prisma.comparison.findUnique({
    where: { id: comparisonId },
    select: { id: true },
  });
  if (!exists) {
    logger.info('[n3/generate-candidates] comparison missing, skipping', { comparisonId });
    return {
      totalEdges: 0,
      bySource: {
        verified_zone: 0,
        ai_proposed_zone: 0,
        semantic: 0,
        fuzzy_description: 0,
        item_code: 0,
        trade_action_material: 0,
        quantity_unit: 0,
        total_similarity: 0,
        sequence_nearby: 0,
      },
    };
  }

  const acc: EdgeAccumulator = new Map();

  // Run sources sequentially so logs are easy to read; each source is fast.
  await retrieveAiProposedZone(comparisonId, acc, logger);
  await retrieveSemantic(comparisonId, acc, CANDIDATE_BUDGETS.semantic, logger);
  await retrieveFuzzyDescription(
    comparisonId,
    acc,
    CANDIDATE_BUDGETS.fuzzy_description,
    logger,
  );
  await retrieveTotalSimilarity(
    comparisonId,
    acc,
    CANDIDATE_BUDGETS.total_similarity,
    logger,
  );
  await retrieveItemCode(comparisonId, acc, logger);

  // ── Idempotent write ────────────────────────────────────────────────────────
  await prisma.n3CandidateEdge.deleteMany({ where: { comparisonId } });

  const rows = Array.from(acc.values()).map(e => ({
    comparisonId,
    sourceItemId: e.yoursId,
    targetItemId: e.adjusterId,
    retrievalSources: Array.from(e.sources),
    boostsJson: [],
    featuresJson: PLACEHOLDER_FEATURES,
    rawScore: 0,
    finalScore: 0,
    isRejected: false,
  }));

  const BATCH = 500;
  const YIELD_EVERY = 10;
  for (let i = 0; i < rows.length; i += BATCH) {
    await prisma.n3CandidateEdge.createMany({
      data: rows.slice(i, i + BATCH),
      skipDuplicates: true,
    });
    if (((i / BATCH) + 1) % YIELD_EVERY === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  // Aggregate counts per source for logging.
  const bySource: Record<N3RetrievalSource, number> = {
    verified_zone: 0,
    ai_proposed_zone: 0,
    semantic: 0,
    fuzzy_description: 0,
    item_code: 0,
    trade_action_material: 0,
    quantity_unit: 0,
    total_similarity: 0,
    sequence_nearby: 0,
  };
  for (const e of acc.values()) {
    for (const s of e.sources) {
      bySource[s]++;
    }
  }

  logger.info('[n3/generate-candidates] complete', {
    comparisonId,
    totalEdges: rows.length,
    bySource,
  });

  return { totalEdges: rows.length, bySource };
}
