// ─────────────────────────────────────────────────────────────────────────────
// N4 Pipeline — Extractor contract
//
// Every estimate format implements this interface. The N4 orchestrator calls
// detectZones() and extractLineItems() as separate Inngest steps (with the
// zone-review gate between them), enabling plug-and-play support for any
// number of formats without changes to the orchestrator or shared phases.
//
// Adding a new format (e.g. CSV):
//   1. Create lib/n4/extractors/{format}/index.ts implementing Extractor
//   2. Add the format to EstimateFormat in lib/n2/schemas/types.ts
//   3. Register in lib/n4/extractors/registry.ts
//   4. Add to the upload UI format dropdown
// ─────────────────────────────────────────────────────────────────────────────

import type { StepLogger } from '@/lib/n3/passes/detect-zones';
import type { EstimateFormat } from '@/lib/n2/schemas/types';

export type { StepLogger, EstimateFormat };

// ── detectZones result ────────────────────────────────────────────────────────

export type DetectZonesResult = {
  zoneCount: number;
  flat: boolean;
  detectedFormat: EstimateFormat;
};

// ── extractLineItems result ───────────────────────────────────────────────────

export type ExtractLineItemsResult = {
  itemCount: number;
};

// ── The Extractor contract ────────────────────────────────────────────────────

export interface Extractor {
  readonly format: EstimateFormat;

  /**
   * Phase 4: Detect zone boundaries for ONE side of a comparison.
   *
   * Reads:   Comparison.{your|adjuster}EstimateStoragePath (for `side`)
   * Writes:  n3_zones rows where source = side
   * Idempotent: deletes only this side's existing n3_zones rows before writing.
   *
   * @returns zoneCount — zones written; flat — true if synthesized General zone;
   *          detectedFormat — format signal from AI (sanity-check vs user selection)
   */
  detectZones(
    comparisonId: string,
    side: 'yours' | 'adjuster',
    logger: StepLogger,
  ): Promise<DetectZonesResult>;

  /**
   * Phase 8: Extract line items for ONE side of a comparison.
   *
   * Reads:   n3_zones rows for this side; PDF from Supabase storage
   * Writes:  n3_line_items rows where source = side
   * Idempotent: deletes only this side's existing n3_line_items rows before writing.
   *
   * @param reextractSource  When re-extracting after line-item review, the UI
   *   specifies which side(s) to re-run. Passed through to control DB deletions.
   */
  extractLineItems(
    comparisonId: string,
    side: 'yours' | 'adjuster',
    logger: StepLogger,
    reextractSource?: 'yours' | 'adjuster' | 'both',
  ): Promise<ExtractLineItemsResult>;
}
