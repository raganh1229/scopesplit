/**
 * Quick check that the comparison_processing_state row was cleared after
 * the Phase 4 verification run completed Stage D. Pass a comparison ID:
 *
 *   npx tsx scripts/n1-check-state-clear.ts <comparisonId>
 */
import { config as loadEnv } from 'dotenv';
import path from 'node:path';

loadEnv({ path: path.resolve(__dirname, '..', '.env') });
loadEnv({ path: path.resolve(__dirname, '..', '.env.local'), override: true });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing.');
  process.exit(1);
}

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error('Usage: npx tsx scripts/n1-check-state-clear.ts <comparisonId>');
    process.exit(1);
  }
  const { prisma } = await import('../lib/prisma');
  const row = await prisma.comparisonProcessingState.findUnique({
    where: { comparisonId: id },
    select: { stage: true, updatedAt: true },
  });
  if (row === null) {
    console.log(`✓ No comparison_processing_state row exists for ${id} — clearStage worked.`);
  } else {
    console.log(`✗ Row still present: stage=${row.stage} updatedAt=${row.updatedAt.toISOString()}`);
    process.exit(1);
  }
  await prisma.$disconnect();
}

main().catch(err => {
  console.error('FAILURE:', err);
  process.exit(1);
});
