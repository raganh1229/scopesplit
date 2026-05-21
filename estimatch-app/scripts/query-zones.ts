/**
 * query-zones.ts — print all n3_zones for a comparison with page ranges
 * Usage: npx tsx scripts/query-zones.ts --id <comparisonId>
 */
import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';
dotenvConfig({ path: path.resolve(__dirname, '../.env.local'), override: true });

import { PrismaClient } from '../app/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const idIdx = process.argv.indexOf('--id');
if (idIdx === -1) { console.error('Usage: npx tsx scripts/query-zones.ts --id <comparisonId>'); process.exit(1); }
const COMPARISON_ID = process.argv[idIdx + 1];

const pool    = new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } });
const adapter = new PrismaPg(pool);
const prisma  = new PrismaClient({ adapter });

async function main() {
  const zones = await prisma.n3Zone.findMany({
    where: { comparisonId: COMPARISON_ID },
    orderBy: [{ source: 'asc' }, { startPage: 'asc' }],
    select: { source: true, name: true, startPage: true, endPage: true, approxItems: true },
  });

  let lastSource = '';
  for (const z of zones) {
    if (z.source !== lastSource) { console.log(`\n=== ${z.source} ===`); lastSource = z.source; }
    console.log(`  p${z.startPage}–${z.endPage}  (approx ${z.approxItems} items)  "${z.name}"`);
  }
}

main()
  .catch(err => { console.error('Fatal:', err.message); process.exit(1); })
  .finally(() => prisma.$disconnect().then(() => process.exit(0)));
