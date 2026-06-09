import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import prisma from '@/lib/prisma';
import type { MatchStatus } from '@/app/generated/prisma/client';

type RouteContext = { params: Promise<{ id: string }> };

function recalculateMatchStatus(r: {
  matchStatus: string;
  descriptionYours: string | null;
  descriptionAdjuster: string | null;
  totalYours: number | null;
  totalAdjuster: number | null;
}): MatchStatus {
  const hasYours = r.totalYours !== null || !!(r.descriptionYours?.trim());
  const hasAdjuster = r.totalAdjuster !== null || !!(r.descriptionAdjuster?.trim());

  // When both sides are blank, mark as unverified (was keeping stale status - #23 fix)
  if (!hasYours && !hasAdjuster) return 'MATCH_UNVERIFIED';
  if (hasYours && !hasAdjuster) return 'MISSING_FROM_ADJUSTER';
  if (!hasYours && hasAdjuster) return 'ADDED_BY_ADJUSTER';

  if (r.totalYours === null || r.totalAdjuster === null) return 'MATCH_UNVERIFIED';
  const diff = Math.abs(r.totalYours - r.totalAdjuster);
  return diff < 0.01 ? 'MATCH' : 'MODIFIED';
}

function toN(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

type InlineEditItem = {
  itemId: string;
  fields: {
    descriptionYours?: string | null;
    descriptionAdjuster?: string | null;
    qtyYours?: string | null;
    qtyAdjuster?: string | null;
    removeYours?: number | null;
    removeAdjuster?: number | null;
    replaceYours?: number | null;
    replaceAdjuster?: number | null;
    taxYours?: number | null;
    taxAdjuster?: number | null;
    opYours?: number | null;
    opAdjuster?: number | null;
    totalYours?: number | null;
    totalAdjuster?: number | null;
  };
};

type InlineInsert = {
  insertBeforeItemId: string;
  zoneCanonical: string;
  zoneYours: string | null;
  zoneAdjuster: string | null;
  fields: InlineEditItem['fields'];
};

/**
 * POST — Apply manual (non-AI) inline row edits and create a new version.
 *
 * Body: { edits: InlineEditItem[] }
 *
 * 1. Load the active version's line items (or canonical line_items if no version exists).
 * 2. Apply field overrides per itemId.
 * 3. Create a new ComparisonVersion, mark it active.
 */
export async function POST(request: Request, context: RouteContext) {
  const { userId: clerkId } = await auth();
  if (!clerkId) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const appUser = await prisma.user.findUnique({ where: { clerkId } });
  if (!appUser) return NextResponse.json({ error: 'User not synced.' }, { status: 409 });

  const { id: comparisonId } = await context.params;

  const body = await request.json().catch(() => null);
  const inlineEdits: InlineEditItem[] = Array.isArray(body?.edits) ? body.edits : [];
  const inlineInserts: InlineInsert[] = Array.isArray(body?.inserts) ? body.inserts : [];
  type ZoneRename = { oldCanonical: string; newCanonical: string };
  const zoneRenames: ZoneRename[] = Array.isArray(body?.zoneRenames)
    ? (body.zoneRenames as unknown[]).filter(
        (r): r is ZoneRename =>
          typeof r === 'object' && r !== null &&
          typeof (r as ZoneRename).oldCanonical === 'string' &&
          typeof (r as ZoneRename).newCanonical === 'string'
      )
    : [];
  type ZoneAdjusterRename = { canonical: string; newAdjusterName: string };
  const zoneAdjusterRenames: ZoneAdjusterRename[] = Array.isArray(body?.zoneAdjusterRenames)
    ? (body.zoneAdjusterRenames as unknown[]).filter(
        (r): r is ZoneAdjusterRename =>
          typeof r === 'object' && r !== null &&
          typeof (r as ZoneAdjusterRename).canonical === 'string' &&
          typeof (r as ZoneAdjusterRename).newAdjusterName === 'string'
      )
    : [];
  type ZoneMove = { itemId: string; targetZoneId: string };
  const zoneMoves: ZoneMove[] = Array.isArray(body?.zoneMoves)
    ? (body.zoneMoves as unknown[]).filter(
        (r): r is ZoneMove =>
          typeof r === 'object' && r !== null &&
          typeof (r as ZoneMove).itemId === 'string' &&
          typeof (r as ZoneMove).targetZoneId === 'string'
      )
    : [];
  const hasDeletions = Array.isArray(body?.deletions) && body.deletions.length > 0;
  if (!body || (inlineEdits.length === 0 && inlineInserts.length === 0 && zoneRenames.length === 0 && zoneAdjusterRenames.length === 0 && zoneMoves.length === 0 && !hasDeletions)) {
    return NextResponse.json({ error: 'A non-empty "edits", "inserts", "zoneRenames", "zoneAdjusterRenames", or "deletions" array is required.' }, { status: 400 });
  }

  const comparison = await prisma.comparison.findFirst({
    where: { id: comparisonId, userId: appUser.id, status: 'COMPLETED' },
    select: { id: true },
  });
  if (!comparison) {
    return NextResponse.json({ error: 'Completed comparison not found.' }, { status: 404 });
  }

  // Load source rows from active version or fall back to canonical line_items
  const activeVersion = await prisma.comparisonVersion.findFirst({
    where: { comparisonId, isActive: true },
    select: { id: true, lineItems: { orderBy: { sortOrder: 'asc' } } },
  });

  type SourceRow = {
    itemId: string;
    originalLineItemId: string | null;
    matchStatus: string;
    zoneYours: string | null;
    zoneAdjuster: string | null;
    zoneCanonical: string | null;
    zoneConfidence: number | null;
    descriptionYours: string | null;
    descriptionAdjuster: string | null;
    qtyYours: string | null;
    qtyAdjuster: string | null;
    removeYours: number | null; removeAdjuster: number | null;
    replaceYours: number | null; replaceAdjuster: number | null;
    resetYours: number | null; resetAdjuster: number | null;
    taxYours: number | null; taxAdjuster: number | null;
    opYours: number | null; opAdjuster: number | null;
    totalYours: number | null; totalAdjuster: number | null;
    diffAmount: number | null;
    category: string | null;
    sortOrder: number;
  };

  let sourceRows: SourceRow[];

  if (activeVersion) {
    sourceRows = activeVersion.lineItems.map((li) => ({
      itemId: li.id,
      originalLineItemId: li.originalLineItemId,
      matchStatus: li.matchStatus,
      zoneYours: li.zoneYours,
      zoneAdjuster: li.zoneAdjuster,
      zoneCanonical: li.zoneCanonical,
      zoneConfidence: li.zoneConfidence !== null ? Number(li.zoneConfidence) : null,
      descriptionYours: li.descriptionYours,
      descriptionAdjuster: li.descriptionAdjuster,
      qtyYours: li.qtyYours,
      qtyAdjuster: li.qtyAdjuster,
      removeYours: toN(li.removeYours), removeAdjuster: toN(li.removeAdjuster),
      replaceYours: toN(li.replaceYours), replaceAdjuster: toN(li.replaceAdjuster),
      resetYours: toN(li.resetYours), resetAdjuster: toN(li.resetAdjuster),
      taxYours: toN(li.taxYours), taxAdjuster: toN(li.taxAdjuster),
      opYours: toN(li.opYours), opAdjuster: toN(li.opAdjuster),
      totalYours: toN(li.totalYours), totalAdjuster: toN(li.totalAdjuster),
      diffAmount: toN(li.diffAmount),
      category: li.category,
      sortOrder: li.sortOrder,
    }));
  } else {
    const lineItems = await prisma.lineItem.findMany({
      where: { comparisonId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    sourceRows = lineItems.map((li) => ({
      itemId: li.id,
      originalLineItemId: li.id,
      matchStatus: li.matchStatus,
      zoneYours: li.zoneYours,
      zoneAdjuster: li.zoneAdjuster,
      zoneCanonical: li.zoneCanonical,
      zoneConfidence: li.zoneConfidence !== null ? Number(li.zoneConfidence) : null,
      descriptionYours: li.descriptionYours,
      descriptionAdjuster: li.descriptionAdjuster,
      qtyYours: li.qtyYours,
      qtyAdjuster: li.qtyAdjuster,
      removeYours: toN(li.removeYours), removeAdjuster: toN(li.removeAdjuster),
      replaceYours: toN(li.replaceYours), replaceAdjuster: toN(li.replaceAdjuster),
      resetYours: toN(li.resetYours), resetAdjuster: toN(li.resetAdjuster),
      taxYours: toN(li.taxYours), taxAdjuster: toN(li.taxAdjuster),
      opYours: toN(li.opYours), opAdjuster: toN(li.opAdjuster),
      totalYours: toN(li.totalYours), totalAdjuster: toN(li.totalAdjuster),
      diffAmount: toN(li.diffAmount),
      category: li.category,
      sortOrder: li.sortOrder,
    }));
  }

  if (sourceRows.length === 0) {
    return NextResponse.json({ error: 'No line items found.' }, { status: 400 });
  }

  // Build edit map: itemId -> fields (also index by originalLineItemId for version items)
  const editMap = new Map<string, InlineEditItem['fields']>();
  for (const edit of inlineEdits) {
    editMap.set(edit.itemId, edit.fields);
  }

  // Apply edits to source rows
  let appliedEditCount = 0;
  const newRows = sourceRows.map((r) => {
    const overrides = editMap.get(r.itemId)
      ?? (r.originalLineItemId ? editMap.get(r.originalLineItemId) : undefined);
    if (!overrides) return { ...r };
    appliedEditCount++;

    const updated = { ...r };
    if (overrides.descriptionYours !== undefined) updated.descriptionYours = overrides.descriptionYours;
    if (overrides.descriptionAdjuster !== undefined) updated.descriptionAdjuster = overrides.descriptionAdjuster;
    if (overrides.qtyYours !== undefined) updated.qtyYours = overrides.qtyYours;
    if (overrides.qtyAdjuster !== undefined) updated.qtyAdjuster = overrides.qtyAdjuster;
    if (overrides.removeYours !== undefined) updated.removeYours = toN(overrides.removeYours);
    if (overrides.removeAdjuster !== undefined) updated.removeAdjuster = toN(overrides.removeAdjuster);
    if (overrides.replaceYours !== undefined) updated.replaceYours = toN(overrides.replaceYours);
    if (overrides.replaceAdjuster !== undefined) updated.replaceAdjuster = toN(overrides.replaceAdjuster);
    if (overrides.taxYours !== undefined) updated.taxYours = toN(overrides.taxYours);
    if (overrides.taxAdjuster !== undefined) updated.taxAdjuster = toN(overrides.taxAdjuster);
    if (overrides.opYours !== undefined) updated.opYours = toN(overrides.opYours);
    if (overrides.opAdjuster !== undefined) updated.opAdjuster = toN(overrides.opAdjuster);
    if (overrides.totalYours !== undefined) updated.totalYours = toN(overrides.totalYours);
    if (overrides.totalAdjuster !== undefined) updated.totalAdjuster = toN(overrides.totalAdjuster);

    // Recalculate diff
    updated.diffAmount =
      updated.totalYours !== null && updated.totalAdjuster !== null
        ? +(updated.totalYours - updated.totalAdjuster).toFixed(2)
        : null;

    // Recalculate match status based on updated field values
    updated.matchStatus = recalculateMatchStatus(updated);

    return updated;
  });

  // Apply inserts: splice new rows at the correct positions, then renormalize sortOrders
  for (const ins of inlineInserts) {
    const idx = newRows.findIndex(r => r.itemId === ins.insertBeforeItemId || r.originalLineItemId === ins.insertBeforeItemId);
    const pos = idx >= 0 ? idx : newRows.length;
    const newRow: SourceRow = {
      itemId: `__inserted__${Math.random().toString(36).slice(2)}`,
      originalLineItemId: null,
      matchStatus: 'MISSING_FROM_ADJUSTER',
      zoneYours: ins.zoneYours,
      zoneAdjuster: ins.zoneAdjuster,
      zoneCanonical: ins.zoneCanonical,
      zoneConfidence: null,
      descriptionYours: ins.fields.descriptionYours ?? null,
      descriptionAdjuster: ins.fields.descriptionAdjuster ?? null,
      qtyYours: ins.fields.qtyYours ?? null,
      qtyAdjuster: ins.fields.qtyAdjuster ?? null,
      removeYours: toN(ins.fields.removeYours), removeAdjuster: toN(ins.fields.removeAdjuster),
      replaceYours: toN(ins.fields.replaceYours), replaceAdjuster: toN(ins.fields.replaceAdjuster),
      resetYours: null, resetAdjuster: null,
      taxYours: toN(ins.fields.taxYours), taxAdjuster: toN(ins.fields.taxAdjuster),
      opYours: toN(ins.fields.opYours), opAdjuster: toN(ins.fields.opAdjuster),
      totalYours: toN(ins.fields.totalYours), totalAdjuster: toN(ins.fields.totalAdjuster),
      diffAmount: null,
      category: null,
      sortOrder: 0,
    };
    newRow.matchStatus = recalculateMatchStatus(newRow);
    newRow.diffAmount =
      newRow.totalYours !== null && newRow.totalAdjuster !== null
        ? +(newRow.totalYours - newRow.totalAdjuster).toFixed(2)
        : null;
    newRows.splice(pos, 0, newRow);
  }
  // Apply deletions: remove rows whose itemId (or originalLineItemId) is in the deletions list
  const deletionSet = new Set<string>(Array.isArray(body.deletions) ? body.deletions : []);
  if (deletionSet.size > 0) {
    for (let i = newRows.length - 1; i >= 0; i--) {
      const r = newRows[i];
      if (deletionSet.has(r.itemId) || (r.originalLineItemId && deletionSet.has(r.originalLineItemId))) {
        newRows.splice(i, 1);
      }
    }
  }

  // Apply zone renames: update zoneCanonical for all rows belonging to a renamed zone
  if (zoneRenames.length > 0) {
    const renameMap = new Map<string, string>(zoneRenames.map(r => [r.oldCanonical, r.newCanonical]));
    for (const r of newRows) {
      if (r.zoneCanonical && renameMap.has(r.zoneCanonical)) {
        r.zoneCanonical = renameMap.get(r.zoneCanonical)!;
      }
    }
  }

  // Apply adjuster zone renames: update zoneAdjuster for all rows belonging to a zone
  if (zoneAdjusterRenames.length > 0) {
    const adjRenameMap = new Map<string, string>(zoneAdjusterRenames.map(r => [r.canonical, r.newAdjusterName]));
    for (const r of newRows) {
      if (r.zoneCanonical && adjRenameMap.has(r.zoneCanonical)) {
        r.zoneAdjuster = adjRenameMap.get(r.zoneCanonical)!;
      }
    }
  }

  // Apply zone moves: update zone fields for moved rows and reorder them to end of target zone
  if (zoneMoves.length > 0) {
    function toZoneSlug(s: string): string { return s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-'); }
    const zoneMoveMap = new Map<string, string>(zoneMoves.map(m => [m.itemId, m.targetZoneId]));
    // Build slug → zone info map (matches frontend zone.id derivation via toZoneId)
    const zoneInfoBySlug = new Map<string, { zoneYours: string | null; zoneAdjuster: string | null; zoneCanonical: string }>();
    for (const r of newRows) {
      if (r.zoneCanonical) {
        const slug = toZoneSlug(r.zoneCanonical);
        if (!zoneInfoBySlug.has(slug)) {
          zoneInfoBySlug.set(slug, { zoneYours: r.zoneYours, zoneAdjuster: r.zoneAdjuster, zoneCanonical: r.zoneCanonical });
        }
      }
    }
    const movedItemIds = new Set(zoneMoveMap.keys());
    const movedRows: SourceRow[] = [];
    for (let i = newRows.length - 1; i >= 0; i--) {
      const r = newRows[i];
      const matchId = movedItemIds.has(r.itemId) ? r.itemId : (r.originalLineItemId && movedItemIds.has(r.originalLineItemId) ? r.originalLineItemId : null);
      if (matchId) {
        const targetZoneId = zoneMoveMap.get(matchId)!;
        const targetZoneInfo = zoneInfoBySlug.get(targetZoneId);
        if (targetZoneInfo) {
          const updated = { ...r, zoneCanonical: targetZoneInfo.zoneCanonical, zoneYours: targetZoneInfo.zoneYours, zoneAdjuster: targetZoneInfo.zoneAdjuster };
          newRows.splice(i, 1);
          movedRows.unshift(updated);
        }
      }
    }
    // Group moved rows by target zone canonical and append them to the end of each target zone block
    for (const moved of movedRows) {
      // Find the last row with this zoneCanonical
      let insertIdx = -1;
      for (let i = newRows.length - 1; i >= 0; i--) {
        if (newRows[i].zoneCanonical === moved.zoneCanonical) { insertIdx = i + 1; break; }
      }
      if (insertIdx >= 0) {
        newRows.splice(insertIdx, 0, moved);
      } else {
        newRows.push(moved);
      }
    }
  }

  newRows.forEach((r, i) => { r.sortOrder = i; });

  if (inlineEdits.length > 0 && appliedEditCount === 0 && inlineInserts.length === 0 && deletionSet.size === 0 && zoneRenames.length === 0 && zoneAdjusterRenames.length === 0) {
    return NextResponse.json(
      { error: 'No edits matched any current line item. Reload the page and try again.' },
      { status: 409 }
    );
  }

  // Determine next version number
  const maxVersion = await prisma.comparisonVersion.aggregate({
    where: { comparisonId },
    _max: { versionNumber: true },
  });
  const nextVersionNumber = (maxVersion._max.versionNumber ?? 0) + 1;

  const editCount = inlineEdits.length + inlineInserts.length + deletionSet.size + zoneRenames.length + zoneAdjusterRenames.length + zoneMoves.length;

  const version = await prisma.$transaction(async (tx) => {
    await tx.comparisonVersion.updateMany({
      where: { comparisonId, isActive: true },
      data: { isActive: false },
    });

    const ver = await tx.comparisonVersion.create({
      data: {
        comparisonId,
        versionNumber: nextVersionNumber,
        label: `Manual edit — ${editCount} row${editCount !== 1 ? 's' : ''}`,
        isActive: true,
      },
    });

    if (newRows.length > 0) {
      await tx.comparisonVersionLineItem.createMany({
        data: newRows.map((r) => ({
          versionId: ver.id,
          originalLineItemId: r.originalLineItemId,
          matchStatus: r.matchStatus as MatchStatus,
          zoneYours: r.zoneYours,
          zoneAdjuster: r.zoneAdjuster,
          zoneCanonical: r.zoneCanonical,
          zoneConfidence: r.zoneConfidence,
          descriptionYours: r.descriptionYours,
          descriptionAdjuster: r.descriptionAdjuster,
          qtyYours: r.qtyYours,
          qtyAdjuster: r.qtyAdjuster,
          removeYours: r.removeYours,
          removeAdjuster: r.removeAdjuster,
          replaceYours: r.replaceYours,
          replaceAdjuster: r.replaceAdjuster,
          resetYours: r.resetYours,
          resetAdjuster: r.resetAdjuster,
          taxYours: r.taxYours,
          taxAdjuster: r.taxAdjuster,
          opYours: r.opYours,
          opAdjuster: r.opAdjuster,
          totalYours: r.totalYours,
          totalAdjuster: r.totalAdjuster,
          diffAmount: r.diffAmount,
          category: r.category,
          sortOrder: r.sortOrder,
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
        isActive: true,
        createdAt: version.createdAt,
      },
      editsApplied: editCount,
    },
    { status: 201 }
  );
}
