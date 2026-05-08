import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';

export async function GET() {
  try {
    // Test 1: Can we connect?
    const userCount = await prisma.user.count();
    const comparisonCount = await prisma.comparison.count();
    const lineItemCount = await prisma.lineItem.count();

    return NextResponse.json({
      status: 'connected',
      tables: {
        users: userCount,
        comparisons: comparisonCount,
        line_items: lineItemCount,
      },
      message: 'Database connection successful. All tables accessible.',
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { status: 'error', message },
      { status: 500 }
    );
  }
}
