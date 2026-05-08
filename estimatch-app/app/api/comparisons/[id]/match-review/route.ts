// ─────────────────────────────────────────────────────────────────────────────
// GET /api/comparisons/[id]/match-review
//
// Returns the AI-produced zone-match pairs for the MatchReview UI.
// Each pair includes display names for both sides, an AI confidence score,
// and an isMerged flag. Unmatched zones are listed separately.
//
// Status guard: only returns data when status is AWAITING_MATCH_REVIEW.
// Auth: Clerk + DB ownership check.
// ─────────────────────────────────────────────────────────────────────────────

import { auth } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { readZonesMatched } from '@/lib/n2/utils/n2-state';

export async function GET(
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

  if (comparison.status !== 'AWAITING_MATCH_REVIEW') {
    return NextResponse.json(
      { error: 'Comparison is not awaiting match review' },
      { status: 409 },
    );
  }

  const matched = await readZonesMatched(comparisonId);
  if (!matched) {
    return NextResponse.json({ error: 'Match state not found' }, { status: 500 });
  }

  return NextResponse.json({
    pairs: matched.matched.map(pair => ({
      e1Zones: pair.e1Zones.map(z => z.zone),
      e2Zones: pair.e2Zones.map(z => z.zone),
      canonical: pair.canonical,
      isMerged: pair.isMerged,
      confidence: pair.confidence,
    })),
    unmatchedE1: matched.unmatchedE1.map(z => z.zone),
    unmatchedE2: matched.unmatchedE2.map(z => z.zone),
  });
}
