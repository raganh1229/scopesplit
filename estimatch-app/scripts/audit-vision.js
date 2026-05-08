// Comprehensive audit of vision extraction results against Set 4 cheat sheet
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('./scripts/set4-vision-audit.json', 'utf8'));
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

function checkNum(actual, expected, label, tolerance = 0.02) {
  if (expected === undefined || expected === null) return;
  const a = Number(actual);
  if (Math.abs(a - expected) <= tolerance) pass(`${label}: ${a} = ${expected}`);
  else fail(`${label}: expected ${expected}, got ${a}`);
}

// ══════════════════════════════════════════════════════════════
console.log('=== 1. COUNT VERIFICATION ===');
// Cheat sheet: Contractor = 87 items, Adjuster = ~80 items
// Expected: 10 MISSING, 3 ADDED, remaining paired (65 MATCH + 12 MODIFIED = 77)
// Total unique = 87 + 3 = 90  (or 80 + 10 = 90)
console.log(`Total items: ${items.length}`);
if (items.length === 90) pass('Total count = 90'); else fail(`Total count: expected 90, got ${items.length}`);
if (data.matchCount === 65) pass('MATCH = 65'); else fail(`MATCH: expected 65, got ${data.matchCount}`);
if (data.modifiedCount === 12) pass('MODIFIED = 12'); else fail(`MODIFIED: expected 12, got ${data.modifiedCount}`);
if (data.missingCount === 10) pass('MISSING = 10'); else fail(`MISSING: expected 10, got ${data.missingCount}`);
if (data.addedCount === 3) pass('ADDED = 3'); else fail(`ADDED: expected 3, got ${data.addedCount}`);

// ══════════════════════════════════════════════════════════════
console.log('\n=== 2. NULL TOTALS ===');
const nullTotalYours = items.filter(it => it.totalYours === null && it.matchStatus !== 'ADDED_BY_ADJUSTER');
const nullTotalAdj = items.filter(it => it.totalAdjuster === null && it.matchStatus !== 'MISSING_FROM_ADJUSTER');
if (nullTotalYours.length === 0) pass('Zero null totalYours (non-ADDED)');
else fail(`${nullTotalYours.length} null totalYours: ${nullTotalYours.map(i=>i.descriptionYours).join(', ')}`);
if (nullTotalAdj.length === 0) pass('Zero null totalAdjuster (non-MISSING)');
else fail(`${nullTotalAdj.length} null totalAdj: ${nullTotalAdj.map(i=>i.descriptionAdjuster).join(', ')}`);

// ══════════════════════════════════════════════════════════════
console.log('\n=== 3. PRICE/QTY DISCREPANCIES (13 items — all should be MODIFIED) ===');

const discrepancies = [
  { desc: 'Residential Supervision', qY: '24.00', qA: '16.00', tY: 2402.78, tA: 1601.86 },
  { desc: 'Cleaning Technician', qY: '16.00', qA: '8.00', tY: 891.08, tA: 483.96 },
  { desc: 'Dumpster load', qY: '2.00', qA: '1.00', tY: 1884.00, tA: 881.17 },
  { desc: 'Floor protection', qY: '350.00', qA: '250.00', tY: 187.05, tA: 133.61 },
  // Line 14: Wallpaper (yours) vs Paint 3-coat (adjuster) — completely different item
  // This is special: contractor has Wallpaper (MISSING), adjuster has Paint 3-coat (ADDED)
  { desc: 'French door', tY: 1005.81, tA: 1001.48, resetY: 33.33, resetA: 28.50 },
  { desc: 'Interior door', zone: 'Master Bedroom', tY: 657.40, tA: 440.95 },
  { desc: 'Vinyl floor covering', tY: 738.90, tA: 541.49 },
  { desc: 'Washer', tY: 976.31, tA: 1171.20 },
  { desc: 'Ceramic/porcelain tile - Premium', zone: 'Bathroom', tY: 990.53, tA: 772.88 },
  { desc: 'Mosaic', tY: 5624.82, tA: 4862.53 },
  { desc: 'R&R Ceramic/porcelain tile', zone: 'Bathroom', tY: 3518.66, tA: 2737.57 },
  { desc: 'Vanity', tY: 1689.31, tA: 1270.14 },
];

discrepancies.forEach(cs => {
  const it = findItem(cs.desc, cs.zone);
  if (!it) { fail(`"${cs.desc}" — NOT FOUND`); return; }
  const issues = [];
  if (it.matchStatus !== 'MODIFIED') issues.push(`status=${it.matchStatus}, expected MODIFIED`);
  if (cs.qY && !(it.qtyYours||'').startsWith(cs.qY)) issues.push(`qtyY=${it.qtyYours}, expected ${cs.qY}*`);
  if (cs.qA && !(it.qtyAdjuster||'').startsWith(cs.qA)) issues.push(`qtyA=${it.qtyAdjuster}, expected ${cs.qA}*`);
  if (cs.tY !== undefined && Math.abs(Number(it.totalYours) - cs.tY) > 0.02) issues.push(`totalY=${it.totalYours}, expected ${cs.tY}`);
  if (cs.tA !== undefined && Math.abs(Number(it.totalAdjuster) - cs.tA) > 0.02) issues.push(`totalA=${it.totalAdjuster}, expected ${cs.tA}`);
  if (cs.resetY !== undefined && Math.abs(Number(it.resetYours) - cs.resetY) > 0.02) issues.push(`resetY=${it.resetYours}, expected ${cs.resetY}`);
  if (cs.resetA !== undefined && Math.abs(Number(it.resetAdjuster) - cs.resetA) > 0.02) issues.push(`resetA=${it.resetAdjuster}, expected ${cs.resetA}`);
  if (issues.length === 0) pass(`"${cs.desc}" — MODIFIED, totalY=$${it.totalYours}, totalA=$${it.totalAdjuster}`);
  else fail(`"${cs.desc}" — ${issues.join('; ')}`);
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 4. CONTRACTOR-ONLY LINES (10 items — all MISSING_FROM_ADJUSTER) ===');

const contractorOnly = [
  { desc: 'Temporary containment wall', zone: 'General', tY: 289.37 },
  { desc: 'Prep wall for wallpaper', zone: 'Master', tY: 629.88 },
  { desc: 'Wallpaper - High grade', zone: 'Master', tY: 2332.05 },
  { desc: 'Additional charge to tile a wall', zone: 'Bathroom', tY: 318.30 },
  // Garage — 6 items
  { desc: '1/2" drywall', zone: 'Garage', tY: 1225.97 },
  { desc: 'Seal walls w/PVA primer', zone: 'Garage', tY: 544.35 },
  { desc: 'Paint the walls', zone: 'Garage', tY: 838.22 },
  { desc: 'Epoxy floor coating', zone: 'Garage', tY: 1095.02 },
  { desc: 'Garage door opener', zone: 'Garage', tY: 110.80 },
  { desc: 'Final cleaning', zone: 'Garage', tY: 95.04 },
];

contractorOnly.forEach(cs => {
  const it = findItem(cs.desc, cs.zone);
  if (!it) { fail(`"${cs.desc}" (${cs.zone}) — NOT FOUND`); return; }
  const issues = [];
  if (it.matchStatus !== 'MISSING_FROM_ADJUSTER') issues.push(`status=${it.matchStatus}, expected MISSING`);
  if (cs.tY !== undefined && Math.abs(Number(it.totalYours) - cs.tY) > 0.02) issues.push(`totalY=${it.totalYours}, expected ${cs.tY}`);
  if (it.totalAdjuster !== null) issues.push(`totalA=${it.totalAdjuster}, expected null`);
  if (issues.length === 0) pass(`"${cs.desc}" (${cs.zone}) — MISSING, totalY=$${it.totalYours}`);
  else fail(`"${cs.desc}" (${cs.zone}) — ${issues.join('; ')}`);
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 5. ADJUSTER-ONLY LINES (3 items — all ADDED_BY_ADJUSTER) ===');

const adjusterOnly = [
  { desc: 'Paint the walls - three coats', zone: 'Master', tA: 1336.66 },
  { desc: 'Vinyl floor covering labor minim', zone: 'Labor', tA: 11.89 },
  { desc: 'Door labor minimum', zone: 'Labor', tA: 172.99 },
];

adjusterOnly.forEach(cs => {
  const it = findItem(cs.desc, cs.zone);
  if (!it) { fail(`"${cs.desc}" — NOT FOUND`); return; }
  const issues = [];
  if (it.matchStatus !== 'ADDED_BY_ADJUSTER') issues.push(`status=${it.matchStatus}, expected ADDED`);
  if (cs.tA !== undefined && Math.abs(Number(it.totalAdjuster) - cs.tA) > 0.02) issues.push(`totalA=${it.totalAdjuster}, expected ${cs.tA}`);
  if (it.totalYours !== null) issues.push(`totalY=${it.totalYours}, expected null`);
  if (issues.length === 0) pass(`"${cs.desc}" — ADDED, totalA=$${it.totalAdjuster}`);
  else fail(`"${cs.desc}" — ${issues.join('; ')}`);
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 6. DESCRIPTION WORDING TRAPS (should still pair correctly) ===');

const wordingTraps = [
  { yours: 'Residential Supervision / Project', adj: 'Residential Supervision / Project' },
  { yours: 'Dumpster load - Approx. 30', adj: 'Dumpster load - Approx. 20' },
  { yours: 'Hickory floor', adj: 'Hickory floor' },
  { yours: 'Door lockset', adj: 'Door lockset' },
  { yours: 'Vinyl floor covering', adj: 'Vinyl floor covering' },
];

wordingTraps.forEach(wt => {
  const it = findItem(wt.yours);
  if (!it) { fail(`"${wt.yours}" — NOT FOUND`); return; }
  if (it.descriptionAdjuster && it.descriptionAdjuster.length > 0) {
    pass(`"${wt.yours}" paired — adj="${(it.descriptionAdjuster||'').substring(0,40)}"`);
  } else {
    fail(`"${wt.yours}" — not paired (adj description is null)`);
  }
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 7. COLUMN MAPPING (RESET column — water damage format) ===');

// French door should have non-zero RESET values
const frenchDoor = findItem('French door');
if (frenchDoor) {
  const ry = Number(frenchDoor.resetYours);
  const ra = Number(frenchDoor.resetAdjuster);
  if (Math.abs(ry - 33.33) < 0.02) pass(`French door resetYours = ${ry} (expected 33.33)`);
  else fail(`French door resetYours = ${ry}, expected 33.33`);
  if (Math.abs(ra - 28.50) < 0.02) pass(`French door resetAdjuster = ${ra} (expected 28.50)`);
  else fail(`French door resetAdjuster = ${ra}, expected 28.50`);
}

// Dumpster should have remove > 0, replace = 0, reset = 0
const dumpster = findItem('Dumpster');
if (dumpster) {
  const rm = Number(dumpster.removeYours);
  const rp = Number(dumpster.replaceYours);
  const rs = Number(dumpster.resetYours);
  if (rm > 0 && rp === 0 && rs === 0) pass(`Dumpster columns correct: rm=${rm}, rp=${rp}, rs=${rs}`);
  else fail(`Dumpster columns wrong: rm=${rm}, rp=${rp}, rs=${rs}`);
}

// Breaker panel RESET check (cheat sheet says line 55 RESET=1280.39)
const breaker = findItem('Breaker panel');
if (breaker) {
  const rs = Number(breaker.resetYours);
  if (Math.abs(rs - 1280.39) < 0.10) pass(`Breaker panel resetYours = ${rs} (expected ~1280.39)`);
  else fail(`Breaker panel resetYours = ${rs}, expected ~1280.39`);
}

// Detach & Reset AC unit RESET check (line 34 RESET=332.17)
const ac = findItem('Detach & Reset AC');
if (ac) {
  const rs = Number(ac.resetYours);
  if (Math.abs(rs - 332.17) < 0.10) pass(`AC unit resetYours = ${rs} (expected ~332.17)`);
  else fail(`AC unit resetYours = ${rs}, expected ~332.17`);
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 8. ZONE ASSIGNMENT ===');

const zoneChecks = [
  { desc: 'Residential Supervision', zone: 'General' },
  { desc: 'Hickory floor', zone: 'Master Bedroom' },
  { desc: 'Vinyl floor covering', zone: 'Laundry' },
  { desc: 'Radiant floor heating', zone: 'Bathroom' },
  { desc: 'Epoxy floor coating', zone: 'Garage' },
  { desc: 'Detach & Reset Siding', zone: 'Exterior' },
  { desc: 'Door labor minimum', zone: 'Labor' },
];

zoneChecks.forEach(zc => {
  const it = findItem(zc.desc);
  if (!it) { fail(`"${zc.desc}" — NOT FOUND`); return; }
  const z = (it.zoneCanonical || '').toLowerCase();
  if (z.includes(zc.zone.toLowerCase())) pass(`"${zc.desc}" zone="${it.zoneCanonical}" (expected ${zc.zone})`);
  else fail(`"${zc.desc}" zone="${it.zoneCanonical}", expected to contain "${zc.zone}"`);
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 9. STRUCTURAL TRAPS ===');

// Line 14 trap: Wallpaper (contractor) should be MISSING, Paint 3-coat (adjuster) should be ADDED
const wallpaper = findItem('Wallpaper - High grade', 'Master');
const paint3coat = findItem('Paint the walls - three coats', 'Master');
if (wallpaper && wallpaper.matchStatus === 'MISSING_FROM_ADJUSTER') pass('Line 14 trap: Wallpaper correctly MISSING');
else fail(`Line 14 trap: Wallpaper status=${wallpaper?.matchStatus}, expected MISSING`);
if (paint3coat && paint3coat.matchStatus === 'ADDED_BY_ADJUSTER') pass('Line 14 trap: Paint 3-coat correctly ADDED');
else fail(`Line 14 trap: Paint 3-coat status=${paint3coat?.matchStatus}, expected ADDED`);

// Garage entire room missing
const garageItems = items.filter(it => (it.zoneCanonical || '').toLowerCase().includes('garage'));
if (garageItems.length === 6) pass(`Garage: 6 items found`);
else fail(`Garage: expected 6 items, got ${garageItems.length}`);
const allGarageMissing = garageItems.every(it => it.matchStatus === 'MISSING_FROM_ADJUSTER');
if (allGarageMissing) pass('Garage: all 6 items are MISSING_FROM_ADJUSTER');
else fail('Garage: not all items are MISSING');

// Labor Minimums section added
const laborItems = items.filter(it => (it.zoneCanonical || '').toLowerCase().includes('labor'));
if (laborItems.length === 2) pass(`Labor Minimums: 2 items found`);
else fail(`Labor Minimums: expected 2, got ${laborItems.length}`);
const allLaborAdded = laborItems.every(it => it.matchStatus === 'ADDED_BY_ADJUSTER');
if (allLaborAdded) pass('Labor Minimums: all ADDED_BY_ADJUSTER');
else fail('Labor Minimums: not all ADDED');

// Cross-room duplicate description trap (Interior door in Laundry vs Master)
const doorLaundry = findItem('Interior door', 'Laundry');
const doorMaster = findItem('Interior door', 'Master');
if (doorLaundry) pass(`Interior door found in Laundry zone`);
else fail(`Interior door NOT found in Laundry`);
if (doorMaster) pass(`Interior door found in Master zone`);
else fail(`Interior door NOT found in Master`);

// ══════════════════════════════════════════════════════════════
console.log('\n==============================');
console.log(`TOTAL: ${totalPass} PASS, ${totalFail} FAIL`);
console.log('==============================');

// ── Full line item dump ──────────────────────────────────────
console.log('\n=== ALL 90 LINE ITEMS ===');
items.forEach((it, i) => {
  const desc = (it.descriptionYours || it.descriptionAdjuster || '???').substring(0, 45);
  const zone = it.zoneCanonical || '?';
  const status = it.matchStatus.padEnd(22);
  const tY = it.totalYours ? `$${Number(it.totalYours).toFixed(2)}` : 'null';
  const tA = it.totalAdjuster ? `$${Number(it.totalAdjuster).toFixed(2)}` : 'null';
  console.log(`${String(i+1).padStart(3)}. [${status}] ${desc.padEnd(47)} zone=${zone.padEnd(22)} yours=${tY.padStart(10)} adj=${tA.padStart(10)}`);
});
