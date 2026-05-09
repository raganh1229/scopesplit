import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';
dotenvConfig({ path: path.resolve(__dirname, '../.env.local'), override: true });

import { PrismaClient } from '../app/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const prisma = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } })) });
const CID = process.argv[2];

function pct(n: number, d: number) { return d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`; }
function f2(n: number) { return n.toFixed(2); }

async function main() {
  if (!CID) { console.error('Usage: npx tsx scripts/dashboard.ts <comparison_id>'); process.exit(1); }

  // ── Phase 4: Zones ────────────────────────────────────────────────────────
  const zones = await prisma.n3Zone.findMany({ where: { comparisonId: CID } });
  const yourZones = zones.filter(z => z.source === 'yours');
  const adjZones  = zones.filter(z => z.source === 'adjuster');

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║          N3 VERIFICATION DASHBOARD                  ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  console.log('\n── PHASE 4: Zone Detection ──');
  console.log(`  Yours zones    : ${yourZones.length}`);
  console.log(`  Adjuster zones : ${adjZones.length}`);
  for (const z of yourZones) console.log(`    [yours]    ${z.name}  →  ${z.normalizedName}  (items: ${z.approxItems ?? '?'})`);
  for (const z of adjZones)  console.log(`    [adjuster] ${z.name}  →  ${z.normalizedName}  (items: ${z.approxItems ?? '?'})`);

  // ── Phase 6: Zone Correspondences ────────────────────────────────────────
  const corrs = await prisma.n3ZoneCorrespondence.findMany({ where: { comparisonId: CID }, include: { yourZones: true, adjusterZones: true } });
  console.log(`\n── PHASE 6: Zone Correspondences ──`);
  console.log(`  Pairs proposed : ${corrs.length}`);
  for (const c of corrs) {
    const y = c.yourZones[0];
    const a = c.adjusterZones[0];
    console.log(`    ${(y?.name ?? '?').padEnd(30)} ↔  ${(a?.name ?? '?').padEnd(30)}  conf: ${Number(c.confidence).toFixed(2)}  type: ${c.correspondenceType}`);
  }

  // ── Phase 8: Line Items ───────────────────────────────────────────────────
  const items = await prisma.n3LineItem.findMany({ where: { comparisonId: CID } });
  const yourItems = items.filter(i => i.source === 'yours');
  const adjItems  = items.filter(i => i.source === 'adjuster');
  console.log(`\n── PHASE 8: Line Item Extraction ──`);
  console.log(`  Yours items    : ${yourItems.length}`);
  console.log(`  Adjuster items : ${adjItems.length}`);
  console.log(`  Total          : ${items.length}`);

  // ── Phase 9: Normalization ────────────────────────────────────────────────
  const withTrade    = items.filter(i => i.trade).length;
  const withAction   = items.filter(i => i.action).length;
  const withCode     = items.filter(i => i.itemCode).length;
  const withQty      = items.filter(i => i.normalizedQuantity != null).length;
  console.log(`\n── PHASE 9: Normalization ──`);
  console.log(`  trade parsed   : ${withTrade}/${items.length} (${pct(withTrade, items.length)})`);
  console.log(`  action parsed  : ${withAction}/${items.length} (${pct(withAction, items.length)})`);
  console.log(`  item code      : ${withCode}/${items.length} (${pct(withCode, items.length)})`);
  console.log(`  qty parsed     : ${withQty}/${items.length} (${pct(withQty, items.length)})`);

  // ── Phase 11: Embeddings ──────────────────────────────────────────────────
  // Embeddings stored in pgvector, not exposed in Prisma select — check via item extraction confidence instead
  const avgConf11 = items.length ? items.reduce((s, i) => s + Number(i.extractionConfidence), 0) / items.length : 0;
  console.log(`\n── PHASE 11: Embeddings (pgvector — not directly queryable via Prisma) ──`);
  console.log(`  Avg extraction confidence : ${f2(avgConf11)}`);

  // ── Phase 12 + 13: Candidates & Scoring ──────────────────────────────────
  const edges = await prisma.n3CandidateEdge.findMany({ where: { comparisonId: CID }, select: { finalScore: true, retrievalSources: true, boostsJson: true } });
  const scores = edges.map(e => Number(e.finalScore));
  const highConf  = scores.filter(s => s >= 0.75).length;
  const possible  = scores.filter(s => s >= 0.55 && s < 0.75).length;
  const weak      = scores.filter(s => s >= 0.35 && s < 0.55).length;
  const rejected  = scores.filter(s => s < 0.35).length;
  const avgScore  = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const sources: Record<string, number> = {};
  for (const e of edges) {
    const srcs = (e.retrievalSources as string[] | null) ?? [];
    for (const s of srcs) sources[s] = (sources[s] ?? 0) + 1;
  }
  const zoomed = edges.filter(e => { const b = e.boostsJson as unknown as { zoneBoost?: number }; return (b?.zoneBoost ?? 0) > 0; }).length;
  console.log(`\n── PHASE 12: Candidate Generation ──`);
  console.log(`  Total edges    : ${edges.length}`);
  console.log(`  Avg sources/edge: ${f2(Object.values(sources).reduce((a, b) => a + b, 0) / Math.max(edges.length, 1))}`);
  console.log(`  Zone-boosted   : ${zoomed}/${edges.length} (${pct(zoomed, edges.length)})`);
  console.log(`  Top retrieval sources:`);
  for (const [src, cnt] of Object.entries(sources).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`    ${src.padEnd(30)} ${cnt}`);
  }
  console.log(`\n── PHASE 13: Scoring ──`);
  console.log(`  HighConf  ≥0.75: ${highConf}  (${pct(highConf, edges.length)})`);
  console.log(`  Possible  ≥0.55: ${possible}  (${pct(possible, edges.length)})`);
  console.log(`  Weak      ≥0.35: ${weak}  (${pct(weak, edges.length)})`);
  console.log(`  Rejected  <0.35: ${rejected}  (${pct(rejected, edges.length)})`);
  console.log(`  Avg score      : ${f2(avgScore)}`);

  // ── Phase 14: Components ──────────────────────────────────────────────────
  const comps = await prisma.n3MatchComponent.findMany({ where: { comparisonId: CID }, select: { size: true, isAmbiguous: true } });
  const small  = comps.filter(c => c.size === 'small').length;
  const medium = comps.filter(c => c.size === 'medium').length;
  const large  = comps.filter(c => c.size === 'large').length;
  const ambig  = comps.filter(c => c.isAmbiguous).length;
  console.log(`\n── PHASE 14: Match Components ──`);
  console.log(`  Total          : ${comps.length}`);
  console.log(`  small (1:1)    : ${small}  (${pct(small, comps.length)})`);
  console.log(`  medium (2-3)   : ${medium}  (${pct(medium, comps.length)})`);
  console.log(`  large (4+)     : ${large}  (${pct(large, comps.length)})`);
  console.log(`  ambiguous      : ${ambig}  (${pct(ambig, comps.length)})`);

  // ── Phase 15-17: Decisions ────────────────────────────────────────────────
  const decisions = await prisma.n3MatchDecision.findMany({ where: { comparisonId: CID }, select: { decisionType: true, finalScore: true, decidedBy: true } });
  const byType: Record<string, number> = {};
  const bySrc:  Record<string, number> = {};
  for (const d of decisions) {
    byType[d.decisionType] = (byType[d.decisionType] ?? 0) + 1;
    bySrc[d.decidedBy ?? 'unknown'] = (bySrc[d.decidedBy ?? 'unknown'] ?? 0) + 1;
  }
  const confValues = decisions.map(d => Number(d.finalScore ?? 0)).filter(v => v > 0);
  const avgConf = confValues.length ? confValues.reduce((a, b) => a + b, 0) / confValues.length : 0;
  console.log(`\n── PHASE 15-17: Decisions ──`);
  console.log(`  Total decisions: ${decisions.length}`);
  console.log(`  By type:`);
  for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) console.log(`    ${t.padEnd(25)} ${n}  (${pct(n, decisions.length)})`);
  console.log(`  By decidedBy:`);
  for (const [s, n] of Object.entries(bySrc).sort((a, b) => b[1] - a[1])) console.log(`    ${s.padEnd(25)} ${n}  (${pct(n, decisions.length)})`);  
  console.log(`  Avg confidence : ${f2(avgConf)}`);

  // ── LLM Calls ─────────────────────────────────────────────────────────────
  const llmCalls = await prisma.n3LlmCall.findMany({ where: { comparisonId: CID }, select: { phase: true, durationMs: true, promptTokens: true, completionTokens: true, totalTokens: true, estimatedCostUsd: true, success: true } });
  if (llmCalls.length) {
    console.log(`\n── LLM CALLS ──`);
    console.log(`  Total calls    : ${llmCalls.length}`);
    console.log(`  Successful     : ${llmCalls.filter(c => c.success).length}`);
    const totalIn  = llmCalls.reduce((a, c) => a + (c.promptTokens ?? 0), 0);
    const totalOut = llmCalls.reduce((a, c) => a + (c.completionTokens ?? 0), 0);
    const totalCost = llmCalls.reduce((a, c) => a + Number(c.estimatedCostUsd ?? 0), 0);
    const avgMs    = llmCalls.reduce((a, c) => a + (c.durationMs ?? 0), 0) / llmCalls.length;
    console.log(`  Prompt tokens  : ${totalIn.toLocaleString()}`);
    console.log(`  Completion toks: ${totalOut.toLocaleString()}`);
    console.log(`  Est. cost USD  : $${totalCost.toFixed(4)}`);
    console.log(`  Avg latency    : ${avgMs.toFixed(0)}ms`);
    const byPhase: Record<string, number> = {};
    for (const c of llmCalls) byPhase[c.phase] = (byPhase[c.phase] ?? 0) + 1;
    for (const [ph, n] of Object.entries(byPhase)) console.log(`    phase ${ph.padEnd(5)}  ${n} call(s)`);
  }

  // ── Warnings ──────────────────────────────────────────────────────────────
  const warns = await prisma.n3ExtractionWarning.findMany({ where: { comparisonId: CID }, select: { warningType: true, detail: true, source: true } });
  if (warns.length) {
    console.log(`\n── EXTRACTION WARNINGS (${warns.length}) ──`);
    const byWarnType: Record<string, number> = {};
    for (const w of warns) byWarnType[`[${w.source}] ${w.warningType}`] = (byWarnType[`[${w.source}] ${w.warningType}`] ?? 0) + 1;
    for (const [t, n] of Object.entries(byWarnType)) console.log(`    ${t.padEnd(40)} ${n}`);
    for (const w of warns.slice(0, 5)) console.log(`    detail: ${w.detail.slice(0, 80)}`);
  } else {
    console.log(`\n── EXTRACTION WARNINGS: 0 ──`);
  }

  // ── Phase 18: Final Results ───────────────────────────────────────────────
  const lineItems = await prisma.lineItem.findMany({ where: { comparisonId: CID }, select: { matchStatus: true, diffAmount: true } });
  const byStatus: Record<string, number> = {};
  for (const li of lineItems) byStatus[li.matchStatus] = (byStatus[li.matchStatus] ?? 0) + 1;
  const totalDiff = lineItems.reduce((s, li) => s + Number(li.diffAmount ?? 0), 0);
  console.log(`\n── PHASE 18: Persisted Line Items ──`);
  console.log(`  Total          : ${lineItems.length}`);
  for (const [s, n] of Object.entries(byStatus)) console.log(`    ${s.padEnd(25)} ${n}`);
  console.log(`  Sum diff       : $${f2(Math.abs(totalDiff))}`);

  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
