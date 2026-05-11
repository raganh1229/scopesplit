import { config } from 'dotenv';
import * as path from 'node:path';
config({ path: path.resolve(__dirname, '../.env.local'), override: true });

import { PrismaClient } from '../app/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const pool   = new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
const CID    = 'c382d5dc-f5a3-42a2-9a56-11c753c65d65';

async function main() {

  // ── 1. Zone correspondences ───────────────────────────────────────────────
  const corrs = await prisma.n3ZoneCorrespondence.findMany({
    where: { comparisonId: CID },
    include: {
      yourZones:     { select: { name: true, normalizedName: true } },
      adjusterZones: { select: { name: true, normalizedName: true } },
    },
  });

  console.log('\n══════════ ZONE CORRESPONDENCES ══════════');
  for (const c of corrs) {
    const yours = c.yourZones.map(z => z.name).join(', ') || '(none)';
    const adj   = c.adjusterZones.map(z => z.name).join(', ') || '(none)';
    console.log(`  [${c.verificationStatus.padEnd(14)}  conf: ${Number(c.confidence).toFixed(2)}]  ${yours}  ↔  ${adj}`);
  }

  // ── 2. All extracted N3LineItems containing "door" or "smoke" ────────────
  const n3Items = await prisma.n3LineItem.findMany({
    where: {
      comparisonId: CID,
      OR: [
        { rawDescription: { contains: 'door',          mode: 'insensitive' } },
        { rawDescription: { contains: 'smoke',         mode: 'insensitive' } },
        { rawDescription: { contains: 'chandelier',    mode: 'insensitive' } },
        { rawDescription: { contains: 'detector',      mode: 'insensitive' } },
      ],
    },
    select: {
      id: true, source: true, rawDescription: true,
      normalizedQuantity: true, normalizedUnit: true, totalAmount: true,
      zone: { select: { name: true } },
    },
    orderBy: [{ source: 'asc' }],
  });

  console.log('\n══════════ EXTRACTED LINE ITEMS (door / smoke / detector / chandelier) ══════════');
  for (const i of n3Items) {
    const zone  = i.zone?.name ?? '(no zone)';
    const qty   = i.normalizedQuantity != null ? Number(i.normalizedQuantity).toString() : '?';
    const total = i.totalAmount != null ? `$${Number(i.totalAmount).toFixed(2)}` : '$?';
    console.log(`  [${i.source.padEnd(8)}]  id: ${i.id.slice(0,8)}  zone: ${zone.padEnd(30)}  qty: ${qty.padStart(4)} ${(i.normalizedUnit??'').padEnd(3)}  ${total.padStart(10)}  "${i.rawDescription}"`);
  }

  // ── 3. Candidate edges for those items ───────────────────────────────────
  const itemIds = n3Items.map(i => i.id);
  const edges = await prisma.n3CandidateEdge.findMany({
    where: {
      comparisonId: CID,
      OR: [
        { sourceItemId: { in: itemIds } },
        { targetItemId: { in: itemIds } },
      ],
    },
    select: {
      sourceItemId: true, targetItemId: true,
      finalScore: true, rawScore: true,
      boostsJson: true, retrievalSources: true, isRejected: true,
    },
    orderBy: [{ finalScore: 'desc' }],
  });

  // Build item id → description/zone map for readable output
  const itemLookup = new Map(n3Items.map(i => [
    i.id,
    `[${i.source.slice(0,1).toUpperCase()}] ${(i.rawDescription??'').slice(0,40).padEnd(40)} ${(i.zone?.name??'').slice(0,22).padEnd(22)} $${Number(i.totalAmount??0).toFixed(2)}`,
  ]));

  console.log('\n══════════ CANDIDATE EDGES (involving those items) ══════════');
  console.log('  finalScore  rawScore  rejected  sources');
  for (const e of edges) {
    const src = itemLookup.get(e.sourceItemId) ?? e.sourceItemId.slice(0,8);
    const tgt = itemLookup.get(e.targetItemId) ?? e.targetItemId.slice(0,8);
    const fs  = Number(e.finalScore).toFixed(4);
    const rs  = Number(e.rawScore).toFixed(4);
    const rej = e.isRejected ? '❌' : '✅';
    const boosts = JSON.stringify(e.boostsJson);
    console.log(`\n  FROM: ${src}`);
    console.log(`    TO: ${tgt}`);
    console.log(`        finalScore: ${fs}  rawScore: ${rs}  ${rej}  boosts: ${boosts}`);
    console.log(`        sources: ${JSON.stringify(e.retrievalSources)}`);
  }

  // ── 4. Final match decisions for those items ──────────────────────────────
  const decisions = await prisma.n3MatchDecision.findMany({
    where: {
      comparisonId: CID,
      OR: [
        { yourItemIds:     { hasSome: itemIds } },
        { adjusterItemIds: { hasSome: itemIds } },
      ],
    },
    select: {
      decisionType: true, yourItemIds: true, adjusterItemIds: true,
      finalScore: true, decidedBy: true,
    },
  });

  console.log('\n══════════ MATCH DECISIONS (involving those items) ══════════');
  for (const d of decisions) {
    const yours = d.yourItemIds.map(id => itemLookup.get(id) ?? id.slice(0,8)).join(', ') || '(none)';
    const adjs  = d.adjusterItemIds.map(id => itemLookup.get(id) ?? id.slice(0,8)).join(', ') || '(none)';
    console.log(`  [${d.decisionType.padEnd(10)}  score: ${Number(d.finalScore).toFixed(4)}  by: ${d.decidedBy}]`);
    console.log(`    yours: ${yours}`);
    console.log(`    adj  : ${adjs}`);
  }

  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
