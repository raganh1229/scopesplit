const fs = require('fs');
const d = JSON.parse(fs.readFileSync('scripts/audit-output.json', 'utf8'));

console.log('=== ITEM INTEGRITY CHECK ===\n');

// 1. Check item counts match cheat sheet (202 yours, 234 adjuster)
const matchItems = d.lineItems.filter(i => i.matchStatus === 'MATCH');
const modItems = d.lineItems.filter(i => i.matchStatus === 'MODIFIED');
const missItems = d.lineItems.filter(i => i.matchStatus === 'MISSING_FROM_ADJUSTER');
const addItems = d.lineItems.filter(i => i.matchStatus === 'ADDED_BY_ADJUSTER');

// Yours items = MATCH + MODIFIED + MISSING (items that appear on your side)
const yoursCount = matchItems.length + modItems.length + missItems.length;
// Adjuster items = MATCH + MODIFIED + ADDED (items that appear on adjuster side)
const adjCount = matchItems.length + modItems.length + addItems.length;

console.log('Expected: Yours=202, Adjuster=234');
console.log(`Got:      Yours=${yoursCount} (82M+${modItems.length}MOD+${missItems.length}MISS), Adjuster=${adjCount} (82M+${modItems.length}MOD+${addItems.length}ADD)`);
console.log(yoursCount === 202 ? '  ✓ Yours count matches' : `  ✗ Yours count off by ${yoursCount - 202}`);
console.log(adjCount === 234 ? '  ✓ Adjuster count matches' : `  ✗ Adjuster count off by ${adjCount - 234}`);

// 2. Check for duplicate descriptions (potential hallucinations)
console.log('\n=== DUPLICATE DESCRIPTION CHECK ===');
const descYCounts = {};
const descACounts = {};
d.lineItems.forEach(i => {
  if (i.descriptionYours) {
    const key = i.descriptionYours.toLowerCase().trim();
    descYCounts[key] = (descYCounts[key] || 0) + 1;
  }
  if (i.descriptionAdjuster) {
    const key = i.descriptionAdjuster.toLowerCase().trim();
    descACounts[key] = (descACounts[key] || 0) + 1;
  }
});

const dupeY = Object.entries(descYCounts).filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]);
const dupeA = Object.entries(descACounts).filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]);

console.log(`Yours duplicate descriptions: ${dupeY.length}`);
dupeY.slice(0, 10).forEach(([desc, c]) => console.log(`  ${c}x "${desc.slice(0, 70)}"`));
console.log(`\nAdjuster duplicate descriptions: ${dupeA.length}`);
dupeA.slice(0, 10).forEach(([desc, c]) => console.log(`  ${c}x "${desc.slice(0, 70)}"`));

// 3. Spot check specific items from cheat sheet with EXACT values
console.log('\n=== CHEAT SHEET VALUE VERIFICATION ===');

function findByDesc(pattern, side) {
  return d.lineItems.filter(i => {
    const desc = side === 'yours' ? i.descriptionYours : i.descriptionAdjuster;
    return desc && desc.toLowerCase().includes(pattern.toLowerCase());
  });
}

function checkValue(label, pattern, side, field, expected) {
  const items = findByDesc(pattern, side);
  if (items.length === 0) {
    console.log(`  ✗ ${label}: NOT FOUND`);
    return;
  }
  const item = items[0];
  const actual = item[field];
  const match = String(actual) === String(expected);
  if (match) {
    console.log(`  ✓ ${label}: ${field}=${actual}`);
  } else {
    console.log(`  ✗ ${label}: ${field}=${actual} (expected ${expected})`);
  }
}

// Cheat sheet: Dumpsters — yours: 4x 30CY, $5,028 total? Let's check qty
console.log('\n  -- General section --');
checkValue('Dumpster (yours qty)', 'dumpster', 'yours', 'qtyYours', '4.00 EA');
checkValue('PM hours (yours)', 'superintendent', 'yours', 'qtyYours', '280.00 HR');
checkValue('Demo labor (yours)', 'demolition', 'yours', 'qtyYours', '140.00 HR');
checkValue('Cleanup (yours)', 'cleanup', 'yours', 'qtyYours', '100.00 HR');
checkValue('PM hours (adjuster)', 'supervision', 'adjuster', 'qtyAdjuster', '220.00 HR');
checkValue('Demo labor (adjuster)', 'demolition', 'adjuster', 'qtyAdjuster', '100.00 HR');

console.log('\n  -- Roofing section --');
checkValue('Ridge cap (yours qty)', 'ridge cap', 'yours', 'qtyYours', '95.00');
checkValue('Gutters (yours qty)', 'gutter', 'yours', 'qtyYours', '220.00');
checkValue('Downspouts (yours qty)', 'downspout', 'yours', 'qtyYours', '90.00');

console.log('\n  -- Exterior section --');
checkValue('Stucco removal (yours qty)', 'stucco removal', 'yours', 'qtyYours', '900.00 SF');
checkValue('Entry doors (yours total)', 'entry door', 'yours', 'totalYours', '2850');

// 4. Check for suspicious items that shouldn't exist
console.log('\n=== SUSPICIOUS ITEM CHECK ===');
console.log('Looking for items that seem fabricated...\n');

// Items in zones that don't exist in cheat sheet
const suspiciousZones = ['Women\'s Restroom 1', 'Office Suite 1', 'Office Suite 2', 'Storage/Janitor', 'Parking/Site'];
suspiciousZones.forEach(z => {
  const items = d.lineItems.filter(i => i.zoneCanonical === z);
  if (items.length > 0) {
    console.log(`  Zone "${z}" (${items.length} items):`);
    items.slice(0, 3).forEach(i => {
      const desc = i.descriptionYours || i.descriptionAdjuster || '(null)';
      console.log(`    [${i.matchStatus}] "${desc.slice(0, 60)}" total=${i.totalYours || i.totalAdjuster}`);
    });
    if (items.length > 3) console.log(`    ... and ${items.length - 3} more`);
  }
});

// 5. Items where BOTH descriptions are present but look completely unrelated
console.log('\n=== POTENTIAL MIS-PAIRS (descriptions look unrelated) ===');
const paired = d.lineItems.filter(i => i.descriptionYours && i.descriptionAdjuster);
let mispairCount = 0;
paired.forEach(i => {
  const y = i.descriptionYours.toLowerCase();
  const a = i.descriptionAdjuster.toLowerCase();
  // Check if they share at least one meaningful word (>3 chars)
  const yWords = y.split(/\s+/).filter(w => w.length > 3);
  const aWords = new Set(a.split(/\s+/).filter(w => w.length > 3));
  const shared = yWords.filter(w => aWords.has(w));
  if (shared.length === 0 && i.matchStatus !== 'MATCH') {
    mispairCount++;
    if (mispairCount <= 5) {
      console.log(`  [${i.matchStatus}] zone=${i.zoneCanonical}`);
      console.log(`    Y: "${i.descriptionYours.slice(0, 70)}"`);
      console.log(`    A: "${i.descriptionAdjuster.slice(0, 70)}"`);
    }
  }
});
console.log(`\n  Total potential mis-pairs (no shared words >3 chars): ${mispairCount}/${paired.length}`);
