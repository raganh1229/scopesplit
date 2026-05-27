// ─────────────────────────────────────────────────────────────────────────────
// POST /api/comparisons/[id]/zone-review/confirm
//
// Normal path (first time):
//   Fires the comparison/zone-review.completed Inngest event, resuming the
//   N2 pipeline past the step.waitForEvent gate. Sets status to PROCESSING.
//
// Re-entry path (user went back from match review):
//   Detected when n2:zones_matched already exists. The Inngest pipeline is
//   still blocked at the match-review gate, so we must NOT fire zone-review
//   .completed again. Instead: re-run matchZones inline here, then set
//   status directly to AWAITING_MATCH_REVIEW. The pipeline remains waiting.
//
// Idempotent: safe to call even if no zone corrections were made.
// Auth: Clerk + DB ownership check.
// ─────────────────────────────────────────────────────────────────────────────

import { auth } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { inngest } from '@/lib/inngest/client';
import { readZonesMatched } from '@/lib/n2/utils/n2-state';
import { matchZones } from '@/lib/n2/passes/match-zones';

// Re-entry path calls matchZones() inline (one Sonnet call, ~15-30 s).
// Normal path just fires an Inngest event (< 1 s). 60 s covers both safely.
export const maxDuration = 60;

const reEntryLogger = {
  info: (msg: string, data?: Record<string, unknown>) => console.log('[zone-review/confirm re-entry]', msg, data ?? ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn('[zone-review/confirm re-entry]', msg, data ?? ''),
};

export async function POST(
  _request: NextRequest,
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

  if (comparison.status !== 'AWAITING_ZONE_REVIEW') {
    return NextResponse.json({ ok: true, skipped: true, reason: 'not-awaiting-review' });
  }

  // ── N3/N4 path ─────────────────────────────────────────────────────────────
  if (comparison.pipelineVersion === 'n3' || comparison.pipelineVersion === 'n4') {
    await prisma.comparison.update({
      where: { id: comparisonId },
      data: { status: 'PROCESSING' },
    });
    await inngest.send({
      name: 'comparison/n3-zone-review.completed',
      data: { comparisonId, action: 'confirmed' },
    });
    return NextResponse.json({ ok: true, skipped: false });
  }

  // ── Re-entry detection ────────────────────────────────────────────────────
  // If zones_matched already exists the user went Back from the match review
  // gate. The Inngest function is still blocked at step.waitForEvent(
  // 'match-review-complete'). Re-run matchZones inline and advance status
  // directly to AWAITING_MATCH_REVIEW without touching Inngest.
  const existingMatch = await readZonesMatched(comparisonId);
  if (existingMatch) {
    try {
      await matchZones(comparisonId, reEntryLogger);
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 300) : String(err);
      return NextResponse.json({ error: `Zone re-matching failed: ${msg}` }, { status: 500 });
    }

    await prisma.$executeRaw`
      UPDATE comparisons
      SET status = 'AWAITING_MATCH_REVIEW'::comparison_status, updated_at = NOW()
      WHERE id = ${comparisonId}
    `;

    return NextResponse.json({ ok: true, reEntry: true });
  }

  // ── Normal first-time path ────────────────────────────────────────────────
  await prisma.comparison.update({
    where: { id: comparisonId },
    data: { status: 'PROCESSING' },
  });

  await inngest.send({
    name: 'comparison/zone-review.completed',
    data: { comparisonId },
  });

  return NextResponse.json({ ok: true, skipped: false });
}
