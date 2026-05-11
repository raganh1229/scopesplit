/**
 * gen-v4-adjuster.ts — Generates Adjuster_V4.pdf
 * Format C style: COURIER monospace + dark AMBER accent + ASCII-style separators
 * "data-terminal printout" feel
 * Usage: npx tsx scripts/gen-v4-adjuster.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const OUT = path.resolve(__dirname, '../../../PDFS/Generated Sets/Verified Sets/V4/Adjuster_V4.pdf');

type Item = [string, number, string, number, number]; // [desc, qty, unit, rate, opFactor]
type SubCat = { name: string; items: Item[] };
type Zone = { name: string; subcats: SubCat[] };

const P = 0.20;
const N = 0;

const zones: Zone[] = [
  { name: '[PROJECT GENERAL CONDITIONS]', subcats: [
    { name: 'GENERAL', items: [
      ['30 cy debris dumpster — per pull', 3, 'EA', 550.00, P],
      ['Fire debris removal — per truck load', 10, 'LD', 125.00, P],
      ['Municipal permit — structural restoration', 1, 'EA', 850.00, N],
      ['Municipal permit — mechanical & electrical', 1, 'EA', 485.00, N],
      ['Post-construction cleaning — residential, per SF', 2880, 'SF', 0.32, P],
      ['Site fencing panels — rental per month', 3, 'MO', 342.00, P],
      ['Portable restroom — rental per month', 3, 'MO', 222.00, P],
      ['Safety barricade & signage package', 1, 'LS', 420.00, P],
      ['Air quality sampling — post-fire', 1, 'EA', 582.00, P],
      ['Emergency board-up — openings, per SF', 320, 'SF', 3.42, P],
      ['General helper labor — hourly', 72, 'HR', 34.50, P],
      ['Construction supervision — per hour', 45, 'HR', 72.00, P],
      ['Fire investigator report fee', 1, 'EA', 780.00, P],
    ]},
  ]},
  { name: '[ROOF SYSTEM]', subcats: [
    { name: 'ROOFING', items: [
      ['Tear-off fire/heat damaged roof covering, per SQ', 28, 'SQ', 125.00, P],
      ['Roof sheathing — 7/16 OSB, per SF', 2688, 'SF', 1.55, P],
      ['Type X fire-board underlayment, per SF', 2688, 'SF', 0.91, P],
      ['Underlayment — synthetic, per SQ', 28, 'SQ', 46.29, P],
      ['30-yr dimensional shingle — per SQ', 28, 'SQ', 293.14, P],
      ['Hip & ridge cap — per LF', 90, 'LF', 5.25, P],
      ['Eave ice/water barrier, per LF', 135, 'LF', 3.17, P],
      ['Metal drip edge — eaves, per LF', 135, 'LF', 2.06, P],
      ['Plumbing stack flashing — replace', 4, 'EA', 58.50, P],
      ['Step & counter chimney flashing', 1, 'EA', 342.00, P],
      ['Blown-in attic insulation — R-38, per SF', 2688, 'SF', 2.41, P],
      ['Ridge & soffit ventilation, per LF', 128, 'LF', 4.33, P],
      ['Attic decking — plywood walkway boards, per SF', 55, 'SF', 7.80, P],
    ]},
    { name: 'EXTERIOR', items: [
      ['PVC fascia board — 1×6, per LF', 150, 'LF', 5.25, P],
      ['5-in aluminum K-style gutters, per LF', 150, 'LF', 5.85, P],
      ['Vented aluminum soffit — per SF', 222, 'SF', 3.85, P],
      ['3×4 aluminum downspouts, per LF', 76, 'LF', 4.29, P],
    ]},
  ]},
  { name: '[LIVING ROOM]', subcats: [
    { name: 'DEMO', items: [
      ['Soot cleaning — ceiling, per SF', 504, 'SF', 0.95, P],
      ['Soot cleaning — walls, per SF', 816, 'SF', 0.95, P],
      ['Remove damaged drywall — ceiling', 504, 'SF', 1.28, P],
      ['Remove damaged drywall — walls', 816, 'SF', 1.28, P],
      ['Tear out base molding, per LF', 132, 'LF', 0.58, P],
      ['Remove hardwood flooring, per SF', 504, 'SF', 2.50, P],
      ['Ozone odor treatment — per session', 2, 'LS', 540.00, P],
    ]},
    { name: 'DRYWALL', items: [
      ['Install & finish drywall — ceiling', 504, 'SF', 3.85, P],
      ['Install & finish drywall — walls', 816, 'SF', 3.85, P],
      ['Knockdown texture — per SF', 1320, 'SF', 0.95, P],
      ['Drywall primer sealer — ceiling & walls', 1320, 'SF', 0.42, P],
    ]},
    { name: 'PAINTING', items: [
      ['Ceiling paint — 2 coats', 504, 'SF', 1.55, P],
      ['Wall paint — 2 coats', 816, 'SF', 1.55, P],
    ]},
    { name: 'CARPENTRY', items: [
      ['Base molding — 3.5-in, per LF', 132, 'LF', 3.25, P],
      ['Base molding paint, per LF', 132, 'LF', 0.72, P],
      ['Window casing & stool — per LF', 48, 'LF', 4.50, P],
    ]},
    { name: 'FLOORING', items: [
      ['Hardwood flooring — 3/4-in oak, per SF', 504, 'SF', 8.50, P],
    ]},
  ]},
  { name: '[KITCHEN]', subcats: [
    { name: 'DEMO', items: [
      ['Soot cleaning — ceiling, per SF', 252, 'SF', 0.95, P],
      ['Soot cleaning — walls, per SF', 576, 'SF', 0.95, P],
      ['Remove damaged drywall — ceiling', 252, 'SF', 1.28, P],
      ['Remove damaged drywall — walls', 576, 'SF', 1.28, P],
      ['Remove LVP flooring', 252, 'SF', 2.10, P],
    ]},
    { name: 'DRYWALL', items: [
      ['Hang, tape & finish drywall — ceiling', 252, 'SF', 3.85, P],
      ['Hang, tape & finish drywall — walls', 576, 'SF', 3.85, P],
      ['Drywall primer sealer — kitchen', 828, 'SF', 0.42, P],
    ]},
    { name: 'PAINTING', items: [
      ['Ceiling paint — 2 coats', 252, 'SF', 1.55, P],
      ['Wall paint — 2 coats', 576, 'SF', 1.55, P],
    ]},
    { name: 'FLOORING', items: [
      ['LVP flooring — furnished & installed', 252, 'SF', 7.25, P],
    ]},
    { name: 'FIXTURES', items: [
      ['Smoke detector — replace', 2, 'EA', 78.00, P],
      ['Kitchen sink — stainless double basin', 1, 'EA', 582.00, P],
      ['Kitchen faucet — pull-down spray', 1, 'EA', 342.00, P],
    ]},
    { name: 'CABINETS', items: [
      ['Cabinet hardware replacement set', 1, 'LS', 342.00, P],
      ['Ceramic tile backsplash — 4×4, per SF', 24, 'SF', 36.00, P],
      ['Base cabinets — builder grade, per LF', 18, 'LF', 258.00, P],
      ['Upper wall cabinets — builder grade, per LF', 14, 'LF', 234.00, P],
      ['Countertop — laminate, per SF', 36, 'SF', 93.60, P],
    ]},
  ]},
  { name: '[DINING AREA]', subcats: [
    { name: 'DEMO', items: [
      ['Soot cleaning — walls, per SF', 624, 'SF', 0.95, P],
      ['Remove damaged drywall — walls', 624, 'SF', 1.28, P],
      ['Tear out base molding, per LF', 108, 'LF', 0.58, P],
      ['Remove hardwood flooring, per SF', 390, 'SF', 2.50, P],
      ['Ozone odor treatment — per session', 1, 'LS', 540.00, P],
    ]},
    { name: 'DRYWALL', items: [
      ['Install & finish drywall — walls', 624, 'SF', 3.85, P],
      ['Install & finish drywall — ceiling', 390, 'SF', 3.85, P],
      ['Knockdown texture — per SF', 624, 'SF', 0.95, P],
      ['Drywall primer sealer — dining room', 1014, 'SF', 0.42, P],
    ]},
    { name: 'PAINTING', items: [
      ['Wall paint — 2 coats', 624, 'SF', 1.55, P],
      ['Ceiling paint — 2 coats', 390, 'SF', 1.55, P],
    ]},
    { name: 'CARPENTRY', items: [
      ['Base molding — 3.5-in, per LF', 108, 'LF', 3.25, P],
      ['Base molding paint, per LF', 108, 'LF', 0.72, P],
      ['Window casing trim — per LF', 48, 'LF', 4.50, P],
    ]},
    { name: 'FLOORING', items: [
      ['Hardwood flooring — 3/4-in oak, per SF', 390, 'SF', 8.50, P],
    ]},
    { name: 'FIXTURES', items: [
      ['Smoke detector — replace', 1, 'EA', 78.00, P],
    ]},
  ]},
  { name: '[PRIMARY BEDROOM SUITE]', subcats: [
    { name: 'DEMO', items: [
      ['Soot cleaning — walls, per SF', 696, 'SF', 0.95, P],
      ['Remove damaged drywall — walls', 696, 'SF', 1.28, P],
      ['Tear out base molding, per LF', 114, 'LF', 0.58, P],
      ['Remove carpet and pad, per SY', 54, 'SY', 3.59, P],
    ]},
    { name: 'DRYWALL', items: [
      ['Install & finish drywall — walls', 696, 'SF', 3.85, P],
      ['Install & finish drywall — ceiling', 450, 'SF', 3.85, P],
      ['Knockdown texture — per SF', 696, 'SF', 0.95, P],
      ['Drywall primer sealer — master suite', 1146, 'SF', 0.42, P],
    ]},
    { name: 'PAINTING', items: [
      ['Wall paint — 2 coats', 696, 'SF', 1.55, P],
      ['Ceiling paint — 2 coats', 450, 'SF', 1.55, P],
    ]},
    { name: 'CARPENTRY', items: [
      ['Base molding — 3.5-in, per LF', 114, 'LF', 3.25, P],
      ['Base molding paint, per LF', 114, 'LF', 0.72, P],
      ['Wire shelving — closet, per LF', 28, 'LF', 10.20, P],
    ]},
    { name: 'FLOORING', items: [
      ['Carpet cushion — 8-lb rebond, per SY', 54, 'SY', 6.07, P],
      ['Carpet — mid-grade residential, per SY', 54, 'SY', 26.60, P],
    ]},
    { name: 'FIXTURES', items: [
      ['Interior door — pre-hung, hollow-core', 2, 'EA', 318.00, P],
      ['Window blinds — 1-in aluminum mini', 3, 'EA', 114.00, P],
    ]},
  ]},
  { name: '[SECOND BEDROOM]', subcats: [
    { name: 'DEMO', items: [
      ['Soot cleaning — walls, per SF', 516, 'SF', 0.95, P],
      ['Remove damaged drywall — walls', 516, 'SF', 1.28, P],
      ['Tear out base molding, per LF', 94, 'LF', 0.58, P],
      ['Remove carpet and pad, per SY', 41, 'SY', 3.59, P],
      ['Ozone odor treatment — per session', 1, 'LS', 420.00, P],
    ]},
    { name: 'DRYWALL', items: [
      ['Install & finish drywall — walls', 516, 'SF', 3.85, P],
      ['Knockdown texture — per SF', 516, 'SF', 0.95, P],
      ['Drywall primer sealer — bedroom 2', 516, 'SF', 0.42, P],
    ]},
    { name: 'PAINTING', items: [
      ['Wall paint — 2 coats', 516, 'SF', 1.55, P],
    ]},
    { name: 'CARPENTRY', items: [
      ['Base molding — 3.5-in, per LF', 94, 'LF', 3.25, P],
      ['Base molding paint, per LF', 94, 'LF', 0.72, P],
      ['Wire shelving — closet, per LF', 12, 'LF', 8.50, P],
    ]},
    { name: 'FLOORING', items: [
      ['Carpet cushion — 8-lb rebond, per SY', 41, 'SY', 6.07, P],
      ['Carpet — mid-grade residential, per SY', 41, 'SY', 26.60, P],
    ]},
    { name: 'FIXTURES', items: [
      ['Smoke detector — replace', 1, 'EA', 78.00, P],
    ]},
  ]},
  { name: '[THIRD BEDROOM]', subcats: [
    { name: 'DEMO', items: [
      ['Soot cleaning — walls, per SF', 456, 'SF', 0.95, P],
      ['Remove damaged drywall — walls', 456, 'SF', 1.28, P],
      ['Tear out base molding, per LF', 84, 'LF', 0.58, P],
      ['Remove carpet and pad, per SY', 36, 'SY', 3.59, P],
    ]},
    { name: 'DRYWALL', items: [
      ['Install & finish drywall — walls', 456, 'SF', 3.85, P],
      ['Install & finish drywall — ceiling', 324, 'SF', 3.85, P],
      ['Knockdown texture — per SF', 456, 'SF', 0.95, P],
      ['Drywall primer sealer — bedroom 3', 780, 'SF', 0.42, P],
    ]},
    { name: 'PAINTING', items: [
      ['Wall paint — 2 coats', 456, 'SF', 1.55, P],
      ['Ceiling paint — 2 coats', 324, 'SF', 1.55, P],
    ]},
    { name: 'CARPENTRY', items: [
      ['Base molding — 3.5-in, per LF', 84, 'LF', 3.25, P],
      ['Base molding paint, per LF', 84, 'LF', 0.72, P],
    ]},
    { name: 'FLOORING', items: [
      ['Carpet — mid-grade residential, per SY', 36, 'SY', 26.60, P],
    ]},
    { name: 'FIXTURES', items: [
      ['Interior door — pre-hung, hollow-core', 1, 'EA', 318.00, P],
      ['Window blinds — 1-in aluminum mini', 2, 'EA', 114.00, P],
    ]},
  ]},
  { name: '[ATTACHED GARAGE]', subcats: [
    { name: 'DEMO', items: [
      ['Soot cleaning — walls, per SF', 360, 'SF', 0.95, P],
      ['Remove damaged drywall — walls', 360, 'SF', 1.28, P],
      ['Remove damaged drywall — ceiling', 552, 'SF', 1.28, P],
      ['Ozone odor treatment — garage', 1, 'LS', 420.00, P],
    ]},
    { name: 'DRYWALL', items: [
      ['Install & finish drywall — walls', 360, 'SF', 3.85, P],
      ['Install & finish drywall — ceiling', 552, 'SF', 3.85, P],
    ]},
    { name: 'PAINTING', items: [
      ['Wall paint — 2 coats', 360, 'SF', 1.55, P],
      ['Ceiling paint — 2 coats', 552, 'SF', 1.55, P],
    ]},
    { name: 'FLOORING', items: [
      ['Concrete floor sealer — per SF', 552, 'SF', 0.95, P],
      ['Concrete floor — etching & prep for sealer', 552, 'SF', 0.32, P],
    ]},
    { name: 'EXTERIOR', items: [
      ['Garage door — 16×7 steel, replace', 1, 'EA', 1542.00, P],
      ['Garage door operator — replace', 1, 'EA', 582.00, P],
      ['Exterior paint — per SF', 160, 'SF', 3.00, P],
      ['Door weatherstrip — per LF', 42, 'LF', 2.00, P],
      ['Garage door weather seal — bottom sweep', 1, 'EA', 102.00, P],
    ]},
    { name: 'GENERAL', items: [
      ['Emergency board-up — per SF', 120, 'SF', 3.42, P],
    ]},
  ]},
];

async function main() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Courier);
  const fontBold = await doc.embedFont(StandardFonts.CourierBold);

  let itemNum = 1;
  const margin = 50;
  const pageWidth = 612;
  const pageHeight = 792;

  for (const zone of zones) {
    const page = doc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;

    page.drawText('>>> PACIFIC MUTUAL CLAIMS SERVICES <<<', { x: margin, y, size: 11, font: fontBold, color: rgb(0.8, 0.5, 0) });
    y -= 18;
    page.drawText('FIRE DAMAGE CLAIM — PHOENIX AZ', { x: margin, y, size: 9, font });
    y -= 14;
    page.drawText('CLAIM #PMC-2025-7841 | ISSUED: 03/22/2025', { x: margin, y, size: 8, font });
    y -= 25;

    page.drawText(zone.name, { x: margin, y, size: 10, font: fontBold, color: rgb(0.8, 0.5, 0) });
    y -= 20;

    const colX = [margin, 310, 370, 430, 490];
    page.drawText('DESCRIPTION', { x: colX[0], y, size: 7, font: fontBold });
    page.drawText('QTY', { x: colX[1], y, size: 7, font: fontBold });
    page.drawText('UNIT', { x: colX[2], y, size: 7, font: fontBold });
    page.drawText('RATE', { x: colX[3], y, size: 7, font: fontBold });
    page.drawText('RCV', { x: colX[4], y, size: 7, font: fontBold });
    y -= 14;

    for (const subcat of zone.subcats) {
      if (y < 100) {
        const newPage = doc.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
        newPage.drawText(`${zone.name} >>> CONTINUED`, { x: margin, y, size: 9, font: fontBold });
        y -= 22;
      }

      page.drawText(`+-- ${subcat.name}`, { x: margin, y, size: 8, font: fontBold, color: rgb(0.5, 0.5, 0.5) });
      y -= 12;

      for (const [desc, qty, unit, rate, opFactor] of subcat.items) {
        if (y < 80) break;
        const total = qty * rate * (1 + opFactor);
        page.drawText(`${itemNum}. ${desc}`, { x: colX[0], y, size: 7, font });
        page.drawText(qty.toFixed(2), { x: colX[1], y, size: 7, font });
        page.drawText(unit, { x: colX[2], y, size: 7, font });
        page.drawText(`$${rate.toFixed(2)}`, { x: colX[3], y, size: 7, font });
        page.drawText(`$${total.toFixed(2)}`, { x: colX[4], y, size: 7, font });
        y -= 11;
        itemNum++;
      }
      y -= 6;
    }
  }

  const pdfBytes = await doc.save();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, pdfBytes);
  console.log(`✅ Adjuster_V4.pdf written to ${OUT}`);
}

main().catch(console.error);
