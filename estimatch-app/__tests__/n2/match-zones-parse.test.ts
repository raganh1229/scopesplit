/**
 * Tests for the match-zones Zod schema validation and the confirm route's
 * slot-to-payload reconstruction logic.
 *
 * These tests are schema/logic focused — no real HTTP calls, no Anthropic API.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// ── Inline the same schemas used by match-zones.ts ───────────────────────────
// (Replicating here so we test the shape independently of the implementation.)

const ZoneRefRawSchema = z.object({
  zone: z.string().min(1),
  pages: z.tuple([z.number().int(), z.number().int()]),
});

const MatchedPairRawSchema = z.object({
  e1Zones: z.array(ZoneRefRawSchema).min(1),
  e2Zones: z.array(ZoneRefRawSchema).min(1),
  canonical: z.string().min(1),
  isMerged: z.boolean(),
  confidence: z.number().int().min(50).max(100),
});

const MatchZonesResponseSchema = z.object({
  matched: z.array(MatchedPairRawSchema),
  unmatchedE1: z.array(ZoneRefRawSchema),
  unmatchedE2: z.array(ZoneRefRawSchema),
});

// ── Valid response examples ───────────────────────────────────────────────────

const validResponse = {
  matched: [
    {
      e1Zones: [{ zone: 'Kitchen', pages: [1, 5] }],
      e2Zones: [{ zone: 'Kitchen', pages: [3, 7] }],
      canonical: 'Kitchen',
      isMerged: false,
      confidence: 100,
    },
    {
      e1Zones: [{ zone: 'Master Suite', pages: [6, 12] }],
      e2Zones: [
        { zone: 'Master Bedroom', pages: [8, 11] },
        { zone: 'Master Bathroom', pages: [12, 14] },
      ],
      canonical: 'Master Suite',
      isMerged: true,
      confidence: 85,
    },
  ],
  unmatchedE1: [{ zone: 'Garage', pages: [13, 16] }],
  unmatchedE2: [],
};

describe('MatchZonesResponseSchema', () => {
  it('accepts a valid match-zones response', () => {
    const result = MatchZonesResponseSchema.safeParse(validResponse);
    expect(result.success).toBe(true);
  });

  it('accepts empty matched array (all zones unmatched)', () => {
    const result = MatchZonesResponseSchema.safeParse({
      matched: [],
      unmatchedE1: [{ zone: 'General', pages: [1, 80] }],
      unmatchedE2: [{ zone: 'General', pages: [1, 60] }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects confidence below 50', () => {
    const bad = {
      ...validResponse,
      matched: [
        {
          ...validResponse.matched[0],
          confidence: 49,
        },
      ],
    };
    const result = MatchZonesResponseSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects confidence above 100', () => {
    const bad = {
      ...validResponse,
      matched: [{ ...validResponse.matched[0]!, confidence: 101 }],
    };
    expect(MatchZonesResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects empty e1Zones array', () => {
    const bad = {
      ...validResponse,
      matched: [{ ...validResponse.matched[0]!, e1Zones: [] }],
    };
    expect(MatchZonesResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects empty e2Zones array', () => {
    const bad = {
      ...validResponse,
      matched: [{ ...validResponse.matched[0]!, e2Zones: [] }],
    };
    expect(MatchZonesResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects missing canonical field', () => {
    const bad = {
      ...validResponse,
      matched: [
        {
          e1Zones: [{ zone: 'Kitchen', pages: [1, 5] }],
          e2Zones: [{ zone: 'Kitchen', pages: [3, 7] }],
          // canonical intentionally omitted
          isMerged: false,
          confidence: 100,
        },
      ],
    };
    expect(MatchZonesResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects zone ref with empty string name', () => {
    const bad = {
      ...validResponse,
      unmatchedE1: [{ zone: '', pages: [1, 5] }],
    };
    expect(MatchZonesResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts isMerged: true for 1:many pairs', () => {
    const mergedPair = validResponse.matched[1]!; // Master Suite example
    expect(MatchedPairRawSchema.safeParse(mergedPair).success).toBe(true);
    expect(mergedPair.isMerged).toBe(true);
    expect(mergedPair.e2Zones).toHaveLength(2);
  });

  it('pages tuple must have exactly two integers', () => {
    const bad = { zone: 'Kitchen', pages: [1] }; // only one element
    expect(ZoneRefRawSchema.safeParse(bad).success).toBe(false);
  });
});

// ── Confirm route slot reconstruction logic ───────────────────────────────────

/**
 * Tests the core reconstruction algorithm used in the confirm route:
 * given slot arrays, produce matched/unmatchedE1/unmatchedE2.
 */
function reconstructFromSlots(
  e1Slots: (string | null)[],
  e2Slots: (string | null)[],
) {
  const matched: Array<{ e1: string; e2: string }> = [];
  const unmatchedE1: string[] = [];
  const unmatchedE2: string[] = [];

  for (let i = 0; i < e1Slots.length; i++) {
    const e1 = e1Slots[i] ?? null;
    const e2 = e2Slots[i] ?? null;
    if (e1 && e2) matched.push({ e1, e2 });
    else if (e1 && !e2) unmatchedE1.push(e1);
    else if (!e1 && e2) unmatchedE2.push(e2);
    // both null → blank filler row, skip
  }

  return { matched, unmatchedE1, unmatchedE2 };
}

describe('confirm route slot reconstruction', () => {
  it('basic paired slots produce matched array', () => {
    const out = reconstructFromSlots(['Kitchen', 'Bathroom'], ['Kitchen', 'Bath']);
    expect(out.matched).toHaveLength(2);
    expect(out.unmatchedE1).toHaveLength(0);
    expect(out.unmatchedE2).toHaveLength(0);
  });

  it('e1 with null e2 → unmatchedE1', () => {
    const out = reconstructFromSlots(['Garage', null], [null, null]);
    expect(out.unmatchedE1).toContain('Garage');
    expect(out.matched).toHaveLength(0);
  });

  it('null e1 with e2 → unmatchedE2', () => {
    const out = reconstructFromSlots([null], ['Garage']);
    expect(out.unmatchedE2).toContain('Garage');
    expect(out.matched).toHaveLength(0);
  });

  it('both null → filler row, skipped', () => {
    const out = reconstructFromSlots([null, 'Kitchen'], [null, 'Kitchen']);
    expect(out.matched).toHaveLength(1); // only the Kitchen pair
  });

  it('user moved Kitchen to match Bathroom (re-pairing)', () => {
    // Originally AI matched Kitchen↔Kitchen and Bathroom↔Bathroom
    // User drags Bathroom into Kitchen's e2 slot
    const out = reconstructFromSlots(
      ['Kitchen', 'Bathroom', null],
      ['Bathroom', null, 'Kitchen'],
    );
    expect(out.matched[0]).toEqual({ e1: 'Kitchen', e2: 'Bathroom' });
    expect(out.unmatchedE1).toContain('Bathroom');
    expect(out.unmatchedE2).toContain('Kitchen');
  });

  it('all slots null → no output', () => {
    const out = reconstructFromSlots([null, null], [null, null]);
    expect(out.matched).toHaveLength(0);
    expect(out.unmatchedE1).toHaveLength(0);
    expect(out.unmatchedE2).toHaveLength(0);
  });
});
