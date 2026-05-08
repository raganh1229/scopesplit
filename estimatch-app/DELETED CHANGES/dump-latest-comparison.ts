import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });

import fs from 'fs';
import path from 'path';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const OUT_FILE = path.resolve('scripts/latest-comparison-dump.txt');

async function main() {
  const lines: string[] = [];
  const log = (s: string = '') => lines.push(s);

  const compRes = await pool.query(
    `SELECT * FROM comparisons ORDER BY created_at DESC LIMIT 1`
  );
  if (compRes.rows.length === 0) {
    console.log('No comparisons found.');
    return;
  }
  const c = compRes.rows[0];

  log('=== LATEST COMPARISON ===');
  log(`ID: ${c.id}`);
  log(`Status: ${c.status}`);
  log(`Your file: ${c.your_estimate_filename}`);
  log(`Adjuster file: ${c.adjuster_estimate_filename}`);
  log(`Created: ${c.created_at}`);
  log(`Total yours: ${c.your_estimate_total}`);
  log(`Total adjuster: ${c.adjuster_estimate_total}`);
  log(`Gap: ${c.total_gap}`);
  if (c.error_message) log(`Error: ${c.error_message}`);
  log('');

  const itemsRes = await pool.query(
    `SELECT * FROM line_items WHERE comparison_id = $1 ORDER BY sort_order ASC`,
    [c.id]
  );
  log(`Line items: ${itemsRes.rows.length}`);

  // Status breakdown
  const statusCounts: Record<string, number> = {};
  for (const item of itemsRes.rows) {
    statusCounts[item.match_status] = (statusCounts[item.match_status] || 0) + 1;
  }
  log('\n=== STATUS BREAKDOWN ===');
  for (const [status, count] of Object.entries(statusCounts)) {
    log(`  ${status}: ${count}`);
  }

  // Print line items table
  log('\n=== LINE ITEMS ===');
  log(
    'Row'.padEnd(5) +
    'Sort'.padEnd(6) +
    'Status'.padEnd(25) +
    'Zone (Y)'.padEnd(18) +
    'Desc (Yours)'.padEnd(50) +
    'Desc (Adj)'.padEnd(50) +
    'Total Y'.padEnd(12) +
    'Total A'.padEnd(12) +
    'Diff'
  );
  log('-'.repeat(180));

  let rowNum = 0;
  for (const item of itemsRes.rows) {
    rowNum++;
    const descY = (item.description_yours || '---').slice(0, 47);
    const descA = (item.description_adjuster || '---').slice(0, 47);
    const zoneY = (item.zone_yours || '---').slice(0, 15);
    log(
      String(rowNum).padEnd(5) +
      String(item.sort_order ?? '').padEnd(6) +
      (item.match_status || '').padEnd(25) +
      zoneY.padEnd(18) +
      descY.padEnd(50) +
      descA.padEnd(50) +
      String(item.total_yours ?? '---').padEnd(12) +
      String(item.total_adjuster ?? '---').padEnd(12) +
      String(item.diff_amount ?? '---')
    );
  }

  const output = lines.join('\n');
  fs.writeFileSync(OUT_FILE, output, 'utf-8');
  console.log(`Wrote ${rowNum} line items to ${OUT_FILE}`);
  console.log(output);
}

main()
  .catch(console.error)
  .finally(() => pool.end());
