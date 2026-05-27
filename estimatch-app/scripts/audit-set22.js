const { Client } = require('pg');
require('dotenv').config({ path: '.env.local' });
const ID = '73041d34-503e-494d-8377-cf6f7be7c7c9';

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  const r1 = await c.query(
    `SELECT match_status, COUNT(*)::int AS count, ROUND(SUM(diff_amount)::numeric, 2) AS gap
     FROM line_items WHERE comparison_id = $1
     GROUP BY match_status ORDER BY match_status`,
    [ID]
  );
  console.log('STATUS COUNTS:');
  console.table(r1.rows);

  const r2 = await c.query(
    `SELECT COALESCE(zone_canonical, zone_yours, zone_adjuster) AS zone,
            match_status, COUNT(*)::int AS count
     FROM line_items WHERE comparison_id = $1
     GROUP BY zone, match_status
     ORDER BY zone, match_status`,
    [ID]
  );
  console.log('\nPER-ZONE STATUS:');
  console.table(r2.rows);

  const r3 = await c.query(
    `SELECT ROUND(SUM(diff_amount)::numeric, 2) AS total_gap,
            ROUND(SUM(total_yours)::numeric, 2) AS yours_total,
            ROUND(SUM(total_adjuster)::numeric, 2) AS adj_total,
            COUNT(*)::int AS row_count
     FROM line_items WHERE comparison_id = $1`,
    [ID]
  );
  console.log('\nTOTALS:');
  console.table(r3.rows);

  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
