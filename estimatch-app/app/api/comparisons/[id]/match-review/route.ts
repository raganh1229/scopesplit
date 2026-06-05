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
    select: { userId: true, status: true, pipelineVersion: true },
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

  // ── N3/N4 path: read from n3_zone_correspondences table ──────────────────
  if (comparison.pipelineVersion === 'n3' || comparison.pipelineVersion === 'n4') {
    const corrs = await prisma.n3ZoneCorrespondence.findMany({
      where: { comparisonId },
      include: {
        yourZones: { select: { name: true } },
        adjusterZones: { select: { name: true } },
      },
      orderBy: { confidence: 'desc' },
    });

    const paired = new Set<string>();
    const pairs = corrs.map(c => {
      const e1 = c.yourZones.map(z => z.name);
      const e2 = c.adjusterZones.map(z => z.name);
      e1.forEach(n => paired.add(n));
      e2.forEach(n => paired.add(n));
      return {
        e1Zones: e1,
        e2Zones: e2,
        canonical: e1[0] ?? e2[0] ?? '',
        isMerged: e1.length > 1 || e2.length > 1,
        confidence: Math.round(Number(c.confidence) * 10000) / 100,
      };
    });

    const allYours = await prisma.n3Zone.findMany({
      where: { comparisonId, source: 'yours' },
      select: { name: true },
    });
    const allAdj = await prisma.n3Zone.findMany({
      where: { comparisonId, source: 'adjuster' },
      select: { name: true },
    });

    const unmatchedE1 = allYours.map(z => z.name).filter(n => !paired.has(n));
    const unmatchedE2 = allAdj.map(z => z.name).filter(n => !paired.has(n));

    return NextResponse.json({ pairs, unmatchedE1, unmatchedE2 });
  }

  return NextResponse.json({ error: 'Unsupported pipeline version' }, { status: 409 });
}
