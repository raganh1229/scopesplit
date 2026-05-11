import { config } from 'dotenv';
import * as path from 'node:path';
config({ path: path.resolve(__dirname, '../.env.local'), override: true });

import { PrismaClient } from '../app/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const pool   = new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
const CID    = 'c382d5dc-f5a3-42a2-9a56-11c753c65d65';

async function main() {
  const comp = await prisma.comparison.findUnique({
    where: { id: CID },
    select: {
      status: true, matchCount: true, modifiedCount: true,
      missingCount: true, addedCount: true,
      yourEstimateTotal: true, adjusterEstimateTotal: true, totalGap: true,
    },
  });
  console.log('\n══════════════ V3 RUN SUMMARY ══════════════');
  console.log('CID     :', CID);
  console.log('Status  :', comp?.status);
  console.log('MATCH   :', comp?.matchCount,   '  (expected 116)');
  console.log('MODIFIED:', comp?.modifiedCount, '  (expected 19)');
  console.log('MISSING :', comp?.missingCount,  '  (expected 15)');
  console.log('ADDED   :', comp?.addedCount,    '  (expected 10)');
  console.log('Contractor $:', comp?.yourEstimateTotal?.toString(),      '  (expected 168982.18)');
  console.log('Adjuster $  :', comp?.adjusterEstimateTotal?.toString(),  '  (expected 141286.50)');
  console.log('Gap $       :', comp?.totalGap?.toString(),               '  (expected -27695.68)');

  const items = await prisma.lineItem.findMany({
    where: { comparisonId: CID },
    select: {
      matchStatus: true,
      descriptionYours: true, descriptionAdjuster: true,
      zoneYours: true, zoneAdjuster: true,
      totalYours: true, totalAdjuster: true,
    },
    orderBy: [{ matchStatus: 'asc' }, { zoneYours: 'asc' }],
  });

  const byStatus: Record<string, typeof items> = {};
  for (const i of items) { (byStatus[i.matchStatus] ??= []).push(i); }

  for (const [status, grp] of Object.entries(byStatus)) {
    console.log(`\n── ${status} (${grp.length}) ─────────────────────────────────────`);
    for (const i of grp) {
      const yd = (i.descriptionYours     ?? '*(none)*').slice(0, 50).padEnd(50);
      const ad = (i.descriptionAdjuster   ?? '*(none)*').slice(0, 50).padEnd(50);
      const yz = (i.zoneYours     ?? '').slice(0, 22).padEnd(22);
      const az = (i.zoneAdjuster ?? '').slice(0, 22).padEnd(22);
      const ya = i.totalYours     ? Number(i.totalYours).toFixed(2).padStart(9)  : '      n/a';
      const aa = i.totalAdjuster  ? Number(i.totalAdjuster).toFixed(2).padStart(9) : '      n/a';
      console.log(`  [C] ${yd}  zone: ${yz}  $${ya}`);
      console.log(`  [A] ${ad}  zone: ${az}  $${aa}`);
      console.log();
    }
  }

  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
