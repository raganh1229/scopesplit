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
  console.log(`Comparison: ${cid}\n`);

  const items = await pool.query(
    `SELECT sort_order, match_status, zone_yours, zone_adjuster, zone_canonical, zone_confidence,
            substring(description_yours from 1 for 45) as dy,
            substring(description_adjuster from 1 for 45) as da
     FROM line_items WHERE comparison_id = $1 ORDER BY sort_order`,
    [cid]
  );

  console.log(
    'Sort'.padEnd(6) +
    'Status'.padEnd(25) +
    'Zone(Y)'.padEnd(20) +
    'Zone(A)'.padEnd(20) +
    'Zone(Canonical)'.padEnd(25) +
    'Desc(Y)'.padEnd(47) +
    'Desc(A)'
  );
  console.log('-'.repeat(170));

  for (const i of items.rows) {
    console.log(
      String(i.sort_order ?? '').padEnd(6) +
      (i.match_status || '').padEnd(25) +
      (i.zone_yours || '---').padEnd(20) +
      (i.zone_adjuster || '---').padEnd(20) +
      (i.zone_canonical || '---').padEnd(25) +
      (i.dy || '---').padEnd(47) +
      (i.da || '---')
    );
  }
}

main().catch(console.error).finally(() => pool.end());
