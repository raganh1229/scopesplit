// ─────────────────────────────────────────────────────────────────────────────
// N2 Pipeline — canonical TypeScript types
//
// This is the single source of truth for all shared types across the N2
// pipeline. All passes, utilities, and Inngest steps import from here.
//
// Mirrors the JSON contracts defined in N2_SPEED_CAPACITY_ACCURACY.md.
// Do NOT duplicate these types in other files — import them.
// ─────────────────────────────────────────────────────────────────────────────

// ── Enums / Literals ──────────────────────────────────────────────────────────

export type EstimateFormat = 'xactimate' | 'symbility' | 'unknown' | 'xls';

export type RoutingDecision =
  | 'zoned-zoned'
  | 'flat-flat'
  | 'zoned-flat'
  | 'flat-zoned'
  | 'unknown';

export type N2MatchStatus =
  | 'MATCH'
  | 'MODIFIED'
  | 'MISSING_FROM_ADJUSTER'
  | 'ADDED_BY_ADJUSTER';

/** Tracks which part of the LZF pipeline produced a given pair. */
export type ResolutionSource = 'deterministic' | 'tier1' | 'tier2' | 'ai-standard';

// ── Zone Keys ─────────────────────────────────────────────────────────────────

/**
 * Unique key for a zone entry, combining the verbatim zone name and its
 * printed start-page number. Used as the dictionary key in state payloads.
 *
 * Examples: "Kitchen_p5", "Master Suite_p12", "1st Floor - Lobby_p34"
 */
export function zoneKey(name: string, startPage: number): string {
  return `${name}_p${startPage}`;
}

// ── Zone Detection (Pass 1/2) ─────────────────────────────────────────────────

/**
 * A single zone as detected and merged from Pass 1/2.
 *
 * `chunkOffset`: converts a printed page number to a pdf-lib 0-based internal
 * page index for slicing:
 *   internalIndex = printedPageNumber + chunkOffset
 *
 * Computed at merge time: offset = startInternalIndex − firstPagePrintedNumber
 * for the chunk in which this zone's header was first detected.
 */
export type N2DetectedZone = {
  name: string;
  startPage: number;        // printed page number as it appears in the PDF
  endPage: number;          // next zone's startPage printed number (inclusive shared boundary);
                            // last zone = last printed page of the document
  approxItems: number;      // AI estimate of line items in this zone
  chunkOffset: number;      // from the chunk that detected THIS zone's start:
                            //   internalStart = startPage + chunkOffset
  endPageChunkOffset: number; // from the chunk that detected the NEXT zone's start:
                            //   internalEnd = endPage + endPageChunkOffset
                            // last zone: set to (totalPageCount - 1 - lastPrintedPage) so
                            //   internalEnd = lastPrintedPage + endPageChunkOffset = totalPageCount - 1
};

// ── Zone Matching (Pass 3) ────────────────────────────────────────────────────

/** A zone reference as returned by Pass 3 output (name + page range). */
export type N2ZoneRef = {
  zone: string;          // verbatim zone name
  pages: [number, number]; // [startPage, endPage] — printed page numbers
};

/** A matched pair from Pass 3. Both sides are arrays to support 1:many. */
export type N2MatchedZonePair = {
  e1Zones: N2ZoneRef[];
  e2Zones: N2ZoneRef[];
  canonical: string; // longest/most specific name chosen by Opus
  isMerged: boolean; // true when one side has >1 zone
  confidence: number; // 50–100
};

/** An unmatched zone reference from Pass 3. */
export type N2UnmatchedZone = N2ZoneRef;

// ── Zone Slice Info (carry-forward for Step 4) ────────────────────────────────

/**
 * Slice metadata for a zone needed by Step 4 to cut sub-PDFs.
 * Keyed by zoneKey(name, startPage) in zones_matched payload.
 */
export type N2ZoneSliceInfo = {
  startPage: number;
  endPage: number;          // inclusive shared boundary (next zone's startPage)
  approxItems: number;
  chunkOffset: number;      // internalStart = startPage + chunkOffset
  endPageChunkOffset: number; // internalEnd = endPage + endPageChunkOffset
};

// ── Line Item Extraction (Pass 4 / LZF) ──────────────────────────────────────

/**
 * A single line item as extracted by Pass 4A, 4B, or LZF Step 1.
 * Field names are intentionally short (matching the AI prompt schema)
 * to minimise token count in AI responses.
 *
 * n  = item number (integer from PDF; used for sort ordering only — not stored in DB)
 * d  = description
 * q  = quantity string (e.g. "120.00")
 * u  = unit code (e.g. "SF", "LF", "EA")
 * rm = remove cost
 * rp = replace cost
 * rs = reset cost
 * tx = tax
 * op = overhead & profit
 * t  = total (rightmost cost column)
 */
export type N2ExtractedItem = {
  n: number;
  d: string;
  q: string | null;
  u: string | null;
  rm: number | null;
  rp: number | null;
  rs: number | null;
  tx: number | null;
  op: number | null;
  t: number | null;
};

/** A matched/classified item pair — the atomic output unit of Pass 4. */
export type N2ItemPair = {
  status: N2MatchStatus;
  e1: N2ExtractedItem | null; // null for ADDED_BY_ADJUSTER
  e2: N2ExtractedItem | null; // null for MISSING_FROM_ADJUSTER
  resolutionSource?: ResolutionSource; // present on LZF pairs; omitted on standard pairs
  /**
   * Set ONLY by Pass 5 (cross-zone reconciliation) on pairs that promote a
   * MISSING contractor item + an ADDED adjuster item from two different home
   * zones into a unified MATCH/MODIFIED. Carries the original zone names so
   * persistResults can populate LineItem.zoneYours / LineItem.zoneAdjuster
   * with the contractor's and adjuster's actual home zones (rather than the
   * synthetic CROSS ZONE MATCHES canonical name).
   *
   * Absent on every Pass 4 / LZF pair.
   */
  crossZoneOrigin?: { e1Zone: string; e2Zone: string };
};

/** Extraction + matching result for a single zone. */
export type N2ZoneResult = {
  pairs: N2ItemPair[];
};

// ── Pass 5 — Cross-Zone Reconciliation ───────────────────────────────────────

/**
 * Canonical name of the synthetic zone Pass 5 emits when it accepts at least
 * one cross-zone item pair. All accepted Pass 5 pairs file under this single
 * zone in the persisted output. Items retain their original contractor and
 * adjuster zone names via N2ItemPair.crossZoneOrigin so the UI can render
 * "originally filed under '<contractor zone>' / '<adjuster zone>'".
 *
 * The dashboard renders this zone with stylistic differentiation (color band,
 * icon, or shading) and a tooltip explaining the cross-zone semantics.
 *
 * Architecture: see N2_SPEED_CAPACITY_ACCURACY.md §Pass 5, Issues 39–41.
 */
export const CROSS_ZONE_MATCHES_ZONE_NAME = 'CROSS ZONE MATCHES';

/**
 * resultKey used inside zoneResults / zoneMeta dicts for the synthetic
 * Pass 5 zone. Single key — there is at most one CROSS ZONE MATCHES entry
 * per comparison.
 */
export const CROSS_ZONE_MATCHES_RESULT_KEY = 'cross_zone_matches';

// ── Zone Meta (Pass 3 → Step 5) ───────────────────────────────────────────────

/**
 * Zone metadata derived from Pass 3. Carried through zones_extracted so
 * Step 5 can populate the zone* columns on LineItem without re-reading
 * zones_matched from state.
 *
 * zoneYours is null for adjuster-only (ADDED_BY_ADJUSTER) zones.
 * zoneAdjuster is null for contractor-only (MISSING_FROM_ADJUSTER) zones.
 *
 * Either field can be an array when isMerged=true and that side is the
 * many-side of a 1:many match (e.g. zoneAdjuster: ["Master Bedroom",
 * "Master Bathroom"] when E1's "Master Suite" maps to two E2 zones).
 */
export type N2ZoneMeta = {
  canonical: string;
  zoneYours: string | string[] | null;
  zoneAdjuster: string | string[] | null;
  confidence: number;
  isMerged: boolean;
};

// ── State Payload Types ───────────────────────────────────────────────────────

/**
 * Payload written to ComparisonProcessingState after Step 2 (detect-zones).
 * Stage key: 'n2:zones_detected'
 */
export type N2ZonesDetectedPayload = {
  e1Zones: N2DetectedZone[];
  e2Zones: N2DetectedZone[];
  e1Format: EstimateFormat;
  e2Format: EstimateFormat;
  routingDecision: RoutingDecision;
};

/**
 * Payload written to ComparisonProcessingState after Step 3 (match-zones).
 * Stage key: 'n2:zones_matched'
 *
 * Carries forward all fields from zones_detected that Step 4 needs, so
 * Step 4 never has to read an earlier state stage.
 */
export type N2ZonesMatchedPayload = {
  matched: N2MatchedZonePair[];
  unmatchedE1: N2UnmatchedZone[];
  unmatchedE2: N2UnmatchedZone[];
  // carry-forward from zones_detected:
  e1Format: EstimateFormat;
  e2Format: EstimateFormat;
  routingDecision: RoutingDecision;
  // per-zone slice metadata; keyed by zoneKey(verbatimName, startPage)
  e1ZoneMeta: Record<string, N2ZoneSliceInfo>;
  e2ZoneMeta: Record<string, N2ZoneSliceInfo>;
};

/**
 * Payload written to ComparisonProcessingState after Step 4 (extract-and-match).
 * Stage key: 'n2:zones_extracted'
 *
 * zoneResults keys for matched zones:    zoneKey(canonical, e1StartPage)
 * zoneResults keys for unmatched E1:     'e1_' + zoneKey(name, startPage)
 * zoneResults keys for unmatched E2:     'e2_' + zoneKey(name, startPage)
 */
export type N2ZonesExtractedPayload = {
  zoneResults: Record<string, N2ZoneResult>;
  zoneMeta: Record<string, N2ZoneMeta>;
  routingDecision: RoutingDecision;
};
