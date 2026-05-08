/**
 * Debug script: dumps raw PDF text with zone assignments for each line.
 * Usage: npx tsx scripts/debug-zones.ts "path/to/pdf1.pdf" "path/to/pdf2.pdf"
 */
import * as fs from 'fs';
import * as path from 'path';
import pdfParse from 'pdf-parse';

// We need to replicate the zone detection logic visibility, so import from prematch
import {
  parseAllLinesWithZones,
  type PrematchLineRecord,
} from '../lib/deterministic-prematch';

function normalizePdfText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function toLineRecords(text: string): PrematchLineRecord[] {
  const lines = text.split('\n');
  const records: PrematchLineRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim().length > 0) {
      records.push({ lineNumber: i + 1, text: line.trim() });
    }
  }
  return records;
}

async function main() {
  const [pdfAPath, pdfBPath] = process.argv.slice(2);
  if (!pdfAPath || !pdfBPath) {
    console.error('Usage: npx tsx scripts/debug-zones.ts <pdf-a> <pdf-b>');
    process.exit(1);
  }

  const resolvedA = path.resolve(process.cwd(), pdfAPath);
  const resolvedB = path.resolve(process.cwd(), pdfBPath);

  const output: string[] = [];
  const log = (s: string) => { output.push(s); console.log(s); };

  for (const [label, filePath] of [['PDF A (Yours)', resolvedA], ['PDF B (Adjuster)', resolvedB]] as const) {
    const pdfBytes = fs.readFileSync(filePath);
    const parsed = await pdfParse(pdfBytes);
    const text = normalizePdfText(parsed.text ?? '');
    const lines = toLineRecords(text);

    log(`\n${'='.repeat(80)}`);
    log(`${label}: ${path.basename(filePath)}`);
    log(`Total raw lines: ${lines.length}`);
    log(`${'='.repeat(80)}`);

    // Show ALL raw lines with line numbers
    log(`\n--- RAW TEXT (first 200 lines) ---`);
    for (const line of lines.slice(0, 200)) {
      log(`  L${String(line.lineNumber).padStart(4)}: ${line.text}`);
    }

    // Now show zone assignments
    const parsedMap = parseAllLinesWithZones(lines);
    const zoneGroups = new Map<string, { lineNumber: number; desc: string }[]>();

    for (const [lineNum, fields] of parsedMap) {
      const zone = fields.zone ?? '__UNZONED__';
      if (!zoneGroups.has(zone)) zoneGroups.set(zone, []);
      zoneGroups.get(zone)!.push({
        lineNumber: lineNum,
        desc: fields.description || fields.rawText,
      });
    }

    log(`\n--- ZONE ASSIGNMENTS ---`);
    log(`Zones detected: ${[...zoneGroups.keys()].join(', ')}`);
    for (const [zone, items] of zoneGroups) {
      log(`\n  Zone: "${zone}" (${items.length} scope lines)`);
      for (const item of items) {
        log(`    L${String(item.lineNumber).padStart(4)}: ${item.desc}`);
      }
    }
  }

  const outFile = path.join(__dirname, 'debug-zones-output.txt');
  fs.writeFileSync(outFile, output.join('\n'), 'utf-8');
  console.log(`\nFull output written to ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
