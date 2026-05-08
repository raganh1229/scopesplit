const fs = require('fs');
const d = JSON.parse(fs.readFileSync('scripts/audit-output.json', 'utf8'));

// Cheat sheet expected zones
const cheatYours = [
  'General / Administrative',
  'Roof System',
  'Exterior Envelope',
  '1st Floor - Retail Space A',
  '1st Floor - Retail Space B',
  '1st Floor - Common Lobby',
  '1st Floor - Restroom 1 (Men\'s)',
  '2nd Floor - Office Suite 201',
  '2nd Floor - Office Suite 202',
  '2nd Floor - Conference Room',
  '2nd Floor - Common Hallway',
  '2nd Floor - Restroom 2 (Women\'s)',
  'Elevator / Stairwell',
];

const cheatAdj = [
  'General',
  'Roofing',
  'Exterior Envelope',
  '1st Floor - Common Lobby',
  '1st Floor - Retail Space A',
  '1st Floor - Storage/Janitor',
  '1st Floor - Women\'s Restroom 1',
  '1st Floor - Men\'s Restroom 1',
  '2nd Floor - Conference Room',
  '2nd Floor - Office Suite 201',
  '2nd Floor - Office Suite 202',
  '2nd Floor - Women\'s Restroom 2',
  'Elevator / Stairwell',
  'Site Work / Parking',
  'ADA Compliance',
];

// Collect what Haiku actually returned (from zoneYours and zoneAdjuster on items)
const haikuYours = new Set();
const haikuAdj = new Set();
d.lineItems.forEach(i => {
  if (i.zoneYours) haikuYours.add(i.zoneYours);
  if (i.zoneAdjuster) haikuAdj.add(i.zoneAdjuster);
});

console.log('=== HAIKU YOURS ZONES vs CHEAT SHEET ===\n');
console.log('PDF (cheat sheet)                          | Haiku returned');
console.log('-------------------------------------------|------------------------------------------');

const allYoursZones = new Set([...cheatYours, ...haikuYours]);
[...allYoursZones].sort().forEach(z => {
  const inPdf = cheatYours.includes(z) ? '✓' : ' ';
  const inHaiku = haikuYours.has(z) ? '✓' : ' ';
  const flag = (inPdf === '✓' && inHaiku !== '✓') ? ' ← MISSING' : (inPdf !== '✓' && inHaiku === '✓') ? ' ← MADE UP' : '';
  console.log(`  [${inPdf}] ${z.padEnd(40)} | [${inHaiku}] ${z}${flag}`);
});

console.log('\n=== HAIKU ADJUSTER ZONES vs CHEAT SHEET ===\n');
console.log('PDF (cheat sheet)                          | Haiku returned');
console.log('-------------------------------------------|------------------------------------------');

const allAdjZones = new Set([...cheatAdj, ...haikuAdj]);
[...allAdjZones].sort().forEach(z => {
  const inPdf = cheatAdj.includes(z) ? '✓' : ' ';
  const inHaiku = haikuAdj.has(z) ? '✓' : ' ';
  const flag = (inPdf === '✓' && inHaiku !== '✓') ? ' ← MISSING' : (inPdf !== '✓' && inHaiku === '✓') ? ' ← MADE UP' : '';
  console.log(`  [${inPdf}] ${z.padEnd(40)} | [${inHaiku}] ${z}${flag}`);
});

// Show the mapping: made-up → what it probably should be
console.log('\n=== MADE-UP ZONE → PROBABLE REAL ZONE ===\n');
const madeUpMap = [
  { fake: 'Common Lobby', real: '1st Floor - Common Lobby', issue: 'Dropped floor prefix' },
  { fake: 'Conference Room', real: '2nd Floor - Conference Room', issue: 'Dropped floor prefix' },
  { fake: 'Retail Space A', real: '1st Floor - Retail Space A', issue: 'Dropped floor prefix' },
  { fake: 'Retail Space B', real: '1st Floor - Retail Space B', issue: 'Dropped floor prefix' },
  { fake: 'Restroom 1 (Men\'s)', real: '1st Floor - Restroom 1 (Men\'s)', issue: 'Dropped floor prefix' },
  { fake: 'Restroom 2 (Women\'s)', real: '2nd Floor - Restroom 2 (Women\'s)', issue: 'Dropped floor prefix' },
  { fake: 'Exterior', real: 'Exterior Envelope', issue: 'Truncated name' },
  { fake: 'General', real: 'General / Administrative', issue: 'Truncated name (contractor side)' },
  { fake: 'Roofing', real: 'Roof System', issue: 'Synonym (contractor side)' },
  { fake: 'Office Suite 1', real: '2nd Floor - Office Suite 201', issue: 'Renamed + dropped prefix' },
  { fake: 'Office Suite 2', real: '2nd Floor - Office Suite 202', issue: 'Renamed + dropped prefix' },
  { fake: 'Women\'s Restroom 1', real: '1st Floor - Women\'s Restroom 1', issue: 'Dropped floor prefix' },
  { fake: 'Parking/Site', real: 'Site Work / Parking', issue: 'Reworded + reformatted' },
  { fake: 'Elevator/Stairwell', real: 'Elevator / Stairwell', issue: 'Removed spaces around slash' },
];

madeUpMap.forEach(m => {
  const count = d.lineItems.filter(i => i.zoneCanonical === m.fake).length;
  if (count > 0) {
    console.log(`  "${m.fake}" (${count} items)`);
    console.log(`    → Should be: "${m.real}"`);
    console.log(`    → Issue: ${m.issue}\n`);
  }
});
