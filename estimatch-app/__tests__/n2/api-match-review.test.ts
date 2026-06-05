/**
 * Unit tests for the match-review API routes (N3/N4 production paths).
 *
 * All external dependencies (Clerk auth, Prisma, Inngest) are mocked via
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
    n3ZoneCorrespondence: { findMany: vi.fn() },
    n3Zone: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn() },
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { auth } from '@clerk/nextjs/server';
import prisma from '@/lib/prisma';
import { inngest } from '@/lib/inngest/client';
import { GET } from '@/app/api/comparisons/[id]/match-review/route';
import { POST } from '@/app/api/comparisons/[id]/match-review/confirm/route';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPARISON_ID = 'cmp-test-123';
const USER_ID = 'clerk-user-abc';
const DB_USER_ID = 'db-user-xyz';

const mockN3Correspondences = [
  {
    confidence: 0.95,
    yourZones: [{ name: 'Kitchen' }],
    adjusterZones: [{ name: 'Kitchen' }],
  },
];

function makeRequest(path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
      pipelineVersion: 'n4',
    } as never);
    vi.mocked(prisma.n3ZoneCorrespondence.findMany).mockResolvedValue(mockN3Correspondences as never);
    vi.mocked(prisma.n3Zone.findMany)
      .mockResolvedValueOnce([{ name: 'Kitchen' }, { name: 'Garage' }] as never)
      .mockResolvedValueOnce([{ name: 'Kitchen' }] as never);
  });

  it('returns 200 with n3 pairs and unmatched zones', async () => {
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
      pipelineVersion: 'n4',
    } as never);
    const req = makeRequest(`/api/comparisons/${COMPARISON_ID}/match-review`);
    const res = await GET(req, makeParams(COMPARISON_ID));
    expect(res.status).toBe(403);
  });

  it('returns 409 when comparison is not in AWAITING_MATCH_REVIEW', async () => {
    vi.mocked(prisma.comparison.findUnique).mockResolvedValue({
      userId: DB_USER_ID,
      status: 'COMPLETED',
      pipelineVersion: 'n4',
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

  it('returns 409 for unknown pipelineVersion', async () => {
    vi.mocked(prisma.comparison.findUnique).mockResolvedValue({
      userId: DB_USER_ID,
      status: 'AWAITING_MATCH_REVIEW',
      pipelineVersion: null,
    } as never);
    const req = makeRequest(`/api/comparisons/${COMPARISON_ID}/match-review`);
    const res = await GET(req, makeParams(COMPARISON_ID));
    expect(res.status).toBe(409);
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
      pipelineVersion: 'n4',
    } as never);
    vi.mocked(prisma.comparison.update).mockResolvedValue({} as never);
    vi.mocked(inngest.send).mockResolvedValue(undefined as never);
  });

  it('returns 200 ok=true for n4 pipeline', async () => {
    const req = makeRequest(`/api/comparisons/${COMPARISON_ID}/match-review/confirm`, {});
    const res = await POST(req, makeParams(COMPARISON_ID));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; skipped: boolean };
    expect(body.ok).toBe(true);
    expect(body.skipped).toBe(false);
  });

  it('fires n3-correspondence-review.completed Inngest event', async () => {
    const req = makeRequest(`/api/comparisons/${COMPARISON_ID}/match-review/confirm`, {});
    await POST(req, makeParams(COMPARISON_ID));
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'comparison/n3-correspondence-review.completed',
      data: { comparisonId: COMPARISON_ID, action: 'confirmed' },
    });
  });

  it('sets comparison status to PROCESSING', async () => {
    const req = makeRequest(`/api/comparisons/${COMPARISON_ID}/match-review/confirm`, {});
    await POST(req, makeParams(COMPARISON_ID));
    expect(prisma.comparison.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PROCESSING' }) }),
    );
  });

  it('returns skipped:true when already past AWAITING_MATCH_REVIEW', async () => {
    vi.mocked(prisma.comparison.findUnique).mockResolvedValue({
      userId: DB_USER_ID,
      status: 'PROCESSING',
      pipelineVersion: 'n4',
    } as never);
    const req = makeRequest(`/api/comparisons/${COMPARISON_ID}/match-review/confirm`, {});
    const res = await POST(req, makeParams(COMPARISON_ID));
    const body = await res.json() as { ok: boolean; skipped: boolean };
    expect(body.ok).toBe(true);
    expect(body.skipped).toBe(true);
  });

  it('returns 409 for unknown pipelineVersion', async () => {
    vi.mocked(prisma.comparison.findUnique).mockResolvedValue({
      userId: DB_USER_ID,
      status: 'AWAITING_MATCH_REVIEW',
      pipelineVersion: null,
    } as never);
    const req = makeRequest(`/api/comparisons/${COMPARISON_ID}/match-review/confirm`, {});
    const res = await POST(req, makeParams(COMPARISON_ID));
    expect(res.status).toBe(409);
  });

  it('returns 401 when not authenticated', async () => {
    vi.mocked(auth).mockResolvedValue({ userId: null } as never);
    const req = makeRequest(`/api/comparisons/${COMPARISON_ID}/match-review/confirm`, {});
    const res = await POST(req, makeParams(COMPARISON_ID));
    expect(res.status).toBe(401);
  });
});
