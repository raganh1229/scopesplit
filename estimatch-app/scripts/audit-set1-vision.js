// Comprehensive audit of Set 1 vision extraction against full cheat sheet
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('./scripts/set1-vision-audit.json', 'utf8'));
const items = data.lineItems;

let totalPass = 0;
let totalFail = 0;
function pass(msg) { totalPass++; console.log(`  PASS: ${msg}`); }
function fail(msg) { totalFail++; console.log(`  FAIL: ${msg}`); }

function findItem(descSubstring, zone) {
  return items.find(it => {
    const d = ((it.descriptionYours || '') + ' ' + (it.descriptionAdjuster || '')).toLowerCase();
    const matchDesc = d.includes(descSubstring.toLowerCase());
    if (!zone) return matchDesc;
    const z = (it.zoneCanonical || '').toLowerCase();
    return matchDesc && z.includes(zone.toLowerCase());
  });
}

// ══════════════════════════════════════════════════════════════
console.log('=== 1. COUNT VERIFICATION ===');
// Cheat sheet: Contractor = 95 items, Adjuster = ~89 items
// Expected: 5 MISSING (contractor-only), 1 ADDED (adjuster-only)
// Paired: 95 - 5 = 90 items on contractor side pair with 89 - 1 = 88 + some on adj...
// Cheat sheet lists 9 MODIFIED items. So MATCH = total - MODIFIED - MISSING - ADDED
console.log(`Total items: ${items.length}`);
console.log(`MATCH: ${data.matchCount}, MODIFIED: ${data.modifiedCount}, MISSING: ${data.missingCount}, ADDED: ${data.addedCount}`);

// Cheat sheet: 95 contractor + 1 adjuster-only = 96 total possible
// But some contractor items don't have adjuster pair (5 missing) → total unique = 95 + 1 = 96
// Actually: 95 contractor items, 89 adjuster items
// Shared = 89 - 1 = 88 (adjuster items that pair) ... but contractor has 95 - 5 = 90 pairable
// Hmm, 90 vs 88 — that means 2 more contractor items pair than adjuster has? 
// Actually: contractor=95, 5 only-contractor. So 90 contractor items should pair.
// adjuster=89, 1 only-adjuster. So 88 adjuster items should pair.
// But 90 ≠ 88... unless some contractor items pair to same adjuster items? Unlikely.
// Let's just verify what we got: total should be around 95 + 1 = 96 or close.
const expectedTotal = data.matchCount + data.modifiedCount + data.missingCount + data.addedCount;
if (items.length === expectedTotal) pass(`Total items (${items.length}) = sum of statuses (${expectedTotal})`);
else fail(`Total items (${items.length}) ≠ sum of statuses (${expectedTotal})`);
if (data.missingCount === 5) pass('MISSING = 5'); else fail(`MISSING: expected 5, got ${data.missingCount}`);
if (data.addedCount === 1) pass('ADDED = 1'); else fail(`ADDED: expected 1, got ${data.addedCount}`);

// ══════════════════════════════════════════════════════════════
console.log('\n=== 2. NULL TOTALS ===');
// PERMITS AND FEES is an OPEN ITEM with no dollar total — expected null
const nullTotalYours = items.filter(it => it.totalYours === null && it.matchStatus !== 'ADDED_BY_ADJUSTER');
const nullTotalAdj = items.filter(it => it.totalAdjuster === null && it.matchStatus !== 'MISSING_FROM_ADJUSTER');
const permitItem = nullTotalYours.find(it => (it.descriptionYours||'').toLowerCase().includes('permit'));
const realNullY = nullTotalYours.filter(it => !(it.descriptionYours||'').toLowerCase().includes('permit'));
const realNullA = nullTotalAdj.filter(it => !(it.descriptionAdjuster||'').toLowerCase().includes('permit'));
if (permitItem) pass('PERMITS AND FEES has null total (expected — OPEN ITEM)');
if (realNullY.length === 0) pass('Zero unexpected null totalYours');
else { fail(`${realNullY.length} unexpected null totalYours`); realNullY.forEach(i => console.log(`    -> [${i.matchStatus}] ${i.descriptionYours}`)); }
if (realNullA.length === 0) pass('Zero unexpected null totalAdjuster');
else { fail(`${realNullA.length} unexpected null totalAdj`); realNullA.forEach(i => console.log(`    -> [${i.matchStatus}] ${i.descriptionAdjuster}`)); }

// ══════════════════════════════════════════════════════════════
console.log('\n=== 3. PRICE/QTY DISCREPANCIES (9 items — all should be MODIFIED) ===');

const discrepancies = [
  { desc: 'Dumpster load', qY: '1.00', tY: 942.00, tA: 811.20 },
  { desc: 'General Laborer', qY: '12.00', qA: '8.00', tY: 685.58, tA: 457.06 },
  { desc: 'Residential Supervision', qY: '200.00', qA: '160.00', tY: 19800, tA: 14976 },
  { desc: 'Recessed light', zone: 'Entry', qY: '2.00', qA: '1.00', tY: 338.07, tA: 169.04 },
  { desc: 'Exterior double door', tY: 2448.20, tA: 2155.66, rpY: 1877.77, rpA: 1650.00 },
  { desc: 'Carpet', zone: 'Living', qY: '493.50', qA: '450.00', tY: 2337.90, tA: 2129.73, excludeDesc: 'pad' },
  { desc: 'Cabinetry - lower', tY: 6059.84, tA: 4019.84 },
  { desc: 'Cabinetry - upper', tY: 3752.87, tA: 2930.87 },
  { desc: 'double oven', tY: 226.28, tA: 170.79 },
];

discrepancies.forEach(cs => {
  let it = findItem(cs.desc, cs.zone);
  // If we need to exclude a substring (e.g. 'Carpet' but not 'Carpet pad')
  if (it && cs.excludeDesc && (it.descriptionYours||'').toLowerCase().includes(cs.excludeDesc)) {
    it = items.find(i => {
      const d = ((i.descriptionYours||'')+' '+(i.descriptionAdjuster||'')).toLowerCase();
      const z = (i.zoneCanonical||'').toLowerCase();
      return d.includes(cs.desc.toLowerCase()) && !d.includes(cs.excludeDesc) && (!cs.zone || z.includes(cs.zone.toLowerCase()));
    });
  }
  if (!it) { fail(`"${cs.desc}" — NOT FOUND`); return; }
  const issues = [];
  if (it.matchStatus !== 'MODIFIED') issues.push(`status=${it.matchStatus}, expected MODIFIED`);
  if (cs.qY && !(it.qtyYours||'').startsWith(cs.qY)) issues.push(`qtyY=${it.qtyYours}, expected ${cs.qY}*`);
  if (cs.qA && !(it.qtyAdjuster||'').startsWith(cs.qA)) issues.push(`qtyA=${it.qtyAdjuster}, expected ${cs.qA}*`);
  if (cs.tY !== undefined && Math.abs(Number(it.totalYours) - cs.tY) > 0.05) issues.push(`totalY=${it.totalYours}, expected ${cs.tY}`);
  if (cs.tA !== undefined && Math.abs(Number(it.totalAdjuster) - cs.tA) > 0.05) issues.push(`totalA=${it.totalAdjuster}, expected ${cs.tA}`);
  if (cs.rpY !== undefined && Math.abs(Number(it.replaceYours) - cs.rpY) > 0.05) issues.push(`replaceY=${it.replaceYours}, expected ${cs.rpY}`);
  if (cs.rpA !== undefined && Math.abs(Number(it.replaceAdjuster) - cs.rpA) > 0.05) issues.push(`replaceA=${it.replaceAdjuster}, expected ${cs.rpA}`);
  if (issues.length === 0) pass(`"${cs.desc}" — MODIFIED, totalY=$${it.totalYours}, totalA=$${it.totalAdjuster}`);
  else fail(`"${cs.desc}" — ${issues.join('; ')}`);
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 4. CONTRACTOR-ONLY LINES (5 items — all MISSING_FROM_ADJUSTER) ===');

const contractorOnly = [
  { desc: 'Content manipulation', tY: 1500.00 },
  { desc: 'Thermal & moisture', tY: 82.80 },
  { desc: 'Chandelier', tY: 335.33 },
  { desc: 'Crown molding - 2 1/4', tY: 233.19 },
  { desc: 'Paint crown molding', tY: 112.03 },
];

contractorOnly.forEach(cs => {
  const it = findItem(cs.desc);
  if (!it) { fail(`"${cs.desc}" — NOT FOUND`); return; }
  const issues = [];
  if (it.matchStatus !== 'MISSING_FROM_ADJUSTER') issues.push(`status=${it.matchStatus}, expected MISSING`);
  if (cs.tY !== undefined && Math.abs(Number(it.totalYours) - cs.tY) > 0.05) issues.push(`totalY=${it.totalYours}, expected ${cs.tY}`);
  if (it.totalAdjuster !== null && it.totalAdjuster !== '0') issues.push(`totalA=${it.totalAdjuster}, expected null`);
  if (issues.length === 0) pass(`"${cs.desc}" — MISSING, totalY=$${it.totalYours}`);
  else fail(`"${cs.desc}" — ${issues.join('; ')}`);
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 5. ADJUSTER-ONLY LINE (1 item — ADDED_BY_ADJUSTER) ===');

const adjusterOnly = [
  { desc: 'Window blind - PVC - 1"', tA: 103.66 },
];

adjusterOnly.forEach(cs => {
  const it = findItem(cs.desc);
  if (!it) { fail(`"${cs.desc}" — NOT FOUND`); return; }
  const issues = [];
  if (it.matchStatus !== 'ADDED_BY_ADJUSTER') issues.push(`status=${it.matchStatus}, expected ADDED`);
  if (cs.tA !== undefined && Math.abs(Number(it.totalAdjuster) - cs.tA) > 0.05) issues.push(`totalA=${it.totalAdjuster}, expected ${cs.tA}`);
  if (it.totalYours !== null && it.totalYours !== '0') issues.push(`totalY=${it.totalYours}, expected null`);
  if (issues.length === 0) pass(`"${cs.desc}" — ADDED, totalA=$${it.totalAdjuster}`);
  else fail(`"${cs.desc}" — ${issues.join('; ')}`);
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 6. DESCRIPTION WORDING TRAPS (should pair correctly despite differences) ===');

const wordingTraps = [
  { yours: 'Batt insulation', note: 'paper/foil vs paper/foil faced — descriptions truncated but items correctly paired' },
  { yours: 'Seal ceiling w/PVA primer', note: 'vs Seal the ceiling w/PVA primer' },
  { yours: 'Exterior double door', note: 'R&R Exterior vs R&R Ext.' },
  { yours: 'Residential Supervision', note: 'Project Mgmt vs Project Management' },
];

wordingTraps.forEach(wt => {
  const it = findItem(wt.yours);
  if (!it) { fail(`"${wt.yours}" — NOT FOUND`); return; }
  if (it.descriptionAdjuster && it.descriptionAdjuster.length > 0) {
    pass(`"${wt.yours}" paired — adj="${(it.descriptionAdjuster||'').substring(0,45)}" (${wt.note})`);
  } else if (it.matchStatus === 'MISSING_FROM_ADJUSTER') {
    fail(`"${wt.yours}" — wrongly MISSING (should have paired)`);
  } else {
    fail(`"${wt.yours}" — adj description is null`);
  }
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 7. COLUMN MAPPING (fire damage format — REMOVE/REPLACE/TAX/O&P/TOTAL) ===');

// Set 1 is fire damage — NO RESET column. Columns: REMOVE | REPLACE | TAX | O&P | TOTAL
// Ext double door: replace=$1,877.77 (yours), remove should be $0
const extDoor = findItem('double door');
if (extDoor) {
  const rm = Number(extDoor.removeYours);
  const rp = Number(extDoor.replaceYours);
  if (Math.abs(rp - 1877.77) < 0.05) pass(`Ext double door replaceYours = ${rp} (expected 1877.77)`);
  else fail(`Ext double door replaceYours = ${rp}, expected 1877.77`);
  // Remove cost $34.30 is real (remove old door) — verify both sides match
  const rmA = Number(extDoor.removeAdjuster);
  if (rm === rmA) pass(`Ext double door remove consistent: yours=${rm}, adj=${rmA}`);
  else fail(`Ext double door remove mismatch: yours=${rm}, adj=${rmA}`);
}

// Dumpster should have REMOVE > 0 (fire removal item)
const dumpster = findItem('Dumpster');
if (dumpster) {
  const rm = Number(dumpster.removeYours);
  const rp = Number(dumpster.replaceYours);
  const rs = Number(dumpster.resetYours);
  console.log(`  INFO: Dumpster — rm=${rm}, rp=${rp}, rs=${rs}, total=${dumpster.totalYours}`);
  if (rm > 0) pass(`Dumpster removeYours > 0 (removal item)`);
  else fail(`Dumpster removeYours = ${rm}, expected > 0`);
  // Set 1 has no RESET column
  if (rs === 0 || isNaN(rs)) pass(`Dumpster resetYours = ${rs} (no RESET column in fire format)`);
  else fail(`Dumpster resetYours = ${rs}, expected 0/null (fire format has no RESET)`);
}

// General Laborer check
const laborer = findItem('General Laborer');
if (laborer) {
  const rp = Number(laborer.replaceYours);
  // Actual PDF rate is $47.61 (not $48.70 as initially assumed)
  if (Math.abs(rp - 47.61) < 0.10) pass(`General Laborer replaceYours = ${rp} (expected ~47.61)`);
  else fail(`General Laborer replaceYours = ${rp}, expected ~47.61`);
}

// Project Mgmt: 200 HR @ $82.50 = replace should be 82.50
const projMgmt = findItem('Residential Supervision');
if (projMgmt) {
  const rp = Number(projMgmt.replaceYours);
  if (Math.abs(rp - 82.50) < 0.10) pass(`Project Mgmt replaceYours = ${rp} (expected ~82.50)`);
  else fail(`Project Mgmt replaceYours = ${rp}, expected ~82.50`);
  const rpA = Number(projMgmt.replaceAdjuster);
  if (Math.abs(rpA - 78.06) < 0.10) pass(`Project Mgmt replaceAdjuster = ${rpA} (expected ~78.06)`);
  else fail(`Project Mgmt replaceAdjuster = ${rpA}, expected ~78.06`);
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 8. ZONE ASSIGNMENT ===');

const zoneChecks = [
  { desc: 'Dumpster', zone: 'General' },
  { desc: 'Residential Supervision', zone: 'General' },
  { desc: 'Recessed light', zone: 'Entry', useZone: 'Entry' },
  { desc: 'Carpet', zone: 'Living', useZone: 'Living' },
  { desc: 'Cabinetry - lower', zone: 'Kitchen' },
  { desc: 'Cabinetry - upper', zone: 'Kitchen' },
];

zoneChecks.forEach(zc => {
  const it = findItem(zc.desc, zc.useZone);
  if (!it) { fail(`"${zc.desc}" — NOT FOUND`); return; }
  const z = (it.zoneCanonical || '').toLowerCase();
  if (z.includes(zc.zone.toLowerCase())) pass(`"${zc.desc}" zone="${it.zoneCanonical}" (expected ${zc.zone})`);
  else fail(`"${zc.desc}" zone="${it.zoneCanonical}", expected to contain "${zc.zone}"`);
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 9. STRUCTURAL TRAPS ===');

// Room ordering: rooms should be correctly assigned despite different order
// Verify that items from different rooms are in correct zones
const entryItems = items.filter(it => (it.zoneCanonical || '').toLowerCase().includes('entry'));
const familyItems = items.filter(it => (it.zoneCanonical || '').toLowerCase().includes('living'));
const kitchenItems = items.filter(it => (it.zoneCanonical || '').toLowerCase().includes('kitchen'));
const masterItems = items.filter(it => (it.zoneCanonical || '').toLowerCase().includes('bedroom'));

console.log(`  INFO: Entry=${entryItems.length}, Living=${familyItems.length}, Kitchen=${kitchenItems.length}, Bedroom=${masterItems.length}`);
if (entryItems.length > 0) pass(`Entry zone has items (${entryItems.length})`);
else fail('Entry zone has 0 items');
if (familyItems.length > 0) pass(`Living Room zone has items (${familyItems.length})`);
else fail('Living Room zone has 0 items');
if (kitchenItems.length > 0) pass(`Kitchen zone has items (${kitchenItems.length})`);
else fail('Kitchen zone has 0 items');
if (masterItems.length > 0) pass(`Bedroom zone has items (${masterItems.length})`);
else fail('Bedroom zone has 0 items');

// OPEN ITEM trap (line 4 — no dollar total)
// This item might have $0 total or be handled specially
const openItem = items.find(it => {
  const d = ((it.descriptionYours||'') + (it.descriptionAdjuster||'')).toLowerCase();
  return d.includes('open item') || d.includes('content manipulation fee') || d.includes('contents fee');
});
if (openItem) console.log(`  INFO: Open item found — status=${openItem.matchStatus}, totalY=${openItem.totalYours}, totalA=${openItem.totalAdjuster}`);

// Crown molding (line 93-94) should be MISSING
const crownMold = findItem('Crown molding');
const paintCrown = findItem('Paint crown molding');
if (crownMold && crownMold.matchStatus === 'MISSING_FROM_ADJUSTER') pass('Crown molding correctly MISSING');
else fail(`Crown molding status=${crownMold?.matchStatus}`);
if (paintCrown && paintCrown.matchStatus === 'MISSING_FROM_ADJUSTER') pass('Paint crown molding correctly MISSING');
else fail(`Paint crown molding status=${paintCrown?.matchStatus}`);

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

// ── Full line item dump ──────────────────────────────────────
console.log('\n=== ALL LINE ITEMS ===');
items.forEach((it, i) => {
  const desc = (it.descriptionYours || it.descriptionAdjuster || '???').substring(0, 45);
  const zone = (it.zoneCanonical || '?').substring(0, 20);
  const status = it.matchStatus.padEnd(22);
  const tY = it.totalYours ? `$${Number(it.totalYours).toFixed(2)}` : 'null';
  const tA = it.totalAdjuster ? `$${Number(it.totalAdjuster).toFixed(2)}` : 'null';
  console.log(`${String(i+1).padStart(3)}. [${status}] ${desc.padEnd(47)} zone=${zone.padEnd(22)} yours=${tY.padStart(12)} adj=${tA.padStart(12)}`);
});
