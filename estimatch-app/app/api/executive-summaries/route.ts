import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import prisma from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/** GET — list all executive summaries for the current user, newest first */
export async function GET() {
  const { userId: clerkId } = await auth();
  if (!clerkId) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const appUser = await prisma.user.findUnique({ where: { clerkId }, select: { id: true } });
  if (!appUser) return NextResponse.json({ error: 'User not synced.' }, { status: 409 });

  const summaries = await prisma.executiveSummary.findMany({
    where: { userId: appUser.id },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      comparisonId: true,
      instructions: true,
      createdAt: true,
      comparison: {
        select: {
          name: true,
          yourEstimateFilename: true,
          adjusterEstimateFilename: true,
          insuredName: true,
          claimNumber: true,
        },
      },
    },
  });

  return NextResponse.json({ summaries });
}
