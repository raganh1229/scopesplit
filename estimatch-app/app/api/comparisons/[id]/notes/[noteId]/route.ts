import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import prisma from '@/lib/prisma';

type RouteContext = {
  params: Promise<{ id: string; noteId: string }>;
};

// ── PATCH update a note ──
export async function PATCH(request: Request, context: RouteContext) {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const appUser = await prisma.user.findUnique({ where: { clerkId } });
  if (!appUser) {
    return NextResponse.json({ error: 'User not synced.' }, { status: 409 });
  }

  const { id, noteId } = await context.params;

  // Verify comparison ownership
  const comparison = await prisma.comparison.findFirst({
    where: { id, userId: appUser.id },
    select: { id: true },
  });
  if (!comparison) {
    return NextResponse.json({ error: 'Comparison not found.' }, { status: 404 });
  }

  // Verify note exists and belongs to this comparison + user
  const existing = await prisma.comparisonNote.findFirst({
    where: { id: noteId, comparisonId: id, userId: appUser.id },
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json({ error: 'Note not found.' }, { status: 404 });
  }

  let body: { content?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 });
  }

  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content || content.length === 0) {
    return NextResponse.json({ error: 'Content is required.' }, { status: 400 });
  }
  if (content.length > 2000) {
    return NextResponse.json({ error: 'Content must be 2000 characters or less.' }, { status: 400 });
  }

  const note = await prisma.comparisonNote.update({
    where: { id: noteId },
    data: { content },
    select: {
      id: true,
      lineItemId: true,
      content: true,
      createdAt: true,
      updatedAt: true,
      lineItem: {
        select: {
          id: true,
          sortOrder: true,
          descriptionYours: true,
          descriptionAdjuster: true,
          zoneCanonical: true,
        },
      },
    },
  });

  return NextResponse.json({ note }, { status: 200 });
}

// ── DELETE a note ──
export async function DELETE(_request: Request, context: RouteContext) {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const appUser = await prisma.user.findUnique({ where: { clerkId } });
  if (!appUser) {
    return NextResponse.json({ error: 'User not synced.' }, { status: 409 });
  }

  const { id, noteId } = await context.params;

  const comparison = await prisma.comparison.findFirst({
    where: { id, userId: appUser.id },
    select: { id: true },
  });
  if (!comparison) {
    return NextResponse.json({ error: 'Comparison not found.' }, { status: 404 });
  }

  const existing = await prisma.comparisonNote.findFirst({
    where: { id: noteId, comparisonId: id, userId: appUser.id },
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json({ error: 'Note not found.' }, { status: 404 });
  }

  await prisma.comparisonNote.delete({ where: { id: noteId } });

  return NextResponse.json({ deleted: true }, { status: 200 });
}
