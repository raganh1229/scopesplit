/**
 * dump-pdf-text.ts — extract raw text from a PDF page range
 * Usage: npx tsx scripts/dump-pdf-text.ts --file <path> --pages <start>-<end>
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const fileIdx  = process.argv.indexOf('--file');
const pagesIdx = process.argv.indexOf('--pages');
if (fileIdx === -1 || pagesIdx === -1) {
  console.error('Usage: npx tsx scripts/dump-pdf-text.ts --file <path> --pages <start>-<end>');
  process.exit(1);
}
const filePath   = process.argv[fileIdx + 1];
const [startStr, endStr] = process.argv[pagesIdx + 1].split('-');
const startPage  = parseInt(startStr);
const endPage    = parseInt(endStr ?? startStr);

async function main() {
  const data = new Uint8Array(fs.readFileSync(filePath));
  const pdf  = await getDocument({ data }).promise;
  console.log(`PDF has ${pdf.numPages} pages. Dumping pages ${startPage}–${endPage}.\n`);
  for (let p = startPage; p <= endPage; p++) {
    const page    = await pdf.getPage(p);
    const content = await page.getTextContent();
    const text    = content.items.map((i: any) => i.str).join(' ');
    console.log(`\n========== PAGE ${p} ==========`);
    console.log(text);
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
