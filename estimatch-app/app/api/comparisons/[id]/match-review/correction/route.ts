// ─────────────────────────────────────────────────────────────────────────────
// POST /api/comparisons/[id]/match-review/correction
//
// Runs Claude Sonnet against the user's freeform description of a zone
// correspondence error. Applies corrected pairings to n3_zone_correspondences.
//
// Supports N3 (Xactimate PDF) and N4 (Symbility, CSV) pipelines — both store
// zone data in the shared n3_zones / n3_zone_correspondences tables.
//
// Auth: Clerk + DB ownership check.
// Status guard: comparison must be AWAITING_MATCH_REVIEW.
// ─────────────────────────────────────────────────────────────────────────────

import { auth } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';

export const maxDuration = 60;

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const CORRECTION_MODEL = 'claude-sonnet-4-5';
const CORRECTION_MAX_TOKENS = 15000;

const SYSTEM_PROMPT = `You are a zone correspondence correction agent for an insurance estimate comparison tool. Your job is to correct errors in AI-proposed zone pairings between a contractor estimate (PDF A / e1) and an adjuster estimate (PDF B / e2).

You will receive:
- CURRENT_PAIRS: AI-proposed zone pairings. Each pair has e1Zones (one or more contractor zones) and e2Zones (one or more adjuster zones).
- UNMATCHED_E1: contractor zones not yet paired with any adjuster zone
- UNMATCHED_E2: adjuster zones not yet paired with any contractor zone
- USER_DESCRIPTION: the user's natural language description of what is wrong

## Output format

Always return valid JSON matching this exact structure:
{
  "pairs": [{"e1Zones": ["zone name"], "e2Zones": ["zone name"]}, ...],
  "unmatchedE1": ["zone name", ...],
  "unmatchedE2": ["zone name", ...],
  "agentMessage": null | "string with clarifying question",
  "confirmationMessage": "string — always a brief one-sentence summary of the action taken or question asked"
}

## Universal rules

1. Use ONLY zone names from the input lists (CURRENT_PAIRS + UNMATCHED_E1 + UNMATCHED_E2). Never invent zone names.
2. Every zone name must appear exactly once across pairs + unmatched lists.
3. If agentMessage is non-null, return the input lists UNCHANGED.
4. Return COMPLETE lists — not diffs or partial lists.
5. If the user's request is ambiguous, ask a single clarifying question in agentMessage.
6. Always populate confirmationMessage with a plain-English one-sentence summary of what you did or what you need (e.g. "Paired Master Bedroom with Primary Suite and moved Exterior to unmatched." or "Could you clarify which zones should be paired?"). Never leave it empty.

## Playbooks

- **Pair two zones**: User says zone X (yours) should be matched with zone Y (adjuster). Move both into a pair entry. Remove from unmatched lists if applicable.
- **Break a pair**: User says a pairing is wrong. Split back to unmatchedE1 and unmatchedE2.
- **Mark as unmatched**: User says a zone has no counterpart on the other side. Leave or move it to the appropriate unmatched list.
- **Merged zone (one-to-many)**: One estimate treats an area as one zone, the other splits it. e.g. e1Zones: ["Master Suite"], e2Zones: ["Primary Bedroom", "Primary Bath"]. Any number of zones can appear in either side of a pair.
- **Swap**: User says zone A was wrongly paired with zone B and should be paired with zone C. Reassign accordingly.
- **Multiple issues**: Fix the first issue only. Note any remaining issues in agentMessage.`;

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key?.trim()) throw new Error('ANTHROPIC_API_KEY not configured');
  return key.trim();
}

function extractJsonFromText(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) return text.slice(firstBrace, lastBrace + 1);
  return text.trim();
}

type CorrectionResponse = {
  pairs: Array<{ e1Zones: string[]; e2Zones: string[] }>;
  unmatchedE1: string[];
  unmatchedE2: string[];
  agentMessage: string | null;
  confirmationMessage: string;
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: comparisonId } = await params;

  const dbUser = await prisma.user.findUnique({ where: { clerkId: userId }, select: { id: true } });
  if (!dbUser) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const comparison = await prisma.comparison.findUnique({
    where: { id: comparisonId },
    select: { userId: true, status: true, pipelineVersion: true },
  });
  if (!comparison) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (comparison.userId !== dbUser.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (comparison.status !== 'AWAITING_MATCH_REVIEW') {
    return NextResponse.json({ error: 'Comparison is not awaiting match review' }, { status: 409 });
  }

  let body: { description?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  if (!body.description || typeof body.description !== 'string' || !body.description.trim()) {
    return NextResponse.json({ error: 'description is required' }, { status: 400 });
  }
  const userDescription = body.description.trim();

  // ── Read current correspondences ─────────────────────────────────────────
  const corrs = await prisma.n3ZoneCorrespondence.findMany({
    where: { comparisonId },
    include: {
      yourZones: { select: { name: true } },
      adjusterZones: { select: { name: true } },
    },
    orderBy: { confidence: 'desc' },
  });

  const pairedYours = new Set<string>();
  const pairedAdj = new Set<string>();
  const currentPairs = corrs.map(c => {
    const e1 = c.yourZones.map(z => z.name);
    const e2 = c.adjusterZones.map(z => z.name);
    e1.forEach(n => pairedYours.add(n));
    e2.forEach(n => pairedAdj.add(n));
    return { e1Zones: e1, e2Zones: e2 };
  });

  const allYours = await prisma.n3Zone.findMany({ where: { comparisonId, source: 'yours' }, select: { name: true } });
  const allAdj = await prisma.n3Zone.findMany({ where: { comparisonId, source: 'adjuster' }, select: { name: true } });
  const unmatchedE1 = allYours.map(z => z.name).filter(n => !pairedYours.has(n));
  const unmatchedE2 = allAdj.map(z => z.name).filter(n => !pairedAdj.has(n));

  // ── Build user message ────────────────────────────────────────────────────
  const userMessage = `CURRENT_PAIRS:
${JSON.stringify(currentPairs, null, 2)}

UNMATCHED_E1 (contractor zones not yet paired):
${JSON.stringify(unmatchedE1)}

UNMATCHED_E2 (adjuster zones not yet paired):
${JSON.stringify(unmatchedE2)}

USER_DESCRIPTION:
${userDescription}

Apply the matching playbook and return corrected JSON.`;

  // ── Call Claude ───────────────────────────────────────────────────────────
  const apiKey = getApiKey();
  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: CORRECTION_MODEL,
      max_tokens: CORRECTION_MAX_TOKENS,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    return NextResponse.json(
      { error: `Anthropic API error: ${response.status} ${response.statusText}` },
      { status: 500 },
    );
  }

  const body2 = await response.json() as { content?: Array<{ type: string; text?: string }> };
  const textBlock = body2.content?.find(b => b.type === 'text');
  if (!textBlock?.text) {
    return NextResponse.json({ error: 'Agent returned no text response' }, { status: 500 });
  }

  let result: CorrectionResponse;
  try {
    result = JSON.parse(extractJsonFromText(textBlock.text)) as CorrectionResponse;
  } catch {
    return NextResponse.json({ error: 'Agent returned malformed JSON' }, { status: 500 });
  }

  // ── If agent asked a question, return without writing ─────────────────────
  if (result.agentMessage) {
    return NextResponse.json({
      pairs: currentPairs,
      unmatchedE1,
      unmatchedE2,
      agentMessage: result.agentMessage,
      confirmationMessage: result.confirmationMessage ?? 'Correction applied.',
    });
  }

  // ── Apply corrections to n3_zone_correspondences ──────────────────────────
  const yoursNameToId = new Map(allYours.map(z => [z.name, '']));
  const adjNameToId = new Map(allAdj.map(z => [z.name, '']));

  const yoursRows = await prisma.n3Zone.findMany({
    where: { comparisonId, source: 'yours' },
    select: { id: true, name: true },
  });
  const adjRows = await prisma.n3Zone.findMany({
    where: { comparisonId, source: 'adjuster' },
    select: { id: true, name: true },
  });
  yoursRows.forEach(z => yoursNameToId.set(z.name, z.id));
  adjRows.forEach(z => adjNameToId.set(z.name, z.id));

  await prisma.$transaction(async tx => {
    await tx.n3ZoneCorrespondence.deleteMany({ where: { comparisonId } });

    for (const pair of result.pairs) {
      const yourIds = pair.e1Zones.map(n => yoursNameToId.get(n)).filter((id): id is string => !!id);
      const adjIds = pair.e2Zones.map(n => adjNameToId.get(n)).filter((id): id is string => !!id);
      if (yourIds.length === 0 || adjIds.length === 0) continue;

      const type =
        yourIds.length > 1 ? 'many_to_one' :
        adjIds.length > 1 ? 'one_to_many' :
        'one_to_one';

      await tx.n3ZoneCorrespondence.create({
        data: {
          comparisonId,
          correspondenceType: type,
          verificationStatus: 'user_corrected',
          confidence: 1.0,
          yourZones: { connect: yourIds.map(id => ({ id })) },
          adjusterZones: { connect: adjIds.map(id => ({ id })) },
        },
      });
    }
  });

  return NextResponse.json({
    pairs: result.pairs,
    unmatchedE1: result.unmatchedE1,
    unmatchedE2: result.unmatchedE2,
    agentMessage: null,
    confirmationMessage: result.confirmationMessage ?? 'Correction applied.',
  });
}
