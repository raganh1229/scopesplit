import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import prisma from '@/lib/prisma';

type RouteContext = { params: Promise<{ id: string }> };

/** GET — fetch a single executive summary (verified to belong to current user) */
export async function GET(_request: Request, context: RouteContext) {
  const { userId: clerkId } = await auth();
  if (!clerkId) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const appUser = await prisma.user.findUnique({ where: { clerkId }, select: { id: true } });
  if (!appUser) return NextResponse.json({ error: 'User not synced.' }, { status: 409 });

  const { id } = await context.params;

  const summary = await prisma.executiveSummary.findFirst({
    where: { id, userId: appUser.id },
    select: {
      id: true,
      markdown: true,
      instructions: true,
      createdAt: true,
      comparisonId: true,
      comparison: {
        select: {
          name: true,
          insuredName: true,
          claimNumber: true,
          yourEstimateFilename: true,
          adjusterEstimateFilename: true,
        },
      },
    },
  });

  if (!summary) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  return NextResponse.json({ summary });
}

/** DELETE — permanently remove a saved executive summary */
export async function DELETE(_request: Request, context: RouteContext) {
  const { userId: clerkId } = await auth();
  if (!clerkId) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const appUser = await prisma.user.findUnique({ where: { clerkId }, select: { id: true } });
  if (!appUser) return NextResponse.json({ error: 'User not synced.' }, { status: 409 });

  const { id } = await context.params;

  const deleted = await prisma.executiveSummary.deleteMany({
    where: { id, userId: appUser.id },
  });

  if (deleted.count === 0) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  return NextResponse.json({ ok: true });
}
