// ─────────────────────────────────────────────────────────────────────────────
// N4 Pipeline — Xactimate Extractor
//
// Implements the Extractor interface for Xactimate-format estimates.
// Delegates to per-side zone detection and line item extraction.
// ─────────────────────────────────────────────────────────────────────────────

import type { Extractor } from '@/lib/n4/extractors/types';
import { xactimateDetectZones } from './detect-zones';
import { xactimateExtractLineItems } from './extract-line-items';

export const xactimateExtractor: Extractor = {
  format: 'xactimate',

  detectZones(comparisonId, side, logger) {
    return xactimateDetectZones(comparisonId, side, logger);
  },

  extractLineItems(comparisonId, side, logger, reextractSource) {
    return xactimateExtractLineItems(comparisonId, side, logger, reextractSource);
  },
};
