import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';
dotenvConfig({ path: path.resolve(__dirname, '../.env.local'), override: true });

import { PrismaClient } from '../app/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const prisma = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } })) });

async function main() {
const items = await prisma.n3LineItem.findMany({
  where: {
    comparisonId: '91e1466e-61d5-4309-9f6a-840ebce774b8',
    rawDescription: { contains: 'Soffit', mode: 'insensitive' },
  },
  include: { zone: true },
});

console.log('\n=== SOFFIT ITEMS (N3 extraction) ===\n');
items.forEach(i => {
  console.log(`${i.source.toUpperCase()}: ${i.rawDescription}`);
  console.log(`  Qty: ${i.rawQuantity} ${i.rawUnit}`);
  console.log(`  Total: $${Number(i.totalAmount ?? 0).toFixed(2)}`);
  console.log(`  Zone: ${i.zone?.name}`);
  console.log('');
});

const persisted = await prisma.lineItem.findMany({
  where: {
    comparisonId: '91e1466e-61d5-4309-9f6a-840ebce774b8',
    OR: [
      { descriptionYours: { contains: 'Soffit', mode: 'insensitive' } },
      { descriptionAdjuster: { contains: 'Soffit', mode: 'insensitive' } },
    ],
  },
});

console.log('=== SOFFIT ITEMS (persisted) ===\n');
persisted.forEach(p => {
  console.log(`Match Status: ${p.matchStatus}`);
  console.log(`Yours: ${p.descriptionYours} | ${p.qtyYours} | $${Number(p.totalYours ?? 0).toFixed(2)}`);
  console.log(`Adj:   ${p.descriptionAdjuster} | ${p.qtyAdjuster} | $${Number(p.totalAdjuster ?? 0).toFixed(2)}`);
  console.log('');
});

await prisma.$disconnect();
}

main().catch(console.error);
