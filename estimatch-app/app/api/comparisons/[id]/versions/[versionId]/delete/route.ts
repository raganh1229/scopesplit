import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import prisma from '@/lib/prisma';

type RouteContext = {
  params: Promise<{ id: string; versionId: string }>;
};

/**
 * DELETE — remove a specific version and its line items.
 * If the deleted version was active, activate the highest remaining version.
 * Cannot delete the last remaining version (version 1 / Initial).
 */
export async function DELETE(_request: Request, context: RouteContext) {
  const { userId: clerkId } = await auth();
  if (!clerkId) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const appUser = await prisma.user.findUnique({ where: { clerkId } });
  if (!appUser) return NextResponse.json({ error: 'User not synced.' }, { status: 409 });

  const { id: comparisonId, versionId } = await context.params;

  const comparison = await prisma.comparison.findFirst({
    where: { id: comparisonId, userId: appUser.id },
    select: { id: true },
  });
  if (!comparison) return NextResponse.json({ error: 'Comparison not found.' }, { status: 404 });

  const version = await prisma.comparisonVersion.findFirst({
    where: { id: versionId, comparisonId },
    select: { id: true, versionNumber: true, isActive: true },
  });
  if (!version) return NextResponse.json({ error: 'Version not found.' }, { status: 404 });

  // Count total versions for this comparison
  const totalVersions = await prisma.comparisonVersion.count({
    where: { comparisonId },
  });

  if (totalVersions <= 1) {
    return NextResponse.json(
      { error: 'Cannot delete the only remaining version.' },
      { status: 400 }
    );
  }

  const wasActive = version.isActive;

  await prisma.$transaction(async (tx) => {
    // Delete the version (cascade deletes its line items via DB FK)
    await tx.comparisonVersion.delete({ where: { id: versionId } });

    // If it was the active version, activate the highest remaining version
    if (wasActive) {
      const nextActive = await tx.comparisonVersion.findFirst({
        where: { comparisonId },
        orderBy: { versionNumber: 'desc' },
        select: { id: true },
      });
      if (nextActive) {
        await tx.comparisonVersion.update({
          where: { id: nextActive.id },
          data: { isActive: true },
        });
      }
    }
  });

  return NextResponse.json(
    { deleted: { id: versionId, versionNumber: version.versionNumber } },
    { status: 200 }
  );
}
