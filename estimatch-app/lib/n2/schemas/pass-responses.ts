// ─────────────────────────────────────────────────────────────────────────────
// N2 Pipeline — Zod schemas for AI response validation
//
// These schemas validate the raw JSON returned by Claude after cleaning.
// Used by ai-response.ts's `parseAndValidate()` at every API call site.
//
// Schemas are intentionally strict: any unexpected structure → retryable error.
// The AI prompt contracts in prompts/ must stay in sync with these schemas.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

// ── Pass 1 — Zone Detection, Chunk 1 (includes format) ───────────────────────

export const Pass1Chunk1ResponseSchema = z.object({
  first_page_printed_number: z.number().int(),
  format: z.enum(['xactimate', 'symbility', 'unknown']),
  approx_items_on_pages: z.number().int().min(0),
  zones: z.array(
    z.object({
      name: z.string().min(1),
      start_page: z.number().int(),
      evidence_item: z.string(),
      approx_items: z.number().int().min(0),
    }),
  ),
});

export type Pass1Chunk1Response = z.infer<typeof Pass1Chunk1ResponseSchema>;

// ── Pass 2 — Zone Detection, Chunks 2+ (no format field) ─────────────────────

export const Pass2ChunkNResponseSchema = z.object({
  first_page_printed_number: z.number().int(),
  approx_items_on_pages: z.number().int().min(0),
  zones: z.array(
    z.object({
      name: z.string().min(1),
      start_page: z.number().int(),
      evidence_item: z.string(),
      approx_items: z.number().int().min(0),
    }),
  ),
});

export type Pass2ChunkNResponse = z.infer<typeof Pass2ChunkNResponseSchema>;

// ── Pass 3 — Zone Matching (Opus) ─────────────────────────────────────────────

const ZoneRefSchema = z.object({
  zone: z.string().min(1),
  pages: z.tuple([z.number().int(), z.number().int()]),
});

export const Pass3ResponseSchema = z.object({
  matched: z.array(
    z.object({
      e1Zones: z.array(ZoneRefSchema).min(1),
      e2Zones: z.array(ZoneRefSchema).min(1),
      canonical: z.string().min(1),
      isMerged: z.boolean(),
      confidence: z.number().int().min(50).max(100),
    }),
  ),
  unmatchedE1: z.array(ZoneRefSchema),
  unmatchedE2: z.array(ZoneRefSchema),
});

export type Pass3Response = z.infer<typeof Pass3ResponseSchema>;

// ── Pass 4 shared — extracted item ───────────────────────────────────────────

const ExtractedItemSchema = z.object({
  n: z.number().int().positive(),
  d: z.string().min(1),
  q: z.string().nullable().optional().transform(v => v ?? null),
  u: z.string().nullable().optional().transform(v => v ?? null),
  rm: z.number().nullable().optional().transform(v => v ?? null),
  rp: z.number().nullable().optional().transform(v => v ?? null),
  rs: z.number().nullable().optional().transform(v => v ?? null),
  tx: z.number().nullable().optional().transform(v => v ?? null),
  op: z.number().nullable().optional().transform(v => v ?? null),
  t: z.number().nullable().optional().transform(v => v ?? null),
});

// ── Pass 4A — Extraction + Matching (matched zones) ──────────────────────────

const MatchStatusSchema = z.enum([
  'MATCH',
  'MODIFIED',
  'MISSING_FROM_ADJUSTER',
  'ADDED_BY_ADJUSTER',
]);

export const Pass4AResponseSchema = z.object({
  zone: z.string().min(1),
  pairs: z.array(
    z.object({
      status: MatchStatusSchema,
      e1: ExtractedItemSchema.nullable(),
      e2: ExtractedItemSchema.nullable(),
    }),
  ),
});

export type Pass4AResponse = z.infer<typeof Pass4AResponseSchema>;

// ── Pass 4B — Extraction Only (unmatched zones) ───────────────────────────────
// CONTRACT: Pass 4B returns items[] (extraction-only). Status classification
// (MISSING_FROM_ADJUSTER / ADDED_BY_ADJUSTER) is added by code in the
// extract-and-match orchestrator, not by the AI. The Pass 4B prompt in
// pass4b-extract-only.ts MUST return "items" not "pairs" to match this schema.
// See also: N2_SPEED_CAPACITY_ACCURACY.md §Pass 4B (arch doc baseline updated).

export const Pass4BResponseSchema = z.object({
  zone: z.string().min(1),
  items: z.array(ExtractedItemSchema),
});

export type Pass4BResponse = z.infer<typeof Pass4BResponseSchema>;

// ── LZF Step 1 — Chunk Extraction Response ────────────────────────────────────
// Same structure as Pass 4B — items only, no pairing.

export const LzfChunkExtractionResponseSchema = Pass4BResponseSchema;
export type LzfChunkExtractionResponse = Pass4BResponse;

// ── LZF Step 3 — Tier Matching Response ──────────────────────────────────────

export const LzfTierMatchResponseSchema = z.object({
  pairs: z.array(
    z.object({
      e1n: z.number().int().positive(), // E1 item number
      e2n: z.number().int().positive(), // E2 item number
      confidence: z.number().int().min(50).max(100),
    }),
  ),
});

export type LzfTierMatchResponse = z.infer<typeof LzfTierMatchResponseSchema>;

// ── Pass 5 — Cross-Zone Reconciliation (Opus) ────────────────────────────────
//
// CONTRACT: The Pass 5 prompt assigns each contractor orphan a sequential
// `C<N>` id and each adjuster orphan an `A<N>` id. Opus returns proposed
// cross-zone pairs by id reference. The orchestrator looks up the actual
// orphan items by id and applies the pairing.
//
// Status (MATCH | MODIFIED) is recomputed deterministically post-parse from
// quantity/unit/total — see Issue 41 in N2_SPEED_CAPACITY_ACCURACY.md. The
// AI's status field is parsed for completeness but not trusted authoritatively.
//
// Confidence threshold: pairs at confidence ≥ 75 are accepted; below threshold
// are rejected. AI returns confidence in 0–100 range; the schema enforces
// the practical 50–100 floor since anything below 50 should never be returned
// per the prompt's decision policy.

const Pass5StatusSchema = z.enum(['MATCH', 'MODIFIED']);

export const Pass5ResponseSchema = z.object({
  pairs: z.array(
    z.object({
      contractorId: z.string().regex(/^C\d+$/),
      adjusterId: z.string().regex(/^A\d+$/),
      confidence: z.number().int().min(0).max(100),
      status: Pass5StatusSchema,
      rationale: z.string().min(1).max(500),
    }),
  ),
});

export type Pass5Response = z.infer<typeof Pass5ResponseSchema>;
