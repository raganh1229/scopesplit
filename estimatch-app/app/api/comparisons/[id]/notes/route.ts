import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import prisma from '@/lib/prisma';

type RouteContext = {
  params: Promise<{ id: string }>;
};

// ── GET all notes for a comparison ──
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { userId: clerkId } = await auth();
    if (!clerkId) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    const appUser = await prisma.user.findUnique({ where: { clerkId } });
    if (!appUser) {
      return NextResponse.json({ error: 'User not synced.' }, { status: 409 });
    }

    const { id } = await context.params;

    const comparison = await prisma.comparison.findFirst({
      where: { id, userId: appUser.id },
      select: { id: true },
    });
    if (!comparison) {
      return NextResponse.json({ error: 'Comparison not found.' }, { status: 404 });
    }

    const notes = await prisma.comparisonNote.findMany({
      where: { comparisonId: id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        lineItemId: true,
        versionLineItemId: true,
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
        versionLineItem: {
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

    return NextResponse.json({ notes }, { status: 200 });
  } catch (error) {
    console.error('Failed to load notes:', error);
    const details = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      {
        error:
          process.env.NODE_ENV === 'production'
            ? 'Unable to load notes. Please try again or contact support if the issue persists.'
            : `Unable to load notes: ${details}`,
      },
      { status: 500 }
    );
  }
}

// ── POST create a new note ──
export async function POST(request: Request, context: RouteContext) {
  try {
    const { userId: clerkId } = await auth();
    if (!clerkId) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    const appUser = await prisma.user.findUnique({ where: { clerkId } });
    if (!appUser) {
      return NextResponse.json({ error: 'User not synced.' }, { status: 409 });
    }

    const { id } = await context.params;

    const comparison = await prisma.comparison.findFirst({
      where: { id, userId: appUser.id },
      select: { id: true },
    });
    if (!comparison) {
      return NextResponse.json({ error: 'Comparison not found.' }, { status: 404 });
    }

    let body: { content?: string; lineItemId?: string | null; versionLineItemId?: string | null };
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

    const noteCount = await prisma.comparisonNote.count({ where: { comparisonId: id } });
    if (noteCount >= 500) {
      return NextResponse.json({ error: 'Note limit reached for this comparison (500 max).' }, { status: 422 });
    }

    let lineItemId = body.lineItemId ?? null;
    let versionLineItemId: string | null = null;

    if (lineItemId) {
      if (lineItemId.startsWith('__new__')) {
        return NextResponse.json(
          { error: 'Save as a new version before adding a note to this item.' },
          { status: 400 }
        );
      }
      const lineItem = await prisma.lineItem.findFirst({
        where: { id: lineItemId, comparisonId: id },
        select: { id: true },
      });
      if (!lineItem) {
        // The ID may be a ComparisonVersionLineItem.id (when a version is active).
        const vli = await prisma.comparisonVersionLineItem.findFirst({
          where: { id: lineItemId, version: { comparisonId: id } },
          select: { id: true, originalLineItemId: true },
        });
        if (vli?.originalLineItemId) {
          // Modified existing item — resolve to canonical lineItem
          lineItemId = vli.originalLineItemId;
        } else if (vli) {
          // Inserted item with no canonical parent — store as versionLineItemId
          versionLineItemId = vli.id;
          lineItemId = null;
        } else {
          return NextResponse.json({ error: 'Line item not found in this comparison.' }, { status: 400 });
        }
      }
    }

    const note = await prisma.comparisonNote.create({
      data: {
        comparisonId: id,
        lineItemId,
        versionLineItemId,
        userId: appUser.id,
        content,
      },
      select: {
        id: true,
        lineItemId: true,
        versionLineItemId: true,
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
        versionLineItem: {
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

    return NextResponse.json({ note }, { status: 201 });
  } catch (error) {
    console.error('Failed to create note:', error);
    const details = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      {
        error:
          process.env.NODE_ENV === 'production'
            ? 'Unable to save note. Please try again or contact support if the issue persists.'
            : `Unable to save note: ${details}`,
      },
      { status: 500 }
    );
  }
}
