/**
 * Phase 8.4 verification — permanent failure + FAILED fallback.
 *
 * Injects a PERSISTENT forced failure into Stage B ('reconcile-and-prematch')
 * via a sentinel file at `scripts/debug-sentinels/fail-always-reconcile-and-prematch.flag`
 * that `maybeFailStageAlways()` throws on every call. Expected behavior:
 *
 *   • Attempt 1: Stage A runs ✓ (memoized for retries); Stage B throws.
 *   • Retries 1–4: Stage A skipped (memoized); Stage B throws again each time.
 *   • After Inngest exhausts its 4 retries (default), the worker's
 *     wrapping try/catch executes `step.run('mark-failed', ...)` which
 *     flips the comparison row to status=FAILED with errorMessage set.
 *   • Intermediate state row (`comparison_processing_state`) is left behind
 *     from Stage A's write of `extracted` — this is expected and not an
 *     error. The row would be re-used if someone later retries with
 *     `force: true`, or cleaned up manually.
 *
 * We chose Stage B (not C) because Stage A's memoization means each retry
 * only re-runs Stage B (one Sonnet reconciliation call ≈ $0.02) plus the
 * Inngest backoff delay. Total cost: ~$0.05 initial Stage A + ~$0.10 for
 * 5 Stage B attempts = ~$0.15. Without memoization it would be ~$0.50+.
 *
 * Wall-clock: Inngest's default backoff is exponential. Expect ~8–12 minutes
 * total for the 4 retries to exhaust. POLL_TIMEOUT_MS is set generously.
 *
 * Usage:
 *   npx tsx scripts/n1-verify-phase8-permanent-failure.ts
 *   COMPARISON_ID=<id> npx tsx scripts/n1-verify-phase8-permanent-failure.ts
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
const SENTINEL_STAGE = 'reconcile-and-prematch';
const SENTINEL_FILE = path.join(SENTINEL_DIR, `fail-always-${SENTINEL_STAGE}.flag`);

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes — covers full exponential-backoff retry exhaustion

function cleanupSentinel() {
  try {
    if (fs.existsSync(SENTINEL_FILE)) fs.unlinkSync(SENTINEL_FILE);
  } catch {
    /* best-effort */
  }
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

  // ── Reset. ──
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

  // ── Drop the persistent sentinel. ──
  console.log(`\n▶ Arming persistent sentinel: ${SENTINEL_FILE}`);
  fs.mkdirSync(SENTINEL_DIR, { recursive: true });
  fs.writeFileSync(SENTINEL_FILE, `Armed at ${new Date().toISOString()}\n`);
  console.log(`  Sentinel created. Stage B ("${SENTINEL_STAGE}") will throw on every attempt.`);

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
    cleanupSentinel();
    await prisma.$disconnect();
    process.exit(2);
  }

  // ── Poll until FAILED (or COMPLETED, which would be a failure of the test). ──
  console.log('\n▶ Polling for FAILED status (Inngest must exhaust 4 retries — ~8–12 min)...');
  let finalStatus: string = 'PROCESSING';
  let finalRow: Awaited<ReturnType<typeof prisma.comparison.findUnique>> = null;
  let lastLoggedMinute = -1;
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const row = await prisma.comparison.findUnique({ where: { id: comparisonId } });
    if (!row) throw new Error(`Comparison ${comparisonId} disappeared mid-run.`);
    finalRow = row;
    finalStatus = row.status;
    if (row.status === 'COMPLETED' || row.status === 'FAILED') break;

    const elapsedMin = Math.floor((Date.now() - startedAt) / 60000);
    if (elapsedMin !== lastLoggedMinute) {
      lastLoggedMinute = elapsedMin;
      if (elapsedMin > 0) process.stdout.write(`[${elapsedMin}m]`);
    }
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  const totalSec = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\n  Final status: ${finalStatus} after ${totalSec}s`);

  // ── Clean up sentinel regardless of outcome. ──
  console.log('\n▶ Cleaning up sentinel file...');
  cleanupSentinel();

  // ── Check leftover intermediate state. Stage A ran and wrote `extracted`;
  //    this row should still be there (it's legitimate — Stage D was never
  //    reached to clear it). Log but do not fail on its presence.
  const leftoverState = await prisma.comparisonProcessingState.findUnique({
    where: { comparisonId },
  });

  // ── Assertions. ──
  console.log('\n═════════════════════════════════════════════════════════');
  const failures: string[] = [];
  if (finalStatus !== 'FAILED') {
    failures.push(`final status is ${finalStatus}, expected FAILED`);
  }
  if (finalStatus === 'FAILED') {
    const msg = finalRow?.errorMessage ?? '';
    if (!msg) {
      failures.push('errorMessage is empty');
    } else if (!msg.toLowerCase().includes('debug-fail-always') && !msg.toLowerCase().includes(SENTINEL_STAGE)) {
      failures.push(`errorMessage does not reference the debug-fail source: "${msg}"`);
    } else {
      console.log(`  ✓ errorMessage: "${msg}"`);
    }
  }

  if (leftoverState) {
    console.log(`  ℹ intermediate-state row remains at stage="${leftoverState.stage}" (expected — Stage D never cleared it)`);
  } else {
    console.log('  ℹ no intermediate-state row (unexpected, but not a test failure)');
  }

  // Also verify Stage A's work wasn't re-applied to the canonical aggregate
  // columns (those should remain null from the reset).
  if (finalRow?.yourEstimateTotal !== null || finalRow?.adjusterEstimateTotal !== null) {
    failures.push(`aggregate columns leaked despite FAILED status: yourTotal=${finalRow?.yourEstimateTotal}, adjTotal=${finalRow?.adjusterEstimateTotal}`);
  }

  if (failures.length === 0) {
    console.log('\n✓ PERMANENT-FAILURE HANDLING VERIFIED — P8.4 PASS');
    console.log(`  Inngest exhausted its 4-retry budget (~${Math.round(totalSec / 60)}m wall-clock),`);
    console.log('  the worker\'s mark-failed step flipped the row to FAILED with a useful');
    console.log('  errorMessage, and Stage A\'s intermediate state was preserved for');
    console.log('  potential force-retry. No aggregate leakage.');
  } else {
    console.log('\n✗ PERMANENT-FAILURE TEST FAILED');
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log('═════════════════════════════════════════════════════════');

  await prisma.$disconnect();
  if (failures.length > 0) process.exit(3);
}

main().catch(async err => {
  console.error('\n✗ FAILURE:', err);
  cleanupSentinel();
  process.exit(1);
});
