import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import prisma from '@/lib/prisma';

type RouteContext = {
  params: Promise<{ id: string }>;
};

/**
 * GET  — list all versions for a comparison (newest first)
 * POST — create Version 1 snapshot from canonical line_items (idempotent)
 */

export async function GET(_request: Request, context: RouteContext) {
  const { userId: clerkId } = await auth();
  if (!clerkId) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const appUser = await prisma.user.findUnique({ where: { clerkId } });
  if (!appUser) return NextResponse.json({ error: 'User not synced.' }, { status: 409 });

  const { id } = await context.params;

  const comparison = await prisma.comparison.findFirst({
    where: { id, userId: appUser.id },
    select: { id: true },
  });
  if (!comparison) return NextResponse.json({ error: 'Comparison not found.' }, { status: 404 });

  const versions = await prisma.comparisonVersion.findMany({
    where: { comparisonId: id },
    orderBy: { versionNumber: 'desc' },
    select: {
      id: true,
      versionNumber: true,
      label: true,
      editPrompt: true,
      isActive: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ versions }, { status: 200 });
}

export async function POST(_request: Request, context: RouteContext) {
  const { userId: clerkId } = await auth();
  if (!clerkId) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const appUser = await prisma.user.findUnique({ where: { clerkId } });
  if (!appUser) return NextResponse.json({ error: 'User not synced.' }, { status: 409 });

  const { id } = await context.params;

  const comparison = await prisma.comparison.findFirst({
    where: { id, userId: appUser.id, status: 'COMPLETED' },
    select: {
      id: true,
      lineItems: {
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      },
    },
  });

  if (!comparison) {
    return NextResponse.json(
      { error: 'Completed comparison not found.' },
      { status: 404 }
    );
  }

  // Idempotent — if version 1 already exists, return it
  const existing = await prisma.comparisonVersion.findUnique({
    where: { comparisonId_versionNumber: { comparisonId: id, versionNumber: 1 } },
    select: { id: true, versionNumber: true, label: true, isActive: true, createdAt: true },
  });

  if (existing) {
    return NextResponse.json({ version: existing, created: false }, { status: 200 });
  }

  // Create version 1 snapshot from canonical line_items in a transaction
  const version = await prisma.$transaction(async (tx) => {
    const ver = await tx.comparisonVersion.create({
      data: {
        comparisonId: id,
        versionNumber: 1,
        label: 'Initial',
        isActive: true,
      },
    });

    if (comparison.lineItems.length > 0) {
      await tx.comparisonVersionLineItem.createMany({
        data: comparison.lineItems.map((li) => ({
          versionId: ver.id,
          originalLineItemId: li.id,
          matchStatus: li.matchStatus,
          zoneYours: li.zoneYours,
          zoneAdjuster: li.zoneAdjuster,
          zoneCanonical: li.zoneCanonical,
          zoneConfidence: li.zoneConfidence,
          descriptionYours: li.descriptionYours,
          descriptionAdjuster: li.descriptionAdjuster,
          qtyYours: li.qtyYours,
          qtyAdjuster: li.qtyAdjuster,
          removeYours: li.removeYours,
          removeAdjuster: li.removeAdjuster,
          replaceYours: li.replaceYours,
          replaceAdjuster: li.replaceAdjuster,
          resetYours: li.resetYours,
          resetAdjuster: li.resetAdjuster,
          taxYours: li.taxYours,
          taxAdjuster: li.taxAdjuster,
          opYours: li.opYours,
          opAdjuster: li.opAdjuster,
          totalYours: li.totalYours,
          totalAdjuster: li.totalAdjuster,
          diffAmount: li.diffAmount,
          category: li.category,
          sortOrder: li.sortOrder,
        })),
      });
    }

    return ver;
  });

  return NextResponse.json(
    {
      version: {
        id: version.id,
        versionNumber: version.versionNumber,
        label: version.label,
        isActive: version.isActive,
        createdAt: version.createdAt,
      },
      created: true,
    },
    { status: 201 }
  );
}
