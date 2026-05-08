import { describe, it, expect } from 'vitest';
import { buildChunks, uniquePagesInChunk } from '@/lib/n2/utils/chunk-pdf';

describe('buildChunks', () => {
  it('returns empty array for 0 pages', () => {
    expect(buildChunks(0)).toEqual([]);
  });

  it('single page PDF → one chunk', () => {
    const chunks = buildChunks(1);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ startIndex: 0, endIndex: 0, chunkIndex: 0 });
  });

  it('10-page PDF with default args → one chunk (no overflow)', () => {
    const chunks = buildChunks(10);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ startIndex: 0, endIndex: 9, chunkIndex: 0 });
  });

  it('20 pages, size=10, overlap=1 → doc comment example', () => {
    const chunks = buildChunks(20, 10, 1);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ startIndex: 0, endIndex: 9, chunkIndex: 0 });
    expect(chunks[1]).toEqual({ startIndex: 9, endIndex: 18, chunkIndex: 1 });
    expect(chunks[2]).toEqual({ startIndex: 18, endIndex: 19, chunkIndex: 2 });
  });

  it('exactly chunkSize pages → single chunk, no next chunk', () => {
    const chunks = buildChunks(10, 10, 1);
    expect(chunks).toHaveLength(1);
  });

  it('11 pages, size=10, overlap=1 → two chunks', () => {
    const chunks = buildChunks(11, 10, 1);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.endIndex).toBe(9);
    expect(chunks[1]!.startIndex).toBe(9); // overlap page repeated
    expect(chunks[1]!.endIndex).toBe(10);
  });

  it('last chunk never exceeds totalPages - 1', () => {
    const chunks = buildChunks(25, 10, 1);
    const last = chunks[chunks.length - 1]!;
    expect(last.endIndex).toBe(24);
  });

  it('chunkIndex increments sequentially', () => {
    const chunks = buildChunks(30, 10, 1);
    chunks.forEach((c, i) => expect(c.chunkIndex).toBe(i));
  });

  it('throws if chunkSize is 0', () => {
    expect(() => buildChunks(10, 0)).toThrow('chunkSize must be > 0');
  });

  it('throws if overlap >= chunkSize', () => {
    expect(() => buildChunks(20, 10, 10)).toThrow('overlap must be < chunkSize');
  });

  it('no overlap=0 still produces valid non-overlapping chunks', () => {
    const chunks = buildChunks(30, 10, 0);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.endIndex + 1).toBe(chunks[1]!.startIndex);
    expect(chunks[1]!.endIndex + 1).toBe(chunks[2]!.startIndex);
  });
});

describe('uniquePagesInChunk', () => {
  it('first chunk contributes all its pages', () => {
    const chunk = { startIndex: 0, endIndex: 9, chunkIndex: 0 };
    expect(uniquePagesInChunk(chunk, 1)).toBe(10);
  });

  it('subsequent chunk subtracts overlap', () => {
    const chunk = { startIndex: 9, endIndex: 18, chunkIndex: 1 };
    expect(uniquePagesInChunk(chunk, 1)).toBe(9);
  });

  it('zero-overlap: all pages unique for every chunk', () => {
    const chunk = { startIndex: 10, endIndex: 19, chunkIndex: 1 };
    expect(uniquePagesInChunk(chunk, 0)).toBe(10);
  });
});
