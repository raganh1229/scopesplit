// ─────────────────────────────────────────────────────────────────────────────
// N2 Pipeline — PDF loading and page slicing (pdf-lib)
//
// Core utility for creating sub-PDFs from a source document. Used by:
//   • Step 2 (detect-zones): slice chunks for Pass 1/2 zone detection
//   • Step 4 (extract-and-match): slice per-zone sub-PDFs for Pass 4A/4B
//   • LZF Step 1 (large-zone-flow): slice chunks for extraction
//
// Design:
//   - Load each PDF once (loadPdf), hold the PDFDocument in memory for the
//     duration of the step, and call slicePages many times on the same doc.
//   - All page indices are 0-based internal pdf-lib indices.
//   - Printed page numbers → internal indices via chunkOffset on each zone:
//       internalIndex = printedPageNumber + chunkOffset
//   - The caller is responsible for computing correct indices before calling
//     slicePages. This function performs range clamping as a safety net but
//     does NOT apply offsets.
// ─────────────────────────────────────────────────────────────────────────────

import { PDFDocument } from 'pdf-lib';

/**
 * Load a PDF from raw bytes into a pdf-lib PDFDocument.
 * Call once per PDF per step; reuse the returned doc for all slices.
 *
 * @param pdfBytes  Uint8Array of the raw PDF file
 */
export async function loadPdf(pdfBytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(pdfBytes);
}

/**
 * Slice pages [startIndex, endIndex] (inclusive) from srcDoc into a new
 * standalone PDF and return its bytes.
 *
 * @param srcDoc      Source PDFDocument (from loadPdf)
 * @param startIndex  0-based internal page index (offset-corrected by caller)
 * @param endIndex    0-based internal page index, inclusive
 * @returns           Uint8Array of the sliced sub-PDF
 *
 * @throws  If the clamped range is empty (startIndex > endIndex after clamping)
 */
export async function slicePages(
  srcDoc: PDFDocument,
  startIndex: number,
  endIndex: number,
): Promise<Uint8Array> {
  const totalPages = srcDoc.getPageCount();

  const safeStart = Math.max(0, startIndex);
  const safeEnd = Math.min(totalPages - 1, endIndex);

  if (safeStart > safeEnd) {
    throw new Error(
      `pdf-slicer: empty range after clamping — requested [${startIndex}, ${endIndex}] ` +
        `but PDF has ${totalPages} pages (0-based [0, ${totalPages - 1}])`,
    );
  }

  const newDoc = await PDFDocument.create();
  const indices = Array.from(
    { length: safeEnd - safeStart + 1 },
    (_, i) => safeStart + i,
  );

  const pages = await newDoc.copyPages(srcDoc, indices);
  for (const page of pages) {
    newDoc.addPage(page);
  }

  return newDoc.save();
}

/**
 * Convenience: convert a printed page number to a 0-based pdf-lib internal
 * index using the zone's chunkOffset.
 *
 *   internalIndex = printedPage + chunkOffset
 *
 * The chunkOffset was computed at merge time in detect-zones:
 *   chunkOffset = chunkStartInternalIndex − chunkFirstPrintedPage
 */
export function printedToInternal(printedPage: number, chunkOffset: number): number {
  return printedPage + chunkOffset;
}
