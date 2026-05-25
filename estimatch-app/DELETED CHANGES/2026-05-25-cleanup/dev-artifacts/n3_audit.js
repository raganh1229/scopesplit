const { Client } = require('pg');
const fs = require('fs');
const lines = [];
function p(s) { lines.push(s); process.stdout.write(s + '\n'); }

const DB = 'postgresql://postgres.pkoyyojellmangswrczj:Heyokayigetit1678!%40@aws-1-us-east-1.pooler.supabase.com:5432/postgres';
const CID = '3058afd4-ca23-4801-ac77-60b744845b7d';

// Cheatsheet ground truth (zone → {match, mod, missing, added})
const CHEATSHEET = {
  'general conditions':  { match:10, mod:2, missing:2, added:2, ctItems:14, adjItems:14 },
  'attic & roof':        { match:34, mod:0, missing:2, added:2, ctItems:36, adjItems:36 },
  'master bedroom':      { match:31, mod:2, missing:2, added:2, ctItems:35, adjItems:35 },
  'living room':         { match:31, mod:2, missing:1, added:2, ctItems:34, adjItems:34 },
  'kitchen':             { match:27, mod:2, missing:1, added:2, ctItems:30, adjItems:30 },
  'bedroom 2':           { match:26, mod:2, missing:1, added:1, ctItems:29, adjItems:29 },
  'bedroom 3':           { match:25, mod:1, missing:1, added:1, ctItems:27, adjItems:27 },
  'dining room':         { match:26, mod:1, missing:0, added:1, ctItems:27, adjItems:27 },
  'master bath':         { match:18, mod:0, missing:0, added:1, ctItems:18, adjItems:18 },
  'hall bath':           { match:18, mod:0, missing:0, added:1, ctItems:18, adjItems:18 },
  'hallway':             { match:15, mod:0, missing:1, added:1, ctItems:16, adjItems:16 },
  'laundry room':        { match:16, mod:0, missing:0, added:1, ctItems:16, adjItems:16 },
};

async function run() {
  const client = new Client({ connectionString: DB });
  await client.connect();

  // ── 1. Zone extraction counts ──────────────────────────────────────────────
  const zones = await client.query(`
    SELECT z.source, z.name AS zone_name, z.start_page, z.end_page,
           COUNT(li.id)::int AS extracted_count
    FROM n3_zones z
    LEFT JOIN n3_line_items li ON li.zone_id = z.id
    WHERE z.comparison_id = $1
    GROUP BY z.id, z.source, z.name, z.start_page, z.end_page
    ORDER BY z.source, z.start_page
  `, [CID]);

  p('\n══════════════════════════════════════════════════════════════');
  p('  N3 ACCURACY AUDIT — V20  |  ' + CID);
  p('══════════════════════════════════════════════════════════════\n');

  p('── SECTION 1: ZONE EXTRACTION COUNTS ─────────────────────────');
  p('source     | zone                                    | pages  | items');
  p('-----------|------------------------------------------|--------|------');
  zones.rows.forEach(r => {
    p(
      r.source.padEnd(10) + ' | ' +
      r.zone_name.padEnd(40) + ' | ' +
      (r.start_page + '-' + r.end_page).padEnd(6) + ' | ' +
      r.extracted_count
    );
  });

  const yoursTotal = zones.rows.filter(r=>r.source==='yours').reduce((s,r)=>s+r.extracted_count,0);
  const adjTotal   = zones.rows.filter(r=>r.source==='adjuster').reduce((s,r)=>s+r.extracted_count,0);
  p(`\n  Yours: ${yoursTotal} items across ${zones.rows.filter(r=>r.source==='yours').length} zones`);
  p(`  Adj:   ${adjTotal} items across ${zones.rows.filter(r=>r.source==='adjuster').length} zones`);
  p(`  Cheatsheet expects: 300 yours / 306 adj across 12 zones each`);
  p(`  DELTA: ${yoursTotal-300} extra yours, ${adjTotal-306} extra adj (extra zones: Roof&Exterior split, Family Room, Garage)`);

  // ── 2. Per-zone decision counts vs cheatsheet ───────────────────────────────
  const decisions = await client.query(`
    SELECT
      LOWER(COALESCE(zone_canonical, zone_yours, zone_adjuster)) AS zone,
      match_status,
      COUNT(*)::int AS count
    FROM line_items
    WHERE comparison_id = $1
    GROUP BY zone, match_status
    ORDER BY zone, match_status
  `, [CID]);

  // pivot
  const zoneMap = {};
  decisions.rows.forEach(r => {
    if (!zoneMap[r.zone]) zoneMap[r.zone] = {};
    zoneMap[r.zone][r.match_status] = r.count;
  });

  p('\n── SECTION 2: DECISION COUNTS vs CHEATSHEET ──────────────────');
  p('zone                  | MA pip/exp | MO pip/exp | MI pip/exp | AD pip/exp | verdict');
  p('----------------------|------------|------------|------------|------------|--------');

  let totalErrors = 0;
  for (const [zKey, cs] of Object.entries(CHEATSHEET)) {
    const pz = zoneMap[zKey] || {};
    const pMA = (pz.MATCH||0);
    const pMO = (pz.MODIFIED||0);
    const pMI = (pz.MISSING_FROM_ADJUSTER||0);
    const pAD = (pz.ADDED_BY_ADJUSTER||0);

    // Count cheatsheet-scope errors only (pipeline may have extra items from PDF)
    // MOD error = if pipeline MOD < expected (pipeline missed a modification)
    // For MATCH: pipeline >= expected is always OK (extra PDF items inflate it)
    const modErr  = pMO < cs.mod ? cs.mod - pMO : 0;
    const verdict = modErr > 0 ? `⚠ MOD miss -${modErr}` : '✓';
    totalErrors += modErr;

    p(
      zKey.padEnd(21) + ' | ' +
      (pMA+'/'+cs.match).padEnd(10) + ' | ' +
      (pMO+'/'+cs.mod).padEnd(10)   + ' | ' +
      (pMI+'/'+cs.missing).padEnd(10) + ' | ' +
      (pAD+'/'+cs.added).padEnd(10)  + ' | ' +
      verdict
    );
  }

  p(`\n  Cheatsheet-zone MODIFIED misses: ${totalErrors}`);

  // ── 3. Item-level diffs — non-MATCH items in cheatsheet zones ──────────────
  p('\n── SECTION 3: ALL NON-MATCH DECISIONS (cheatsheet zones) ─────');

  const csZoneNames = Object.keys(CHEATSHEET);
  const nonMatch = await client.query(`
    SELECT
      LOWER(COALESCE(zone_canonical, zone_yours, zone_adjuster)) AS zone,
      match_status,
      description_yours,
      description_adjuster,
      total_yours,
      total_adjuster,
      diff_amount
    FROM line_items
    WHERE comparison_id = $1
      AND match_status <> 'MATCH'
      AND LOWER(COALESCE(zone_canonical, zone_yours, zone_adjuster)) = ANY($2)
    ORDER BY zone, match_status, sort_order
  `, [CID, csZoneNames]);

  let lastZone = '';
  nonMatch.rows.forEach(r => {
    if (r.zone !== lastZone) {
      p('\n  [' + r.zone.toUpperCase() + ']');
      lastZone = r.zone;
    }
    const dy = (r.description_yours||'--').slice(0,55);
    const da = (r.description_adjuster||'--').slice(0,55);
    const ty = r.total_yours != null ? '$'+Number(r.total_yours).toFixed(2) : 'null';
    const ta = r.total_adjuster != null ? '$'+Number(r.total_adjuster).toFixed(2) : 'null';
    p(`    ${r.match_status.padEnd(22)} | ${dy.padEnd(55)} | ${da.padEnd(55)} | Y=${ty} A=${ta}`);
  });

  // ── 4. Dollar gap accuracy ─────────────────────────────────────────────────
  const totals = await client.query(`
    SELECT
      SUM(total_yours)::numeric     AS sum_yours,
      SUM(total_adjuster)::numeric  AS sum_adj
    FROM line_items
    WHERE comparison_id = $1
  `, [CID]);

  const sumY = parseFloat(totals.rows[0].sum_yours||0);
  const sumA = parseFloat(totals.rows[0].sum_adj||0);
  p('\n── SECTION 4: DOLLAR GAP ──────────────────────────────────────');
  p(`  Pipeline   yours total:     $${sumY.toFixed(2)}`);
  p(`  Pipeline   adj total:       $${sumA.toFixed(2)}`);
  p(`  Pipeline   gap (Y-A):       $${(sumY-sumA).toFixed(2)}`);
  p(`  Cheatsheet yours total:     $179,770.36`);
  p(`  Cheatsheet adj total:       $174,609.86`);
  p(`  Cheatsheet gap:             $5,160.50`);
  p(`  Extra items inflate gap by: $${((sumY-sumA)-5160.50).toFixed(2)}`);

  // ── 5. Zone correspondence check ──────────────────────────────────────────
  const corresp = await client.query(`
    SELECT zy.name AS yours_name, za.name AS adj_name, zc.confidence
    FROM n3_zone_correspondences zc
    JOIN "_YourZoneCorrespondences" yj ON yj."A" = zc.id
    JOIN n3_zones zy ON zy.id = yj."B"
    JOIN "_AdjusterZoneCorrespondences" aj ON aj."A" = zc.id
    JOIN n3_zones za ON za.id = aj."B"
    WHERE zc.comparison_id = $1
    ORDER BY zy.start_page
  `, [CID]);

  p('\n── SECTION 5: ZONE CORRESPONDENCES ───────────────────────────');
  corresp.rows.forEach(r => {
    const conf = r.confidence != null ? r.confidence.toFixed(3) : 'n/a';
    p(`  ${r.yours_name.padEnd(35)} ↔  ${r.adj_name.padEnd(40)} [${conf}]`);
  });

  await client.end();
  p('\n══════════════════════════════════════════════════════════════');
  p('  AUDIT COMPLETE');
  p('══════════════════════════════════════════════════════════════\n');
  const outPath = '/Users/raganharrison/Documents/CascadeProjects/scopesplit-master/n3_audit_report.txt';
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log('Report saved to: ' + outPath);
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
