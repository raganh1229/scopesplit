// ─────────────────────────────────────────────────────────────────────────────
// N4 Pipeline — Symbility Extractor
//
// Implements the Extractor interface for Symbility-format estimates.
// Uses Symbility-specific zone detection and extraction prompts.
// ─────────────────────────────────────────────────────────────────────────────

import type { Extractor } from '@/lib/n4/extractors/types';
import { symbilityDetectZones } from './detect-zones';
import { symbilityExtractLineItems } from './extract-line-items';

export const symbilityExtractor: Extractor = {
  format: 'symbility',

  detectZones(comparisonId, side, logger) {
    return symbilityDetectZones(comparisonId, side, logger);
  },

  extractLineItems(comparisonId, side, logger, reextractSource) {
    return symbilityExtractLineItems(comparisonId, side, logger, reextractSource);
  },
};
