import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';
dotenvConfig({ path: path.resolve(__dirname, '../.env.local'), override: true });

import { PrismaClient } from '../app/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const prisma = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } })) });
const CID = 'a49f7692-4114-4f49-aeb3-1762f1797110';

async function probeMissPair(label: string, contractorMatch: string, adjMatch: string, contractorZone: string, adjZone: string) {
  console.log(`\n══════ ${label} ══════`);

  const contractor = await prisma.n3LineItem.findFirst({
    where: {
      comparisonId: CID, source: 'yours',
      rawDescription: { contains: contractorMatch, mode: 'insensitive' },
      zone: { name: { contains: contractorZone, mode: 'insensitive' } },
    },
    select: { id: true, rawDescription: true, totalAmount: true, zone: { select: { name: true } } },
  });
  const adj = await prisma.n3LineItem.findFirst({
    where: {
      comparisonId: CID, source: 'adjuster',
      rawDescription: { contains: adjMatch, mode: 'insensitive' },
      zone: { name: { contains: adjZone, mode: 'insensitive' } },
    },
    select: { id: true, rawDescription: true, totalAmount: true, zone: { select: { name: true } } },
  });

  console.log('  Contractor:', contractor?.rawDescription, '| zone:', contractor?.zone?.name, '| $', contractor?.totalAmount);
  console.log('  Adjuster  :', adj?.rawDescription, '| zone:', adj?.zone?.name, '| $', adj?.totalAmount);

  if (!contractor || !adj) { console.log('  *** ITEM NOT FOUND ***'); return; }

  // Edge between them?
  const edge = await prisma.n3CandidateEdge.findFirst({
    where: { comparisonId: CID, sourceItemId: contractor.id, targetItemId: adj.id },
    select: { id: true, finalScore: true, rawScore: true, isRejected: true, featuresJson: true, boostsJson: true, retrievalSources: true },
  });
  if (!edge) {
    console.log('  *** NO EDGE GENERATED IN PHASE 12 ***');
  } else {
    const f = edge.featuresJson as Record<string, number>;
    console.log(`  Edge: finalScore=${Number(edge.finalScore).toFixed(3)}  isRejected=${edge.isRejected}`);
    console.log(`    fuzzy=${f.descriptionFuzzySimilarity?.toFixed(3)}  semantic=${f.descriptionSemanticSimilarity?.toFixed(3)}  trade=${f.tradeActionSimilarity?.toFixed(3)}  total=${f.totalSimilarity?.toFixed(3)}  qty=${f.quantityUnitSimilarity?.toFixed(3)}  zone=${f.zoneCorrespondenceSimilarity?.toFixed(3)}`);
    console.log(`    boosts=${JSON.stringify(edge.boostsJson)}  retrieval=${JSON.stringify(edge.retrievalSources)}`);
  }

  // What did contractor end up paired with?
  const cDecision = await prisma.n3MatchDecision.findFirst({
    where: { comparisonId: CID, yourItemIds: { has: contractor.id } },
    select: { decisionType: true, decidedBy: true, finalScore: true, adjusterItemIds: true },
  });
  if (cDecision?.adjusterItemIds.length) {
    const pairedAdj = await prisma.n3LineItem.findUnique({ where: { id: cDecision.adjusterItemIds[0] }, select: { rawDescription: true, totalAmount: true } });
    console.log(`  Contractor was paired with: "${pairedAdj?.rawDescription}" $${pairedAdj?.totalAmount} (score=${Number(cDecision.finalScore).toFixed(3)} via ${cDecision.decidedBy})`);
  } else {
    console.log(`  Contractor decision: ${cDecision?.decisionType ?? 'NONE'} (orphan? ${!cDecision})`);
  }

  // What did adj end up paired with?
  const aDecision = await prisma.n3MatchDecision.findFirst({
    where: { comparisonId: CID, adjusterItemIds: { has: adj.id } },
    select: { decisionType: true, decidedBy: true, finalScore: true, yourItemIds: true },
  });
  if (aDecision?.yourItemIds.length) {
    const pairedYours = await prisma.n3LineItem.findUnique({ where: { id: aDecision.yourItemIds[0] }, select: { rawDescription: true, totalAmount: true } });
    console.log(`  Adjuster   was paired with: "${pairedYours?.rawDescription}" $${pairedYours?.totalAmount} (score=${Number(aDecision.finalScore).toFixed(3)} via ${aDecision.decidedBy})`);
  } else {
    console.log(`  Adjuster   decision: ${aDecision?.decisionType ?? 'NONE'} (orphan? ${!aDecision})`);
  }

  // Top 3 edges FROM contractor (best candidates per Phase 13)
  const topFromContractor = await prisma.n3CandidateEdge.findMany({
    where: { comparisonId: CID, sourceItemId: contractor.id, isRejected: false },
    select: { targetItemId: true, finalScore: true },
    orderBy: { finalScore: 'desc' },
    take: 3,
  });
  console.log('  Top 3 edges FROM contractor:');
  for (const e of topFromContractor) {
    const it = await prisma.n3LineItem.findUnique({ where: { id: e.targetItemId }, select: { rawDescription: true, totalAmount: true, zone: { select: { name: true } } } });
    console.log(`    ${Number(e.finalScore).toFixed(3)}  "${it?.rawDescription}"  zone:${it?.zone?.name}  $${it?.totalAmount}`);
  }

  // Top 3 edges TO adj
  const topToAdj = await prisma.n3CandidateEdge.findMany({
    where: { comparisonId: CID, targetItemId: adj.id, isRejected: false },
    select: { sourceItemId: true, finalScore: true },
    orderBy: { finalScore: 'desc' },
    take: 3,
  });
  console.log('  Top 3 edges TO adjuster:');
  for (const e of topToAdj) {
    const it = await prisma.n3LineItem.findUnique({ where: { id: e.sourceItemId }, select: { rawDescription: true, totalAmount: true, zone: { select: { name: true } } } });
    console.log(`    ${Number(e.finalScore).toFixed(3)}  "${it?.rawDescription}"  zone:${it?.zone?.name}  $${it?.totalAmount}`);
  }
}

async function main() {
  await probeMissPair(
    'Kitchen drywall walls (should MATCH)',
    'Tear out wet drywall — walls', 'Remove damaged drywall — walls',
    'Kitchen', 'Kitchen',
  );

  await probeMissPair(
    'Kitchen countertop (should MOD-PRICE)',
    'countertop', 'countertop',
    'Kitchen', 'Kitchen',
  );

  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
