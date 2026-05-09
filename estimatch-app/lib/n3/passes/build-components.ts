// ─────────────────────────────────────────────────────────────────────────────
// N3 Pipeline — Phase 14: build-components
//
// Builds the sparse bipartite candidate graph from non-rejected Phase 13 edges
// and partitions it into connected components using Union-Find (disjoint set
// union with path compression + union by rank).
//
// Each component becomes one row in `n3_match_components` and is solved
// independently in Phase 15 (Hungarian assignment). Items that appear in no
// surviving edge are "singletons" — they will surface as unmatched (missing or
// added) in Phase 18.
//
// Component classification (§17.3):
//   small  — total items ≤  50 → exact Hungarian in Phase 15
//   medium — total items ≤ 250 → pruned Hungarian in Phase 15
//   large  — total items >  250 → greedy + repair in Phase 15
//
// isAmbiguous = true when a component has more than one item on either side.
// Phase 17 (LLM adjudication) may be invoked for ambiguous components whose
// Hungarian assignment leaves unresolved conflicts.
//
// Idempotent: deletes prior components for the comparison before inserting.
//
// Architecture refs: N3.md §Phase 14, §17.2–§17.3 (graph + component strategy).
// ─────────────────────────────────────────────────────────────────────────────

import prisma from '@/lib/prisma';
import type { StepLogger } from '@/lib/n3/passes/detect-zones';
import { COMPONENT_SIZE } from '@/lib/n3/constants';
import type { N3ComponentSize } from '@/lib/n3/types';

// ── Return type ───────────────────────────────────────────────────────────────

export type BuildComponentsN3Result = {
  componentCount: number;
  edgesConsumed: number;
  bySize: { small: number; medium: number; large: number };
  singletonYours: number;    // yours items not in any surviving edge → will be "added"
  singletonAdj: number;      // adj items not in any surviving edge → will be "missing"
};

// ── Union-Find (path compression + union by rank) ─────────────────────────────

class UnionFind {
  private parent = new Map<string, string>();
  private rank   = new Map<string, number>();

  add(id: string): void {
    if (!this.parent.has(id)) {
      this.parent.set(id, id);
      this.rank.set(id, 0);
    }
  }

  find(id: string): string {
    let root = id;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    // Path compression
    let cur = id;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank.get(ra) ?? 0;
    const rankB = this.rank.get(rb) ?? 0;
    if (rankA < rankB) {
      this.parent.set(ra, rb);
    } else if (rankA > rankB) {
      this.parent.set(rb, ra);
    } else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rankA + 1);
    }
  }

  /** Returns Map<rootId, allItemIdsInComponent> */
  getComponents(): Map<string, string[]> {
    const comps = new Map<string, string[]>();
    for (const id of this.parent.keys()) {
      const root = this.find(id);
      const bucket = comps.get(root);
      if (bucket) bucket.push(id);
      else comps.set(root, [id]);
    }
    return comps;
  }
}

// ── Component size classification ─────────────────────────────────────────────

function classifySize(yoursCount: number, adjCount: number): N3ComponentSize {
  const total = yoursCount + adjCount;
  if (total <= COMPONENT_SIZE.SMALL_MAX)  return 'small';
  if (total <= COMPONENT_SIZE.MEDIUM_MAX) return 'medium';
  return 'large';
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function buildComponentsN3(
  comparisonId: string,
  logger: StepLogger,
): Promise<BuildComponentsN3Result> {

  // ── 1. Load non-rejected edges ─────────────────────────────────────────────
  const edges = await prisma.n3CandidateEdge.findMany({
    where: { comparisonId, isRejected: false },
    select: { id: true, sourceItemId: true, targetItemId: true },
  });

  // ── 2. Load all line items to know which side each item belongs to ──────────
  const lineItems = await prisma.n3LineItem.findMany({
    where: { comparisonId },
    select: { id: true, source: true },
  });
  const sideMap = new Map(lineItems.map(li => [li.id, li.source as 'yours' | 'adjuster']));

  logger.info('[n3/build-components] loaded', {
    comparisonId,
    survivingEdges: edges.length,
    totalItems: lineItems.length,
  });

  // ── 3. Run Union-Find over items that appear in surviving edges ────────────
  const uf = new UnionFind();
  const itemsInEdges = new Set<string>();

  for (const edge of edges) {
    uf.add(edge.sourceItemId);
    uf.add(edge.targetItemId);
    uf.union(edge.sourceItemId, edge.targetItemId);
    itemsInEdges.add(edge.sourceItemId);
    itemsInEdges.add(edge.targetItemId);
  }

  // ── 4. Extract and classify components ────────────────────────────────────
  const rawComponents = uf.getComponents();

  type ComponentRow = {
    comparisonId: string;
    sourceItemIds: string[];
    targetItemIds: string[];
    size: string;
    isAmbiguous: boolean;
  };

  const componentRows: ComponentRow[] = [];
  const bySize = { small: 0, medium: 0, large: 0 };

  for (const [, itemIds] of rawComponents) {
    const yoursIds = itemIds.filter(id => sideMap.get(id) === 'yours');
    const adjIds   = itemIds.filter(id => sideMap.get(id) === 'adjuster');

    // Skip degenerate components (items only on one side — shouldn't occur with valid edges)
    if (yoursIds.length === 0 || adjIds.length === 0) continue;

    const size        = classifySize(yoursIds.length, adjIds.length);
    const isAmbiguous = yoursIds.length > 1 || adjIds.length > 1;

    bySize[size]++;
    componentRows.push({
      comparisonId,
      sourceItemIds: yoursIds,
      targetItemIds: adjIds,
      size,
      isAmbiguous,
    });
  }

  // ── 5. Singleton counts (items with no surviving edge) ─────────────────────
  const singletonYours = lineItems.filter(
    li => li.source === 'yours' && !itemsInEdges.has(li.id),
  ).length;
  const singletonAdj = lineItems.filter(
    li => li.source === 'adjuster' && !itemsInEdges.has(li.id),
  ).length;

  // ── 6. Idempotent write ────────────────────────────────────────────────────
  await prisma.n3MatchComponent.deleteMany({ where: { comparisonId } });

  if (componentRows.length > 0) {
    await prisma.n3MatchComponent.createMany({ data: componentRows });
  }

  logger.info('[n3/build-components] complete', {
    comparisonId,
    componentCount: componentRows.length,
    edgesConsumed: edges.length,
    bySize,
    singletonYours,
    singletonAdj,
  });

  return {
    componentCount: componentRows.length,
    edgesConsumed: edges.length,
    bySize,
    singletonYours,
    singletonAdj,
  };
}
