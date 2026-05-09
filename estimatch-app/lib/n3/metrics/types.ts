// ─────────────────────────────────────────────────────────────────────────────
// N3 Verification Dashboard — Metrics types
//
// Shapes for every metric the dashboard surfaces. Computed on demand from the
// existing n3_* tables; no separate metrics table exists.
// ─────────────────────────────────────────────────────────────────────────────

export type StatusColor = 'green' | 'yellow' | 'red';

export type PhaseSummary = {
  phase:    string;        // 'p4' | 'p6' | …
  label:    string;        // 'Zones' | 'Corresps' | …
  status:   StatusColor;
  headline: string;        // one-line summary
  flags:    string[];      // diagnostic warnings (yellow/red explanations)
};

// ── Phase 4 — Zone detection ──────────────────────────────────────────────────

export type Phase4Metrics = {
  yoursZoneCount:    number;
  adjZoneCount:      number;
  yoursFormat:       string | null;  // 'xactimate' | 'unknown' | …
  adjFormat:         string | null;
  yoursPagesCovered: number;
  adjPagesCovered:   number;
  emptyZones:        number;          // zones with approxItems=0
  oversizedZones:    number;          // zones spanning >3 pages
  flatZones:         number;          // single-zone-covers-all detection
  zones: Array<{
    side:        'yours' | 'adjuster';
    name:        string;
    startPage:   number;
    endPage:     number;
    approxItems: number;
  }>;
};

// ── Phase 6 — Zone correspondences ────────────────────────────────────────────

export type Phase6Metrics = {
  correspondenceCount:   number;
  unmatchedYoursZones:   number;
  unmatchedAdjZones:     number;
  avgConfidence:         number;
  byType: {
    one_to_one:  number;
    one_to_many: number;
    many_to_one: number;
  };
  correspondences: Array<{
    type:        string;
    confidence:  number;
    yoursZones:  string[];   // zone names
    adjZones:    string[];
  }>;
};

// ── Phase 8 — Line item extraction ────────────────────────────────────────────

export type Phase8Metrics = {
  yoursItemCount:        number;
  adjItemCount:          number;
  totalItems:            number;
  itemsPerZone: { min: number; median: number; max: number };
  avgExtractionConfidence: number;
  itemsMissingTotal:     number;     // no totalAmount
  itemsMissingQuantity:  number;
  itemsLowConfidence:    number;     // confidence < 0.7
  yoursTotalAmount:      number;
  adjTotalAmount:        number;
  estimateGap:           number;     // adj - yours
};

// ── Phase 9 — Normalization ──────────────────────────────────────────────────

export type Phase9Metrics = {
  totalRows:           number;
  pctWithQuantity:     number;
  pctWithUnit:         number;
  pctWithTrade:        number;
  pctWithAction:       number;
  pctWithSpecialFlags: number;
  distinctTrades:      number;
  distinctActions:     number;
  topTrades:           Array<{ value: string; count: number }>;
  topActions:          Array<{ value: string; count: number }>;
  topFlags:            Array<{ value: string; count: number }>;
};

// ── Phase 11 — Embeddings ────────────────────────────────────────────────────

export type Phase11Metrics = {
  totalRows:        number;
  embedded:         number;          // rows with embedding present
  missing:          number;          // rows without embedding
  pctEmbedded:      number;
};

// ── Phase 12 — Candidate generation ──────────────────────────────────────────

export type Phase12Metrics = {
  totalEdges:                number;
  bySource:                  Record<string, number>;   // retrieval source → count
  itemsWithZeroCandidates:   number;                   // pipeline-killer signal
  yoursCandidatesHistogram:  number[];                 // [0–5, 6–15, 16–30, 31+]
  adjCandidatesHistogram:    number[];
  avgCandidatesPerYours:     number;
  avgCandidatesPerAdj:       number;
};

// ── Phase 13 — Scoring ─────────────────────────────────────────────────── ⭐

export type FeatureStats = {
  name:                string;
  weight:              number;
  meanAll:             number;        // mean across all edges
  meanHighConf:        number;        // mean among highConfidence edges
  meanRejected:        number;        // mean among rejected edges
  std:                 number;
  min:                 number;
  max:                 number;
  pctZero:             number;        // % of edges where this feature = 0
  weightedContribAll:  number;        // mean × weight (raw score contribution)
  discriminativePower: number;        // |meanHighConf - meanRejected|
};

export type Phase13Metrics = {
  scoredCount:         number;
  bucketCounts: {
    highConfidence: number;
    possibleMatch:  number;
    weakCandidate:  number;
    rejected:       number;
  };
  survivalRate:        number;        // non-rejected / total
  scoreHistogram:      number[];      // 10 buckets, 0.0–1.0
  featureStats:        FeatureStats[];
  borderline: {
    nearReject:        number;        // within ±0.02 of REJECT threshold
    nearPossible:      number;
    nearHighConf:      number;
  };
  boostStats: {
    edgesWithBoost:    number;        // edges where boostsJson is non-empty
    avgBoostMagnitude: number;
    bucketChangedByBoost: number;     // edges that flipped buckets due to boost
  };
};

// ── Phase 14 — Components ────────────────────────────────────────────────────

export type Phase14Metrics = {
  componentCount: number;
  bySize: { small: number; medium: number; large: number };
  largestComponentSize: number;
  singletonsYours: number;
  singletonsAdj:   number;
  components: Array<{
    idx:           number;
    yoursCount:    number;
    adjCount:      number;
    edgeCount:     number;
    size:          string;
    isAmbiguous:   boolean;
    edgeDensity:   number;            // edges / (yoursCount * adjCount)
  }>;
};

// ── Phase 15 — Assignment ────────────────────────────────────────────────────

export type Phase15Metrics = {
  decisionCount:    number;
  matchedCount:     number;
  possibleCount:    number;
  unmatchedYours:   number;
  unmatchedAdj:     number;
  matchedScores:    { min: number; mean: number; max: number };
  possibleScores:   { min: number; mean: number; max: number };
  scoreHistogramMatched:  number[];
  scoreHistogramPossible: number[];
};

// ── Phase 16 — Group matching ────────────────────────────────────────────────

export type Phase16Metrics = {
  groupedCount:       number;
  relinquishedAdj:    number;
};

// ── Phase 17 — LLM adjudication ──────────────────────────────────────────────

export type Phase17Metrics = {
  adjudicatedCount: number;
  acceptedCount:    number;
  rejectedCount:    number;
  estimatedCostUsd: number;
  durationMs:       number;
  confusionMatrix: {
    // algo score split at MATCH_THRESHOLD (0.55)
    algoHigh_llmAccept: number;
    algoHigh_llmReject: number;
    algoLow_llmAccept:  number;
    algoLow_llmReject:  number;
  };
  agreementRate:    number;            // diagonal / total
  reasoningSamples: Array<{
    pairIndex:  number;
    finalScore: number;
    decision:   'match' | 'no_match';
    reasoning:  string;
    yoursDesc:  string;
    adjDesc:    string;
  }>;
};

// ── Phase 18 — Persist decisions ─────────────────────────────────────────────

export type Phase18Metrics = {
  lineItemCount: number;
  byStatus: {
    MATCH:                  number;
    MODIFIED:               number;
    MISSING_FROM_ADJUSTER:  number;
    ADDED_BY_ADJUSTER:      number;
    GROUPED:                number;
  };
  byProvenance:        Record<string, number>;   // decidedBy → count
  totalGap:            number;
  yourEstimateTotal:   number;
  adjEstimateTotal:    number;
  matchedDollars:      number;            // sum of MATCH totalYours
  matchedDollarPct:    number;
};

// ── Per-decision drill-down ──────────────────────────────────────────────────

export type DecisionDetail = {
  id:           string;
  decisionType: string;
  decidedBy:    string;
  finalScore:   number;
  yoursDesc:    string | null;
  adjDesc:      string | null;
  yoursTotal:   number | null;
  adjTotal:     number | null;
  diff:         number | null;
  llmReasoning: string | null;
};

// ── Top-level dashboard payload ──────────────────────────────────────────────

export type N3DashboardMetrics = {
  comparisonId:   string;
  generatedAt:    string;        // ISO timestamp
  health:         PhaseSummary[];
  p4:  Phase4Metrics;
  p6:  Phase6Metrics;
  p8:  Phase8Metrics;
  p9:  Phase9Metrics;
  p11: Phase11Metrics;
  p12: Phase12Metrics;
  p13: Phase13Metrics;
  p14: Phase14Metrics;
  p15: Phase15Metrics;
  p16: Phase16Metrics;
  p17: Phase17Metrics;
  p18: Phase18Metrics;
  decisions: DecisionDetail[];
};
