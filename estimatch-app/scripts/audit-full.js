const fs = require('fs');
const d = JSON.parse(fs.readFileSync('scripts/audit-output.json', 'utf8'));

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║            FULL AUDIT — Set 11 (Set 10 PDFs)               ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

// ── 1. SUMMARY ──
console.log('=== 1. COMPARISON SUMMARY ===');
console.log('ID:', d.id);
console.log('Status:', d.status);
console.log('Yours:', d.yourEstimateFilename, '| Adjuster:', d.adjusterEstimateFilename);
console.log('Your Total: $' + d.yourEstimateTotal, '| Adjuster Total: $' + d.adjusterEstimateTotal, '| Gap: $' + d.totalGap);
console.log('Total items:', d.lineItems.length);
console.log('');

// ── 2. STATUS COUNTS ──
console.log('=== 2. STATUS COUNTS ===');
const byStatus = {};
d.lineItems.forEach(i => { byStatus[i.matchStatus] = (byStatus[i.matchStatus] || 0) + 1; });
Object.entries(byStatus).sort().forEach(([s, c]) => console.log(`  ${s}: ${c}`));
console.log(`  Header counts → M:${d.matchCount} MOD:${d.modifiedCount} MISS:${d.missingCount} ADD:${d.addedCount}`);
console.log('');

// ── 3. COLUMN HEALTH ──
console.log('=== 3. COLUMN HEALTH (null/empty check) ===');
const n = d.lineItems.length;
const cols = {
  descriptionYours: 0, descriptionAdjuster: 0, zoneCanonical: 0, zoneConfidence: 0,
  zoneYours: 0, zoneAdjuster: 0, totalYours: 0, totalAdjuster: 0,
  qtyYours: 0, qtyAdjuster: 0, removeYours: 0, removeAdjuster: 0,
  replaceYours: 0, replaceAdjuster: 0, diffAmount: 0,
};
d.lineItems.forEach(i => {
  if (!i.descriptionYours) cols.descriptionYours++;
  if (!i.descriptionAdjuster) cols.descriptionAdjuster++;
  if (!i.zoneCanonical) cols.zoneCanonical++;
  if (i.zoneConfidence === null) cols.zoneConfidence++;
  if (!i.zoneYours) cols.zoneYours++;
  if (!i.zoneAdjuster) cols.zoneAdjuster++;
  if (i.totalYours === null || i.totalYours === '') cols.totalYours++;
  if (i.totalAdjuster === null || i.totalAdjuster === '') cols.totalAdjuster++;
  if (!i.qtyYours) cols.qtyYours++;
  if (!i.qtyAdjuster) cols.qtyAdjuster++;
  if (i.removeYours === null || i.removeYours === '') cols.removeYours++;
  if (i.removeAdjuster === null || i.removeAdjuster === '') cols.removeAdjuster++;
  if (i.replaceYours === null || i.replaceYours === '') cols.replaceYours++;
  if (i.replaceAdjuster === null || i.replaceAdjuster === '') cols.replaceAdjuster++;
  if (i.diffAmount === null) cols.diffAmount++;
});
Object.entries(cols).forEach(([col, cnt]) => {
  const pct = ((cnt / n) * 100).toFixed(1);
  const flag = cnt > 0 ? (cnt === byStatus.ADDED_BY_ADJUSTER || cnt === byStatus.MISSING_FROM_ADJUSTER ? '  ✓ expected' : '  ⚠') : '  ✓';
  console.log(`  ${col}: ${cnt}/${n} (${pct}%)${flag}`);
});

// Cross-check: null descriptions must correspond to MISSING/ADDED
const badDescY = d.lineItems.filter(i => !i.descriptionYours && i.matchStatus !== 'ADDED_BY_ADJUSTER');
const badDescA = d.lineItems.filter(i => !i.descriptionAdjuster && i.matchStatus !== 'MISSING_FROM_ADJUSTER');
console.log(`\n  Cross-check: null descriptionYours on non-ADDED items: ${badDescY.length}`);
console.log(`  Cross-check: null descriptionAdjuster on non-MISSING items: ${badDescA.length}`);
console.log('');

// ── 4. ZONE BREAKDOWN ──
console.log('=== 4. ZONE BREAKDOWN ===');
const byZone = {};
d.lineItems.forEach(i => {
  const z = i.zoneCanonical || '(null)';
  if (!byZone[z]) byZone[z] = { total: 0, M: 0, MOD: 0, MISS: 0, ADD: 0, yNames: new Set(), aNames: new Set(), confs: new Set() };
  byZone[z].total++;
  if (i.matchStatus === 'MATCH') byZone[z].M++;
  if (i.matchStatus === 'MODIFIED') byZone[z].MOD++;
  if (i.matchStatus === 'MISSING_FROM_ADJUSTER') byZone[z].MISS++;
  if (i.matchStatus === 'ADDED_BY_ADJUSTER') byZone[z].ADD++;
  if (i.zoneYours) byZone[z].yNames.add(i.zoneYours);
  if (i.zoneAdjuster) byZone[z].aNames.add(i.zoneAdjuster);
  if (i.zoneConfidence !== null) byZone[z].confs.add(i.zoneConfidence);
});
const zoneCount = Object.keys(byZone).length;
console.log(`  Total unique zones: ${zoneCount}`);
Object.entries(byZone).sort((a, b) => b[1].total - a[1].total).forEach(([z, s]) => {
  const confStr = s.confs.size > 0 ? `conf:[${[...s.confs].join(',')}]` : 'conf:null';
  console.log(`  ${z} (${s.total}) — M:${s.M} MOD:${s.MOD} MISS:${s.MISS} ADD:${s.ADD} | ${confStr}`);
  if (s.yNames.size > 1 || s.aNames.size > 1 || ([...s.yNames][0] !== z && s.yNames.size > 0)) {
    console.log(`    Y variants: [${[...s.yNames].join(', ')}] | A variants: [${[...s.aNames].join(', ')}]`);
  }
});
console.log('');

// ── 5. CHEAT SHEET ACCURACY ──
console.log('=== 5. CHEAT SHEET ACCURACY ===\n');

// Expected zone pairings from cheat sheet
const expectedZonePairs = [
  { y: 'General / Administrative', a: 'General', canonical: 'General' },
  { y: 'Roof System', a: 'Roofing', canonical: 'Roofing' },
  { y: 'Exterior Envelope', a: 'Exterior Envelope', canonical: 'Exterior' },
  { y: '1st Floor - Retail Space A', a: '1st Floor - Retail Space A', canonical: 'Retail Space A' },
  { y: '1st Floor - Common Lobby', a: '1st Floor - Common Lobby', canonical: 'Common Lobby' },
  { y: '1st Floor - Restroom 1 (Men\'s)', a: '1st Floor - Men\'s Restroom 1', canonical: 'Restroom 1' },
  { y: '2nd Floor - Office Suite 201', a: '2nd Floor - Office Suite 201', canonical: 'Office Suite 201' },
  { y: '2nd Floor - Office Suite 202', a: '2nd Floor - Office Suite 202', canonical: 'Office Suite 202' },
  { y: '2nd Floor - Conference Room', a: '2nd Floor - Conference Room', canonical: 'Conference Room' },
  { y: '2nd Floor - Restroom 2 (Women\'s)', a: '2nd Floor - Women\'s Restroom 2', canonical: 'Restroom 2' },
  { y: 'Elevator / Stairwell', a: 'Elevator / Stairwell', canonical: 'Elevator / Stairwell' },
];
const expectedYoursOnly = ['1st Floor - Retail Space B', '2nd Floor - Common Hallway'];
const expectedAdjusterOnly = ['1st Floor - Storage/Janitor', 'Site Work / Parking', 'ADA Compliance'];

// Check: do duplicates from previous run still exist?
const suspectDupes = [
  ['Common Lobby', '1st Floor - Common Lobby'],
  ['Conference Room', '2nd Floor - Conference Room'],
  ['Retail Space A', '1st Floor - Retail Space A'],
  ['Office / Suite A', '2nd Floor - Office Suite 201'],
  ['Office / Suite B', '2nd Floor - Office Suite 202'],
  ['Restroom 1 (Men\'s)', '1st Floor - Men\'s Restroom 1'],
  ['Restroom 2 (Women\'s)', '2nd Floor - Women\'s Restroom 2'],
  ['General / Administrative', 'General'],
  ['Roof System', 'Roofing'],
  ['Exterior', 'Exterior Envelope'],
];

console.log('  Zone dedup check (should both map to same canonical):');
let dedupPass = 0, dedupFail = 0;
suspectDupes.forEach(([a, b]) => {
  const aItems = d.lineItems.filter(i => i.zoneCanonical === a);
  const bItems = d.lineItems.filter(i => i.zoneCanonical === b);
  if (aItems.length > 0 && bItems.length > 0) {
    console.log(`    ✗ SPLIT: "${a}" (${aItems.length}) and "${b}" (${bItems.length}) still separate`);
    dedupFail++;
  } else {
    const merged = aItems.length > 0 ? a : b;
    const mergedCount = (aItems.length || 0) + (bItems.length || 0);
    if (mergedCount > 0) {
      console.log(`    ✓ MERGED into "${merged}" (${mergedCount})`);
      dedupPass++;
    }
  }
});
console.log(`  Dedup score: ${dedupPass}/${dedupPass + dedupFail}\n`);

// Specific item checks from cheat sheet
console.log('  Spot checks from cheat sheet:');
let spotPass = 0, spotTotal = 0;

function findItem(descPattern, status, side) {
  return d.lineItems.find(i => {
    const desc = side === 'yours' ? i.descriptionYours : i.descriptionAdjuster;
    if (!desc) return false;
    return desc.toLowerCase().includes(descPattern.toLowerCase()) && i.matchStatus === status;
  });
}

function spotCheck(label, descPattern, expectedStatus, side) {
  spotTotal++;
  const found = findItem(descPattern, expectedStatus, side);
  if (found) {
    console.log(`    ✓ ${label}: ${expectedStatus}`);
    spotPass++;
  } else {
    // Check if it exists with wrong status
    const any = d.lineItems.find(i => {
      const desc = side === 'yours' ? i.descriptionYours : i.descriptionAdjuster;
      return desc && desc.toLowerCase().includes(descPattern.toLowerCase());
    });
    if (any) {
      console.log(`    ✗ ${label}: expected ${expectedStatus}, got ${any.matchStatus}`);
    } else {
      console.log(`    ✗ ${label}: NOT FOUND`);
    }
  }
}

// General section
spotCheck('Dumpster (yours)', 'dumpster', 'MODIFIED', 'yours');
spotCheck('PM/Superintendent (yours)', 'superintendent', 'MODIFIED', 'yours');
spotCheck('Demo labor (yours)', 'demolition', 'MODIFIED', 'yours');
spotCheck('Fire watch (yours)', 'fire watch', 'MISSING_FROM_ADJUSTER', 'yours');
spotCheck('Board-up (yours)', 'board', 'MISSING_FROM_ADJUSTER', 'yours');
spotCheck('Moisture testing (adjuster)', 'moisture', 'ADDED_BY_ADJUSTER', 'adjuster');
spotCheck('Air quality (adjuster)', 'air quality', 'ADDED_BY_ADJUSTER', 'adjuster');
spotCheck('Asbestos test (adjuster)', 'asbestos', 'ADDED_BY_ADJUSTER', 'adjuster');
spotCheck('Lead paint (adjuster)', 'lead paint', 'ADDED_BY_ADJUSTER', 'adjuster');

// Roofing
spotCheck('Shingles (yours)', 'shingle', 'MODIFIED', 'yours');
spotCheck('Ridge cap (yours)', 'ridge cap', 'MODIFIED', 'yours');
spotCheck('Gutters (yours)', 'gutter', 'MODIFIED', 'yours');
spotCheck('Crane (yours)', 'crane', 'MISSING_FROM_ADJUSTER', 'yours');

// Exterior
spotCheck('Stucco (yours)', 'stucco', 'MODIFIED', 'yours');
spotCheck('Entry doors (yours)', 'entry door', 'MODIFIED', 'yours');
spotCheck('Soffit repair (adjuster)', 'soffit', 'ADDED_BY_ADJUSTER', 'adjuster');

// Room-level
spotCheck('Recessed lights (yours)', 'recessed', 'MODIFIED', 'yours');
spotCheck('Carpet (yours)', 'carpet', 'MODIFIED', 'yours');
spotCheck('Baseboard (yours)', 'baseboard', 'MODIFIED', 'yours');
spotCheck('Interior door (yours)', 'interior door', 'MODIFIED', 'yours');

console.log(`\n  Spot check score: ${spotPass}/${spotTotal}`);

// ── 6. OVERALL ACCURACY SCORE ──
console.log('\n=== 6. OVERALL ACCURACY SCORE ===\n');

// Scoring: zone dedup (20%), status spot checks (50%), column health (30%)
const dedupScore = dedupFail === 0 ? 100 : (dedupPass / (dedupPass + dedupFail)) * 100;
const spotScore = (spotPass / spotTotal) * 100;

// Column health: penalize unexpected nulls
const colHealthIssues = badDescY.length + badDescA.length;
const colScore = colHealthIssues === 0 ? 100 : Math.max(0, 100 - (colHealthIssues / n) * 100);

const zoneWeight = 0.20;
const spotWeight = 0.50;
const colWeight = 0.30;

const overallScore = (dedupScore * zoneWeight) + (spotScore * spotWeight) + (colScore * colWeight);

console.log(`  Zone dedup accuracy:    ${dedupScore.toFixed(1)}% (weight: ${zoneWeight * 100}%)`);
console.log(`  Spot check accuracy:    ${spotScore.toFixed(1)}% (weight: ${spotWeight * 100}%)`);
console.log(`  Column health:          ${colScore.toFixed(1)}% (weight: ${colWeight * 100}%)`);
console.log(`  ─────────────────────────────────────`);
console.log(`  ★ OVERALL ACCURACY:     ${overallScore.toFixed(1)}%`);
console.log('');
