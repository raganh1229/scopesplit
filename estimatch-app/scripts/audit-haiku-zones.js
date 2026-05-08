// Inspect the raw zone assignments per item from the latest comparison
// to understand Haiku's zone naming patterns
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('scripts/audit-output.json', 'utf8'));

// Group items by their raw zone names
const yoursByZone = {};
const adjByZone = {};

for (const item of data.lineItems) {
  const yz = item.zoneYours || '[null]';
  const az = item.zoneAdjuster || '[null]';
  if (!yoursByZone[yz]) yoursByZone[yz] = [];
  if (!adjByZone[az]) adjByZone[az] = [];
  yoursByZone[yz].push({ desc: item.descriptionYours || '[added]', status: item.status });
  adjByZone[az].push({ desc: item.descriptionAdjuster || '[missing]', status: item.status });
}

console.log('=== YOUR SIDE: Zone → Items (first 3 per zone) ===\n');
for (const [zone, items] of Object.entries(yoursByZone).sort((a,b) => b[1].length - a[1].length)) {
  console.log(`  "${zone}" (${items.length} items):`);
  items.slice(0, 3).forEach(i => console.log(`    - ${i.desc.substring(0, 80)}`));
  if (items.length > 3) console.log(`    ... +${items.length - 3} more`);
  console.log();
}

console.log('\n=== ADJUSTER SIDE: Zone → Items (first 3 per zone) ===\n');
for (const [zone, items] of Object.entries(adjByZone).sort((a,b) => b[1].length - a[1].length)) {
  console.log(`  "${zone}" (${items.length} items):`);
  items.slice(0, 3).forEach(i => console.log(`    - ${i.desc.substring(0, 80)}`));
  if (items.length > 3) console.log(`    ... +${items.length - 3} more`);
  console.log();
}

// Key question: do pairs with MATCH status have same or different zones?
console.log('\n=== MATCHED PAIRS: Zone consistency ===\n');
let sameZone = 0, diffZone = 0;
const diffExamples = [];
for (const item of data.lineItems) {
  if (item.status === 'MATCH' && item.zoneYours && item.zoneAdjuster) {
    if (item.zoneYours === item.zoneAdjuster) {
      sameZone++;
    } else {
      diffZone++;
      if (diffExamples.length < 10) {
        diffExamples.push(`  Y:"${item.zoneYours}" vs A:"${item.zoneAdjuster}" — ${(item.descriptionYours || '').substring(0, 50)}`);
      }
    }
  }
}
console.log(`  Same zone on both sides: ${sameZone}`);
console.log(`  Different zones: ${diffZone}`);
if (diffExamples.length > 0) {
  console.log('  Examples:');
  diffExamples.forEach(e => console.log(e));
}
