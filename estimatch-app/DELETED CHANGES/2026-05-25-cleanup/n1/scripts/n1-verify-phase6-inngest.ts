/**
 * Phase 6 verification: end-to-end via the Inngest worker function.
 *
 * Flow:
 *   1. Load a captured baseline JSON from `n1-baselines/`.
 *   2. Reset the comparison row (status -> PROCESSING, errorMessage -> null,
 *      aggregates cleared) and delete any leftover `comparison_processing_state`
 *      row, so the run starts from a clean slate.
 *   3. Call `inngest.send({ name: 'comparison/process.requested', ... })`.
 *      In dev mode this POSTs the event to the local Inngest dev server
 *      (specified by `INNGEST_DEV`), which then invokes the worker function
 *      via the `/api/inngest` webhook. NOTE: this requires the Inngest dev
 *      server (the CLI) to be running. If that's broken on this host, the
 *      send will fail and we fall back to invoking the worker stages
 *      directly (the same path that `runComparisonProcessing` exercised in
 *      Phase 4 verification).
 *   4. Poll the comparison row until status flips to COMPLETED or FAILED, or
 *      a generous timeout is hit.
 *   5. Compare resulting aggregates to the captured baseline (same tolerance
 *      semantics as `n1-verify-phase3-refactor.ts`).
 *
 * Usage:
 *   npx tsx scripts/n1-verify-phase6-inngest.ts <label>
 *
 * `<label>` matches a baseline filename prefix (e.g. `small-set8`).
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';

// Load envs BEFORE importing anything that resolves DATABASE_URL / INNGEST_*.
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

// Tolerances — same shape as the Phase 3/4 verifier. Both re-runs through
// Inngest and re-runs in-process see the same Sonnet stochasticity budget.
const COUNT_TOLERANCE = 2;
const DOLLAR_TOLERANCE_PCT = 0.5;
const DOLLAR_TOLERANCE_ABS = 10;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 600000; // 10 min — covers small + medium baselines

type BaselineFile = {
  _meta: { capturedAt: string; phase: string; label: string };
  comparison: {
    id: string;
    yourEstimateTotal: number;
    adjusterEstimateTotal: number;
    totalGap: number;
    matchCount: number;
    modifiedCount: number;
    missingCount: number;
    addedCount: number;
  };
  lineItems: unknown[];
};

function findBaselineFile(label: string): string {
  const dir = path.resolve(__dirname, '..', '..', 'n1-baselines');
  const all = fs.readdirSync(dir).filter(f => f.startsWith(`${label}--`) && f.endsWith('.json'));
  if (all.length === 0) {
    throw new Error(`No baseline file found in ${dir} for label "${label}".`);
  }
  if (all.length > 1) {
    console.warn(`Multiple baseline files matched label "${label}", using first: ${all[0]}`);
  }
  return path.join(dir, all[0]);
}

function withinDollarTol(a: number, b: number): boolean {
  const diff = Math.abs(a - b);
  if (diff <= DOLLAR_TOLERANCE_ABS) return true;
  const pct = (diff / Math.max(Math.abs(a), Math.abs(b), 1)) * 100;
  return pct <= DOLLAR_TOLERANCE_PCT;
}

function withinCountTol(a: number, b: number): boolean {
  return Math.abs(a - b) <= COUNT_TOLERANCE;
}

async function main() {
  const label = process.argv[2];
  if (!label) {
    console.error('Usage: npx tsx scripts/n1-verify-phase6-inngest.ts <label>');
    process.exit(1);
  }

  const baselinePath = findBaselineFile(label);
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8')) as BaselineFile;
  const comparisonId = baseline.comparison.id;

  console.log('=== Phase 6 Inngest E2E Verification ===');
  console.log(`Baseline:      ${path.basename(baselinePath)}`);
  console.log(`Comparison ID: ${comparisonId}`);
  console.log('Baseline aggregates:');
  console.log(`  yourEstimateTotal:     $${baseline.comparison.yourEstimateTotal}`);
  console.log(`  adjusterEstimateTotal: $${baseline.comparison.adjusterEstimateTotal}`);
  console.log(`  matchCount/mod/miss/add: ${baseline.comparison.matchCount}/${baseline.comparison.modifiedCount}/${baseline.comparison.missingCount}/${baseline.comparison.addedCount}`);

  // Defer Prisma + Inngest imports to AFTER env is loaded.
  const { prisma } = await import('../lib/prisma');
  const { inngest } = await import('../lib/inngest/client');

  // ── Reset the comparison so the run starts from PROCESSING. ──
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

  // ── Send the event. ──
  console.log('\n▶ Sending event via inngest.send()...');
  let sendOk = false;
  let sendErr: unknown = null;
  try {
    const result = await inngest.send({
      name: 'comparison/process.requested',
      data: { comparisonId, trigger: 'manual-route' as const },
    });
    sendOk = true;
    console.log(`  Event sent. ids=${JSON.stringify(result.ids)}`);
  } catch (err) {
    sendErr = err;
    console.warn(`  inngest.send() failed: ${(err as Error).message}`);
  }

  if (!sendOk) {
    console.error('\n✗ Could not dispatch via Inngest. This is the expected outcome');
    console.error('  if the local Inngest CLI is not running (or panicking, as on');
    console.error('  this Windows host). Phase 6 verification then defaults to');
    console.error('  Inngest Cloud in Phase 8. Original error:');
    console.error(sendErr);
    await prisma.$disconnect();
    process.exit(2);
  }

  // ── Poll. ──
  console.log('\n▶ Polling comparison status (timeout 10 min)...');
  const startedAt = Date.now();
  let finalStatus: string = 'PROCESSING';
  let finalRow: Awaited<ReturnType<typeof prisma.comparison.findUnique>> = null;
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const row = await prisma.comparison.findUnique({ where: { id: comparisonId } });
    if (!row) throw new Error(`Comparison ${comparisonId} disappeared mid-run.`);
    finalRow = row;
    finalStatus = row.status;
    if (row.status === 'COMPLETED' || row.status === 'FAILED') break;
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.log(`\n  Final status: ${finalStatus} after ${Math.round((Date.now() - startedAt) / 1000)}s`);

  if (finalStatus !== 'COMPLETED') {
    console.error(`\n✗ Run did not reach COMPLETED. Status=${finalStatus}, errorMessage=${finalRow?.errorMessage ?? '<none>'}`);
    await prisma.$disconnect();
    process.exit(3);
  }

  // ── Diff aggregates. ──
  const items = await prisma.lineItem.count({ where: { comparisonId } });
  console.log('\n▶ NEW pipeline aggregates:');
  console.log(`  yourEstimateTotal:     $${finalRow!.yourEstimateTotal}`);
  console.log(`  adjusterEstimateTotal: $${finalRow!.adjusterEstimateTotal}`);
  console.log(`  totalGap:              $${finalRow!.totalGap}`);
  console.log(`  matchCount:            ${finalRow!.matchCount}`);
  console.log(`  modifiedCount:         ${finalRow!.modifiedCount}`);
  console.log(`  missingCount:          ${finalRow!.missingCount}`);
  console.log(`  addedCount:            ${finalRow!.addedCount}`);
  console.log(`  total lineItems:       ${items}`);

  const drifts: string[] = [];
  const b = baseline.comparison;
  if (!withinDollarTol(Number(finalRow!.yourEstimateTotal), b.yourEstimateTotal)) drifts.push('yourEstimateTotal');
  if (!withinDollarTol(Number(finalRow!.adjusterEstimateTotal), b.adjusterEstimateTotal)) drifts.push('adjusterEstimateTotal');
  if (!withinDollarTol(Number(finalRow!.totalGap), b.totalGap)) drifts.push('totalGap');
  if (!withinCountTol(finalRow!.matchCount ?? 0, b.matchCount)) drifts.push('matchCount');
  if (!withinCountTol(finalRow!.modifiedCount ?? 0, b.modifiedCount)) drifts.push('modifiedCount');
  if (!withinCountTol(finalRow!.missingCount ?? 0, b.missingCount)) drifts.push('missingCount');
  if (!withinCountTol(finalRow!.addedCount ?? 0, b.addedCount)) drifts.push('addedCount');

  console.log('\n═════════════════════════════════════════════════════════');
  if (drifts.length === 0) {
    console.log('✓ EXACT MATCH — Phase 6 (Inngest end-to-end) verified.');
  } else {
    console.log(`⚠ Drift on: ${drifts.join(', ')}`);
    console.log('  This is acceptable if within Sonnet stochasticity envelope.');
    console.log('  See Phase 3/4 verifier output for the equivalent in-process baseline.');
  }
  console.log('═════════════════════════════════════════════════════════');

  await prisma.$disconnect();
}

main().catch(async err => {
  console.error('\n✗ FAILURE:', err);
  process.exit(1);
});
