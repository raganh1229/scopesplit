// ─────────────────────────────────────────────────────────────────────────────
// sweep-stuck-comparisons — Vercel cron route
//
// Finds comparisons that have been stuck in PROCESSING for longer than
// STUCK_THRESHOLD_MINUTES and marks them FAILED.
//
// This is the safety net for comparisons whose Inngest function was killed by
// Vercel's 300 s Lambda timeout (SIGKILL). In that case the JS catch block
// never runs, so the DB row is never transitioned to FAILED by the pipeline
// itself.
//
// AWAITING_* statuses are intentionally excluded — those are legitimately
// waiting for user input and have their own 24 h Inngest waitForEvent timeout.
//
// Auth: Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` for
//   scheduled cron jobs. The same secret is accepted for manual POST calls.
//
// Schedule: every 10 minutes (see vercel.json).
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { autoFailComparison } from '@/lib/comparisons/auto-fail';

export const maxDuration = 60;

const STUCK_THRESHOLD_MINUTES = 30;

function isAuthorized(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  const authHeader = request.headers.get('authorization');
  const bearerToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : null;
  return bearerToken === cronSecret;
}

async function runSweep() {
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000);

  // Find all comparisons stuck in PROCESSING (never AWAITING_*).
  const stuckComparisons = await prisma.comparison.findMany({
    where: {
      status: 'PROCESSING',
      updatedAt: { lt: cutoff },
    },
    select: { id: true },
  });

  if (stuckComparisons.length === 0) {
    return NextResponse.json({ ok: true, swept: 0 });
  }

  const results = await Promise.allSettled(
    stuckComparisons.map(({ id }) =>
      autoFailComparison(
        id,
        `[auto-fail] Comparison processing timed out after ${STUCK_THRESHOLD_MINUTES} minutes.`,
      ),
    ),
  );

  let marked = 0;
  let skipped = 0;
  let errors = 0;
  const errorIds: string[] = [];

  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      if (result.value.marked) marked++;
      else skipped++;
    } else {
      errors++;
      errorIds.push(stuckComparisons[i].id);
      console.error(
        `[sweep-stuck] failed to auto-fail comparison ${stuckComparisons[i].id}:`,
        result.reason,
      );
    }
  });

  return NextResponse.json({
    ok: true,
    found: stuckComparisons.length,
    marked,
    skipped,
    errors,
    errorIds,
    thresholdMinutes: STUCK_THRESHOLD_MINUTES,
  });
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }
  return runSweep();
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }
  return runSweep();
}
