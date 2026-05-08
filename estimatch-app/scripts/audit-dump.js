const fs = require('fs');
const d = JSON.parse(fs.readFileSync('scripts/audit-output.json', 'utf8'));

// Status x null description cross-check
console.log('=== STATUS x DESCRIPTION NULLS ===');
const check = {};
d.lineItems.forEach(i => {
  const s = i.matchStatus;
  const key = s + ((!i.descriptionYours) ? '_nullDescY' : '') + ((!i.descriptionAdjuster) ? '_nullDescA' : '');
  check[key] = (check[key] || 0) + 1;
});
Object.entries(check).sort().forEach(([k, v]) => console.log(' ', k, ':', v));

// Sample items
console.log('\n=== SAMPLE ITEMS (first 10) ===');
d.lineItems.slice(0, 10).forEach((i, idx) => {
  console.log(`\n--- Item ${idx} ---`);
  console.log('status:', i.matchStatus);
  console.log('zone:', i.zoneCanonical, '(Y:', i.zoneYours, ', A:', i.zoneAdjuster, ') conf:', i.zoneConfidence);
  console.log('descY:', (i.descriptionYours || '(null)').slice(0, 80));
  console.log('descA:', (i.descriptionAdjuster || '(null)').slice(0, 80));
  console.log('qtyY:', i.qtyYours, 'qtyA:', i.qtyAdjuster);
  console.log('totalY:', i.totalYours, 'totalA:', i.totalAdjuster, 'diff:', i.diffAmount);
});

// Duplicate zone check - are there zones that SHOULD be merged?
console.log('\n=== ZONE PAIRS (zone reconciliation audit) ===');
const zonePairs = {};
d.lineItems.forEach(i => {
  const key = `Y:${i.zoneYours || '(null)'} | A:${i.zoneAdjuster || '(null)'} => ${i.zoneCanonical || '(null)'}`;
  zonePairs[key] = (zonePairs[key] || 0) + 1;
});
Object.entries(zonePairs).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(' ', v, 'x', k));

// Items with MISSING status
console.log('\n=== MISSING_FROM_ADJUSTER items (sample 5) ===');
d.lineItems.filter(i => i.matchStatus === 'MISSING_FROM_ADJUSTER').slice(0, 5).forEach((i, idx) => {
  console.log(`  ${idx}: zone=${i.zoneCanonical} desc="${(i.descriptionYours || '').slice(0, 60)}" total=${i.totalYours}`);
});

// Items with ADDED status
console.log('\n=== ADDED_BY_ADJUSTER items (sample 5) ===');
d.lineItems.filter(i => i.matchStatus === 'ADDED_BY_ADJUSTER').slice(0, 5).forEach((i, idx) => {
  console.log(`  ${idx}: zone=${i.zoneCanonical} desc="${(i.descriptionAdjuster || '').slice(0, 60)}" total=${i.totalAdjuster}`);
});
