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

  return NextResponse.json({ error: 'Unsupported pipeline version' }, { status: 409 });
}
