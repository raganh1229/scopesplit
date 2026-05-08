import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });

import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const r = await pool.query('SELECT * FROM comparisons ORDER BY created_at DESC LIMIT 1');
  const cid = r.rows[0].id;

  // Find MODIFIED items with 0 diff — these might be wrong status
  const items = await pool.query(
    `SELECT sort_order, match_status, zone_yours, zone_adjuster,
            description_yours, description_adjuster,
            qty_yours, qty_adjuster,
            total_yours, total_adjuster, diff_amount,
            remove_yours, remove_adjuster, replace_yours, replace_adjuster,
            reset_yours, reset_adjuster, tax_yours, tax_adjuster, op_yours, op_adjuster
     FROM line_items WHERE comparison_id = $1 AND match_status = 'MODIFIED'
     ORDER BY sort_order`,
    [cid]
  );

  for (const i of items.rows) {
    const isDiffZero = i.diff_amount !== null && Math.abs(parseFloat(i.diff_amount)) < 0.01;
    if (isDiffZero) {
      console.log(`\nSort ${i.sort_order} — MODIFIED but diff=0:`);
      console.log(`  Desc Y: ${i.description_yours}`);
      console.log(`  Desc A: ${i.description_adjuster}`);
      console.log(`  Qty Y: [${i.qty_yours}] Qty A: [${i.qty_adjuster}]`);
      console.log(`  Total Y: ${i.total_yours} Total A: ${i.total_adjuster}`);
      console.log(`  Remove Y: ${i.remove_yours} A: ${i.remove_adjuster}`);
      console.log(`  Replace Y: ${i.replace_yours} A: ${i.replace_adjuster}`);
      console.log(`  Reset Y: ${i.reset_yours} A: ${i.reset_adjuster}`);
      console.log(`  Tax Y: ${i.tax_yours} A: ${i.tax_adjuster}`);
      console.log(`  OP Y: ${i.op_yours} A: ${i.op_adjuster}`);
    }
  }
}

main().catch(console.error).finally(() => pool.end());
