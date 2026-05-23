// ─────────────────────────────────────────────────────────────────────────────
// N3 Pipeline — constants
//
// All scoring weights, thresholds, boosts, candidate budgets, component size
// thresholds, and normalization dictionaries.
//
// CALIBRATION NOTE (§A.6): The score weights and thresholds below are the
// initial values from §16.2–§16.3 of the N3 spec. They MUST be recalibrated
// against labeled fixture data (Set3 cheatsheet + generated sets) before Phase
// 13 is considered production-ready. Current values are a starting point, not
// tuned parameters. See §B.2 test-gate requirements.
// ─────────────────────────────────────────────────────────────────────────────

import type { N3CandidateScoreFeatures, N3RetrievalSource } from './types';

// ── Score weights (§16.2 resolved) ────────────────────────────────────────────
//
// 11 combined features; weights sum to exactly 1.00.
// Feature groupings vs §16.1's 17 granular features — see §A.6 reconciliation.

export const SCORE_WEIGHTS = {
  descriptionFuzzySimilarity:    0.23,  // +0.03 (redistributed from stubs)
  descriptionSemanticSimilarity: 0.19,  // +0.04 (redistributed from stubs)
  tradeActionSimilarity:         0.14,  // +0.02 (redistributed from stubs)
  materialObjectSimilarity:      0.01,  // stub (Phase 10 NLP not yet built); minimal to preserve slot
  quantityUnitSimilarity:        0.12,  // +0.02 (redistributed from stubs)
  totalSimilarity:               0.11,  // +0.01 (redistributed from stubs)
  unitPriceSimilarity:           0.06,
  itemCodeSimilarity:            0.01,  // stub (0% on real-description PDFs); minimal to preserve slot
  zoneCorrespondenceSimilarity:  0.09,  // +0.01 (redistributed from stubs)
  sequenceSimilarity:            0.02,
  specialFlagCompatibility:      0.02,
} as const satisfies Record<keyof N3CandidateScoreFeatures, number>;

// ── Zone boosts / penalties (§16.2) ───────────────────────────────────────────
//
// Applied on top of the raw weighted sum. Boosts accumulate; final score is
// clamped to [0, 1] after summing all applicable adjustments (§A.6 option 1).
//
// zone correspondence boost values are derived from §14 / Page 18 suggestions.
// These are upper bounds — the actual boost scales with zone_correspondence_similarity.

export const ZONE_BOOSTS = {
  user_corrected:   0.15,   // §16.2: "user corrected zone boost: +0.15 max"
  user_confirmed:   0.12,   // §16.2: "user confirmed zone boost: +0.12 max"
  ai_proposed:      0.06,   // §16.2: "AI proposed zone boost: +0.06 max"
  outside_verified: -0.08,  // §16.2: "outside verified zone: -0.08"
} as const;

// ── Score thresholds (§16.3) ──────────────────────────────────────────────────
//
// Applied to `finalScore` (clamped [0, 1]). Edges below REJECT are dropped
// before graph construction (§A.6 §17.1 fix — below-threshold edges are NOT
// retained as low-confidence ghosts).
//
// CALIBRATION REQUIRED: tune against Set3 labeled data before production.

// PRE-CALIBRATION NOTE (Phase 13 live test, May 2026):
// materialObjectSimilarity (weight 0.09) and itemCodeSimilarity (weight 0.06)
// are both stubs returning 0 for all edges. This caps the max achievable
// finalScore at ~0.895 instead of the theoretical 1.0 + boosts. The REJECT
// threshold has been temporarily lowered from 0.60 → 0.30 so that true matches
// are not discarded before Phase 14/15 can rank and assign them.
// Raise back toward 0.55 once Phase 10 NLP (material/object) is built and
// real item-code data is present in production comparisons.

export const SCORE_THRESHOLDS = {
  HIGH_CONFIDENCE: 0.75,   // auto-resolve without LLM if no competing edge (was 0.90 pre-calibration)
  POSSIBLE_MATCH:  0.55,   // requires human review (was 0.75 pre-calibration)
  WEAK_CANDIDATE:  0.30,   // above this → enters sparse graph; below → REJECT (was 0.60 pre-calibration)
  REJECT:          0.30,   // same as WEAK_CANDIDATE; explicit alias for filter logic (was 0.60 pre-calibration)
} as const;

// ── Zone verification confidence (§7, Page 7) ─────────────────────────────────
//
// Stored on `n3_zone_correspondences.confidence` for query-time boost lookup.

export const ZONE_CONFIDENCE = {
  ai_proposed:    0.75,
  user_confirmed: 0.95,
  user_corrected: 1.00,
  user_rejected:  0.00,
} as const;

// ── Component size thresholds (§17.3) ─────────────────────────────────────────

export const COMPONENT_SIZE = {
  SMALL_MAX:  50,    // exact Hungarian assignment
  MEDIUM_MAX: 350,   // pruned Hungarian assignment (raised from 250 for storm damage claims)
  // > MEDIUM_MAX → 'large': split by strong feature, greedy + repair
} as const;

// ── Group matching config (§17.3 + §A.6 hole fix) ────────────────────────────
//
// §A.6 cap: prune to top-K before generating combinations to keep the number
// of group candidates bounded: C(8,2)+C(8,3)+C(8,4)+C(8,5) = 210 per item.

export const GROUP_MATCH = {
  TOP_K_CANDIDATES: 8,    // prune to top-K individual edges before combinations
  MAX_GROUP_SIZE:   5,    // maximum members in a group candidate
  MIN_GROUP_SIZE:   2,    // minimum members to qualify as a group
} as const;

// ── Candidate budgets per retrieval source (§15.3) ───────────────────────────
//
// Maximum candidates to fetch from each source before dedup.
// Post-dedup target: 30–75 per item (large estimates), 10–40 (small estimates).
// §A.6 §15.4: 30–75 is the POST-DEDUP target; budgets below are PER-DIRECTION.

// Maximum cross-product pairs allowed for a single ai_proposed_zone correspondence.
// If yoursItems × adjItems exceeds this, the correspondence is skipped and the
// four global sources (semantic, fuzzy_description, total_similarity, item_code)
// provide full coverage instead. Prevents DB connection timeouts on large zones.
export const AI_ZONE_MAX_PAIRS = 7_000;

export const CANDIDATE_BUDGETS: Record<N3RetrievalSource, number> = {
  verified_zone:          30,
  ai_proposed_zone:       20,
  semantic:               15,
  fuzzy_description:      15,
  item_code:              10,
  trade_action_material:  15,
  quantity_unit:          10,
  total_similarity:       10,
  sequence_nearby:         5,
};

// ── Unit normalization dictionary (§13.2) ─────────────────────────────────────
//
// Maps uppercase unit abbreviations to their canonical English form.
// Used by `expandUnit()` in normalization.ts.

export const UNIT_EXPANSION: Readonly<Record<string, string>> = {
  SF:   'square feet',
  SY:   'square yard',
  LF:   'linear feet',
  LY:   'linear yard',
  EA:   'each',
  LS:   'lump sum',
  HR:   'hour',
  DAY:  'day',
  MO:   'month',
  CF:   'cubic feet',
  CY:   'cubic yard',
  GAL:  'gallon',
  SQFT: 'square feet',
  SQYD: 'square yard',
  LNFT: 'linear feet',
};

// ── Description abbreviation dictionary (§13.2) ───────────────────────────────
//
// Maps lowercase abbreviations (word-boundary matched) to their expansions.
// Applied in normalizeDescription() BEFORE punctuation stripping, so
// compound abbreviations like "r&r" are expanded correctly.
// Keys are lowercase; values are lowercase expanded forms.

export const ABBREV_EXPANSION: Readonly<Record<string, string>> = {
  'r&r':   'remove and replace',
  'd&r':   'detach and reset',
  'det':   'detach',
  'demo':  'demolition',
  'inst':  'install',
  'repl':  'replace',
  'rmv':   'remove',
  'reinst': 'reinstall',
};

// ── Scoring stopwords ──────────────────────────────────────────────────────────
//
// Tokens filtered out during description tokenization (§13.1).
// Short or common words that add noise to Jaccard similarity.

export const DESCRIPTION_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'in', 'to', 'for',
  'with', 'on', 'at', 'by', 'is', 'it', 'as', 'be', 'that', 'this',
  'from', 'per', 'up', 'do', 'if', 'not',
]);

// ── Special flag detection patterns ───────────────────────────────────────────
//
// Regex patterns used by detectSpecialFlags() in normalization.ts.
// Patterns are tested against lowercased description text.

export const SPECIAL_FLAG_PATTERNS = {
  tax:               /\btax\b/,
  op:                /\bo&p\b|\boverhead\b|\bprofit\b/,
  depreciation:      /\bdepreciation\b|\bdepreciated\b/,
  permit:            /\bpermit\b/,
  emergency_service: /\bemergency\b/,
  debris_removal:    /\bdebris\b/,
} as const satisfies Record<string, RegExp>;
