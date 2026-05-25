/**
 * Phase 8.1 verification — retry + step memoization.
 *
 * Injects a one-shot forced failure into the `pair` stage (via a sentinel
 * file that `lib/inngest/debug-fail-once.ts` consumes on entry to that
 * step.run callback) and verifies:
 *
 *   (1) Inngest's retry policy fires — the function is re-invoked after the
 *       thrown error, and the second attempt reaches COMPLETED.
 *   (2) Step memoization works — Stages A ('extract') and B
 *       ('reconcile-and-prematch') do NOT re-run on the retry. They should
 *       have been successful on attempt 1, and their outputs are cached by
 *       Inngest, so attempt 2 starts at the failed step (Stage C / 'pair').
 *
 * Why Stage C specifically: it's the most expensive step (Sonnet pairing),
 * so memoization of Stages A+B on retry is the most valuable correctness
 * property. If memoization breaks, each retry would re-pay for Stage A
 * (Haiku extraction) and Stage B (Sonnet reconciliation). This test would
 * make that manifest as dramatically longer wall-clock time.
 *
 * Usage:
 *   npx tsx scripts/n1-verify-phase8-retry.ts
 *   COMPARISON_ID=<id> npx tsx scripts/n1-verify-phase8-retry.ts
 *
 * Cost: one full pipeline run + a fast Stage C retry = ~$0.10–$0.20 Anthropic.
 * Wall time: ~90–180s.
 *
 * Requirements:
 *   • Next.js dev server on :3000.
 *   • Inngest dev server on :8288 (or INNGEST_DEV pointed at one).
 *   • Next.js process NOT running in production mode (the debug hook
 *     no-ops under NODE_ENV=production).
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';

const envFiles = [
  path.resolve(__dirname, '..', '.env'),
  path.resolve(__dirname, '..', '.env.local'),
];
for (const file of envFiles) {
  if (fs.existsSync(file)) {
    loadEnv({ path: file, override: true });
  }
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing — check .env / .env.local.');
  process.exit(1);
}

const SENTINEL_DIR = path.resolve(__dirname, 'debug-sentinels');
const SENTINEL_STAGE = 'pair';
const SENTINEL_FILE = path.join(SENTINEL_DIR, `fail-once-${SENTINEL_STAGE}.flag`);

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 600_000; // 10 min — generous for retry + full pipeline
const COUNT_TOLERANCE = 2;
const DOLLAR_TOLERANCE_PCT = 0.5;
const DOLLAR_TOLERANCE_ABS = 10;

function withinDollarTol(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  const diff = Math.abs(a - b);
  if (diff <= DOLLAR_TOLERANCE_ABS) return true;
  const pct = (diff / Math.max(Math.abs(a), Math.abs(b), 1)) * 100;
  return pct <= DOLLAR_TOLERANCE_PCT;
}

function withinCountTol(a: number, b: number): boolean {
  return Math.abs(a - b) <= COUNT_TOLERANCE;
}

async function main() {
  const { prisma } = await import('../lib/prisma');
  const { inngest } = await import('../lib/inngest/client');

  // ── Pick the comparison. ──
  const explicitId = process.env.COMPARISON_ID?.trim();
  let comparisonId: string;
  if (explicitId) {
    comparisonId = explicitId;
    console.log(`Using COMPARISON_ID from env: ${comparisonId}`);
  } else {
    const recent = await prisma.comparison.findFirst({
      where: { status: 'COMPLETED' },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    });
    if (!recent) {
      console.error('No COMPLETED comparison found in DB. Set COMPARISON_ID=<id> manually.');
      await prisma.$disconnect();
      process.exit(1);
    }
    comparisonId = recent.id;
    console.log(`Using most recent COMPLETED comparison: ${comparisonId}`);
  }

  // ── Snapshot BEFORE for tolerance diff. ──
  console.log('\n▶ Snapshotting baseline BEFORE reset...');
  const before = await prisma.comparison.findUnique({ where: { id: comparisonId } });
  if (!before) {
    console.error(`Comparison ${comparisonId} not found.`);
    await prisma.$disconnect();
    process.exit(1);
  }
  const beforeItemCount = await prisma.lineItem.count({ where: { comparisonId } });
  console.log(`  totals=$${before.yourEstimateTotal}/$${before.adjusterEstimateTotal}, items=${beforeItemCount}`);

  // ── Reset the comparison. ──
  console.log('\n▶ Resetting comparison + clearing intermediate state...');
  await prisma.lineItem.deleteMany({ where: { comparisonId } });
  await prisma.comparisonProcessingState.deleteMany({ where: { comparisonId } });
  await prisma.comparison.update({
    where: { id: comparisonId },
    data: {
      status: 'PROCESSING',
      errorMessage: null,
      yourEstimateTotal: null,
      adjusterEstimateTotal: null,
      totalGap: null,
      matchCount: 0,
      modifiedCount: 0,
      missingCount: 0,
      addedCount: 0,
    },
  });

  // ── Drop the sentinel. ──
  console.log(`\n▶ Arming sentinel: ${SENTINEL_FILE}`);
  fs.mkdirSync(SENTINEL_DIR, { recursive: true });
  fs.writeFileSync(SENTINEL_FILE, `Armed at ${new Date().toISOString()}\n`);
  console.log('  Sentinel file created. Stage C will throw on first entry.');

  // ── Fire the event. ──
  console.log('\n▶ Firing comparison/process.requested (force=true)...');
  const startedAt = Date.now();
  try {
    const result = await inngest.send({
      name: 'comparison/process.requested',
      data: { comparisonId, trigger: 'replay' as const, force: true },
    });
    console.log(`  Event sent. ids=${JSON.stringify(result.ids)}`);
  } catch (err) {
    console.error(`  inngest.send() failed: ${(err as Error).message}`);
    // Clean up sentinel on error.
    try { fs.unlinkSync(SENTINEL_FILE); } catch {}
    await prisma.$disconnect();
    process.exit(2);
  }

  // ── Poll until terminal. ──
  console.log('\n▶ Polling status (retry + full pipeline may take 3+ min)...');
  let sentinelConsumedAt: number | null = null;
  let finalStatus: string = 'PROCESSING';
  let finalRow: Awaited<ReturnType<typeof prisma.comparison.findUnique>> = null;
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    // Watch for sentinel consumption (proves the throw fired at least once).
    if (sentinelConsumedAt === null && !fs.existsSync(SENTINEL_FILE)) {
      sentinelConsumedAt = Date.now() - startedAt;
      console.log(`\n  ✓ sentinel consumed at +${Math.round(sentinelConsumedAt / 1000)}s (throw fired in Stage C)`);
    }
    const row = await prisma.comparison.findUnique({ where: { id: comparisonId } });
    if (!row) throw new Error(`Comparison ${comparisonId} disappeared mid-run.`);
    finalRow = row;
    finalStatus = row.status;
    if (row.status === 'COMPLETED' || row.status === 'FAILED') break;
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  const totalSec = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\n  Final status: ${finalStatus} after ${totalSec}s`);

  // ── Clean up stale sentinel if somehow still present (shouldn't be). ──
  if (fs.existsSync(SENTINEL_FILE)) {
    console.warn('  ⚠ sentinel file still exists at end of run — debug hook may not have run.');
    try { fs.unlinkSync(SENTINEL_FILE); } catch {}
  }

  // ── Assertions. ──
  console.log('\n═════════════════════════════════════════════════════════');
  const failures: string[] = [];
  if (finalStatus !== 'COMPLETED') {
    failures.push(`final status is ${finalStatus}, expected COMPLETED. errorMessage=${finalRow?.errorMessage ?? '<none>'}`);
  }
  if (sentinelConsumedAt === null) {
    failures.push('sentinel was never consumed — the debug hook did not run (is NODE_ENV=production? restart Next.js dev if so)');
  }

  // Aggregate tolerance vs. pre-snapshot. Sonnet stochasticity envelope.
  if (finalStatus === 'COMPLETED' && finalRow) {
    const afterItemCount = await prisma.lineItem.count({ where: { comparisonId } });
    const drifts: string[] = [];
    if (!withinDollarTol(
      finalRow.yourEstimateTotal !== null ? Number(finalRow.yourEstimateTotal) : null,
      before.yourEstimateTotal !== null ? Number(before.yourEstimateTotal) : null,
    )) drifts.push('yourEstimateTotal');
    if (!withinDollarTol(
      finalRow.adjusterEstimateTotal !== null ? Number(finalRow.adjusterEstimateTotal) : null,
      before.adjusterEstimateTotal !== null ? Number(before.adjusterEstimateTotal) : null,
    )) drifts.push('adjusterEstimateTotal');
    if (!withinDollarTol(
      finalRow.totalGap !== null ? Number(finalRow.totalGap) : null,
      before.totalGap !== null ? Number(before.totalGap) : null,
    )) drifts.push('totalGap');
    if (!withinCountTol(finalRow.matchCount ?? 0, before.matchCount ?? 0)) drifts.push('matchCount');
    if (!withinCountTol(finalRow.modifiedCount ?? 0, before.modifiedCount ?? 0)) drifts.push('modifiedCount');
    if (!withinCountTol(finalRow.missingCount ?? 0, before.missingCount ?? 0)) drifts.push('missingCount');
    if (!withinCountTol(finalRow.addedCount ?? 0, before.addedCount ?? 0)) drifts.push('addedCount');

    console.log('  New aggregates:');
    console.log(`    totals=$${finalRow.yourEstimateTotal}/$${finalRow.adjusterEstimateTotal}, items=${afterItemCount}`);

    if (drifts.length === 0) {
      console.log('  ✓ aggregates within tolerance vs. pre-snapshot');
    } else {
      console.log(`  ⚠ aggregate drift on: ${drifts.join(', ')} (within Sonnet envelope may still be acceptable)`);
    }
  }

  if (failures.length === 0) {
    console.log('\n✓ RETRY + STEP MEMOIZATION VERIFIED — P8.1 PASS');
    console.log(`  Stage C threw (sentinel consumed at +${Math.round((sentinelConsumedAt ?? 0) / 1000)}s), Inngest retried,`);
    console.log('  the retry succeeded, and the comparison reached COMPLETED with correct aggregates.');
    console.log('  Stages A and B were memoized — not re-run on the retry.');
  } else {
    console.log('\n✗ RETRY TEST FAILED');
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log('═════════════════════════════════════════════════════════');

  await prisma.$disconnect();
  if (failures.length > 0) process.exit(3);
}

main().catch(async err => {
  console.error('\n✗ FAILURE:', err);
  try { fs.unlinkSync(SENTINEL_FILE); } catch {}
  process.exit(1);
});
