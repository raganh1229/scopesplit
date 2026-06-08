// Vercel serverless runtime cap. 300s = Vercel Pro ceiling.
// Each examine_pdf_pages round involves a Supabase download + Anthropic vision
// call; PDFs are pre-loaded once before the loop (see below) to avoid repeated
// downloads, but the vision calls themselves can take 20-30s each.
export const maxDuration = 300;

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
import { supabaseAdmin } from '@/lib/supabase';
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
const CORRECTION_MAX_TOKENS = 15000;
const MAX_TOOL_ROUNDS = 6;

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
  options?: { noTools?: boolean },
): Promise<AnthropicResponseBody> {
  const payload: Record<string, unknown> = {
    model: CORRECTION_MODEL,
    max_tokens: CORRECTION_MAX_TOKENS,
    temperature: 0,
    system: ZONE_CORRECTION_SYSTEM_PROMPT,
    messages,
  };
  if (!options?.noTools) {
    payload.tools = [EXAMINE_PDF_PAGES_TOOL];
  }
  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(payload),
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
      pipelineVersion: true,
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

  // ── N3/N4 path: read/write n3_zones table directly ──────────────────────────
  if (comparison.pipelineVersion === 'n3' || comparison.pipelineVersion === 'n4') {
    const n3Zones = await prisma.n3Zone.findMany({
      where: { comparisonId },
      select: { name: true, source: true, startPage: true, endPage: true, approxItems: true },
      orderBy: [{ source: 'asc' }, { startPage: 'asc' }],
    });

    const toN2 = (z: { name: string; startPage: number; endPage: number; approxItems: number }): N2DetectedZone => ({
      name: z.name,
      startPage: z.startPage,
      endPage: z.endPage,
      approxItems: z.approxItems,
      chunkOffset: 0,
      endPageChunkOffset: 0,
    });

    const n3E1 = n3Zones.filter(z => z.source === 'yours').map(toN2);
    const n3E2 = n3Zones.filter(z => z.source === 'adjuster').map(toN2);
    const slimN3 = (z: N2DetectedZone) => ({ name: z.name, startPage: z.startPage, endPage: z.endPage, approxItems: z.approxItems });

    const n3ApiKey = getApiKey();

    // Pre-download both PDFs once so repeated examine_pdf_pages tool calls
    // within the same agent session reuse the buffer instead of re-fetching.
    const [e1Download, e2Download] = await Promise.all([
      supabaseAdmin.storage.from('estimates').download(comparison.yourEstimateStoragePath),
      supabaseAdmin.storage.from('estimates').download(comparison.adjusterEstimateStoragePath),
    ]);
    const n3PdfBuffers: { e1?: Uint8Array; e2?: Uint8Array } = {};
    if (e1Download.data) n3PdfBuffers.e1 = new Uint8Array(await e1Download.data.arrayBuffer());
    if (e2Download.data) n3PdfBuffers.e2 = new Uint8Array(await e2Download.data.arrayBuffer());

    const n3UserMsg = buildZoneCorrectionUserMessage({ e1Zones: n3E1.map(slimN3), e2Zones: n3E2.map(slimN3), userDescription });
    const n3Messages: AnthropicMessage[] = [{ role: 'user', content: n3UserMsg }];
    let n3Result: ZoneCorrectionResponse | null = null;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const agentResponse = await callCorrectionAgent(n3Messages, n3ApiKey);

      if (agentResponse.stop_reason === 'end_turn') {
        const textBlock = agentResponse.content.find(b => b.type === 'text');
        if (!textBlock || textBlock.type !== 'text') {
          return NextResponse.json({ error: 'Agent returned no text response' }, { status: 500 });
        }
        try {
          n3Result = JSON.parse(extractJsonFromText(textBlock.text)) as ZoneCorrectionResponse;
        } catch {
          return NextResponse.json({ error: 'Agent returned malformed JSON' }, { status: 500 });
        }
        break;
      }

      if (agentResponse.stop_reason === 'tool_use') {
        const toolUseBlocks = agentResponse.content.filter(b => b.type === 'tool_use');
        n3Messages.push({ role: 'assistant', content: agentResponse.content });
        const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];
        for (const block of toolUseBlocks) {
          if (block.type !== 'tool_use') continue;
          if (block.name === 'examine_pdf_pages') {
            const toolInput = block.input as ExaminePdfPagesInput;
            const result = await handleExaminePdfPages(
              toolInput,
              comparison.yourEstimateStoragePath,
              comparison.adjusterEstimateStoragePath,
              n3E1,
              n3E2,
              n3ApiKey,
              n3PdfBuffers,
            );
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
          }
        }
        n3Messages.push({ role: 'user', content: toolResults });
        continue;
      }
      break;
    }

    if (!n3Result) {
      const forced = await callCorrectionAgent(n3Messages, n3ApiKey, { noTools: true });
      const forcedText = forced.content.find(b => b.type === 'text');
      if (forcedText?.type === 'text') {
        try { n3Result = JSON.parse(extractJsonFromText(forcedText.text)) as ZoneCorrectionResponse; } catch { /* fall through */ }
      }
    }

    if (!n3Result) {
      return NextResponse.json({ error: 'Agent did not produce a correction' }, { status: 500 });
    }

    if (!n3Result.agentMessage) {
      await prisma.$transaction(async tx => {
        await tx.n3Zone.deleteMany({ where: { comparisonId, source: 'yours' } });
        await tx.n3Zone.deleteMany({ where: { comparisonId, source: 'adjuster' } });
        for (const z of n3Result!.e1Zones) {
          await tx.n3Zone.create({
            data: {
              comparisonId,
              source: 'yours',
              name: z.name,
              normalizedName: z.name.toLowerCase().trim(),
              startPage: z.startPage,
              endPage: z.endPage,
              approxItems: z.approxItems,
              verificationStatus: 'user_corrected',
            },
          });
        }
        for (const z of n3Result!.e2Zones) {
          await tx.n3Zone.create({
            data: {
              comparisonId,
              source: 'adjuster',
              name: z.name,
              normalizedName: z.name.toLowerCase().trim(),
              startPage: z.startPage,
              endPage: z.endPage,
              approxItems: z.approxItems,
              verificationStatus: 'user_corrected',
            },
          });
        }
      });
    }

    return NextResponse.json({
      e1Zones: n3Result.e1Zones,
      e2Zones: n3Result.e2Zones,
      matchHints: n3Result.matchHints ?? [],
      confirmedUniqueZones: n3Result.confirmedUniqueZones ?? [],
      agentMessage: n3Result.agentMessage ?? null,
      confirmationMessage: n3Result.confirmationMessage ?? 'Correction applied.',
    });
  }
  // ── End N3 path ───────────────────────────────────────────────────────────────

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
    const forced = await callCorrectionAgent(messages, apiKey, { noTools: true });
    const forcedText = forced.content.find(b => b.type === 'text');
    if (forcedText?.type === 'text') {
      try { correctionResult = JSON.parse(extractJsonFromText(forcedText.text)) as ZoneCorrectionResponse; } catch { /* fall through */ }
    }
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
    confirmationMessage: correctionResult.confirmationMessage ?? 'Correction applied.',
  });
}
