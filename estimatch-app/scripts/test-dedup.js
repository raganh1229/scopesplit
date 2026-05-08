// Test the dedup logic directly (reimplemented in JS for quick testing)

function roughStem(word) {
  let w = word.toLowerCase();
  for (const suffix of ['ative', 'tion', 'sion', 'ment', 'ness', 'able', 'ible', 'ling', 'ical', 'ing', 'ous', 'ive', 'ful', 'ial', 'al', 'ed', 'er', 'ly']) {
    if (w.length > suffix.length + 2 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w;
}

function extractNumbers(s) {
  return (s.match(/\d+/g) || []).map(Number);
}

function normalizeForCompare(s) {
  return s.toLowerCase().replace(/[\/\-\(\)]/g, ' ').replace(/\s+/g, ' ').trim();
}

function numbersCompatible(shortNums, longNums) {
  if (shortNums.length === 0) return true;
  for (const sn of shortNums) {
    const hasMatch = longNums.some(ln => sn === ln || String(ln).endsWith(String(sn)));
    if (!hasMatch) return false;
  }
  return true;
}

function isSimplifiedVersion(shortName, longName) {
  if (shortName === longName) return false;
  const shortNorm = normalizeForCompare(shortName);
  const longNorm = normalizeForCompare(longName);
  
  console.log(`  Testing: "${shortName}" vs "${longName}"`);
  console.log(`    Normalized: "${shortNorm}" vs "${longNorm}"`);
  console.log(`    Substring: ${longNorm.includes(shortNorm)}`);
  
  if (longNorm.includes(shortNorm)) return true;
  
  const shortNoNums = shortNorm.replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
  const longNoNums = longNorm.replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
  if (shortNoNums.length >= 3 && longNoNums.includes(shortNoNums)) {
    if (numbersCompatible(extractNumbers(shortName), extractNumbers(longName))) return true;
  }
  
  const shortWords = shortNorm.split(/\s+/).filter(w => w.length > 2);
  const longWords = longNorm.split(/\s+/).filter(w => w.length > 2);
  const longStems = new Set(longWords.map(roughStem));
  console.log(`    Short stems: ${shortWords.map(roughStem)}, Long stems: ${[...longStems]}`);
  
  if (shortWords.length > 0) {
    const allStemsMatch = shortWords.every(sw => longStems.has(roughStem(sw)));
    if (allStemsMatch && numbersCompatible(extractNumbers(shortName), extractNumbers(longName))) return true;
  }
  
  return false;
}

// Test cases from the actual data
const tests = [
  ['Common Lobby', '1st Floor - Common Lobby'],
  ['Conference Room', '2nd Floor - Conference Room'],
  ['Retail Space A', '1st Floor - Retail Space A'],
  ['General', 'General / Administrative'],
  ['Elevator/Stairwell', 'Elevator / Stairwell'],
  ['Office Room A', '2nd Floor - Office Suite 201'],
  ['Office Room B', '2nd Floor - Office Suite 202'],
  ['Restroom 1 (Men\'s)', '1st Floor - Restroom 1 (Men\'s)'],
  // Should NOT merge:
  ['Restroom 1 (Men\'s)', 'Restroom 2 (Women\'s)'],
];

console.log('=== DEDUP TEST RESULTS ===\n');
for (const [short, long] of tests) {
  const result = isSimplifiedVersion(short, long);
  console.log(`  → ${result ? '✓ MERGE' : '✗ NO MERGE'}\n`);
}
