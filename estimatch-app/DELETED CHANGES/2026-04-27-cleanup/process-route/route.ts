import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import prisma from '@/lib/prisma';
import {
  isComparisonProcessingAvailable,
  runComparisonProcessing,
} from '@/lib/comparison-processing';

type RouteContext = {
  params: Promise<{ id: string }>;
};

type ProcessMode = 'success' | 'failed';

function parseMode(value: unknown): ProcessMode {
  if (value === 'failed') return 'failed';
  return 'success';
}

export async function POST(request: Request, context: RouteContext) {
  if (!isComparisonProcessingAvailable()) {
    return NextResponse.json(
      { error: 'Comparison processing is disabled.' },
      { status: 409 }
    );
  }

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
    },
  });

  if (!comparison) {
    return NextResponse.json({ error: 'Comparison not found.' }, { status: 404 });
  }

  if (comparison.status === 'PROCESSING') {
    return NextResponse.json(
      {
        status: 'already_processing',
        comparison: {
          id: comparison.id,
          status: comparison.status,
        },
      },
      { status: 409 }
    );
  }

  let mode: ProcessMode = 'success';

  try {
    const payload = (await request.json()) as { mode?: unknown };
    mode = parseMode(payload.mode);
  } catch {
    mode = 'success';
  }

  await prisma.comparison.update({
    where: { id: comparison.id },
    data: {
      status: 'PROCESSING',
      errorMessage: null,
    },
  });

  void runComparisonProcessing(comparison.id, {
    trigger: 'manual-route',
    stubMode: mode,
    stubDelayMs: 0,
  }).catch((error) => {
    console.error('Manual comparison processing failed:', error);
  });

  return NextResponse.json(
    {
      status: 'processing_started',
      comparison: {
        id: comparison.id,
        status: 'PROCESSING',
      },
      mode: isComparisonProcessingAvailable() ? 'real_or_stub' : 'disabled',
    },
    { status: 202 }
  );
}
