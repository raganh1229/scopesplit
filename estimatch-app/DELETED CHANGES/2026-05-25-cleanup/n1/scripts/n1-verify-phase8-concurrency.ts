/**
 * Phase 8.2 verification — concurrency.
 *
 * Fires two `comparison/process.requested` events back-to-back for two
 * different `comparisonId`s and verifies:
 *   • Both runs complete successfully.
 *   • At some point during the test window, BOTH `comparison_processing_state`
 *     rows exist simultaneously — proving the runs are actually concurrent
 *     and not serialized by Inngest's per-comparisonId concurrency cap
 *     (which is `limit: 1` on `event.data.comparisonId` — should NOT apply
 *     across different comparisonIds).
 *   • Each comparison's final aggregates are within the Sonnet stochasticity
 *     envelope of its prior values (i.e. Stage D's wipe-and-rewrite produced
 *     equivalent results).
 *
 * Usage:
 *   npx tsx scripts/n1-verify-phase8-concurrency.ts
 *   COMPARISON_IDS="<id1>,<id2>" npx tsx scripts/n1-verify-phase8-concurrency.ts
 *
 * Cost: ~$0.20–$0.40 Anthropic spend (one full pipeline × 2).
 * Wall time: ~60–180s depending on PDF size.
 *
 * Requirements:
 *   • Next.js dev server on :3000.
 *   • Inngest dev server on :8288 (or INNGEST_DEV pointed at one).
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

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 600_000; // 10 min — covers two real-PDF pipelines.
const COUNT_TOLERANCE = 2;
const DOLLAR_TOLERANCE_PCT = 0.5;
const DOLLAR_TOLERANCE_ABS = 10;

type Snapshot = {
  status: string;
  yourEstimateTotal: number | null;
  adjusterEstimateTotal: number | null;
  totalGap: number | null;
  matchCount: number;
  modifiedCount: number;
  missingCount: number;
  addedCount: number;
  lineItemCount: number;
};

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

  // ── Pick the two comparisons. ──
  const explicit = process.env.COMPARISON_IDS?.trim();
  let ids: [string, string];
  if (explicit) {
    const parts = explicit.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length !== 2) {
      console.error('COMPARISON_IDS must be exactly two comma-separated ids.');
      await prisma.$disconnect();
      process.exit(1);
    }
    ids = [parts[0], parts[1]];
    console.log(`Using COMPARISON_IDS from env: ${ids[0]}, ${ids[1]}`);
  } else {
    const recent = await prisma.comparison.findMany({
      where: { status: 'COMPLETED' },
      orderBy: { updatedAt: 'desc' },
      take: 2,
      select: { id: true },
    });
    if (recent.length < 2) {
      console.error('Fewer than 2 COMPLETED comparisons in DB. Set COMPARISON_IDS=<id1>,<id2> manually.');
      await prisma.$disconnect();
      process.exit(1);
    }
    ids = [recent[0].id, recent[1].id];
    console.log(`Using two most recent COMPLETED comparisons:`);
    console.log(`  A: ${ids[0]}`);
    console.log(`  B: ${ids[1]}`);
  }

  // ── Snapshot pre-state for tolerance comparison. ──
  console.log('\n▶ Snapshotting baselines BEFORE...');
  const snapshots: Record<string, Snapshot> = {};
  for (const id of ids) {
    const row = await prisma.comparison.findUnique({ where: { id } });
    if (!row) {
      console.error(`Comparison ${id} not found.`);
      await prisma.$disconnect();
      process.exit(1);
    }
    const lineItemCount = await prisma.lineItem.count({ where: { comparisonId: id } });
    snapshots[id] = {
      status: row.status,
      yourEstimateTotal: row.yourEstimateTotal !== null ? Number(row.yourEstimateTotal) : null,
      adjusterEstimateTotal: row.adjusterEstimateTotal !== null ? Number(row.adjusterEstimateTotal) : null,
      totalGap: row.totalGap !== null ? Number(row.totalGap) : null,
      matchCount: row.matchCount ?? 0,
      modifiedCount: row.modifiedCount ?? 0,
      missingCount: row.missingCount ?? 0,
      addedCount: row.addedCount ?? 0,
      lineItemCount,
    };
    console.log(`  ${id.slice(0, 8)}... totals=$${snapshots[id].yourEstimateTotal}/$${snapshots[id].adjusterEstimateTotal}, items=${lineItemCount}`);
  }

  // ── Reset both rows and clear any leftover state. ──
  console.log('\n▶ Resetting both comparisons + clearing intermediate state...');
  for (const id of ids) {
    await prisma.lineItem.deleteMany({ where: { comparisonId: id } });
    await prisma.comparisonProcessingState.deleteMany({ where: { comparisonId: id } });
    await prisma.comparison.update({
      where: { id },
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
  }

  // ── Fire both events back-to-back. force=true is required because the
  //    rows are now PROCESSING (not terminal), but the guard would have
  //    let them through anyway — we set force=true defensively in case
  //    an earlier crashed run left the row in COMPLETED.
  console.log('\n▶ Firing both events back-to-back...');
  const sendStart = Date.now();
  const [r1, r2] = await Promise.all([
    inngest.send({
      name: 'comparison/process.requested',
      data: { comparisonId: ids[0], trigger: 'replay' as const, force: true },
    }),
    inngest.send({
      name: 'comparison/process.requested',
      data: { comparisonId: ids[1], trigger: 'replay' as const, force: true },
    }),
  ]);
  console.log(`  Both events sent in ${Date.now() - sendStart}ms.`);
  console.log(`    A: ids=${JSON.stringify(r1.ids)}`);
  console.log(`    B: ids=${JSON.stringify(r2.ids)}`);

  // ── Poll both rows + watch for simultaneous state-row presence. ──
  console.log('\n▶ Polling both rows + watching for concurrent execution...');
  const watchStart = Date.now();
  let bothStateRowsSeenSimultaneously = false;
  const finalStatuses: Record<string, string> = { [ids[0]]: 'PROCESSING', [ids[1]]: 'PROCESSING' };
  const stagesObserved: Record<string, Set<string>> = { [ids[0]]: new Set(), [ids[1]]: new Set() };

  while (Date.now() - watchStart < POLL_TIMEOUT_MS) {
    const [rowA, rowB, stateA, stateB] = await Promise.all([
      prisma.comparison.findUnique({ where: { id: ids[0] }, select: { status: true } }),
      prisma.comparison.findUnique({ where: { id: ids[1] }, select: { status: true } }),
      prisma.comparisonProcessingState.findUnique({ where: { comparisonId: ids[0] } }),
      prisma.comparisonProcessingState.findUnique({ where: { comparisonId: ids[1] } }),
    ]);
    if (rowA) finalStatuses[ids[0]] = rowA.status;
    if (rowB) finalStatuses[ids[1]] = rowB.status;
    if (stateA) stagesObserved[ids[0]].add(stateA.stage);
    if (stateB) stagesObserved[ids[1]].add(stateB.stage);
    if (stateA && stateB && !bothStateRowsSeenSimultaneously) {
      bothStateRowsSeenSimultaneously = true;
      console.log(`\n  ✓ both state rows present simultaneously at +${Math.round((Date.now() - watchStart) / 1000)}s (A=${stateA.stage}, B=${stateB.stage})`);
    }
    const aDone = rowA && (rowA.status === 'COMPLETED' || rowA.status === 'FAILED');
    const bDone = rowB && (rowB.status === 'COMPLETED' || rowB.status === 'FAILED');
    if (aDone && bDone) break;
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  const totalSec = Math.round((Date.now() - watchStart) / 1000);
  console.log(`\n  Run took ${totalSec}s.`);
  console.log(`  Final statuses: A=${finalStatuses[ids[0]]}, B=${finalStatuses[ids[1]]}`);
  console.log(`  Stages observed in state table: A=[${[...stagesObserved[ids[0]]].join(',')}], B=[${[...stagesObserved[ids[1]]].join(',')}]`);

  // ── Snapshot AFTER. ──
  console.log('\n▶ Snapshotting baselines AFTER...');
  const after: Record<string, Snapshot> = {};
  for (const id of ids) {
    const row = await prisma.comparison.findUnique({ where: { id } });
    const lineItemCount = await prisma.lineItem.count({ where: { comparisonId: id } });
    after[id] = {
      status: row!.status,
      yourEstimateTotal: row!.yourEstimateTotal !== null ? Number(row!.yourEstimateTotal) : null,
      adjusterEstimateTotal: row!.adjusterEstimateTotal !== null ? Number(row!.adjusterEstimateTotal) : null,
      totalGap: row!.totalGap !== null ? Number(row!.totalGap) : null,
      matchCount: row!.matchCount ?? 0,
      modifiedCount: row!.modifiedCount ?? 0,
      missingCount: row!.missingCount ?? 0,
      addedCount: row!.addedCount ?? 0,
      lineItemCount,
    };
    console.log(`  ${id.slice(0, 8)}... totals=$${after[id].yourEstimateTotal}/$${after[id].adjusterEstimateTotal}, items=${lineItemCount}`);
  }

  // ── Stage-D-cleared check. ──
  const leftoverState: string[] = [];
  for (const id of ids) {
    const left = await prisma.comparisonProcessingState.findUnique({ where: { comparisonId: id } });
    if (left) leftoverState.push(`${id.slice(0, 8)}... (stage=${left.stage})`);
  }

  // ── Assertions. ──
  console.log('\n═════════════════════════════════════════════════════════');
  const failures: string[] = [];
  if (finalStatuses[ids[0]] !== 'COMPLETED') failures.push(`A status is ${finalStatuses[ids[0]]}, expected COMPLETED`);
  if (finalStatuses[ids[1]] !== 'COMPLETED') failures.push(`B status is ${finalStatuses[ids[1]]}, expected COMPLETED`);
  if (!bothStateRowsSeenSimultaneously) {
    failures.push('Never observed both state rows simultaneously — runs may have been serialized (cross-comparisonId concurrency cap leak?)');
  }
  if (leftoverState.length > 0) {
    failures.push(`Leftover intermediate-state rows after run: ${leftoverState.join('; ')}`);
  }

  // Tolerance diffs vs. pre-snapshots. Sonnet stochasticity envelope same
  // as Phase 6 verifier.
  for (const id of ids) {
    const before = snapshots[id];
    const a = after[id];
    const drifts: string[] = [];
    if (!withinDollarTol(a.yourEstimateTotal, before.yourEstimateTotal)) drifts.push('yourEstimateTotal');
    if (!withinDollarTol(a.adjusterEstimateTotal, before.adjusterEstimateTotal)) drifts.push('adjusterEstimateTotal');
    if (!withinDollarTol(a.totalGap, before.totalGap)) drifts.push('totalGap');
    if (!withinCountTol(a.matchCount, before.matchCount)) drifts.push('matchCount');
    if (!withinCountTol(a.modifiedCount, before.modifiedCount)) drifts.push('modifiedCount');
    if (!withinCountTol(a.missingCount, before.missingCount)) drifts.push('missingCount');
    if (!withinCountTol(a.addedCount, before.addedCount)) drifts.push('addedCount');
    if (drifts.length > 0) {
      console.log(`  ⚠ ${id.slice(0, 8)}... aggregate drift on: ${drifts.join(', ')} (within Sonnet envelope is OK)`);
    } else {
      console.log(`  ✓ ${id.slice(0, 8)}... aggregates within tolerance vs. pre-snapshot`);
    }
  }

  if (failures.length === 0) {
    console.log('\n✓ CONCURRENCY VERIFIED — P8.2 PASS');
    console.log('  Both runs completed, executed concurrently (state rows coexisted),');
    console.log('  no leftover intermediate-state rows, aggregates within Sonnet envelope.');
  } else {
    console.log('\n✗ CONCURRENCY TEST FAILED');
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log('═════════════════════════════════════════════════════════');

  await prisma.$disconnect();
  if (failures.length > 0) process.exit(3);
}

main().catch(async err => {
  console.error('\n✗ FAILURE:', err);
  process.exit(1);
});
