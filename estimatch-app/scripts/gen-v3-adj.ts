/**
 * gen-v3-adj.ts — Generates a proper Xactimate-style Adjuster_V3.pdf
 * matching V2 adjuster format with columns, zone headers, sub-categories.
 * Usage: npx tsx scripts/gen-v3-adj.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const OUT = path.resolve(__dirname, '../../../PDFS/Generated Sets/Verified Sets/V3/Adjuster_V3.pdf');

// [desc, qty, unit, rate, opFactor] — total = qty*rate*(1+opFactor)
type Item = [string, number, string, number, number];
type SubCat = { name: string; items: Item[] };
type Zone = { name: string; subcats: SubCat[] };

const P = 0.20; // standard 20% O&P
const N = 0;    // no O&P (permits/fees)

const zones: Zone[] = [
  { name: 'PROJECT GENERAL CONDITIONS', subcats: [
    { name: 'GENERAL', items: [
      ['30 cy debris dumpster — per pull', 3, 'EA', 550.00, P],
      ['Fire debris removal — per truck load', 8, 'LD', 125.00, P],
      ['Municipal permit — structural restoration', 1, 'EA', 850.00, N],
      ['Municipal permit — mechanical & electrical', 1, 'EA', 485.00, N],
      ['Post-construction cleaning — residential, per SF', 2400, 'SF', 0.32, P],
      ['Site fencing panels — rental per month', 3, 'MO', 285.00, P],
      ['Portable restroom — rental per month', 3, 'MO', 185.00, P],
      ['Safety barricade & signage package', 1, 'LS', 350.00, P],
      ['Air quality sampling — post-fire', 1, 'EA', 485.00, P],
      ['Emergency board-up — openings, per SF', 320, 'SF', 2.85, P],
      ['General helper labor — hourly', 60, 'HR', 34.50, P],
      ['Construction supervision — per hour', 36, 'HR', 72.00, P],
      ['Fire investigator report fee', 1, 'EA', 650.00, P],
    ]},
  ]},
  { name: 'ROOF SYSTEM', subcats: [
    { name: 'ROOFING', items: [
      ['Tear-off fire/heat damaged roof covering, per SQ', 24, 'SQ', 125.00, P],
      ['Roof sheathing — 7/16 OSB, per SF', 2400, 'SF', 1.45, P],
      ['Type X fire-board underlayment, per SF', 2400, 'SF', 0.85, P],
      ['Underlayment — synthetic, per SQ', 24, 'SQ', 45.00, P],
      ['30-yr dimensional shingle — per SQ', 24, 'SQ', 285.00, P],
      ['Hip & ridge cap — per LF', 75, 'LF', 5.25, P],
      ['Eave ice/water barrier, per LF', 125, 'LF', 2.85, P],
      ['Metal drip edge — eaves, per LF', 125, 'LF', 1.85, P],
      ['Plumbing stack flashing — replace', 3, 'EA', 65.00, P],
      ['Step & counter chimney flashing', 1, 'EA', 285.00, P],
      ['Blown-in attic insulation — R-38, per SF', 2400, 'SF', 2.25, P],
      ['Ridge & soffit ventilation, per LF', 120, 'LF', 3.85, P],
    ]},
    { name: 'EXTERIOR', items: [
      ['PVC fascia board — 1x6, per LF', 125, 'LF', 5.25, P],
      ['5-in aluminum K-style gutters, per LF', 125, 'LF', 5.85, P],
      ['Vented aluminum soffit — per SF', 185, 'SF', 3.85, P],
      ['3x4 aluminum downspouts, per LF', 64, 'LF', 4.25, P],
      ['Attic decking — plywood walkway boards, per SF', 55, 'SF', 6.50, P],
    ]},
  ]},
  { name: 'LIVING ROOM', subcats: [
    { name: 'DEMO', items: [
      ['Soot cleaning — ceiling, per SF', 420, 'SF', 0.95, P],
      ['Soot cleaning — walls, per SF', 680, 'SF', 0.95, P],
      ['Remove damaged drywall — ceiling', 420, 'SF', 1.28, P],
      ['Remove damaged drywall — walls', 680, 'SF', 1.28, P],
      ['Tear out base molding, per LF', 110, 'LF', 0.58, P],
      ['Remove hardwood flooring, per SF', 420, 'SF', 2.50, P],
      ['Ozone odor treatment — per session', 2, 'LS', 450.00, P],
    ]},
    { name: 'DRYWALL', items: [
      ['Install & finish drywall — ceiling', 420, 'SF', 3.85, P],
      ['Install & finish drywall — walls', 680, 'SF', 3.85, P],
      ['Knockdown texture — per SF', 1100, 'SF', 0.95, P],
      ['Drywall primer sealer — ceiling & walls', 1100, 'SF', 0.42, P],
    ]},
    { name: 'CARPENTRY', items: [
      ['Base molding — 3.5-in, per LF', 110, 'LF', 3.25, P],
      ['Window casing & stool — per LF', 40, 'LF', 4.50, P],
    ]},
    { name: 'FLOORING', items: [
      ['Hardwood flooring — 3/4-in oak, per SF', 420, 'SF', 8.50, P],
    ]},
    { name: 'PAINTING', items: [
      ['Ceiling paint — 2 coats', 420, 'SF', 1.55, P],
      ['Wall paint — 2 coats', 680, 'SF', 1.55, P],
      ['Base molding paint, per LF', 110, 'LF', 0.72, P],
    ]},
  ]},
  { name: 'KITCHEN', subcats: [
    { name: 'DEMO', items: [
      ['Soot cleaning — ceiling, per SF', 210, 'SF', 0.95, P],
      ['Soot cleaning — walls, per SF', 480, 'SF', 0.95, P],
      ['Remove damaged drywall — ceiling', 210, 'SF', 1.28, P],
      ['Remove damaged drywall — walls', 480, 'SF', 1.28, P],
      ['Remove LVP flooring', 210, 'SF', 2.10, P],
    ]},
    { name: 'DRYWALL', items: [
      ['Hang, tape & finish drywall — ceiling', 210, 'SF', 3.85, P],
      ['Hang, tape & finish drywall — walls', 480, 'SF', 3.85, P],
      ['Drywall primer sealer — kitchen', 690, 'SF', 0.42, P],
    ]},
    { name: 'CABINETS', items: [
      ['Cabinet hardware replacement set', 1, 'EA', 285.00, P],
      ['Ceramic tile backsplash — 4x4, per SF', 32, 'SF', 22.50, P],
      ['Base cabinets — builder grade, per LF', 18, 'LF', 215.00, P],
      ['Upper wall cabinets — builder grade, per LF', 14, 'LF', 195.00, P],
      ['Countertop — laminate, per SF', 36, 'SF', 78.00, P],
    ]},
    { name: 'FLOORING', items: [
      ['LVP flooring — furnished & installed', 210, 'SF', 7.25, P],
    ]},
    { name: 'FIXTURES', items: [
      ['Smoke detector — replace', 2, 'EA', 65.00, P],
      ['Kitchen sink — stainless double basin', 1, 'EA', 485.00, P],
      ['Kitchen faucet — pull-down spray', 1, 'EA', 285.00, P],
    ]},
    { name: 'PAINTING', items: [
      ['Ceiling paint — 2 coats', 210, 'SF', 1.55, P],
      ['Wall paint — 2 coats', 480, 'SF', 1.55, P],
    ]},
  ]},
  { name: 'DINING AREA', subcats: [
    { name: 'DEMO', items: [
      ['Soot cleaning — walls, per SF', 520, 'SF', 0.95, P],
      ['Remove damaged drywall — walls', 520, 'SF', 1.28, P],
      ['Tear out base molding, per LF', 90, 'LF', 0.58, P],
      ['Remove hardwood flooring, per SF', 325, 'SF', 2.50, P],
      ['Ozone odor treatment — per session', 1, 'LS', 450.00, P],
    ]},
    { name: 'DRYWALL', items: [
      ['Install & finish drywall — walls', 520, 'SF', 3.85, P],
      ['Install & finish drywall — ceiling', 325, 'SF', 3.85, P],
      ['Knockdown texture — per SF', 520, 'SF', 0.95, P],
      ['Drywall primer sealer — dining room', 845, 'SF', 0.42, P],
    ]},
    { name: 'CARPENTRY', items: [
      ['Base molding — 3.5-in, per LF', 90, 'LF', 3.25, P],
      ['Window casing trim — per LF', 40, 'LF', 4.50, P],
    ]},
    { name: 'FLOORING', items: [
      ['Hardwood flooring — 3/4-in oak, per SF', 325, 'SF', 8.50, P],
    ]},
    { name: 'PAINTING', items: [
      ['Wall paint — 2 coats', 520, 'SF', 1.55, P],
      ['Ceiling paint — 2 coats', 325, 'SF', 1.55, P],
      ['Base molding paint, per LF', 90, 'LF', 0.72, P],
    ]},
    { name: 'FIXTURES', items: [
      ['Smoke detector — replace', 1, 'EA', 65.00, P],
    ]},
  ]},
  { name: 'PRIMARY BEDROOM SUITE', subcats: [
    { name: 'DEMO', items: [
      ['Soot cleaning — walls, per SF', 580, 'SF', 0.95, P],
      ['Remove damaged drywall — walls', 580, 'SF', 1.28, P],
      ['Tear out base molding, per LF', 95, 'LF', 0.58, P],
      ['Remove carpet and pad, per SY', 42, 'SY', 3.85, P],
    ]},
    { name: 'DRYWALL', items: [
      ['Install & finish drywall — walls', 580, 'SF', 3.85, P],
      ['Install & finish drywall — ceiling', 375, 'SF', 3.85, P],
      ['Knockdown texture — per SF', 580, 'SF', 0.95, P],
      ['Drywall primer sealer — master suite', 955, 'SF', 0.42, P],
    ]},
    { name: 'CARPENTRY', items: [
      ['Base molding — 3.5-in, per LF', 95, 'LF', 3.25, P],
      ['Wire shelving — closet, per LF', 28, 'LF', 8.50, P],
    ]},
    { name: 'FLOORING', items: [
      ['Carpet cushion — 8-lb rebond, per SY', 42, 'SY', 6.50, P],
      ['Carpet — mid-grade residential, per SY', 42, 'SY', 28.50, P],
    ]},
    { name: 'PAINTING', items: [
      ['Wall paint — 2 coats', 580, 'SF', 1.55, P],
      ['Ceiling paint — 2 coats', 375, 'SF', 1.55, P],
      ['Base molding paint, per LF', 95, 'LF', 0.72, P],
    ]},
    { name: 'FIXTURES', items: [
      ['Interior door — pre-hung, hollow-core', 2, 'EA', 265.00, P],
      ['Window blinds — 1-in aluminum mini', 3, 'EA', 95.00, P],
    ]},
  ]},
  { name: 'SECOND BEDROOM', subcats: [
    { name: 'DEMO', items: [
      ['Soot cleaning — walls, per SF', 430, 'SF', 0.95, P],
      ['Remove damaged drywall — walls', 430, 'SF', 1.28, P],
      ['Tear out base molding, per LF', 78, 'LF', 0.58, P],
      ['Remove carpet and pad, per SY', 32, 'SY', 3.85, P],
      ['Ozone odor treatment — per session', 1, 'LS', 350.00, P],
    ]},
    { name: 'DRYWALL', items: [
      ['Install & finish drywall — walls', 430, 'SF', 3.85, P],
      ['Knockdown texture — per SF', 430, 'SF', 0.95, P],
      ['Drywall primer sealer — bedroom 2', 430, 'SF', 0.42, P],
    ]},
    { name: 'CARPENTRY', items: [
      ['Base molding — 3.5-in, per LF', 78, 'LF', 3.25, P],
      ['Wire shelving — closet, per LF', 10, 'LF', 8.50, P],
    ]},
    { name: 'FLOORING', items: [
      ['Carpet cushion — 8-lb rebond, per SY', 32, 'SY', 6.50, P],
      ['Carpet — mid-grade residential, per SY', 32, 'SY', 28.50, P],
    ]},
    { name: 'PAINTING', items: [
      ['Wall paint — 2 coats', 430, 'SF', 1.55, P],
      ['Base molding paint, per LF', 78, 'LF', 0.72, P],
    ]},
    { name: 'FIXTURES', items: [
      ['Smoke detector — replace', 1, 'EA', 65.00, P],
    ]},
  ]},
  { name: 'THIRD BEDROOM', subcats: [
    { name: 'DEMO', items: [
      ['Soot cleaning — walls, per SF', 380, 'SF', 0.95, P],
      ['Remove damaged drywall — walls', 380, 'SF', 1.28, P],
      ['Tear out base molding, per LF', 70, 'LF', 0.58, P],
      ['Remove carpet and pad, per SY', 28, 'SY', 3.85, P],
    ]},
    { name: 'DRYWALL', items: [
      ['Install & finish drywall — walls', 380, 'SF', 3.85, P],
      ['Install & finish drywall — ceiling', 270, 'SF', 3.85, P],
      ['Knockdown texture — per SF', 380, 'SF', 0.95, P],
      ['Drywall primer sealer — bedroom 3', 650, 'SF', 0.42, P],
    ]},
    { name: 'CARPENTRY', items: [
      ['Base molding — 3.5-in, per LF', 70, 'LF', 3.25, P],
    ]},
    { name: 'FLOORING', items: [
      ['Carpet — mid-grade residential, per SY', 28, 'SY', 28.50, P],
    ]},
    { name: 'PAINTING', items: [
      ['Wall paint — 2 coats', 380, 'SF', 1.55, P],
      ['Ceiling paint — 2 coats', 270, 'SF', 1.55, P],
      ['Base molding paint, per LF', 70, 'LF', 0.72, P],
    ]},
    { name: 'FIXTURES', items: [
      ['Interior door — pre-hung, hollow-core', 1, 'EA', 265.00, P],
      ['Window blind — 1-in aluminum mini', 2, 'EA', 95.00, P],
    ]},
  ]},
  { name: 'ATTACHED GARAGE', subcats: [
    { name: 'DEMO', items: [
      ['Soot cleaning — walls, per SF', 300, 'SF', 0.95, P],
      ['Remove damaged drywall — walls', 300, 'SF', 1.28, P],
      ['Remove damaged drywall — ceiling', 460, 'SF', 1.28, P],
      ['Ozone odor treatment — garage', 1, 'LS', 350.00, P],
      ['Emergency board-up — per SF', 100, 'SF', 2.85, P],
    ]},
    { name: 'DRYWALL', items: [
      ['Install & finish drywall — walls', 300, 'SF', 3.85, P],
      ['Install & finish drywall — ceiling', 460, 'SF', 3.85, P],
    ]},
    { name: 'EXTERIOR', items: [
      ['Garage door — 16x7 steel, replace', 1, 'EA', 1285.00, P],
      ['Garage door operator — replace', 1, 'EA', 485.00, P],
      ['Exterior paint — per SF', 320, 'SF', 1.25, P],
      ['Door weatherstrip — per LF', 20, 'LF', 3.50, P],
      ['Garage door weather seal — bottom sweep', 1, 'EA', 85.00, P],
    ]},
    { name: 'FLOORING', items: [
      ['Concrete floor sealer — per SF', 460, 'SF', 0.95, P],
      ['Concrete floor — etching & prep for sealer', 460, 'SF', 0.32, P],
    ]},
    { name: 'PAINTING', items: [
      ['Wall paint — 2 coats', 300, 'SF', 1.55, P],
      ['Ceiling paint — 2 coats', 460, 'SF', 1.55, P],
    ]},
  ]},
];

function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function wrap(text: string, max: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > max && cur) { lines.push(cur); cur = w; }
    else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

async function main() {
  // Count items
  let totalItems = 0;
  for (const z of zones) for (const sc of z.subcats) totalItems += sc.items.length;
  console.log(`Total items: ${totalItems}`);

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const W = 612, H = 792, M = 36;
  let page = pdf.addPage([W, H]);
  let y = H - M;
  let pageNum = 1;

  const drawHeader = () => {
    page.drawText('Pinnacle West Mutual Insurance', { x: M, y, size: 11, font: bold, color: rgb(0.05, 0.12, 0.25) });
    y -= 13;
    page.drawText('Claims Division', { x: M, y, size: 8, font, color: rgb(0.3, 0.3, 0.3) });
    y -= 11;
    page.drawText('PO Box 82200  Scottsdale, AZ 85252-2200', { x: M, y, size: 8, font, color: rgb(0.3, 0.3, 0.3) });
    y -= 14;
    page.drawText(`CLAIM: PWM-30817-FNL`, { x: M, y, size: 8, font: bold });
    page.drawText(`Page ${pageNum}`, { x: W - M - 40, y, size: 8, font });
    y -= 11;
    page.drawText('INSURED: Marcus & Leah Tran', { x: M, y, size: 8, font });
    y -= 11;
    page.drawText('PROPERTY: 12084 W. Cactus Wren Ln, Phoenix, AZ 85027', { x: M, y, size: 8, font });
    y -= 11;
    page.drawText('Estimate: PWM-30817-FNL    Date: 3/10/2025    Examiner: S. Martinez, AIC', { x: M, y, size: 8, font });
    y -= 16;
  };

  const drawFooter = () => {
    page.drawText('Pinnacle West Mutual Insurance  ·  Claims Division  ·  1-800-555-0177', { x: M, y: 28, size: 7, font, color: rgb(0.4, 0.4, 0.4) });
    page.drawText('File: PWM-30817-FNL  ·  Examiner: S. Martinez, AIC  ·  Kitchen Fire Damage', { x: M, y: 18, size: 7, font, color: rgb(0.4, 0.4, 0.4) });
    page.drawText('ADJUSTER COPY — FOR INTERNAL USE', { x: W - M - 140, y: 18, size: 7, font: bold, color: rgb(0.4, 0.4, 0.4) });
  };

  const drawColHeaders = () => {
    const cy = y;
    page.drawLine({ start: { x: M, y: cy + 2 }, end: { x: W - M, y: cy + 2 }, thickness: 0.5, color: rgb(0.5, 0.5, 0.5) });
    page.drawText('#', { x: M + 2, y: cy - 8, size: 7, font: bold });
    page.drawText('DESCRIPTION', { x: M + 22, y: cy - 8, size: 7, font: bold });
    page.drawText('U', { x: 290, y: cy - 8, size: 7, font: bold });
    page.drawText('QTY', { x: 310, y: cy - 8, size: 7, font: bold });
    page.drawText('RATE', { x: 355, y: cy - 8, size: 7, font: bold });
    page.drawText('O&P', { x: 405, y: cy - 8, size: 7, font: bold });
    page.drawText('RCV', { x: 458, y: cy - 8, size: 7, font: bold });
    page.drawText('DEP.', { x: 500, y: cy - 8, size: 7, font: bold });
    page.drawText('ACV', { x: 535, y: cy - 8, size: 7, font: bold });
    y -= 14;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: rgb(0.5, 0.5, 0.5) });
    y -= 4;
  };

  const newPage = () => {
    drawFooter();
    pageNum++;
    page = pdf.addPage([W, H]);
    y = H - M;
    drawHeader();
    drawColHeaders();
  };

  const ensure = (space: number) => { if (y - space < 50) newPage(); };

  drawHeader();
  drawColHeaders();

  let itemNo = 1;
  let grandTotal = 0;

  for (const zone of zones) {
    ensure(30);
    // Zone header
    page.drawRectangle({ x: M, y: y - 2, width: W - M * 2, height: 14, color: rgb(0.9, 0.93, 0.97) });
    page.drawText(`>> ${zone.name}`, { x: M + 4, y: y, size: 8, font: bold, color: rgb(0.1, 0.15, 0.3) });
    y -= 18;

    for (const sc of zone.subcats) {
      ensure(24);
      // Sub-category header
      page.drawText(sc.name, { x: M + 4, y, size: 7, font: bold, color: rgb(0.2, 0.2, 0.2) });
      y -= 12;

      for (const item of sc.items) {
        const [desc, qty, unit, rate, opF] = item;
        const extd = qty * rate;
        const op = +(extd * opF).toFixed(2);
        const rcv = +(extd + op).toFixed(2);
        grandTotal += rcv;

        const lines = wrap(desc, 38);
        const rowH = Math.max(10, lines.length * 9 + 2);
        ensure(rowH + 2);

        const ry = y;
        page.drawText(String(itemNo), { x: M + 2, y: ry, size: 7, font });
        for (let i = 0; i < lines.length; i++) {
          page.drawText(lines[i], { x: M + 22, y: ry - i * 9, size: 7, font });
        }
        page.drawText(unit, { x: 290, y: ry, size: 7, font });
        page.drawText(fmt(qty), { x: 310, y: ry, size: 7, font });
        page.drawText(fmt(rate), { x: 355, y: ry, size: 7, font });
        page.drawText(fmt(op), { x: 405, y: ry, size: 7, font });
        page.drawText(fmt(rcv), { x: 452, y: ry, size: 7, font });
        page.drawText('—', { x: 507, y: ry, size: 7, font });
        page.drawText(fmt(rcv), { x: 528, y: ry, size: 7, font });

        itemNo++;
        y -= rowH;
      }
      y -= 4;
    }
    y -= 6;
  }

  // Grand total
  ensure(30);
  page.drawLine({ start: { x: M, y: y + 4 }, end: { x: W - M, y: y + 4 }, thickness: 1, color: rgb(0.1, 0.1, 0.1) });
  page.drawText(`RCV TOTAL`, { x: M + 4, y, size: 9, font: bold });
  page.drawText(fmt(grandTotal), { x: 452, y, size: 9, font: bold });
  y -= 14;
  page.drawText('LESS DEPRECIATION', { x: M + 4, y, size: 8, font });
  page.drawText('(0.00)', { x: 452, y, size: 8, font });
  y -= 12;
  page.drawText('ACV TOTAL', { x: M + 4, y, size: 9, font: bold });
  page.drawText(fmt(grandTotal), { x: 452, y, size: 9, font: bold });

  drawFooter();

  const bytes = await pdf.save();
  fs.writeFileSync(OUT, bytes);
  console.log(`Written: ${OUT}`);
  console.log(`Items: ${itemNo - 1}, RCV Total: $${fmt(grandTotal)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
