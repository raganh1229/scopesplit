import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import prisma from '@/lib/prisma';

type RouteContext = {
  params: Promise<{ id: string; versionId: string }>;
};

/**
 * POST — mark a specific version as active (deactivates all others for this comparison)
 */
export async function POST(_request: Request, context: RouteContext) {
  const { userId: clerkId } = await auth();
  if (!clerkId) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const appUser = await prisma.user.findUnique({ where: { clerkId } });
  if (!appUser) return NextResponse.json({ error: 'User not synced.' }, { status: 409 });

  const { id: comparisonId, versionId } = await context.params;

  // Verify ownership
  const comparison = await prisma.comparison.findFirst({
    where: { id: comparisonId, userId: appUser.id },
    select: { id: true },
  });
  if (!comparison) return NextResponse.json({ error: 'Comparison not found.' }, { status: 404 });

  // Verify the version belongs to this comparison
  const version = await prisma.comparisonVersion.findFirst({
    where: { id: versionId, comparisonId },
    select: { id: true, versionNumber: true, label: true },
  });
  if (!version) return NextResponse.json({ error: 'Version not found.' }, { status: 404 });

  // Swap active flag in a transaction
  await prisma.$transaction([
    prisma.comparisonVersion.updateMany({
      where: { comparisonId, isActive: true },
      data: { isActive: false },
    }),
    prisma.comparisonVersion.update({
      where: { id: versionId },
      data: { isActive: true },
    }),
  ]);

  return NextResponse.json(
    { activated: { id: version.id, versionNumber: version.versionNumber, label: version.label } },
    { status: 200 }
  );
}
