/**
 * Phase 2 smoke test — run zone detection for one comparison and inspect the result.
 *
 * Usage:
 *   npx tsx scripts/n2-smoke-detect-zones.ts [comparisonId]
 *
 * If no comparisonId is supplied, uses the most recently created comparison.
 *
 * Requires (all present in .env.local already):
 *   DATABASE_URL
 *   ANTHROPIC_API_KEY
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * What it does:
 *   1. Downloads both PDFs from Supabase Storage
 *   2. Chunks them (20 pages, 1-page overlap)
 *   3. Fires Haiku AI calls in parallel — each chunk identifies zone headers
 *   4. Merges + deduplicates zones per estimate
 *   5. Writes n2:zones_detected to ComparisonProcessingState
 *   6. Reads the state back and prints the full payload
 *
 * IMPORTANT: This calls the real Anthropic API and costs real tokens.
 * It also overwrites any existing n2:zones_detected row for this comparison.
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../app/generated/prisma/client';

loadEnv({ path: path.resolve(__dirname, '..', '.env') });
loadEnv({ path: path.resolve(__dirname, '..', '.env.local'), override: true });

// ── Env guards ────────────────────────────────────────────────────────────────

const required = [
  'DATABASE_URL',
  'ANTHROPIC_API_KEY',
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`❌  ${key} is missing from .env.local — aborting.`);
    process.exit(1);
  }
}

// ── Prisma (for reading state back after the run) ─────────────────────────────

const pool = new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Resolve comparison ID
  let comparisonId = process.argv[2];
  if (!comparisonId) {
    const latest = await prisma.comparison.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, yourEstimateStoragePath: true, adjusterEstimateStoragePath: true },
    });
    if (!latest) {
      console.error('❌  No comparisons found in the database.');
      process.exit(1);
    }
    comparisonId = latest.id;
    console.log(`ℹ️   No comparisonId supplied — using latest: ${comparisonId}`);
    console.log(`    Status: ${latest.status}`);
    console.log(`    E1 path: ${latest.yourEstimateStoragePath}`);
    console.log(`    E2 path: ${latest.adjusterEstimateStoragePath}`);
  } else {
    const found = await prisma.comparison.findUnique({
      where: { id: comparisonId },
      select: { status: true, yourEstimateStoragePath: true, adjusterEstimateStoragePath: true },
    });
    if (!found) {
      console.error(`❌  Comparison ${comparisonId} not found.`);
      process.exit(1);
    }
    console.log(`ℹ️   Using comparison: ${comparisonId}`);
    console.log(`    Status: ${found.status}`);
    console.log(`    E1 path: ${found.yourEstimateStoragePath}`);
    console.log(`    E2 path: ${found.adjusterEstimateStoragePath}`);
  }

  console.log('\n🚀  Running detectZones...\n');
  const startMs = Date.now();

  // detectZones imports its own prisma instance and supabaseAdmin — no conflict.
  const { detectZones } = await import('@/lib/n2/passes/detect-zones');
  await detectZones(comparisonId, console as unknown as Parameters<typeof detectZones>[1]);

  const elapsedMs = Date.now() - startMs;
  console.log(`\n✅  detectZones completed in ${(elapsedMs / 1000).toFixed(1)}s`);

  // ── Read back the written state ────────────────────────────────────────────
  const state = await prisma.comparisonProcessingState.findUnique({
    where: { comparisonId },
  });

  if (!state) {
    console.error('❌  No ComparisonProcessingState row found — write may have failed silently.');
    process.exit(1);
  }

  console.log(`\n📦  Stage: ${state.stage}`);
  console.log(`    Written at: ${state.updatedAt ?? state.createdAt}\n`);

  const payload = state.payload as {
    e1Zones: { name: string; startPage: number; endPage: number; approxItems: number; chunkOffset: number }[];
    e2Zones: { name: string; startPage: number; endPage: number; approxItems: number; chunkOffset: number }[];
    e1Format: string;
    e2Format: string;
    routingDecision: string;
  };

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('━━━ SUMMARY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`E1 format : ${payload.e1Format}`);
  console.log(`E2 format : ${payload.e2Format}`);
  console.log(`Routing   : ${payload.routingDecision}`);
  console.log(`E1 zones  : ${payload.e1Zones?.length ?? '?'}`);
  console.log(`E2 zones  : ${payload.e2Zones?.length ?? '?'}`);

  // ── E1 zones table ─────────────────────────────────────────────────────────
  if (payload.e1Zones?.length) {
    console.log('\n─── E1 Zones ────────────────────────────────────────────────────');
    const colW = Math.max(...payload.e1Zones.map((z) => z.name.length), 4);
    console.log(`${'Zone'.padEnd(colW)}  Start  End   ~Items  Offset`);
    for (const z of payload.e1Zones) {
      console.log(
        `${z.name.padEnd(colW)}  ${String(z.startPage).padStart(5)}  ${String(z.endPage).padEnd(4)}  ${String(z.approxItems).padStart(6)}  ${z.chunkOffset}`
      );
    }
  }

  // ── E2 zones table ─────────────────────────────────────────────────────────
  if (payload.e2Zones?.length) {
    console.log('\n─── E2 Zones ────────────────────────────────────────────────────');
    const colW = Math.max(...payload.e2Zones.map((z) => z.name.length), 4);
    console.log(`${'Zone'.padEnd(colW)}  Start  End   ~Items  Offset`);
    for (const z of payload.e2Zones) {
      console.log(
        `${z.name.padEnd(colW)}  ${String(z.startPage).padStart(5)}  ${String(z.endPage).padEnd(4)}  ${String(z.approxItems).padStart(6)}  ${z.chunkOffset}`
      );
    }
  }

  // ── Full payload (for deep inspection) ────────────────────────────────────
  console.log('\n─── Full payload (JSON) ─────────────────────────────────────────');
  console.log(JSON.stringify(payload, null, 2));

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('\n💥  Fatal error:', err);
  process.exit(1);
});
