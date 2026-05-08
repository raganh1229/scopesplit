/**
 * N1 Inngest Conversion — Phase 1 helper.
 *
 * Lists all COMPLETED comparisons in the dev DB, ordered newest-first,
 * with line-item counts and per-side totals. Use the output to pick
 * 2–3 representative comparisons to snapshot as baselines.
 *
 * Usage:
 *   npx tsx scripts/n1-list-baseline-candidates.ts
 */

// Load env files the same way Next.js does: .env first, then .env.local overrides.
// Standalone tsx scripts don't get Next.js's env loading for free.
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
loadEnv({ path: path.resolve(__dirname, '..', '.env') });
loadEnv({ path: path.resolve(__dirname, '..', '.env.local'), override: true });

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

async function main() {
  const completed = await prisma.comparison.findMany({
    where: { status: 'COMPLETED' },
    orderBy: { createdAt: 'desc' },
    take: 25,
    select: {
      id: true,
      createdAt: true,
      name: true,
      yourEstimateFilename: true,
      adjusterEstimateFilename: true,
      yourEstimateTotal: true,
      adjusterEstimateTotal: true,
      totalGap: true,
      matchCount: true,
      modifiedCount: true,
      missingCount: true,
      addedCount: true,
      _count: { select: { lineItems: true } },
    },
  });

  if (completed.length === 0) {
    console.log('No COMPLETED comparisons found in the dev DB.');
    console.log('');
    console.log('To create baselines, upload 2–3 PDF pairs through the UI');
    console.log('(npm run dev → http://localhost:3000/app/new-comparison)');
    console.log('and wait for each to reach COMPLETED status.');
    return;
  }

  console.log(`Found ${completed.length} COMPLETED comparisons (newest first):`);
  console.log('');

  for (const c of completed) {
    const size = c._count.lineItems;
    const sizeBucket =
      size >= 300 ? 'LARGE' : size >= 100 ? 'MEDIUM' : size >= 20 ? 'SMALL' : 'TINY';
    console.log(
      `[${sizeBucket.padEnd(6)}] ${c.id}  |  ${size.toString().padStart(4)} items  |  ${c.createdAt.toISOString().slice(0, 10)}`
    );
    console.log(
      `           yours: "${c.yourEstimateFilename}" ($${c.yourEstimateTotal ?? 0})`
    );
    console.log(
      `           adj:   "${c.adjusterEstimateFilename}" ($${c.adjusterEstimateTotal ?? 0})`
    );
    console.log(
      `           M:${c.matchCount} Mod:${c.modifiedCount} Miss:${c.missingCount} Add:${c.addedCount}  |  gap: $${c.totalGap ?? 0}`
    );
    console.log('');
  }

  console.log('');
  console.log('RECOMMENDED SELECTION for N1 baselines:');
  console.log(
    '  • one SMALL/TINY  (quick iteration, residential-scale)'
  );
  console.log(
    '  • one MEDIUM       (representative typical use)'
  );
  console.log(
    '  • one LARGE        (stress test — payload size + pipeline duration)'
  );
  console.log('');
  console.log('To capture a baseline, run:');
  console.log(
    '  npx tsx scripts/n1-capture-baseline.ts <comparisonId> <label>'
  );
  console.log('');
  console.log('  where <label> is a short kebab-case name like "small-residential"');
  console.log('');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
