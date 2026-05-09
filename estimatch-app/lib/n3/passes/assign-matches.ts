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
    select: { id: true, sourceItemId: true, targetItemId: true, finalScore: true },
  });

  type EdgeInfo = { id: string; finalScore: number };
  const edgeLookup = new Map<string, EdgeInfo>();
  for (const e of allEdges) {
    edgeLookup.set(`${e.sourceItemId}__${e.targetItemId}`, {
      id: e.id,
      finalScore: Number(e.finalScore),
    });
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

  // ── 4. Idempotent write ────────────────────────────────────────────────────
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
  };
}
