// ─────────────────────────────────────────────────────────────────────────────
// N4 Pipeline — XLS extractor
//
// Implements the Extractor interface for XLS/CSV format estimates
// (Xactimate spreadsheet export and compatible formats).
//
// Key properties:
//   - Zero AI calls in P4 or P8 — fully deterministic spreadsheet parsing
//   - Uses SheetJS (xlsx) for workbook parsing
//   - Zone detection via Group Code column; flat General fallback if absent
//   - Same Extractor interface as xactimateExtractor and symbilityExtractor
// ─────────────────────────────────────────────────────────────────────────────

import type { Extractor } from '@/lib/n4/extractors/types';
import { xlsDetectZones } from './detect-zones';
import { xlsExtractLineItems } from './extract-items';

export const xlsExtractor: Extractor = {
  format: 'xls',

  detectZones(comparisonId, side, logger) {
    return xlsDetectZones(comparisonId, side, logger);
  },

  extractLineItems(comparisonId, side, logger, reextractSource) {
    return xlsExtractLineItems(comparisonId, side, logger, reextractSource);
  },
};
