// ─────────────────────────────────────────────────────────────────────────────
// N3 Pipeline — Phase 13: score-candidates
//
// Reads every n3_candidate_edge row produced by Phase 12, computes all 11
// feature scores, calculates rawScore and finalScore (with zone boosts), and
// marks edges below the REJECT threshold as isRejected=true.
//
// Zero AI calls — pure arithmetic over normalized fields already in the DB.
// Cosine similarity for descriptionSemanticSimilarity is retrieved via a single
// raw SQL JOIN using pgvector's <=> operator.
//
// Features computed here:
//   descriptionFuzzySimilarity    — Jaccard on descriptionTokens
//   descriptionSemanticSimilarity — cosine sim from Phase 11 embeddings
//   tradeActionSimilarity         — trade_match×0.6 + action_match×0.4
//   materialObjectSimilarity      — 0 (stub; Phase 10 NLP not yet built)
//   quantityUnitSimilarity        — unit_match×0.5 + qty_ratio×0.5
//   totalSimilarity               — min/max of totalAmount
//   unitPriceSimilarity           — min/max of unitPrice
//   itemCodeSimilarity            — exact item_code match
//   zoneCorrespondenceSimilarity  — correspondence confidence if in-zone, else 0
//   sequenceSimilarity            — page + line proximity
//   specialFlagCompatibility      — flag set comparison
//
// Idempotent: rewrites scores on every run (safe for retries).
//
// Architecture refs: N3.md §Phase 13, §16.2 (scoring), §16.3 (thresholds).
// ─────────────────────────────────────────────────────────────────────────────

import prisma from '@/lib/prisma';
import type { StepLogger } from '@/lib/n3/passes/detect-zones';
import {
  computeRawScore,
  computeFinalScore,
  shouldRejectEdge,
} from '@/lib/n3/normalization';
import { ZONE_BOOSTS, SCORE_THRESHOLDS } from '@/lib/n3/constants';
import type { N3CandidateScoreFeatures, N3ZoneBoost } from '@/lib/n3/types';

// ── Return type ───────────────────────────────────────────────────────────────

export type ScoreCandidatesN3Result = {
  scoredCount: number;
  rejectedCount: number;
  byBucket: {
    highConfidence: number;   // finalScore >= HIGH_CONFIDENCE (0.90)
    possibleMatch: number;    // finalScore >= POSSIBLE_MATCH (0.75)
    weakCandidate: number;    // finalScore >= WEAK_CANDIDATE / REJECT (0.60)
    rejected: number;         // finalScore < REJECT (0.60) — isRejected=true
  };
};

// ── Internal lookup type ──────────────────────────────────────────────────────

type ZoneCorr = {
  confidence: number;         // 0-1
  verificationStatus: string; // 'ai_proposed' | 'user_confirmed' | 'user_corrected'
};

// key: `${yoursZoneId}__${adjusterZoneId}`
type CorrespondenceLookup = Map<string, ZoneCorr>;

// ── Feature helpers (pure, no I/O) ────────────────────────────────────────────

function computeJaccard(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 && tokensB.length === 0) return 0;
  const setA = new Set(tokensA);
  let intersection = 0;
  for (const t of tokensB) {
    if (setA.has(t)) intersection++;
  }
  const union = setA.size + tokensB.length - intersection;
  return union === 0 ? 0 : intersection / union;
}

function safeRatio(a: unknown, b: unknown): number {
  const na = a != null ? Number(a) : null;
  const nb = b != null ? Number(b) : null;
  if (na === null || nb === null || na <= 0 || nb <= 0) return 0;
  return Math.min(na, nb) / Math.max(na, nb);
}

function computeTradeActionSimilarity(
  yoursTrade: string | null, yoursAction: string | null,
  adjTrade: string | null,   adjAction: string | null,
): number {
  const tradeScore = yoursTrade && adjTrade && yoursTrade === adjTrade ? 1 : 0;
  const actionScore = yoursAction && adjAction && yoursAction === adjAction ? 1 : 0;
  return 0.6 * tradeScore + 0.4 * actionScore;
}

function computeQuantityUnitSimilarity(
  yoursQty: unknown, yoursUnit: string | null,
  adjQty: unknown,   adjUnit: string | null,
): number {
  const unitScore = yoursUnit && adjUnit && yoursUnit === adjUnit ? 1 : 0;
  const qtyRatio  = safeRatio(yoursQty, adjQty);
  if (!yoursUnit && !adjUnit && yoursQty == null && adjQty == null) return 0;
  return 0.5 * unitScore + 0.5 * qtyRatio;
}

function computeZoneCorrespondenceSimilarity(
  yoursZoneId: string | null,
  adjZoneId: string | null,
  lookup: CorrespondenceLookup,
): number {
  if (!yoursZoneId || !adjZoneId) return 0;
  return lookup.get(`${yoursZoneId}__${adjZoneId}`)?.confidence ?? 0;
}

function buildBoosts(
  yoursZoneId: string | null,
  adjZoneId: string | null,
  lookup: CorrespondenceLookup,
  verifiedYoursZones: Set<string>,
  verifiedAdjZones: Set<string>,
): N3ZoneBoost[] {
  if (!yoursZoneId || !adjZoneId) return [];
  const corr = lookup.get(`${yoursZoneId}__${adjZoneId}`);
  if (corr) {
    // In-zone pair: apply positive boost scaled by correspondence confidence
    const boostType = corr.verificationStatus as keyof typeof ZONE_BOOSTS;
    const baseBoost = ZONE_BOOSTS[boostType] ?? 0;
    return [{ type: boostType, value: baseBoost * corr.confidence }];
  }
  // Cross-zone pair: if both zones are part of a verified correspondence
  // (just not with each other), apply the outside_verified penalty so the
  // global assignment prefers in-zone pairs over near-identical cross-zone ones.
  if (verifiedYoursZones.has(yoursZoneId) && verifiedAdjZones.has(adjZoneId)) {
    return [{ type: 'outside_verified', value: ZONE_BOOSTS.outside_verified }];
  }
  return [];
}

function computeSequenceSimilarity(
  yoursPage: number, yoursLine: number,
  adjPage: number,   adjLine: number,
): number {
  const pageScore = Math.max(0, 1 - Math.abs(yoursPage - adjPage) / 10);
  const lineScore = Math.max(0, 1 - Math.abs(yoursLine - adjLine) / 100);
  return 0.5 * pageScore + 0.5 * lineScore;
}

function computeSpecialFlagCompatibility(
  yoursFlags: string[],
  adjFlags: string[],
): number {
  const ySet = new Set(yoursFlags);
  const aSet = new Set(adjFlags);
  if (ySet.size === 0 && aSet.size === 0) return 1.0;
  if (ySet.size === 0 || aSet.size === 0) return 0.5;
  const allSame = ySet.size === aSet.size && [...ySet].every(f => aSet.has(f));
  if (allSame) return 1.0;
  let intersect = 0;
  for (const f of ySet) if (aSet.has(f)) intersect++;
  return intersect > 0 ? 0.3 : 0.0;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function scoreCandidatesN3(
  comparisonId: string,
  logger: StepLogger,
): Promise<ScoreCandidatesN3Result> {

  // ── 1. Load line items ─────────────────────────────────────────────────────
  const lineItems = await prisma.n3LineItem.findMany({
    where: { comparisonId },
    select: {
      id: true,
      zoneId: true,
      source: true,
      descriptionTokens: true,
      trade: true,
      action: true,
      itemCode: true,
      normalizedQuantity: true,
      normalizedUnit: true,
      totalAmount: true,
      unitPrice: true,
      specialFlags: true,
      pageNumber: true,
      sourceLineNumber: true,
    },
  });
  const itemMap = new Map(lineItems.map(li => [li.id, li]));

  // ── 2. Build zone correspondence lookup ───────────────────────────────────
  const correspondences = await prisma.n3ZoneCorrespondence.findMany({
    where: { comparisonId },
    select: {
      verificationStatus: true,
      confidence: true,
      yourZones:     { select: { id: true } },
      adjusterZones: { select: { id: true } },
    },
  });

  const corrLookup: CorrespondenceLookup = new Map();
  const verifiedYoursZones = new Set<string>();
  const verifiedAdjZones   = new Set<string>();
  for (const corr of correspondences) {
    const conf = Number(corr.confidence);
    for (const yz of corr.yourZones) {
      verifiedYoursZones.add(yz.id);
      for (const az of corr.adjusterZones) {
        verifiedAdjZones.add(az.id);
        corrLookup.set(`${yz.id}__${az.id}`, {
          confidence: conf,
          verificationStatus: corr.verificationStatus,
        });
      }
    }
  }

  // ── 3. Load candidate edges ────────────────────────────────────────────────
  const edges = await prisma.n3CandidateEdge.findMany({
    where: { comparisonId },
    select: { id: true, sourceItemId: true, targetItemId: true },
  });

  // ── 4. Cosine similarities via SQL (single query for all pairs) ────────────
  type CosineRow = { edge_id: string; cosine_sim: number };
  const cosineRows = await prisma.$queryRaw<CosineRow[]>`
    SELECT e.id               AS edge_id,
           (1 - (li_y.embedding <=> li_a.embedding))::float AS cosine_sim
    FROM   n3_candidate_edges e
    JOIN   n3_line_items li_y ON li_y.id = e.source_item_id
    JOIN   n3_line_items li_a ON li_a.id = e.target_item_id
    WHERE  e.comparison_id::text = ${comparisonId}
      AND  li_y.embedding IS NOT NULL
      AND  li_a.embedding IS NOT NULL
  `;
  const cosineMap = new Map<string, number>(
    cosineRows.map(r => [r.edge_id, Math.max(0, Math.min(1, Number(r.cosine_sim)))]),
  );

  logger.info('[n3/score-candidates] data loaded', {
    comparisonId,
    lineItems: lineItems.length,
    correspondences: correspondences.length,
    edges: edges.length,
    cosineRows: cosineRows.length,
  });

  // ── 5. Score all edges ─────────────────────────────────────────────────────
  type ScoredEdge = {
    id: string;
    featuresJson: N3CandidateScoreFeatures;
    boostsJson: N3ZoneBoost[];
    rawScore: number;
    finalScore: number;
    isRejected: boolean;
  };

  const scored: ScoredEdge[] = [];

  for (const edge of edges) {
    const yours = itemMap.get(edge.sourceItemId);
    const adj   = itemMap.get(edge.targetItemId);
    if (!yours || !adj) continue;

    const features: N3CandidateScoreFeatures = {
      descriptionFuzzySimilarity:    computeJaccard(yours.descriptionTokens, adj.descriptionTokens),
      descriptionSemanticSimilarity: cosineMap.get(edge.id) ?? 0,
      tradeActionSimilarity:         computeTradeActionSimilarity(yours.trade, yours.action, adj.trade, adj.action),
      materialObjectSimilarity:      0,  // stub — Phase 10 NLP not yet built
      quantityUnitSimilarity:        computeQuantityUnitSimilarity(yours.normalizedQuantity, yours.normalizedUnit, adj.normalizedQuantity, adj.normalizedUnit),
      totalSimilarity:               safeRatio(yours.totalAmount, adj.totalAmount),
      unitPriceSimilarity:           safeRatio(yours.unitPrice, adj.unitPrice),
      itemCodeSimilarity:            yours.itemCode && adj.itemCode && yours.itemCode === adj.itemCode ? 1 : 0,
      zoneCorrespondenceSimilarity:  computeZoneCorrespondenceSimilarity(yours.zoneId, adj.zoneId, corrLookup),
      sequenceSimilarity:            computeSequenceSimilarity(yours.pageNumber, yours.sourceLineNumber, adj.pageNumber, adj.sourceLineNumber),
      specialFlagCompatibility:      computeSpecialFlagCompatibility(yours.specialFlags, adj.specialFlags),
    };

    const boosts     = buildBoosts(yours.zoneId, adj.zoneId, corrLookup, verifiedYoursZones, verifiedAdjZones);
    const rawScore   = computeRawScore(features);
    const finalScore = computeFinalScore(rawScore, boosts);
    const isRejected = shouldRejectEdge(finalScore);

    scored.push({ id: edge.id, featuresJson: features, boostsJson: boosts, rawScore, finalScore, isRejected });
  }

  // ── 6. Batch update in chunks of 50 ───────────────────────────────────────
  const CHUNK = 50;
  for (let i = 0; i < scored.length; i += CHUNK) {
    const chunk = scored.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map(e =>
        prisma.n3CandidateEdge.update({
          where: { id: e.id },
          data: {
            featuresJson: e.featuresJson,
            boostsJson:   e.boostsJson,
            rawScore:     e.rawScore,
            finalScore:   e.finalScore,
            isRejected:   e.isRejected,
          },
        }),
      ),
    );
  }

  // ── 7. Build result summary ────────────────────────────────────────────────
  const byBucket = { highConfidence: 0, possibleMatch: 0, weakCandidate: 0, rejected: 0 };
  for (const e of scored) {
    if (e.isRejected)                                  byBucket.rejected++;
    else if (e.finalScore >= SCORE_THRESHOLDS.HIGH_CONFIDENCE) byBucket.highConfidence++;
    else if (e.finalScore >= SCORE_THRESHOLDS.POSSIBLE_MATCH)  byBucket.possibleMatch++;
    else                                               byBucket.weakCandidate++;
  }

  logger.info('[n3/score-candidates] complete', {
    comparisonId,
    scoredCount: scored.length,
    ...byBucket,
  });

  return {
    scoredCount: scored.length,
    rejectedCount: byBucket.rejected,
    byBucket,
  };
}
