/**
 * gen-v4-contractor.ts — Generates Contractor_V4.pdf
 * Format B style: Empire-Estimators full Xactimate format
 * Numbered items, sub-categories, room dimension blocks
 * Columns: REMOVE / REPLACE / TAX / O&P / TOTAL
 * Usage: npx tsx scripts/gen-v4-contractor.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const OUT = path.resolve(__dirname, '../../../PDFS/Generated Sets/Verified Sets/V4/Contractor_V4.pdf');

type Item = [string, number, string, number, number]; // [desc, qty, unit, rate, opFactor]
type SubCat = { name: string; items: Item[] };
type Zone = { name: string; subcats: SubCat[] };

const P = 0.20; // 20% O&P
const N = 0;    // no O&P

const zones: Zone[] = [
  { name: 'GENERAL CONDITIONS', subcats: [
    { name: 'GENERAL', items: [
      ['Dumpster — 30 cubic yard, per pull', 3, 'EA', 550.00, P],
      ['Fire debris haul-off — truck load', 10, 'LD', 125.00, P],
      ['Building permit — structural repair', 1, 'EA', 850.00, N],
      ['Building permit — HVAC & electrical', 1, 'EA', 485.00, N],
      ['Final post-construction cleaning, per SF', 2880, 'SF', 0.32, P],
      ['Temporary fence — rental per month', 3, 'MO', 342.00, P],
      ['Temporary toilet — rental per month', 3, 'MO', 222.00, P],
      ['Site safety signage & barricades', 1, 'LS', 420.00, P],
      ['Air quality / industrial hygienist test', 1, 'EA', 582.00, P],
      ['Board up — structural openings, per SF', 320, 'SF', 3.42, P],
      ['General laborer — per hour', 96, 'HR', 34.50, P],
      ['Project supervision — per hour', 60, 'HR', 72.00, P],
      ['Temporary housing allowance — per month', 3, 'MO', 2400.00, P],
      ['Contents pack-out & storage — per month', 2, 'MO', 935.00, P],
    ]},
  ]},
  { name: 'EXTERIOR & ROOF', subcats: [
    { name: 'ROOFING', items: [
      ['Remove fire-damaged roofing — per SQ', 28, 'SQ', 125.00, P],
      ['Roof decking — OSB 7/16-in, replace', 2688, 'SF', 1.55, P],
      ['Fire-stop code board — per SF', 2688, 'SF', 0.91, P],
      ['Synthetic roofing underlayment, per SQ', 28, 'SQ', 46.29, P],
      ['30-yr architectural shingles — install, per SQ', 28, 'SQ', 293.14, P],
      ['Ridge cap shingles, per LF', 90, 'LF', 5.25, P],
      ['Ice & water shield — eave course, per LF', 135, 'LF', 3.17, P],
      ['Drip edge — eave metal, per LF', 135, 'LF', 2.06, P],
      ['Pipe flashing — lead boot, replace', 4, 'EA', 58.50, P],
      ['Chimney flashing — step & counter', 1, 'EA', 342.00, P],
      ['Attic insulation — blown R-38, per SF', 2688, 'SF', 2.41, P],
      ['Attic ventilation — soffit & ridge, per LF', 128, 'LF', 4.33, P],
      ['Box roof vents — remove & replace', 2, 'EA', 204.00, P],
      ['Solar attic fan — replace', 1, 'EA', 582.00, P],
    ]},
    { name: 'EXTERIOR', items: [
      ['Fascia board — 1×6 PVC, per LF', 150, 'LF', 5.25, P],
      ['Gutters — 5-in aluminum K-style, per LF', 150, 'LF', 5.85, P],
      ['Soffit — aluminum vented, per SF', 222, 'SF', 4.85, P],
      ['Downspouts — 3×4 aluminum, per LF', 76, 'LF', 5.56, P],
    ]},
  ]},
  { name: 'LIVING ROOM', subcats: [
    { name: 'DEMO', items: [
      ['Soot/smoke cleaning — ceiling, per SF', 504, 'SF', 0.95, P],
      ['Soot/smoke cleaning — walls, per SF', 816, 'SF', 0.95, P],
      ['Tear out fire-damaged drywall — ceiling', 504, 'SF', 1.28, P],
      ['Tear out fire-damaged drywall — walls', 816, 'SF', 1.28, P],
      ['Remove base molding, per LF', 132, 'LF', 0.58, P],
      ['Tear out hardwood flooring, per SF', 504, 'SF', 2.50, P],
      ['Smoke/odor treatment — ozone clean, per session', 3, 'LS', 540.00, P],
    ]},
    { name: 'DRYWALL', items: [
      ['Drywall — ceiling, 1/2-in, hang, tape & finish', 504, 'SF', 3.85, P],
      ['Drywall — walls, 1/2-in, hang, tape & finish', 816, 'SF', 3.85, P],
      ['Texture — knockdown, walls & ceiling, per SF', 1320, 'SF', 0.95, P],
    ]},
    { name: 'PAINTING', items: [
      ['Paint ceiling — 2 coats, latex flat', 504, 'SF', 1.55, P],
      ['Paint walls — 2 coats, latex eggshell', 816, 'SF', 1.55, P],
    ]},
    { name: 'CARPENTRY', items: [
      ['Base molding — 3.5-in colonial, per LF', 132, 'LF', 3.25, P],
      ['Paint base molding, per LF', 132, 'LF', 0.72, P],
      ['Window trim — replace, per LF', 68, 'LF', 5.40, P],
      ['Crown molding — 3.25-in, per LF', 132, 'LF', 3.75, P],
      ['Built-in bookcase — standard, per LF', 18, 'LF', 139.33, P],
    ]},
    { name: 'FLOORING', items: [
      ['Hardwood flooring — 3/4-in red oak, install', 504, 'SF', 8.50, P],
    ]},
  ]},
  { name: 'KITCHEN', subcats: [
    { name: 'DEMO', items: [
      ['Soot cleaning — ceiling, per SF', 252, 'SF', 0.95, P],
      ['Soot cleaning — walls, per SF', 576, 'SF', 0.95, P],
      ['Tear out drywall — ceiling', 252, 'SF', 1.28, P],
      ['Tear out drywall — walls', 576, 'SF', 1.28, P],
      ['Tear out LVP flooring', 252, 'SF', 2.10, P],
    ]},
    { name: 'DRYWALL', items: [
      ['Drywall — ceiling, install & finish', 252, 'SF', 3.85, P],
      ['Drywall — walls, install & finish', 576, 'SF', 3.85, P],
    ]},
    { name: 'PAINTING', items: [
      ['Paint ceiling — 2 coats', 252, 'SF', 1.55, P],
      ['Paint walls — 2 coats', 576, 'SF', 1.55, P],
    ]},
    { name: 'FLOORING', items: [
      ['LVP flooring — install, glue-down', 252, 'SF', 7.25, P],
    ]},
    { name: 'FIXTURES', items: [
      ['Smoke detector — replace', 2, 'EA', 78.00, P],
      ['Kitchen sink — SS double basin, replace', 1, 'EA', 582.00, P],
      ['Kitchen faucet — pull-down, replace', 1, 'EA', 342.00, P],
      ['Kitchen range — 30-in gas free-standing, replace', 1, 'EA', 1542.00, P],
      ['Refrigerator — 25-cu-ft, replace', 1, 'EA', 1782.00, P],
    ]},
    { name: 'CABINETS', items: [
      ['Cabinet hardware — full set, replace', 1, 'LS', 342.00, P],
      ['Tile backsplash — 4×4 ceramic, per SF', 24, 'SF', 36.00, P],
      ['Kitchen base cabinets — replace, per LF', 18, 'LF', 354.00, P],
      ['Kitchen upper cabinets — replace, per LF', 14, 'LF', 318.00, P],
      ['Kitchen countertop — quartz, per SF', 36, 'SF', 150.00, P],
    ]},
  ]},
  { name: 'DINING ROOM', subcats: [
    { name: 'DEMO', items: [
      ['Soot/smoke cleaning — walls, per SF', 624, 'SF', 0.95, P],
      ['Tear out drywall — walls', 624, 'SF', 1.28, P],
      ['Remove base molding, per LF', 108, 'LF', 0.58, P],
      ['Tear out hardwood flooring, per SF', 390, 'SF', 2.50, P],
      ['Ozone/odor treatment — per session', 2, 'LS', 540.00, P],
    ]},
    { name: 'DRYWALL', items: [
      ['Drywall — walls, hang, tape & finish', 624, 'SF', 3.85, P],
      ['Drywall — ceiling, hang, tape & finish', 390, 'SF', 3.85, P],
      ['Texture walls — knockdown, per SF', 624, 'SF', 0.95, P],
    ]},
    { name: 'PAINTING', items: [
      ['Paint walls — 2 coats', 624, 'SF', 1.55, P],
      ['Paint ceiling — 2 coats', 390, 'SF', 1.55, P],
    ]},
    { name: 'CARPENTRY', items: [
      ['Base molding — 3.5-in colonial, per LF', 108, 'LF', 3.25, P],
      ['Paint base molding, per LF', 108, 'LF', 0.72, P],
      ['Window trim — replace, per LF', 48, 'LF', 4.50, P],
    ]},
    { name: 'FLOORING', items: [
      ['Hardwood flooring — 3/4-in red oak, install', 390, 'SF', 8.50, P],
    ]},
    { name: 'FIXTURES', items: [
      ['Smoke detector — replace', 2, 'EA', 78.00, P],
      ['Chandelier / dining light fixture — replace', 1, 'EA', 582.00, P],
    ]},
  ]},
  { name: 'MASTER BEDROOM', subcats: [
    { name: 'DEMO', items: [
      ['Soot/smoke cleaning — walls, per SF', 696, 'SF', 0.95, P],
      ['Tear out drywall — walls', 696, 'SF', 1.28, P],
      ['Remove base molding, per LF', 114, 'LF', 0.58, P],
      ['Tear out carpet & pad, per SY', 54, 'SY', 3.59, P],
    ]},
    { name: 'DRYWALL', items: [
      ['Drywall — walls, hang, tape & finish', 696, 'SF', 3.85, P],
      ['Drywall — ceiling, hang, tape & finish', 450, 'SF', 3.85, P],
      ['Texture walls & ceiling — knockdown', 696, 'SF', 0.95, P],
    ]},
    { name: 'PAINTING', items: [
      ['Paint walls — 2 coats', 696, 'SF', 1.55, P],
      ['Paint ceiling — 2 coats', 450, 'SF', 1.55, P],
    ]},
    { name: 'CARPENTRY', items: [
      ['Base molding — 3.5-in colonial, per LF', 114, 'LF', 3.25, P],
      ['Paint base molding, per LF', 114, 'LF', 0.72, P],
      ['Closet wire shelving — ventilated, per LF', 28, 'LF', 10.20, P],
      ['Walk-in closet organizer system', 1, 'LS', 2220.00, P],
    ]},
    { name: 'FLOORING', items: [
      ['Carpet pad — 8-lb rebond, per SY', 54, 'SY', 6.07, P],
      ['Carpet — medium grade, per SY', 54, 'SY', 26.60, P],
    ]},
    { name: 'FIXTURES', items: [
      ['Interior door — pre-hung, solid wood', 2, 'EA', 462.00, P],
      ['Ceiling fan — standard, 52-in, replace', 1, 'EA', 462.00, P],
      ['Window blinds — 2-in faux wood', 3, 'EA', 198.00, P],
    ]},
  ]},
  { name: 'BEDROOM 2', subcats: [
    { name: 'DEMO', items: [
      ['Soot/smoke cleaning — walls, per SF', 516, 'SF', 0.95, P],
      ['Tear out drywall — walls', 516, 'SF', 1.28, P],
      ['Remove base molding, per LF', 94, 'LF', 0.58, P],
      ['Tear out carpet & pad, per SY', 41, 'SY', 3.59, P],
      ['Ozone treatment — bedroom, per session', 2, 'LS', 420.00, P],
    ]},
    { name: 'DRYWALL', items: [
      ['Drywall — walls, hang, tape & finish', 516, 'SF', 3.85, P],
      ['Texture walls — knockdown, per SF', 516, 'SF', 0.95, P],
    ]},
    { name: 'PAINTING', items: [
      ['Paint walls — 2 coats', 516, 'SF', 1.55, P],
    ]},
    { name: 'CARPENTRY', items: [
      ['Base molding — 3.5-in colonial, per LF', 94, 'LF', 3.25, P],
      ['Paint base molding, per LF', 94, 'LF', 0.72, P],
      ['Closet wire shelving — per LF', 18, 'LF', 9.07, P],
    ]},
    { name: 'FLOORING', items: [
      ['Carpet pad — 8-lb rebond, per SY', 41, 'SY', 6.07, P],
      ['Carpet — medium grade, per SY', 41, 'SY', 26.60, P],
    ]},
    { name: 'FIXTURES', items: [
      ['Smoke detector — replace', 1, 'EA', 78.00, P],
      ['Ceiling fan — standard, 52-in, replace', 1, 'EA', 462.00, P],
      ['Window blind — 2-in faux wood, replace', 1, 'EA', 198.00, P],
    ]},
  ]},
  { name: 'BEDROOM 3', subcats: [
    { name: 'DEMO', items: [
      ['Soot/smoke cleaning — walls, per SF', 456, 'SF', 0.95, P],
      ['Tear out drywall — walls', 456, 'SF', 1.28, P],
      ['Remove base molding, per LF', 84, 'LF', 0.58, P],
      ['Tear out carpet & pad, per SY', 36, 'SY', 3.59, P],
    ]},
    { name: 'DRYWALL', items: [
      ['Drywall — walls, hang, tape & finish', 456, 'SF', 3.85, P],
      ['Drywall — ceiling, hang, tape & finish', 324, 'SF', 3.85, P],
      ['Texture walls — knockdown, per SF', 456, 'SF', 0.95, P],
    ]},
    { name: 'PAINTING', items: [
      ['Paint walls — 2 coats', 456, 'SF', 1.55, P],
      ['Paint ceiling — 2 coats', 324, 'SF', 1.55, P],
    ]},
    { name: 'CARPENTRY', items: [
      ['Base molding — 3.5-in colonial, per LF', 84, 'LF', 3.25, P],
      ['Paint base molding, per LF', 84, 'LF', 0.72, P],
    ]},
    { name: 'FLOORING', items: [
      ['Carpet — medium grade, per SY', 36, 'SY', 26.60, P],
    ]},
    { name: 'FIXTURES', items: [
      ['Interior door — pre-hung, solid wood', 1, 'EA', 462.00, P],
      ['Ceiling fan — standard, 52-in, replace', 1, 'EA', 462.00, P],
      ['Window blind — 2-in faux wood', 2, 'EA', 198.00, P],
    ]},
  ]},
  { name: 'ATTACHED GARAGE', subcats: [
    { name: 'DEMO', items: [
      ['Soot/smoke cleaning — walls, per SF', 360, 'SF', 0.95, P],
      ['Tear out drywall — walls', 360, 'SF', 1.28, P],
      ['Tear out drywall — ceiling', 552, 'SF', 1.28, P],
      ['Ozone treatment — garage, per session', 2, 'LS', 420.00, P],
    ]},
    { name: 'DRYWALL', items: [
      ['Drywall — walls, hang, tape & finish', 360, 'SF', 3.85, P],
      ['Drywall — ceiling, hang, tape & finish', 552, 'SF', 3.85, P],
    ]},
    { name: 'PAINTING', items: [
      ['Paint walls — 2 coats', 360, 'SF', 1.55, P],
      ['Paint ceiling — 2 coats', 552, 'SF', 1.55, P],
    ]},
    { name: 'FLOORING', items: [
      ['Concrete floor sealer — per SF', 552, 'SF', 0.95, P],
    ]},
    { name: 'EXTERIOR', items: [
      ['Garage door — steel flush, 16×7, replace', 1, 'EA', 1542.00, P],
      ['Garage door opener — replace', 1, 'EA', 582.00, P],
      ['Exterior paint — roll & brush, per SF', 160, 'SF', 3.00, P],
      ['Weatherstripping — garage door, per LF', 42, 'LF', 2.00, P],
      ['Overhead light fixture — replace', 1, 'EA', 444.00, P],
    ]},
    { name: 'GENERAL', items: [
      ['Board up — temporary panels, per SF', 192, 'SF', 3.42, P],
    ]},
  ]},
];

async function main() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  let itemNum = 1;
  const margin = 50;
  const pageWidth = 612;
  const pageHeight = 792;

  for (const zone of zones) {
    const page = doc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;

    // Header
    page.drawText('EMPIRE ESTIMATORS LLC', { x: margin, y, size: 14, font: fontBold, color: rgb(0, 0.4, 0) });
    y -= 20;
    page.drawText('Fire Damage Restoration — Phoenix, AZ', { x: margin, y, size: 10, font });
    y -= 15;
    page.drawText('Estimate #EMP-2025-0892 | Date: 3/15/2025', { x: margin, y, size: 9, font });
    y -= 30;

    // Zone header
    page.drawText(zone.name, { x: margin, y, size: 12, font: fontBold, color: rgb(0, 0.4, 0) });
    y -= 25;

    // Column headers
    const colX = [margin, 320, 380, 440, 500];
    page.drawText('DESCRIPTION', { x: colX[0], y, size: 8, font: fontBold });
    page.drawText('QTY', { x: colX[1], y, size: 8, font: fontBold });
    page.drawText('UNIT', { x: colX[2], y, size: 8, font: fontBold });
    page.drawText('RATE', { x: colX[3], y, size: 8, font: fontBold });
    page.drawText('TOTAL', { x: colX[4], y, size: 8, font: fontBold });
    y -= 15;

    for (const subcat of zone.subcats) {
      if (y < 100) {
        const newPage = doc.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
        newPage.drawText(`${zone.name} (continued)`, { x: margin, y, size: 11, font: fontBold });
        y -= 25;
      }

      page.drawText(subcat.name, { x: margin, y, size: 9, font: fontBold, color: rgb(0.3, 0.3, 0.3) });
      y -= 14;

      for (const [desc, qty, unit, rate, opFactor] of subcat.items) {
        if (y < 80) break;
        const total = qty * rate * (1 + opFactor);
        page.drawText(`${itemNum}. ${desc}`, { x: colX[0], y, size: 8, font });
        page.drawText(qty.toFixed(2), { x: colX[1], y, size: 8, font });
        page.drawText(unit, { x: colX[2], y, size: 8, font });
        page.drawText(`$${rate.toFixed(2)}`, { x: colX[3], y, size: 8, font });
        page.drawText(`$${total.toFixed(2)}`, { x: colX[4], y, size: 8, font });
        y -= 12;
        itemNum++;
      }
      y -= 8;
    }
  }

  const pdfBytes = await doc.save();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, pdfBytes);
  console.log(`✅ Contractor_V4.pdf written to ${OUT}`);
}

main().catch(console.error);
