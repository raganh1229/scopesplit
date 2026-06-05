// ─────────────────────────────────────────────────────────────────────────────
// POST /api/comparisons/[id]/match-review/confirm
//
// Accepts the user's (possibly adjusted) zone-pair arrangement, flips status
// to PROCESSING, and fires the comparison/n3-correspondence-review.completed
// Inngest event to resume the N3/N4 pipeline past the match-review gate.
//
// Request body:
//   {
//     e1Slots: (string | null)[],  // ordered E1 zone names; null = blank row
//     e2Slots: (string | null)[]   // same length; same index = paired
//   }
//
// Idempotent: safe to call even if no adjustments were made.
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
    select: { userId: true, status: true, pipelineVersion: true },
  });
  if (!comparison) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (comparison.userId !== dbUser.id)
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  if (comparison.status !== 'AWAITING_MATCH_REVIEW') {
    return NextResponse.json({ ok: true, skipped: true, reason: 'not-awaiting-match-review' });
  }

  // ── N3/N4 path ───────────────────────────────────────────────────────────
  if (comparison.pipelineVersion === 'n3' || comparison.pipelineVersion === 'n4') {
    await prisma.comparison.update({
      where: { id: comparisonId },
      data: { status: 'PROCESSING' },
    });
    await inngest.send({
      name: 'comparison/n3-correspondence-review.completed',
      data: { comparisonId, action: 'confirmed' },
    });
    return NextResponse.json({ ok: true, skipped: false });
  }

  return NextResponse.json({ error: 'Unsupported pipeline version' }, { status: 409 });
}

// Re-export GET to generate a proper 405 for unsupported methods
export const dynamic = 'force-dynamic';
