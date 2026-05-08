import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });

import fs from 'fs';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const r = await pool.query('SELECT * FROM comparisons ORDER BY created_at DESC LIMIT 1');
  const c = r.rows[0];
  console.log(`Comparison: ${c.id}`);
  console.log(`Status: ${c.status}`);
  console.log(`Files: ${c.your_estimate_filename} vs ${c.adjuster_estimate_filename}`);
  console.log(`Totals: yours=${c.your_estimate_total}, adj=${c.adjuster_estimate_total}, gap=${c.total_gap}`);
  console.log('');

  const items = await pool.query(
    `SELECT * FROM line_items WHERE comparison_id = $1 ORDER BY sort_order`,
    [c.id]
  );

  // Status breakdown
  const statusCounts: Record<string, number> = {};
  for (const i of items.rows) {
    statusCounts[i.match_status] = (statusCounts[i.match_status] || 0) + 1;
  }
  console.log('=== STATUS BREAKDOWN ===');
  for (const [s, n] of Object.entries(statusCounts)) console.log(`  ${s}: ${n}`);
  console.log(`  TOTAL: ${items.rows.length}`);

  // Zone breakdown
  const zoneItems: Record<string, typeof items.rows> = {};
  for (const i of items.rows) {
    const z = i.zone_canonical || 'UNZONED';
    if (!zoneItems[z]) zoneItems[z] = [];
    zoneItems[z].push(i);
  }

  console.log(`\n=== ZONE BREAKDOWN (${Object.keys(zoneItems).length} zones) ===`);
  for (const [zone, zItems] of Object.entries(zoneItems)) {
    const matched = zItems.filter(i => i.match_status === 'MATCH' || i.match_status === 'MODIFIED').length;
    const missing = zItems.filter(i => i.match_status === 'MISSING_FROM_ADJUSTER').length;
    const added = zItems.filter(i => i.match_status === 'ADDED_BY_ADJUSTER').length;
    console.log(`  ${zone}: ${zItems.length} items (${matched} paired, ${missing} missing, ${added} added)`);
  }

  // Check for issues
  console.log('\n=== POTENTIAL ISSUES ===');

  // 1. Duplicate line descriptions on same side within same zone (possible cross-zone pollution)
  let issueCount = 0;

  // 2. MODIFIED with diff=0 (possible status misclassification)
  const modZeroDiff = items.rows.filter(
    i => i.match_status === 'MODIFIED' && i.diff_amount !== null && Math.abs(parseFloat(i.diff_amount)) < 0.01
  );
  if (modZeroDiff.length > 0) {
    console.log(`  MODIFIED with diff=0: ${modZeroDiff.length} items`);
    for (const i of modZeroDiff) {
      console.log(`    sort=${i.sort_order} zone=${i.zone_canonical} "${(i.description_yours || '').slice(0,40)}" ↔ "${(i.description_adjuster || '').slice(0,40)}"`);
    }
    issueCount += modZeroDiff.length;
  }

  // 3. Zone canonical = "exterior envelope" for bathroom items (known issue pattern)
  const extEnvItems = (zoneItems['exterior envelope'] || zoneItems['Exterior Envelope'] || []);
  const bathInExt = extEnvItems.filter(i => {
    const d = ((i.description_yours || '') + (i.description_adjuster || '')).toLowerCase();
    return d.includes('bath') || d.includes('restroom') || d.includes('toilet') || d.includes('vanity');
  });
  if (bathInExt.length > 0) {
    console.log(`  Bathroom items in "exterior envelope" zone: ${bathInExt.length}`);
    issueCount += bathInExt.length;
  }

  // 4. Items with zone_yours and zone_adjuster that are very different from zone_canonical
  let zoneMismatch = 0;
  for (const i of items.rows) {
    const canon = (i.zone_canonical || '').toLowerCase();
    const zy = (i.zone_yours || '').toLowerCase();
    const za = (i.zone_adjuster || '').toLowerCase();
    if (zy && !canon.includes(zy.slice(0, 6)) && !zy.includes(canon.slice(0, 6))) {
      zoneMismatch++;
    }
    if (za && !canon.includes(za.slice(0, 6)) && !za.includes(canon.slice(0, 6))) {
      zoneMismatch++;
    }
  }
  if (zoneMismatch > 0) {
    console.log(`  Raw zone ≠ canonical zone mismatches: ${zoneMismatch}`);
  }

  if (issueCount === 0 && zoneMismatch === 0) {
    console.log('  None detected.');
  }

  // Write full detail to file for manual review
  const lines: string[] = [];
  for (const i of items.rows) {
    lines.push(
      `${String(i.sort_order).padEnd(5)} ${(i.match_status || '').padEnd(25)} ` +
      `ZC=${(i.zone_canonical || '---').padEnd(30)} ` +
      `ZY=${(i.zone_yours || '---').slice(0,25).padEnd(27)} ` +
      `ZA=${(i.zone_adjuster || '---').slice(0,25).padEnd(27)} ` +
      `"${(i.description_yours || '---').slice(0,45)}" ↔ "${(i.description_adjuster || '---').slice(0,45)}" ` +
      `T:${i.total_yours ?? '---'}/${i.total_adjuster ?? '---'} D:${i.diff_amount ?? '---'}`
    );
  }
  fs.writeFileSync('scripts/audit-set11-detail.txt', lines.join('\n'), 'utf-8');
  console.log(`\nWrote ${lines.length} items to scripts/audit-set11-detail.txt`);
}

main().catch(console.error).finally(() => pool.end());
