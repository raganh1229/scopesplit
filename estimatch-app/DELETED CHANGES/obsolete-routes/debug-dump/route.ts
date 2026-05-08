import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';

export async function GET() {
  const c = await prisma.comparison.findFirst({
    orderBy: { createdAt: 'desc' },
    include: { lineItems: { orderBy: { sortOrder: 'asc' } } },
  });
  return NextResponse.json(c);
}
