// Audit the pipeline trace: parse Sonnet 2 pairs, cross-ref with Haiku zones and cheat sheet
const fs = require('fs');

const trace = fs.readFileSync('scripts/pipeline-trace.txt', 'utf8');

// ── Parse Haiku items ────────────────────────────────────────────────────────
function parseHaikuItems(section) {
  const match = section.match(/```json\s*([\s\S]*?)```/);
  if (!match) return [];
  const obj = JSON.parse(match[1]);
  return obj.items;
}

function extractSection(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) return '';
  const end = endMarker ? text.indexOf(endMarker, start + startMarker.length) : text.length;
  return text.substring(start, end === -1 ? text.length : end);
}

const yourSection = extractSection(trace, 'HAIKU RAW RESPONSE', 'HAIKU RAW RESPONSE');
// Second occurrence for adjuster
const firstEnd = trace.indexOf('HAIKU RAW RESPONSE') + 20;
const adjStart = trace.indexOf('HAIKU RAW RESPONSE', firstEnd);
const adjEnd = trace.indexOf('PRE-DEDUP', adjStart);
const adjSection = trace.substring(adjStart, adjEnd);

const yourItems = parseHaikuItems(yourSection);
const adjItems = parseHaikuItems(adjSection);

const yourMap = new Map(yourItems.map(i => [i.n, i]));
const adjMap = new Map(adjItems.map(i => [i.n, i]));

// ── Parse Sonnet 1 zone groups ───────────────────────────────────────────────
// Split on 'RAW RESPONSE' which appears right after the section title
const s1Marker = trace.indexOf('ZONE RECONCILIATION');
const s1RawStart = trace.indexOf('RAW RESPONSE', s1Marker + 20);
const s1RawEnd = trace.indexOf('SONNET 2', s1RawStart);
const s1Section = trace.substring(s1RawStart, s1RawEnd);
const s1Fenced = s1Section.match(/```(?:json)?\s*([\s\S]*?)```/);
const s1Json = s1Fenced ? s1Fenced[1] : s1Section.match(/\{[\s\S]*\}/)?.[0] || '';
const s1Groups = JSON.parse(s1Json).groups;

// Build zone map: raw name → canonical
const zoneMap = new Map();
for (const g of s1Groups) {
  for (const name of g.yours) zoneMap.set(name, g.canonical);
  for (const name of g.adjuster) zoneMap.set(name, g.canonical);
}

// ── Parse Sonnet 2 pairs ─────────────────────────────────────────────────────
const s2Marker = trace.lastIndexOf('RAW RESPONSE');
const s2Section = trace.substring(s2Marker);
const s2Match = s2Section.match(/\{"pairs":\[[\s\S]*?\]\}/);
const pairs = JSON.parse(s2Match[0]).pairs;

// ── Audit ────────────────────────────────────────────────────────────────────
console.log(`\n=== COUNTS ===`);
console.log(`Yours items (Haiku): ${yourItems.length}`);
console.log(`Adjuster items (Haiku): ${adjItems.length}`);
console.log(`Sonnet 1 zone groups: ${s1Groups.length}`);
console.log(`Sonnet 2 pairs: ${pairs.length}`);

// Count statuses
let matched = 0, yourOnly = 0, adjOnly = 0;
const yUsed = new Set(), aUsed = new Set();
const duplicateY = [], duplicateA = [];

for (const p of pairs) {
  if (p.y !== null && p.a !== null) matched++;
  else if (p.y !== null && p.a === null) yourOnly++;
  else if (p.y === null && p.a !== null) adjOnly++;

  if (p.y !== null) {
    if (yUsed.has(p.y)) duplicateY.push(p.y);
    yUsed.add(p.y);
  }
  if (p.a !== null) {
    if (aUsed.has(p.a)) duplicateA.push(p.a);
    aUsed.add(p.a);
  }
}

console.log(`\nMatched pairs: ${matched}`);
console.log(`Yours-only (MISSING_FROM_ADJUSTER): ${yourOnly}`);
console.log(`Adjuster-only (ADDED_BY_ADJUSTER): ${adjOnly}`);
console.log(`Total accounted: ${matched * 2 + yourOnly + adjOnly} (yours: ${matched + yourOnly}, adj: ${matched + adjOnly})`);

// Missing items
const yMissing = yourItems.filter(i => !yUsed.has(i.n)).map(i => i.n);
const aMissing = adjItems.filter(i => !aUsed.has(i.n)).map(i => i.n);
console.log(`\nYours items NOT in any pair: [${yMissing.join(', ')}] (${yMissing.length})`);
console.log(`Adjuster items NOT in any pair: [${aMissing.join(', ')}] (${aMissing.length})`);
console.log(`Duplicate yours line numbers: [${duplicateY.join(', ')}]`);
console.log(`Duplicate adjuster line numbers: [${duplicateA.join(', ')}]`);

// ── Zone reconciliation audit ────────────────────────────────────────────────
console.log(`\n=== SONNET 1 ZONE RECONCILIATION ===`);
for (const g of s1Groups) {
  const yNames = g.yours.length ? g.yours.join(', ') : '—';
  const aNames = g.adjuster.length ? g.adjuster.join(', ') : '—';
  console.log(`  ${g.canonical} [${g.confidence}%] yours=[${yNames}] adj=[${aNames}]`);
}

// ── Cross-zone pair check ────────────────────────────────────────────────────
console.log(`\n=== CROSS-ZONE PAIRS (items paired across different canonical zones) ===`);
let crossZone = 0;
for (const p of pairs) {
  if (p.y === null || p.a === null) continue;
  const yItem = yourMap.get(p.y);
  const aItem = adjMap.get(p.a);
  if (!yItem || !aItem) continue;
  const yCanon = zoneMap.get(yItem.z) || yItem.z;
  const aCanon = zoneMap.get(aItem.z) || aItem.z;
  if (yCanon !== aCanon) {
    crossZone++;
    console.log(`  y${p.y} (${yItem.z} → ${yCanon}) ↔ a${p.a} (${aItem.z} → ${aCanon}): "${yItem.d}" ↔ "${aItem.d}"`);
  }
}
if (crossZone === 0) console.log('  None — all pairs are within the same canonical zone.');

// ── Problematic pairs: a:5 used 4 times ──────────────────────────────────────
console.log(`\n=== MULTI-USE ADJUSTER LINE NUMBERS ===`);
const aCounts = new Map();
for (const p of pairs) {
  if (p.a !== null) aCounts.set(p.a, (aCounts.get(p.a) || 0) + 1);
}
for (const [a, count] of aCounts) {
  if (count > 1) {
    const aItem = adjMap.get(a);
    console.log(`  a${a} used ${count} times: "${aItem?.d}"`);
  }
}

// ── Full pair listing with descriptions ──────────────────────────────────────
console.log(`\n=== FULL PAIR LISTING ===`);
for (const p of pairs) {
  const yItem = p.y !== null ? yourMap.get(p.y) : null;
  const aItem = p.a !== null ? adjMap.get(p.a) : null;
  const yDesc = yItem ? `y${p.y}: "${yItem.d}" [${yItem.z}]` : 'y:null';
  const aDesc = aItem ? `a${p.a}: "${aItem.d}" [${aItem.z}]` : 'a:null';
  const status = p.y !== null && p.a !== null ? 'PAIR' : (p.y !== null ? 'MISSING' : 'ADDED');
  console.log(`  ${status}  ${yDesc}  ↔  ${aDesc}`);
}
