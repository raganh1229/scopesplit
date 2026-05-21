// ─────────────────────────────────────────────────────────────────────────────
// POST /api/comparisons/[id]/line-item-review/reextract
//
// Called when the user reports item counts look wrong and wants to re-run
// Phase 8 extraction. Fires 'comparison/n3-line-item-review.completed' with
// action='reextract' so the pipeline's p8.5 waitForEvent step resumes into
// the p8-reextract-line-items branch.
//
// Request body:
//   {
//     source:  'yours' | 'adjuster' | 'both'   // which side to re-extract
//     feedback: string                          // user's description of the issue
//   }
//
// The `source` field determines credit cost:
//   - 'yours' or 'adjuster': targeted re-extract (low cost)
//   - 'both':                full re-extract both sides (high cost — warned in UI)
//
// Auth: Clerk + DB ownership check.
// ─────────────────────────────────────────────────────────────────────────────

import { auth } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { inngest } from '@/lib/inngest/client';

type ReextractBody = {
  source:   'yours' | 'adjuster' | 'both';
  feedback: string;
};

export async function POST(
  request: NextRequest,
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

  let body: ReextractBody;
  try {
    body = (await request.json()) as ReextractBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { source, feedback } = body;
  if (!['yours', 'adjuster', 'both'].includes(source)) {
    return NextResponse.json(
      { error: 'source must be "yours", "adjuster", or "both"' },
      { status: 400 },
    );
  }

  await prisma.comparison.update({
    where: { id: comparisonId },
    data: { status: 'PROCESSING' },
  });

  await inngest.send({
    name: 'comparison/n3-line-item-review.completed',
    data: {
      comparisonId,
      action:           'reextract',
      reextractSource:  source,
      userFeedback:     feedback ?? '',
    },
  });

  return NextResponse.json({ ok: true, source, skipped: false });
}

export const dynamic = 'force-dynamic';
