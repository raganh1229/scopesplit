// ─────────────────────────────────────────────────────────────────────────────
// POST /api/comparisons/[id]/line-item-review/confirm
//
// Called by the Line Item Review gate (Phase 8.5) when the user is satisfied
// with the extracted item counts. Flips status to PROCESSING and fires the
// Inngest event that resumes the pipeline from Phase 9 onward.
//
// Request body: {}  (empty — user has no corrections at this path)
//
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
    return NextResponse.json({ ok: true, skipped: true, reason: 'not-awaiting-line-item-review' });
  }

  await prisma.comparison.update({
    where: { id: comparisonId },
    data: { status: 'PROCESSING' },
  });

  await inngest.send({
    name: 'comparison/n3-line-item-review.completed',
    data: { comparisonId, action: 'confirmed' },
  });

  return NextResponse.json({ ok: true, skipped: false });
}

export const dynamic = 'force-dynamic';
