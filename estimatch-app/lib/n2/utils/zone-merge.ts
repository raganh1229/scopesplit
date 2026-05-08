// ─────────────────────────────────────────────────────────────────────────────
// N2 Pipeline — Zone merge, offset calculation, pre-dedup, zero-zone fallback
//
// Consumes raw chunk detection results and produces the final N2DetectedZone[]
// for one estimate. Called once per estimate after all chunk AI calls complete.
//
// Responsibilities:
//   1. Per-chunk offset: chunkOffset = chunk.startIndex − firstPagePrintedNumber
//   2. Build zone map: verbatim name → earliest startPage + summed approxItems
//   3. Sort by startPage; derive endPage and endPageChunkOffset deterministically
//   4. Pre-dedup: collapse zones where one name is a proper suffix of another
//   5. Zero-zone fallback: synthesize a "General" zone if none were detected
//
// Architecture refs: N2_SPEED_CAPACITY_ACCURACY.md §Pass 1, Issues 1/35
// ─────────────────────────────────────────────────────────────────────────────

import type { N2DetectedZone, EstimateFormat } from '@/lib/n2/schemas/types';
import type { PdfChunk } from '@/lib/n2/utils/chunk-pdf';

// ── Input type ────────────────────────────────────────────────────────────────

/**
 * Zone detection result for a single chunk, produced by the AI call in
 * detect-zones.ts and consumed here by mergeChunkZones.
 */
export type ChunkZoneDetectionResult = {
  chunk: PdfChunk;
  /** Printed page number on the first page of this sub-PDF — returned by the model. */
  firstPagePrintedNumber: number;
  /** Total approximate line items visible on all pages in this chunk. */
  approxItemsOnPages: number;
  zones: Array<{
    name: string;
    startPage: number;     // original printed page number
    evidenceItem: string;  // first line item beneath this header (proof of validity)
    approxItems: number;   // items visible under this zone in this chunk
  }>;
  /**
   * Present only for chunkIndex === 0. The detected document format is returned
   * by Pass 1 Chunk 1 only — all other chunks omit this field.
   */
  detectedFormat?: EstimateFormat;
};

// ── Internal helpers ──────────────────────────────────────────────────────────

type ZoneEntry = {
  name: string;
  startPage: number;   // lowest printed start page seen across all chunks
  approxItems: number; // accumulated across all chunks where this zone appears
  chunkOffset: number; // offset from the chunk that detected the LOWEST startPage
};

/** Compute per-chunk offset: add to any printed page to get a pdf-lib internal index. */
function chunkOffset(chunk: PdfChunk, firstPagePrintedNumber: number): number {
  return chunk.startIndex - firstPagePrintedNumber;
}

// ── Main export: mergeChunkZones ──────────────────────────────────────────────

/**
 * Merge all chunk detection results into a sorted, offset-annotated
 * N2DetectedZone array for one estimate.
 *
 * Returns an empty array if no zones were detected (caller should apply
 * `synthesizeGeneralZone` as a fallback before proceeding to Pass 3).
 *
 * @param chunkResults       All chunk results for one estimate, in any order.
 * @param pdfInternalPageCount  Total internal pages (pdf-lib page count).
 */
export function mergeChunkZones(
  chunkResults: ChunkZoneDetectionResult[],
  pdfInternalPageCount: number,
): N2DetectedZone[] {
  if (chunkResults.length === 0) return [];

  // Sort by chunkIndex so we iterate in document order
  const sorted = [...chunkResults].sort((a, b) => a.chunk.chunkIndex - b.chunk.chunkIndex);

  // Step 1: Compute per-chunk offsets and build zone map
  // Key: verbatim zone name (case-sensitive — names are copied verbatim from PDF)
  const zoneMap = new Map<string, ZoneEntry>();

  for (const cr of sorted) {
    const offset = chunkOffset(cr.chunk, cr.firstPagePrintedNumber);
    for (const z of cr.zones) {
      const existing = zoneMap.get(z.name);
      if (!existing) {
        zoneMap.set(z.name, {
          name: z.name,
          startPage: z.startPage,
          approxItems: z.approxItems,
          chunkOffset: offset,
        });
      } else if (z.startPage < existing.startPage) {
        // Earlier occurrence in document (across chunk boundary) — update canonical
        // start page and chunkOffset; keep accumulated approxItems from previous entry
        zoneMap.set(z.name, {
          name: z.name,
          startPage: z.startPage,
          approxItems: existing.approxItems + z.approxItems,
          chunkOffset: offset,
        });
      } else {
        // Same zone continuing in a later chunk — accumulate item count only
        zoneMap.set(z.name, {
          ...existing,
          approxItems: existing.approxItems + z.approxItems,
        });
      }
    }
  }

  // Step 2: Sort zones by startPage
  const zones = Array.from(zoneMap.values()).sort((a, b) => a.startPage - b.startPage);
  if (zones.length === 0) return [];

  // Step 3: Derive last printed page from the last chunk
  const lastChunk = sorted[sorted.length - 1]!;
  const lastPrintedPage =
    lastChunk.firstPagePrintedNumber + (lastChunk.chunk.endIndex - lastChunk.chunk.startIndex);

  // Step 4: Assign endPage and endPageChunkOffset per zone
  //   Zone N: endPage = Zone N+1's startPage (inclusive shared boundary per Issue 35)
  //           endPageChunkOffset = Zone N+1's chunkOffset
  //   Last zone: endPage = lastPrintedPage
  //              endPageChunkOffset = pdfInternalPageCount - 1 - lastPrintedPage
  //              → internalEnd = lastPrintedPage + endPageChunkOffset = pdfInternalPageCount - 1 ✓
  return zones.map((z, i): N2DetectedZone => {
    if (i < zones.length - 1) {
      const next = zones[i + 1]!;
      return {
        name: z.name,
        startPage: z.startPage,
        endPage: next.startPage,
        approxItems: z.approxItems,
        chunkOffset: z.chunkOffset,
        endPageChunkOffset: next.chunkOffset,
      };
    }
    // Last zone — end is the document's final internal page.
    // Guard: endPage must be >= startPage. If lastPrintedPage is unexpectedly
    // low (e.g. every chunk reports firstPagePrintedNumber=1 because the PDF
    // has no visible page numbers), clamp to startPage so we never produce an
    // inverted range. endPageChunkOffset is recomputed from the clamped value
    // so that internalEnd = endPage + endPageChunkOffset = pdfInternalPageCount - 1.
    const safeEndPage = Math.max(z.startPage, lastPrintedPage);
    return {
      name: z.name,
      startPage: z.startPage,
      endPage: safeEndPage,
      approxItems: z.approxItems,
      chunkOffset: z.chunkOffset,
      endPageChunkOffset: pdfInternalPageCount - 1 - safeEndPage,
    };
  });
}

// ── Pre-dedup ─────────────────────────────────────────────────────────────────

/**
 * Collapse within-estimate zone duplicates where one name is a proper suffix
 * of another — e.g. "Common Lobby" is removed when "1st Floor - Common Lobby"
 * is also present.
 *
 * Conservative: only removes a zone if its full name (lowercased) is a proper
 * suffix of another zone's name AND has nothing after the suffix (no trailing
 * qualifier like " 2"). This prevents collapsing "Bathroom 1" / "Bathroom 2".
 *
 * Zones that survive are passed as-is to Pass 3 (Opus handles any remaining
 * ambiguity via its matching rules).
 */
export function preDeduplicateZones(zones: N2DetectedZone[]): N2DetectedZone[] {
  if (zones.length <= 1) return zones;

  const normalized = zones.map(z => z.name.toLowerCase().trim());
  const toRemove = new Set<number>();

  for (let i = 0; i < zones.length; i++) {
    if (toRemove.has(i)) continue;
    for (let j = i + 1; j < zones.length; j++) {
      if (toRemove.has(j)) continue;
      const a = normalized[i]!;
      const b = normalized[j]!;

      if (a === b) {
        // Exact duplicate (case-insensitive) — keep higher approxItems; tie → keep i
        toRemove.add(zones[i]!.approxItems >= zones[j]!.approxItems ? j : i);
      } else if (a.length > b.length && a.endsWith(b)) {
        // a is the more specific form; b is a bare suffix — remove b (j)
        // Guard: the character before b in a must be a word boundary (space or dash)
        const charBefore = a[a.length - b.length - 1];
        if (charBefore === ' ' || charBefore === '-') {
          toRemove.add(j);
        }
      } else if (b.length > a.length && b.endsWith(a)) {
        // b is the more specific form; remove a (i)
        const charBefore = b[b.length - a.length - 1];
        if (charBefore === ' ' || charBefore === '-') {
          toRemove.add(i);
          break; // i is gone — no point comparing it further
        }
      }
    }
  }

  return zones.filter((_, i) => !toRemove.has(i));
}

// ── Zero-zone fallback ────────────────────────────────────────────────────────

/**
 * Synthesize a single "General" zone covering the entire document when no
 * zone headers were detected (flat-list estimate). The zone's approxItems is
 * the sum of all chunk `approxItemsOnPages` values.
 *
 * The caller must still classify the estimate as flat in the routing decision.
 */
export function synthesizeGeneralZone(
  chunkResults: ChunkZoneDetectionResult[],
  pdfInternalPageCount: number,
): N2DetectedZone {
  const sorted = [...chunkResults].sort((a, b) => a.chunk.chunkIndex - b.chunk.chunkIndex);

  const firstChunk = sorted[0]!;
  const lastChunk = sorted[sorted.length - 1]!;

  const firstOffset = chunkOffset(firstChunk.chunk, firstChunk.firstPagePrintedNumber);
  const lastPrintedPage =
    lastChunk.firstPagePrintedNumber + (lastChunk.chunk.endIndex - lastChunk.chunk.startIndex);

  const totalApproxItems = sorted.reduce((sum, cr) => sum + cr.approxItemsOnPages, 0);

  return {
    name: 'General',
    startPage: firstChunk.firstPagePrintedNumber,
    endPage: lastPrintedPage,
    approxItems: totalApproxItems,
    chunkOffset: firstOffset,
    endPageChunkOffset: pdfInternalPageCount - 1 - lastPrintedPage,
  };
}
