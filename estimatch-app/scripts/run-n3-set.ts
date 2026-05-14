/**
 * run-n3-set.ts
 *
 * Generalized N3 pipeline trigger for any generated test set.
 * Uploads PDFs directly to Supabase, creates a Comparison row, fires the
 * `comparison/process-v3.requested` Inngest event, and polls Prisma until
 * COMPLETED or FAILED. Prints COMPARISON_ID=<id> on success.
 *
 * Usage:
 *   npx tsx scripts/run-n3-set.ts --set Set12
 *
 * Requirements:
 *   - npm run dev running on :3000
 *   - npx inngest-cli@latest dev -u http://127.0.0.1:3000/api/inngest running on :8288
 *   - .env.local with DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

dotenvConfig({ path: path.resolve(__dirname, '../.env.local'), override: true });

import { PrismaClient } from '../app/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { createClient } from '@supabase/supabase-js';

// ── CLI args ───────────────────────────────────────────────────────────────────

const setIdx = process.argv.indexOf('--set');
if (setIdx === -1 || !process.argv[setIdx + 1]) {
  console.error('Usage: npx tsx scripts/run-n3-set.ts --set Set12');
  process.exit(1);
}
const SET_ID = process.argv[setIdx + 1];

// ── Paths ──────────────────────────────────────────────────────────────────────

const WORKSPACE_ROOT    = path.resolve(__dirname, '../../..');
const SET_DIR           = path.join(WORKSPACE_ROOT, 'PDFS', 'Generated Sets', SET_ID);
const CONTRACTOR_PATH   = path.join(SET_DIR, `Contractor_${SET_ID}.pdf`);
const ADJUSTER_PATH     = path.join(SET_DIR, `Adjuster_${SET_ID}.pdf`);
const ESTIMATES_BUCKET  = 'estimates';
const INNGEST_DEV_URL   = process.env.INNGEST_DEV ?? 'http://127.0.0.1:8288';
const POLL_INTERVAL_MS  = 4_000;
const POLL_TIMEOUT_MS   = 900_000;   // 15 minutes — large sets need time for extraction

// ── DB + Supabase clients ──────────────────────────────────────────────────────

const pool     = new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false } });
const adapter  = new PrismaPg(pool);
const prisma   = new PrismaClient({ adapter });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// ── Helpers ────────────────────────────────────────────────────────────────────

async function uploadPdf(localPath: string, storagePath: string, label: string) {
  process.stdout.write(`  Uploading ${label}...`);
  const bytes = fs.readFileSync(localPath);
  const { error } = await supabase.storage
    .from(ESTIMATES_BUCKET)
    .upload(storagePath, bytes, { contentType: 'application/pdf', upsert: false });
  if (error) {
    process.stdout.write(' ✗\n');
    throw new Error(`${label} upload failed: ${error.message}`);
  }
  process.stdout.write(' ✓\n');
}

async function pollUntilDone(comparisonId: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  process.stdout.write(`  Pipeline running`);
  while (Date.now() < deadline) {
    const row = await prisma.comparison.findUnique({
      where:  { id: comparisonId },
      select: { status: true, errorMessage: true },
    });
    if (!row) throw new Error('Comparison row disappeared mid-pipeline');
    if (row.status === 'COMPLETED') { process.stdout.write(' ✓\n'); return; }
    if (row.status === 'FAILED')    throw new Error(`Pipeline FAILED: ${row.errorMessage ?? 'unknown'}`);
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out after ${POLL_TIMEOUT_MS / 1000}s waiting for COMPLETED`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n[run-n3-set] ${SET_ID} — N3 pipeline trigger`);
  console.log(`${'─'.repeat(60)}`);

  // Sanity checks
  if (!fs.existsSync(CONTRACTOR_PATH)) {
    console.error(`  ✗ Missing: ${CONTRACTOR_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(ADJUSTER_PATH)) {
    console.error(`  ✗ Missing: ${ADJUSTER_PATH}`);
    process.exit(1);
  }

  // Find first user in DB
  const user = await prisma.user.findFirst({
    select: { id: true, clerkId: true, email: true },
  });
  if (!user) {
    console.error('  ✗ No user in DB. Sign in to the app at least once first.');
    process.exit(1);
  }
  console.log(`  User: ${user.email ?? user.clerkId}`);

  // Upload PDFs to Supabase
  const ts = Date.now();
  const cPath = `${user.clerkId}/${ts}-${crypto.randomUUID()}-Contractor_${SET_ID}.pdf`;
  const aPath = `${user.clerkId}/${ts + 1}-${crypto.randomUUID()}-Adjuster_${SET_ID}.pdf`;

  await uploadPdf(CONTRACTOR_PATH, cPath, `Contractor_${SET_ID}.pdf`);
  await uploadPdf(ADJUSTER_PATH,   aPath, `Adjuster_${SET_ID}.pdf`);

  // Create Comparison row
  const comparison = await prisma.comparison.create({
    data: {
      userId:                       user.id,
      status:                       'PROCESSING',
      insuredName:                  `${SET_ID} — N3 Test Run`,
      claimNumber:                  `N3-TEST-${SET_ID}`,
      propertyAddress:              `${SET_ID} Test Property`,
      yourEstimateFilename:         `Contractor_${SET_ID}.pdf`,
      yourEstimateStoragePath:      cPath,
      adjusterEstimateFilename:     `Adjuster_${SET_ID}.pdf`,
      adjusterEstimateStoragePath:  aPath,
    },
    select: { id: true },
  });
  console.log(`  Comparison created: ${comparison.id}`);

  // Fire N3 Inngest event
  const event = {
    name: 'comparison/process-v3.requested',
    data: { comparisonId: comparison.id, trigger: `n3pdfrun-${SET_ID}`, force: false },
  };
  process.stdout.write(`  Sending N3 event to Inngest (${INNGEST_DEV_URL})...`);
  const resp = await fetch(`${INNGEST_DEV_URL}/e/test`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(event),
  });
  if (!resp.ok) {
    process.stdout.write(' ✗\n');
    throw new Error(`Inngest rejected event (HTTP ${resp.status}): ${await resp.text()}`);
  }
  process.stdout.write(' ✓\n');
  console.log(`  Inngest UI: ${INNGEST_DEV_URL}`);

  // Poll Prisma until COMPLETED
  await pollUntilDone(comparison.id);

  // Machine-parseable output for runner-n3.js
  console.log(`\nCOMPARISON_ID=${comparison.id}`);
  console.log(`STATUS=COMPLETED`);
}

main()
  .catch(err => {
    console.error('\n  ✗ Fatal:', err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect().then(() => process.exit(0)));
