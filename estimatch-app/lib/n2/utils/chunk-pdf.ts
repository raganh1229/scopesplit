// ─────────────────────────────────────────────────────────────────────────────
// N2 Pipeline — PDF chunking utility
//
// Produces a list of page ranges for processing a PDF in overlapping chunks.
// Used in Step 2 (Pass 1/2 zone detection) and LZF Step 1 (large-zone
// extraction), where both estimate PDFs are chunked independently.
//
// All indices returned are 0-based internal pdf-lib page indices.
//
// Overlap logic:
//   Each chunk ends at min(start + chunkSize - 1, lastPage).
//   The next chunk starts at (end - overlap + 1), so the last `overlap` pages
//   of each chunk are repeated at the start of the next chunk.
//   This ensures zone headers that fall exactly at a chunk boundary are always
//   fully visible in at least one chunk.
//
//   Default chunkSize = 10, overlap = 1.
//   Example (20 pages, chunkSize=10, overlap=1):
//     Chunk 0: pages 0–9   (internal indices)
//     Chunk 1: pages 9–18
//     Chunk 2: pages 18–19
// ─────────────────────────────────────────────────────────────────────────────

/** A single chunk descriptor with 0-based internal page indices. */
export type PdfChunk = {
  /** 0-based internal start index (inclusive) */
  startIndex: number;
  /** 0-based internal end index (inclusive) */
  endIndex: number;
  /** 0-based chunk position in the sequence */
  chunkIndex: number;
};

/**
 * Divide a PDF of `totalPages` internal pages into overlapping chunks.
 *
 * @param totalPages   Total number of pages in the PDF (pdf-lib page count)
 * @param chunkSize    Maximum pages per chunk (default 10)
 * @param overlap      Pages shared between adjacent chunks (default 1)
 * @returns            Ordered array of PdfChunk descriptors
 */
export function buildChunks(
  totalPages: number,
  chunkSize = 10,
  overlap = 1,
): PdfChunk[] {
  if (totalPages <= 0) return [];
  if (chunkSize <= 0) throw new Error('chunkSize must be > 0');
  if (overlap < 0) throw new Error('overlap must be >= 0');
  if (overlap >= chunkSize) throw new Error('overlap must be < chunkSize');

  const chunks: PdfChunk[] = [];
  let startIndex = 0;
  let chunkIndex = 0;

  while (startIndex < totalPages) {
    const endIndex = Math.min(startIndex + chunkSize - 1, totalPages - 1);
    chunks.push({ startIndex, endIndex, chunkIndex });

    if (endIndex === totalPages - 1) break; // reached the last page

    // Advance by (chunkSize - overlap) so the last `overlap` pages repeat
    startIndex = endIndex - overlap + 1;
    chunkIndex++;
  }

  return chunks;
}

/**
 * Returns the number of non-overlapping pages a chunk contributes.
 * Useful for computing chunk item budgets.
 *
 * For the first chunk: all pages are non-overlapping.
 * For subsequent chunks: subtract overlap from the total.
 */
export function uniquePagesInChunk(chunk: PdfChunk, overlap: number): number {
  const total = chunk.endIndex - chunk.startIndex + 1;
  return chunk.chunkIndex === 0 ? total : Math.max(0, total - overlap);
}
