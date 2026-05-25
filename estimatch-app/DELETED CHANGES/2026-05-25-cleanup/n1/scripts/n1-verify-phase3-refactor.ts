/**
 * Phase 3 verification — re-run a baseline comparison through the refactored
 * 4-stage pipeline and diff aggregates against the captured baseline.
 *
 * Usage:
 *   npx tsx scripts/n1-verify-phase3-refactor.ts <baseline-label>
 *
 * Where <baseline-label> is one of:
 *   - small-set8
 *   - medium-set12-mod-heavy
 *   - large-set10-add-heavy
 *
 * This script re-processes the comparison (calls Anthropic API!) using the
 * NEW 4-stage pipeline and compares the resulting DB state to the baseline
 * JSON. LLM outputs are non-deterministic, so we tolerate small variations
 * but flag aggregate dollar discrepancies > 0.5% and count mismatches > 2.
 *
 * IMPORTANT: This OVERWRITES line items for the comparison being verified.
 * The baseline JSON file on disk is the source of truth and is not touched.
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import fs from 'node:fs/promises';

loadEnv({ path: path.resolve(__dirname, '..', '.env') });
loadEnv({ path: path.resolve(__dirname, '..', '.env.local'), override: true });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing. Aborting.');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY missing. Aborting.');
  process.exit(1);
}
// Force real processing on for this script — the baseline was captured with it on.
process.env.ENABLE_REAL_COMPARISON_PROCESSING = 'true';

const BASELINE_DIR = path.resolve(__dirname, '..', '..', 'n1-baselines');

type BaselineComparison = {
  id: string;
  yourEstimateTotal: string | null;
  adjusterEstimateTotal: string | null;
  totalGap: string | null;
  matchCount: number;
  modifiedCount: number;
  missingCount: number;
  addedCount: number;
};

type BaselineFile = {
  _meta: { label: string };
  comparison: BaselineComparison;
  lineItems: Array<{ matchStatus: string }>;
};

function approxEqual(a: number, b: number, tolPct: number, tolAbs: number): boolean {
  const diff = Math.abs(a - b);
  const tol = Math.max(tolAbs, Math.abs(a) * tolPct);
  return diff <= tol;
}

async function findBaselineByLabel(label: string): Promise<{ filePath: string; data: BaselineFile }> {
  const files = await fs.readdir(BASELINE_DIR);
  const match = files.find(f => f.startsWith(`${label}--`) && f.endsWith('.json'));
  if (!match) {
    throw new Error(`No baseline file found for label '${label}' in ${BASELINE_DIR}`);
  }
  const filePath = path.join(BASELINE_DIR, match);
  const raw = await fs.readFile(filePath, 'utf8');
  return { filePath, data: JSON.parse(raw) as BaselineFile };
}

async function main() {
  const label = process.argv[2];
  if (!label) {
    console.error('Usage: npx tsx scripts/n1-verify-phase3-refactor.ts <baseline-label>');
    process.exit(1);
  }

  console.log(`\n=== Phase 3 Refactor Verification: ${label} ===\n`);

  const { filePath, data: baseline } = await findBaselineByLabel(label);
  console.log(`Loaded baseline: ${filePath}`);
  console.log(`Comparison ID:   ${baseline.comparison.id}`);
  console.log(`Baseline aggregates:`);
  console.log(`  yourEstimateTotal:     $${baseline.comparison.yourEstimateTotal}`);
  console.log(`  adjusterEstimateTotal: $${baseline.comparison.adjusterEstimateTotal}`);
  console.log(`  totalGap:              $${baseline.comparison.totalGap}`);
  console.log(`  matchCount:            ${baseline.comparison.matchCount}`);
  console.log(`  modifiedCount:         ${baseline.comparison.modifiedCount}`);
  console.log(`  missingCount:          ${baseline.comparison.missingCount}`);
  console.log(`  addedCount:            ${baseline.comparison.addedCount}`);
  console.log(`  total lineItems:       ${baseline.lineItems.length}\n`);

  // Dynamic imports — env must be set first.
  const { prisma } = await import('../lib/prisma');
  const { runComparisonProcessing } = await import('../lib/comparison-processing');

  console.log('▶ Calling runComparisonProcessing via NEW 4-stage pipeline...');
  console.log('  (this hits the Anthropic API — expect 30–90 seconds)\n');

  const t0 = Date.now();
  let runResult: Awaited<ReturnType<typeof runComparisonProcessing>>;
  try {
    runResult = await runComparisonProcessing(baseline.comparison.id, {
      trigger: 'manual-route',
    });
  } catch (err) {
    console.error('\n✗ runComparisonProcessing THREW:', err);
    await prisma.$disconnect();
    process.exit(1);
  }
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n▶ Pipeline completed in ${elapsedSec}s. Result:`, runResult);

  // Read the new DB state
  const updated = await prisma.comparison.findUnique({
    where: { id: baseline.comparison.id },
    select: {
      yourEstimateTotal: true,
      adjusterEstimateTotal: true,
      totalGap: true,
      matchCount: true,
      modifiedCount: true,
      missingCount: true,
      addedCount: true,
    },
  });
  if (!updated) {
    console.error('Comparison row vanished after processing??');
    await prisma.$disconnect();
    process.exit(1);
  }

  const newLineItemCount = await prisma.lineItem.count({
    where: { comparisonId: baseline.comparison.id },
  });

  console.log('\n▶ NEW pipeline aggregates:');
  console.log(`  yourEstimateTotal:     $${updated.yourEstimateTotal}`);
  console.log(`  adjusterEstimateTotal: $${updated.adjusterEstimateTotal}`);
  console.log(`  totalGap:              $${updated.totalGap}`);
  console.log(`  matchCount:            ${updated.matchCount}`);
  console.log(`  modifiedCount:         ${updated.modifiedCount}`);
  console.log(`  missingCount:          ${updated.missingCount}`);
  console.log(`  addedCount:            ${updated.addedCount}`);
  console.log(`  total lineItems:       ${newLineItemCount}\n`);

  // ── Compare against baseline ──────────────────────────────────────────
  const issues: string[] = [];
  const warnings: string[] = [];

  // Dollar amounts: tolerate 0.5% drift or $10 absolute (whichever is larger)
  const compareDollar = (name: string, base: string | null, now: unknown) => {
    const baseN = base !== null ? Number(base) : 0;
    const nowN = now !== null && now !== undefined ? Number(now as string) : 0;
    if (!approxEqual(baseN, nowN, 0.005, 10)) {
      issues.push(`${name}: baseline=${baseN.toFixed(2)} new=${nowN.toFixed(2)} delta=${(nowN - baseN).toFixed(2)}`);
    } else if (Math.abs(baseN - nowN) > 0.01) {
      warnings.push(`${name}: minor drift baseline=${baseN.toFixed(2)} new=${nowN.toFixed(2)} delta=${(nowN - baseN).toFixed(2)}`);
    }
  };
  compareDollar('yourEstimateTotal', baseline.comparison.yourEstimateTotal, updated.yourEstimateTotal);
  compareDollar('adjusterEstimateTotal', baseline.comparison.adjusterEstimateTotal, updated.adjusterEstimateTotal);
  compareDollar('totalGap', baseline.comparison.totalGap, updated.totalGap);

  // Counts: tolerate ±2 items, flag ±3 or more
  const compareCount = (name: string, base: number, now: number) => {
    const delta = now - base;
    if (Math.abs(delta) > 2) {
      issues.push(`${name}: baseline=${base} new=${now} delta=${delta > 0 ? '+' : ''}${delta}`);
    } else if (delta !== 0) {
      warnings.push(`${name}: minor drift baseline=${base} new=${now} delta=${delta > 0 ? '+' : ''}${delta}`);
    }
  };
  compareCount('matchCount', baseline.comparison.matchCount, updated.matchCount);
  compareCount('modifiedCount', baseline.comparison.modifiedCount, updated.modifiedCount);
  compareCount('missingCount', baseline.comparison.missingCount, updated.missingCount);
  compareCount('addedCount', baseline.comparison.addedCount, updated.addedCount);
  compareCount('total lineItems', baseline.lineItems.length, newLineItemCount);

  // ── Report ────────────────────────────────────────────────────────────
  console.log('═════════════════════════════════════════════════════════');
  if (issues.length === 0 && warnings.length === 0) {
    console.log(`✓ EXACT MATCH — no aggregate drift at all.`);
  } else if (issues.length === 0) {
    console.log(`✓ PASS (within tolerance) — ${warnings.length} minor drift(s):`);
    for (const w of warnings) console.log(`  ! ${w}`);
    console.log(`\n  Minor drift is expected from LLM non-determinism. Phase 3 verified.`);
  } else {
    console.log(`✗ FAIL — ${issues.length} aggregate(s) outside tolerance:`);
    for (const i of issues) console.log(`  ✗ ${i}`);
    if (warnings.length > 0) {
      console.log(`\n  Plus ${warnings.length} minor drift(s):`);
      for (const w of warnings) console.log(`  ! ${w}`);
    }
    console.log(`\n  This may indicate a refactor regression. INVESTIGATE before proceeding.`);
  }
  console.log('═════════════════════════════════════════════════════════');

  await prisma.$disconnect();
  process.exit(issues.length === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('FAILURE:', err);
  process.exit(1);
});
