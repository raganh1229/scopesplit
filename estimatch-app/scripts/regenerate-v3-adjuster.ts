import * as fs from 'node:fs';
import * as path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

type Row = {
  contractorDescription: string;
  adjusterDescription: string;
  status: string;
  contractorAmount: string;
  adjusterAmount: string;
  gapAmount: string;
};

type Zone = {
  contractorZone: string;
  adjusterZone: string;
  rows: Row[];
};

const ROOT = path.resolve(__dirname, '../../../PDFS/Generated Sets/Verified Sets/V3');
const CHEATSHEET_PATH = path.join(ROOT, 'V3_Cheatsheet.md');
const ADJUSTER_PDF_PATH = path.join(ROOT, 'Adjuster_V3.pdf');

const markdown = fs.readFileSync(CHEATSHEET_PATH, 'utf8');

const zoneHeadingPattern = /^###\s+(.+?)\s+\/\s+(.+)$/gm;
const zones: Zone[] = [];
const headings = [...markdown.matchAll(zoneHeadingPattern)];

for (let i = 0; i < headings.length; i++) {
  const match = headings[i];
  const start = match.index ?? 0;
  const end = i + 1 < headings.length ? headings[i + 1].index ?? markdown.length : markdown.indexOf('\n---', start + 1) > -1 ? markdown.indexOf('\n---', start + 1) : markdown.length;
  const block = markdown.slice(start, end);
  const contractorZone = match[1].trim().replace(/`/g, '');
  const adjusterZone = match[2].trim().replace(/`/g, '');
  const rows: Row[] = [];

  for (const line of block.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    if (line.includes('|---')) continue;
    if (line.includes('| # |')) continue;

    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    if (cells.length < 8) continue;

    const adjusterDescription = cells[3].replace(/^`|`$/g, '').trim();
    if (!adjusterDescription || adjusterDescription === '*(none)*') continue;

    rows.push({
      contractorDescription: cells[2].trim(),
      adjusterDescription,
      status: cells[4].trim(),
      contractorAmount: cells[5].trim(),
      adjusterAmount: cells[6].trim(),
      gapAmount: cells[7].trim(),
    });
  }

  zones.push({ contractorZone, adjusterZone, rows });
}

function dollarsToNumber(value: string): number {
  const normalized = value.replace(/[$,]/g, '').trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }

  if (current) lines.push(current);
  return lines;
}

async function generatePdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const margin = 42;
  const pageWidth = 612;
  const pageHeight = 792;
  let page = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;
  let pageNo = 1;

  function newPage() {
    page.drawText(`Page ${pageNo}`, { x: pageWidth - margin - 44, y: 24, size: 8, font, color: rgb(0.35, 0.35, 0.35) });
    pageNo++;
    page = pdf.addPage([pageWidth, pageHeight]);
    y = pageHeight - margin;
  }

  function ensure(space: number) {
    if (y - space < margin) newPage();
  }

  function text(value: string, x: number, size = 9, useBold = false, color = rgb(0, 0, 0)) {
    page.drawText(value, { x, y, size, font: useBold ? bold : font, color });
  }

  text('Pinnacle West Mutual Insurance', margin, 14, true, rgb(0.05, 0.12, 0.22));
  y -= 18;
  text('Estimate PWM-30817-FNL', margin, 10, false, rgb(0.2, 0.2, 0.2));
  y -= 14;
  text('Insured: Kitchen Fire — Phoenix AZ Single-Story Residence', margin, 10);
  y -= 14;
  text('Property: 12084 W. Cactus Wren Ln, Phoenix, AZ 85027', margin, 10);
  y -= 14;
  text('Date of Loss: 2/11/2025    Estimate Date: 3/10/2025', margin, 10);
  y -= 24;

  let itemNo = 1;
  let total = 0;

  for (const zone of zones) {
    ensure(60);
    page.drawRectangle({ x: margin, y: y - 4, width: pageWidth - margin * 2, height: 18, color: rgb(0.88, 0.92, 0.98) });
    text(zone.adjusterZone.toUpperCase(), margin + 6, 10, true, rgb(0.05, 0.15, 0.35));
    y -= 24;

    text('Item', margin, 8, true);
    text('Description', margin + 36, 8, true);
    text('Qty', margin + 352, 8, true);
    text('Unit', margin + 392, 8, true);
    text('RCV', margin + 438, 8, true);
    y -= 10;
    page.drawLine({ start: { x: margin, y }, end: { x: pageWidth - margin, y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
    y -= 12;

    for (const row of zone.rows) {
      const lines = wrapText(row.adjusterDescription.replace(/\*|`/g, ''), 48);
      const lineHeight = 10;
      ensure(Math.max(20, lines.length * lineHeight + 6));

      text(String(itemNo).padStart(3, '0'), margin, 8);
      for (let i = 0; i < lines.length; i++) {
        page.drawText(lines[i], { x: margin + 36, y: y - i * lineHeight, size: 8, font });
      }
      text('1.00', margin + 352, 8);
      text('EA', margin + 392, 8);
      text(row.adjusterAmount.replace('$', ''), margin + 438, 8);

      total += dollarsToNumber(row.adjusterAmount);
      itemNo++;
      y -= Math.max(18, lines.length * lineHeight + 4);
    }

    y -= 10;
  }

  ensure(50);
  page.drawLine({ start: { x: margin, y }, end: { x: pageWidth - margin, y }, thickness: 1, color: rgb(0.1, 0.1, 0.1) });
  y -= 18;
  text(`Estimate Total RCV: $${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, margin, 12, true);
  newPage();
  pdf.removePage(pdf.getPageCount() - 1);

  fs.writeFileSync(ADJUSTER_PDF_PATH, await pdf.save());
}

function regenerateCheatsheet() {
  const marker = '<!-- Regenerated V3 adjuster PDF uses room/location-based adjuster headers matching this cheatsheet. -->';
  const cleaned = markdown.replace(/\n?<!-- Regenerated V3 adjuster PDF uses room\/location-based adjuster headers matching this cheatsheet\. -->\n?/g, '\n');
  const output = cleaned.replace('# V3 Cheat Sheet — Kitchen Fire — Phoenix AZ Single-Story Residence', `# V3 Cheat Sheet — Kitchen Fire — Phoenix AZ Single-Story Residence\n\n${marker}`);
  fs.writeFileSync(CHEATSHEET_PATH, output, 'utf8');
}

async function main() {
  if (zones.length !== 9) {
    throw new Error(`Expected 9 zones, parsed ${zones.length}`);
  }

  await generatePdf();
  regenerateCheatsheet();

  console.log(`Regenerated ${ADJUSTER_PDF_PATH}`);
  console.log(`Regenerated ${CHEATSHEET_PATH}`);
  console.log(`Zones: ${zones.map(z => z.adjusterZone).join(', ')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
