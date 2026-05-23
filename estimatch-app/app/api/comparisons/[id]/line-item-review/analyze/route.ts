// ─────────────────────────────────────────────────────────────────────────────
// POST /api/comparisons/[id]/line-item-review/analyze
//
// N3 pipeline only. Calls Claude Sonnet to analyze per-zone extraction counts
// against the user's description of what looks wrong. Returns an analysis and
// recommendation WITHOUT triggering any pipeline action.
//
// The user can then either confirm (existing confirm route) or re-extract
// (existing reextract route) based on the AI's analysis.
//
// Auth: Clerk + DB ownership check.
// Status guard: comparison must be AWAITING_LINE_ITEM_REVIEW.
// ─────────────────────────────────────────────────────────────────────────────

import { auth } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';

export const maxDuration = 30;

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ANALYZE_MODEL = 'claude-sonnet-4-5';
const ANALYZE_MAX_TOKENS = 1000;

const SYSTEM_PROMPT = `You are an extraction analyst for an insurance estimate comparison tool. The user is reviewing per-zone item counts extracted from two PDF estimates and believes something looks wrong.

You will receive:
- EXTRACTION_COUNTS: for each zone, the extracted item count and the approximate expected count from the PDF header (approxItems). A count significantly different from approxItems (>3 items off, or approxItems is 0 but many items are expected) may indicate an extraction error.
- USER_DESCRIPTION: what the user says looks wrong

Analyze the issue and return JSON:
{
  "analysis": "1–2 sentence summary of the likely issue",
  "zones_to_check": [{"source": "yours" | "adjuster", "zone": "zone name", "extracted": N, "expected": N, "issue": "brief reason"}],
  "recommendation": "reextract" | "confirm" | "review_manually",
  "agentMessage": null | "clarifying question or note"
}

Rules:
- Only flag zones where counts differ significantly (>3 items) from expected OR where the user specifically mentions them.
- Use only zone names from the provided data — never invent names.
- recommendation is "reextract" if re-running extraction would likely fix it, "confirm" if counts look acceptable, "review_manually" if the user should inspect the PDF directly.
- If the user's description doesn't match any data issue, ask a clarifying question via agentMessage.`;

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

type AnalysisResponse = {
  analysis: string;
  zones_to_check: Array<{ source: string; zone: string; extracted: number; expected: number; issue: string }>;
  recommendation: 'reextract' | 'confirm' | 'review_manually';
  agentMessage: string | null;
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
    select: { userId: true, status: true },
  });
  if (!comparison) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (comparison.userId !== dbUser.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (comparison.status !== 'AWAITING_LINE_ITEM_REVIEW') {
    return NextResponse.json({ error: 'Comparison is not awaiting line item review' }, { status: 409 });
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

  // ── Read extraction counts ────────────────────────────────────────────────
  const zones = await prisma.n3Zone.findMany({
    where: { comparisonId },
    select: { id: true, name: true, source: true, approxItems: true },
    orderBy: [{ source: 'asc' }, { startPage: 'asc' }],
  });

  const items = await prisma.n3LineItem.groupBy({
    by: ['zoneId'],
    where: { comparisonId },
    _count: { id: true },
  });
  const countByZone = new Map<string, number>(items.map(r => [r.zoneId ?? '', r._count.id]));

  const extractionCounts = zones.map(z => ({
    source: z.source,
    zone: z.name,
    extracted: countByZone.get(z.id) ?? 0,
    expected: z.approxItems ?? 0,
  }));

  // ── Call Claude ───────────────────────────────────────────────────────────
  const userMessage = `EXTRACTION_COUNTS:
${JSON.stringify(extractionCounts, null, 2)}

USER_DESCRIPTION:
${userDescription}

Analyze the extraction results and return JSON.`;

  const apiKey = getApiKey();
  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: ANALYZE_MODEL,
      max_tokens: ANALYZE_MAX_TOKENS,
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

  const respBody = await response.json() as { content?: Array<{ type: string; text?: string }> };
  const textBlock = respBody.content?.find(b => b.type === 'text');
  if (!textBlock?.text) {
    return NextResponse.json({ error: 'Agent returned no text response' }, { status: 500 });
  }

  let result: AnalysisResponse;
  try {
    result = JSON.parse(extractJsonFromText(textBlock.text)) as AnalysisResponse;
  } catch {
    return NextResponse.json({ error: 'Agent returned malformed JSON' }, { status: 500 });
  }

  return NextResponse.json(result);
}
