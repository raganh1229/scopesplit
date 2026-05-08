/**
 * Phase 8.6 / 8.7 stress-test monitor.
 *
 * Watches an in-flight comparison and records per-stage wall-clock timings
 * by polling the `comparison_processing_state` row. Used during 1K / 2K / 5K
 * line-item stress tests.
 *
 * Stage transitions tracked (state row contents at each phase):
 *   • null (no row)               — Stage A in flight (extract)
 *   • stage='extracted'           — Stage B in flight (reconcile-and-prematch)
 *   • stage='prematched'          — Stage C in flight (pair)
 *   • stage='paired'              — Stage D in flight (finalize-and-persist)
 *   • null + status=COMPLETED     — done
 *   • null + status=FAILED        — failed
 *
 * Usage (after kicking off an upload through the UI):
 *   npx tsx scripts/n1-monitor-stress-test.ts [label]
 *   COMPARISON_ID=<id> npx tsx scripts/n1-monitor-stress-test.ts [label]
 *
 * `label` (optional) tags the saved JSON output, e.g. "stress-1k".
 *
 * Auto-detect mode picks the most recently-created `PROCESSING` comparison,
 * so kick off the upload first, then run this within ~5 seconds.
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

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour — generous for 5K stress

type Phase = 'stage-a-extract' | 'stage-b-prematch' | 'stage-c-pair' | 'stage-d-finalize' | 'pre-extract' | 'done';

type PhaseRecord = {
  phase: Phase;
  startedAt: number; // ms since monitor start
  durationMs?: number;
};

async function main() {
  const label = process.argv[2] ?? 'stress-test';
  const { prisma } = await import('../lib/prisma');

  // ── Pick the comparison. ──
  const explicitId = process.env.COMPARISON_ID?.trim();
  let comparisonId: string;
  if (explicitId) {
    comparisonId = explicitId;
    console.log(`Using COMPARISON_ID from env: ${comparisonId}`);
  } else {
    const recent = await prisma.comparison.findFirst({
      where: { status: 'PROCESSING' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true },
    });
    if (!recent) {
      console.error('No PROCESSING comparison found. Kick off an upload through the UI first, then re-run within ~5 seconds.');
      console.error('Or set COMPARISON_ID=<id> manually.');
      await prisma.$disconnect();
      process.exit(1);
    }
    const ageSec = Math.round((Date.now() - new Date(recent.createdAt).getTime()) / 1000);
    comparisonId = recent.id;
    console.log(`Auto-detected newest PROCESSING comparison: ${comparisonId}`);
    console.log(`  (created ${ageSec}s ago)`);
  }

  // ── Initial snapshot. ──
  const initial = await prisma.comparison.findUnique({ where: { id: comparisonId } });
  if (!initial) {
    console.error(`Comparison ${comparisonId} not found.`);
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log(`\nLabel: ${label}`);
  console.log(`Comparison created at: ${initial.createdAt.toISOString()}`);
  console.log(`Initial status: ${initial.status}`);
  console.log('');

  // ── Phase tracker. ──
  const monitorStart = Date.now();
  const phases: PhaseRecord[] = [];
  let currentPhase: Phase | null = null;

  function transitionTo(phase: Phase) {
    const now = Date.now();
    if (phases.length > 0) {
      phases[phases.length - 1].durationMs = now - (monitorStart + phases[phases.length - 1].startedAt);
    }
    phases.push({ phase, startedAt: now - monitorStart });
    currentPhase = phase;
    const elapsedSec = Math.round((now - monitorStart) / 1000);
    console.log(`  [+${elapsedSec.toString().padStart(4, ' ')}s] → ${phase}`);
  }

  // Initial phase based on current state:
  const initialState = await prisma.comparisonProcessingState.findUnique({
    where: { comparisonId },
  });
  if (!initialState) {
    transitionTo('pre-extract');
  } else {
    const map: Record<string, Phase> = {
      extracted: 'stage-b-prematch',
      prematched: 'stage-c-pair',
      paired: 'stage-d-finalize',
    };
    const initPhase = map[initialState.stage] ?? 'pre-extract';
    transitionTo(initPhase);
  }

  // ── Poll loop. ──
  console.log('Watching... (Ctrl+C to abort)');
  let finalStatus = 'PROCESSING';
  let finalRow: Awaited<ReturnType<typeof prisma.comparison.findUnique>> = null;
  const phaseFromState = (state: string | undefined | null, status: string): Phase => {
    if (status === 'COMPLETED' || status === 'FAILED') return 'done';
    if (!state) {
      // Could be pre-extract OR Stage D in flight with state already cleared.
      // Distinguish by the previous phase: if we've been past stage-c-pair,
      // we're in the brief stage-d window; otherwise still in pre-extract.
      if (currentPhase && (currentPhase === 'stage-c-pair' || currentPhase === 'stage-d-finalize')) {
        return 'stage-d-finalize';
      }
      return 'pre-extract';
    }
    if (state === 'extracted') return 'stage-b-prematch';
    if (state === 'prematched') return 'stage-c-pair';
    if (state === 'paired') return 'stage-d-finalize';
    return 'pre-extract';
  };

  while (Date.now() - monitorStart < POLL_TIMEOUT_MS) {
    const [row, state] = await Promise.all([
      prisma.comparison.findUnique({ where: { id: comparisonId } }),
      prisma.comparisonProcessingState.findUnique({ where: { comparisonId } }),
    ]);
    if (!row) throw new Error(`Comparison ${comparisonId} disappeared mid-run.`);
    finalRow = row;
    finalStatus = row.status;

    const inferred = phaseFromState(state?.stage, row.status);
    if (inferred !== currentPhase) {
      transitionTo(inferred);
    }
    if (row.status === 'COMPLETED' || row.status === 'FAILED') break;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Close out the final phase duration.
  if (phases.length > 0 && phases[phases.length - 1].durationMs === undefined) {
    phases[phases.length - 1].durationMs = Date.now() - (monitorStart + phases[phases.length - 1].startedAt);
  }

  const totalMs = Date.now() - monitorStart;
  const totalSec = Math.round(totalMs / 1000);
  const lineItemCount = await prisma.lineItem.count({ where: { comparisonId } });

  console.log('\n═════════════════════════════════════════════════════════');
  console.log(`Final status: ${finalStatus} after ${totalSec}s (${(totalMs / 60000).toFixed(1)} min)`);
  console.log(`Line items: ${lineItemCount}`);
  if (finalRow) {
    console.log(`Aggregates:`);
    console.log(`  yourEstimateTotal:     $${finalRow.yourEstimateTotal}`);
    console.log(`  adjusterEstimateTotal: $${finalRow.adjusterEstimateTotal}`);
    console.log(`  totalGap:              $${finalRow.totalGap}`);
    console.log(`  match/mod/miss/add:    ${finalRow.matchCount}/${finalRow.modifiedCount}/${finalRow.missingCount}/${finalRow.addedCount}`);
    if (finalRow.errorMessage) {
      console.log(`Error: ${finalRow.errorMessage}`);
    }
  }
  console.log('\nPer-phase timings:');
  for (const p of phases) {
    const dur = p.durationMs !== undefined ? `${(p.durationMs / 1000).toFixed(1)}s` : 'n/a';
    console.log(`  ${p.phase.padEnd(20, ' ')} ${dur.padStart(8, ' ')}  (started at +${(p.startedAt / 1000).toFixed(1)}s)`);
  }
  console.log('═════════════════════════════════════════════════════════');

  // ── Save to JSON. ──
  const outDir = path.resolve(__dirname, '..', '..', 'n1-stress-results');
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `${label}--${ts}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    label,
    comparisonId,
    capturedAt: new Date().toISOString(),
    finalStatus,
    totalMs,
    lineItemCount,
    aggregates: finalRow ? {
      yourEstimateTotal: finalRow.yourEstimateTotal !== null ? Number(finalRow.yourEstimateTotal) : null,
      adjusterEstimateTotal: finalRow.adjusterEstimateTotal !== null ? Number(finalRow.adjusterEstimateTotal) : null,
      totalGap: finalRow.totalGap !== null ? Number(finalRow.totalGap) : null,
      matchCount: finalRow.matchCount,
      modifiedCount: finalRow.modifiedCount,
      missingCount: finalRow.missingCount,
      addedCount: finalRow.addedCount,
    } : null,
    errorMessage: finalRow?.errorMessage ?? null,
    phases,
  }, null, 2));
  console.log(`\nResults saved: ${outFile}`);

  await prisma.$disconnect();
  if (finalStatus !== 'COMPLETED') process.exit(3);
}

main().catch(async err => {
  console.error('\n✗ FAILURE:', err);
  process.exit(1);
});
