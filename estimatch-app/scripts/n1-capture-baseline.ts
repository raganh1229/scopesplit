/**
 * N1 Inngest Conversion — Phase 1 helper.
 *
 * Captures a complete JSON snapshot of one COMPLETED comparison:
 * comparison-level aggregates + all line items in a stable sort order.
 *
 * The output is written to the project-root `n1-baselines/` directory
 * under a filename `<label>--<comparisonId>.json`.
 *
 * This snapshot is the ground truth for verifying that the Inngest refactor
 * preserves behavior. After each refactor phase, we will regenerate the
 * comparison (on a fresh row, same PDFs) and diff against this snapshot.
 *
 * Usage:
 *   npx tsx scripts/n1-capture-baseline.ts <comparisonId> <label>
 *
 * Example:
 *   npx tsx scripts/n1-capture-baseline.ts abc12345-... small-residential
 */

// Load env files the same way Next.js does: .env first, then .env.local overrides.
// Standalone tsx scripts don't get Next.js's env loading for free.
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
loadEnv({ path: path.resolve(__dirname, '..', '.env') });
loadEnv({ path: path.resolve(__dirname, '..', '.env.local'), override: true });

import fs from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../app/generated/prisma/client';

if (!process.env.DATABASE_URL) {
  console.error(
    'DATABASE_URL is not set. Expected it in estimatch-app/.env.local. Aborting.'
  );
  process.exit(1);
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const BASELINE_DIR = path.resolve(__dirname, '..', '..', 'n1-baselines');

function usage(): never {
  console.error('Usage: npx tsx scripts/n1-capture-baseline.ts <comparisonId> <label>');
  console.error('');
  console.error('  <comparisonId>  UUID of a COMPLETED comparison in the dev DB');
  console.error('  <label>         Short kebab-case identifier, e.g. "small-residential"');
  process.exit(2);
}

async function main() {
  const [, , comparisonId, label] = process.argv;

  if (!comparisonId || !label) usage();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(label)) {
    console.error(`Invalid label "${label}" — must be lowercase kebab-case.`);
    process.exit(2);
  }

  const comparison = await prisma.comparison.findUnique({
    where: { id: comparisonId },
    select: {
      id: true,
      status: true,
      name: true,
      insuredName: true,
      claimNumber: true,
      propertyAddress: true,
      yourEstimateFilename: true,
      yourEstimateStoragePath: true,
      yourEstimateTotal: true,
      adjusterEstimateFilename: true,
      adjusterEstimateStoragePath: true,
      adjusterEstimateTotal: true,
      totalGap: true,
      matchCount: true,
      modifiedCount: true,
      missingCount: true,
      addedCount: true,
      errorMessage: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!comparison) {
    console.error(`Comparison ${comparisonId} not found.`);
    process.exit(1);
  }

  if (comparison.status !== 'COMPLETED') {
    console.error(
      `Comparison ${comparisonId} is in status ${comparison.status}, not COMPLETED. Refusing to capture.`
    );
    process.exit(1);
  }

  const lineItems = await prisma.lineItem.findMany({
    where: { comparisonId },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      matchStatus: true,
      zoneYours: true,
      zoneAdjuster: true,
      zoneCanonical: true,
      zoneConfidence: true,
      descriptionYours: true,
      descriptionAdjuster: true,
      qtyYours: true,
      qtyAdjuster: true,
      removeYours: true,
      removeAdjuster: true,
      replaceYours: true,
      replaceAdjuster: true,
      resetYours: true,
      resetAdjuster: true,
      taxYours: true,
      taxAdjuster: true,
      opYours: true,
      opAdjuster: true,
      totalYours: true,
      totalAdjuster: true,
      diffAmount: true,
      category: true,
      sortOrder: true,
      groupId: true,
    },
  });

  // Convert Decimals to plain strings to keep JSON diffs clean.
  const normalizedItems = lineItems.map((item) => {
    const out: Record<string, unknown> = { ...item };
    for (const key of [
      'removeYours',
      'removeAdjuster',
      'replaceYours',
      'replaceAdjuster',
      'resetYours',
      'resetAdjuster',
      'taxYours',
      'taxAdjuster',
      'opYours',
      'opAdjuster',
      'totalYours',
      'totalAdjuster',
      'diffAmount',
    ]) {
      const v = (item as unknown as Record<string, unknown>)[key];
      out[key] = v === null || v === undefined ? null : String(v);
    }
    return out;
  });

  const normalizedComparison = {
    ...comparison,
    yourEstimateTotal:
      comparison.yourEstimateTotal === null ? null : String(comparison.yourEstimateTotal),
    adjusterEstimateTotal:
      comparison.adjusterEstimateTotal === null ? null : String(comparison.adjusterEstimateTotal),
    totalGap: comparison.totalGap === null ? null : String(comparison.totalGap),
    createdAt: comparison.createdAt.toISOString(),
    updatedAt: comparison.updatedAt.toISOString(),
  };

  const snapshot = {
    _meta: {
      capturedAt: new Date().toISOString(),
      phase: 'phase-1-baseline',
      label,
      note: 'Baseline snapshot of a COMPLETED comparison. Do not modify — this is ground truth for N1 Inngest conversion verification.',
    },
    comparison: normalizedComparison,
    lineItems: normalizedItems,
    itemCount: normalizedItems.length,
  };

  if (!fs.existsSync(BASELINE_DIR)) {
    fs.mkdirSync(BASELINE_DIR, { recursive: true });
  }

  const filename = `${label}--${comparisonId}.json`;
  const filepath = path.join(BASELINE_DIR, filename);

  fs.writeFileSync(filepath, JSON.stringify(snapshot, null, 2));

  console.log(`Baseline captured:`);
  console.log(`  file:       ${filepath}`);
  console.log(`  label:      ${label}`);
  console.log(`  comparison: ${comparisonId}`);
  console.log(`  items:      ${normalizedItems.length}`);
  console.log(`  yours:      "${comparison.yourEstimateFilename}" ($${comparison.yourEstimateTotal ?? 0})`);
  console.log(`  adj:        "${comparison.adjusterEstimateFilename}" ($${comparison.adjusterEstimateTotal ?? 0})`);
  console.log(`  totals:     M:${comparison.matchCount} Mod:${comparison.modifiedCount} Miss:${comparison.missingCount} Add:${comparison.addedCount}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
