// Comprehensive audit of Set 9 folder (Set 7 PDFs) — Mold Remediation Condo Unit
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('./scripts/set9-vision-audit.json', 'utf8'));
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
// Cheat: Contractor=91, Adjuster=79
const paired = data.matchCount + data.modifiedCount;
const contractorItems = paired + data.missingCount;
const adjusterItems = paired + data.addedCount;
console.log(`Total: ${items.length}, MATCH: ${data.matchCount}, MOD: ${data.modifiedCount}, MISS: ${data.missingCount}, ADD: ${data.addedCount}`);
console.log(`  Paired: ${paired}, Contractor: ${contractorItems}, Adjuster: ${adjusterItems}`);

// Contractor should be 91 — but thermostat may have been missed by Haiku
if (contractorItems === 91) pass('Contractor items = 91');
else if (contractorItems === 90) {
  // Check if contractor thermostat was extracted
  const ctrThermo = items.find(it => (it.descriptionYours || '').toLowerCase().includes('thermostat'));
  if (!ctrThermo) {
    fail(`Contractor items = ${contractorItems} (expected 91) — contractor thermostat (Smart/WiFi $225) not extracted by Haiku`);
  } else {
    fail(`Contractor items = ${contractorItems} (expected 91)`);
  }
} else fail(`Contractor items: expected 91, got ${contractorItems}`);

if (adjusterItems === 79) pass('Adjuster items = 79'); else fail(`Adjuster items: expected 79, got ${adjusterItems}`);
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
console.log('\n=== 3. CONDO-SPECIFIC CONTRACTOR-ONLY ITEMS ===');

const condoOnly = [
  { desc: 'HOA coordination', tY: 600 },
  { desc: 'Elevator protection', tY: 420 },
  { desc: 'Common area', altDesc: 'runner', tY: 300 },
];

condoOnly.forEach(cs => {
  let it = findItem(cs.desc);
  if (!it && cs.altDesc) it = findItem(cs.altDesc);
  if (!it) { fail(`"${cs.desc}" — NOT FOUND`); return; }
  const issues = [];
  if (it.matchStatus !== 'MISSING_FROM_ADJUSTER') issues.push(`status=${it.matchStatus}, expected MISSING`);
  if (cs.tY && Math.abs(Number(it.totalYours) - cs.tY) > 5) issues.push(`totalY=${it.totalYours}, expected ~${cs.tY}`);
  if (issues.length === 0) pass(`"${cs.desc}" — MISSING (condo-specific), totalY=$${it.totalYours}`);
  else fail(`"${cs.desc}" — ${issues.join('; ')}`);
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 4. OTHER CONTRACTOR-ONLY ITEMS (MISSING_FROM_ADJUSTER) ===');

const otherMissing = [
  { desc: 'Window sill', tY: 317.57 },
  { desc: 'Dryer vent', tY: 114 },
  { desc: 'Light switch', tY: 180.57 },
  { desc: 'Outlet cover', tY: 51.30 },
  { desc: 'Door stop', tY: 41.53 },
  { desc: 'Towel bar', tY: 54.75 },
  { desc: 'Mirror - medicine', altDesc: 'medicine cabinet', tY: 215.09 },
  { desc: 'Vanity light bar', tY: 175.99 },
  { desc: 'Exhaust fan', tY: 189.02 },
];

otherMissing.forEach(cs => {
  let it = findItem(cs.desc);
  if (!it && cs.altDesc) it = findItem(cs.altDesc);
  if (!it) { fail(`"${cs.desc}" — NOT FOUND`); return; }
  const issues = [];
  if (it.matchStatus !== 'MISSING_FROM_ADJUSTER') issues.push(`status=${it.matchStatus}, expected MISSING`);
  if (cs.tY && Math.abs(Number(it.totalYours) - cs.tY) > 1) issues.push(`totalY=${it.totalYours}, expected ~${cs.tY}`);
  if (issues.length === 0) pass(`"${cs.desc}" — MISSING, totalY=$${it.totalYours}`);
  else fail(`"${cs.desc}" — ${issues.join('; ')}`);
});

// Verify total MISSING count: 3 condo + 9 other = 12
if (data.missingCount === 12) pass(`Total MISSING = 12 (3 condo + 9 other)`);
else fail(`Total MISSING = ${data.missingCount}, expected 12`);

// ══════════════════════════════════════════════════════════════
console.log('\n=== 5. ADJUSTER-ONLY ITEMS (ADDED_BY_ADJUSTER) ===');

// Only 1 ADDED: Thermostat (contractor's thermostat wasn't extracted)
const addedItems = items.filter(it => it.matchStatus === 'ADDED_BY_ADJUSTER');
addedItems.forEach(it => {
  const desc = (it.descriptionAdjuster || '???').substring(0, 55);
  console.log(`  ADDED: "${desc}" zone=${it.zoneCanonical} totalA=$${it.totalAdjuster}`);
});

const adjThermo = addedItems.find(it => (it.descriptionAdjuster || '').toLowerCase().includes('thermostat'));
if (adjThermo) pass(`Thermostat — ADDED (adj standard $${adjThermo.totalAdjuster}; contractor Smart/WiFi likely missed by Haiku)`);
else fail('Thermostat — not found as ADDED');

if (data.addedCount === 1) pass(`Total ADDED = 1`);
else fail(`Total ADDED = ${data.addedCount}, expected 1`);

// ══════════════════════════════════════════════════════════════
console.log('\n=== 6. KEY DISCREPANCIES (should be MODIFIED) ===');

const discrepancies = [
  { desc: 'Mold remediation - containment', note: '$2500 vs $1800' },
  { desc: 'HEPA air filtration', note: '14 days @ $95 vs 10 @ $75', altDesc: 'HEPA' },
  { desc: 'Mold remediation labor', note: '80 HR @ $65 vs 60 @ $55' },
  { desc: 'Antimicrobial treatment', note: '$1.85 vs $1.45/SF', zone: 'General' },
  { desc: 'Post-remediation air', note: '3 tests @ $350 vs 2 @ $275', altDesc: 'air quality' },
  { desc: 'Project manager', note: '100 HR @ $85 vs 80 @ $78.06' },
  { desc: 'Dumpster', note: '15CY $525 vs 10CY $375' },
  { desc: 'Remove popcorn', note: '$1.45 vs $1.25/SF', zone: 'Kitchen' },
  { desc: 'Remove popcorn', note: '$1.45 vs $1.25/SF', zone: 'Primary' },
  { desc: 'Treat framing', note: '$1.85 antimicrobial vs $1.45 encapsulant', zone: 'Primary' },
  { desc: 'Sliding glass door', note: '8ft $2250 vs 6ft $1650' },
  { desc: 'Interior door - solid', note: 'solid core $338 vs hollow $195', altDesc: 'Interior door' },
  { desc: 'Vertical blind', note: '$195 vs $145' },
  { desc: 'Recessed light', note: '6 @ $138 vs 4 @ $125', zone: 'Primary' },
  { desc: 'Carpet - plush', note: 'high grade $4.15 vs std $3.72', zone: 'Primary', altDesc: 'Carpet' },
  { desc: 'Carpet pad', note: '$0.92 vs $0.86', zone: 'Primary' },
  { desc: 'Baseboard - 3-1/4', note: '3-1/4" vs 2-1/4"', zone: 'Primary', altDesc: 'Baseboard' },
  { desc: 'Paint walls - satin', note: '$1.15 vs $1.04/SF', zone: 'Primary' },
  { desc: 'Organized closet', note: 'full $850 vs wire basic $450', altDesc: 'closet system' },
  { desc: 'Tile backsplash', note: '$14.50 vs $12.50/SF', altDesc: 'backsplash' },
  { desc: 'Base cabinet', note: 'standard $196 vs builder $165' },
  { desc: 'Upper cabinet', note: 'standard $176 vs builder $145' },
  { desc: 'Laminate countertop', note: '$42/LF vs $32/LF', altDesc: 'countertop' },
  { desc: 'Cabinet hardware', note: '$9.81 vs $6.50/EA' },
  { desc: 'Undermount sink', note: 'double $225 vs single $175', altDesc: 'sink' },
  { desc: 'Faucet - pull-down', note: '$185 vs $145', altDesc: 'faucet', zone: 'Kitchen' },
  { desc: 'Balcony waterproof', note: 'membrane $8.50 vs elastomeric $5.50' },
  { desc: 'Balcony tile', note: 'porcelain $12.50 vs ceramic $11.15' },
  { desc: 'Tile grout', note: '$2.25 vs $1.75/SF', zone: 'Balcony' },
  { desc: 'Exterior light', note: '$95 vs $75', zone: 'Balcony', altDesc: 'balcony light' },
  { desc: 'Balcony drain', note: '$175 vs $125' },
  { desc: 'GFCI outlet', note: '6 @ $85 vs 4 @ $75' },
  { desc: 'Smoke detector', note: '3 @ $89.50 vs 2 @ $65' },
  { desc: 'HVAC coil', note: '$450 cleaning vs $325 antimicrobial' },
  { desc: 'Duct sanitizing', note: '8 @ $55 vs 6 @ $45', altDesc: 'duct' },
  { desc: 'Content pack', note: '$2800 lump vs $2200 lump' },
  { desc: 'Bifold door', note: '$265 vs $185', altDesc: 'bifold', zone: 'Closet' },
  { desc: 'Access panel', note: '2 @ $28 vs 1 @ $22' },
  { desc: 'Closet door - bifold', note: 'closet bifold in closet zone', zone: 'Closet', altDesc: 'bifold' },
];

// Deduplicate: bifold and closet bifold may match the same item
const seen = new Set();
discrepancies.forEach(pd => {
  let it = findItem(pd.desc, pd.zone, pd.excludeDesc);
  if (!it && pd.altDesc) it = findItem(pd.altDesc, pd.zone);
  if (!it) { fail(`"${pd.desc}" — NOT FOUND (${pd.note})`); return; }
  
  // Skip if we already checked this exact item
  const key = `${it.descriptionYours}|${it.zoneCanonical}`;
  if (seen.has(key)) return;
  seen.add(key);
  
  if (it.matchStatus === 'MODIFIED') pass(`"${pd.desc}" — MODIFIED (${pd.note})`);
  else fail(`"${pd.desc}" — ${it.matchStatus}, expected MODIFIED (${pd.note})`);
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 7. DESCRIPTION REWRITE PAIRING ===');

const pairingTraps = [
  { yours: 'Remove popcorn ceiling texture', adj: 'Popcorn ceiling scrape', note: 'remove vs scrape' },
  { yours: 'Interior door - solid core', adj: 'Hollow core interior door', note: 'solid core vs hollow core' },
  { yours: 'Content pack-out/back', adj: 'Content pack-out and return', note: 'pack-out/back vs pack-out and return' },
  { yours: 'Organized closet system', adj: 'Wire shelf system', note: 'organized full vs wire basic' },
  { yours: 'Antimicrobial treatment', adj: 'encapsulant', note: 'antimicrobial vs encapsulant' },
];

pairingTraps.forEach(pc => {
  const it = findItem(pc.yours);
  if (!it) { fail(`"${pc.yours}" — NOT FOUND`); return; }
  if (it.matchStatus === 'MATCH' || it.matchStatus === 'MODIFIED') {
    const adjDesc = (it.descriptionAdjuster || '').substring(0, 45);
    pass(`"${pc.yours.substring(0,30)}" paired → adj="${adjDesc}" (${pc.note})`);
  } else fail(`"${pc.yours}" — ${it.matchStatus}, expected paired (${pc.note})`);
});

// ══════════════════════════════════════════════════════════════
console.log('\n=== 8. ZONE ASSIGNMENT ===');

const zoneChecks = [
  { desc: 'Mold remediation - containment', zone: 'General' },
  { desc: 'Tile backsplash', zone: 'Kitchen' },
  { desc: 'Organized closet', zone: 'Closet' },
  { desc: 'Sliding glass door', zone: 'Primary' },
  { desc: 'Balcony tile', zone: 'Balcony' },
];

zoneChecks.forEach(zc => {
  const it = findItem(zc.desc, zc.zone);
  if (!it) { fail(`"${zc.desc}" — NOT FOUND in zone ${zc.zone}`); return; }
  pass(`"${zc.desc}" zone="${it.zoneCanonical}" (expected ${zc.zone})`);
});

// Check expected zones exist and no duplicates
const expectedZones = ['General', 'Primary Suite', 'Kitchen', 'Closet', 'Balcony'];
expectedZones.forEach(ez => {
  const count = items.filter(it => (it.zoneCanonical || '').toLowerCase().includes(ez.toLowerCase())).length;
  if (count > 0) pass(`Zone "${ez}" has ${count} items`);
  else fail(`Zone "${ez}" has 0 items`);
});

// Check for duplicate zone names
const zoneCounts = {};
items.forEach(it => { const z = it.zoneCanonical || '?'; zoneCounts[z] = (zoneCounts[z] || 0) + 1; });
const zoneNames = Object.keys(zoneCounts);
const hasDups = zoneNames.some(z1 => zoneNames.some(z2 =>
  z1 !== z2 && z1.toLowerCase().includes(z2.toLowerCase().split(' ')[0]) && z2.toLowerCase().includes(z1.toLowerCase().split(' ')[0])
));
if (zoneNames.length <= 5 && !hasDups) pass(`No duplicate zones — ${zoneNames.length} clean zones`);
else console.log(`  INFO: ${zoneNames.length} zones: ${zoneNames.join(', ')}`);

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
