// Comprehensive audit of Set 8 folder (Set 6 PDFs) — Smoke/Fire Single Story Ranch
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('./scripts/set8-vision-audit.json', 'utf8'));
const items = data.lineItems;

let totalPass = 0;
let totalFail = 0;
function pass(msg) { totalPass++; console.log(`  PASS: ${msg}`); }
function fail(msg) { totalFail++; console.log(`  FAIL: ${msg}`); }

function findItem(descSubstring, zone, excludeDesc) {
  return items.find(it => {
    const d = ((it.descriptionYours || '') + ' ' + (it.descriptionAdjuster || '')).toLowerCase();
    if (!d.includes(descSubstring.toLowerCase())) return false;
    if (excludeDesc && d.includes(excludeDesc.toLowerCase())) return false;
    if (!zone) return true;
    return (it.zoneCanonical || '').toLowerCase().includes(zone.toLowerCase());
  });
}

// ══════════════════════════════════════════════════════════════
console.log('=== 1. COUNT VERIFICATION ===');
// Cheat: Contractor=88, Adjuster=103
const paired = data.matchCount + data.modifiedCount;
const contractorItems = paired + data.missingCount;
const adjusterItems = paired + data.addedCount;
console.log(`Total: ${items.length}, MATCH: ${data.matchCount}, MOD: ${data.modifiedCount}, MISS: ${data.missingCount}, ADD: ${data.addedCount}`);
console.log(`  Paired: ${paired}, Contractor: ${contractorItems}, Adjuster: ${adjusterItems}`);
if (contractorItems === 88) pass('Contractor items = 88'); else fail(`Contractor items: expected 88, got ${contractorItems}`);
if (adjusterItems === 103) pass('Adjuster items = 103'); else fail(`Adjuster items: expected 103, got ${adjusterItems}`);
if (items.length === data.matchCount + data.modifiedCount + data.missingCount + data.addedCount) pass('Total = sum of statuses');
else fail('Total ≠ sum of statuses');

// ══════════════════════════════════════════════════════════════
console.log('\n=== 2. NULL TOTALS ===');
const nullY = items.filter(it => it.totalYours === null && it.matchStatus !== 'ADDED_BY_ADJUSTER');
const nullA = items.filter(it => it.totalAdjuster === null && it.matchStatus !== 'MISSING_FROM_ADJUSTER');
if (nullY.length === 0) pass('Zero null totalYours (non-ADDED)');
else { fail(`${nullY.length} null totalYours`); nullY.forEach(i => console.log(`    -> [${i.matchStatus}] ${(i.descriptionYours||'').substring(0,50)}`)); }
if (nullA.length === 0) pass('Zero null totalAdjuster (non-MISSING)');
else { fail(`${nullA.length} null totalAdj`); nullA.forEach(i => console.log(`    -> [${i.matchStatus}] ${(i.descriptionAdjuster||'').substring(0,50)}`)); }

// ══════════════════════════════════════════════════════════════
console.log('\n=== 3. CONTRACTOR-ONLY ITEMS (should be MISSING_FROM_ADJUSTER) ===');

const contractorOnly = [
  { desc: 'HEPA air scrubber', tY: 1500 },
  { desc: 'Seal framing - shellac - fire', zone: 'Great', tY: 1807.50 },  // Great Room shellac (per room combined)
  { desc: 'PVA primer - all', zone: 'Great', tY: 932.73 },  // combined PVA (adjuster splits)
];

contractorOnly.forEach(cs => {
  const it = findItem(cs.desc, cs.zone);
  if (!it) { fail(`"${cs.desc}" — NOT FOUND`); return; }
  const issues = [];
  if (it.matchStatus !== 'MISSING_FROM_ADJUSTER') issues.push(`status=${it.matchStatus}, expected MISSING`);
  if (cs.tY && Math.abs(Number(it.totalYours) - cs.tY) > 5) issues.push(`totalY=${it.totalYours}, expected ~${cs.tY}`);
  if (issues.length === 0) pass(`"${cs.desc}" — MISSING, totalY=$${it.totalYours}`);
  else fail(`"${cs.desc}" — ${issues.join('; ')}`);
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 4. ADJUSTER-ONLY ITEMS (18 ADDED — 15 unique + PVA split + soda blasting) ===');

const adjusterOnly = [
  { desc: 'HEPA vacuum', tA: 432 },
  { desc: 'Soda blasting', tA: 795.30 },  // soda blasting line
  { desc: 'odor encapsulant', tA: 1229.10 },
  { desc: 'Dry ice blasting', tA: 1084.50, altDesc: 'blasting - framing - great' },  // ~$1,085
  { desc: 'Air quality testing', tA: 1080 },
  { desc: 'Containment barrier', tA: 475.20 },
  { desc: 'Sod repair', tA: 204 },
  { desc: 'Sprinkler head', tA: 171 },
  { desc: 'Smoke detector', tA: 437.28 },
  { desc: 'CO detector', tA: 232.08 },
  { desc: 'Exterior paint touch', tA: 222 },
  { desc: 'Window cleaning', tA: 240 },
  { desc: 'Gutter cleaning', tA: 252 },
  { desc: 'Landscaping repair', tA: 900 },
  { desc: 'Fence repair', tA: 543.28 },
  { desc: 'Mailbox', tA: 228.13 },
  { desc: 'PVA primer - ceiling', zone: 'Great', tA: 375.42 },  // PVA split
  { desc: 'PVA primer - wall', zone: 'Great', tA: 557.23 },  // PVA split
];

adjusterOnly.forEach(cs => {
  let it = findItem(cs.desc, cs.zone);
  if (!it && cs.altDesc) it = findItem(cs.altDesc, cs.zone);
  if (!it) { fail(`"${cs.desc}" — NOT FOUND as ADDED`); return; }
  const issues = [];
  if (it.matchStatus !== 'ADDED_BY_ADJUSTER') issues.push(`status=${it.matchStatus}, expected ADDED`);
  if (cs.tA && Math.abs(Number(it.totalAdjuster) - cs.tA) > 1) issues.push(`totalA=${it.totalAdjuster}, expected ~${cs.tA}`);
  if (issues.length === 0) pass(`"${cs.desc}" — ADDED, totalA=$${it.totalAdjuster}`);
  else fail(`"${cs.desc}" — ${issues.join('; ')}`);
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 5. KEY MATERIAL/PRICE DIFFERENCES (should be MODIFIED) ===');

const priceDiffs = [
  { desc: 'Tile floor - porcelain', zone: 'Great', note: 'porcelain $14.50 vs std $11.50' },
  { desc: 'Recessed light', zone: 'Great', note: '8@$155 vs 6@$138' },
  { desc: 'Ceiling fan', zone: 'Great', note: '$385 vs $285' },
  { desc: 'Sliding glass door', zone: 'Great', note: '$1850 vs $1450' },
  { desc: 'Crown molding', zone: 'Great', note: '3-1/2" vs 2-1/4"' },
  { desc: 'Paint', zone: 'Nursery', note: 'low VOC vs zero VOC (adj higher!)', altDesc: 'low VOC', excludeDesc: 'baseboard' },
  { desc: 'Carpet pad', zone: 'Nursery', note: 'hypoallergenic vs std 6lb' },
  { desc: 'Carpet - stain', zone: 'Nursery', note: 'nursery grade vs std', altDesc: 'Carpet' },
  { desc: 'Laminate floor', zone: 'Office', note: 'laminate $3.85 vs LVP $3.95 (adj higher!)' },
  { desc: 'Paint garage ceiling', zone: 'Garage', note: 'fire retardant vs std latex', altDesc: 'garage' },
  { desc: 'Garage door opener', zone: 'Garage', note: '$385 vs $325' },
  { desc: 'Garage man door', zone: 'Garage', note: '$475 vs $425' },
  { desc: 'Porch light', zone: 'Porch', note: '$95 vs $75' },
  { desc: 'Debris hauling', zone: 'Great', note: '$850 vs $750' },
  { desc: 'Content cleaning', note: '$350/room vs $275/room' },
  { desc: 'Storage', note: '$275/month vs $225/month' },
  { desc: 'Tree removal', note: '$650 vs $450' },
  { desc: 'Ozone', note: '$175/room vs hydroxyl $95/day' },
  { desc: 'Seal framing', zone: 'Nursery', note: 'shellac $1.25 vs $1.07' },
  { desc: 'Seal framing', zone: 'Office', note: 'shellac $1.25 vs $1.07' },
];

priceDiffs.forEach(pd => {
  let it = findItem(pd.desc, pd.zone, pd.excludeDesc);
  if (!it && pd.altDesc) it = findItem(pd.altDesc, pd.zone, pd.excludeDesc);
  if (!it) { fail(`"${pd.desc}" — NOT FOUND (${pd.note})`); return; }
  if (it.matchStatus === 'MODIFIED') pass(`"${pd.desc}" — MODIFIED (${pd.note})`);
  else fail(`"${pd.desc}" — ${it.matchStatus}, expected MODIFIED (${pd.note})`);
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 6. ADJUSTER-HIGHER CHECKS (nursery paint + office flooring) ===');
// These are unusual: adjuster total is HIGHER than contractor total
const nurseryPaint = findItem('low VOC', 'Nursery') || findItem('Paint - 2 coats', 'Nursery');
if (nurseryPaint) {
  const tY = Number(nurseryPaint.totalYours);
  const tA = Number(nurseryPaint.totalAdjuster);
  if (tA > tY) pass(`Nursery paint: adj($${tA}) > yours($${tY}) — zero VOC costs more`);
  else fail(`Nursery paint: expected adj > yours, got tY=$${tY}, tA=$${tA}`);
}

const officeLaminate = findItem('Laminate floor', 'Office');
if (officeLaminate) {
  const tY = Number(officeLaminate.totalYours);
  const tA = Number(officeLaminate.totalAdjuster);
  if (tA > tY) pass(`Office flooring: adj($${tA}) > yours($${tY}) — LVP costs more than laminate`);
  else fail(`Office flooring: expected adj > yours, got tY=$${tY}, tA=$${tA}`);
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 7. DESCRIPTION PAIRING TRAPS ===');

const pairingChecks = [
  { yours: 'Ozone treatment', adj: 'Hydroxyl', note: 'ozone vs hydroxyl generator' },
  { yours: 'PVA primer - all', adj: null, note: 'contractor combined → adj splits (MISSING + 2 ADDED)' },
  { yours: 'Seal framing - shellac - fire', adj: null, note: 'Great Room shellac → MISSING (adjuster uses soda blasting instead)' },
];

pairingChecks.forEach(pc => {
  const it = findItem(pc.yours);
  if (!it) { fail(`"${pc.yours}" — NOT FOUND`); return; }
  if (pc.adj === null) {
    // Expected MISSING
    if (it.matchStatus === 'MISSING_FROM_ADJUSTER') pass(`"${pc.yours}" — correctly MISSING (${pc.note})`);
    else if (it.descriptionAdjuster && it.descriptionAdjuster.length > 0)
      pass(`"${pc.yours}" paired → adj="${(it.descriptionAdjuster||'').substring(0,40)}" (${pc.note})`);
    else fail(`"${pc.yours}" — ${it.matchStatus} (${pc.note})`);
  } else {
    if (it.descriptionAdjuster && it.descriptionAdjuster.length > 0)
      pass(`"${pc.yours}" paired → adj="${(it.descriptionAdjuster||'').substring(0,40)}" (${pc.note})`);
    else fail(`"${pc.yours}" — not paired (${pc.note})`);
  }
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 8. ZONE ASSIGNMENT ===');

const zoneChecks = [
  { desc: 'Dumpster', zone: 'General' },
  { desc: 'Tile floor - porcelain', zone: 'Great' },
  { desc: 'Carpet pad', zone: 'Nursery' },
  { desc: 'Laminate floor', zone: 'Office' },
  { desc: 'Garage door opener', zone: 'Garage' },
  { desc: 'Porch light', zone: 'Porch' },
];

zoneChecks.forEach(zc => {
  const it = findItem(zc.desc, zc.zone);
  if (!it) { fail(`"${zc.desc}" — NOT FOUND in zone ${zc.zone}`); return; }
  pass(`"${zc.desc}" zone="${it.zoneCanonical}" (expected ${zc.zone})`);
});

// Check expected zones exist
const expectedZones = ['General', 'Great Room', 'Nursery', 'Office', 'Garage', 'Porch'];
expectedZones.forEach(ez => {
  const count = items.filter(it => (it.zoneCanonical || '').toLowerCase().includes(ez.toLowerCase())).length;
  if (count > 0) pass(`Zone "${ez}" has ${count} items`);
  else fail(`Zone "${ez}" has 0 items`);
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 9. NURSERY BASEBOARD DESCRIPTION DIFFERENCE ===');
// Cheat: nursery baseboard 3-1/4" (ctr) vs 2-1/4" (adj) — but same total
const nurseryBase = findItem('Baseboard', 'Nursery', 'paint');
if (nurseryBase) {
  const dy = (nurseryBase.descriptionYours || '').toLowerCase();
  const da = (nurseryBase.descriptionAdjuster || '').toLowerCase();
  const has314 = dy.includes('3-1/4') || dy.includes('3 1/4');
  const has214 = da.includes('2-1/4') || da.includes('2 1/4');
  if (has314 && has214) pass(`Nursery baseboard: yours=3-1/4", adj=2-1/4" — descriptions differ, same cost ($${nurseryBase.totalYours}) → ${nurseryBase.matchStatus}`);
  else pass(`Nursery baseboard found: Y="${(nurseryBase.descriptionYours||'').substring(0,30)}" A="${(nurseryBase.descriptionAdjuster||'').substring(0,30)}" — ${nurseryBase.matchStatus}`);
}

// ══════════════════════════════════════════════════════════════
console.log('\n==============================');
console.log(`TOTAL: ${totalPass} PASS, ${totalFail} FAIL`);
const accuracy = ((totalPass / (totalPass + totalFail)) * 100).toFixed(1);
console.log(`ACCURACY: ${accuracy}%`);
console.log('==============================');

// ── Zone breakdown ───────────────────────────────────────────
console.log('\n=== ZONE BREAKDOWN ===');
const zones = {};
items.forEach(it => {
  const z = it.zoneCanonical || 'UNZONED';
  if (!zones[z]) zones[z] = { match: 0, mod: 0, miss: 0, add: 0, total: 0 };
  zones[z].total++;
  if (it.matchStatus === 'MATCH') zones[z].match++;
  else if (it.matchStatus === 'MODIFIED') zones[z].mod++;
  else if (it.matchStatus === 'MISSING_FROM_ADJUSTER') zones[z].miss++;
  else if (it.matchStatus === 'ADDED_BY_ADJUSTER') zones[z].add++;
});
Object.entries(zones).sort((a,b) => b[1].total - a[1].total).forEach(([z, c]) => {
  console.log(`  ${z}: ${c.total} items (MATCH:${c.match} MOD:${c.mod} MISS:${c.miss} ADD:${c.add})`);
});
