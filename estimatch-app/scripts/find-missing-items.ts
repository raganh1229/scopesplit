/**
 * find-missing-items.ts — identifies which 2 items failed extraction by comparing
 * generated script definitions vs extracted N3 items
 */
import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';
dotenvConfig({ path: path.resolve(__dirname, '../.env.local'), override: true });

import { PrismaClient } from '../app/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const prisma = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } })) });
const CID = process.argv[2];

// Expected items from gen-v4-contractor.ts and gen-v4-adjuster.ts
const expectedContractor = [
  // GENERAL CONDITIONS (14)
  'Dumpster — 30 cubic yard, per pull',
  'Fire debris haul-off — truck load',
  'Building permit — structural repair',
  'Building permit — HVAC & electrical',
  'Final post-construction cleaning, per SF',
  'Temporary fence — rental per month',
  'Temporary toilet — rental per month',
  'Site safety signage & barricades',
  'Air quality / industrial hygienist test',
  'Board up — structural openings, per SF',
  'General laborer — per hour',
  'Project supervision — per hour',
  'Temporary housing allowance — per month',
  'Contents pack-out & storage — per month',
  // EXTERIOR & ROOF - ROOFING (13)
  'Remove fire-damaged roofing — per SQ',
  'Roof decking — OSB 7/16-in, replace',
  'Fire-stop code board — per SF',
  'Synthetic roofing underlayment, per SQ',
  '30-yr architectural shingles — install, per SQ',
  'Ridge cap shingles, per LF',
  'Ice & water shield — eave course, per LF',
  'Drip edge — eave metal, per LF',
  'Pipe flashing — lead boot, replace',
  'Chimney flashing — step & counter',
  'Attic insulation — blown R-38, per SF',
  'Attic ventilation — soffit & ridge, per LF',
  'Box roof vents — remove & replace',
  'Solar attic fan — replace',
  // EXTERIOR & ROOF - EXTERIOR (4)
  'Fascia board — 1×6 PVC, per LF',
  'Gutters — 5-in aluminum K-style, per LF',
  'Soffit — aluminum vented, per SF',
  'Downspouts — 3×4 aluminum, per LF',
];

const expectedAdjuster = [
  // PROJECT GENERAL CONDITIONS (13)
  '30 cy debris dumpster — per pull',
  'Fire debris removal — per truck load',
  'Municipal permit — structural restoration',
  'Municipal permit — mechanical & electrical',
  'Post-construction cleaning — residential, per SF',
  'Site fencing panels — rental per month',
  'Portable restroom — rental per month',
  'Safety barricade & signage package',
  'Air quality sampling — post-fire',
  'Emergency board-up — openings, per SF',
  'General helper labor — hourly',
  'Construction supervision — per hour',
  'Fire investigator report fee',
  // ROOF SYSTEM - ROOFING (13)
  'Tear-off fire/heat damaged roof covering, per SQ',
  'Roof sheathing — 7/16 OSB, per SF',
  'Type X fire-board underlayment, per SF',
  'Underlayment — synthetic, per SQ',
  '30-yr dimensional shingle — per SQ',
  'Hip & ridge cap — per LF',
  'Eave ice/water barrier, per LF',
  'Metal drip edge — eaves, per LF',
  'Plumbing stack flashing — replace',
  'Step & counter chimney flashing',
  'Blown-in attic insulation — R-38, per SF',
  'Ridge & soffit ventilation, per LF',
  'Attic decking — plywood walkway boards, per SF',
  // ROOF SYSTEM - EXTERIOR (4)
  'PVC fascia board — 1×6, per LF',
  '5-in aluminum K-style gutters, per LF',
  'Vented aluminum soffit — per SF',
  '3×4 aluminum downspouts, per LF',
];

function fuzzyMatch(a: string, b: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalize(a).includes(normalize(b).substring(0, 15)) || 
         normalize(b).includes(normalize(a).substring(0, 15));
}

async function main() {
  if (!CID) { console.error('Usage: npx tsx scripts/find-missing-items.ts <comparison_id>'); process.exit(1); }

  const items = await prisma.n3LineItem.findMany({
    where: { comparisonId: CID },
    include: { zone: true },
  });

  const yourItems = items.filter(i => i.source === 'yours');
  const adjItems = items.filter(i => i.source === 'adjuster');

  console.log('\n=== CHECKING CONTRACTOR ITEMS (first 2 zones) ===\n');
  
  const missingContractor: string[] = [];
  for (const expected of expectedContractor) {
    const found = yourItems.some(i => fuzzyMatch(i.rawDescription, expected));
    if (!found) {
      console.log(`✗ MISSING: ${expected}`);
      missingContractor.push(expected);
    }
  }

  if (missingContractor.length === 0) {
    console.log('✓ All contractor items extracted (from first 2 zones)');
  }

  console.log('\n=== CHECKING ADJUSTER ITEMS (first 2 zones) ===\n');
  
  const missingAdjuster: string[] = [];
  for (const expected of expectedAdjuster) {
    const found = adjItems.some(i => fuzzyMatch(i.rawDescription, expected));
    if (!found) {
      console.log(`✗ MISSING: ${expected}`);
      missingAdjuster.push(expected);
    }
  }

  if (missingAdjuster.length === 0) {
    console.log('✓ All adjuster items extracted (from first 2 zones)');
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Missing contractor items: ${missingContractor.length}`);
  console.log(`Missing adjuster items: ${missingAdjuster.length}`);
  console.log(`Total missing: ${missingContractor.length + missingAdjuster.length}`);

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
