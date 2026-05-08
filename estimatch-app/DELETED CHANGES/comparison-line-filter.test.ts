import { filterExtractedLines, FilterableLineRecord } from './comparison-line-filter';

function makeLines(texts: string[]): FilterableLineRecord[] {
  return texts.map((text, i) => ({ lineNumber: i + 1, text }));
}

let failures = 0;
let passes = 0;

function assert(condition: boolean, label: string) {
  if (!condition) {
    console.error(`  FAIL: ${label}`);
    failures += 1;
  } else {
    console.log(`  PASS: ${label}`);
    passes += 1;
  }
}

function simplify(s: string): string {
  return s.replace(/[\s$,]+/g, ' ').trim().toLowerCase();
}

function assertLineKept(result: FilterableLineRecord[], text: string, label: string) {
  const target = simplify(text);
  const found = result.some((line) => {
    const simplified = simplify(line.text);
    return simplified.includes(target) || target.includes(simplified);
  });
  assert(found, `${label} — line kept: "${text.slice(0, 60)}..."`);
}

// ---------------------------------------------------------------
// Test 1: Scope line items are NEVER dropped
// ---------------------------------------------------------------
console.log('\n--- Test 1: Scope line items preserved ---');
{
  const scopeLines = [
    '1.  Remove Comp. shingles - 3 tab - w/out flashing    10.00 SQ    45.67    456.70',
    'Drywall - 1/2" - hung, taped, floated, ready for paint    128.00 SF',
    'RFG   ROOFING',
    'Batt insulation - 4" - R13 - paper/foil faced    250.00 SF    0.61    152.50',
    'PLM   PLUMBING',
    'Seal/prime then paint walls & ceiling - one coat/one color    128.00 SF    0.80    102.40',
    'Remove Additional charge for steep roof - 7/12 to 9/12 slope    10.00 SQ    19.40    194.00',
    'ELC   ELECTRICAL',
    'DRY   DRYWALL',
    'Smoke detector - builder grade    1.00 EA    69.44    69.44',
    'General demolition - per hour    2.00 HR    33.58    67.16',
    'Content manipulation - per hour (move out then reset)    4.00 HR    28.98    115.92',
  ];

  const { lines } = filterExtractedLines(makeLines(scopeLines));

  for (const scopeLine of scopeLines) {
    assertLineKept(lines, scopeLine, 'scope-preserve');
  }
}

// ---------------------------------------------------------------
// Test 2: Page chrome is dropped
// ---------------------------------------------------------------
console.log('\n--- Test 2: Page chrome dropped ---');
{
  const input = [
    'Page 1 of 5',
    'Page 2 of 5',
    '- 3 -',
    '42',
    '04/17/2026 10:30 AM',
    'RFG   ROOFING',
    'Remove Comp. shingles    10.00 SQ    45.67    456.70',
  ];

  const { lines, stats } = filterExtractedLines(makeLines(input));
  assert(stats.droppedPageChrome >= 3, 'page-chrome — dropped at least 3 chrome lines');
  assertLineKept(lines, 'RFG   ROOFING', 'page-chrome');
  assertLineKept(lines, 'Remove Comp. shingles', 'page-chrome');
}

// ---------------------------------------------------------------
// Test 3: Document metadata is dropped
// ---------------------------------------------------------------
console.log('\n--- Test 3: Document metadata dropped ---');
{
  const input = [
    '(555) 123-4567',
    'claims@insurance.com',
    'https://www.xactware.com',
    'www.insurance.com/claims',
    'Claim #: ABC-12345',
    'Policy Number: POL-99999',
    'Insured: John Smith',
    'Xactimate 28.0',
    'Remove Comp. shingles    10.00 SQ    45.67    456.70',
  ];

  const { lines, stats } = filterExtractedLines(makeLines(input));
  assert(stats.droppedMetadata >= 6, 'metadata — dropped at least 6 metadata lines');
  assertLineKept(lines, 'Remove Comp. shingles', 'metadata');
}

// ---------------------------------------------------------------
// Test 4: Boilerplate is dropped
// ---------------------------------------------------------------
console.log('\n--- Test 4: Boilerplate dropped ---');
{
  const input = [
    '----------------------------',
    '============================',
    '***',
    '(continued)',
    "cont'd",
    'Remove Comp. shingles    10.00 SQ    45.67    456.70',
  ];

  const { lines, stats } = filterExtractedLines(makeLines(input));
  assert(stats.droppedBoilerplate >= 4, 'boilerplate — dropped at least 4 boilerplate lines');
  assertLineKept(lines, 'Remove Comp. shingles', 'boilerplate');
}

// ---------------------------------------------------------------
// Test 5: Summary/total lines are dropped
// ---------------------------------------------------------------
console.log('\n--- Test 5: Summary lines dropped ---');
{
  const input = [
    'Subtotal',
    'Page Total    $12,345.67',
    'Grand Total    $45,678.90',
    'Total: Main Level',
    'Sales Tax    $1,234.56',
    'Line Item Total    $99,999.99',
    'Replacement Cost Value    $45,000.00',
    'Remove Comp. shingles    10.00 SQ    45.67    456.70',
  ];

  const { lines, stats } = filterExtractedLines(makeLines(input));
  assert(stats.droppedSummaryLines >= 5, 'summary — dropped at least 5 summary lines');
  assertLineKept(lines, 'Remove Comp. shingles', 'summary');
}

// ---------------------------------------------------------------
// Test 6: Near-duplicates within window are dropped
// ---------------------------------------------------------------
console.log('\n--- Test 6: Near-duplicates dropped ---');
{
  const input = [
    'Some header text that appears twice',
    'Remove Comp. shingles    10.00 SQ    45.67    456.70',
    'Some header text that appears twice',
    'Drywall - 1/2"    128.00 SF    0.80    102.40',
  ];

  const { lines, stats } = filterExtractedLines(makeLines(input));
  assert(stats.droppedDuplicates >= 1, 'duplicates — dropped at least 1 duplicate');
  assertLineKept(lines, 'Remove Comp. shingles', 'duplicates');
  assertLineKept(lines, 'Drywall', 'duplicates');
}

// ---------------------------------------------------------------
// Test 7: Normalization — currency and whitespace
// ---------------------------------------------------------------
console.log('\n--- Test 7: Normalization ---');
{
  const input = [
    'Remove Comp. shingles   $1,234.56    $2,345,678.90',
  ];

  const { lines } = filterExtractedLines(makeLines(input));
  const normalized = lines[0]?.text ?? '';
  assert(!normalized.includes('$'), 'normalization — $ stripped');
  assert(!normalized.includes(','), 'normalization — commas stripped from numbers');
  assert(!/  /.test(normalized), 'normalization — no double spaces');
  assert(normalized.includes('1234.56'), 'normalization — number preserved without formatting');
}

// ---------------------------------------------------------------
// Test 8: lineNumber is preserved
// ---------------------------------------------------------------
console.log('\n--- Test 8: lineNumber preserved ---');
{
  const input = [
    { lineNumber: 5, text: 'Page 1 of 3' },
    { lineNumber: 10, text: 'Remove Comp. shingles    10.00 SQ    45.67    456.70' },
    { lineNumber: 15, text: '---' },
    { lineNumber: 20, text: 'RFG   ROOFING' },
  ];

  const { lines } = filterExtractedLines(input);
  const lineNumbers = lines.map((l) => l.lineNumber);
  assert(lineNumbers.includes(10), 'lineNumber — scope line keeps original lineNumber 10');
  assert(lineNumbers.includes(20), 'lineNumber — scope line keeps original lineNumber 20');
  assert(!lineNumbers.includes(5), 'lineNumber — page chrome lineNumber 5 dropped');
  assert(!lineNumbers.includes(15), 'lineNumber — boilerplate lineNumber 15 dropped');
}

// ---------------------------------------------------------------
// Test 9: Kill switch disables filtering
// ---------------------------------------------------------------
console.log('\n--- Test 9: Kill switch ---');
{
  const original = process.env.COMPARISON_PROCESSING_PRE_FILTER;
  process.env.COMPARISON_PROCESSING_PRE_FILTER = 'false';

  const input = [
    'Page 1 of 3',
    '---',
    'Grand Total    $99,999',
    'RFG   ROOFING',
  ];

  const { lines, stats } = filterExtractedLines(makeLines(input));
  assert(lines.length === 4, 'kill-switch — all lines returned when filter disabled');
  assert(stats.droppedPageChrome === 0, 'kill-switch — no drops when disabled');

  if (original === undefined) {
    delete process.env.COMPARISON_PROCESSING_PRE_FILTER;
  } else {
    process.env.COMPARISON_PROCESSING_PRE_FILTER = original;
  }
}

// ---------------------------------------------------------------
// Test 10: Stats are accurate
// ---------------------------------------------------------------
console.log('\n--- Test 10: Stats accuracy ---');
{
  const input = [
    'Page 1 of 3',
    '(555) 123-4567',
    '---',
    'Grand Total    $99,999',
    'Some repeat line here',
    'Some repeat line here',
    'RFG   ROOFING',
    'Remove shingles    10.00 SQ    45.67    456.70',
  ];

  const { lines, stats } = filterExtractedLines(makeLines(input));
  assert(stats.inputCount === 8, 'stats — inputCount is 8');
  assert(stats.outputCount === lines.length, 'stats — outputCount matches result length');
  assert(
    stats.droppedPageChrome + stats.droppedMetadata + stats.droppedBoilerplate +
      stats.droppedSummaryLines + stats.droppedDuplicates ===
      stats.inputCount - stats.outputCount,
    'stats — drop counts sum to difference'
  );
  assert(stats.estimatedTokensSaved >= 0, 'stats — tokens saved is non-negative');
}

// ---------------------------------------------------------------
// Test 11: Zone headers are preserved
// ---------------------------------------------------------------
console.log('\n--- Test 11: Zone headers preserved ---');
{
  const input = [
    'Entry',
    'Main Level',
    'Kitchen',
    'Master Bedroom',
    'Remove Comp. shingles    10.00 SQ    45.67    456.70',
  ];

  const { lines } = filterExtractedLines(makeLines(input));
  assertLineKept(lines, 'Entry', 'zone-headers');
  assertLineKept(lines, 'Main Level', 'zone-headers');
  assertLineKept(lines, 'Kitchen', 'zone-headers');
  assertLineKept(lines, 'Master Bedroom', 'zone-headers');
}

// ---------------------------------------------------------------
// Summary
// ---------------------------------------------------------------
console.log(`\n========================================`);
console.log(`Results: ${passes} passed, ${failures} failed`);
console.log(`========================================\n`);

if (failures > 0) {
  process.exit(1);
}
