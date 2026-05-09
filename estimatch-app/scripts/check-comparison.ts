import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';
dotenvConfig({ path: path.resolve(__dirname, '../.env.local'), override: true });

import { PrismaClient } from '../app/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const pool    = new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } });
const adapter = new PrismaPg(pool);
const prisma  = new PrismaClient({ adapter });

const COMPARISON_ID = process.argv[2];

async function main() {
  if (!COMPARISON_ID) { console.error('Usage: npx tsx scripts/check-comparison.ts <id>'); process.exit(1); }

  const c = await prisma.comparison.findUnique({
    where:  { id: COMPARISON_ID },
    select: {
      status: true, pipelineVersion: true, errorMessage: true,
      matchCount: true, modifiedCount: true, missingCount: true, addedCount: true,
      yourEstimateTotal: true, adjusterEstimateTotal: true, totalGap: true,
    },
  });

  if (!c) { console.error('Comparison not found'); process.exit(1); }

  console.log('\n── Comparison', COMPARISON_ID, '──');
  console.log('  Status         :', c.status);
  console.log('  Pipeline       :', c.pipelineVersion);
  if (c.errorMessage) console.log('  Error          :', c.errorMessage);
  console.log('  match          :', c.matchCount);
  console.log('  modified       :', c.modifiedCount);
  console.log('  missing        :', c.missingCount);
  console.log('  added          :', c.addedCount);
  console.log('  contractor $   :', c.yourEstimateTotal?.toString() ?? '—');
  console.log('  adjuster $     :', c.adjusterEstimateTotal?.toString() ?? '—');
  console.log('  gap $          :', c.totalGap?.toString() ?? '—');

  const zones = await prisma.n3Zone.findMany({
    where:  { comparisonId: COMPARISON_ID },
    select: { source: true, name: true, normalizedName: true },
  });
  if (zones.length) {
    console.log('\n── N3 Zones ──');
    for (const z of zones) console.log(`  [${z.source}] ${z.name} → ${z.normalizedName ?? '?'}`);
  }

  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
