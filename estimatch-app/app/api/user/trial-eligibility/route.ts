import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import prisma from '@/lib/prisma';

export async function GET() {
  const { userId: clerkId } = await auth();

  if (!clerkId) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const appUser = await prisma.user.findUnique({
    where: { clerkId },
    select: {
      hasUsedTrial: true,
      subscriptionStatus: true,
    },
  });

  if (!appUser) {
    return NextResponse.json({ eligible: true });
  }

  const eligible = !appUser.hasUsedTrial && (
    appUser.subscriptionStatus === null ||
    appUser.subscriptionStatus === 'EXPIRED' ||
    appUser.subscriptionStatus === 'CANCELED'
  );

  return NextResponse.json({ eligible });
}
