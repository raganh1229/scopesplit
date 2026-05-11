/**
 * find-extra-matches.ts — identifies which items are MATCH but should be MODIFIED or ADDED
 */
import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';
dotenvConfig({ path: path.resolve(__dirname, '../.env.local'), override: true });

import { PrismaClient } from '../app/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const prisma = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } })) });
const CID = process.argv[2];

// Expected MODIFIED items from cheat sheet
const expectedModified = [
  { yours: 'General laborer', adj: 'General helper labor', type: 'MOD-QTY' },
  { yours: 'Project supervision', adj: 'Construction supervision', type: 'MOD-QTY' },
  { yours: 'Soffit — aluminum vented', adj: 'Vented aluminum soffit', type: 'MOD-PRICE' },
  { yours: 'Downspouts — 3×4 aluminum', adj: '3×4 aluminum downspouts', type: 'MOD-PRICE' },
  { yours: 'Window trim — replace', adj: 'Window casing & stool', type: 'MOD-QTY', zone: 'LIVING ROOM' },
  { yours: 'Smoke/odor treatment — ozone clean', adj: 'Ozone odor treatment', type: 'MOD-QTY', zone: 'LIVING ROOM' },
  { yours: 'Kitchen base cabinets', adj: 'Base cabinets — builder grade', type: 'MOD-PRICE' },
  { yours: 'Kitchen upper cabinets', adj: 'Upper wall cabinets — builder grade', type: 'MOD-PRICE' },
  { yours: 'Kitchen countertop — quartz', adj: 'Countertop — laminate', type: 'MOD-PRICE' },
  { yours: 'Ozone/odor treatment', adj: 'Ozone odor treatment', type: 'MOD-QTY', zone: 'DINING' },
  { yours: 'Smoke detector', adj: 'Smoke detector', type: 'MOD-QTY', zone: 'DINING' },
  { yours: 'Interior door — pre-hung, solid wood', adj: 'Interior door — pre-hung, hollow-core', type: 'MOD-PRICE', zone: 'MASTER' },
  { yours: 'Window blinds — 2-in faux wood', adj: 'Window blinds — 1-in aluminum mini', type: 'MOD-PRICE', zone: 'MASTER' },
  { yours: 'Ozone treatment — bedroom', adj: 'Ozone odor treatment', type: 'MOD-QTY', zone: 'BEDROOM 2' },
  { yours: 'Closet wire shelving', adj: 'Wire shelving — closet', type: 'MOD-QTY', zone: 'BEDROOM 2' },
  { yours: 'Interior door — pre-hung, solid wood', adj: 'Interior door — pre-hung, hollow-core', type: 'MOD-PRICE', zone: 'BEDROOM 3' },
  { yours: 'Window blind — 2-in faux wood', adj: 'Window blinds — 1-in aluminum mini', type: 'MOD-PRICE', zone: 'BEDROOM 3' },
  { yours: 'Ozone treatment — garage', adj: 'Ozone odor treatment — garage', type: 'MOD-QTY', zone: 'GARAGE' },
  { yours: 'Board up — temporary panels', adj: 'Emergency board-up', type: 'MOD-QTY', zone: 'GARAGE' },
];

// Expected ADDED items (adjuster only, no contractor match)
const expectedAdded = [
  'Fire investigator report fee',
  'Attic decking — plywood walkway boards',
  'Drywall primer sealer — ceiling & walls',
  'Drywall primer sealer — kitchen',
  'Drywall primer sealer — dining room',
  'Drywall primer sealer — master suite',
  'Drywall primer sealer — bedroom 2',
  'Drywall primer sealer — bedroom 3',
  'Concrete floor — etching & prep for sealer',
  'Garage door weather seal — bottom sweep',
];

function fuzzyMatch(text: string, pattern: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normText = normalize(text);
  const normPattern = normalize(pattern);
  return normText.includes(normPattern.substring(0, Math.min(20, normPattern.length)));
}

async function main() {
  if (!CID) { console.error('Usage: npx tsx scripts/find-extra-matches.ts <comparison_id>'); process.exit(1); }

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
  });

  console.log('\n=== CHECKING FOR FALSE MATCH ITEMS (should be MODIFIED) ===\n');

  let falseMatchCount = 0;
  for (const exp of expectedModified) {
    const item = persisted.find(p => 
      p.descriptionYours && p.descriptionAdjuster &&
      fuzzyMatch(p.descriptionYours, exp.yours) && 
      fuzzyMatch(p.descriptionAdjuster, exp.adj)
    );

    if (item) {
      if (item.matchStatus === 'MATCH') {
        console.log(`✗ FALSE MATCH (should be ${exp.type}):`);
        console.log(`  Zone: ${item.zoneYours}`);
        console.log(`  Yours: ${item.descriptionYours} | ${item.qtyYours} | $${Number(item.totalYours ?? 0).toFixed(2)}`);
        console.log(`  Adj:   ${item.descriptionAdjuster} | ${item.qtyAdjuster} | $${Number(item.totalAdjuster ?? 0).toFixed(2)}`);
        console.log('');
        falseMatchCount++;
      } else if (item.matchStatus === 'MODIFIED') {
        // Expected behavior, no output
      } else {
        console.log(`⚠ UNEXPECTED STATUS (expected MODIFIED, got ${item.matchStatus}):`);
        console.log(`  ${item.descriptionYours} ↔ ${item.descriptionAdjuster}`);
        console.log('');
      }
    } else {
      console.log(`⚠ ITEM NOT FOUND: ${exp.yours} ↔ ${exp.adj}`);
      console.log('');
    }
  }

  if (falseMatchCount === 0) {
    console.log('✓ No false MATCH items found among expected MODIFIED items\n');
  } else {
    console.log(`Found ${falseMatchCount} false MATCH items (should be MODIFIED)\n`);
  }

  console.log('=== CHECKING FOR FALSE MATCH ITEMS (should be ADDED) ===\n');

  let falseMatchAdded = 0;
  for (const exp of expectedAdded) {
    const item = persisted.find(p => 
      p.descriptionAdjuster && fuzzyMatch(p.descriptionAdjuster, exp)
    );

    if (item) {
      if (item.matchStatus === 'MATCH') {
        console.log(`✗ FALSE MATCH (should be ADDED):`);
        console.log(`  Zone: ${item.zoneAdjuster}`);
        console.log(`  Adj: ${item.descriptionAdjuster}`);
        console.log(`  Paired with yours: ${item.descriptionYours ?? '(none)'}`);
        console.log('');
        falseMatchAdded++;
      } else if (item.matchStatus === 'ADDED_BY_ADJUSTER') {
        // Expected behavior
      }
    }
  }

  if (falseMatchAdded === 0) {
    console.log('✓ No false MATCH items found among expected ADDED items\n');
  } else {
    console.log(`Found ${falseMatchAdded} false MATCH items (should be ADDED)\n`);
  }

  console.log('=== SUMMARY ===');
  console.log(`False MATCH (should be MODIFIED): ${falseMatchCount}`);
  console.log(`False MATCH (should be ADDED): ${falseMatchAdded}`);
  console.log(`Total false MATCH: ${falseMatchCount + falseMatchAdded}`);
  console.log(`\n(This explains ${Math.min(falseMatchCount + falseMatchAdded, 6)} of the +6 MATCH surplus)\n`);

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
