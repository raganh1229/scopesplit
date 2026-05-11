/**
 * run-v2-n3.ts
 *
 * Uploads the V2 verified-set PDFs to Supabase, creates a Comparison row,
 * and fires the `comparison/process-v3.requested` Inngest event so the
 * N3 pipeline processes them locally.
 *
 * Usage:
 *   npx tsx scripts/run-v2-n3.ts
 *
 * Requirements:
 *   - `npm run dev` running on :3000
 *   - `npx inngest-cli@latest dev -u http://127.0.0.1:3000/api/inngest` running on :8288
 */

import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

// Load .env.local (overrides .env)
dotenvConfig({ path: path.resolve(__dirname, '../.env.local'), override: true });

import { PrismaClient } from '../app/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { createClient } from '@supabase/supabase-js';

const pool    = new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } });
const adapter = new PrismaPg(pool);
const prisma  = new PrismaClient({ adapter });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const ESTIMATES_BUCKET = 'estimates';
const INNGEST_DEV_URL  = process.env.INNGEST_DEV ?? 'http://127.0.0.1:8288';

const V2_DIR          = path.resolve(__dirname, '../../../PDFS/Generated Sets/Verified Sets/V2');
const CONTRACTOR_PATH = path.join(V2_DIR, 'Contractor_V2.pdf');
const ADJUSTER_PATH   = path.join(V2_DIR, 'Adjuster_V2.pdf');

async function main() {
  // ── sanity checks ──────────────────────────────────────────────────────────
  if (!fs.existsSync(CONTRACTOR_PATH)) {
    console.error(`Contractor PDF not found: ${CONTRACTOR_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(ADJUSTER_PATH)) {
    console.error(`Adjuster PDF not found: ${ADJUSTER_PATH}`);
    process.exit(1);
  }

  // ── find the first user in the DB ─────────────────────────────────────────
  const user = await prisma.user.findFirst({ select: { id: true, clerkId: true, email: true } });
  if (!user) {
    console.error('No user found in the database. Sign in to the app at least once first.');
    process.exit(1);
  }
  console.log(`\nUsing user: ${user.email ?? user.clerkId} (id: ${user.id})`);

  // ── upload PDFs to Supabase storage ───────────────────────────────────────
  const ts = Date.now();
  const contractorStoragePath = `${user.clerkId}/${ts}-${crypto.randomUUID()}-Contractor_V2.pdf`;
  const adjusterStoragePath   = `${user.clerkId}/${ts + 1}-${crypto.randomUUID()}-Adjuster_V2.pdf`;

  console.log('\nUploading Contractor_V2.pdf ...');
  const contractorBytes = fs.readFileSync(CONTRACTOR_PATH);
  const { error: cErr } = await supabase.storage
    .from(ESTIMATES_BUCKET)
    .upload(contractorStoragePath, contractorBytes, { contentType: 'application/pdf', upsert: false });
  if (cErr) { console.error('  ✗ Contractor upload failed:', cErr.message); process.exit(1); }
  console.log(`  ✓ Uploaded to ${contractorStoragePath}`);

  console.log('Uploading Adjuster_V2.pdf ...');
  const adjusterBytes = fs.readFileSync(ADJUSTER_PATH);
  const { error: aErr } = await supabase.storage
    .from(ESTIMATES_BUCKET)
    .upload(adjusterStoragePath, adjusterBytes, { contentType: 'application/pdf', upsert: false });
  if (aErr) { console.error('  ✗ Adjuster upload failed:', aErr.message); process.exit(1); }
  console.log(`  ✓ Uploaded to ${adjusterStoragePath}`);

  // ── create comparison row ─────────────────────────────────────────────────
  const comparison = await prisma.comparison.create({
    data: {
      userId:                      user.id,
      status:                      'PROCESSING',
      insuredName:                 'V2 Verified Set',
      claimNumber:                 'V2-TEST-RUN',
      propertyAddress:             'V2 Test Property',
      yourEstimateFilename:        'Contractor_V2.pdf',
      yourEstimateStoragePath:     contractorStoragePath,
      adjusterEstimateFilename:    'Adjuster_V2.pdf',
      adjusterEstimateStoragePath: adjusterStoragePath,
    },
    select: { id: true },
  });
  console.log(`\nComparison created: ${comparison.id}`);

  // ── fire the Inngest event ─────────────────────────────────────────────────
  const eventPayload = {
    name: 'comparison/process-v3.requested',
    data: {
      comparisonId: comparison.id,
      trigger: 'manual-test-v2',
      force: false,
    },
  };

  console.log(`\nSending event to Inngest dev (${INNGEST_DEV_URL}) ...`);
  const resp = await fetch(`${INNGEST_DEV_URL}/e/test`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(eventPayload),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error(`  ✗ Inngest event failed (HTTP ${resp.status}):`, body);
    process.exit(1);
  }

  console.log('  ✓ Event accepted by Inngest dev');
  console.log('\n─────────────────────────────────────────────');
  console.log(`Comparison ID : ${comparison.id}`);
  console.log(`Inngest UI    : ${INNGEST_DEV_URL}`);
  console.log(`App URL       : http://localhost:3000/app/comparison/${comparison.id}`);
  console.log('─────────────────────────────────────────────\n');

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
