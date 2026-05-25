import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { SubscriptionTier } from '@/app/generated/prisma/client';
import prisma from '@/lib/prisma';
import { supabaseAdmin } from '@/lib/supabase';
import { inngest } from '@/lib/inngest/client';
import { isN3Eligible } from '@/lib/n3/n3-routing';
import { isN4Enabled } from '@/lib/n4/n4-routing';
import { PLAN_COMPARISON_LIMITS } from '@/lib/stripe';

// Vercel serverless runtime cap. This POST handler uploads files and triggers
// downstream processing, so we lift the default (10s on Hobby / 15s on Pro) up
// to 60s. Increase to 300 if deployed on Pro plan and needing more headroom.
export const maxDuration = 60;

const ESTIMATES_BUCKET = 'estimates';
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

class UsageLimitError extends Error {
  used: number;
  limit: number;
  refreshDate: Date | null;

  constructor(used: number, limit: number, refreshDate: Date | null) {
    super('Comparison limit reached for this billing period.');
    this.used = used;
    this.limit = limit;
    this.refreshDate = refreshDate;
  }
}

function nextMonthlyDate(date: Date): Date {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

async function getAddonComparisonsThisPeriod(userId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ addonComparisonsThisPeriod: number | null }>>`
    select coalesce(addon_comparisons_this_period, 0) as "addonComparisonsThisPeriod"
    from public.users
    where id = ${userId}
    limit 1
  `;

  return rows[0]?.addonComparisonsThisPeriod ?? 0;
}

async function resetAddonComparisonsThisPeriod(userId: string) {
  await prisma.$executeRaw`
    update public.users
    set addon_comparisons_this_period = 0
    where id = ${userId}
  `;
}

async function normalizeAndValidateUsage(appUser: {
  id: string;
  subscriptionTier: SubscriptionTier | null;
  comparisonsUsedThisPeriod: number;
  periodResetDate: Date | null;
  trialEndsAt: Date | null;
  subscriptionEndsAt: Date | null;
}) {
  if (!appUser.subscriptionTier) {
    throw new Error('Active subscription required.');
  }

  let addonComparisonsThisPeriod = await getAddonComparisonsThisPeriod(appUser.id);
  let limit = PLAN_COMPARISON_LIMITS[appUser.subscriptionTier] + addonComparisonsThisPeriod;
  const now = new Date();
  let used = appUser.comparisonsUsedThisPeriod;
  let refreshDate = appUser.periodResetDate ?? appUser.subscriptionEndsAt ?? appUser.trialEndsAt ?? null;

  if (refreshDate && refreshDate <= now) {
    used = 0;

    while (refreshDate <= now) {
      refreshDate = nextMonthlyDate(refreshDate);
    }

    await prisma.user.update({
      where: { id: appUser.id },
      data: {
        comparisonsUsedThisPeriod: 0,
        llmEditsUsedThisPeriod: 0,
        executiveSummariesUsedThisPeriod: 0,
        periodResetDate: refreshDate,
      },
    });

    if (addonComparisonsThisPeriod > 0) {
      await resetAddonComparisonsThisPeriod(appUser.id);
      addonComparisonsThisPeriod = 0;
    }

    limit = PLAN_COMPARISON_LIMITS[appUser.subscriptionTier] + addonComparisonsThisPeriod;
  } else if (!appUser.periodResetDate && refreshDate) {
    await prisma.user.update({
      where: { id: appUser.id },
      data: {
        periodResetDate: refreshDate,
      },
    });
  }

  if (used >= limit) {
    throw new UsageLimitError(used, limit, refreshDate);
  }

  return { limit, refreshDate };
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function buildStoragePath(clerkId: string, filename: string): string {
  const safeFilename = sanitizeFilename(filename);
  return `${clerkId}/${Date.now()}-${crypto.randomUUID()}-${safeFilename}`;
}

function validatePdf(file: File): string | null {
  if (file.type !== 'application/pdf') {
    return `File "${file.name}" is not a PDF.`;
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return `File "${file.name}" exceeds 20MB limit.`;
  }

  return null;
}

function readOptionalField(formData: FormData, fieldName: string): string | undefined {
  const value = formData.get(fieldName);

  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function uploadSingleFile(clerkId: string, file: File) {
  const storagePath = buildStoragePath(clerkId, file.name);
  const arrayBuffer = await file.arrayBuffer();

  const { error } = await supabaseAdmin.storage
    .from(ESTIMATES_BUCKET)
    .upload(storagePath, arrayBuffer, {
      contentType: 'application/pdf',
      upsert: false,
    });

  if (error) {
    throw new Error(`Failed to upload ${file.name}: ${error.message}`);
  }

  return {
    filename: file.name,
    storagePath,
    sizeBytes: file.size,
  };
}

function formatComparisonTitle(comparison: {
  name: string | null;
  insuredName: string | null;
  claimNumber: string | null;
  propertyAddress: string | null;
  yourEstimateFilename: string;
  adjusterEstimateFilename: string;
}): string {
  if (comparison.name) return comparison.name;
  if (comparison.propertyAddress) return comparison.propertyAddress;
  if (comparison.claimNumber) return `Claim ${comparison.claimNumber}`;
  if (comparison.insuredName) return comparison.insuredName;

  return `${comparison.yourEstimateFilename} vs ${comparison.adjusterEstimateFilename}`;
}

export async function GET(request: Request) {
  const { userId: clerkId } = await auth();

  if (!clerkId) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const appUser = await prisma.user.findUnique({
    where: { clerkId },
    select: {
      id: true,
      subscriptionTier: true,
      comparisonsUsedThisPeriod: true,
      periodResetDate: true,
      trialEndsAt: true,
      subscriptionEndsAt: true,
    },
  });

  if (!appUser) {
    return NextResponse.json(
      { error: 'User is not synced to the database yet.' },
      { status: 409 }
    );
  }

  const PAGE_SIZE = 50;
  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor') ?? undefined;

  const rows = await prisma.comparison.findMany({
    where: { userId: appUser.id, status: { notIn: ['AWAITING_ZONE_REVIEW', 'AWAITING_MATCH_REVIEW'] } },
    orderBy: { createdAt: 'desc' },
    take: PAGE_SIZE + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      name: true,
      insuredName: true,
      claimNumber: true,
      propertyAddress: true,
      yourEstimateFilename: true,
      adjusterEstimateFilename: true,
      totalGap: true,
      status: true,
      createdAt: true,
    },
  });

  const hasMore = rows.length > PAGE_SIZE;
  const comparisons = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const nextCursor = hasMore ? comparisons[comparisons.length - 1].id : null;

  return NextResponse.json(
    {
      comparisons: comparisons.map((comparison) => ({
        id: comparison.id,
        title: formatComparisonTitle(comparison),
        status: comparison.status,
        totalGap: comparison.totalGap !== null ? Number(comparison.totalGap) : null,
        createdAt: comparison.createdAt,
      })),
      nextCursor,
    },
    { status: 200 }
  );
}

export async function POST(request: Request) {
  const { userId: clerkId } = await auth();

  if (!clerkId) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const appUser = await prisma.user.findUnique({
    where: { clerkId },
    select: {
      id: true,
      subscriptionTier: true,
      comparisonsUsedThisPeriod: true,
      periodResetDate: true,
      trialEndsAt: true,
      subscriptionEndsAt: true,
    },
  });

  if (!appUser) {
    return NextResponse.json(
      { error: 'User is not synced to the database yet.' },
      { status: 409 }
    );
  }

  if (!appUser.subscriptionTier) {
    return NextResponse.json({ error: 'Active subscription required.' }, { status: 403 });
  }

  let formData: FormData;

  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: 'Request must be multipart form data.' },
      { status: 400 }
    );
  }

  const yourEstimate = formData.get('yourEstimate');
  const adjusterEstimate = formData.get('adjusterEstimate');

  if (!(yourEstimate instanceof File) || !(adjusterEstimate instanceof File)) {
    return NextResponse.json(
      { error: 'Both PDF files are required.' },
      { status: 400 }
    );
  }

  const yourEstimateError = validatePdf(yourEstimate);
  if (yourEstimateError) {
    return NextResponse.json({ error: yourEstimateError }, { status: 400 });
  }

  const adjusterEstimateError = validatePdf(adjusterEstimate);
  if (adjusterEstimateError) {
    return NextResponse.json({ error: adjusterEstimateError }, { status: 400 });
  }

  const uploadedPaths: string[] = [];
  let comparison: { id: string; status: string; createdAt: Date } | null = null;

  try {
    const usage = await normalizeAndValidateUsage(appUser);

    const yourUpload = await uploadSingleFile(clerkId, yourEstimate);
    uploadedPaths.push(yourUpload.storagePath);

    const adjusterUpload = await uploadSingleFile(clerkId, adjusterEstimate);
    uploadedPaths.push(adjusterUpload.storagePath);

    const VALID_FORMATS = new Set(['xactimate', 'symbility', 'unknown']);
    const yourFmt = formData.get('yourEstimateFormat');
    const adjFmt  = formData.get('adjusterEstimateFormat');

    comparison = await prisma.$transaction(async (tx) => {
      const usageUpdate = await tx.user.updateMany({
        where: {
          id: appUser.id,
          comparisonsUsedThisPeriod: { lt: usage.limit },
        },
        data: {
          comparisonsUsedThisPeriod: { increment: 1 },
        },
      });

      if (usageUpdate.count === 0) {
        const latestUser = await tx.user.findUnique({
          where: { id: appUser.id },
          select: {
            comparisonsUsedThisPeriod: true,
            periodResetDate: true,
          },
        });

        throw new UsageLimitError(
          latestUser?.comparisonsUsedThisPeriod ?? usage.limit,
          usage.limit,
          latestUser?.periodResetDate ?? usage.refreshDate
        );
      }

      return tx.comparison.create({
        data: {
          userId: appUser.id,
          name: readOptionalField(formData, 'name'),
          insuredName: readOptionalField(formData, 'insuredName'),
          claimNumber: readOptionalField(formData, 'claimNumber'),
          propertyAddress: readOptionalField(formData, 'propertyAddress'),
          yourEstimateFilename: yourUpload.filename,
          yourEstimateStoragePath: yourUpload.storagePath,
          yourEstimateFormat: typeof yourFmt === 'string' && VALID_FORMATS.has(yourFmt) ? yourFmt : 'xactimate',
          adjusterEstimateFilename: adjusterUpload.filename,
          adjusterEstimateStoragePath: adjusterUpload.storagePath,
          adjusterEstimateFormat: typeof adjFmt === 'string' && VALID_FORMATS.has(adjFmt) ? adjFmt : 'xactimate',
        },
        select: {
          id: true,
          status: true,
          createdAt: true,
        },
      });
    });

    // Route to N4 when: flag is on OR either side uses a non-Xactimate format.
    // N4 supports Xactimate, Symbility, and future formats via plug-and-play extractors.
    // N3 remains the fallback for pure Xactimate-Xactimate comparisons.
    const resolvedYourFmt  = typeof yourFmt  === 'string' && VALID_FORMATS.has(yourFmt)  ? yourFmt  : 'xactimate';
    const resolvedAdjFmt   = typeof adjFmt   === 'string' && VALID_FORMATS.has(adjFmt)   ? adjFmt   : 'xactimate';
    const useN4 = isN4Enabled()
      || resolvedYourFmt  !== 'xactimate'
      || resolvedAdjFmt   !== 'xactimate';

    if (useN4) {
      await inngest.send({
        name: 'comparison/process-v4.requested',
        data: {
          comparisonId: comparison.id,
          trigger: 'create-route',
        },
      });
    } else {
      if (!(await isN3Eligible(comparison.id))) {
        throw new Error('N3 pipeline is not eligible for this comparison. Ensure N3_ENABLED=true.');
      }
      await inngest.send({
        name: 'comparison/process-v3.requested',
        data: {
          comparisonId: comparison.id,
          trigger: 'create-route',
        },
      });
    }

    return NextResponse.json(
      {
        status: 'accepted',
        comparison,
        files: {
          yourEstimate: yourUpload,
          adjusterEstimate: adjusterUpload,
        },
      },
      { status: 202 }
    );
  } catch (error) {
    if (error instanceof UsageLimitError) {
      if (uploadedPaths.length > 0) {
        const { error: cleanupError } = await supabaseAdmin.storage
          .from(ESTIMATES_BUCKET)
          .remove(uploadedPaths);
        if (cleanupError) {
          console.error('Failed to cleanup uploaded files after usage limit error:', cleanupError);
        }
      }
      return NextResponse.json(
        {
          error: error.message,
          code: 'USAGE_LIMIT_REACHED',
          used: error.used,
          limit: error.limit,
          refreshDate: error.refreshDate,
        },
        { status: 403 }
      );
    }

    if (uploadedPaths.length > 0) {
      const { error: cleanupError } = await supabaseAdmin.storage
        .from(ESTIMATES_BUCKET)
        .remove(uploadedPaths);

      if (cleanupError) {
        console.error('Failed to cleanup uploaded files after comparison error:', cleanupError);
      }
    }

    if (comparison) {
      try {
        await prisma.comparison.delete({ where: { id: comparison.id } });
      } catch (deleteErr) {
        console.error('[COMPARISON-CREATE] Failed to delete zombie comparison:', comparison.id, deleteErr);
      }
      try {
        await prisma.user.update({
          where: { id: appUser.id },
          data: { comparisonsUsedThisPeriod: { decrement: 1 } },
        });
      } catch (decrementErr) {
        console.error('[COMPARISON-CREATE] Failed to decrement usage after inngest failure:', decrementErr);
      }
    }

    const message = error instanceof Error ? error.message : 'Unknown comparison creation error.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
