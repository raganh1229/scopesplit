/**
 * audit-v4-n3.ts — compares N3 decisions against V4_Cheatsheet.md expectations
 * Usage: npx tsx scripts/audit-v4-n3.ts <comparison_id>
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
  if (!CID) { console.error('Usage: npx tsx scripts/audit-v4-n3.ts <comparison_id>'); process.exit(1); }

  // Load all N3 line items
  const items = await prisma.n3LineItem.findMany({
    where: { comparisonId: CID },
    include: { zone: true },
    orderBy: [{ source: 'asc' }, { sourceLineNumber: 'asc' }],
  });

  const yourItems = items.filter(i => i.source === 'yours');
  const adjItems = items.filter(i => i.source === 'adjuster');

  // Load match decisions
  const decisions = await prisma.n3MatchDecision.findMany({
    where: { comparisonId: CID },
    orderBy: { createdAt: 'asc' },
  });

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║          V4 N3 EXTRACTION AUDIT                      ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // ── PHASE 1: Extraction counts by zone ────────────────────────────────────
  console.log('── EXTRACTION COUNTS BY ZONE ──\n');
  
  const yoursByZone = yourItems.reduce((acc, i) => {
    const z = i.zone?.name ?? 'NO_ZONE';
    acc[z] = (acc[z] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const adjByZone = adjItems.reduce((acc, i) => {
    const z = i.zone?.name ?? 'NO_ZONE';
    acc[z] = (acc[z] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const expectedYours: Record<string, number> = {
    'GENERAL CONDITIONS': 14,
    'EXTERIOR & ROOF': 18,
    'LIVING ROOM': 18,
    'KITCHEN': 20,
    'DINING ROOM': 16,
    'MASTER BEDROOM': 18,
    'BEDROOM 2': 16,
    'BEDROOM 3': 15,
    'ATTACHED GARAGE': 15,
  };

  const expectedAdj: Record<string, number> = {
    'PROJECT GENERAL CONDITIONS': 13,
    'ROOF SYSTEM': 17,
    'LIVING ROOM': 17,
    'KITCHEN': 19,
    'DINING AREA': 16,
    'PRIMARY BEDROOM SUITE': 17,
    'SECOND BEDROOM': 15,
    'THIRD BEDROOM': 15,
    'ATTACHED GARAGE': 16,
  };

  console.log('CONTRACTOR ZONES:');
  for (const [zone, exp] of Object.entries(expectedYours)) {
    const actual = yoursByZone[zone] ?? 0;
    const delta = actual - exp;
    const status = delta === 0 ? '✓' : '✗';
    console.log(`  ${status} ${zone.padEnd(30)} exp: ${exp}  actual: ${actual}  ${delta !== 0 ? `(${delta > 0 ? '+' : ''}${delta})` : ''}`);
  }

  console.log('\nADJUSTER ZONES:');
  for (const [zone, exp] of Object.entries(expectedAdj)) {
    const actual = adjByZone[zone] ?? 0;
    const delta = actual - exp;
    const status = delta === 0 ? '✓' : '✗';
    console.log(`  ${status} ${zone.padEnd(30)} exp: ${exp}  actual: ${actual}  ${delta !== 0 ? `(${delta > 0 ? '+' : ''}${delta})` : ''}`);
  }

  // ── PHASE 2: Decision type audit ──────────────────────────────────────────
  console.log('\n── DECISION TYPE COUNTS ──\n');

  const decisionTypes = decisions.reduce((acc, d) => {
    acc[d.decisionType] = (acc[d.decisionType] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const oneToOne = decisionTypes['one_to_one'] ?? 0;
  const unmatched = decisionTypes['unmatched'] ?? 0;

  console.log(`  one_to_one                : ${oneToOne}`);
  console.log(`  unmatched                 : ${unmatched}`);
  console.log(`  TOTAL decisions           : ${decisions.length}`);

  // ── PHASE 3: Status bucket audit (from persisted lineItems) ──────────────
  console.log('\n── STATUS BUCKET AUDIT (from persisted line_items) ──\n');

  const persistedItems = await prisma.lineItem.findMany({
    where: { comparisonId: CID },
    select: { matchStatus: true, totalYours: true, totalAdjuster: true, zoneYours: true, descriptionYours: true, descriptionAdjuster: true },
  });

  const statusCounts = persistedItems.reduce((acc, i) => {
    acc[i.matchStatus] = (acc[i.matchStatus] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const expected = {
    MATCH: 110,
    MODIFIED: 20,
    MISSING_FROM_ADJUSTER: 15,
    ADDED_BY_ADJUSTER: 11,
  };

  for (const [status, exp] of Object.entries(expected)) {
    const actual = statusCounts[status] ?? 0;
    const delta = actual - exp;
    const pct = exp > 0 ? ((actual / exp) * 100).toFixed(1) : '—';
    const statusSym = delta === 0 ? '✓' : (delta > 0 ? '⚠' : '✗');
    console.log(`  ${statusSym} ${status.padEnd(25)} exp: ${String(exp).padStart(3)}  actual: ${String(actual).padStart(3)}  ${pct.padStart(6)}%  ${delta !== 0 ? `(${delta > 0 ? '+' : ''}${delta})` : ''}`);
  }

  // ── PHASE 4: Match decision errors (false MATCH items) ───────────────────
  console.log('\n── LIKELY FALSE MATCH ITEMS (should be MODIFIED) ──\n');

  const matches = persistedItems.filter(i => i.matchStatus === 'MATCH');
  let suspectCount = 0;

  for (const m of matches) {
    const yourTotal = Number(m.totalYours ?? 0);
    const adjTotal = Number(m.totalAdjuster ?? 0);
    const gap = Math.abs(yourTotal - adjTotal);
    
    if (gap > 1.0) {
      suspectCount++;
      console.log(`  ${suspectCount}. [${m.zoneYours ?? '?'}] ${m.descriptionYours ?? '(no desc)'}`);
      console.log(`     Yours: $${yourTotal.toFixed(2)} | Adj: $${adjTotal.toFixed(2)} | Gap: $${gap.toFixed(2)}`);
    }
  }

  if (suspectCount === 0) {
    console.log('  (none found — all MATCH pairs have matching totals)');
  } else {
    console.log(`\n  Found ${suspectCount} MATCH pairs with significant $ gap`);
  }

  // ── PHASE 5: Missing item deep-dive ───────────────────────────────────────
  console.log('\n── EXTRACTION FAILURES (zones with missing items) ──\n');

  let totalMissing = 0;
  for (const [zone, exp] of Object.entries(expectedYours)) {
    const actual = yoursByZone[zone] ?? 0;
    if (actual < exp) {
      console.log(`  CONTRACTOR ${zone}: missing ${exp - actual} item(s)`);
      totalMissing += (exp - actual);
    }
  }

  for (const [zone, exp] of Object.entries(expectedAdj)) {
    const actual = adjByZone[zone] ?? 0;
    if (actual < exp) {
      console.log(`  ADJUSTER ${zone}: missing ${exp - actual} item(s)`);
      totalMissing += (exp - actual);
    }
  }

  if (totalMissing === 0) {
    console.log('  (no extraction failures detected)');
  }

  // ── PHASE 6: Summary ──────────────────────────────────────────────────────
  console.log('\n── ERROR SUMMARY ──\n');
  
  const extractionErrors = (151 - yourItems.length) + (146 - adjItems.length);
  const statusErrors = Math.abs((statusCounts['MATCH'] ?? 0) - 110) + 
                      Math.abs((statusCounts['MODIFIED'] ?? 0) - 20) + 
                      Math.abs((statusCounts['MISSING_FROM_ADJUSTER'] ?? 0) - 15) + 
                      Math.abs((statusCounts['ADDED_BY_ADJUSTER'] ?? 0) - 11);
  
  console.log(`Extraction errors    : ${extractionErrors} item(s) not extracted`);
  console.log(`Status bucket errors : ${statusErrors} item(s) in wrong bucket (absolute delta sum)`);
  console.log(`False MATCH suspects : ${suspectCount} item(s)`);
  console.log(`Total extracted items: ${items.length} (expected 297, delta: ${items.length - 297})`);
  console.log(`Total decisions      : ${decisions.length} (expected ~150)`);
  console.log(`Total persisted items: ${persistedItems.length} (expected 161, delta: ${persistedItems.length - 161})`);
  
  const totalExpected = 110 + 20 + 15 + 11;
  const totalCorrect = Math.min((statusCounts['MATCH'] ?? 0), 110) + 
                       Math.min((statusCounts['MODIFIED'] ?? 0), 20) + 
                       Math.min((statusCounts['MISSING_FROM_ADJUSTER'] ?? 0), 15) + 
                       Math.min((statusCounts['ADDED_BY_ADJUSTER'] ?? 0), 11);
  const accuracy = ((totalCorrect / totalExpected) * 100).toFixed(1);
  
  console.log(`\nEstimated accuracy   : ${accuracy}% (${totalCorrect}/${totalExpected} correct bucket assignments)`);
  console.log(`\n✓ Audit complete\n`);

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
