import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import prisma from '@/lib/prisma';
import { MatchStatus } from '@/app/generated/prisma/client';

type RouteContext = {
  params: Promise<{ id: string; versionId: string }>;
};

type UiRowStatus = 'match' | 'modified' | 'missing' | 'added';

function toNumber(value: number | bigint | { toString(): string } | null): number | null {
  if (value === null) return null;
  return Number(value);
}

function mapMatchStatus(status: MatchStatus): UiRowStatus {
  if (status === MatchStatus.MATCH) return 'match';
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

/**
 * GET — fetch a version's line items formatted identically to the main comparison GET,
 *       so the UI can swap them in without any transformation.
 */
export async function GET(_request: Request, context: RouteContext) {
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
    select: {
      id: true,
      versionNumber: true,
      label: true,
      editPrompt: true,
      isActive: true,
      createdAt: true,
      lineItems: {
        orderBy: { sortOrder: 'asc' },
      },
    },
  });

  if (!version) return NextResponse.json({ error: 'Version not found.' }, { status: 404 });

  // Build zone-grouped structure identical to the main comparison GET
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

  for (const item of version.lineItems) {
    const canonicalZone = item.zoneCanonical ?? item.zoneYours ?? item.zoneAdjuster ?? 'General';
    const zoneId = toZoneId(canonicalZone);

    if (!zoneMap.has(zoneId)) {
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
    if (!zone.yourName && item.zoneYours && item.zoneYours !== '__UNZONED__') {
      zone.yourName = item.zoneYours;
    }
    if (!zone.adjusterName && item.zoneAdjuster && item.zoneAdjuster !== '__UNZONED__') {
      zone.adjusterName = item.zoneAdjuster;
    }
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

  const allZones = Array.from(zoneMap.values());

  // Sort zones identically to the main comparison GET route
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
    const aUnzoned = isUnzoned(a) ? 1 : 0;
    const bUnzoned = isUnzoned(b) ? 1 : 0;
    if (aUnzoned !== bUnzoned) return aUnzoned - bUnzoned;
    const aBoth = hasBothSides(a) ? 0 : 1;
    const bBoth = hasBothSides(b) ? 0 : 1;
    if (aBoth !== bBoth) return aBoth - bBoth;
    return getZoneGap(b) - getZoneGap(a);
  });

  return NextResponse.json(
    {
      version: {
        id: version.id,
        versionNumber: version.versionNumber,
        label: version.label,
        editPrompt: version.editPrompt,
        isActive: version.isActive,
        createdAt: version.createdAt,
      },
      zones: allZones,
    },
    { status: 200 }
  );
}
