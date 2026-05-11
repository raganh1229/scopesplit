import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';
dotenvConfig({ path: path.resolve(__dirname, '../.env.local'), override: true });

import { PrismaClient } from '../app/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const prisma = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } })) });

async function main() {
  const items = await prisma.n3LineItem.findMany({
    where: { comparisonId: '91e1466e-61d5-4309-9f6a-840ebce774b8' },
    include: { zone: true },
  });

  const yours = items.filter(i => i.source === 'yours');
  const adj = items.filter(i => i.source === 'adjuster');

  console.log('\n=== EXTRACTION TOTALS ===');
  console.log(`Contractor: ${yours.length} (expected 151, missing ${151 - yours.length})`);
  console.log(`Adjuster:   ${adj.length} (expected 146, missing ${146 - adj.length})`);
  console.log(`Total:      ${items.length} (expected 297, missing ${297 - items.length})`);

  const yoursByZone = yours.reduce((acc, i) => {
    const z = i.zone?.name ?? 'NO_ZONE';
    acc[z] = (acc[z] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const adjByZone = adj.reduce((acc, i) => {
    const z = i.zone?.name ?? 'NO_ZONE';
    acc[z] = (acc[z] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  console.log('\n=== BY ZONE (Contractor) ===');
  Object.entries(yoursByZone).sort((a, b) => a[0].localeCompare(b[0])).forEach(([zone, count]) => {
    console.log(`  ${zone}: ${count}`);
  });

  console.log('\n=== BY ZONE (Adjuster) ===');
  Object.entries(adjByZone).sort((a, b) => a[0].localeCompare(b[0])).forEach(([zone, count]) => {
    console.log(`  ${zone}: ${count}`);
  });

  await prisma.$disconnect();
}

main().catch(console.error);
