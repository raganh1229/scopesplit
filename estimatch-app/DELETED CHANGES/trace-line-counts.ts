import pdfParse from 'pdf-parse';
import fs from 'fs';
import { filterExtractedLines } from '@/lib/comparison-line-filter';
import {
  isPrematchEnabled,
  runDeterministicPrematch,
  isZoneCandidate,
} from '@/lib/deterministic-prematch';

type LineRecord = { lineNumber: number; text: string };

function toLineRecords(rawText: string): LineRecord[] {
  return rawText
    .split(/\n/)
    .map((line, idx) => ({ lineNumber: idx, text: line }))
    .filter((r) => r.text.trim().length > 0);
}

async function main() {
  const ctrBuf = fs.readFileSync(
    'C:/Users/Ragan Harrison/OneDrive/Desktop/Application Comparrison/PDFS/Accurate Comparisons/Set11/Contractor_Estimate_Set10.pdf'
  );
  const adjBuf = fs.readFileSync(
    'C:/Users/Ragan Harrison/OneDrive/Desktop/Application Comparrison/PDFS/Accurate Comparisons/Set11/Adjuster_Estimate_Set10.pdf'
  );

  const ctrPdf = await pdfParse(ctrBuf);
  const adjPdf = await pdfParse(adjBuf);

  // Stage 1: Raw extraction
  const ctrRaw = toLineRecords(ctrPdf.text);
  const adjRaw = toLineRecords(adjPdf.text);
  console.log(`\n=== STAGE 1: Raw PDF extraction ===`);
  console.log(`  Contractor: ${ctrRaw.length} lines`);
  console.log(`  Adjuster:   ${adjRaw.length} lines`);

  // Stage 2: Line filter
  const ctrFiltered = filterExtractedLines(ctrRaw);
  const adjFiltered = filterExtractedLines(adjRaw);
  console.log(`\n=== STAGE 2: After line filter ===`);
  console.log(`  Contractor: ${ctrFiltered.lines.length} lines (dropped ${ctrRaw.length - ctrFiltered.lines.length})`);
  console.log(`    chrome:${ctrFiltered.stats.droppedPageChrome} meta:${ctrFiltered.stats.droppedMetadata} boiler:${ctrFiltered.stats.droppedBoilerplate} summary:${ctrFiltered.stats.droppedSummaryLines} dup:${ctrFiltered.stats.droppedDuplicates}`);
  console.log(`  Adjuster:   ${adjFiltered.lines.length} lines (dropped ${adjRaw.length - adjFiltered.lines.length})`);
  console.log(`    chrome:${adjFiltered.stats.droppedPageChrome} meta:${adjFiltered.stats.droppedMetadata} boiler:${adjFiltered.stats.droppedBoilerplate} summary:${adjFiltered.stats.droppedSummaryLines} dup:${adjFiltered.stats.droppedDuplicates}`);

  // Stage 3: Zone candidate breakdown (scope detection is internal, so we approximate)
  // A line with a decimal number (cost) is likely scope; otherwise check zone candidate
  const hasDecimal = (t: string) => /\d+\.\d{2}/.test(t);
  const ctrScope = ctrFiltered.lines.filter(l => hasDecimal(l.text));
  const ctrZoneCandidates = ctrFiltered.lines.filter(l => !hasDecimal(l.text) && isZoneCandidate(l.text));
  const ctrNeither = ctrFiltered.lines.filter(l => !hasDecimal(l.text) && !isZoneCandidate(l.text));
  
  const adjScope = adjFiltered.lines.filter(l => hasDecimal(l.text));
  const adjZoneCandidates = adjFiltered.lines.filter(l => !hasDecimal(l.text) && isZoneCandidate(l.text));
  const adjNeither = adjFiltered.lines.filter(l => !hasDecimal(l.text) && !isZoneCandidate(l.text));

  console.log(`\n=== STAGE 3: Classification ===`);
  console.log(`  Contractor: ${ctrScope.length} scope + ${ctrZoneCandidates.length} zone candidates + ${ctrNeither.length} neither = ${ctrFiltered.lines.length}`);
  console.log(`  Adjuster:   ${adjScope.length} scope + ${adjZoneCandidates.length} zone candidates + ${adjNeither.length} neither = ${adjFiltered.lines.length}`);

  // Stage 4: Prematch
  if (isPrematchEnabled()) {
    const prematch = runDeterministicPrematch(ctrFiltered.lines, adjFiltered.lines);
    
    console.log(`\n=== STAGE 4: After prematch ===`);
    console.log(`  Prematch resolved: ${prematch.matches.length} pairs`);
    console.log(`  Unmatched yours:    ${prematch.unmatchedYourLines.length} lines`);
    console.log(`  Unmatched adjuster: ${prematch.unmatchedAdjusterLines.length} lines`);
    console.log(`  Total accounted: ${prematch.matches.length * 2 + prematch.unmatchedYourLines.length + prematch.unmatchedAdjusterLines.length} (should equal ${ctrFiltered.lines.length + adjFiltered.lines.length})`);

    // What prematch consumed
    const yourScopeInUnmatched = prematch.unmatchedYourLines.filter(l => hasDecimal(l.text)).length;
    const yourZoneInUnmatched = prematch.unmatchedYourLines.filter(l => !hasDecimal(l.text) && isZoneCandidate(l.text)).length;
    const adjScopeInUnmatched = prematch.unmatchedAdjusterLines.filter(l => hasDecimal(l.text)).length;
    const adjZoneInUnmatched = prematch.unmatchedAdjusterLines.filter(l => !hasDecimal(l.text) && isZoneCandidate(l.text)).length;
    
    console.log(`\n  Unmatched yours breakdown: ${yourScopeInUnmatched} scope + ${yourZoneInUnmatched} zone candidates + ${prematch.unmatchedYourLines.length - yourScopeInUnmatched - yourZoneInUnmatched} other`);
    console.log(`  Unmatched adjuster breakdown: ${adjScopeInUnmatched} scope + ${adjZoneInUnmatched} zone candidates + ${prematch.unmatchedAdjusterLines.length - adjScopeInUnmatched - adjZoneInUnmatched} other`);
  }

  // Show "neither" lines that are being silently dropped
  if (ctrNeither.length > 0) {
    console.log(`\n=== DROPPED LINES (contractor "neither" — not scope, not zone candidate) ===`);
    for (const l of ctrNeither) {
      console.log(`  [${l.lineNumber}] "${l.text.trim().substring(0, 80)}"`);
    }
  }
  if (adjNeither.length > 0) {
    console.log(`\n=== DROPPED LINES (adjuster "neither" — not scope, not zone candidate) ===`);
    for (const l of adjNeither) {
      console.log(`  [${l.lineNumber}] "${l.text.trim().substring(0, 80)}"`);
    }
  }
}

main().catch(console.error);
