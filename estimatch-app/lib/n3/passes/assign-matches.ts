// ─────────────────────────────────────────────────────────────────────────────
// N3 Pipeline — Phase 15: assign-matches
//
// Runs the Hungarian (Munkres) minimum-cost assignment algorithm on each
// connected component produced by Phase 14. For every component:
//
//   1. Build an N×N cost matrix (N = max(yoursCount, adjCount)).
//      cost[i][j] = 1 − finalScore  if a non-rejected edge exists, else 1.0.
//      Dummy rows/cols (added for square padding) get UNMATCHED_COST = 0.70.
//   2. Run O(n³) Hungarian via dual-variable Jonker–Volgenant reduction.
//   3. Extract 1:1 assignments; cells assigned to dummy cols/rows → unmatched.
//   4. Write one N3MatchDecision row per yours item:
//        matched (yours→adj)  → decisionType one_to_one | possible
//        unmatched yours      → decisionType unmatched, adjusterItemIds []
//        unmatched adj        → decisionType unmatched, yourItemIds []
//
// Idempotent: deletes prior decisions before inserting.
//
// decisionType mapping (post-calibration thresholds):
//   finalScore ≥ 0.75 → one_to_one, decidedBy auto_high_confidence
//   finalScore ≥ 0.55 → one_to_one, decidedBy assignment
//   finalScore ≥ 0.30 → possible,   decidedBy assignment
//   finalScore = 0    → unmatched,  decidedBy assignment
//
// Architecture refs: N3.md §Phase 15, §17.3, §A.4.
// ─────────────────────────────────────────────────────────────────────────────

import prisma from '@/lib/prisma';
import type { StepLogger } from '@/lib/n3/passes/detect-zones';
import { SCORE_THRESHOLDS } from '@/lib/n3/constants';

// ── Return type ───────────────────────────────────────────────────────────────

export type AssignMatchesN3Result = {
  decisionCount: number;
  matchedCount: number;     // one_to_one + possible
  possibleCount: number;    // matched but below POSSIBLE_MATCH threshold
  unmatchedYours: number;   // yours items with no adj assignment
  unmatchedAdj: number;     // adj items with no yours assignment
  zoneRepairCount: number;  // cross-zone assignments corrected by zone conflict repair
};

// ── Cost constants ────────────────────────────────────────────────────────────

// Cost for a cell with no candidate edge (unrelated pair).
const NO_EDGE_COST = 1.0;
// Cost for a dummy row/col (padding to make square).
// Set to 1 - REJECT so any real surviving edge is preferred over staying unmatched.
const UNMATCHED_COST = 1.0 - SCORE_THRESHOLDS.REJECT;  // 0.70

// ── Hungarian algorithm (O(n³), dual-variable / Jonker–Volgenant) ─────────────
//
// Accepts an n×n cost matrix. Returns result[i] = j meaning row i is assigned
// to column j (0-indexed). Works on square matrices only — caller must pad.

function hungarianMin(cost: number[][]): number[] {
  const n = cost.length;
  const u   = new Array<number>(n + 1).fill(0);
  const v   = new Array<number>(n + 1).fill(0);
  const p   = new Array<number>(n + 1).fill(0);   // p[j] = row assigned to col j (1-indexed)
  const way = new Array<number>(n + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minVal = new Array<number>(n + 1).fill(Infinity);
    const used   = new Array<boolean>(n + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1    = -1;

      for (let j = 1; j <= n; j++) {
        if (!used[j]) {
          const val = cost[i0 - 1][j - 1] - u[i0] - v[j];
          if (val < minVal[j]) { minVal[j] = val; way[j] = j0; }
          if (minVal[j] < delta) { delta = minVal[j]; j1 = j; }
        }
      }

      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else         { minVal[j] -= delta; }
      }

      j0 = j1!;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0];
      p[j0]    = p[j1];
      j0       = j1;
    } while (j0);
  }

  const ans = new Array<number>(n).fill(-1);
  for (let j = 1; j <= n; j++) {
    if (p[j] > 0) ans[p[j] - 1] = j - 1;
  }
  return ans;
}

// ── Decision type helpers ─────────────────────────────────────────────────────

function decisionType(finalScore: number): string {
  if (finalScore >= SCORE_THRESHOLDS.POSSIBLE_MATCH) return 'one_to_one';
  return 'possible';   // >= REJECT but < POSSIBLE_MATCH
}

function decidedBy(finalScore: number): string {
  if (finalScore >= SCORE_THRESHOLDS.HIGH_CONFIDENCE) return 'auto_high_confidence';
  return 'assignment';
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function assignMatchesN3(
  comparisonId: string,
  logger: StepLogger,
): Promise<AssignMatchesN3Result> {

  // ── 1. Load components ─────────────────────────────────────────────────────
  const components = await prisma.n3MatchComponent.findMany({
    where: { comparisonId },
    select: { id: true, sourceItemIds: true, targetItemIds: true },
  });

  // ── 2. Load all surviving edges indexed for O(1) lookup ───────────────────
  const allEdges = await prisma.n3CandidateEdge.findMany({
    where: { comparisonId, isRejected: false },
    select: { id: true, sourceItemId: true, targetItemId: true, finalScore: true, boostsJson: true },
  });

  type BoostEntry = { type: string; value: number };
  function hasOutsideVerifiedPenalty(boostsJson: unknown): boolean {
    if (!Array.isArray(boostsJson)) return false;
    return (boostsJson as BoostEntry[]).some(b => b.type === 'outside_verified');
  }

  type EdgeInfo = { id: string; finalScore: number; isCrossZone: boolean };
  type EdgeRef  = EdgeInfo & { sourceId: string; targetId: string };
  const edgeLookup    = new Map<string, EdgeInfo>();
  // Pre-built per-yours and per-adj edge indices to avoid O(edges) scans during
  // the rescue and zone-repair passes. Building once is O(edges); each lookup
  // is then O(degree-of-item) instead of O(all-edges).
  const edgesByYours  = new Map<string, EdgeRef[]>();
  const edgesByAdj    = new Map<string, EdgeRef[]>();
  for (const e of allEdges) {
    const info: EdgeInfo = {
      id: e.id,
      finalScore: Number(e.finalScore),
      isCrossZone: hasOutsideVerifiedPenalty(e.boostsJson),
    };
    edgeLookup.set(`${e.sourceItemId}__${e.targetItemId}`, info);
    const ref: EdgeRef = { ...info, sourceId: e.sourceItemId, targetId: e.targetItemId };
    const yArr = edgesByYours.get(e.sourceItemId) ?? [];
    yArr.push(ref);
    edgesByYours.set(e.sourceItemId, yArr);
    const aArr = edgesByAdj.get(e.targetItemId) ?? [];
    aArr.push(ref);
    edgesByAdj.set(e.targetItemId, aArr);
  }

  logger.info('[n3/assign-matches] loaded', {
    comparisonId,
    components: components.length,
    survivingEdges: allEdges.length,
  });

  // ── 3. Solve each component ────────────────────────────────────────────────

  type DecisionRow = {
    comparisonId: string;
    componentId:     string | null;
    topEdgeId:       string | null;
    decisionType:    string;
    yourItemIds:     string[];
    adjusterItemIds: string[];
    finalScore:      number;
    decidedBy:       string;
  };

  const decisions: DecisionRow[] = [];
  let matchedCount = 0;
  let possibleCount = 0;
  let unmatchedYours = 0;
  let unmatchedAdj   = 0;

  for (const comp of components) {
    const yours = comp.sourceItemIds;
    const adj   = comp.targetItemIds;
    const n     = yours.length;
    const m     = adj.length;
    const N     = Math.max(n, m);

    // Build N×N cost matrix
    const cost: number[][] = [];
    for (let i = 0; i < N; i++) {
      cost[i] = [];
      for (let j = 0; j < N; j++) {
        if (i >= n || j >= m) {
          cost[i][j] = UNMATCHED_COST;  // dummy row/col
        } else {
          const edge = edgeLookup.get(`${yours[i]}__${adj[j]}`);
          cost[i][j] = edge ? 1 - edge.finalScore : NO_EDGE_COST;
        }
      }
    }

    // Run Hungarian
    const assignment = hungarianMin(cost);

    // Track which adj cols received a real assignment
    const assignedAdjCols = new Set<number>();

    for (let i = 0; i < n; i++) {
      const j = assignment[i];

      if (j < m) {
        // Real assignment (yours[i] → adj[j])
        assignedAdjCols.add(j);
        const edge = edgeLookup.get(`${yours[i]}__${adj[j]}`);
        const fs   = edge?.finalScore ?? 0;
        const dtype = decisionType(fs);
        if (dtype === 'possible') possibleCount++;
        else matchedCount++;

        decisions.push({
          comparisonId,
          componentId:     comp.id,
          topEdgeId:       edge?.id ?? null,
          decisionType:    dtype,
          yourItemIds:     [yours[i]],
          adjusterItemIds: [adj[j]],
          finalScore:      fs,
          decidedBy:       decidedBy(fs),
        });
      } else {
        // Dummy column → yours item is unmatched
        unmatchedYours++;
        decisions.push({
          comparisonId,
          componentId:     comp.id,
          topEdgeId:       null,
          decisionType:    'unmatched',
          yourItemIds:     [yours[i]],
          adjusterItemIds: [],
          finalScore:      0,
          decidedBy:       'assignment',
        });
      }
    }

    // Adj items not assigned (dummy rows or unassigned cols when m > n)
    for (let j = 0; j < m; j++) {
      if (!assignedAdjCols.has(j)) {
        unmatchedAdj++;
        decisions.push({
          comparisonId,
          componentId:     comp.id,
          topEdgeId:       null,
          decisionType:    'unmatched',
          yourItemIds:     [],
          adjusterItemIds: [adj[j]],
          finalScore:      0,
          decidedBy:       'assignment',
        });
      }
    }
  }

  // ── 4. Bidirectional-best rescue pass ──────────────────────────────────────
  // Hungarian's global cost minimization can sacrifice a clearly-mutual-best pair
  // for a marginal aggregate gain elsewhere. This pass detects pairs where both
  // items are unmatched, the edge between them is each side's TOP unmatched
  // candidate, and the score is ≥ POSSIBLE_MATCH. Such pairs are merged into
  // one one_to_one decision (decidedBy: 'mutual_best_rescue').
  let rescuedCount = 0;
  {
    const unmatchedYoursDecisions = decisions.filter(
      d => d.decisionType === 'unmatched' && d.yourItemIds.length > 0 && d.adjusterItemIds.length === 0,
    );
    const unmatchedAdjDecisionByItem = new Map(
      decisions
        .filter(d => d.decisionType === 'unmatched' && d.adjusterItemIds.length > 0 && d.yourItemIds.length === 0)
        .map(d => [d.adjusterItemIds[0], d]),
    );

    // Build per-yours best edge to ANY unmatched adj. Uses the pre-built
    // edgesByYours index to avoid scanning the full edgeLookup per decision.
    const unmatchedYoursIdSet = new Set(unmatchedYoursDecisions.map(d => d.yourItemIds[0]));
    const bestYoursToAdj = new Map<string, { adjId: string; score: number }>();
    for (const yoursId of unmatchedYoursIdSet) {
      const refs = edgesByYours.get(yoursId);
      if (!refs) continue;
      let best: { adjId: string; score: number } | null = null;
      for (const ref of refs) {
        if (!unmatchedAdjDecisionByItem.has(ref.targetId)) continue;
        if (!best || ref.finalScore > best.score) best = { adjId: ref.targetId, score: ref.finalScore };
      }
      if (best) bestYoursToAdj.set(yoursId, best);
    }
    // Build per-adj best edge from ANY unmatched yours. Uses edgesByAdj index.
    const bestAdjToYours = new Map<string, { yoursId: string; score: number }>();
    for (const adjId of unmatchedAdjDecisionByItem.keys()) {
      const refs = edgesByAdj.get(adjId);
      if (!refs) continue;
      let best: { yoursId: string; score: number } | null = null;
      for (const ref of refs) {
        if (!unmatchedYoursIdSet.has(ref.sourceId)) continue;
        if (!best || ref.finalScore > best.score) best = { yoursId: ref.sourceId, score: ref.finalScore };
      }
      if (best) bestAdjToYours.set(adjId, best);
    }

    const rescuedYoursIds = new Set<string>();
    const rescuedAdjIds   = new Set<string>();

    for (const d of unmatchedYoursDecisions) {
      const yoursId = d.yourItemIds[0];
      if (rescuedYoursIds.has(yoursId)) continue;
      const yBest = bestYoursToAdj.get(yoursId);
      if (!yBest || yBest.score < SCORE_THRESHOLDS.POSSIBLE_MATCH) continue;
      if (rescuedAdjIds.has(yBest.adjId)) continue;
      const aBest = bestAdjToYours.get(yBest.adjId);
      if (!aBest || aBest.yoursId !== yoursId) continue;          // not mutual

      // Mutual best AND score >= POSSIBLE_MATCH → rescue
      const fs = yBest.score;
      const edge = edgeLookup.get(`${yoursId}__${yBest.adjId}`)!;
      d.decisionType    = decisionType(fs);
      d.adjusterItemIds = [yBest.adjId];
      d.finalScore      = fs;
      d.topEdgeId       = edge.id;
      d.decidedBy       = 'mutual_best_rescue';

      // Drop the unmatched-adj decision (it's now claimed by this yours)
      const adjDecision = unmatchedAdjDecisionByItem.get(yBest.adjId)!;
      const idx = decisions.indexOf(adjDecision);
      if (idx >= 0) decisions.splice(idx, 1);

      // Adjust counters
      unmatchedYours--;
      unmatchedAdj--;
      if (d.decisionType === 'possible') possibleCount++;
      else matchedCount++;

      rescuedYoursIds.add(yoursId);
      rescuedAdjIds.add(yBest.adjId);
      rescuedCount++;
    }
  }

  if (rescuedCount > 0) {
    logger.info('[n3/assign-matches] mutual-best rescue', { comparisonId, rescuedCount });
  }

  // ── 4b. Zone conflict repair pass ─────────────────────────────────────────
  // Hungarian minimises global cost but can produce cross-zone pairings when
  // many identical-description items exist across zones. This pass detects any
  // decision whose assigned edge carries an outside_verified penalty and checks
  // whether a better-scoring edge exists for the same yours item.
  //
  // Two repair cases:
  //   A. Better adj target is unmatched → simple reassignment.
  //   B. Better adj target is matched to another yours item → pairwise swap
  //      when total score improves OR zone conflict count decreases.
  let zoneRepairCount = 0;
  {
    // Build adjId → decision-array-index map for O(1) lookup
    const adjToIdx = new Map<string, number>();
    for (let i = 0; i < decisions.length; i++) {
      const a = decisions[i].adjusterItemIds[0];
      if (a) adjToIdx.set(a, i);
    }

    // Build per-yours best alternative edge (excluding current assignment)
    // Iterate over cross-zone decisions only
    for (let i = 0; i < decisions.length; i++) {
      const d1 = decisions[i];
      if (d1.yourItemIds.length === 0 || d1.adjusterItemIds.length === 0) continue;
      if (d1.decisionType === 'unmatched') continue;

      const yoursId  = d1.yourItemIds[0];
      const curAdjId = d1.adjusterItemIds[0];
      const curEdge  = edgeLookup.get(`${yoursId}__${curAdjId}`);
      if (!curEdge?.isCrossZone) continue;  // only repair cross-zone assignments

      // Find best surviving edge from yoursId to any OTHER adj item.
      // Uses the pre-built edgesByYours index instead of scanning edgeLookup.
      let bestAdjId: string | null = null;
      let bestScore = d1.finalScore;  // must strictly beat current
      let bestEdgeId = '';
      const yRefs = edgesByYours.get(yoursId);
      if (yRefs) {
        for (const ref of yRefs) {
          if (ref.targetId === curAdjId) continue;
          if (ref.finalScore > bestScore) {
            bestScore  = ref.finalScore;
            bestAdjId  = ref.targetId;
            bestEdgeId = ref.id;
          }
        }
      }
      if (!bestAdjId) continue;  // no improvement available

      // ── Case A: bestAdj is unmatched ──────────────────────────────────────
      if (!adjToIdx.has(bestAdjId)) {
        adjToIdx.delete(curAdjId);
        adjToIdx.set(bestAdjId, i);
        d1.adjusterItemIds = [bestAdjId];
        d1.finalScore      = bestScore;
        d1.topEdgeId       = bestEdgeId;
        d1.decidedBy       = 'zone_repair';
        d1.decisionType    = decisionType(bestScore);
        zoneRepairCount++;
        continue;
      }

      // ── Case B: bestAdj is matched to another yours item ──────────────────
      const d2Idx   = adjToIdx.get(bestAdjId)!;
      const d2      = decisions[d2Idx];
      if (d2.yourItemIds.length === 0) continue;
      const yoursId2 = d2.yourItemIds[0];

      // What score would d2 get if it took curAdj instead?
      const swapEdge  = edgeLookup.get(`${yoursId2}__${curAdjId}`);
      const swapScore = swapEdge?.finalScore ?? 0;

      const d2CurrentEdge = edgeLookup.get(`${yoursId2}__${bestAdjId}`);
      const d2IsCrossZone = d2CurrentEdge?.isCrossZone ?? false;
      const bestEdgeInfo  = edgeLookup.get(`${yoursId}__${bestAdjId}`)!;
      const swapEdgeIsCrossZone = swapEdge?.isCrossZone ?? false;

      const currentTotal = d1.finalScore + d2.finalScore;
      const swapTotal    = bestScore + swapScore;

      // Accept the swap if total score improves OR zone conflicts reduce
      const scoreImproves = swapTotal > currentTotal;
      const zoneImproves  = (curEdge.isCrossZone || d2IsCrossZone) &&
                            (!bestEdgeInfo.isCrossZone && !swapEdgeIsCrossZone);

      if (!scoreImproves && !zoneImproves) continue;

      // Perform swap: D1 → bestAdj, D2 → curAdj
      d1.adjusterItemIds = [bestAdjId];
      d1.finalScore      = bestScore;
      d1.topEdgeId       = bestEdgeId;
      d1.decidedBy       = 'zone_repair';
      d1.decisionType    = decisionType(bestScore);

      d2.adjusterItemIds = swapScore > 0 ? [curAdjId] : [];
      d2.finalScore      = swapScore;
      d2.topEdgeId       = swapEdge?.id ?? null;
      d2.decidedBy       = 'zone_repair';
      d2.decisionType    = swapScore >= SCORE_THRESHOLDS.POSSIBLE_MATCH
        ? 'one_to_one'
        : swapScore >= SCORE_THRESHOLDS.REJECT
        ? 'possible'
        : 'unmatched';

      adjToIdx.set(bestAdjId, i);
      if (swapScore > 0) {
        adjToIdx.set(curAdjId, d2Idx);
      } else {
        adjToIdx.delete(curAdjId);
        if (d2.decisionType === 'unmatched') {
          unmatchedYours++;
          unmatchedAdj--;
        }
      }
      zoneRepairCount++;
    }
  }

  if (zoneRepairCount > 0) {
    logger.info('[n3/assign-matches] zone conflict repair', { comparisonId, zoneRepairCount });
  }

  // ── 5. Idempotent write ────────────────────────────────────────────────────
  await prisma.n3MatchDecision.deleteMany({ where: { comparisonId } });

  const BATCH = 500;
  for (let i = 0; i < decisions.length; i += BATCH) {
    await prisma.n3MatchDecision.createMany({ data: decisions.slice(i, i + BATCH) });
  }

  logger.info('[n3/assign-matches] complete', {
    comparisonId,
    decisionCount: decisions.length,
    matchedCount,
    possibleCount,
    unmatchedYours,
    unmatchedAdj,
  });

  return {
    decisionCount: decisions.length,
    matchedCount,
    possibleCount,
    unmatchedYours,
    unmatchedAdj,
    zoneRepairCount,
  };
}
