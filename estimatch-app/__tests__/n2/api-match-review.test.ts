/**
 * Unit tests for the match-review API routes.
 *
 * All external dependencies (Clerk auth, Prisma, n2-state) are mocked via
 * vi.mock() so no database or network calls occur.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    comparison: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('@/lib/n2/utils/n2-state', () => ({
  readZonesMatched: vi.fn(),
  writeN2Stage: vi.fn(),
  N2_STAGE_ZONES_MATCHED: 'n2:zones_matched',
}));

vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn() },
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { auth } from '@clerk/nextjs/server';
import prisma from '@/lib/prisma';
import { readZonesMatched, writeN2Stage } from '@/lib/n2/utils/n2-state';
import { inngest } from '@/lib/inngest/client';
import { GET } from '@/app/api/comparisons/[id]/match-review/route';
import { POST } from '@/app/api/comparisons/[id]/match-review/confirm/route';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPARISON_ID = 'cmp-test-123';
const USER_ID = 'clerk-user-abc';
const DB_USER_ID = 'db-user-xyz';

const mockZonesMatched = {
  matched: [
    {
      e1Zones: [{ zone: 'Kitchen', pages: [1, 5] }],
      e2Zones: [{ zone: 'Kitchen', pages: [3, 7] }],
      canonical: 'Kitchen',
      isMerged: false,
      confidence: 95,
    },
  ],
  unmatchedE1: [{ zone: 'Garage', pages: [13, 16] }],
  unmatchedE2: [],
  e1Format: 'xactimate' as const,
  e2Format: 'xactimate' as const,
  routingDecision: 'standard' as const,
  e1ZoneMeta: { 'Kitchen_p1': { startPage: 1, endPage: 5, approxItems: 20, chunkOffset: 0, endPageChunkOffset: 0 } },
  e2ZoneMeta: { 'Kitchen_p3': { startPage: 3, endPage: 7, approxItems: 18, chunkOffset: 0, endPageChunkOffset: 0 } },
};

function makeRequest(path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

// ── GET /api/comparisons/[id]/match-review ────────────────────────────────────

describe('GET /api/comparisons/[id]/match-review', () => {
  beforeEach(() => {
    vi.mocked(auth).mockResolvedValue({ userId: USER_ID } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: DB_USER_ID } as never);
    vi.mocked(prisma.comparison.findUnique).mockResolvedValue({
      userId: DB_USER_ID,
      status: 'AWAITING_MATCH_REVIEW',
    } as never);
    vi.mocked(readZonesMatched).mockResolvedValue(mockZonesMatched as never);
  });

  it('returns 200 with pairs + unmatched zones', async () => {
    const req = makeRequest(`/api/comparisons/${COMPARISON_ID}/match-review`);
    const res = await GET(req, makeParams(COMPARISON_ID));
    expect(res.status).toBe(200);
    const body = await res.json() as { pairs: unknown[]; unmatchedE1: string[]; unmatchedE2: string[] };
    expect(body.pairs).toHaveLength(1);
    expect(body.unmatchedE1).toEqual(['Garage']);
    expect(body.unmatchedE2).toEqual([]);
  });

  it('returns 401 when not authenticated', async () => {
    vi.mocked(auth).mockResolvedValue({ userId: null } as never);
    const req = makeRequest(`/api/comparisons/${COMPARISON_ID}/match-review`);
    const res = await GET(req, makeParams(COMPARISON_ID));
    expect(res.status).toBe(401);
  });

  it('returns 403 when comparison belongs to a different user', async () => {
    vi.mocked(prisma.comparison.findUnique).mockResolvedValue({
      userId: 'other-user-id',
      status: 'AWAITING_MATCH_REVIEW',
    } as never);
    const req = makeRequest(`/api/comparisons/${COMPARISON_ID}/match-review`);
    const res = await GET(req, makeParams(COMPARISON_ID));
    expect(res.status).toBe(403);
  });

  it('returns 409 when comparison is not in AWAITING_MATCH_REVIEW', async () => {
    vi.mocked(prisma.comparison.findUnique).mockResolvedValue({
      userId: DB_USER_ID,
      status: 'COMPLETED',
    } as never);
    const req = makeRequest(`/api/comparisons/${COMPARISON_ID}/match-review`);
    const res = await GET(req, makeParams(COMPARISON_ID));
    expect(res.status).toBe(409);
  });

  it('returns 404 when comparison not found', async () => {
    vi.mocked(prisma.comparison.findUnique).mockResolvedValue(null);
    const req = makeRequest(`/api/comparisons/${COMPARISON_ID}/match-review`);
    const res = await GET(req, makeParams(COMPARISON_ID));
    expect(res.status).toBe(404);
  });

  it('returns 500 when zones_matched state is missing', async () => {
    vi.mocked(readZonesMatched).mockResolvedValue(null);
    const req = makeRequest(`/api/comparisons/${COMPARISON_ID}/match-review`);
    const res = await GET(req, makeParams(COMPARISON_ID));
    expect(res.status).toBe(500);
  });
});

// ── POST /api/comparisons/[id]/match-review/confirm ───────────────────────────

describe('POST /api/comparisons/[id]/match-review/confirm', () => {
  beforeEach(() => {
    vi.mocked(auth).mockResolvedValue({ userId: USER_ID } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: DB_USER_ID } as never);
    vi.mocked(prisma.comparison.findUnique).mockResolvedValue({
      userId: DB_USER_ID,
      status: 'AWAITING_MATCH_REVIEW',
    } as never);
    vi.mocked(prisma.comparison.update).mockResolvedValue({} as never);
    vi.mocked(readZonesMatched).mockResolvedValue(mockZonesMatched as never);
    vi.mocked(writeN2Stage).mockResolvedValue(undefined);
    vi.mocked(inngest.send).mockResolvedValue(undefined as never);
  });

  it('returns 200 ok=true on valid confirmation', async () => {
    const req = makeRequest(`/api/comparisons/${COMPARISON_ID}/match-review/confirm`, {
      e1Slots: ['Kitchen', 'Garage'],
      e2Slots: ['Kitchen', null],
    });
    const res = await POST(req, makeParams(COMPARISON_ID));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; skipped: boolean };
    expect(body.ok).toBe(true);
    expect(body.skipped).toBe(false);
  });

  it('writes updated payload to state', async () => {
    const req = makeRequest(`/api/comparisons/${COMPARISON_ID}/match-review/confirm`, {
      e1Slots: ['Kitchen'],
      e2Slots: ['Kitchen'],
    });
    await POST(req, makeParams(COMPARISON_ID));
    expect(writeN2Stage).toHaveBeenCalledWith(
      COMPARISON_ID,
      'n2:zones_matched',
      expect.objectContaining({ matched: expect.any(Array) }),
    );
  });

  it('fires Inngest match-review.completed event', async () => {
    const req = makeRequest(`/api/comparisons/${COMPARISON_ID}/match-review/confirm`, {
      e1Slots: ['Kitchen'],
      e2Slots: ['Kitchen'],
    });
    await POST(req, makeParams(COMPARISON_ID));
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'comparison/match-review.completed',
      data: { comparisonId: COMPARISON_ID },
    });
  });

  it('sets comparison status to PROCESSING', async () => {
    const req = makeRequest(`/api/comparisons/${COMPARISON_ID}/match-review/confirm`, {
      e1Slots: ['Kitchen'],
      e2Slots: ['Kitchen'],
    });
    await POST(req, makeParams(COMPARISON_ID));
    expect(prisma.comparison.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PROCESSING' }) }),
    );
  });

  it('returns skipped:true when already past AWAITING_MATCH_REVIEW', async () => {
    vi.mocked(prisma.comparison.findUnique).mockResolvedValue({
      userId: DB_USER_ID,
      status: 'PROCESSING',
    } as never);
    const req = makeRequest(`/api/comparisons/${COMPARISON_ID}/match-review/confirm`, {
      e1Slots: ['Kitchen'],
      e2Slots: ['Kitchen'],
    });
    const res = await POST(req, makeParams(COMPARISON_ID));
    const body = await res.json() as { ok: boolean; skipped: boolean };
    expect(body.ok).toBe(true);
    expect(body.skipped).toBe(true);
  });

  it('returns 400 when slot arrays have different lengths', async () => {
    const req = makeRequest(`/api/comparisons/${COMPARISON_ID}/match-review/confirm`, {
      e1Slots: ['Kitchen', 'Bathroom'],
      e2Slots: ['Kitchen'],
    });
    const res = await POST(req, makeParams(COMPARISON_ID));
    expect(res.status).toBe(400);
  });

  it('returns 400 when body is invalid JSON', async () => {
    const req = new NextRequest(
      `http://localhost:3000/api/comparisons/${COMPARISON_ID}/match-review/confirm`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not-json' },
    );
    const res = await POST(req, makeParams(COMPARISON_ID));
    expect(res.status).toBe(400);
  });

  it('returns 401 when not authenticated', async () => {
    vi.mocked(auth).mockResolvedValue({ userId: null } as never);
    const req = makeRequest(`/api/comparisons/${COMPARISON_ID}/match-review/confirm`, {
      e1Slots: [],
      e2Slots: [],
    });
    const res = await POST(req, makeParams(COMPARISON_ID));
    expect(res.status).toBe(401);
  });
});
