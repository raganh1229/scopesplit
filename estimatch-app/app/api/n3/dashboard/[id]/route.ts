// ─────────────────────────────────────────────────────────────────────────────
// GET /api/n3/dashboard/[id]
//
// Returns the full N3DashboardMetrics blob for a comparison. Internal debug
// surface; auth required + ownership check.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import prisma from '@/lib/prisma';
import { computePipelineMetrics } from '@/lib/n3/metrics/compute-metrics';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: RouteContext) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  // Ownership check via Clerk → User → Comparison
  const dbUser = await prisma.user.findUnique({
    where: { clerkId: userId },
    select: { id: true },
  });
  if (!dbUser) return NextResponse.json({ error: 'User not synced' }, { status: 404 });

  const cmp = await prisma.comparison.findUnique({
    where: { id },
    select: { id: true, userId: true },
  });
  if (!cmp || cmp.userId !== dbUser.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const metrics = await computePipelineMetrics(id);
    if (!metrics) {
      return NextResponse.json({ error: 'No N3 data available' }, { status: 404 });
    }
    return NextResponse.json(metrics);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: 'Failed to compute metrics', detail: message }, { status: 500 });
  }
}
