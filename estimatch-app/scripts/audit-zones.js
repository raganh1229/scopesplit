const fs = require('fs');
const d = JSON.parse(fs.readFileSync('scripts/audit-output.json', 'utf8'));

// Group items by their zone pair (zoneYours + zoneAdjuster)
console.log('=== PER-ZONE BREAKDOWN (with status counts) ===\n');
const byZone = {};
d.lineItems.forEach(i => {
  const z = i.zoneCanonical || '(null)';
  if (!byZone[z]) byZone[z] = { total: 0, MATCH: 0, MODIFIED: 0, MISSING_FROM_ADJUSTER: 0, ADDED_BY_ADJUSTER: 0, zoneY: new Set(), zoneA: new Set() };
  byZone[z].total++;
  byZone[z][i.matchStatus]++;
  if (i.zoneYours) byZone[z].zoneY.add(i.zoneYours);
  if (i.zoneAdjuster) byZone[z].zoneA.add(i.zoneAdjuster);
});

Object.entries(byZone).sort((a, b) => b[1].total - a[1].total).forEach(([z, s]) => {
  console.log(`${z} (${s.total} items)`);
  console.log(`  M:${s.MATCH} MOD:${s.MODIFIED} MISS:${s.MISSING_FROM_ADJUSTER} ADD:${s.ADDED_BY_ADJUSTER}`);
  console.log(`  zoneYours variants: [${[...s.zoneY].join(', ')}]`);
  console.log(`  zoneAdjuster variants: [${[...s.zoneA].join(', ')}]`);
  console.log('');
});

// Expected zones from cheat sheet
console.log('\n=== CHEAT SHEET ZONE MAPPING ===');
console.log('Expected contractor zones (13):');
console.log('  General / Administrative, Roof System, Exterior Envelope');
console.log('  1st Floor - Retail Space A, 1st Floor - Retail Space B, 1st Floor - Common Lobby');
console.log('  1st Floor - Restroom 1 (Mens), 2nd Floor - Office Suite 201, 2nd Floor - Office Suite 202');
console.log('  2nd Floor - Conference Room, 2nd Floor - Common Hallway, 2nd Floor - Restroom 2 (Womens)');
console.log('  Elevator / Stairwell');
console.log('');
console.log('Expected adjuster zones (15):');
console.log('  General, Roofing, Exterior Envelope');
console.log('  1st Floor - Common Lobby, 1st Floor - Retail Space A, 1st Floor - Storage/Janitor');
console.log('  1st Floor - Womens Restroom 1, 1st Floor - Mens Restroom 1');
console.log('  2nd Floor - Conference Room, 2nd Floor - Office Suite 201, 2nd Floor - Office Suite 202');
console.log('  2nd Floor - Womens Restroom 2, Elevator / Stairwell');
console.log('  Site Work / Parking, ADA Compliance');

// Identify suspicious zone splits
console.log('\n=== SUSPECTED DUPLICATE ZONES (should be merged) ===');
const suspects = [
  ['General / Administrative', 'General'],
  ['Roof System', 'Roofing'],
  ['Common Lobby', '1st Floor - Common Lobby'],
  ['Conference Room', '2nd Floor - Conference Room'],
  ['Retail Space A', '1st Floor - Retail Space A'],
  ['Retail Space B', '1st Floor - Retail Space B'],
  ['Office / Suite A', '2nd Floor - Office Suite 201'],
  ['Office / Suite B', '2nd Floor - Office Suite 202'],
  ['Restroom 1 (Men\'s)', '1st Floor - Men\'s Restroom 1'],
  ['Restroom 2 (Women\'s)', '2nd Floor - Women\'s Restroom 2'],
  ['Exterior', 'Exterior Envelope'],
  ['Parking / Site', 'Site Work / Parking'],
];

suspects.forEach(([a, b]) => {
  const countA = byZone[a]?.total || 0;
  const countB = byZone[b]?.total || 0;
  if (countA > 0 || countB > 0) {
    console.log(`  "${a}" (${countA}) + "${b}" (${countB}) = ${countA + countB} items`);
  }
});

// Show all items for a few suspect zones to see if they're really the same
console.log('\n=== SAMPLE: "Common Lobby" items (first 3) ===');
d.lineItems.filter(i => i.zoneCanonical === 'Common Lobby').slice(0, 3).forEach(i => {
  console.log(`  [${i.matchStatus}] Y:"${(i.descriptionYours||'').slice(0,50)}" A:"${(i.descriptionAdjuster||'').slice(0,50)}"`);
});

console.log('\n=== SAMPLE: "1st Floor - Common Lobby" items (all) ===');
d.lineItems.filter(i => i.zoneCanonical === '1st Floor - Common Lobby').forEach(i => {
  console.log(`  [${i.matchStatus}] Y:"${(i.descriptionYours||'').slice(0,50)}" A:"${(i.descriptionAdjuster||'').slice(0,50)}"`);
});

console.log('\n=== SAMPLE: "Office / Suite A" items (first 3) ===');
d.lineItems.filter(i => i.zoneCanonical === 'Office / Suite A').slice(0, 3).forEach(i => {
  console.log(`  [${i.matchStatus}] Y:"${(i.descriptionYours||'').slice(0,50)}" A:"${(i.descriptionAdjuster||'').slice(0,50)}"`);
});

console.log('\n=== SAMPLE: "2nd Floor - Office Suite 201" items (first 3) ===');
d.lineItems.filter(i => i.zoneCanonical === '2nd Floor - Office Suite 201').slice(0, 3).forEach(i => {
  console.log(`  [${i.matchStatus}] Y:"${(i.descriptionYours||'').slice(0,50)}" A:"${(i.descriptionAdjuster||'').slice(0,50)}"`);
});
