// ─────────────────────────────────────────────────────────────────────────────
// N3 Pipeline — Phase 16: group-matching
//
// Looks for one-to-many matches that Phase 15's 1:1 Hungarian missed.
// Primary target: unmatched yours items (items on your estimate with no adj
// counterpart) — these may actually be "summary" items that the adjuster split
// into 2-3 smaller line items.
//
// Algorithm:
//   1. Load all Phase 15 decisions.
//   2. For each unmatched yours item:
//      a. Find all its non-rejected edges to adj items that are only weakly
//         matched (decisionType = 'possible') — their adj items are re-claimable.
//      b. Sort candidates by finalScore, keep top-K (GROUP_MATCH.TOP_K_CANDIDATES).
//      c. Generate all combinations of size 2 to MAX_GROUP_SIZE.
//      d. Score each combination using 7 N3GroupScoreFeatures (weighted sum).
//      e. If bestGroupScore > GROUP_ACCEPT_THRESHOLD AND
//            bestGroupScore > bestIndividualScore + GROUP_MARGIN:
//         → write `grouped` decision, mark adj items' previous `possible`
//           decisions as `unmatched` (they are now claimed by the group).
//   3. Idempotent: writes new decisions; modifies existing ones in place.
//
// Scope: one_to_many only (yours → group of adj items). Many-to-one is
// deferred to Phase 17 LLM adjudication.
//
// Architecture refs: N3.md §Phase 16, §19.3, §A.6.
// ─────────────────────────────────────────────────────────────────────────────

import prisma from '@/lib/prisma';
import type { StepLogger } from '@/lib/n3/passes/detect-zones';
import { GROUP_MATCH } from '@/lib/n3/constants';

// ── Return type ───────────────────────────────────────────────────────────────

export type GroupMatchingN3Result = {
  groupedCount: number;       // new `grouped` decisions written
  relinquishedAdj: number;    // adj items moved from `possible` → adj unmatched
};

// ── Group scoring weights (§19.3) ─────────────────────────────────────────────

const GW = {
  combinedDescriptionCoverage: 0.30,
  summedTotalSimilarity:        0.25,
  tradeActionCoverage:          0.15,
  averagePairScore:             0.10,
  zoneCompatibility:            0.10,
  sequenceProximity:            0.05,
  specialFlagCompatibility:     0.05,
} as const;

// Group must exceed this absolute score to be accepted.
const GROUP_ACCEPT_THRESHOLD = 0.45;
// Group must beat best individual by this margin to justify reassigning adj items.
const GROUP_MARGIN = 0.10;

// ── Helpers ───────────────────────────────────────────────────────────────────

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setB) if (setA.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

function safeRatio(a: unknown, b: unknown): number {
  const na = a != null ? Number(a) : 0;
  const nb = b != null ? Number(b) : 0;
  if (na <= 0 || nb <= 0) return 0;
  return Math.min(na, nb) / Math.max(na, nb);
}

function combinations<T>(arr: T[], size: number): T[][] {
  if (size > arr.length) return [];
  if (size === 1) return arr.map(x => [x]);
  const result: T[][] = [];
  for (let i = 0; i <= arr.length - size; i++) {
    for (const rest of combinations(arr.slice(i + 1), size - 1)) {
      result.push([arr[i], ...rest]);
    }
  }
  return result;
}

type ItemSnapshot = {
  id: string;
  descriptionTokens: string[];
  trade: string | null;
  action: string | null;
  totalAmount: unknown;
  specialFlags: string[];
  pageNumber: number;
  sourceLineNumber: number;
  zoneId: string | null;
};

type EdgeInfo = { adjItemId: string; finalScore: number };

// Zone correspondence lookup, keyed by `${yoursZoneId}__${adjusterZoneId}`.
// Matches the lookup built by Phase 13 (score-candidates.ts) so cross-zone
// correspondences (e.g. "Master Bath" ↔ "Master Bathroom") are recognised here.
type CorrespondenceLookup = Map<string, { confidence: number }>;

/** True when the adj item's zone is in correspondence with the source's zone. */
function isZoneCompatible(
  sourceZoneId: string | null,
  adjZoneId: string | null,
  corrLookup: CorrespondenceLookup,
): boolean {
  if (!sourceZoneId || !adjZoneId) return false;
  if (sourceZoneId === adjZoneId) return true;             // same N3Zone row
  return corrLookup.has(`${sourceZoneId}__${adjZoneId}`);  // cross-zone correspondence
}

function scoreGroup(
  source: ItemSnapshot,
  group: ItemSnapshot[],
  edges: EdgeInfo[],  // edges from source → each group member
  corrLookup: CorrespondenceLookup,
): number {
  // Feature 1: combinedDescriptionCoverage
  const unionTokens = Array.from(new Set(group.flatMap(g => g.descriptionTokens)));
  const f1 = jaccard(unionTokens, source.descriptionTokens);

  // Feature 2: summedTotalSimilarity
  const groupTotal = group.reduce((s, g) => s + (g.totalAmount != null ? Number(g.totalAmount) : 0), 0);
  const f2 = safeRatio(groupTotal, source.totalAmount);

  // Feature 3: tradeActionCoverage
  const groupTrades   = new Set(group.map(g => g.trade).filter(Boolean));
  const groupActions  = new Set(group.map(g => g.action).filter(Boolean));
  const tradeMatch  = source.trade   && groupTrades.has(source.trade)   ? 1 : 0;
  const actionMatch = source.action  && groupActions.has(source.action) ? 1 : 0;
  const f3 = source.trade || source.action
    ? (tradeMatch * 0.6 + actionMatch * 0.4)
    : 0.5;  // neutral when neither side has trade/action

  // Feature 4: averagePairScore
  const edgeMap = new Map(edges.map(e => [e.adjItemId, e.finalScore]));
  const scores = group.map(g => edgeMap.get(g.id) ?? 0);
  const f4 = scores.reduce((s, v) => s + v, 0) / (scores.length || 1);

  // Feature 5: zoneCompatibility — fraction of group members whose zone is in
  // correspondence with source's zone (same zone OR cross-zone correspondence).
  // Previously this required exact zoneId equality, which penalised valid
  // cross-zone matches (e.g. "Master Bath" ↔ "Master Bathroom") with f5 = 0.
  const compatCount = group.filter(g => isZoneCompatible(source.zoneId, g.zoneId, corrLookup)).length;
  const f5 = group.length > 0 ? compatCount / group.length : 0;

  // Feature 6: sequenceProximity (how close to source's page/line)
  const pageScores = group.map(g =>
    Math.max(0, 1 - Math.abs(g.pageNumber - source.pageNumber) / 5),
  );
  const f6 = pageScores.reduce((s, v) => s + v, 0) / (pageScores.length || 1);

  // Feature 7: specialFlagCompatibility
  const sourceFlags = new Set(source.specialFlags);
  const allFlagsMatch = group.every(g =>
    g.specialFlags.length === source.specialFlags.length &&
    g.specialFlags.every(f => sourceFlags.has(f)),
  );
  const f7 = allFlagsMatch ? 1 : (group.every(g => g.specialFlags.length === 0) ? 1 : 0.3);

  return (
    GW.combinedDescriptionCoverage * f1 +
    GW.summedTotalSimilarity        * f2 +
    GW.tradeActionCoverage          * f3 +
    GW.averagePairScore             * f4 +
    GW.zoneCompatibility            * f5 +
    GW.sequenceProximity            * f6 +
    GW.specialFlagCompatibility     * f7
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function groupMatchingN3(
  comparisonId: string,
  logger: StepLogger,
): Promise<GroupMatchingN3Result> {

  // ── 1. Load existing decisions ─────────────────────────────────────────────
  const allDecisions = await prisma.n3MatchDecision.findMany({
    where: { comparisonId },
    select: { id: true, decisionType: true, yourItemIds: true, adjusterItemIds: true, finalScore: true, componentId: true },
  });

  const unmatchedYours = allDecisions.filter(
    d => d.decisionType === 'unmatched' && d.yourItemIds.length > 0 && d.adjusterItemIds.length === 0,
  );
  // adj items available for re-claiming (weakly matched only)
  const possibleDecisionByAdj = new Map(
    allDecisions
      .filter(d => d.decisionType === 'possible' && d.adjusterItemIds.length > 0)
      .map(d => [d.adjusterItemIds[0], d]),
  );

  if (unmatchedYours.length === 0) {
    logger.info('[n3/group-matching] no unmatched yours items — skipping', { comparisonId });
    return { groupedCount: 0, relinquishedAdj: 0 };
  }

  // ── 2. Load line items ─────────────────────────────────────────────────────
  const lineItems = await prisma.n3LineItem.findMany({
    where: { comparisonId },
    select: {
      id: true, descriptionTokens: true, trade: true, action: true,
      totalAmount: true, specialFlags: true, pageNumber: true,
      sourceLineNumber: true, zoneId: true,
    },
  });
  const itemMap = new Map<string, ItemSnapshot>(lineItems.map(li => [li.id, {
    id: li.id,
    descriptionTokens: li.descriptionTokens,
    trade: li.trade,
    action: li.action,
    totalAmount: li.totalAmount,
    specialFlags: li.specialFlags,
    pageNumber: li.pageNumber,
    sourceLineNumber: li.sourceLineNumber,
    zoneId: li.zoneId,
  }]));

  // ── 3. Load surviving edges for fast lookup ────────────────────────────────
  const edges = await prisma.n3CandidateEdge.findMany({
    where: { comparisonId, isRejected: false },
    select: { sourceItemId: true, targetItemId: true, finalScore: true },
  });
  // Map: sourceId → [{adjItemId, finalScore}]
  const edgesBySource = new Map<string, EdgeInfo[]>();
  for (const e of edges) {
    const arr = edgesBySource.get(e.sourceItemId) ?? [];
    arr.push({ adjItemId: e.targetItemId, finalScore: Number(e.finalScore) });
    edgesBySource.set(e.sourceItemId, arr);
  }

  // ── 3b. Load zone correspondences for zoneCompatibility feature ───────────
  // Mirrors the lookup built in Phase 13 so cross-zone correspondences
  // (e.g. "Master Bath" ↔ "Master Bathroom") are recognised when scoring groups.
  const correspondences = await prisma.n3ZoneCorrespondence.findMany({
    where: { comparisonId },
    select: {
      confidence:    true,
      yourZones:     { select: { id: true } },
      adjusterZones: { select: { id: true } },
    },
  });
  const corrLookup: CorrespondenceLookup = new Map();
  for (const corr of correspondences) {
    const conf = Number(corr.confidence);
    for (const yz of corr.yourZones) {
      for (const az of corr.adjusterZones) {
        corrLookup.set(`${yz.id}__${az.id}`, { confidence: conf });
      }
    }
  }

  // ── 4. Try to form groups for each unmatched yours item ───────────────────
  let groupedCount    = 0;
  let relinquishedAdj = 0;

  for (const decision of unmatchedYours) {
    const yoursId = decision.yourItemIds[0];
    const source  = itemMap.get(yoursId);
    if (!source) continue;

    // Find adj candidates: must have an edge AND must be in a `possible` decision
    const candidates = (edgesBySource.get(yoursId) ?? [])
      .filter(e => possibleDecisionByAdj.has(e.adjItemId))
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, GROUP_MATCH.TOP_K_CANDIDATES);

    if (candidates.length < GROUP_MATCH.MIN_GROUP_SIZE) continue;

    // Best individual score among candidates
    const bestIndividual = candidates[0]?.finalScore ?? 0;

    // Generate all group combos and score them
    let bestGroupScore = 0;
    let bestGroup: EdgeInfo[] = [];

    for (let size = GROUP_MATCH.MIN_GROUP_SIZE; size <= Math.min(GROUP_MATCH.MAX_GROUP_SIZE, candidates.length); size++) {
      for (const combo of combinations(candidates, size)) {
        const groupItems = combo.map(c => itemMap.get(c.adjItemId)).filter(Boolean) as ItemSnapshot[];
        const gs = scoreGroup(source, groupItems, combo, corrLookup);
        if (gs > bestGroupScore) { bestGroupScore = gs; bestGroup = combo; }
      }
    }

    // Accept group only if it clearly beats individual
    if (
      bestGroupScore < GROUP_ACCEPT_THRESHOLD ||
      bestGroupScore < bestIndividual + GROUP_MARGIN
    ) continue;

    const groupAdjIds = bestGroup.map(e => e.adjItemId);
    const groupScore  = bestGroupScore;

    logger.info('[n3/group-matching] group found', {
      comparisonId, yoursId, adjIds: groupAdjIds, groupScore,
    });

    // Write grouped decision (replace the unmatched decision)
    await prisma.n3MatchDecision.update({
      where: { id: decision.id },
      data: {
        decisionType:    'grouped',
        adjusterItemIds: groupAdjIds,
        finalScore:      groupScore,
        decidedBy:       'group_match',
        groupMatchScore: groupScore,
      },
    });
    groupedCount++;

    // Move the adj items' previous `possible` decisions to `unmatched_adj`
    for (const adjId of groupAdjIds) {
      const prevDecision = possibleDecisionByAdj.get(adjId);
      if (!prevDecision) continue;
      await prisma.n3MatchDecision.update({
        where: { id: prevDecision.id },
        data: {
          decisionType:    'unmatched',
          yourItemIds:     prevDecision.yourItemIds,
          adjusterItemIds: [],
          finalScore:      0,
          decidedBy:       'group_match',
        },
      });
      relinquishedAdj++;
      possibleDecisionByAdj.delete(adjId);  // prevent re-use
    }
  }

  logger.info('[n3/group-matching] complete', {
    comparisonId, groupedCount, relinquishedAdj,
  });

  return { groupedCount, relinquishedAdj };
}
