/**
 * deep-investigation.ts — comprehensive analysis of all discrepancies
 */
import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';
dotenvConfig({ path: path.resolve(__dirname, '../.env.local'), override: true });

import { PrismaClient } from '../app/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const prisma = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } })) });
const CID = '91e1466e-61d5-4309-9f6a-840ebce774b8';

async function main() {
  // Get ALL persisted items with status
  const persisted = await prisma.lineItem.findMany({
    where: { comparisonId: CID },
    select: {
      matchStatus: true,
      zoneYours: true,
      zoneAdjuster: true,
      descriptionYours: true,
      descriptionAdjuster: true,
      qtyYours: true,
      qtyAdjuster: true,
      totalYours: true,
      totalAdjuster: true,
    },
    orderBy: [{ zoneYours: 'asc' }, { descriptionYours: 'asc' }],
  });

  console.log('\n=== ALL MATCH PAIRS (showing totals for verification) ===\n');

  const matches = persisted.filter(p => p.matchStatus === 'MATCH');
  let suspectMatches: any[] = [];

  for (const m of matches) {
    const yourTotal = Number(m.totalYours ?? 0);
    const adjTotal = Number(m.totalAdjuster ?? 0);
    const gap = Math.abs(yourTotal - adjTotal);

    // Look for any MATCH pair where quantities differ
    const yourQty = m.qtyYours?.match(/[\d.]+/)?.[0];
    const adjQty = m.qtyAdjuster?.match(/[\d.]+/)?.[0];
    
    if (yourQty && adjQty && yourQty !== adjQty) {
      console.log(`⚠ MATCH with different quantities:`);
      console.log(`  [${m.zoneYours}]`);
      console.log(`  Yours: ${m.descriptionYours} | ${m.qtyYours} | $${yourTotal.toFixed(2)}`);
      console.log(`  Adj:   ${m.descriptionAdjuster} | ${m.qtyAdjuster} | $${adjTotal.toFixed(2)}`);
      console.log('');
      suspectMatches.push({ ...m, reason: 'qty_differs' });
    } else if (gap > 0.50) {
      console.log(`⚠ MATCH with different totals:`);
      console.log(`  [${m.zoneYours}]`);
      console.log(`  Yours: ${m.descriptionYours} | ${m.qtyYours} | $${yourTotal.toFixed(2)}`);
      console.log(`  Adj:   ${m.descriptionAdjuster} | ${m.qtyAdjuster} | $${adjTotal.toFixed(2)}`);
      console.log(`  Gap: $${gap.toFixed(2)}`);
      console.log('');
      suspectMatches.push({ ...m, reason: 'total_differs' });
    }
  }

  if (suspectMatches.length === 0) {
    console.log('✓ All MATCH pairs have matching quantities and totals\n');
  } else {
    console.log(`Found ${suspectMatches.length} suspect MATCH pairs\n`);
  }

  // Check MODIFIED items
  console.log('=== ALL MODIFIED ITEMS ===\n');
  const modified = persisted.filter(p => p.matchStatus === 'MODIFIED');
  console.log(`Total MODIFIED: ${modified.length} (expected 20, delta: ${modified.length - 20})\n`);

  for (const m of modified) {
    const yourTotal = Number(m.totalYours ?? 0);
    const adjTotal = Number(m.totalAdjuster ?? 0);
    console.log(`[${m.zoneYours}] ${m.descriptionYours?.substring(0, 40)}`);
    console.log(`  Yours: ${m.qtyYours} = $${yourTotal.toFixed(2)}`);
    console.log(`  Adj:   ${m.qtyAdjuster} = $${adjTotal.toFixed(2)}`);
    console.log('');
  }

  // Check specific expected MODIFIED items that might be missing
  const expectedModKitchen = persisted.find(p => 
    p.descriptionYours?.includes('Smoke detector') && 
    p.zoneYours?.includes('KITCHEN')
  );
  
  if (expectedModKitchen) {
    console.log(`Kitchen Smoke Detector status: ${expectedModKitchen.matchStatus}`);
    console.log(`  Yours qty: ${expectedModKitchen.qtyYours}`);
    console.log(`  Adj qty: ${expectedModKitchen.qtyAdjuster}\n`);
  }

  // Check downspouts specifically
  console.log('=== DOWNSPOUTS CHECK ===\n');
  const downspouts = persisted.filter(p => 
    (p.descriptionYours?.toLowerCase().includes('downspout') || 
     p.descriptionAdjuster?.toLowerCase().includes('downspout'))
  );
  
  console.log(`Found ${downspouts.length} downspout item(s):\n`);
  for (const d of downspouts) {
    console.log(`Status: ${d.matchStatus}`);
    console.log(`Yours: ${d.descriptionYours ?? '(none)'}`);
    console.log(`Adj:   ${d.descriptionAdjuster ?? '(none)'}`);
    console.log('');
  }

  // Summary of discrepancies
  console.log('=== FINAL SUMMARY ===\n');
  console.log(`Total MATCH: ${matches.length} (expected 110, surplus: +${matches.length - 110})`);
  console.log(`Suspect MATCH pairs: ${suspectMatches.length}`);
  console.log(`Total MODIFIED: ${modified.length} (expected 20, delta: ${modified.length - 20})`);
  console.log(`Missing from extraction: 2 items (1 contractor, 1 adjuster)`);
  console.log(`\nNet accounting:`);
  console.log(`  +${matches.length - 110} extra MATCH`);
  console.log(`  ${modified.length - 20} fewer MODIFIED`);
  console.log(`  = ${(matches.length - 110) + (modified.length - 20)} status assignment errors`);

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
