// ─────────────────────────────────────────────────────────────────────────────
// GET /api/comparisons/[id]/line-item-review
//
// Returns per-zone item counts for the Line Item Review gate (Phase 8.5).
// The UI shows these counts — NOT the individual items — so the user can
// sanity-check extraction totals without reviewing each line.
//
// Response shape:
//   {
//     yours:    { zoneName: string; itemCount: number; approxItems: number }[]
//     adjuster: { zoneName: string; itemCount: number; approxItems: number }[]
//     yoursTotal:    number   // sum of extracted items, yours side
//     adjusterTotal: number   // sum of extracted items, adjuster side
//   }
//
// Status guard: only returns data when status is AWAITING_LINE_ITEM_REVIEW.
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
    select: { userId: true, status: true },
  });
  if (!comparison) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (comparison.userId !== dbUser.id)
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  if (comparison.status !== 'AWAITING_LINE_ITEM_REVIEW') {
    return NextResponse.json(
      { error: 'Comparison is not awaiting line item review' },
      { status: 409 },
    );
  }

  // ── Fetch zones with approxItems ──────────────────────────────────────────
  const zones = await prisma.n3Zone.findMany({
    where: { comparisonId },
    select: { id: true, name: true, source: true, approxItems: true },
    orderBy: [{ source: 'asc' }, { startPage: 'asc' }],
  });

  // ── Count actual extracted items per zone ─────────────────────────────────
  const items = await prisma.n3LineItem.groupBy({
    by: ['zoneId'],
    where: { comparisonId },
    _count: { id: true },
  });

  const countByZone = new Map<string, number>();
  for (const row of items) {
    if (row.zoneId) countByZone.set(row.zoneId, row._count.id);
  }

  const yoursZones  = zones.filter(z => z.source === 'yours');
  const adjZones    = zones.filter(z => z.source === 'adjuster');

  const toRow = (z: typeof zones[0]) => ({
    zoneName:    z.name ?? '',
    itemCount:   countByZone.get(z.id) ?? 0,
    approxItems: z.approxItems ?? 0,
  });

  const yours    = yoursZones.map(toRow);
  const adjuster = adjZones.map(toRow);

  return NextResponse.json({
    yours,
    adjuster,
    yoursTotal:    yours.reduce((s, r) => s + r.itemCount, 0),
    adjusterTotal: adjuster.reduce((s, r) => s + r.itemCount, 0),
  });
}
