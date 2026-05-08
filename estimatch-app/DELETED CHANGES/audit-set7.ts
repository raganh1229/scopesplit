import prisma from '@/lib/prisma';

async function main() {
  const comparison = await prisma.comparison.findFirst({
    orderBy: { createdAt: 'desc' },
    include: { lineItems: { orderBy: { sortOrder: 'asc' } } },
  });

  if (!comparison) {
    console.log('No comparisons found');
    return;
  }

  console.log(`Comparison: ${comparison.id}`);
  console.log(`Status: ${comparison.status}`);
  console.log(`Files: ${comparison.yourEstimateFilename} vs ${comparison.adjusterEstimateFilename}`);
  console.log(`Totals: yours=${comparison.yourEstimateTotal}, adj=${comparison.adjusterEstimateTotal}, gap=${comparison.totalGap}`);
  await runAudit(comparison);
}

type ComparisonWithItems = NonNullable<Awaited<ReturnType<typeof prisma.comparison.findFirst<{
  include: { lineItems: { orderBy: { sortOrder: 'asc' } } };
}>>>>;

async function runAudit(comparison: ComparisonWithItems) {
  const items = comparison.lineItems;

  // Status breakdown
  const statusCounts: Record<string, number> = {};
  for (const item of items) {
    statusCounts[item.matchStatus] = (statusCounts[item.matchStatus] || 0) + 1;
  }
  console.log('\n=== STATUS BREAKDOWN ===');
  for (const [status, count] of Object.entries(statusCounts)) {
    console.log(`  ${status}: ${count}`);
  }

  // Zone breakdown
  const zoneCounts: Record<string, { paired: number; missing: number; added: number }> = {};
  for (const item of items) {
    const zone = item.zoneCanonical || item.zoneYours || item.zoneAdjuster || '__UNZONED__';
    if (!zoneCounts[zone]) zoneCounts[zone] = { paired: 0, missing: 0, added: 0 };
    if (item.matchStatus === 'MISSING_FROM_ADJUSTER') zoneCounts[zone].missing++;
    else if (item.matchStatus === 'ADDED_BY_ADJUSTER') zoneCounts[zone].added++;
    else zoneCounts[zone].paired++;
  }
  console.log(`\n=== ZONE BREAKDOWN (${Object.keys(zoneCounts).length} zones) ===`);
  for (const [zone, counts] of Object.entries(zoneCounts)) {
    const total = counts.paired + counts.missing + counts.added;
    console.log(`  ${zone}: ${total} items (${counts.paired} paired, ${counts.missing} missing, ${counts.added} added)`);
  }

  // Potential issues
  console.log('\n=== POTENTIAL ISSUES ===');

  // MODIFIED with diff=0
  const modZero = items.filter(i => i.matchStatus === 'MODIFIED' && i.totalYours !== null && i.totalAdjuster !== null && Math.abs(Number(i.totalYours) - Number(i.totalAdjuster)) < 0.02);
  if (modZero.length > 0) {
    console.log(`  MODIFIED with diff≈0: ${modZero.length} items`);
    for (const i of modZero) {
      console.log(`    sort=${i.sortOrder} zone=${i.zoneCanonical} "${i.descriptionYours}" ↔ "${i.descriptionAdjuster}"`);
    }
  }

  // Unzoned items
  const unzoned = items.filter(i => (i.zoneCanonical || '__UNZONED__') === '__UNZONED__');
  console.log(`  __UNZONED__ items: ${unzoned.length}`);

  // Zone name mismatches
  const rawMismatches = items.filter(i =>
    i.zoneCanonical && (
      (i.zoneYours && i.zoneYours !== '__UNZONED__' && i.zoneYours !== i.zoneCanonical) ||
      (i.zoneAdjuster && i.zoneAdjuster !== '__UNZONED__' && i.zoneAdjuster !== i.zoneCanonical)
    )
  );
  console.log(`  Raw zone ≠ canonical zone mismatches: ${rawMismatches.length}`);

  // Write detail file
  const fs = await import('fs');
  const lines: string[] = [];
  for (const item of items) {
    const zc = (item.zoneCanonical || '__UNZONED__').padEnd(35);
    const zy = (item.zoneYours || '__UNZONED__').padEnd(35);
    const za = (item.zoneAdjuster || '---').padEnd(30);
    const dy = item.descriptionYours ? `"${item.descriptionYours}"` : '"---"';
    const da = item.descriptionAdjuster ? `"${item.descriptionAdjuster}"` : '"---"';
    const ty = item.totalYours !== null ? Number(item.totalYours).toFixed(2) : '---';
    const ta = item.totalAdjuster !== null ? Number(item.totalAdjuster).toFixed(2) : '---';
    const diff = (item.totalYours !== null && item.totalAdjuster !== null)
      ? (Number(item.totalYours) - Number(item.totalAdjuster)).toFixed(2)
      : '---';
    lines.push(
      `${String(item.sortOrder).padStart(5)} ${item.matchStatus.padEnd(25)} ZC=${zc} ZY=${zy} ZA=${za} ${dy} ↔ ${da} T:${ty}/${ta} D:${diff}`
    );
  }
  fs.writeFileSync('scripts/audit-set7-detail.txt', lines.join('\n') + '\n');
  console.log(`\nWrote ${items.length} items to scripts/audit-set7-detail.txt`);
}

main().finally(() => prisma.$disconnect());
