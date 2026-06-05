// ─────────────────────────────────────────────────────────────────────────────
// POST /api/comparisons/[id]/match-review/back
//
// Returns the pipeline to the zone-review gate without advancing Inngest.
// The Inngest function remains blocked at step.waitForEvent('match-review-complete');
// only the DB status is reverted to AWAITING_ZONE_REVIEW so the UI re-renders
// the zone correction screen.
//
// The next time the user confirms zone review, zone-review/confirm detects
// re-entry (n3_zone_correspondences already exist) and flips status directly
// to AWAITING_MATCH_REVIEW without firing the zone-review event again, so the
// Inngest pipeline remains waiting at the match-review gate undisturbed.
//
// Auth: Clerk + DB ownership check.
// ─────────────────────────────────────────────────────────────────────────────

import { auth } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: comparisonId } = await params;

  const dbUser = await prisma.user.findUnique({
    where: { clerkId: userId },
    select: { id: true },
  });
  if (!dbUser) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const comparison = await prisma.comparison.findUnique({
    where: { id: comparisonId },
    select: { userId: true, status: true },
  });
  if (!comparison) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (comparison.userId !== dbUser.id)
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  if ((comparison.status as string) !== 'AWAITING_MATCH_REVIEW') {
    return NextResponse.json({ ok: true, skipped: true, reason: 'not-awaiting-match-review' });
  }

  // Revert status to AWAITING_ZONE_REVIEW.
  // AWAITING_ZONE_REVIEW is in the generated Prisma enum so a regular update works.
  await prisma.comparison.update({
    where: { id: comparisonId },
    data: { status: 'AWAITING_ZONE_REVIEW' },
  });

  return NextResponse.json({ ok: true });
}

export const dynamic = 'force-dynamic';
