import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../app/generated/prisma/client';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  const c = await prisma.comparison.findFirst({ orderBy: { createdAt: 'desc' } });
  if (!c) { console.log('No comparisons found'); return; }
  console.log('Latest comparison:', c.id, '| status:', c.status, '| created:', c.createdAt);

  const items = await prisma.lineItem.findMany({
    where: { comparisonId: c.id },
    orderBy: { sortOrder: 'asc' },
  });
  console.log('Total line items:', items.length);

  // By status
  const byStatus: Record<string, number> = {};
  for (const i of items) { byStatus[i.matchStatus] = (byStatus[i.matchStatus] || 0) + 1; }
  console.log('\nBy status:', JSON.stringify(byStatus, null, 2));

  // By zone
  const byZone: Record<string, number> = {};
  for (const i of items) { const z = i.zoneCanonical || '(null)'; byZone[z] = (byZone[z] || 0) + 1; }
  console.log('\nBy zone:', JSON.stringify(byZone, null, 2));

  // Sample items — first 10
  console.log('\n=== First 10 items ===');
  for (const i of items.slice(0, 10)) {
    console.log(JSON.stringify({
      status: i.matchStatus,
      zoneCanonical: i.zoneCanonical,
      zoneConf: i.zoneConfidence,
      zoneY: i.zoneYours,
      zoneA: i.zoneAdjuster,
      descY: i.descriptionYours?.slice(0, 80),
      descA: i.descriptionAdjuster?.slice(0, 80),
      qtyY: i.qtyYours,
      qtyA: i.qtyAdjuster,
      totalY: i.totalYours,
      totalA: i.totalAdjuster,
      diffAmt: i.diffAmount,
    }, null, 2));
  }

  // Check for null/empty columns
  let nullDescY = 0, nullDescA = 0, nullZoneC = 0, nullTotalY = 0, nullTotalA = 0;
  for (const i of items) {
    if (!i.descriptionYours) nullDescY++;
    if (!i.descriptionAdjuster) nullDescA++;
    if (!i.zoneCanonical) nullZoneC++;
    if (i.totalYours === null) nullTotalY++;
    if (i.totalAdjuster === null) nullTotalA++;
  }
  console.log('\n=== Null/empty column check ===');
  console.log(`descriptionYours null/empty: ${nullDescY}/${items.length}`);
  console.log(`descriptionAdjuster null/empty: ${nullDescA}/${items.length}`);
  console.log(`zoneCanonical null/empty: ${nullZoneC}/${items.length}`);
  console.log(`totalYours null: ${nullTotalY}/${items.length}`);
  console.log(`totalAdjuster null: ${nullTotalA}/${items.length}`);
}

main().then(() => prisma.$disconnect()).catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
