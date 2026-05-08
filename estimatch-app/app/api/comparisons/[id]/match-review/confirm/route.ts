// ─────────────────────────────────────────────────────────────────────────────
// POST /api/comparisons/[id]/match-review/confirm
//
// Accepts the user's (possibly adjusted) zone-pair arrangement, rebuilds the
// n2:zones_matched payload with user-confirmed pairings, flips status to
// PROCESSING, and fires the comparison/match-review.completed Inngest event
// to resume the pipeline into Step 4 (extract-and-match).
//
// Request body:
//   {
//     e1Slots: (string | null)[],  // ordered E1 zone names; null = blank row
//     e2Slots: (string | null)[]   // same length; same index = paired
//   }
//
// Idempotent: safe to call even if no adjustments were made.
// Auth: Clerk + DB ownership check.
// ─────────────────────────────────────────────────────────────────────────────

import { auth } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { inngest } from '@/lib/inngest/client';
import { readZonesMatched, writeN2Stage, N2_STAGE_ZONES_MATCHED } from '@/lib/n2/utils/n2-state';
import type { N2ZonesMatchedPayload, N2ZoneRef } from '@/lib/n2/schemas/types';

type ConfirmBody = {
  e1Slots: (string | null)[];
  e2Slots: (string | null)[];
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: comparisonId } = await params;

  const dbUser = await prisma.user.findUnique({
    where: { clerkId: userId },
    select: { id: true },
  });
  if (!dbUser) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const comparison = await prisma.comparison.findUnique({
    where: { id: comparisonId },
    select: { userId: true, status: true },
  });
  if (!comparison) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (comparison.userId !== dbUser.id)
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  if (comparison.status !== 'AWAITING_MATCH_REVIEW') {
    return NextResponse.json({ ok: true, skipped: true, reason: 'not-awaiting-match-review' });
  }

  // ── Read existing zones_matched for zone metadata ──────────────────────
  const existing = await readZonesMatched(comparisonId);
  if (!existing) {
    return NextResponse.json({ error: 'Match state not found' }, { status: 500 });
  }

  // ── Parse request body ────────────────────────────────────────────────
  let body: ConfirmBody;
  try {
    body = (await request.json()) as ConfirmBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { e1Slots, e2Slots } = body;
  if (!Array.isArray(e1Slots) || !Array.isArray(e2Slots) || e1Slots.length !== e2Slots.length) {
    return NextResponse.json(
      { error: 'e1Slots and e2Slots must be arrays of equal length' },
      { status: 400 },
    );
  }

  // ── Build reverse-lookup maps: zone name → N2ZoneRef ──────────────────
  // Metadata keyed by zoneKey(name, startPage); build name-only index.
  const e1RefByName = new Map<string, N2ZoneRef>();
  const e2RefByName = new Map<string, N2ZoneRef>();

  for (const [key, meta] of Object.entries(existing.e1ZoneMeta)) {
    const name = key.replace(/_p\d+$/, '');
    e1RefByName.set(name, { zone: name, pages: [meta.startPage, meta.endPage] });
  }
  for (const [key, meta] of Object.entries(existing.e2ZoneMeta)) {
    const name = key.replace(/_p\d+$/, '');
    e2RefByName.set(name, { zone: name, pages: [meta.startPage, meta.endPage] });
  }

  // ── Build original confidence lookup ──────────────────────────────────
  // Key: "e1ZoneName|e2ZoneName" (using first zone in each side for merged pairs)
  const confidenceMap = new Map<string, number>();
  for (const pair of existing.matched) {
    const k = `${pair.e1Zones[0]?.zone ?? ''}|${pair.e2Zones[0]?.zone ?? ''}`;
    confidenceMap.set(k, pair.confidence);
  }

  // ── Reconstruct matched/unmatched from user's slot arrangement ─────────
  const userMatched: N2ZonesMatchedPayload['matched'] = [];
  const userUnmatchedE1: N2ZoneRef[] = [];
  const userUnmatchedE2: N2ZoneRef[] = [];

  const rowCount = e1Slots.length;
  for (let i = 0; i < rowCount; i++) {
    const e1Name = e1Slots[i];
    const e2Name = e2Slots[i];

    if (e1Name && e2Name) {
      // Split " + "-joined names back into individual zone refs (handles merged zones)
      const e1Names = e1Name.split(' + ').map(n => n.trim()).filter(Boolean);
      const e2Names = e2Name.split(' + ').map(n => n.trim()).filter(Boolean);
      const e1Refs = e1Names.map(n => e1RefByName.get(n) ?? { zone: n, pages: [0, 0] as [number, number] });
      const e2Refs = e2Names.map(n => e2RefByName.get(n) ?? { zone: n, pages: [0, 0] as [number, number] });
      const confKey = `${e1Names[0] ?? e1Name}|${e2Names[0] ?? e2Name}`;
      const confidence = confidenceMap.get(confKey) ?? 75;
      userMatched.push({
        e1Zones: e1Refs,
        e2Zones: e2Refs,
        canonical: e1Names[0] ?? e1Name,
        isMerged: e1Names.length > 1 || e2Names.length > 1,
        confidence,
      });
    } else if (e1Name && !e2Name) {
      const e1Names = e1Name.split(' + ').map(n => n.trim()).filter(Boolean);
      for (const n of e1Names) {
        userUnmatchedE1.push(e1RefByName.get(n) ?? { zone: n, pages: [0, 0] as [number, number] });
      }
    } else if (!e1Name && e2Name) {
      const e2Names = e2Name.split(' + ').map(n => n.trim()).filter(Boolean);
      for (const n of e2Names) {
        userUnmatchedE2.push(e2RefByName.get(n) ?? { zone: n, pages: [0, 0] as [number, number] });
      }
    }
    // both null → blank filler row, skip
  }

  // ── Build updated payload ─────────────────────────────────────────────
  const updatedPayload: N2ZonesMatchedPayload = {
    matched: userMatched,
    unmatchedE1: userUnmatchedE1,
    unmatchedE2: userUnmatchedE2,
    e1Format: existing.e1Format,
    e2Format: existing.e2Format,
    routingDecision: existing.routingDecision,
    e1ZoneMeta: existing.e1ZoneMeta,
    e2ZoneMeta: existing.e2ZoneMeta,
  };

  await writeN2Stage(comparisonId, N2_STAGE_ZONES_MATCHED, updatedPayload);

  // ── Flip status and fire Inngest event ────────────────────────────────
  await prisma.comparison.update({
    where: { id: comparisonId },
    data: { status: 'PROCESSING' },
  });

  await inngest.send({
    name: 'comparison/match-review.completed',
    data: { comparisonId },
  });

  return NextResponse.json({ ok: true, skipped: false });
}

// Re-export GET to generate a proper 405 for unsupported methods
export const dynamic = 'force-dynamic';
