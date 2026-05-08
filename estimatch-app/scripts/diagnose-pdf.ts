/**
 * Quick PDF diagnostic — reports page count, total text, and item-line count.
 * Usage: npx tsx scripts/diagnose-pdf.ts "C:\path\to\file.pdf"
 */
import fs from 'node:fs';
import pdfParse from 'pdf-parse';

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: npx tsx scripts/diagnose-pdf.ts <path-to-pdf>');
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const stat = fs.statSync(filePath);
  const bytes = fs.readFileSync(filePath);
  const data = await pdfParse(bytes);
  const text = data.text;
  const lines = text.split(/\r?\n/);

  // "Item-like" lines: start with one or more digits then a period (e.g. "247.")
  const itemLines = lines.filter((l) => /^\s*\d+\.\s/.test(l));
  const itemNumbers = itemLines
    .map((l) => {
      const m = l.match(/^\s*(\d+)\./);
      return m ? Number(m[1]) : null;
    })
    .filter((n): n is number => n !== null);

  const minItem = itemNumbers.length > 0 ? Math.min(...itemNumbers) : null;
  const maxItem = itemNumbers.length > 0 ? Math.max(...itemNumbers) : null;
  const distinctItems = new Set(itemNumbers).size;

  console.log('═══════════════════════════════════════════════════════');
  console.log(`File:           ${filePath}`);
  console.log(`Size:           ${stat.size.toLocaleString()} bytes`);
  console.log(`Page count:     ${data.numpages}`);
  console.log(`Text length:    ${text.length.toLocaleString()} chars`);
  console.log(`Total lines:    ${lines.length.toLocaleString()}`);
  console.log(`"X." lines:     ${itemLines.length} (lines that look like numbered items)`);
  console.log(`Item # range:   ${minItem ?? 'n/a'} → ${maxItem ?? 'n/a'} (${distinctItems} distinct numbers)`);
  console.log('═══════════════════════════════════════════════════════');
  console.log('\nFirst 20 item-like lines:');
  itemLines.slice(0, 20).forEach((l) => console.log(`  ${l.trim().slice(0, 100)}`));
  if (itemLines.length > 40) {
    console.log('\nMiddle 10 item-like lines:');
    const mid = Math.floor(itemLines.length / 2);
    itemLines.slice(mid, mid + 10).forEach((l) => console.log(`  ${l.trim().slice(0, 100)}`));
  }
  if (itemLines.length > 20) {
    console.log('\nLast 20 item-like lines:');
    itemLines.slice(-20).forEach((l) => console.log(`  ${l.trim().slice(0, 100)}`));
  }
  console.log('\nFirst 500 chars of raw text:');
  console.log(text.slice(0, 500));
  console.log('\n...Last 500 chars of raw text:');
  console.log(text.slice(-500));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
