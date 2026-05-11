/**
 * investigate-v4-items.ts —查看特定项目的提取结果
 */
import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';
dotenvConfig({ path: path.resolve(__dirname, '../.env.local'), override: true });

import { PrismaClient } from '../app/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const prisma = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } })) });
const CID = process.argv[2];

async function main() {
  if (!CID) { console.error('Usage: npx tsx scripts/investigate-v4-items.ts <comparison_id>'); process.exit(1); }

  // Query items matching "General laborer" / "General helper labor"
  const laborItems = await prisma.n3LineItem.findMany({
    where: {
      comparisonId: CID,
      OR: [
        { rawDescription: { contains: 'General laborer', mode: 'insensitive' } },
        { rawDescription: { contains: 'General helper labor', mode: 'insensitive' } },
      ],
    },
    include: { zone: true },
  });

  console.log('\n=== GENERAL LABORER / HELPER LABOR ===\n');
  for (const item of laborItems) {
    console.log(`Source: ${item.source}`);
    console.log(`Zone: ${item.zone?.name ?? 'NO ZONE'}`);
    console.log(`Description: ${item.rawDescription}`);
    console.log(`Quantity: ${item.rawQuantity}`);
    console.log(`Unit: ${item.rawUnit}`);
    console.log(`Total: $${Number(item.totalAmount ?? 0).toFixed(2)}`);
    console.log(`---`);
  }

  // Query items matching "Project supervision" / "Construction supervision"
  const supervisionItems = await prisma.n3LineItem.findMany({
    where: {
      comparisonId: CID,
      OR: [
        { rawDescription: { contains: 'Project supervision', mode: 'insensitive' } },
        { rawDescription: { contains: 'Construction supervision', mode: 'insensitive' } },
      ],
    },
    include: { zone: true },
  });

  console.log('\n=== PROJECT / CONSTRUCTION SUPERVISION ===\n');
  for (const item of supervisionItems) {
    console.log(`Source: ${item.source}`);
    console.log(`Zone: ${item.zone?.name ?? 'NO ZONE'}`);
    console.log(`Description: ${item.rawDescription}`);
    console.log(`Quantity: ${item.rawQuantity}`);
    console.log(`Unit: ${item.rawUnit}`);
    console.log(`Total: $${Number(item.totalAmount ?? 0).toFixed(2)}`);
    console.log(`---`);
  }

  // Check their match status in persisted items
  const persistedLabor = await prisma.lineItem.findMany({
    where: {
      comparisonId: CID,
      OR: [
        { descriptionYours: { contains: 'General laborer', mode: 'insensitive' } },
        { descriptionAdjuster: { contains: 'General helper labor', mode: 'insensitive' } },
      ],
    },
    select: {
      matchStatus: true,
      descriptionYours: true,
      descriptionAdjuster: true,
      qtyYours: true,
      qtyAdjuster: true,
      totalYours: true,
      totalAdjuster: true,
    },
  });

  console.log('\n=== PERSISTED LABORER ITEM ===\n');
  for (const item of persistedLabor) {
    console.log(`Match Status: ${item.matchStatus}`);
    console.log(`Yours Desc: ${item.descriptionYours}`);
    console.log(`Adj Desc: ${item.descriptionAdjuster}`);
    console.log(`Yours Qty: ${item.qtyYours}`);
    console.log(`Adj Qty: ${item.qtyAdjuster}`);
    console.log(`Yours Total: $${Number(item.totalYours ?? 0).toFixed(2)}`);
    console.log(`Adj Total: $${Number(item.totalAdjuster ?? 0).toFixed(2)}`);
    console.log(`---`);
  }

  const persistedSupervision = await prisma.lineItem.findMany({
    where: {
      comparisonId: CID,
      OR: [
        { descriptionYours: { contains: 'Project supervision', mode: 'insensitive' } },
        { descriptionAdjuster: { contains: 'Construction supervision', mode: 'insensitive' } },
      ],
    },
    select: {
      matchStatus: true,
      descriptionYours: true,
      descriptionAdjuster: true,
      qtyYours: true,
      qtyAdjuster: true,
      totalYours: true,
      totalAdjuster: true,
    },
  });

  console.log('\n=== PERSISTED SUPERVISION ITEM ===\n');
  for (const item of persistedSupervision) {
    console.log(`Match Status: ${item.matchStatus}`);
    console.log(`Yours Desc: ${item.descriptionYours}`);
    console.log(`Adj Desc: ${item.descriptionAdjuster}`);
    console.log(`Yours Qty: ${item.qtyYours}`);
    console.log(`Adj Qty: ${item.qtyAdjuster}`);
    console.log(`Yours Total: $${Number(item.totalYours ?? 0).toFixed(2)}`);
    console.log(`Adj Total: $${Number(item.totalAdjuster ?? 0).toFixed(2)}`);
    console.log(`---`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
