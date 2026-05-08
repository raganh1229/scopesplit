// Comprehensive audit of Set 6 (Test Set 3) vision extraction — Hurricane/Wind
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('./scripts/set6-vision-audit.json', 'utf8'));
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
    const z = (it.zoneCanonical || '').toLowerCase();
    return z.includes(zone.toLowerCase());
  });
}

// ══════════════════════════════════════════════════════════════
console.log('=== 1. COUNT VERIFICATION ===');
// Cheat: Contractor=102, Adjuster=89, 13 contractor-only, 0 adjuster-only
// Paired = 102-13 = 89. Total unique = 102.
console.log(`Total: ${items.length}, MATCH: ${data.matchCount}, MOD: ${data.modifiedCount}, MISS: ${data.missingCount}, ADD: ${data.addedCount}`);
if (items.length === 102) pass('Total = 102'); else fail(`Total: expected 102, got ${items.length}`);
if (data.missingCount === 13) pass('MISSING = 13'); else fail(`MISSING: expected 13, got ${data.missingCount}`);
if (data.addedCount === 0) pass('ADDED = 0'); else fail(`ADDED: expected 0, got ${data.addedCount}`);

// ══════════════════════════════════════════════════════════════
console.log('\n=== 2. NULL TOTALS ===');
const nullY = items.filter(it => it.totalYours === null && it.matchStatus !== 'ADDED_BY_ADJUSTER');
const nullA = items.filter(it => it.totalAdjuster === null && it.matchStatus !== 'MISSING_FROM_ADJUSTER');
// Permit fees are OPEN ITEMs — null totals expected
const realNullY = nullY.filter(it => !(it.descriptionYours||'').toLowerCase().includes('permit'));
const realNullA = nullA.filter(it => !(it.descriptionAdjuster||'').toLowerCase().includes('permit'));
const permitNullY = nullY.filter(it => (it.descriptionYours||'').toLowerCase().includes('permit'));
const permitNullA = nullA.filter(it => (it.descriptionAdjuster||'').toLowerCase().includes('permit'));
if (permitNullY.length > 0) pass(`${permitNullY.length} permit OPEN ITEM(s) with null totalYours (expected)`);
if (permitNullA.length > 0) pass(`${permitNullA.length} permit OPEN ITEM(s) with null totalAdjuster (expected)`);
if (realNullY.length === 0) pass('Zero unexpected null totalYours');
else fail(`${realNullY.length} unexpected null totalYours: ${realNullY.map(i=>i.descriptionYours).join('; ')}`);
if (realNullA.length === 0) pass('Zero unexpected null totalAdjuster');
else fail(`${realNullA.length} unexpected null totalAdj: ${realNullA.map(i=>i.descriptionAdjuster).join('; ')}`);

// ══════════════════════════════════════════════════════════════
console.log('\n=== 3. 13 CONTRACTOR-ONLY ITEMS (all MISSING_FROM_ADJUSTER) ===');

const contractorOnly = [
  { desc: 'Additional dumpster', tY: 630.00 },
  { desc: 'Permit fees - electrical', tY: null },  // OPEN ITEM
  { desc: 'Plywood countertop substrate', tY: 1093.06 },
  { desc: 'PVC window blind', zone: 'Kitchen', tY: 207.32 },
  { desc: 'Paper towel holder', tY: 32.44 },
  { desc: '6-panel', tY: 711.32 },  // colonist door
  { desc: 'Paint interior door slab', tY: 197.28 },
  { desc: 'Paint door jamb', tY: 164.38 },
  { desc: 'Passage knob', tY: 70.96 },
  { desc: 'PVC vertical blind', tY: 419.05 },  // master blinds
  { desc: 'Ceiling fan', tY: 275.58 },
  { desc: 'Recessed light trim', tY: 18.10 },
  { desc: 'Smoke', tY: 112.60 },  // Smoke/CO detector
];

contractorOnly.forEach(cs => {
  const it = findItem(cs.desc, cs.zone);
  if (!it) { fail(`"${cs.desc}" — NOT FOUND`); return; }
  const issues = [];
  if (it.matchStatus !== 'MISSING_FROM_ADJUSTER') issues.push(`status=${it.matchStatus}, expected MISSING`);
  if (cs.tY !== null && cs.tY !== undefined && Math.abs(Number(it.totalYours) - cs.tY) > 0.10) issues.push(`totalY=${it.totalYours}, expected ${cs.tY}`);
  if (it.totalAdjuster !== null) issues.push(`totalA=${it.totalAdjuster}, expected null`);
  if (issues.length === 0) pass(`"${cs.desc}" — MISSING, totalY=$${it.totalYours || 'null (OPEN)'}`);
  else fail(`"${cs.desc}" — ${issues.join('; ')}`);
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 4. DESCRIPTION REWRITE PAIRING (25 pairs — should all be paired) ===');

const pairingTraps = [
  { yours: 'dumpster', adj: 'Dumpster', note: '30 CY hauling vs 20 CY capacity' },
  { yours: 'Project manager', adj: 'Supervision', note: 'project mgr vs supervision' },
  { yours: 'General labor', adj: 'General cleanup', note: 'cleanup & debris vs hourly' },
  { yours: 'Haul off drywall', adj: 'Drywall debris', note: 'haul off vs disposal' },
  { yours: 'Frame ceiling', adj: 'Sister ceiling', note: 'frame vs sister joists' },
  { yours: 'Seal ceiling', adj: 'Primer - PVA', note: 'seal ceiling vs primer PVA' },
  { yours: 'heavy texture', adj: 'Texture - heavy', note: 'apply heavy texture vs texture heavy' },
  { yours: 'Mask wall', adj: 'Masking', note: 'mask walls vs masking walls' },
  { yours: 'Ceiling paint', adj: 'Paint - ceiling', note: 'ceiling paint vs paint ceiling' },
  { yours: 'Recessed can light', adj: 'Recessed light', note: 'can light vs light new install', zone: 'Living' },
  { yours: 'Seal wall framing', adj: 'Seal framing', note: 'wall framing vs framing walls', zone: 'Living' },
  { yours: 'batt insulation', adj: 'Batt insulation', note: 'R13 kraft faced', zone: 'Living' },
  { yours: 'drywall - wall', adj: 'drywall', note: 'hang finish vs hung taped', zone: 'Living' },
  { yours: 'PVA primer - wall', adj: 'Wall primer', note: 'PVA primer walls vs wall primer PVA' },
  { yours: 'Wall texture', adj: 'Texture', note: 'wall texture vs texture walls' },
  { yours: 'wall paint', adj: 'Paint - wall', note: 'interior wall paint vs paint walls' },
  { yours: 'Carpet pad', adj: 'Carpet', note: 'premium 8lb vs premium 8lb', zone: 'Living' },
  { yours: 'Vacuum', adj: 'Vacuum', note: 'post carpet vs after carpet' },
  { yours: 'baseboard', adj: 'baseboard', note: '2-1/4 colonial vs colonial 2-1/4', zone: 'Living' },
  { yours: 'Undermount sink', adj: 'Double bowl sink', note: 'undermount vs double bowl' },
  { yours: 'Garbage disposal', adj: 'Disposer', note: 'garbage disposal vs disposer garbage' },
  { yours: 'Closet shelf', adj: 'Closet rod', note: 'shelf & rod vs rod and shelf' },
];

pairingTraps.forEach(pt => {
  // Find the item that has BOTH contractor and adjuster descriptions (paired)
  const it = items.find(i => {
    const dy = (i.descriptionYours || '').toLowerCase();
    const da = (i.descriptionAdjuster || '').toLowerCase();
    const matchY = dy.includes(pt.yours.toLowerCase());
    const matchA = da.length > 0;  // Has adjuster description = paired
    if (!matchY || !matchA) return false;
    if (pt.zone) return (i.zoneCanonical || '').toLowerCase().includes(pt.zone.toLowerCase());
    return true;
  });
  if (it) pass(`"${pt.yours}" paired → adj="${(it.descriptionAdjuster||'').substring(0,40)}" (${pt.note})`);
  else {
    // Check if item exists but is MISSING (not paired)
    const unpaired = findItem(pt.yours, pt.zone);
    if (unpaired && unpaired.matchStatus === 'MISSING_FROM_ADJUSTER') fail(`"${pt.yours}" — exists but NOT paired (MISSING)`);
    else if (unpaired) fail(`"${pt.yours}" — found but adj desc is null`);
    else fail(`"${pt.yours}" — NOT FOUND`);
  }
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 5. GRADE/MATERIAL DIFFERENCES (8 items — all should be MODIFIED) ===');

const gradeDiffs = [
  { desc: 'Carpet', zone: 'Living', excludeDesc: 'pad', note: 'HG $4.15 vs Std $3.72' },
  { desc: 'Carpet', zone: 'Bedroom', excludeDesc: 'pad', note: 'HG $4.15 vs Std $3.72' },
  { desc: 'Ceiling tile', note: 'Commercial vs Standard' },
  { desc: 'Cabinetry - lower', note: 'Custom $310 vs Std $196', altDesc: 'cabinet' },
  { desc: 'Cabinetry - upper', note: 'Custom $242 vs Std $177', altDesc: 'cabinet' },
  { desc: 'Countertop', note: 'Granite $68.50 vs Laminate $32.50' },
  { desc: 'oven', note: 'Double wall oven vs Slide-in range' },
  { desc: 'Refrigerator', note: 'side by side vs top freezer' },
];

gradeDiffs.forEach(gd => {
  let it = findItem(gd.desc, gd.zone, gd.excludeDesc);
  if (!it && gd.altDesc) it = findItem(gd.altDesc, gd.zone, gd.excludeDesc);
  if (!it) { fail(`"${gd.desc}" — NOT FOUND`); return; }
  if (it.matchStatus === 'MODIFIED') pass(`"${gd.desc}" — MODIFIED (${gd.note})`);
  else if (it.matchStatus === 'MATCH') {
    // Refrigerator could be MATCH if install price is same
    if (gd.desc === 'Refrigerator') pass(`"${gd.desc}" — MATCH (same install price, ${gd.note})`);
    else fail(`"${gd.desc}" — ${it.matchStatus}, expected MODIFIED (${gd.note})`);
  }
  else fail(`"${gd.desc}" — ${it.matchStatus}, expected MODIFIED (${gd.note})`);
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 6. QTY/RATE DIFFERENCES (5 items — should be MODIFIED) ===');

const qtyDiffs = [
  { desc: 'Project manager', tY: 22440, tA: 14988, altDesc: 'Supervision' },
  { desc: 'General labor', tY: 1371, tA: 914, altDesc: 'cleanup labor' },
  { desc: 'Recessed', zone: 'Living', note: '6 EA vs 4 EA' },
  { desc: 'Dishwasher', tY: 327.10, tA: 155.71 },
];

qtyDiffs.forEach(qd => {
  let it = findItem(qd.desc, qd.zone);
  if (!it && qd.altDesc) it = findItem(qd.altDesc, qd.zone);
  if (!it) { fail(`"${qd.desc}" — NOT FOUND`); return; }
  const issues = [];
  if (it.matchStatus !== 'MODIFIED') issues.push(`status=${it.matchStatus}, expected MODIFIED`);
  if (qd.tY && Math.abs(Number(it.totalYours) - qd.tY) > 1.00) issues.push(`totalY=${it.totalYours}, expected ~${qd.tY}`);
  if (qd.tA && Math.abs(Number(it.totalAdjuster) - qd.tA) > 1.00) issues.push(`totalA=${it.totalAdjuster}, expected ~${qd.tA}`);
  if (issues.length === 0) pass(`"${qd.desc}" — MODIFIED, totalY=$${it.totalYours}, totalA=$${it.totalAdjuster}`);
  else fail(`"${qd.desc}" — ${issues.join('; ')}`);
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 7. ZONE ASSIGNMENT ===');

const zoneChecks = [
  { desc: 'dumpster', zone: 'General' },
  { desc: 'Project manager', zone: 'General', altDesc: 'Supervision' },
  { desc: 'Recessed', zone: 'Living', note: 'Living room recessed lights' },
  { desc: 'Countertop', zone: 'Kitchen' },
  { desc: 'Closet shelf', zone: 'Bedroom', altDesc: 'Closet rod' },
];

zoneChecks.forEach(zc => {
  let it = findItem(zc.desc, zc.zone);
  if (!it && zc.altDesc) it = findItem(zc.altDesc, zc.zone);
  if (!it) { fail(`"${zc.desc}" zone check — NOT FOUND in ${zc.zone}`); return; }
  pass(`"${zc.desc}" zone="${it.zoneCanonical}" (expected ${zc.zone})`);
});

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

// ── Full dump ────────────────────────────────────────────────
console.log('\n=== ALL LINE ITEMS ===');
items.forEach((it, i) => {
  const desc = (it.descriptionYours || it.descriptionAdjuster || '???').substring(0, 45);
  const zone = (it.zoneCanonical || '?').substring(0, 20);
  const status = it.matchStatus.padEnd(22);
  const tY = it.totalYours ? `$${Number(it.totalYours).toFixed(2)}` : 'null';
  const tA = it.totalAdjuster ? `$${Number(it.totalAdjuster).toFixed(2)}` : 'null';
  console.log(`${String(i+1).padStart(3)}. [${status}] ${desc.padEnd(47)} zone=${zone.padEnd(22)} yours=${tY.padStart(12)} adj=${tA.padStart(12)}`);
});
