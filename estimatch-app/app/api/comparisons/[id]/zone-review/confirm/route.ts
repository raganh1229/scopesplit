// ─────────────────────────────────────────────────────────────────────────────
// POST /api/comparisons/[id]/zone-review/confirm
//
// Fires the comparison/n3-zone-review.completed Inngest event, resuming the
// N3/N4 pipeline past the step.waitForEvent gate. Sets status to PROCESSING.
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
    // Re-entry detection: if zone correspondences already exist the pipeline
    // already consumed the zone-review event and is now blocked at the
    // match-review gate. Firing the event again would orphan it and leave
    // status stuck at PROCESSING forever (spinner deadlock).
    // Instead: flip status directly to AWAITING_MATCH_REVIEW and tell the
    // frontend to skip the spinner and show MatchReview immediately.
    const existingCorrespondences = await prisma.n3ZoneCorrespondence.count({
      where: { comparisonId },
    });
    if (existingCorrespondences > 0) {
      await prisma.comparison.update({
        where: { id: comparisonId },
        data: { status: 'AWAITING_MATCH_REVIEW' },
      });
      return NextResponse.json({ ok: true, skipped: false, reEntry: true });
    }

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
