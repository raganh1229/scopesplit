// One-off smoke test for the comparison-processing-state helpers (Phase 2D
// verification of N1). Picks a real comparisonId from the dev DB, exercises
// writeStage → readStage → hasStage → clearStage round-trips, prints results,
// and ensures the state row is fully cleaned up afterward so it does not
// interfere with future comparison processing.
//
// Usage:
//   npx tsx scripts/n1-verify-state-helpers.ts [comparisonId]
//
// If no comparisonId is provided, picks the first COMPLETED comparison in
// the DB. Either way, no comparison data is mutated — only the
// `comparison_processing_state` row is written and then deleted.

// Load env files BEFORE any module that touches DATABASE_URL is imported.
// `lib/prisma.ts` reads `process.env.DATABASE_URL` at module-evaluation time,
// so we must use dynamic `import()` for it (and anything that imports it)
// to ensure env loading happens first.
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
loadEnv({ path: path.resolve(__dirname, '..', '.env') });
loadEnv({ path: path.resolve(__dirname, '..', '.env.local'), override: true });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is missing from .env / .env.local — aborting.');
  process.exit(1);
}

type ExtractedPayload = {
  yourItems: number;
  adjItems: number;
  zones: string[];
};

async function main() {
  // Dynamic imports — see top-of-file comment for why.
  const { prisma } = await import('../lib/prisma');
  const {
    writeStage,
    readStage,
    hasStage,
    clearStage,
  } = await import('../lib/comparison-processing-state');
  type ProcessingStage = 'extracted' | 'prematched' | 'paired';

  const argId = process.argv[2];
  let comparisonId: string;

  if (argId) {
    comparisonId = argId;
  } else {
    const c = await prisma.comparison.findFirst({
      where: { status: 'COMPLETED' },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!c) {
      console.error('No COMPLETED comparison found. Pass an id explicitly.');
      process.exit(1);
    }
    comparisonId = c.id;
  }

  console.log(`Using comparisonId: ${comparisonId}`);

  // Belt-and-suspenders: clear any pre-existing state so the test starts clean.
  await clearStage(comparisonId);

  // Step 1 — writeStage('extracted')
  const samplePayload: ExtractedPayload = {
    yourItems: 53,
    adjItems: 51,
    zones: ['General Items', 'Kitchen', 'Living Room'],
  };
  await writeStage(comparisonId, 'extracted', samplePayload);
  console.log('✓ writeStage(extracted) succeeded');

  // Step 2 — hasStage('extracted') should be true
  const hasExtracted = await hasStage(comparisonId, 'extracted');
  if (!hasExtracted) throw new Error('hasStage(extracted) returned false after write');
  console.log('✓ hasStage(extracted) === true');

  // Step 3 — hasStage('prematched') should be false (different stage)
  const hasPrematched = await hasStage(comparisonId, 'prematched');
  if (hasPrematched) throw new Error('hasStage(prematched) returned true but stage is extracted');
  console.log('✓ hasStage(prematched) === false (correct rejection)');

  // Step 4 — readStage('extracted') should round-trip the payload
  const readBack = await readStage<ExtractedPayload>(comparisonId, 'extracted');
  if (!readBack) throw new Error('readStage(extracted) returned null after write');
  if (readBack.yourItems !== samplePayload.yourItems) {
    throw new Error(`readStage payload mismatch: ${JSON.stringify(readBack)}`);
  }
  if (JSON.stringify(readBack.zones) !== JSON.stringify(samplePayload.zones)) {
    throw new Error(`readStage zones mismatch: ${JSON.stringify(readBack.zones)}`);
  }
  console.log('✓ readStage(extracted) round-tripped payload correctly');

  // Step 5 — readStage('prematched') should return null (wrong stage)
  const wrongStage = await readStage<ExtractedPayload>(comparisonId, 'prematched');
  if (wrongStage !== null) throw new Error('readStage(prematched) returned non-null for wrong stage');
  console.log('✓ readStage(prematched) === null (correct stage guard)');

  // Step 6 — writeStage('prematched') overwrites previous row (upsert)
  const prematchedPayload = { matchedPairs: 22, unmatched: { yours: 31, adj: 29 } };
  await writeStage(comparisonId, 'prematched', prematchedPayload);
  console.log('✓ writeStage(prematched) succeeded (upsert)');

  const stage2 = await readStage<typeof prematchedPayload>(comparisonId, 'prematched');
  if (!stage2 || stage2.matchedPairs !== 22) throw new Error('upsert read-back failed');
  console.log('✓ upsert produced correct stored stage and payload');

  // Step 7 — clearStage removes the row
  await clearStage(comparisonId);
  const afterClear = await readStage(comparisonId, 'prematched');
  if (afterClear !== null) throw new Error('clearStage did not remove the row');
  console.log('✓ clearStage removed the row');

  // Step 8 — clearStage on already-empty row is a no-op (no error)
  await clearStage(comparisonId);
  console.log('✓ clearStage is idempotent (no-op when no row exists)');

  // Type-only sanity: ProcessingStage should narrow correctly
  const stages: ProcessingStage[] = ['extracted', 'prematched', 'paired'];
  console.log(`✓ ProcessingStage values: ${stages.join(', ')}`);

  console.log('\nAll checks passed. Phase 2D verified.');

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('FAILURE:', err);
  process.exit(1);
});
