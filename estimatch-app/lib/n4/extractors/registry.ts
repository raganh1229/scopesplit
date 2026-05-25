// ─────────────────────────────────────────────────────────────────────────────
// N4 Pipeline — Extractor registry
//
// Maps each EstimateFormat to its concrete Extractor implementation.
// The N4 orchestrator looks up both sides' extractors at the start of
// each comparison run.
//
// To add a new format (e.g. CSV for N5):
//   import { csvExtractor } from './csv';
//   Add:  csv: csvExtractor,
//   Add 'csv' to EstimateFormat in lib/n2/schemas/types.ts
// ─────────────────────────────────────────────────────────────────────────────

import type { Extractor, EstimateFormat } from './types';
import { xactimateExtractor } from './xactimate';
import { symbilityExtractor } from './symbility';

export const EXTRACTORS: Record<EstimateFormat, Extractor> = {
  xactimate: xactimateExtractor,
  symbility: symbilityExtractor,
  unknown:   xactimateExtractor, // fallback — treat unknown format as Xactimate
};

/**
 * Resolve an extractor for a given format string.
 * Always returns a valid extractor — falls back to Xactimate for any
 * unrecognised format so the pipeline never hard-fails at dispatch.
 */
export function resolveExtractor(format: string): Extractor {
  return EXTRACTORS[format as EstimateFormat] ?? xactimateExtractor;
}
