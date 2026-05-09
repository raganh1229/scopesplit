import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';
dotenvConfig({ path: path.resolve(__dirname, '../.env.local'), override: true });

import { PrismaClient } from '../app/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const prisma = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } })) });
const CID = '22ffb042-306b-4cbd-b615-6aa258d10083';

async function main() {
  // ── Top 10 edges by score ──
  const top = await prisma.n3CandidateEdge.findMany({
    where: { comparisonId: CID },
    select: { id: true, finalScore: true, rawScore: true, featuresJson: true, boostsJson: true },
    orderBy: { finalScore: 'desc' },
    take: 10,
  });
  console.log('\n─── Top 10 edges by finalScore ───');
  for (const e of top) {
    const f = e.featuresJson as Record<string, number>;
    const b = e.boostsJson as Array<{ type: string; value: number }>;
    console.log(`  finalScore=${Number(e.finalScore).toFixed(3)}  rawScore=${Number(e.rawScore).toFixed(3)}  boosts=${JSON.stringify(b)}`);
    console.log(`    fuzzy=${f.descriptionFuzzySimilarity?.toFixed(3)}  semantic=${f.descriptionSemanticSimilarity?.toFixed(3)}  tradeAction=${f.tradeActionSimilarity?.toFixed(3)}  qty=${f.quantityUnitSimilarity?.toFixed(3)}  total=${f.totalSimilarity?.toFixed(3)}  zone=${f.zoneCorrespondenceSimilarity?.toFixed(3)}`);
  }

  // ── How many items have embeddings ──
  type CountRow = { c: bigint };
  const rows = await prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(*) as c FROM n3_line_items 
    WHERE comparison_id = ${CID} AND embedding IS NOT NULL
  `;
  console.log('\n─── Embedding coverage ───');
  console.log(`  Items with embedding: ${rows[0]?.c ?? 'unknown'} / (total 97)`);

  // ── How many cosine pairs computed ──
  const cosineCount = await prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(*) as c
    FROM n3_candidate_edges e
    JOIN n3_line_items li_y ON li_y.id = e.source_item_id
    JOIN n3_line_items li_a ON li_a.id = e.target_item_id
    WHERE e.comparison_id = ${CID}
      AND li_y.embedding IS NOT NULL
      AND li_a.embedding IS NOT NULL
  `;
  console.log(`  Edges with both embeddings: ${cosineCount[0]?.c ?? 'unknown'} / 1432`);

  // ── ALE item check ──
  const aleItem = await prisma.n3LineItem.findFirst({
    where: { comparisonId: CID, source: 'yours', rawDescription: { contains: 'accommodation', mode: 'insensitive' } },
    select: { id: true, rawDescription: true, totalAmount: true, zoneId: true },
  });
  console.log('\n─── ALE item (n3_line_items) ───');
  console.log(aleItem ?? '  NOT FOUND in n3_line_items');

  if (aleItem) {
    const decisionWithAle = await prisma.n3MatchDecision.findFirst({
      where: { comparisonId: CID, yourItemIds: { has: aleItem.id } },
      select: { id: true, decisionType: true, decidedBy: true, finalScore: true },
    });
    console.log('  Decision for ALE:', decisionWithAle ?? 'NONE — orphan');
  }

  // ── Carpet pad items ──
  const contractorCarpetPad = await prisma.n3LineItem.findFirst({
    where: { comparisonId: CID, source: 'yours', rawDescription: { contains: 'rebond', mode: 'insensitive' } },
    select: { id: true, rawDescription: true, totalAmount: true, zoneId: true, source: true },
  });
  const adjCarpetPads = await prisma.n3LineItem.findMany({
    where: { comparisonId: CID, source: 'adjuster', rawDescription: { contains: 'rebond', mode: 'insensitive' } },
    select: { id: true, rawDescription: true, totalAmount: true, zoneId: true },
  });

  // ── Carpet pad decision trace ──
  console.log('\n─── Carpet pad decisions (all 3 items) ───');
  const carpetIds = [
    contractorCarpetPad?.id ?? '',
    ...(adjCarpetPads ?? []).map(a => a.id),
  ].filter(Boolean);
  for (const itemId of carpetIds) {
    const decisionsForItem = await prisma.n3MatchDecision.findMany({
      where: {
        comparisonId: CID,
        OR: [
          { yourItemIds: { has: itemId } },
          { adjusterItemIds: { has: itemId } },
        ],
      },
      select: { id: true, decisionType: true, decidedBy: true, finalScore: true, yourItemIds: true, adjusterItemIds: true, llmReasoning: true },
    });
    console.log(`  Item ${itemId.slice(0,8)} decisions:`, JSON.stringify(decisionsForItem.map(d => ({ type: d.decisionType, by: d.decidedBy, score: Number(d.finalScore).toFixed(3), yours: d.yourItemIds, adj: d.adjusterItemIds, llm: d.llmReasoning?.slice(0,80) }))));
  }

  // ── Carpet pad component lookup ──
  console.log('\n─── Component containing contractor 8-lb ───');
  if (contractorCarpetPad) {
    const comp = await prisma.n3MatchComponent.findFirst({
      where: { comparisonId: CID, sourceItemIds: { has: contractorCarpetPad.id } },
      select: { id: true, sourceItemIds: true, targetItemIds: true, size: true, isAmbiguous: true },
    });
    console.log('  Component:', JSON.stringify(comp));
    if (comp) {
      const adjInComponent = comp.targetItemIds.includes(adjCarpetPads.find(a => Number(a.totalAmount) === 374.4)?.id ?? '');
      console.log('  adj_8lb in component targetItemIds:', adjInComponent);
    }
  }

  // ── Carpet pad edge probe ──
  console.log('\n─── Carpet pad edge probe ───');
  console.log('  Contractor rebond item:', contractorCarpetPad);
  console.log('  Adjuster rebond items :', adjCarpetPads);

  if (contractorCarpetPad) {
    for (const adj of adjCarpetPads) {
      const edge = await prisma.n3CandidateEdge.findFirst({
        where: { comparisonId: CID, sourceItemId: contractorCarpetPad.id, targetItemId: adj.id },
        select: { id: true, finalScore: true, rawScore: true, featuresJson: true, boostsJson: true, isRejected: true },
      });
      const zone = adj.zoneId ? (await prisma.n3Zone.findUnique({ where: { id: adj.zoneId }, select: { name: true } }))?.name : null;
      console.log(`\n  Edge: contractor→adjuster "${adj.rawDescription}" (zone: ${zone}, $${adj.totalAmount})`);
      if (edge) {
        const f = edge.featuresJson as Record<string, number>;
        console.log(`    finalScore=${Number(edge.finalScore).toFixed(3)}  isRejected=${edge.isRejected}  boosts=${JSON.stringify(edge.boostsJson)}`);
        console.log(`    fuzzy=${f.descriptionFuzzySimilarity?.toFixed(3)}  semantic=${f.descriptionSemanticSimilarity?.toFixed(3)}  total=${f.totalSimilarity?.toFixed(3)}  qty=${f.quantityUnitSimilarity?.toFixed(3)}  zone=${f.zoneCorrespondenceSimilarity?.toFixed(3)}`);
      } else {
        console.log('    *** EDGE DOES NOT EXIST IN n3_candidate_edges ***');
      }
    }
  }

  // ── Which contractor item has the best edge to adjuster 8-lb? ──
  const adj8lb = adjCarpetPads.find(a => Number(a.totalAmount) === 374.4);
  if (adj8lb) {
    console.log('\n─── Top edges TO adjuster 8-lb carpet pad ───');
    const edgesToAdj8lb = await prisma.n3CandidateEdge.findMany({
      where: { comparisonId: CID, targetItemId: adj8lb.id, isRejected: false },
      select: { id: true, sourceItemId: true, finalScore: true, featuresJson: true },
      orderBy: { finalScore: 'desc' },
      take: 5,
    });
    for (const e of edgesToAdj8lb) {
      const item = await prisma.n3LineItem.findUnique({ where: { id: e.sourceItemId }, select: { rawDescription: true, totalAmount: true } });
      const f = e.featuresJson as Record<string, number>;
      console.log(`  score=${Number(e.finalScore).toFixed(3)}  "${item?.rawDescription}"  $${item?.totalAmount}`);
      console.log(`    fuzzy=${f.descriptionFuzzySimilarity?.toFixed(3)}  semantic=${f.descriptionSemanticSimilarity?.toFixed(3)}  total=${f.totalSimilarity?.toFixed(3)}  qty=${f.quantityUnitSimilarity?.toFixed(3)}  zone=${f.zoneCorrespondenceSimilarity?.toFixed(3)}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
