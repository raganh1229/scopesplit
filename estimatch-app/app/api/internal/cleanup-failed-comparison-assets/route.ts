import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { supabaseAdmin } from '@/lib/supabase';

// Vercel serverless runtime cap for cron jobs
export const maxDuration = 60;

const FAILED_AGE_DAYS = 7; // Clean up FAILED comparisons older than 7 days

function isAuthorizedRequest(request: Request): boolean {
  const configuredSecret = process.env.FAILED_ASSETS_CLEANUP_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  const providedSecret = request.headers.get('x-cleanup-secret');
  const authHeader = request.headers.get('authorization');
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : null;

  if (!configuredSecret && !cronSecret) {
    return false;
  }

  const matchesCleanupSecret = Boolean(configuredSecret) && (providedSecret === configuredSecret || bearerToken === configuredSecret);
  const matchesCronSecret = Boolean(cronSecret) && bearerToken === cronSecret;

  return matchesCleanupSecret || matchesCronSecret;
}

export async function POST(request: Request) {
  if (!isAuthorizedRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  if (process.env.FAILED_ASSETS_CLEANUP_ENABLED !== 'true') {
    return NextResponse.json({ ok: true, skipped: true, reason: 'cleanup_disabled' }, { status: 200 });
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - FAILED_AGE_DAYS);

  // Find FAILED comparisons older than N days
  const failedComparisons = await prisma.comparison.findMany({
    where: {
      status: 'FAILED',
      createdAt: { lt: cutoffDate },
    },
    select: {
      id: true,
      yourEstimateStoragePath: true,
      adjusterEstimateStoragePath: true,
    },
  });

  const results: {
    comparisonId: string;
    filesRemoved: string[];
    errors: string[];
  }[] = [];

  for (const comparison of failedComparisons) {
    const storagePaths: string[] = [];
    if (comparison.yourEstimateStoragePath) storagePaths.push(comparison.yourEstimateStoragePath);
    if (comparison.adjusterEstimateStoragePath) storagePaths.push(comparison.adjusterEstimateStoragePath);

    const result = {
      comparisonId: comparison.id,
      filesRemoved: [] as string[],
      errors: [] as string[],
    };

    if (storagePaths.length > 0) {
      try {
        const { error } = await supabaseAdmin.storage
          .from('estimates')
          .remove(storagePaths);

        if (error) {
          result.errors.push(`Storage remove failed: ${error.message}`);
          console.error(`[CLEANUP-FAILED] Storage error for ${comparison.id}:`, error);
        } else {
          result.filesRemoved = storagePaths;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`Storage exception: ${message}`);
        console.error(`[CLEANUP-FAILED] Storage exception for ${comparison.id}:`, message);
      }
    }

    try {
      await prisma.comparison.delete({ where: { id: comparison.id } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`DB delete failed: ${message}`);
      console.error(`[CLEANUP-FAILED] DB delete error for ${comparison.id}:`, message);
    }

    results.push(result);
  }

  return NextResponse.json({
    ok: true,
    cutoffDays: FAILED_AGE_DAYS,
    cutoffDate: cutoffDate.toISOString(),
    failedComparisonsFound: failedComparisons.length,
    results,
  }, { status: 200 });
}

export async function GET(request: Request) {
  if (!isAuthorizedRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // Dry-run mode: return what WOULD be cleaned up without doing it
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - FAILED_AGE_DAYS);

  const failedComparisons = await prisma.comparison.findMany({
    where: {
      status: 'FAILED',
      createdAt: { lt: cutoffDate },
    },
    select: {
      id: true,
      yourEstimateStoragePath: true,
      adjusterEstimateStoragePath: true,
      createdAt: true,
    },
  });

  const totalOrphanFiles = failedComparisons.reduce((count, c) => {
    return count + (c.yourEstimateStoragePath ? 1 : 0) + (c.adjusterEstimateStoragePath ? 1 : 0);
  }, 0);

  return NextResponse.json({
    dryRun: true,
    cutoffDays: FAILED_AGE_DAYS,
    cutoffDate: cutoffDate.toISOString(),
    failedComparisonsFound: failedComparisons.length,
    totalOrphanFiles,
    comparisons: failedComparisons.map(c => ({
      id: c.id,
      createdAt: c.createdAt,
      yourPath: c.yourEstimateStoragePath,
      adjusterPath: c.adjusterEstimateStoragePath,
    })),
  }, { status: 200 });
}
