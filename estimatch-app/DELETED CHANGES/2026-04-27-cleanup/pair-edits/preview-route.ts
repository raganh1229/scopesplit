import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import prisma from '@/lib/prisma';
import { validatePairEditOperations } from '@/lib/pair-edits/operations';

type RouteContext = {
  params: Promise<{ id: string }>;
};

function hasYourSideData(item: {
  descriptionYours: string | null;
  qtyYours: string | null;
  removeYours: unknown;
  replaceYours: unknown;
  taxYours: unknown;
  opYours: unknown;
  totalYours: unknown;
}): boolean {
  return (
    item.descriptionYours !== null ||
    item.qtyYours !== null ||
    item.removeYours !== null ||
    item.replaceYours !== null ||
    item.taxYours !== null ||
    item.opYours !== null ||
    item.totalYours !== null
  );
}

function hasAdjusterSideData(item: {
  descriptionAdjuster: string | null;
  qtyAdjuster: string | null;
  removeAdjuster: unknown;
  replaceAdjuster: unknown;
  taxAdjuster: unknown;
  opAdjuster: unknown;
  totalAdjuster: unknown;
}): boolean {
  return (
    item.descriptionAdjuster !== null ||
    item.qtyAdjuster !== null ||
    item.removeAdjuster !== null ||
    item.replaceAdjuster !== null ||
    item.taxAdjuster !== null ||
    item.opAdjuster !== null ||
    item.totalAdjuster !== null
  );
}

export async function POST(request: Request, context: RouteContext) {
  const { userId: clerkId } = await auth();

  if (!clerkId) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const appUser = await prisma.user.findUnique({ where: { clerkId } });

  if (!appUser) {
    return NextResponse.json(
      { error: 'User is not synced to the database yet.' },
      { status: 409 }
    );
  }

  const { id } = await context.params;

  const comparison = await prisma.comparison.findFirst({
    where: {
      id,
      userId: appUser.id,
    },
    select: {
      id: true,
      status: true,
      lineItems: {
        select: {
          id: true,
          descriptionYours: true,
          descriptionAdjuster: true,
          qtyYours: true,
          qtyAdjuster: true,
          removeYours: true,
          removeAdjuster: true,
          replaceYours: true,
          replaceAdjuster: true,
          taxYours: true,
          taxAdjuster: true,
          opYours: true,
          opAdjuster: true,
          totalYours: true,
          totalAdjuster: true,
        },
      },
    },
  });

  if (!comparison) {
    return NextResponse.json({ error: 'Comparison not found.' }, { status: 404 });
  }

  let body: { operations?: unknown };
  try {
    body = (await request.json()) as { operations?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 });
  }

  const rowSnapshots = comparison.lineItems.map((item) => ({
    id: item.id,
    hasYoursSide: hasYourSideData(item),
    hasAdjusterSide: hasAdjusterSideData(item),
  }));

  const validation = validatePairEditOperations(body.operations, rowSnapshots);

  return NextResponse.json(
    {
      comparisonId: comparison.id,
      comparisonStatus: comparison.status,
      mode: 'preview_only',
      summary: {
        totalSubmitted: Array.isArray(body.operations) ? body.operations.length : 0,
        acceptedCount: validation.accepted.length,
        rejectedCount: validation.rejected.length,
      },
      acceptedOperations: validation.accepted,
      rejectedOperations: validation.rejected,
      warning:
        'No comparison rows were mutated. This endpoint validates draft pair edits only and keeps the generation pipeline untouched.',
    },
    { status: 200 }
  );
}
