// ─────────────────────────────────────────────────────────────────────────────
// POST /api/comparisons/[id]/zone-management
//
// Handles zone management operations like unpairing zones and resetting to original.
// This allows users to manually override zone correspondences when confidence is low.
//
// Auth: Clerk + DB ownership check.
// Status guard: only works when comparison is completed.
// ─────────────────────────────────────────────────────────────────────────────

import { auth } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';

type ZoneManagementRequest = {
  action: 'unpair' | 'reset';
  zoneIds?: string[]; // For unpair action
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: comparisonId } = await params;

  const dbUser = await prisma.user.findUnique({ where: { clerkId: userId }, select: { id: true } });
  if (!dbUser) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const comparison = await prisma.comparison.findUnique({
    where: { id: comparisonId },
    select: { userId: true, status: true, pipelineVersion: true },
  });
  if (!comparison) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (comparison.userId !== dbUser.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // Only allow zone management on completed comparisons
  if (comparison.status !== 'COMPLETED') {
    return NextResponse.json(
      { error: 'Zone management is only available on completed comparisons' },
      { status: 409 },
    );
  }

  try {
    const body = (await request.json()) as ZoneManagementRequest;
    
    if (body.action === 'reset') {
      // Reset: clear all zone management overrides
      await prisma.n3ZoneManagement.deleteMany({
        where: { comparisonId },
      });
      
      return NextResponse.json({ success: true, message: 'Zone management reset to original' });
    }
    
    if (body.action === 'unpair' && body.zoneIds) {
      // Unpair: mark zones as unpaired
      const data = body.zoneIds.map(zoneId => ({
        comparisonId,
        zoneId,
        isUnpaired: true,
      }));
      
      await prisma.n3ZoneManagement.createMany({
        data,
        skipDuplicates: true,
      });
      
      return NextResponse.json({ 
        success: true, 
        message: `Unpaired ${body.zoneIds.length} zone(s)`,
        unpairedZones: body.zoneIds 
      });
    }
    
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    
  } catch (error) {
    console.error('Zone management error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: comparisonId } = await params;

  const dbUser = await prisma.user.findUnique({ where: { clerkId: userId }, select: { id: true } });
  if (!dbUser) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const comparison = await prisma.comparison.findUnique({
    where: { id: comparisonId },
    select: { userId: true, status: true, pipelineVersion: true },
  });
  if (!comparison) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (comparison.userId !== dbUser.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // Get current zone management state
  const zoneManagement = await prisma.n3ZoneManagement.findMany({
    where: { comparisonId },
    select: { zoneId: true, isUnpaired: true },
  });
  
  const unpairedZones = zoneManagement
    .filter(zm => zm.isUnpaired)
    .map(zm => zm.zoneId);
  
  return NextResponse.json({ unpairedZones });
}
