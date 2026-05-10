// ─────────────────────────────────────────────────────────────────────────────
// N3 Pipeline — Phase 17: llm-adjudication
//
// For every `possible` decision remaining after Phase 16 (finalScore 0.30–0.55),
// asks Claude Sonnet to rule accept or reject in a single batched call.
//
// Algorithm:
//   1. Load all `possible` decisions.
//   2. Load source (yours) and target (adj) line items for each pair.
//   3. Build a single Sonnet prompt listing all pairs with their key features.
//   4. Parse structured JSON response:
//        { adjudications: [{index, decision, confidence, reasoning}] }
//   5. Apply decisions:
//        match    → decisionType one_to_one, decidedBy llm_adjudication
//        no_match → decisionType unmatched,  decidedBy llm_adjudication
//        (llmReasoning written to both outcomes for audit trail)
//   6. Write one N3LlmCall telemetry row.
//
// If there are no `possible` decisions this phase is a no-op.
//
// Architecture refs: N3.md §Phase 17, §A.3 (LLM as fallback, not primary).
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import prisma from '@/lib/prisma';
import { parseAndValidate, withRetry, isTruncated, AIResponseError } from '@/lib/n2/utils/ai-response';
import type { StepLogger } from '@/lib/n3/passes/detect-zones';
import { SCORE_THRESHOLDS } from '@/lib/n3/constants';

// ── Constants ─────────────────────────────────────────────────────────────────

const SONNET_MODEL      = 'claude-sonnet-4-5';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS        = 2000;
// Claude Sonnet 4-5 pricing (per million tokens, USD)
const COST_PER_M_INPUT  = 3.0;
const COST_PER_M_OUTPUT = 15.0;

// ── Return type ───────────────────────────────────────────────────────────────

export type LlmAdjudicationN3Result = {
  adjudicatedCount:    number;
  acceptedCount:       number;
  rejectedCount:       number;
  postLlmRescueCount:  number;  // pairs rescued after LLM rejection by mutual-best pass
  skipped:             boolean; // true when no `possible` decisions exist
};

// ── Zod schema for AI response ────────────────────────────────────────────────

const AdjudicationItemSchema = z.object({
  index:      z.number().int().min(0),
  decision:   z.enum(['match', 'no_match']),
  confidence: z.number().min(0).max(1),
  reasoning:  z.string().max(400),
});

const AdjudicationResponseSchema = z.object({
  adjudications: z.array(AdjudicationItemSchema),
});

// ── Prompt builder ────────────────────────────────────────────────────────────

type PairContext = {
  index:         number;
  decisionId:    string;
  yoursDesc:     string;
  yoursTrade:    string | null;
  yoursAction:   string | null;
  yoursQty:      string;
  yoursUnit:     string;
  yoursTotal:    string;
  adjDesc:       string;
  adjTrade:      string | null;
  adjAction:     string | null;
  adjQty:        string;
  adjUnit:       string;
  adjTotal:      string;
  finalScore:    number;
};

function buildSystemPrompt(): string {
  return `You are a specialist in insurance property-damage estimates. \
Your task is to decide whether each pair of line items — one from a contractor's estimate \
("yours") and one from an insurance adjuster's estimate — represents the same scope of work.

Rules:
- Identical or near-identical descriptions → match
- Same trade/action with proportional quantities → match
- Fundamentally different work scopes → no_match
- When genuinely ambiguous, prefer match over no_match (false positives are less harmful than missed matches)

Respond ONLY with valid JSON matching this schema exactly:
{"adjudications":[{"index":0,"decision":"match","confidence":0.85,"reasoning":"brief explanation"},...]}`;
}

function buildUserPrompt(pairs: PairContext[]): string {
  const lines = pairs.map(p =>
    `[${p.index}]
  YOUR  | "${p.yoursDesc}" | trade: ${p.yoursTrade ?? '—'} | action: ${p.yoursAction ?? '—'} | qty: ${p.yoursQty} ${p.yoursUnit} | total: $${p.yoursTotal}
  ADJ   | "${p.adjDesc}" | trade: ${p.adjTrade ?? '—'} | action: ${p.adjAction ?? '—'} | qty: ${p.adjQty} ${p.adjUnit} | total: $${p.adjTotal}
  score: ${p.finalScore.toFixed(3)}`
  );
  return `Evaluate the following ${pairs.length} candidate pair(s):\n\n${lines.join('\n\n')}`;
}

// ── API key helper ────────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key?.trim()) throw new Error('[n3/llm-adjudication] ANTHROPIC_API_KEY is not configured.');
  return key.trim();
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function llmAdjudicationN3(
  comparisonId: string,
  logger: StepLogger,
): Promise<LlmAdjudicationN3Result> {

  // ── 1. Load possible decisions ─────────────────────────────────────────────
  const possibleDecisions = await prisma.n3MatchDecision.findMany({
    where: { comparisonId, decisionType: 'possible' },
    select: { id: true, yourItemIds: true, adjusterItemIds: true, finalScore: true },
  });

  if (possibleDecisions.length === 0) {
    logger.info('[n3/llm-adjudication] no possible decisions — skipping', { comparisonId });
    return { adjudicatedCount: 0, acceptedCount: 0, rejectedCount: 0, postLlmRescueCount: 0, skipped: true };
  }

  // ── 2. Load line items ─────────────────────────────────────────────────────
  const allItemIds = [
    ...possibleDecisions.flatMap(d => d.yourItemIds),
    ...possibleDecisions.flatMap(d => d.adjusterItemIds),
  ];
  const items = await prisma.n3LineItem.findMany({
    where: { id: { in: allItemIds } },
    select: {
      id: true, rawDescription: true, trade: true, action: true,
      normalizedQuantity: true, normalizedUnit: true, totalAmount: true,
    },
  });
  const itemMap = new Map(items.map(li => [li.id, li]));

  // ── 3. Build pair contexts ─────────────────────────────────────────────────
  const pairs: PairContext[] = [];
  for (const [i, d] of possibleDecisions.entries()) {
    const yours = itemMap.get(d.yourItemIds[0]);
    const adj   = itemMap.get(d.adjusterItemIds[0]);
    if (!yours || !adj) continue;
    pairs.push({
      index:      i,
      decisionId: d.id,
      yoursDesc:  yours.rawDescription,
      yoursTrade: yours.trade,
      yoursAction: yours.action,
      yoursQty:   String(yours.normalizedQuantity ?? '?'),
      yoursUnit:  yours.normalizedUnit ?? '?',
      yoursTotal: yours.totalAmount != null ? Number(yours.totalAmount).toFixed(2) : '?',
      adjDesc:    adj.rawDescription,
      adjTrade:   adj.trade,
      adjAction:  adj.action,
      adjQty:     String(adj.normalizedQuantity ?? '?'),
      adjUnit:    adj.normalizedUnit ?? '?',
      adjTotal:   adj.totalAmount != null ? Number(adj.totalAmount).toFixed(2) : '?',
      finalScore: Number(d.finalScore),
    });
  }

  if (pairs.length === 0) {
    logger.info('[n3/llm-adjudication] no valid pairs to adjudicate', { comparisonId });
    return { adjudicatedCount: 0, acceptedCount: 0, rejectedCount: 0, postLlmRescueCount: 0, skipped: true };
  }

  logger.info('[n3/llm-adjudication] calling Sonnet', { comparisonId, pairs: pairs.length });

  // ── 4. Call Sonnet ─────────────────────────────────────────────────────────
  const context  = `${comparisonId}/llm-adjudication`;
  const startMs  = Date.now();
  let promptTokens = 0, completionTokens = 0, callSuccess = true, callError: string | null = null;

  const parsed = await withRetry(
    async () => {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'content-type':     'application/json',
          'x-api-key':        getApiKey(),
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model:       SONNET_MODEL,
          max_tokens:  MAX_TOKENS,
          temperature: 0,
          system:      buildSystemPrompt(),
          messages:    [{ role: 'user', content: buildUserPrompt(pairs) }],
        }),
      });

      if (!response.ok) {
        throw new AIResponseError(
          `[n3/llm-adjudication] Anthropic ${response.status}: ${response.statusText}`,
          response.status >= 500 || response.status === 429,
          context,
        );
      }

      const body = (await response.json()) as {
        content?: Array<{ text?: string }>;
        stop_reason?: string | null;
        usage?: { input_tokens: number; output_tokens: number };
      };

      promptTokens     = body.usage?.input_tokens  ?? 0;
      completionTokens = body.usage?.output_tokens ?? 0;

      const text = body.content?.[0]?.text ?? '';
      if (isTruncated(body.stop_reason ?? null, text)) {
        throw new AIResponseError(
          '[n3/llm-adjudication] Response truncated — increase max_tokens',
          true,
          context,
        );
      }

      return parseAndValidate(text, AdjudicationResponseSchema, context);
    },
    3,
    context,
  ).catch(err => {
    callSuccess = false;
    callError   = err instanceof Error ? err.message.slice(0, 400) : String(err);
    throw err;
  });

  const durationMs = Date.now() - startMs;

  // ── 5. Write N3LlmCall telemetry ───────────────────────────────────────────
  const totalTokens = promptTokens + completionTokens;
  const estimatedCostUsd =
    (promptTokens / 1_000_000) * COST_PER_M_INPUT +
    (completionTokens / 1_000_000) * COST_PER_M_OUTPUT;

  await prisma.n3LlmCall.create({
    data: {
      comparisonId,
      phase:            'adjudication',
      model:            SONNET_MODEL,
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedCostUsd,
      durationMs,
      success:          callSuccess,
      errorMessage:     callError,
    },
  });

  // ── 6. Apply decisions ─────────────────────────────────────────────────────
  // Build index → decision row lookup
  const adjMap = new Map(parsed.adjudications.map(a => [a.index, a]));

  let acceptedCount = 0, rejectedCount = 0;

  for (const pair of pairs) {
    const ruling = adjMap.get(pair.index);
    if (!ruling) continue;  // Sonnet skipped this index — leave as-is

    if (ruling.decision === 'match') {
      await prisma.n3MatchDecision.update({
        where: { id: pair.decisionId },
        data: {
          decisionType: 'one_to_one',
          decidedBy:    'llm_adjudication',
          llmReasoning: ruling.reasoning,
        },
      });
      acceptedCount++;
    } else {
      await prisma.n3MatchDecision.update({
        where: { id: pair.decisionId },
        data: {
          decisionType:    'unmatched',
          adjusterItemIds: [],
          finalScore:      0,
          topEdgeId:       null,
          decidedBy:       'llm_adjudication',
          llmReasoning:    ruling.reasoning,
        },
      });
      rejectedCount++;
    }
  }

  // ── 7. Post-LLM mutual-best rescue pass ───────────────────────────────────
  // Items whose `possible` decisions were rejected by LLM are now unmatched.
  // Some of those items may still have a mutual-best HIGH_CONFIDENCE edge to
  // another unmatched item — the LLM only evaluated them against wrong partners.
  // Rescue such pairs as one_to_one decisions without re-calling LLM.
  let postLlmRescueCount = 0;
  {
    // Load all contractor-unmatched decisions
    const unmatchedContrDecisions = await prisma.n3MatchDecision.findMany({
      where: { comparisonId, decisionType: 'unmatched' },
      select: { id: true, yourItemIds: true, adjusterItemIds: true },
    });
    const unmatchedYoursList = unmatchedContrDecisions.filter(
      d => d.yourItemIds.length > 0 && d.adjusterItemIds.length === 0,
    );
    const unmatchedYoursIds = unmatchedYoursList.map(d => d.yourItemIds[0]);

    // Find all adjuster item IDs currently claimed (non-empty adjusterItemIds)
    const allDecisions = await prisma.n3MatchDecision.findMany({
      where: { comparisonId },
      select: { adjusterItemIds: true },
    });
    const claimedAdjIds = new Set<string>();
    for (const d of allDecisions) {
      for (const id of d.adjusterItemIds) claimedAdjIds.add(id);
    }

    // All adjuster items not in any non-empty decision = unmatched adj
    const adjLineItems = await prisma.n3LineItem.findMany({
      where: { comparisonId, source: 'adjuster' },
      select: { id: true },
    });
    const unmatchedAdjIds = new Set(adjLineItems.map(a => a.id).filter(id => !claimedAdjIds.has(id)));

    if (unmatchedYoursIds.length > 0 && unmatchedAdjIds.size > 0) {
      // Load all non-rejected edges from unmatched contractor items
      const rescueEdges = await prisma.n3CandidateEdge.findMany({
        where: { comparisonId, isRejected: false, sourceItemId: { in: unmatchedYoursIds } },
        select: { id: true, sourceItemId: true, targetItemId: true, finalScore: true },
      });

      // Build best-edge maps (only considering edges to unmatched adj items)
      const bestYoursToAdj = new Map<string, { adjId: string; score: number; edgeId: string }>();
      for (const e of rescueEdges) {
        if (!unmatchedAdjIds.has(e.targetItemId)) continue;
        const score = Number(e.finalScore);
        const cur = bestYoursToAdj.get(e.sourceItemId);
        if (!cur || score > cur.score) bestYoursToAdj.set(e.sourceItemId, { adjId: e.targetItemId, score, edgeId: e.id });
      }
      const bestAdjToYours = new Map<string, { yoursId: string; score: number }>();
      for (const e of rescueEdges) {
        if (!unmatchedAdjIds.has(e.targetItemId)) continue;
        const score = Number(e.finalScore);
        const cur = bestAdjToYours.get(e.targetItemId);
        if (!cur || score > cur.score) bestAdjToYours.set(e.targetItemId, { yoursId: e.sourceItemId, score });
      }

      const rescuedAdjIds = new Set<string>();
      for (const d of unmatchedYoursList) {
        const yoursId = d.yourItemIds[0];
        const yBest = bestYoursToAdj.get(yoursId);
        if (!yBest || yBest.score < SCORE_THRESHOLDS.POSSIBLE_MATCH) continue;
        if (rescuedAdjIds.has(yBest.adjId)) continue;
        const aBest = bestAdjToYours.get(yBest.adjId);
        if (!aBest || aBest.yoursId !== yoursId) continue;  // not mutual-best

        // Mutual-best with sufficient confidence — rescue as one_to_one
        await prisma.n3MatchDecision.update({
          where: { id: d.id },
          data: {
            decisionType:    'one_to_one',
            adjusterItemIds: [yBest.adjId],
            finalScore:      yBest.score,
            topEdgeId:       yBest.edgeId,
            decidedBy:       'post_llm_rescue',
          },
        });
        rescuedAdjIds.add(yBest.adjId);
        postLlmRescueCount++;
      }
    }
  }

  if (postLlmRescueCount > 0) {
    logger.info('[n3/llm-adjudication] post-LLM rescue', { comparisonId, postLlmRescueCount });
  }

  logger.info('[n3/llm-adjudication] complete', {
    comparisonId,
    adjudicatedCount: pairs.length,
    acceptedCount,
    rejectedCount,
    postLlmRescueCount,
    promptTokens,
    completionTokens,
    estimatedCostUsd: estimatedCostUsd.toFixed(4),
    durationMs,
  });

  return {
    adjudicatedCount: pairs.length,
    acceptedCount,
    rejectedCount,
    postLlmRescueCount,
    skipped: false,
  };
}
