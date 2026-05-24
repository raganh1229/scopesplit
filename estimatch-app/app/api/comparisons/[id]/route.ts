import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import prisma from '@/lib/prisma';
import { supabaseAdmin } from '@/lib/supabase';
import { MatchStatus } from '@/app/generated/prisma/client';

const ESTIMATES_BUCKET = 'estimates';

type RouteContext = {
  params: Promise<{ id: string }>;
};

type UiRowStatus = 'match' | 'match_unverified' | 'modified' | 'missing' | 'added';

function toNumber(value: number | bigint | { toString(): string } | null): number | null {
  if (value === null) return null;
  return Number(value);
}

function mapMatchStatus(status: MatchStatus): UiRowStatus {
  if (status === MatchStatus.MATCH) return 'match';
  if (status === MatchStatus.MATCH_UNVERIFIED) return 'match_unverified';
  if (status === MatchStatus.MISSING_FROM_ADJUSTER) return 'missing';
  if (status === MatchStatus.ADDED_BY_ADJUSTER) return 'added';
  return 'modified';
}

function toZoneId(canonicalName: string): string {
  return canonicalName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}

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

export async function GET(_request: Request, context: RouteContext) {
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
      name: true,
      status: true,
      errorMessage: true,
      createdAt: true,
      yourEstimateFilename: true,
      adjusterEstimateFilename: true,
      yourEstimateTotal: true,
      adjusterEstimateTotal: true,
      totalGap: true,
      matchCount: true,
      modifiedCount: true,
      missingCount: true,
      addedCount: true,
      lineItems: {
        orderBy: [
          { sortOrder: 'asc' },
          { createdAt: 'asc' },
        ],
        select: {
          id: true,
          matchStatus: true,
          zoneYours: true,
          zoneAdjuster: true,
          zoneCanonical: true,
          zoneConfidence: true,
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
          category: true,
          sortOrder: true,
        },
      },
    },
  });

  if (!comparison) {
    return NextResponse.json({ error: 'Comparison not found.' }, { status: 404 });
  }

  type ZoneEntry = {
    id: string;
    canonicalName: string;
    yourName: string | null;
    adjusterName: string | null;
    confidence: number | null;
    items: Array<{
      id: string;
      status: UiRowStatus;
      category: string;
      your: {
        description: string;
        qty: string;
        remove: number;
        replace: number;
        tax: number;
        op: number;
        total: number;
      } | null;
      adjuster: {
        description: string;
        qty: string;
        remove: number;
        replace: number;
        tax: number;
        op: number;
        total: number;
      } | null;
    }>;
  };

  const zoneMap = new Map<string, ZoneEntry>();

  for (const item of comparison.lineItems) {
    // Use zoneCanonical for grouping (set by zone reconciliation pipeline)
    const canonicalZone = item.zoneCanonical ?? item.zoneYours ?? item.zoneAdjuster ?? 'General';
    const zoneId = toZoneId(canonicalZone);

    if (!zoneMap.has(zoneId)) {
      // Zone names are set by Claude's zone mappings — trust them directly
      const yRaw = item.zoneYours ?? null;
      const aRaw = item.zoneAdjuster ?? null;
      zoneMap.set(zoneId, {
        id: zoneId,
        canonicalName: canonicalZone,
        yourName: yRaw && yRaw !== '__UNZONED__' ? yRaw : null,
        adjusterName: aRaw && aRaw !== '__UNZONED__' ? aRaw : null,
        confidence: item.zoneConfidence ?? null,
        items: [],
      });
    }

    const zone = zoneMap.get(zoneId)!;

    // Fill in zone names from subsequent items if not already set
    if (!zone.yourName && item.zoneYours && item.zoneYours !== '__UNZONED__') {
      zone.yourName = item.zoneYours;
    }
    if (!zone.adjusterName && item.zoneAdjuster && item.zoneAdjuster !== '__UNZONED__') {
      zone.adjusterName = item.zoneAdjuster;
    }
    // Use highest confidence seen for this zone
    if (item.zoneConfidence !== null && (zone.confidence === null || item.zoneConfidence > zone.confidence)) {
      zone.confidence = item.zoneConfidence;
    }

    zone.items.push({
      id: item.id,
      status: mapMatchStatus(item.matchStatus),
      category: item.category ?? 'uncategorized',
      your: hasYourSideData(item)
        ? {
          description: item.descriptionYours ?? '—',
          qty: item.qtyYours ?? '',
          remove: toNumber(item.removeYours) ?? 0,
          replace: toNumber(item.replaceYours) ?? 0,
          tax: toNumber(item.taxYours) ?? 0,
          op: toNumber(item.opYours) ?? 0,
          total: toNumber(item.totalYours) ?? 0,
        }
        : null,
      adjuster: hasAdjusterSideData(item)
        ? {
          description: item.descriptionAdjuster ?? '—',
          qty: item.qtyAdjuster ?? '',
          remove: toNumber(item.removeAdjuster) ?? 0,
          replace: toNumber(item.replaceAdjuster) ?? 0,
          tax: toNumber(item.taxAdjuster) ?? 0,
          op: toNumber(item.opAdjuster) ?? 0,
          total: toNumber(item.totalAdjuster) ?? 0,
        }
        : null,
    });
  }

  // Sort zones: matched (has both sides) by absolute gap desc, then unmatched yours, then unmatched adjuster, then "Unzoned"/"General"
  const allZones = Array.from(zoneMap.values());

  const getZoneGap = (z: ZoneEntry): number => {
    let yourTotal = 0;
    let adjTotal = 0;
    for (const item of z.items) {
      yourTotal += item.your?.total ?? 0;
      adjTotal += item.adjuster?.total ?? 0;
    }
    return Math.abs(yourTotal - adjTotal);
  };

  const isUnzoned = (z: ZoneEntry): boolean =>
    z.canonicalName.toLowerCase() === 'unzoned' ||
    z.canonicalName.toLowerCase() === 'general' ||
    z.canonicalName.toLowerCase() === '__unzoned__';

  const hasBothSides = (z: ZoneEntry): boolean =>
    z.yourName !== null && z.adjusterName !== null;

  allZones.sort((a, b) => {
    // Unzoned always last
    const aUnzoned = isUnzoned(a) ? 1 : 0;
    const bUnzoned = isUnzoned(b) ? 1 : 0;
    if (aUnzoned !== bUnzoned) return aUnzoned - bUnzoned;

    // Matched zones (both sides) before unmatched
    const aBoth = hasBothSides(a) ? 0 : 1;
    const bBoth = hasBothSides(b) ? 0 : 1;
    if (aBoth !== bBoth) return aBoth - bBoth;

    // Within same group: sort by gap descending (biggest discrepancies first)
    return getZoneGap(b) - getZoneGap(a);
  });

  return NextResponse.json(
    {
      comparison: {
        id: comparison.id,
        name: comparison.name,
        status: comparison.status,
        errorMessage: comparison.errorMessage,
        createdAt: comparison.createdAt,
        yourEstimateFilename: comparison.yourEstimateFilename,
        adjusterEstimateFilename: comparison.adjusterEstimateFilename,
        yourEstimateTotal: toNumber(comparison.yourEstimateTotal),
        adjusterEstimateTotal: toNumber(comparison.adjusterEstimateTotal),
        totalGap: toNumber(comparison.totalGap),
        matchCount: comparison.matchCount,
        modifiedCount: comparison.modifiedCount,
        missingCount: comparison.missingCount,
        addedCount: comparison.addedCount,
      },
      zones: allZones,
    },
    { status: 200 }
  );
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const appUser = await prisma.user.findUnique({ where: { clerkId } });
  if (!appUser) {
    return NextResponse.json({ error: 'User not synced.' }, { status: 409 });
  }

  const { id: comparisonId } = await context.params;

  const comparison = await prisma.comparison.findUnique({
    where: { id: comparisonId },
    select: {
      id: true,
      userId: true,
      yourEstimateStoragePath: true,
      adjusterEstimateStoragePath: true,
    },
  });

  if (!comparison) {
    return NextResponse.json({ error: 'Comparison not found.' }, { status: 404 });
  }

  if (comparison.userId !== appUser.id) {
    return NextResponse.json({ error: 'Forbidden.' }, { status: 403 });
  }

  // Remove uploaded PDFs from Supabase storage
  const storagePaths = [
    comparison.yourEstimateStoragePath,
    comparison.adjusterEstimateStoragePath,
  ].filter(Boolean);

  if (storagePaths.length > 0) {
    const { error: storageError } = await supabaseAdmin.storage
      .from(ESTIMATES_BUCKET)
      .remove(storagePaths);

    if (storageError) {
      console.error(`Failed to remove storage files for comparison ${comparisonId}:`, storageError);
    }
  }

  // Cascade-delete comparison + line items
  await prisma.comparison.delete({ where: { id: comparisonId } });

  return NextResponse.json({ ok: true }, { status: 200 });
}
