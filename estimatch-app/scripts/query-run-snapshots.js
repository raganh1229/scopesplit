// Usage: node scripts/query-run-snapshots.js [comparisonId]
// Shows the most recent N3 run snapshots, or a specific comparison's snapshot.
require('dotenv').config({ path: '.env.local' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const comparisonId = process.argv[2];
const where = comparisonId ? `WHERE comparison_id = '${comparisonId}'` : '';

pool.query(`
  SELECT
    id,
    comparison_id,
    trigger,
    completed_at,
    yours_zone_count,
    adjuster_zone_count,
    correspondence_count,
    yours_item_count,
    adjuster_item_count,
    candidate_edge_count,
    match_count,
    modified_count,
    missing_count,
    added_count,
    grouped_count,
    total_gap,
    line_item_review_action,
    line_item_review_source,
    line_item_review_feedback
  FROM n3_run_snapshots
  ${where}
  ORDER BY completed_at DESC
  LIMIT 10
`).then(({ rows }) => {
  if (rows.length === 0) {
    console.log('No run snapshots found.');
    pool.end();
    return;
  }
  for (const r of rows) {
    console.log('\n──────────────────────────────────────');
    console.log(`Run:        ${r.id}`);
    console.log(`Comparison: ${r.comparison_id}`);
    console.log(`Trigger:    ${r.trigger}  |  Completed: ${r.completed_at}`);
    console.log(`Zones:      yours=${r.yours_zone_count}  adj=${r.adjuster_zone_count}  corr=${r.correspondence_count}`);
    console.log(`Items:      yours=${r.yours_item_count}  adj=${r.adjuster_item_count}  edges=${r.candidate_edge_count}`);
    console.log(`Decisions:  match=${r.match_count}  modified=${r.modified_count}  missing=${r.missing_count}  added=${r.added_count}  grouped=${r.grouped_count}`);
    console.log(`Gap:        $${Number(r.total_gap).toFixed(2)}`);
    if (r.line_item_review_action) {
      console.log(`LIR Gate:   action=${r.line_item_review_action}  source=${r.line_item_review_source ?? '-'}`);
      if (r.line_item_review_feedback) console.log(`  feedback: ${r.line_item_review_feedback}`);
    }
  }
  console.log('\n──────────────────────────────────────');
  pool.end();
}).catch(e => { console.error(e.message); pool.end(); process.exit(1); });
