// ─────────────────────────────────────────────────────────────────────────────
// POST /api/comparisons/[id]/zone-correction
//
// Runs the zone correction agent (Sonnet 4.6 + examine_pdf_pages tool-use)
// against the user's freeform description of a zone detection error.
// Writes corrected zones to n2:zones_corrected state (upsert — safe for
// multiple consecutive corrections).
//
// Auth: Clerk + DB ownership check.
// Status guard: comparison must be AWAITING_ZONE_REVIEW.
// ─────────────────────────────────────────────────────────────────────────────

import { auth } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { readZonesDetected, readZonesCorrected, writeN2Stage, N2_STAGE_ZONES_CORRECTED } from '@/lib/n2/utils/n2-state';
import {
  ZONE_CORRECTION_SYSTEM_PROMPT,
  buildZoneCorrectionUserMessage,
  type ZoneCorrectionResponse,
} from '@/lib/n2/prompts/zone-correction-agent';
import {
  EXAMINE_PDF_PAGES_TOOL,
  handleExaminePdfPages,
  type ExaminePdfPagesInput,
} from '@/lib/n2/utils/zone-correction-tool';
import type { N2DetectedZone } from '@/lib/n2/schemas/types';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const CORRECTION_MODEL = 'claude-sonnet-4-6';
const CORRECTION_MAX_TOKENS = 2000;
const MAX_TOOL_ROUNDS = 3;

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key?.trim()) throw new Error('ANTHROPIC_API_KEY not configured');
  return key.trim();
}

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | Array<{ type: string; [key: string]: unknown }>;
};

type AnthropicResponseBody = {
  id: string;
  stop_reason: string | null;
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
  >;
};

async function callCorrectionAgent(
  messages: AnthropicMessage[],
  apiKey: string,
): Promise<AnthropicResponseBody> {
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
      system: ZONE_CORRECTION_SYSTEM_PROMPT,
      tools: [EXAMINE_PDF_PAGES_TOOL],
      messages,
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<AnthropicResponseBody>;
}

function extractJsonFromText(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) return text.slice(firstBrace, lastBrace + 1);
  return text.trim();
}

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
    select: {
      userId: true,
      status: true,
      yourEstimateStoragePath: true,
      adjusterEstimateStoragePath: true,
    },
  });
  if (!comparison) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (comparison.userId !== dbUser.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (comparison.status !== 'AWAITING_ZONE_REVIEW') {
    return NextResponse.json(
      { error: 'Comparison is not awaiting zone review' },
      { status: 409 },
    );
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

  const corrected = await readZonesCorrected(comparisonId);
  const detected = await readZonesDetected(comparisonId);

  const sourcePayload = corrected ?? detected;
  if (!sourcePayload) {
    return NextResponse.json({ error: 'Zone detection state not found' }, { status: 500 });
  }

  const slim = (z: N2DetectedZone) => ({
    name: z.name,
    startPage: z.startPage,
    endPage: z.endPage,
    approxItems: z.approxItems,
  });

  const currentE1 = sourcePayload.e1Zones.map(slim);
  const currentE2 = sourcePayload.e2Zones.map(slim);

  const apiKey = getApiKey();
  const userMessage = buildZoneCorrectionUserMessage({
    e1Zones: currentE1,
    e2Zones: currentE2,
    userDescription,
  });

  const messages: AnthropicMessage[] = [{ role: 'user', content: userMessage }];
  let correctionResult: ZoneCorrectionResponse | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const agentResponse = await callCorrectionAgent(messages, apiKey);

    if (agentResponse.stop_reason === 'end_turn') {
      const textBlock = agentResponse.content.find(b => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        return NextResponse.json({ error: 'Agent returned no text response' }, { status: 500 });
      }
      try {
        correctionResult = JSON.parse(extractJsonFromText(textBlock.text)) as ZoneCorrectionResponse;
      } catch {
        return NextResponse.json({ error: 'Agent returned malformed JSON' }, { status: 500 });
      }
      break;
    }

    if (agentResponse.stop_reason === 'tool_use') {
      const toolUseBlocks = agentResponse.content.filter(b => b.type === 'tool_use');
      messages.push({ role: 'assistant', content: agentResponse.content });

      const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];

      for (const block of toolUseBlocks) {
        if (block.type !== 'tool_use') continue;
        if (block.name === 'examine_pdf_pages') {
          const toolInput = block.input as ExaminePdfPagesInput;
          const result = await handleExaminePdfPages(
            toolInput,
            comparison.yourEstimateStoragePath,
            comparison.adjusterEstimateStoragePath,
            sourcePayload.e1Zones,
            sourcePayload.e2Zones,
            apiKey,
          );
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
        }
      }

      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    break;
  }

  if (!correctionResult) {
    return NextResponse.json({ error: 'Agent did not produce a correction' }, { status: 500 });
  }

  if (!correctionResult.agentMessage) {
    const existingMatchHints = corrected?.matchHints ?? [];
    const existingConfirmedUnique = corrected?.confirmedUniqueZones ?? [];

    const mergedMatchHints = [
      ...existingMatchHints,
      ...(correctionResult.matchHints ?? []),
    ];
    const mergedConfirmedUnique = [
      ...existingConfirmedUnique,
      ...(correctionResult.confirmedUniqueZones ?? []),
    ];

    const newPayload = {
      e1Zones: correctionResult.e1Zones.map(z => ({
        ...z,
        chunkOffset: 0,
        endPageChunkOffset: 0,
      })),
      e2Zones: correctionResult.e2Zones.map(z => ({
        ...z,
        chunkOffset: 0,
        endPageChunkOffset: 0,
      })),
      e1Format: sourcePayload.e1Format,
      e2Format: sourcePayload.e2Format,
      routingDecision: sourcePayload.routingDecision,
      matchHints: mergedMatchHints,
      confirmedUniqueZones: mergedConfirmedUnique,
    };

    await writeN2Stage(comparisonId, N2_STAGE_ZONES_CORRECTED, newPayload);
  }

  return NextResponse.json({
    e1Zones: correctionResult.e1Zones,
    e2Zones: correctionResult.e2Zones,
    matchHints: (corrected?.matchHints ?? []).concat(correctionResult.matchHints ?? []),
    confirmedUniqueZones: (corrected?.confirmedUniqueZones ?? []).concat(
      correctionResult.confirmedUniqueZones ?? [],
    ),
    agentMessage: correctionResult.agentMessage ?? null,
  });
}
