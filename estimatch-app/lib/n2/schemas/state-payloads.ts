// ─────────────────────────────────────────────────────────────────────────────
// N2 Pipeline — Zod schemas for ComparisonProcessingState payloads
//
// These schemas validate the JSON blobs read from the `payload` column of
// comparison_processing_state at the START of each step (read boundary).
// They are also used by the state-write helpers to confirm the payload is
// well-formed before persisting.
//
// Each schema mirrors the corresponding TypeScript type in types.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

// ── Shared sub-schemas ────────────────────────────────────────────────────────

const EstimateFormatSchema = z.enum(['xactimate', 'symbility', 'unknown']);

const RoutingDecisionSchema = z.enum([
  'zoned-zoned',
  'flat-flat',
  'zoned-flat',
  'flat-zoned',
  'unknown',
]);

const N2DetectedZoneSchema = z.object({
  name: z.string().min(1),
  startPage: z.number().int(),
  endPage: z.number().int(),
  approxItems: z.number().int().min(0),
  chunkOffset: z.number().int(),
  endPageChunkOffset: z.number().int(),
});

const N2ZoneRefSchema = z.object({
  zone: z.string().min(1),
  pages: z.tuple([z.number().int(), z.number().int()]),
});

const N2ZoneSliceInfoSchema = z.object({
  startPage: z.number().int(),
  endPage: z.number().int(),
  approxItems: z.number().int().min(0),
  chunkOffset: z.number().int(),
  endPageChunkOffset: z.number().int(),
});

const N2MatchedZonePairSchema = z.object({
  e1Zones: z.array(N2ZoneRefSchema).min(1),
  e2Zones: z.array(N2ZoneRefSchema).min(1),
  canonical: z.string().min(1),
  isMerged: z.boolean(),
  confidence: z.number().int().min(50).max(100),
});

// ── Stage: n2:zones_detected ──────────────────────────────────────────────────

export const N2ZonesDetectedPayloadSchema = z.object({
  e1Zones: z.array(N2DetectedZoneSchema),
  e2Zones: z.array(N2DetectedZoneSchema),
  e1Format: EstimateFormatSchema,
  e2Format: EstimateFormatSchema,
  routingDecision: RoutingDecisionSchema,
});

export type N2ZonesDetectedPayloadParsed = z.infer<typeof N2ZonesDetectedPayloadSchema>;

// ── Stage: n2:zones_corrected ─────────────────────────────────────────────────

const MatchHintSchema = z.object({
  pdfA: z.string().min(1),
  pdfB: z.union([z.string().min(1), z.array(z.string().min(1))]),
  reason: z.string().min(1),
});

const ConfirmedUniqueZoneSchema = z.object({
  pdf: z.enum(['A', 'B']),
  zone: z.string().min(1),
  reason: z.string().min(1),
});

export const N2ZonesCorrectedPayloadSchema = z.object({
  e1Zones: z.array(N2DetectedZoneSchema),
  e2Zones: z.array(N2DetectedZoneSchema),
  e1Format: EstimateFormatSchema,
  e2Format: EstimateFormatSchema,
  routingDecision: RoutingDecisionSchema,
  matchHints: z.array(MatchHintSchema),
  confirmedUniqueZones: z.array(ConfirmedUniqueZoneSchema),
});

export type N2ZonesCorrectedPayloadParsed = z.infer<typeof N2ZonesCorrectedPayloadSchema>;
export type MatchHint = z.infer<typeof MatchHintSchema>;
export type ConfirmedUniqueZone = z.infer<typeof ConfirmedUniqueZoneSchema>;

// ── Stage: n2:zones_matched ───────────────────────────────────────────────────

export const N2ZonesMatchedPayloadSchema = z.object({
  matched: z.array(N2MatchedZonePairSchema),
  unmatchedE1: z.array(N2ZoneRefSchema),
  unmatchedE2: z.array(N2ZoneRefSchema),
  e1Format: EstimateFormatSchema,
  e2Format: EstimateFormatSchema,
  routingDecision: RoutingDecisionSchema,
  e1ZoneMeta: z.record(z.string(), N2ZoneSliceInfoSchema),
  e2ZoneMeta: z.record(z.string(), N2ZoneSliceInfoSchema),
});

export type N2ZonesMatchedPayloadParsed = z.infer<typeof N2ZonesMatchedPayloadSchema>;

// ── Stage: n2:zones_extracted ─────────────────────────────────────────────────

const N2MatchStatusSchema = z.enum([
  'MATCH',
  'MODIFIED',
  'MISSING_FROM_ADJUSTER',
  'ADDED_BY_ADJUSTER',
]);

const N2ExtractedItemSchema = z.object({
  n: z.number().int(),
  d: z.string().min(1),
  q: z.string().nullable(),
  u: z.string().nullable(),
  rm: z.number().nullable(),
  rp: z.number().nullable(),
  rs: z.number().nullable(),
  tx: z.number().nullable(),
  op: z.number().nullable(),
  t: z.number().nullable(),
});

const N2ItemPairSchema = z
  .object({
    status: N2MatchStatusSchema,
    e1: N2ExtractedItemSchema.nullable(),
    e2: N2ExtractedItemSchema.nullable(),
    resolutionSource: z
      .enum(['deterministic', 'tier1', 'tier2', 'ai-standard'])
      .optional(),
    // Set ONLY by Pass 5 cross-zone reconciliation on accepted cross-zone
    // pairs. Carries the original contractor and adjuster zone names so
    // persistResults can populate LineItem.zoneYours / LineItem.zoneAdjuster
    // with the real home zones (the synthetic CROSS ZONE MATCHES zoneMeta
    // has null zoneYours/zoneAdjuster — origin info is per-item, not per-zone).
    crossZoneOrigin: z
      .object({
        e1Zone: z.string().min(1),
        e2Zone: z.string().min(1),
      })
      .optional(),
  })
  .superRefine((pair, ctx) => {
    if (
      (pair.status === 'MATCH' || pair.status === 'MODIFIED') &&
      (pair.e1 === null || pair.e2 === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${pair.status} pair must have both e1 and e2 non-null`,
      });
    }
    if (pair.status === 'MISSING_FROM_ADJUSTER' && pair.e1 === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MISSING_FROM_ADJUSTER pair must have e1 non-null',
      });
    }
    if (pair.status === 'ADDED_BY_ADJUSTER' && pair.e2 === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ADDED_BY_ADJUSTER pair must have e2 non-null',
      });
    }
  });

const N2ZoneResultSchema = z.object({
  pairs: z.array(N2ItemPairSchema),
});

const N2ZoneMetaSchema = z.object({
  canonical: z.string().min(1),
  zoneYours: z.union([z.string(), z.array(z.string().min(1))]).nullable(),
  zoneAdjuster: z.union([z.string(), z.array(z.string().min(1))]).nullable(),
  confidence: z.number().int().min(0).max(100),
  isMerged: z.boolean(),
});

export const N2ZonesExtractedPayloadSchema = z.object({
  zoneResults: z.record(z.string(), N2ZoneResultSchema),
  zoneMeta: z.record(z.string(), N2ZoneMetaSchema),
  routingDecision: RoutingDecisionSchema,
});

export type N2ZonesExtractedPayloadParsed = z.infer<typeof N2ZonesExtractedPayloadSchema>;
