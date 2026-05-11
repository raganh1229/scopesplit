/**
 * probe-texture.ts
 * Probes the Bedroom 2 "Texture walls knockdown" ↔ Second Bedroom "Drywall texture knockdown" pair.
 * Usage: npx tsx scripts/probe-texture.ts <comparisonId>
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
  if (!CID) { console.error('Usage: npx tsx scripts/probe-texture.ts <id>'); process.exit(1); }

  // Find zones
  const zones = await prisma.n3Zone.findMany({ where: { comparisonId: CID }, select: { id: true, source: true, name: true, normalizedName: true } });
  const bed2Zone   = zones.find(z => z.source === 'yours'     && z.normalizedName?.includes('bedroom 2'));
  const secBedZone = zones.find(z => z.source === 'adjuster'  && z.normalizedName?.includes('second bedroom'));
  console.log('\n── Zones ──');
  console.log('  Bedroom 2:', bed2Zone?.id, bed2Zone?.name);
  console.log('  Second Bedroom:', secBedZone?.id, secBedZone?.name);

  // Find items
  const textureC = await prisma.n3LineItem.findFirst({
    where: { comparisonId: CID, source: 'yours', normalizedDescription: { contains: 'texture' }, totalAmount: { gte: 430, lte: 436 } },
    select: { id: true, normalizedDescription: true, totalAmount: true, zoneId: true, trade: true, action: true, descriptionTokens: true },
  });
  const textureA = await prisma.n3LineItem.findFirst({
    where: { comparisonId: CID, source: 'adjuster', normalizedDescription: { contains: 'texture' }, totalAmount: { gte: 430, lte: 436 } },
    select: { id: true, normalizedDescription: true, totalAmount: true, zoneId: true, trade: true, action: true, descriptionTokens: true },
  });

  console.log('\n── Target Items ──');
  console.log('  Contractor:', textureC?.id, textureC?.normalizedDescription, '$' + textureC?.totalAmount, 'zone:', textureC?.zoneId);
  console.log('    trade:', textureC?.trade, 'action:', textureC?.action, 'tokens:', textureC?.descriptionTokens);
  console.log('  Adjuster :', textureA?.id, textureA?.normalizedDescription, '$' + textureA?.totalAmount, 'zone:', textureA?.zoneId);
  console.log('    trade:', textureA?.trade, 'action:', textureA?.action, 'tokens:', textureA?.descriptionTokens);

  if (!textureC || !textureA) { console.log('  !! Could not find one or both items'); return; }

  // Check for candidate edge
  const edge = await prisma.n3CandidateEdge.findFirst({
    where: { comparisonId: CID, sourceItemId: textureC.id, targetItemId: textureA.id },
    select: { id: true, finalScore: true, rawScore: true, retrievalSources: true, boostsJson: true, featuresJson: true, isRejected: true },
  });
  console.log('\n── Candidate Edge (C→A) ──');
  if (!edge) {
    console.log('  !! NO EDGE FOUND — item was never a candidate for this pair');
  } else {
    console.log('  Edge found:', edge.id);
    console.log('  finalScore:', Number(edge.finalScore).toFixed(4), '  rawScore:', Number(edge.rawScore).toFixed(4));
    console.log('  isRejected:', edge.isRejected);
    console.log('  sources:', edge.retrievalSources);
    console.log('  boosts:', JSON.stringify(edge.boostsJson));
    const feat = edge.featuresJson as Record<string, number>;
    console.log('  tradeAction:', feat.tradeActionSimilarity, '  total:', feat.totalSimilarity, '  zoneCorr:', feat.zoneCorrespondenceSimilarity);
  }

  // Always show top-5 edges from texture-C
  const cEdges = await prisma.n3CandidateEdge.findMany({
    where: { comparisonId: CID, sourceItemId: textureC.id },
    orderBy: { finalScore: 'desc' },
    take: 8,
    select: { id: true, targetItemId: true, finalScore: true, rawScore: true, isRejected: true, boostsJson: true },
  });
  console.log(`\n── Top-8 edges FROM Texture-C ──`);
  for (const e of cEdges) {
    const tgt = await prisma.n3LineItem.findUnique({ where: { id: e.targetItemId }, select: { normalizedDescription: true, totalAmount: true, zoneId: true } });
    const boost = (e.boostsJson as Array<{type:string;value:number}>)?.[0];
    console.log(`  [${e.isRejected ? 'REJ' : ' OK'}] finalScore: ${Number(e.finalScore).toFixed(3)}  raw: ${Number(e.rawScore).toFixed(3)}  boost: ${boost ? `${boost.type}(${boost.value.toFixed(3)})` : 'none'}  → ${tgt?.normalizedDescription} $${tgt?.totalAmount}`);
  }

  // Always show top-5 edges TO texture-A
  const aEdges = await prisma.n3CandidateEdge.findMany({
    where: { comparisonId: CID, targetItemId: textureA.id },
    orderBy: { finalScore: 'desc' },
    take: 8,
    select: { id: true, sourceItemId: true, finalScore: true, rawScore: true, isRejected: true, boostsJson: true },
  });
  console.log(`\n── Top-8 reverse edges TO Texture-A ──`);
  for (const e of aEdges) {
    const src = await prisma.n3LineItem.findUnique({ where: { id: e.sourceItemId }, select: { normalizedDescription: true, totalAmount: true, zoneId: true } });
    const boost = (e.boostsJson as Array<{type:string;value:number}>)?.[0];
    console.log(`  [${e.isRejected ? 'REJ' : ' OK'}] finalScore: ${Number(e.finalScore).toFixed(3)}  raw: ${Number(e.rawScore).toFixed(3)}  boost: ${boost ? `${boost.type}(${boost.value.toFixed(3)})` : 'none'}  ← ${src?.normalizedDescription} $${src?.totalAmount}`);
  }

  // Check decision for textureC
  const dec = await prisma.n3MatchDecision.findFirst({
    where: { comparisonId: CID, yourItemIds: { has: textureC.id } },
    select: { decisionType: true, decidedBy: true, finalScore: true, adjusterItemIds: true, llmReasoning: true },
  });
  console.log('\n── Decision for Texture-C ──');
  console.log(' ', JSON.stringify(dec));

  // Check decision for textureA
  const decA = await prisma.n3MatchDecision.findFirst({
    where: { comparisonId: CID, adjusterItemIds: { has: textureA.id } },
    select: { decisionType: true, decidedBy: true, finalScore: true, yourItemIds: true, llmReasoning: true },
  });
  console.log('\n── Decision for Texture-A ──');
  if (decA) {
    console.log(' ', JSON.stringify(decA));
    if (decA.yourItemIds.length > 0) {
      const pairedItem = await prisma.n3LineItem.findUnique({ where: { id: decA.yourItemIds[0] }, select: { normalizedDescription: true, totalAmount: true, zoneId: true, trade: true } });
      console.log('  Paired contractor:', JSON.stringify(pairedItem));
    }
  } else {
    console.log('  !! No decision found for Texture-A — it is an unmatched-adj item');
    // Check for unmatched adj decision
    const unmatchedDec = await prisma.n3MatchDecision.findFirst({
      where: { comparisonId: CID, adjusterItemIds: { has: textureA.id }, decisionType: 'unmatched' },
      select: { decisionType: true, decidedBy: true, yourItemIds: true },
    });
    console.log('  Unmatched decision:', JSON.stringify(unmatchedDec));
  }

  // Also check the component to confirm both items are in it
  const comp = await prisma.n3MatchComponent.findFirst({
    where: { comparisonId: CID },
    select: { id: true, sourceItemIds: true, targetItemIds: true, size: true },
  });
  const textureC_inComp = comp?.sourceItemIds.includes(textureC.id) ?? false;
  const textureA_inComp = comp?.targetItemIds.includes(textureA.id) ?? false;
  console.log(`\n── Component check ──`);
  console.log(`  Component size: ${comp?.size}, yours: ${comp?.sourceItemIds.length}, adj: ${comp?.targetItemIds.length}`);
  console.log(`  TextureC in component: ${textureC_inComp}`);
  console.log(`  TextureA in component: ${textureA_inComp}`);

  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
