import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import prisma from '@/lib/prisma';
import { supabaseAdmin } from '@/lib/supabase';

const ESTIMATES_BUCKET = 'estimates';

type RouteContext = {
  params: Promise<{ id: string }>;
};

function resolveEstimateSide(value: string | null): 'your' | 'adjuster' | null {
  if (value === 'your' || value === 'adjuster') return value;
  return null;
}

function toAttachmentFilename(filename: string): string {
  const normalized = filename.trim().length > 0 ? filename.trim() : 'estimate.pdf';
  return normalized.toLowerCase().endsWith('.pdf') ? normalized : `${normalized}.pdf`;
}

function buildContentDisposition(filename: string): string {
  const safeAscii = filename.replace(/[^\x20-\x7E]+/g, '_').replace(/"/g, '');
  const encodedUtf8 = encodeURIComponent(filename);
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodedUtf8}`;
}

export async function GET(request: Request, context: RouteContext) {
  const { userId: clerkId } = await auth();

  if (!clerkId) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const side = resolveEstimateSide(new URL(request.url).searchParams.get('side'));
  if (!side) {
    return NextResponse.json({ error: 'Invalid estimate side.' }, { status: 400 });
  }

  const appUser = await prisma.user.findUnique({ where: { clerkId }, select: { id: true } });
  if (!appUser) {
    return NextResponse.json({ error: 'User not synced.' }, { status: 409 });
  }

  const { id: comparisonId } = await context.params;

  const comparison = await prisma.comparison.findFirst({
    where: {
      id: comparisonId,
      userId: appUser.id,
    },
    select: {
      yourEstimateFilename: true,
      yourEstimateStoragePath: true,
      adjusterEstimateFilename: true,
      adjusterEstimateStoragePath: true,
    },
  });

  if (!comparison) {
    return NextResponse.json({ error: 'Comparison not found.' }, { status: 404 });
  }

  const storagePath = side === 'your'
    ? comparison.yourEstimateStoragePath
    : comparison.adjusterEstimateStoragePath;
  const filename = side === 'your'
    ? comparison.yourEstimateFilename
    : comparison.adjusterEstimateFilename;

  const { data, error } = await supabaseAdmin.storage
    .from(ESTIMATES_BUCKET)
    .download(storagePath);

  if (error || !data) {
    return NextResponse.json({ error: 'Failed to download estimate PDF.' }, { status: 502 });
  }

  const arrayBuffer = await data.arrayBuffer();
  const attachmentName = toAttachmentFilename(filename);

  return new NextResponse(arrayBuffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': buildContentDisposition(attachmentName),
      'Cache-Control': 'private, no-store, max-age=0',
    },
  });
}
