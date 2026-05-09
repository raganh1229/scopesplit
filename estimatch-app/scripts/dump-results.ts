import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';
dotenvConfig({ path: path.resolve(__dirname, '../.env.local'), override: true });

import { PrismaClient } from '../app/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const pool    = new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } });
const prisma  = new PrismaClient({ adapter: new PrismaPg(pool) });

const CID = process.argv[2];

async function main() {
  if (!CID) { console.error('Usage: npx tsx scripts/dump-results.ts <id>'); process.exit(1); }

  const items = await prisma.lineItem.findMany({
    where:  { comparisonId: CID },
    select: {
      matchStatus: true,
      zoneYours: true,
      zoneAdjuster: true,
      descriptionYours: true,
      descriptionAdjuster: true,
      qtyYours: true,
      qtyAdjuster: true,
      unitYours: true,
      totalYours: true,
      totalAdjuster: true,
      diffAmount: true,
      sortOrder: true,
    },
    orderBy: [{ zoneYours: 'asc' }, { sortOrder: 'asc' }],
  });

  console.log(`\nTotal line items: ${items.length}\n`);

  let curZone = '';
  for (const it of items) {
    const zone = it.zoneYours ?? it.zoneAdjuster ?? '(unknown)';
    if (zone !== curZone) {
      curZone = zone;
      console.log(`\n═══ ${zone} ═══`);
    }
    const cDesc = (it.descriptionYours ?? '(none)').slice(0, 48).padEnd(48);
    const aDesc = (it.descriptionAdjuster ?? '(none)').slice(0, 48).padEnd(48);
    const status = it.matchStatus.padEnd(22);
    const cTotal = (it.totalYours?.toString() ?? '—').padStart(10);
    const aTotal = (it.totalAdjuster?.toString() ?? '—').padStart(10);
    const diff   = (it.diffAmount?.toString() ?? '—').padStart(10);
    console.log(`  [${status}] C: ${cDesc}  A: ${aDesc}  C$:${cTotal}  A$:${aTotal}  diff:${diff}`);
  }

  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
