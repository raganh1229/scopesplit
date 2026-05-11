/**
 * poll-comparison.ts — polls a comparison until status leaves PROCESSING or timeout.
 * Usage: npx tsx scripts/poll-comparison.ts <comparison_id> [timeout_minutes]
 */
import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';
dotenvConfig({ path: path.resolve(__dirname, '../.env.local'), override: true });

import { PrismaClient } from '../app/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const prisma = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } })) });

const CID = process.argv[2];
const TIMEOUT_MIN = parseInt(process.argv[3] ?? '15', 10);

async function main() {
  if (!CID) { console.error('Usage: npx tsx scripts/poll-comparison.ts <comparison_id> [timeout_min]'); process.exit(1); }

  const start = Date.now();
  const deadline = start + TIMEOUT_MIN * 60 * 1000;
  let lastStatus = '';
  let lastZones = -1, lastItems = -1, lastEdges = -1, lastDecisions = -1;

  while (Date.now() < deadline) {
    const c = await prisma.comparison.findUnique({ where: { id: CID }, select: { status: true, errorMessage: true } });
    if (!c) { console.error('Comparison not found'); process.exit(1); }

    const [zones, items, edges, decisions] = await Promise.all([
      prisma.n3Zone.count({ where: { comparisonId: CID } }),
      prisma.n3LineItem.count({ where: { comparisonId: CID } }),
      prisma.n3CandidateEdge.count({ where: { comparisonId: CID } }),
      prisma.n3MatchDecision.count({ where: { comparisonId: CID } }),
    ]);

    const elapsed = Math.floor((Date.now() - start) / 1000);
    if (c.status !== lastStatus || zones !== lastZones || items !== lastItems || edges !== lastEdges || decisions !== lastDecisions) {
      console.log(`[${elapsed}s] status=${c.status}  zones=${zones}  items=${items}  edges=${edges}  decisions=${decisions}`);
      lastStatus = c.status; lastZones = zones; lastItems = items; lastEdges = edges; lastDecisions = decisions;
    }

    if (c.status === 'COMPLETED' || c.status === 'FAILED') {
      if (c.status === 'FAILED') console.error('  ✗ FAILED:', c.errorMessage);
      else console.log('  ✓ COMPLETED');
      await prisma.$disconnect();
      process.exit(c.status === 'COMPLETED' ? 0 : 1);
    }

    await new Promise(r => setTimeout(r, 5000));
  }

  console.error(`\nTimed out after ${TIMEOUT_MIN} minutes`);
  await prisma.$disconnect();
  process.exit(2);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
