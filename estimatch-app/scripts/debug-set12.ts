import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';
dotenvConfig({ path: path.resolve(__dirname, '../.env.local'), override: true });

import { PrismaClient } from '../app/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
const prisma = new PrismaClient();

const COMPARISON_ID = 'c2cb2d9d-107b-4a2a-b773-9cb8a6b25927';

async function main() {
  const zones = await prisma.n3Zone.findMany({
    where: { comparisonId: COMPARISON_ID },
    select: { id: true, source: true, name: true, startPage: true, endPage: true, approxItems: true }
  });
  console.log('=== ZONES ===');
  for (const z of zones) {
    console.log(`  [${z.source}] "${z.name}" p${z.startPage}-${z.endPage} (approx ${z.approxItems})`);
  }

  const items = await prisma.n3LineItem.findMany({
    where: { zoneId: { in: zones.map(z => z.id) } },
    select: { zoneId: true, source: true, rawDescription: true, sourceLineNumber: true, pageNumber: true }
  });
  console.log(`\n=== EXTRACTED LINE ITEMS (${items.length} total) ===`);
  
  const byZone = new Map();
  for (const item of items) {
    const z = zones.find(z => z.id === item.zoneId);
    const key = z ? `[${z.source}] ${z.name}` : item.zoneId;
    if (!byZone.has(key)) byZone.set(key, []);
    byZone.get(key).push(item);
  }
  
  for (const [zoneName, zoneItems] of byZone) {
    console.log(`\n${zoneName} (${zoneItems.length} items):`);
    for (const item of zoneItems.slice(0, 10)) {
      console.log(`  #${item.sourceLineNumber} p${item.pageNumber}: ${item.rawDescription?.substring(0, 50)}`);
    }
    if (zoneItems.length > 10) console.log(`  ... and ${zoneItems.length - 10} more`);
  }

  const edges = await prisma.n3CandidateEdge.findMany({
    where: { comparisonId: COMPARISON_ID },
    select: { id: true, zoneId: true, contractorItemId: true, adjusterItemId: true, similarityScore: true }
  });
  console.log(`\n=== CANDIDATE EDGES (${edges.length} total) ===`);

  const decisions = await prisma.n3MatchDecision.findMany({
    where: { comparisonId: COMPARISON_ID },
    select: { id: true, status: true, contractorItemId: true, adjusterItemId: true }
  });
  console.log(`\n=== MATCH DECISIONS (${decisions.length} total) ===`);
  const statusCount: Record<string, number> = {};
  for (const d of decisions) {
    statusCount[d.status] = (statusCount[d.status] || 0) + 1;
  }
  for (const [status, count] of Object.entries(statusCount)) {
    console.log(`  ${status}: ${count}`);
  }

  console.log('\n=== SEARCHING FOR TARGET ITEMS ===');
  const searchTerms = ['housing', 'LED', 'lighting', 'moisture', 'mold', 'assessment', 'antimicrobial'];
  for (const term of searchTerms) {
    const found = items.filter(i => i.rawDescription?.toLowerCase().includes(term));
    if (found.length > 0) {
      console.log(`\n✓ Found "${term}":`);
      for (const f of found) console.log(`    ${f.rawDescription}`);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
