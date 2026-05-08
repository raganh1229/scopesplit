import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import prisma from '@/lib/prisma';

export async function POST() {
  const { userId: clerkId } = await auth();

  if (!clerkId) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const appUser = await prisma.user.findUnique({
    where: { clerkId },
    select: {
      id: true,
      pendingTierDowngrade: true,
      pendingTierEffectiveAt: true,
    },
  });

  if (!appUser) {
    return NextResponse.json({ error: 'User is not synced to the database yet.' }, { status: 409 });
  }

  if (!appUser.pendingTierDowngrade && !appUser.pendingTierEffectiveAt) {
    return NextResponse.json({ cancelled: false }, { status: 200 });
  }

  await prisma.user.update({
    where: { id: appUser.id },
    data: {
      pendingTierDowngrade: null,
      pendingTierEffectiveAt: null,
    },
  });

  return NextResponse.json({ cancelled: true }, { status: 200 });
}
