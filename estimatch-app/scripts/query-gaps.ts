/**
 * query-gaps.ts — diagnose not_found items for a given comparison
 * Usage: npx tsx scripts/query-gaps.ts --id <comparisonId>
 */
import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';
dotenvConfig({ path: path.resolve(__dirname, '../.env.local'), override: true });

import { PrismaClient } from '../app/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const idIdx = process.argv.indexOf('--id');
if (idIdx === -1) { console.error('Usage: npx tsx scripts/query-gaps.ts --id <comparisonId>'); process.exit(1); }
const COMPARISON_ID = process.argv[idIdx + 1];

const pool    = new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } });
const adapter = new PrismaPg(pool);
const prisma  = new PrismaClient({ adapter });

async function main() {
  const TARGET_ZONES = ['Main Roof', 'Garage Roof', 'Detached Garage'];

  const zones = await prisma.n3Zone.findMany({
    where: { comparisonId: COMPARISON_ID },
    select: { id: true, name: true, source: true, startPage: true, endPage: true, approxItems: true },
  });

  const targetZoneIds = zones
    .filter(z => TARGET_ZONES.some(t => z.name.toLowerCase().includes(t.toLowerCase())))
    .map(z => z.id);

  console.log('\n=== TARGET ZONES ===');
  for (const z of zones.filter(z => targetZoneIds.includes(z.id))) {
    console.log(`  [${z.source}] "${z.name}"  pages ${z.startPage}–${z.endPage}  approxItems=${z.approxItems}`);
  }

  const items = await prisma.n3LineItem.findMany({
    where: { zoneId: { in: targetZoneIds } },
    select: { zoneId: true, source: true, rawDescription: true, normalizedDescription: true, sourceLineNumber: true, pageNumber: true },
    orderBy: [{ zoneId: 'asc' }, { sourceLineNumber: 'asc' }],
  });

  console.log(`\n=== EXTRACTED LINE ITEMS IN TARGET ZONES (${items.length} total) ===\n`);
  let lastZone = '';
  for (const item of items) {
    const z = zones.find(z => z.id === item.zoneId);
    const zoneName = z ? `[${z.source}] ${z.name}` : (item.zoneId ?? 'unknown');
    if (zoneName !== lastZone) { console.log(`\n${zoneName}`); lastZone = zoneName; }
    console.log(`  #${item.sourceLineNumber ?? '?'} (p${item.pageNumber})  ${item.rawDescription}`);
  }

  console.log('\n=== ITEMS NOT IN EXTRACTED SET (cheatsheet expected, look for gaps) ===');
  const MISSING_DESCRIPTIONS = [
    'R&R Attic power vent - solar',
    'R&R Soffit - fiber-cement vented',
    'R&R Fascia board - primed 2x8',
    'R&R Fascia aluminum cap',
    'R&R Soffit & fascia - garage',
    'R&R Garage door - 9x8 steel',
    'R&R Garage door opener - belt drive',
    'Paint garage exterior trim',
  ];
  for (const desc of MISSING_DESCRIPTIONS) {
    const found = items.find(i => i.rawDescription.toLowerCase().includes(desc.toLowerCase().slice(0, 20)));
    console.log(`  ${found ? '✓ FOUND' : '✗ MISSING'} — "${desc}"`);
  }
}

main()
  .catch(err => { console.error('Fatal:', err.message); process.exit(1); })
  .finally(() => prisma.$disconnect().then(() => process.exit(0)));
