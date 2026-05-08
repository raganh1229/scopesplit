import { describe, it, expect } from 'vitest';
import {
  mergeChunkZones,
  preDeduplicateZones,
  synthesizeGeneralZone,
  type ChunkZoneDetectionResult,
} from '@/lib/n2/utils/zone-merge';
import type { N2DetectedZone } from '@/lib/n2/schemas/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeChunk(chunkIndex: number, startIndex: number, endIndex: number) {
  return { startIndex, endIndex, chunkIndex };
}

function makeResult(
  chunkIndex: number,
  startIndex: number,
  endIndex: number,
  firstPagePrinted: number,
  zones: Array<{ name: string; startPage: number; approxItems: number }>,
  approxItemsOnPages = 0,
): ChunkZoneDetectionResult {
  return {
    chunk: makeChunk(chunkIndex, startIndex, endIndex),
    firstPagePrintedNumber: firstPagePrinted,
    approxItemsOnPages,
    zones: zones.map(z => ({ ...z, evidenceItem: 'Item 1. R&R Drywall' })),
  };
}

// ── mergeChunkZones ───────────────────────────────────────────────────────────

describe('mergeChunkZones', () => {
  it('returns empty array if no chunk results', () => {
    expect(mergeChunkZones([], 20)).toEqual([]);
  });

  it('returns empty array if all chunks have no zones', () => {
    const result = makeResult(0, 0, 9, 1, [], 5);
    expect(mergeChunkZones([result], 10)).toEqual([]);
  });

  it('single chunk, single zone — correct offset and endPage', () => {
    // PDF: 10 pages (0-9 internal), printed pages 1-10.
    // Zone "Kitchen" detected at printed page 1.
    const result = makeResult(0, 0, 9, 1, [{ name: 'Kitchen', startPage: 1, approxItems: 20 }]);
    const zones = mergeChunkZones([result], 10);
    expect(zones).toHaveLength(1);
    const k = zones[0]!;
    expect(k.name).toBe('Kitchen');
    expect(k.startPage).toBe(1);
    expect(k.chunkOffset).toBe(-1); // 0 (startIndex) - 1 (printed) = -1
    // Last zone: endPage = firstPage + (endIndex - startIndex) = 1 + 9 = 10
    expect(k.endPage).toBe(10);
    // endPageChunkOffset = pdfInternalPageCount - 1 - endPage = 9 - 10 = -1
    expect(k.endPageChunkOffset).toBe(-1);
  });

  it('two zones, endPage of first = startPage of second', () => {
    const result = makeResult(0, 0, 19, 1, [
      { name: 'Kitchen', startPage: 1, approxItems: 20 },
      { name: 'Dining Room', startPage: 8, approxItems: 15 },
    ]);
    const zones = mergeChunkZones([result], 20);
    expect(zones).toHaveLength(2);
    expect(zones[0]!.endPage).toBe(8); // Kitchen ends where Dining Room starts
    expect(zones[1]!.startPage).toBe(8);
  });

  it('accumulates approxItems across chunks for the same zone', () => {
    const chunk1 = makeResult(0, 0, 9, 1, [{ name: 'Kitchen', startPage: 3, approxItems: 10 }]);
    const chunk2 = makeResult(1, 9, 18, 9, [{ name: 'Kitchen', startPage: 12, approxItems: 7 }]);
    // Chunk 2 reports Kitchen again at startPage 12 > 3, so it accumulates
    const zones = mergeChunkZones([chunk1, chunk2], 19);
    expect(zones).toHaveLength(1);
    expect(zones[0]!.approxItems).toBe(17); // 10 + 7
  });

  it('same-named zone across chunks merges to one entry (name is the map key)', () => {
    // Overlap boundary: chunk1 reports Kitchen at p9, chunk2 reports Kitchen at p10.
    // The merge step uses zone name as the zoneMap key. Both chunks produce one entry
    // with startPage=9 (the lower value) and accumulated approxItems.
    const chunk1 = makeResult(0, 0, 9, 1, [{ name: 'Kitchen', startPage: 9, approxItems: 5 }]);
    const chunk2 = makeResult(1, 9, 18, 9, [{ name: 'Kitchen', startPage: 10, approxItems: 3 }]);
    const zones = mergeChunkZones([chunk1, chunk2], 19);
    expect(zones).toHaveLength(1); // merged to one entry
    expect(zones[0]!.startPage).toBe(9); // lower startPage wins
    expect(zones[0]!.approxItems).toBe(8); // 5 + 3 accumulated
  });

  it('two zones with different names across chunks produce two entries', () => {
    const chunk1 = makeResult(0, 0, 9, 1, [{ name: 'Kitchen', startPage: 2, approxItems: 15 }]);
    const chunk2 = makeResult(1, 9, 18, 9, [{ name: 'Bathroom', startPage: 11, approxItems: 10 }]);
    const zones = mergeChunkZones([chunk1, chunk2], 19);
    expect(zones).toHaveLength(2);
    expect(zones[0]!.name).toBe('Kitchen');
    expect(zones[1]!.name).toBe('Bathroom');
  });

  it('PDF with a cover page offset: printed page 3 = internal index 0', () => {
    // 10-page PDF. First printed number is 3 (pages 1-2 were a cover/ToC).
    // chunkOffset = startIndex(0) - firstPagePrinted(3) = -3
    const result = makeResult(0, 0, 9, 3, [{ name: 'General', startPage: 4, approxItems: 50 }]);
    const zones = mergeChunkZones([result], 10);
    expect(zones[0]!.chunkOffset).toBe(-3);
    // internal index of startPage 4 = 4 + (-3) = 1 ✓
  });

  it('results in correct order regardless of chunk input order', () => {
    const chunk2 = makeResult(1, 9, 18, 9, [{ name: 'Bathroom', startPage: 11, approxItems: 10 }]);
    const chunk1 = makeResult(0, 0, 9, 1, [{ name: 'Kitchen', startPage: 1, approxItems: 20 }]);
    const zones = mergeChunkZones([chunk2, chunk1], 19); // deliberately reversed
    expect(zones[0]!.name).toBe('Kitchen');
    expect(zones[1]!.name).toBe('Bathroom');
  });

  it('last zone endPage is clamped to >= startPage when lastPrintedPage is low', () => {
    // Edge case: all chunks report firstPagePrintedNumber=1 (no visible page numbers)
    // and endIndex=0, making lastPrintedPage = 1 + 0 = 1 = startPage
    const result = makeResult(0, 0, 0, 1, [{ name: 'General', startPage: 1, approxItems: 100 }]);
    const zones = mergeChunkZones([result], 1);
    expect(zones[0]!.endPage).toBeGreaterThanOrEqual(zones[0]!.startPage);
  });
});

// ── preDeduplicateZones ───────────────────────────────────────────────────────

function makeZone(name: string, startPage: number, approxItems = 10): N2DetectedZone {
  return { name, startPage, endPage: startPage + 5, approxItems, chunkOffset: 0, endPageChunkOffset: 0 };
}

describe('preDeduplicateZones', () => {
  it('passes through a single zone', () => {
    expect(preDeduplicateZones([makeZone('Kitchen', 1)])).toHaveLength(1);
  });

  it('removes bare suffix zone when qualified form is present', () => {
    const zones = [
      makeZone('1st Floor - Common Lobby', 5),
      makeZone('Common Lobby', 2),
    ];
    const result = preDeduplicateZones(zones);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('1st Floor - Common Lobby');
  });

  it('removes suffix separated by a dash', () => {
    const zones = [
      makeZone('2nd Floor-Office Suite', 10),
      makeZone('Office Suite', 8),
    ];
    const result = preDeduplicateZones(zones);
    expect(result).toHaveLength(1);
  });

  it('preserves Bathroom 1 and Bathroom 2 (numeric qualifier)', () => {
    const zones = [makeZone('Bathroom 1', 5), makeZone('Bathroom 2', 10)];
    expect(preDeduplicateZones(zones)).toHaveLength(2);
  });

  it('preserves unrelated zones', () => {
    const zones = [makeZone('Kitchen', 1), makeZone('Dining Room', 5), makeZone('Garage', 10)];
    expect(preDeduplicateZones(zones)).toHaveLength(3);
  });

  it('keeps the zone with higher approxItems on exact-name duplicate', () => {
    const zones = [
      makeZone('Kitchen', 1, 5),
      makeZone('Kitchen', 8, 20), // same name, different startPage — treated as exact dup by name
    ];
    // Note: mergeChunkZones uses name as key so this is unusual but still valid input
    const result = preDeduplicateZones(zones);
    expect(result).toHaveLength(1);
    expect(result[0]!.approxItems).toBe(20);
  });

  it('is case-insensitive for suffix matching', () => {
    const zones = [
      makeZone('1st Floor - KITCHEN', 5),
      makeZone('kitchen', 2),
    ];
    const result = preDeduplicateZones(zones);
    expect(result).toHaveLength(1);
  });

  it('does not remove zone where the character before suffix is not space/dash', () => {
    // "Akitchen" ends with "kitchen" but no space/dash separator → should NOT remove
    const zones = [makeZone('Akitchen', 5), makeZone('kitchen', 2)];
    expect(preDeduplicateZones(zones)).toHaveLength(2);
  });
});

// ── synthesizeGeneralZone ─────────────────────────────────────────────────────

describe('synthesizeGeneralZone', () => {
  it('returns a General zone spanning the full document', () => {
    const result = makeResult(0, 0, 9, 1, [], 45);
    const zone = synthesizeGeneralZone([result], 10);
    expect(zone.name).toBe('General');
    expect(zone.startPage).toBe(1);
    expect(zone.approxItems).toBe(45);
  });

  it('sums approxItemsOnPages across all chunks', () => {
    const chunk1 = makeResult(0, 0, 9, 1, [], 30);
    const chunk2 = makeResult(1, 9, 18, 9, [], 25);
    const zone = synthesizeGeneralZone([chunk1, chunk2], 19);
    expect(zone.approxItems).toBe(55);
  });

  it('endPageChunkOffset leads to correct internal last index', () => {
    const result = makeResult(0, 0, 9, 1, [], 10);
    const zone = synthesizeGeneralZone([result], 10);
    // endPage = 1 + (9 - 0) = 10
    // endPageChunkOffset = 10 - 1 - 10 = -1
    // internalEnd = endPage + endPageChunkOffset = 10 + (-1) = 9 = pdfInternalPageCount - 1 ✓
    expect(zone.endPage + zone.endPageChunkOffset).toBe(9);
  });
});
