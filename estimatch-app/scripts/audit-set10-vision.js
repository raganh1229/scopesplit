// Comprehensive audit of Set 10 folder (Set 8 PDFs) — Tropical Storm / Water — Tampa FL
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('./scripts/set10-vision-audit.json', 'utf8'));
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
// Cheat: Contractor=43, Adjuster=50
const paired = data.matchCount + data.modifiedCount;
const contractorItems = paired + data.missingCount;
const adjusterItems = paired + data.addedCount;
console.log(`Total: ${items.length}, MATCH: ${data.matchCount}, MOD: ${data.modifiedCount}, MISS: ${data.missingCount}, ADD: ${data.addedCount}`);
console.log(`  Paired: ${paired}, Contractor: ${contractorItems}, Adjuster: ${adjusterItems}`);

if (contractorItems === 43) pass('Contractor items = 43'); else fail(`Contractor items: expected 43, got ${contractorItems}`);
if (adjusterItems === 50) pass('Adjuster items = 50'); else fail(`Adjuster items: expected 50, got ${adjusterItems}`);
if (items.length === data.matchCount + data.modifiedCount + data.missingCount + data.addedCount) pass('Total = sum of statuses');
else fail('Total ≠ sum of statuses');

// ══════════════════════════════════════════════════════════════
console.log('\n=== 2. NULL TOTALS ===');
// Permits are OPEN items — allow null/0
const nullY = items.filter(it => it.totalYours === null && it.matchStatus !== 'ADDED_BY_ADJUSTER');
const nullA = items.filter(it => it.totalAdjuster === null && it.matchStatus !== 'MISSING_FROM_ADJUSTER');
// Permits may have null totals
const permitNullY = nullY.filter(it => (it.descriptionYours || '').toLowerCase().includes('permit'));
const permitNullA = nullA.filter(it => (it.descriptionAdjuster || '').toLowerCase().includes('permit'));
const realNullY = nullY.filter(it => !(it.descriptionYours || '').toLowerCase().includes('permit'));
const realNullA = nullA.filter(it => !(it.descriptionAdjuster || '').toLowerCase().includes('permit'));
if (realNullY.length === 0) pass('Zero unexpected null totalYours');
else { fail(`${realNullY.length} null totalYours`); realNullY.forEach(i => console.log(`    -> [${i.matchStatus}] ${(i.descriptionYours||'').substring(0,50)}`)); }
if (realNullA.length === 0) pass('Zero unexpected null totalAdjuster');
else { fail(`${realNullA.length} null totalAdj`); realNullA.forEach(i => console.log(`    -> [${i.matchStatus}] ${(i.descriptionAdjuster||'').substring(0,50)}`)); }
if (permitNullY.length + permitNullA.length > 0) pass(`Permits open item(s): ${permitNullY.length + permitNullA.length} null total(s) — expected`);

// ══════════════════════════════════════════════════════════════
console.log('\n=== 3. CONTRACTOR-ONLY ITEMS (should be MISSING_FROM_ADJUSTER) ===');

const contractorOnly = [
  { desc: 'Temporary power hookup', tY: 762.26 },
  { desc: 'Ceiling fan', tY: 275.59 },
  { desc: 'Medicine cabinet', tY: 273.76 },
];

contractorOnly.forEach(cs => {
  const it = findItem(cs.desc);
  if (!it) { fail(`"${cs.desc}" — NOT FOUND`); return; }
  const issues = [];
  if (it.matchStatus !== 'MISSING_FROM_ADJUSTER') {
    if (it.matchStatus === 'MODIFIED') {
      // Known issue: may have been mispaired
      const adjDesc = (it.descriptionAdjuster || '').substring(0, 40);
      fail(`"${cs.desc}" — MISPAIRED as MODIFIED with adj="${adjDesc}" (should be MISSING)`);
      return;
    }
    issues.push(`status=${it.matchStatus}, expected MISSING`);
  }
  if (cs.tY && Math.abs(Number(it.totalYours) - cs.tY) > 1) issues.push(`totalY=${it.totalYours}, expected ~${cs.tY}`);
  if (issues.length === 0) pass(`"${cs.desc}" — MISSING, totalY=$${it.totalYours}`);
  else fail(`"${cs.desc}" — ${issues.join('; ')}`);
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 4. ADJUSTER-ONLY ITEMS (10 expected — 4 inserts + 6 Exterior) ===');

const adjusterOnly = [
  { desc: 'Haul off ceiling drywall debris', zone: 'Room 2', tA: 37.80 },  // Master
  { desc: 'Smoke detector', tA: 116.67 },
  { desc: 'Drywall debris removal', zone: 'Room 1', tA: 58.50 },  // Living
  { desc: 'Suspended ceiling grid', zone: 'Kitchen', tA: 142.68 },
  { desc: 'Vinyl window', zone: 'Exterior', tA: 806.16 },
  { desc: 'Window trim', zone: 'Exterior', tA: 109.93 },
  { desc: 'Exterior caulk', zone: 'Exterior', tA: 44.05 },
  { desc: 'Fascia board', zone: 'Exterior', tA: 190.34 },
  { desc: 'Paint fascia', zone: 'Exterior', tA: 61.38 },
  { desc: 'Pressure wash', zone: 'Exterior', tA: 172.80 },
];

adjusterOnly.forEach(cs => {
  const it = findItem(cs.desc, cs.zone);
  if (!it) { fail(`"${cs.desc}" — NOT FOUND as ADDED`); return; }
  const issues = [];
  if (it.matchStatus !== 'ADDED_BY_ADJUSTER') {
    if (it.matchStatus === 'MODIFIED') {
      const yourDesc = (it.descriptionYours || '').substring(0, 40);
      fail(`"${cs.desc}" — MISPAIRED as MODIFIED with yours="${yourDesc}" (should be ADDED)`);
      return;
    }
    issues.push(`status=${it.matchStatus}, expected ADDED`);
  }
  if (cs.tA && Math.abs(Number(it.totalAdjuster) - cs.tA) > 1) issues.push(`totalA=${it.totalAdjuster}, expected ~${cs.tA}`);
  if (issues.length === 0) pass(`"${cs.desc}" — ADDED, totalA=$${it.totalAdjuster}`);
  else fail(`"${cs.desc}" — ${issues.join('; ')}`);
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 5. KEY DISCREPANCIES (should be MODIFIED) ===');

const priceDiffs = [
  { desc: 'Project manager', note: '$85/hr vs $78.06/hr' },
  { desc: 'Cleanup labor', note: '20HR vs 16HR + rate diff', altDesc: 'General cleanup' },
  { desc: 'Floor protection', note: '400SF vs 350SF' },
  { desc: 'Recessed', note: '4@$155 vs 3@$138', zone: 'Room 1' },
  { desc: 'Wall paint - eggshell', note: 'eggshell vs satin (adj higher!)', zone: 'Room 1' },
  { desc: 'Carpet - plush', note: 'high grade vs std', zone: 'Room 1', altDesc: 'Carpet' },
  { desc: 'Baseboard', note: '3-1/4" vs 2-1/4"', zone: 'Room 1' },
  { desc: 'Knockdown texture', note: 'knockdown vs orange peel', zone: 'Room 2', altDesc: 'texture' },
  { desc: 'Wall paint - satin', note: 'satin vs flat', zone: 'Room 2', altDesc: 'Wall paint' },
  { desc: 'Carpet pad', note: '8lb vs 6lb', zone: 'Room 2' },
  { desc: '5/8" drywall - ceiling', note: '5/8" vs 1/2"', zone: 'Kitchen', altDesc: 'drywall - ceiling' },
  { desc: 'Wall paint - eggshell', note: 'eggshell vs satin (adj higher!)', zone: 'Kitchen', altDesc: 'Wall paint' },
  { desc: 'Ceramic tile floor', note: 'ceramic vs porcelain (adj higher!)', zone: 'Kitchen', altDesc: 'tile floor' },
  { desc: 'Base cabinets - custom', note: 'custom $310 vs std $196', zone: 'Kitchen', altDesc: 'cabinet' },
  { desc: 'Granite countertop', note: 'granite vs laminate', zone: 'Kitchen', altDesc: 'countertop' },
  { desc: 'Final clean', note: 'rate $0.45 vs $0.33', zone: 'Kitchen' },
  { desc: 'Moisture-resistant drywall', note: 'MR vs standard', zone: 'Bathroom', altDesc: 'drywall' },
  { desc: 'Exhaust fan', note: '110CFM vs 80CFM', zone: 'Bathroom' },
];

priceDiffs.forEach(pd => {
  let it = findItem(pd.desc, pd.zone, pd.excludeDesc);
  if (!it && pd.altDesc) it = findItem(pd.altDesc, pd.zone);
  if (!it) { fail(`"${pd.desc}" — NOT FOUND (${pd.note})`); return; }
  if (it.matchStatus === 'MODIFIED') pass(`"${pd.desc}" — MODIFIED (${pd.note})`);
  else fail(`"${pd.desc}" — ${it.matchStatus}, expected MODIFIED (${pd.note})`);
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 6. ADJUSTER-HIGHER CHECKS ===');
// Living wall paint: eggshell→satin (adj higher), Kitchen paint (eggshell→satin), Kitchen tile (ceramic→porcelain)
const checks = [
  { desc: 'Wall paint - eggshell', zone: 'Room 1', note: 'Living: eggshell→satin', altDesc: 'Wall paint' },
  { desc: 'Wall paint - eggshell', zone: 'Kitchen', note: 'Kitchen: eggshell→satin', altDesc: 'Wall paint' },
  { desc: 'Ceramic tile floor', zone: 'Kitchen', note: 'Kitchen: ceramic→porcelain', altDesc: 'tile floor' },
];
checks.forEach(c => {
  let it = findItem(c.desc, c.zone);
  if (!it && c.altDesc) it = findItem(c.altDesc, c.zone);
  if (it) {
    const tY = Number(it.totalYours);
    const tA = Number(it.totalAdjuster);
    if (tA > tY) pass(`${c.note}: adj($${tA}) > yours($${tY})`);
    else fail(`${c.note}: expected adj > yours, got tY=$${tY}, tA=$${tA}`);
  }
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 7. DESCRIPTION REWRITE PAIRING ===');

const pairingChecks = [
  { yours: 'Heavy hand texture', adj: 'Knockdown texture', note: 'heavy hand = knockdown (same $)', zone: 'Room 1' },
  { yours: 'Seal wall framing', adj: 'Shellac seal', note: 'seal framing = shellac seal', zone: 'Room 1' },
  { yours: 'Seal wall framing', adj: 'Wall stud seal', note: 'seal framing = wall stud seal', zone: 'Kitchen' },
];

pairingChecks.forEach(pc => {
  const it = findItem(pc.yours, pc.zone);
  if (!it) { fail(`"${pc.yours}" — NOT FOUND`); return; }
  if (it.descriptionAdjuster && it.descriptionAdjuster.length > 0)
    pass(`"${pc.yours}" paired → adj="${(it.descriptionAdjuster||'').substring(0,40)}" (${pc.note})`);
  else fail(`"${pc.yours}" — not paired (${pc.note})`);
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 8. ZONE ASSIGNMENT & EXTERIOR ZONE ===');

const zoneChecks = [
  { desc: 'Dumpster', zone: 'General' },
  { desc: 'Carpet - plush', zone: 'Room 1', altDesc: 'Carpet', note: 'Living Area' },
  { desc: 'Carpet pad', zone: 'Room 2', note: 'Master Bedroom' },
  { desc: 'Granite countertop', zone: 'Kitchen', altDesc: 'countertop' },
  { desc: 'Exhaust fan', zone: 'Bathroom' },
  { desc: 'Vinyl window', zone: 'Exterior' },
];

zoneChecks.forEach(zc => {
  let it = findItem(zc.desc, zc.zone);
  if (!it && zc.altDesc) it = findItem(zc.altDesc, zc.zone);
  if (!it) { fail(`"${zc.desc}" — NOT FOUND in zone ${zc.zone}`); return; }
  pass(`"${zc.desc}" zone="${it.zoneCanonical}" (expected ${zc.zone}${zc.note ? ' / ' + zc.note : ''})`);
});

// Verify Exterior zone is adjuster-only (all 6 items are ADDED)
const exteriorItems = items.filter(it => (it.zoneCanonical || '').toLowerCase().includes('exterior'));
const exteriorAdded = exteriorItems.filter(it => it.matchStatus === 'ADDED_BY_ADJUSTER');
if (exteriorItems.length === 6 && exteriorAdded.length === 6)
  pass(`Exterior zone: all 6 items are ADDED (adjuster-only zone)`);
else
  fail(`Exterior zone: ${exteriorItems.length} items, ${exteriorAdded.length} ADDED (expected 6/6)`);

// Expected zones
const expectedZones = ['General', 'Room 1', 'Room 2', 'Kitchen', 'Bathroom', 'Exterior'];
expectedZones.forEach(ez => {
  const count = items.filter(it => (it.zoneCanonical || '') === ez).length;
  if (count > 0) pass(`Zone "${ez}" has ${count} items`);
  else fail(`Zone "${ez}" has 0 items`);
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 9. PERMITS / OPEN ITEM ===');
const permit = findItem('Permit');
if (permit) {
  const isMatch = permit.matchStatus === 'MATCH';
  const isOpen = permit.totalYours === 0 || permit.totalYours === null || permit.totalAdjuster === 0 || permit.totalAdjuster === null;
  if (isMatch && isOpen) pass(`Permits — MATCH, open item (tY=$${permit.totalYours}, tA=$${permit.totalAdjuster})`);
  else fail(`Permits — status=${permit.matchStatus}, tY=$${permit.totalYours}, tA=$${permit.totalAdjuster}`);
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
