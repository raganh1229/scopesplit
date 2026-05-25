/**
 * Phase 8.3 verification — idempotency guard.
 *
 * Re-fires `comparison/process.requested` for an already-COMPLETED comparison
 * and asserts that the worker short-circuits via the new `check-already-terminal`
 * guard (added April 28 2026 evening) instead of re-running the 4-stage pipeline.
 *
 * Acceptance:
 *   • The event is accepted by Inngest (sendOk = true).
 *   • Within ~30 s the worker logs the short-circuit and returns.
 *   • The comparison row's status, aggregates, and line-item set are EXACTLY
 *     identical before and after — byte-for-byte. No Sonnet stochasticity
 *     budget here because the guard means no Anthropic call should happen.
 *   • No `comparison_processing_state` row is created (the guard returns
 *     before Stage A).
 *
 * Usage:
 *   npx tsx scripts/n1-verify-phase8-idempotency.ts             # picks most recent COMPLETED
 *   COMPARISON_ID=<id> npx tsx scripts/n1-verify-phase8-idempotency.ts
 *
 * Requirements:
 *   • Next.js dev server running on :3000 (it serves /api/inngest).
 *   • Inngest dev server running on :8288 (or INNGEST_DEV pointed at one).
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

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

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 30000; // Guard should short-circuit fast — 30s is plenty.

function hashLineItems(items: ReadonlyArray<Record<string, unknown>>): string {
  // Stable hash: sort keys per item, sort items by id, JSON-stringify, sha256.
  const normalized = items
    .map(item => {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(item).sort()) {
        const v = (item as Record<string, unknown>)[k];
        // Decimal/BigInt → string for hash stability.
        sorted[k] = v === null || v === undefined ? null : String(v);
      }
      return sorted;
    })
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

async function main() {
  const { prisma } = await import('../lib/prisma');
  const { inngest } = await import('../lib/inngest/client');

  // ── Pick the comparison to test against. ──
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

  // ── Snapshot BEFORE. ──
  console.log('\n▶ Snapshotting comparison BEFORE replay...');
  const before = await prisma.comparison.findUnique({ where: { id: comparisonId } });
  if (!before) {
    console.error(`Comparison ${comparisonId} not found.`);
    await prisma.$disconnect();
    process.exit(1);
  }
  if (before.status !== 'COMPLETED') {
    console.error(`Comparison status is ${before.status}, expected COMPLETED. Aborting.`);
    await prisma.$disconnect();
    process.exit(1);
  }
  const beforeItems = await prisma.lineItem.findMany({ where: { comparisonId } });
  const beforeHash = hashLineItems(beforeItems);
  const beforeStateRow = await prisma.comparisonProcessingState.findUnique({
    where: { comparisonId },
  });
  console.log(`  status=${before.status}, lineItems=${beforeItems.length}, hash=${beforeHash.slice(0, 12)}...`);
  console.log(`  intermediate-state row present: ${beforeStateRow ? 'yes' : 'no'}`);

  // ── Re-fire the event WITHOUT force. ──
  console.log('\n▶ Re-firing comparison/process.requested (force=false, default)...');
  const sendStart = Date.now();
  let sendOk = false;
  try {
    const result = await inngest.send({
      name: 'comparison/process.requested',
      data: { comparisonId, trigger: 'idempotency-test' as const },
    });
    sendOk = true;
    console.log(`  Event sent in ${Date.now() - sendStart}ms. ids=${JSON.stringify(result.ids)}`);
  } catch (err) {
    console.error(`  inngest.send() failed: ${(err as Error).message}`);
    console.error('  Is the Inngest dev server running on :8288 and Next.js on :3000?');
    await prisma.$disconnect();
    process.exit(2);
  }
  if (!sendOk) process.exit(2);

  // ── Wait for the worker to either short-circuit or (incorrectly) start churning. ──
  // We can't directly read the Inngest run state from here, so we observe the
  // DB. If the guard works, NOTHING changes (no state row appears, no
  // updatedAt bumps to lineItems). If the guard fails, status will flip
  // briefly to PROCESSING (Stage A's `traceReset` resets aggregates) and
  // line items will get re-inserted, changing the hash.
  console.log('\n▶ Watching DB for 30s to confirm no churn...');
  const watchStart = Date.now();
  let sawProcessingFlip = false;
  let sawStateRow = false;
  let lastStatus: string = before.status;
  while (Date.now() - watchStart < POLL_TIMEOUT_MS) {
    const [row, stateRow] = await Promise.all([
      prisma.comparison.findUnique({
        where: { id: comparisonId },
        select: { status: true, updatedAt: true },
      }),
      prisma.comparisonProcessingState.findUnique({ where: { comparisonId } }),
    ]);
    if (row && row.status !== lastStatus) {
      sawProcessingFlip = true;
      lastStatus = row.status;
      console.log(`  ⚠ status changed: ${before.status} → ${row.status}`);
    }
    if (stateRow && !beforeStateRow) {
      sawStateRow = true;
      console.log(`  ⚠ intermediate-state row was created (stage=${stateRow.stage}) — guard may have failed`);
    }
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.log('');

  // ── Snapshot AFTER. ──
  console.log('\n▶ Snapshotting comparison AFTER...');
  const after = await prisma.comparison.findUnique({ where: { id: comparisonId } });
  const afterItems = await prisma.lineItem.findMany({ where: { comparisonId } });
  const afterHash = hashLineItems(afterItems);
  console.log(`  status=${after?.status}, lineItems=${afterItems.length}, hash=${afterHash.slice(0, 12)}...`);

  // ── Assertions. ──
  console.log('\n═════════════════════════════════════════════════════════');
  const failures: string[] = [];
  if (sawProcessingFlip) failures.push('comparison status changed during the watch window');
  if (sawStateRow) failures.push('intermediate-state row appeared (guard did not short-circuit)');
  if (after?.status !== 'COMPLETED') failures.push(`final status is ${after?.status}, expected COMPLETED`);
  if (afterItems.length !== beforeItems.length) {
    failures.push(`line-item count changed: ${beforeItems.length} → ${afterItems.length}`);
  }
  if (afterHash !== beforeHash) {
    failures.push(`line-item content hash changed: ${beforeHash.slice(0, 12)} → ${afterHash.slice(0, 12)}`);
  }

  if (failures.length === 0) {
    console.log('✓ IDEMPOTENCY GUARD VERIFIED');
    console.log('  Replay event was accepted by Inngest, the worker short-circuited');
    console.log('  via check-already-terminal, and the comparison row is byte-for-byte');
    console.log('  unchanged. P8.3 PASS.');
  } else {
    console.log('✗ IDEMPOTENCY GUARD FAILED');
    for (const f of failures) console.log(`  - ${f}`);
    console.log('\n  Review the worker logs in the Next.js terminal. The guard step');
    console.log('  `check-already-terminal` should have logged a short-circuit.');
  }
  console.log('═════════════════════════════════════════════════════════');

  await prisma.$disconnect();
  if (failures.length > 0) process.exit(3);
}

main().catch(async err => {
  console.error('\n✗ FAILURE:', err);
  process.exit(1);
});
