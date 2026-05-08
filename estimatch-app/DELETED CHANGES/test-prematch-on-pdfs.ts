/**
 * Offline script: run the pre-filter + prematch pipeline on local PDFs
 * to see how many lines get auto-resolved vs sent to AI.
 *
 * Usage:  npx tsx scripts/test-prematch-on-pdfs.ts <pdfA> <pdfB>
 *
 * Example:
 *   npx tsx scripts/test-prematch-on-pdfs.ts \
 *     "../../PDFS/Fire Damage - Very Short.pdf" \
 *     "../../PDFS/Fire Damage - Very Short.pdf"
 */

import fs from 'node:fs';
import path from 'node:path';
import pdfParse from 'pdf-parse';
import { filterExtractedLines, type FilterableLineRecord } from '../lib/comparison-line-filter';
import { runDeterministicPrematch, deterministicMatchesToRawLineItems } from '../lib/deterministic-prematch';

function toLineRecords(text: string): FilterableLineRecord[] {
  const lines = text.split('\n');
  const records: FilterableLineRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim().length === 0) continue;
    records.push({ lineNumber: i + 1, text: line });
  }
  return records;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: npx tsx scripts/test-prematch-on-pdfs.ts <pdfA> <pdfB>');
    process.exit(1);
  }

  const pdfAPath = path.resolve(args[0]!);
  const pdfBPath = path.resolve(args[1]!);

  console.log(`PDF A: ${pdfAPath}`);
  console.log(`PDF B: ${pdfBPath}`);

  const [bufA, bufB] = await Promise.all([
    fs.promises.readFile(pdfAPath),
    fs.promises.readFile(pdfBPath),
  ]);

  const parsedA = await pdfParse(bufA);
  const parsedB = await pdfParse(bufB);

  const textA = (parsedA.text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const textB = (parsedB.text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const rawA = toLineRecords(textA);
  const rawB = toLineRecords(textB);

  console.log(`\n── Raw extraction ──`);
  console.log(`  PDF A: ${rawA.length} lines`);
  console.log(`  PDF B: ${rawB.length} lines`);

  // Force pre-filter on
  process.env.COMPARISON_PROCESSING_PRE_FILTER = 'true';
  const filteredA = filterExtractedLines(rawA);
  const filteredB = filterExtractedLines(rawB);

  console.log(`\n── After pre-filter ──`);
  console.log(`  PDF A: ${filteredA.stats.inputCount} → ${filteredA.stats.outputCount} lines (~${filteredA.stats.estimatedTokensSaved} tokens saved)`);
  console.log(`  PDF B: ${filteredB.stats.inputCount} → ${filteredB.stats.outputCount} lines (~${filteredB.stats.estimatedTokensSaved} tokens saved)`);

  // Force prematch on
  process.env.COMPARISON_PROCESSING_PREMATCH = 'true';
  const prematch = runDeterministicPrematch(filteredA.lines, filteredB.lines);

  console.log(`\n── Deterministic pre-match ──`);
  console.log(`  Auto-matched: ${prematch.stats.autoMatchedCount} (${prematch.stats.exactMatchCount} exact MATCH, ${prematch.stats.modifiedMatchCount} MODIFIED)`);
  console.log(`  Avg confidence: ${prematch.stats.avgConfidence}`);
  console.log(`  Remaining for AI (yours): ${prematch.stats.unmatchedYoursCount}`);
  console.log(`  Remaining for AI (adjuster): ${prematch.stats.unmatchedAdjusterCount}`);

  if (prematch.matches.length > 0) {
    console.log(`\n── All auto-matches ──`);
    for (let i = 0; i < prematch.matches.length; i++) {
      const m = prematch.matches[i]!;
      console.log(`  #${String(i + 1).padStart(3)} [${m.confidence} ${m.status.padEnd(8)}] YOUR: "${m.yourLine.description.slice(0, 55)}" ↔ ADJ: "${m.adjusterLine.description.slice(0, 55)}"`);
    }
  }

  const items = deterministicMatchesToRawLineItems(prematch.matches);
  console.log(`\n── Converted to ${items.length} RawLineItems (all MATCH status) ──`);

  // Estimate token reduction for AI
  const totalFilteredLines = filteredA.stats.outputCount + filteredB.stats.outputCount;
  const remainingForAI = prematch.stats.unmatchedYoursCount + prematch.stats.unmatchedAdjusterCount;
  const reductionPct = totalFilteredLines > 0
    ? ((1 - remainingForAI / totalFilteredLines) * 100).toFixed(1)
    : '0.0';
  console.log(`\n── Summary ──`);
  console.log(`  Lines to AI: ${remainingForAI}/${totalFilteredLines} (${reductionPct}% reduction from prematch)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
