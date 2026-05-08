const pdfParse = require('pdf-parse');
const fs = require('fs');

const MONEY = /[\d,]+\.\d{2}/g;
const QTY_UNIT_SRC = '(\\d+\\.?\\d*)\\s*(SQ|LF|SF|EA|CY|HR|MO|WK|DY|DA|LS|CF|BF|FF|RF|TN|GL|RL|BG|CS|PR|PC|CT|MBF|MLF)(?=[^a-zA-Z]|$)';

// Set4 is water damage format: RESET, REMOVE, REPLACE, TAX, O&P, TOTAL
function extractPdfCosts(rawLine) {
  const costText = rawLine.replace(new RegExp(QTY_UNIT_SRC, 'gi'), ' ');
  const matches = costText.match(MONEY) || [];
  MONEY.lastIndex = 0;
  const nums = matches.map(s => parseFloat(s.replace(/,/g, '')));
  const total = nums.length > 0 ? nums[nums.length - 1] : null;
  if (nums.length <= 5) {
    return { remove: nums[0] ?? null, replace: nums[1] ?? null, reset: null, tax: nums[2] ?? null, op: nums[3] ?? null, total };
  }
  // Water damage: RESET, REMOVE, REPLACE, TAX, O&P, TOTAL
  return { reset: nums[0] ?? null, remove: nums[1] ?? null, replace: nums[2] ?? null, tax: nums[3] ?? null, op: nums[4] ?? null, total };
}

function extractPdfQty(rawLine) {
  const m = rawLine.match(new RegExp(QTY_UNIT_SRC, 'i'));
  if (!m) return null;
  return m[1] + ' ' + m[2].toUpperCase();
}

function approxEq(a, b) {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a - b) < 0.02;
}

function findPdfLine(pdfLines, descSnip, storedTotal) {
  const candidates = pdfLines.filter(l => {
    const norm = l.toLowerCase().replace(/[^a-z0-9]/g, '');
    const hasMoney = /[\d,]+\.\d{2}/.test(l);
    return norm.includes(descSnip) && hasMoney;
  });
  for (const line of candidates) {
    const costs = extractPdfCosts(line);
    if (approxEq(costs.total, storedTotal)) return line;
  }
  return candidates[0] || null;
}

async function main() {
  const data = JSON.parse(fs.readFileSync('scripts/set4-audit.json', 'utf8'));
  const items = data.lineItems;

  const yourBuf = fs.readFileSync('../../PDFS/Accurate Comparisons/Set4/Contractor_Estimate_Test_Set2.pdf');
  const adjBuf = fs.readFileSync('../../PDFS/Accurate Comparisons/Set4/Adjuster_Estimate_Test_Set2.pdf');
  const yourText = (await pdfParse(yourBuf)).text;
  const adjText = (await pdfParse(adjBuf)).text;
  const yourLines = yourText.split('\n').filter(l => l.trim().length > 0);
  const adjLines = adjText.split('\n').filter(l => l.trim().length > 0);

  let passCount = 0;
  let failCount = 0;
  let skipped = 0;
  const failures = [];

  function checkSide(idx, sideName, pdfLines, desc, storedQty, storedRem, storedRep, storedReset, storedTax, storedOp, storedTot) {
    if (!desc || desc === '\u2014') return;
    if (storedTot === null) { skipped++; return; }
    const descSnip = desc.substring(0, 18).toLowerCase().replace(/[^a-z0-9]/g, '');
    const pdfLine = findPdfLine(pdfLines, descSnip, storedTot);
    if (!pdfLine) { skipped++; return; }

    const pdfCosts = extractPdfCosts(pdfLine);
    const pdfQty = extractPdfQty(pdfLine);

    const checks = [
      { col: 'qty', pdf: pdfQty, stored: storedQty, isQty: true },
      { col: 'remove', pdf: pdfCosts.remove, stored: storedRem },
      { col: 'replace', pdf: pdfCosts.replace, stored: storedRep },
      { col: 'reset', pdf: pdfCosts.reset, stored: storedReset },
      { col: 'tax', pdf: pdfCosts.tax, stored: storedTax },
      { col: 'op', pdf: pdfCosts.op, stored: storedOp },
      { col: 'total', pdf: pdfCosts.total, stored: storedTot },
    ];

    for (const c of checks) {
      const ok = c.isQty ? c.pdf === c.stored : approxEq(c.pdf, c.stored);
      if (ok) { passCount++; }
      else { failCount++; failures.push({ idx: idx+1, side: sideName, col: c.col, pdf: c.pdf, stored: c.stored, desc: desc.substring(0, 40) }); }
    }
  }

  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    checkSide(idx, 'yours', yourLines, it.descriptionYours, it.qtyYours, it.removeYours, it.replaceYours, it.resetYours, it.taxYours, it.opYours, it.totalYours);
    checkSide(idx, 'adj', adjLines, it.descriptionAdjuster, it.qtyAdjuster, it.removeAdjuster, it.replaceAdjuster, it.resetAdjuster, it.taxAdjuster, it.opAdjuster, it.totalAdjuster);
  }

  console.log(`\n=== SET 4 COLUMN VERIFICATION ===`);
  console.log(`PASS: ${passCount}  |  FAIL: ${failCount}  |  Skipped: ${skipped}  |  Total checks: ${passCount + failCount}`);
  const pct = passCount + failCount > 0 ? (100 * passCount / (passCount + failCount)).toFixed(2) : '0';
  console.log(`Accuracy: ${pct}%`);

  if (failures.length > 0) {
    console.log(`\nFAILURES (${failures.length}):`);
    for (const f of failures) {
      console.log(`  [${f.idx}] ${f.side} ${f.col}: PDF=${f.pdf} vs Stored=${f.stored}  | ${f.desc}`);
    }
  } else {
    console.log(`\nALL sub-columns match PDF values exactly.`);
  }
}

main().catch(console.error);
