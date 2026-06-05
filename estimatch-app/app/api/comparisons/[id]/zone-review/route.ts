// ─────────────────────────────────────────────────────────────────────────────
// GET /api/comparisons/[id]/zone-review
//
// Returns the current zone state (corrected if corrections exist, otherwise
// the originally detected zones) for rendering the ZoneReview UI.
//
// Auth: Clerk + DB ownership check.
// Status guard: only returns data when status is AWAITING_ZONE_REVIEW.
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

  const dbUser = await prisma.user.findUnique({ where: { clerkId: userId }, select: { id: true } });
  if (!dbUser) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const comparison = await prisma.comparison.findUnique({
    where: { id: comparisonId },
    select: { userId: true, status: true, pipelineVersion: true },
  });
  if (!comparison) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (comparison.userId !== dbUser.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  if (comparison.status !== 'AWAITING_ZONE_REVIEW') {
    return NextResponse.json(
      { error: 'Comparison is not awaiting zone review' },
      { status: 409 },
    );
  }

  const slim = (z: { name: string; startPage: number; endPage: number; approxItems: number }) => ({
    name: z.name,
    startPage: z.startPage,
    endPage: z.endPage,
    approxItems: z.approxItems,
  });

  // ── N3/N4 path: read from n3_zones table ─────────────────────────────────
  if (comparison.pipelineVersion === 'n3' || comparison.pipelineVersion === 'n4') {
    const zones = await prisma.n3Zone.findMany({
      where: { comparisonId },
      select: { name: true, source: true, startPage: true, endPage: true, approxItems: true },
      orderBy: [{ source: 'asc' }, { startPage: 'asc' }],
    });
    return NextResponse.json({
      e1Zones: zones.filter(z => z.source === 'yours').map(slim),
      e2Zones: zones.filter(z => z.source === 'adjuster').map(slim),
    });
  }

  return NextResponse.json({ error: 'Unsupported pipeline version' }, { status: 409 });
}
