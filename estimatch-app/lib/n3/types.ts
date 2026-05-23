// ─────────────────────────────────────────────────────────────────────────────
// N3 Pipeline — canonical TypeScript types
//
// Single source of truth for all shared types across the N3 pipeline.
// All passes, utilities, and Inngest steps import from here.
//
// Decision record (§A.1, §A.5, §A.6 — May 7, 2026 review):
// - Line-item model: denormalized output — existing `LineItem` stays as-is for UI
//   output. `N3NormalizedLineItem` is the INTERMEDIATE processing shape only;
//   `N3MatchDecision` rows project down to `LineItem` rows at persist time.
// - Side identity: asymmetric (yours = contractor, adjuster). N3 spec uses
//   symmetric e1/e2 — translated throughout to match app naming convention.
// - Table naming: `n3_*` prefixed during build (§A.3, §B.1). Prefix dropped in
//   the N2→N3 cutover commit (mirrors `pipelineVersion` evolution).
// - Scoring: 11 combined features as resolved from §16.1 vs §16.2 mismatch
//   (§A.6 note). Score domain: raw weighted sum clamped to [0, 1] after
//   boosts/penalties (option 1 from §A.6 hole fix).
// ─────────────────────────────────────────────────────────────────────────────

// ── Side identity ─────────────────────────────────────────────────────────────

/** Which side of the comparison a line item or zone belongs to. */
export type N3EstimateSource = 'yours' | 'adjuster';

// ── Estimate format ───────────────────────────────────────────────────────────

export type N3EstimateFormat = 'xactimate' | 'symbility' | 'unknown';

// ── Special flags ─────────────────────────────────────────────────────────────

/**
 * Special line-item flags detectable from description text and financial columns.
 * §13.3 — detected during normalization (Phase 9); used in the pre-scoring
 * special-flag hard-reject filter (§16.2 penalty note) and in the
 * `specialFlagCompatibility` scoring feature.
 */
export type N3SpecialFlag =
  | 'tax'
  | 'op'               // overhead & profit
  | 'depreciation'
  | 'permit'
  | 'emergency_service'
  | 'debris_removal';

// ── Zone types ────────────────────────────────────────────────────────────────

/**
 * Zone correspondence relationship type. §7 / Page 7.
 * `unmatched_zone` = zone on one side has no correspondence on the other side;
 * its items are candidates for cross-zone matching against the full opposite
 * estimate (the exact scenario that broke N2's Pass 3 — §27.11).
 */
export type N3ZoneCorrespondenceType =
  | 'one_to_one'
  | 'one_to_many'
  | 'many_to_one'
  | 'many_to_many'
  | 'unmatched_zone';

/**
 * Verification status for zones and zone correspondences.
 * Drives the boost/penalty applied to candidate edges (§16.2, §14).
 * Confidence values are in `ZONE_CONFIDENCE` in constants.ts.
 */
export type N3VerificationStatus =
  | 'ai_proposed'
  | 'user_confirmed'
  | 'user_corrected'
  | 'user_rejected';

/**
 * A detected zone from Phase 4 (Pass 1/2 zone detection).
 * Lives in the `n3_zones` table (Phase 1 schema).
 */
export type N3Zone = {
  id: string;
  comparisonId: string;
  source: N3EstimateSource;
  name: string;
  normalizedName: string;
  startPage: number;
  endPage: number;
  approxItems: number;
  verificationStatus: N3VerificationStatus;
};

/**
 * A zone correspondence: one or more zones on each side, linked by AI proposal
 * or user verification.
 * Lives in `n3_zone_correspondences`.
 *
 * Confidence is derived from `verificationStatus` (see ZONE_CONFIDENCE in
 * constants.ts) but stored explicitly for query efficiency.
 *
 * Verified zones act as PRIORS (score boost), NOT hard walls — §14, §A.4.
 */
export type N3ZoneCorrespondence = {
  id: string;
  comparisonId: string;
  yourZoneIds: string[];        // one or more n3_zones ids (yours/contractor side)
  adjusterZoneIds: string[];    // one or more n3_zones ids (adjuster side)
  correspondenceType: N3ZoneCorrespondenceType;
  verificationStatus: N3VerificationStatus;
  confidence: number;           // 0–1, derived from verificationStatus
};

// ── Normalized line item ───────────────────────────────────────────────────────

/**
 * A line item after Phase 8 (extraction) + Phase 9 (normalization).
 * INTERMEDIATE processing shape — NOT the output `LineItem` Prisma model.
 *
 * Phase 11 populates `embeddingVector` via pgvector (Voyage AI voyage-3-lite, 512-dim).
 * All financial fields are in dollars (numbers), not strings.
 * §13.1 canonical shape.
 */
export type N3NormalizedLineItem = {
  id: string;
  comparisonId: string;
  source: N3EstimateSource;
  sourceLineNumber: number;
  pageNumber: number;
  zoneId: string | null;

  rawDescription: string;
  normalizedDescription: string;
  descriptionTokens: string[];          // for Jaccard / fuzzy matching

  trade: string | null;
  action: string | null;
  material: string | null;
  object: string | null;
  itemCode: string | null;              // Xactimate item code where present

  rawQuantity: string | null;
  normalizedQuantity: number | null;
  rawUnit: string | null;
  normalizedUnit: string | null;        // canonical expanded form (e.g. "square feet")

  removeAmount: number | null;
  replaceAmount: number | null;
  resetAmount: number | null;
  taxAmount: number | null;
  opAmount: number | null;
  totalAmount: number | null;
  unitPrice: number | null;             // totalAmount / normalizedQuantity when both present

  specialFlags: N3SpecialFlag[];
  extractionConfidence: number;         // 0–1

  embeddingVector: number[] | null;     // null until Phase 11
};

// ── Candidate generation ──────────────────────────────────────────────────────

/**
 * How a candidate edge was produced during candidate generation (§15.2).
 * A single edge may be found by multiple retrieval sources — `retrievalSources`
 * is an array merged during dedup. Dedup key: (sourceItemId, targetItemId).
 * §15.4: both directions (yours→adjuster and adjuster→yours) are run; after
 * dedup, each edge is direction-normalized to (yours=source, adjuster=target).
 */
export type N3RetrievalSource =
  | 'verified_zone'              // searched within a user-confirmed zone
  | 'ai_proposed_zone'           // searched within an AI-proposed zone
  | 'semantic'                   // embedding similarity (Phase 11+)
  | 'fuzzy_description'          // fuzzy text match on normalizedDescription
  | 'item_code'                  // Xactimate item code exact/prefix match
  | 'trade_action_material'      // trade/action/material classification match
  | 'quantity_unit'              // quantity + unit similarity bucket
  | 'total_similarity'           // total amount within tolerance
  | 'sequence_nearby';           // page / line sequence proximity

// ── Candidate scoring ─────────────────────────────────────────────────────────

/**
 * The 11 combined scoring features (§16.2 resolved version).
 *
 * §A.6 reconciliation note: §16.1 lists 17 granular features; §16.2's formula
 * uses 11 combined features (e.g. trade_action_similarity combines trade_match
 * + action_match). The 11-feature combined version is used here to reduce
 * correlated-feature noise. All values are in [0, 1].
 *
 * CALIBRATION REQUIRED before production: thresholds in §16.3 must be tuned
 * against labeled fixture data. See §A.6 calibration note.
 */
export type N3CandidateScoreFeatures = {
  descriptionFuzzySimilarity: number;        // weight 0.20
  descriptionSemanticSimilarity: number;     // weight 0.15 (requires Phase 11 embeddings)
  tradeActionSimilarity: number;             // weight 0.12 (trade_match + action_match combined)
  materialObjectSimilarity: number;          // weight 0.09 (material_match + object_match combined)
  quantityUnitSimilarity: number;            // weight 0.10 (quantity_similarity + unit_match combined)
  totalSimilarity: number;                   // weight 0.10
  unitPriceSimilarity: number;               // weight 0.06
  itemCodeSimilarity: number;                // weight 0.06
  zoneCorrespondenceSimilarity: number;      // weight 0.08 (zone graph prior)
  sequenceSimilarity: number;                // weight 0.02
  specialFlagCompatibility: number;          // weight 0.02
};

/**
 * A zone boost or penalty applied to the raw weighted feature sum.
 * §16.2. Multiple boosts accumulate; final score is clamped to [0, 1].
 */
export type N3ZoneBoost = {
  type: 'user_corrected' | 'user_confirmed' | 'ai_proposed' | 'outside_verified';
  value: number;   // positive for boost, negative for penalty
};

/**
 * A candidate edge between one yours-side item and one adjuster-side item.
 * Edges with finalScore < SCORE_THRESHOLDS.REJECT are not written to the DB.
 * Lives in `n3_candidate_edges`.
 *
 * Natural upsert key: (comparisonId, sourceItemId, targetItemId).
 * On conflict: merge retrievalSources arrays, keep highest finalScore.
 */
export type N3CandidateEdge = {
  id: string;
  comparisonId: string;
  sourceItemId: string;         // N3NormalizedLineItem id (yours side)
  targetItemId: string;         // N3NormalizedLineItem id (adjuster side)
  retrievalSources: N3RetrievalSource[];
  features: N3CandidateScoreFeatures;
  boosts: N3ZoneBoost[];
  rawScore: number;             // sum(weight_i × feature_i) before boosts/penalties
  finalScore: number;           // clamp(rawScore + Σboosts, 0, 1)
  isRejected: boolean;          // true if finalScore < REJECT or special-flag hard-reject
};

// ── Sparse graph / connected components ───────────────────────────────────────

/** Size classification of a connected component (§17.3). */
export type N3ComponentSize = 'small' | 'medium' | 'large';

/**
 * A connected component in the sparse bipartite candidate graph (§17.2).
 * Lives in `n3_match_components`.
 *
 * Size determines assignment strategy:
 *   small (<50)   → exact Hungarian assignment
 *   medium (≤250) → Hungarian with pruning
 *   large (>250)  → split by strong feature, then greedy + repair
 */
export type N3MatchComponent = {
  id: string;
  comparisonId: string;
  sourceItemIds: string[];      // N3NormalizedLineItem ids (yours side)
  targetItemIds: string[];      // N3NormalizedLineItem ids (adjuster side)
  edgeIds: string[];            // N3CandidateEdge ids within this component
  size: N3ComponentSize;
  isAmbiguous: boolean;         // true → routed to LLM adjudication after assignment
};

// ── Match decisions ───────────────────────────────────────────────────────────

/**
 * How the final match decision was produced.
 * Priority ordering: auto_total_match > auto_high_confidence > assignment >
 * group_match > llm_adjudication > user_correction.
 */
export type N3DecisionSource =
  | 'auto_total_match'       // identical totals → auto-resolved, no LLM (§A.4 fix for failure #1)
  | 'auto_high_confidence'   // finalScore >= HIGH_CONFIDENCE, no competing edge
  | 'assignment'             // max-weight assignment (Hungarian or auction)
  | 'group_match'            // one-to-many or many-to-one group match (Phase 16)
  | 'llm_adjudication'       // model adjudication for ambiguous components
  | 'user_correction';       // explicit user override stored as ComparisonVersion

/**
 * Match decision type. §21.
 * Projects to `MatchStatus` on persist:
 *   one_to_one   → MATCH (costs same) or MODIFIED (costs differ)
 *   one_to_many / many_to_one / grouped → GROUPED
 *   possible     → MODIFIED (requires review; may need a new MatchStatus value)
 *   unmatched    → MISSING_FROM_ADJUSTER (yours only) or ADDED_BY_ADJUSTER (adjuster only)
 */
export type N3MatchDecisionType =
  | 'one_to_one'
  | 'one_to_many'
  | 'many_to_one'
  | 'grouped'       // N:M (general group case)
  | 'possible'      // 0.75 ≤ finalScore < 0.90 — requires human review
  | 'unmatched';    // no credible match found after all phases

/**
 * A match decision produced by Phase 15 (assignment) or Phase 17 (adjudication).
 * Lives in `n3_match_decisions`.
 *
 * These are the audit trail for the final output. On persist, each decision
 * projects down to one or more `LineItem` rows (denormalized output).
 */
export type N3MatchDecision = {
  id: string;
  comparisonId: string;
  componentId: string | null;
  decisionType: N3MatchDecisionType;
  yourItemIds: string[];
  adjusterItemIds: string[];
  topEdgeId: string | null;          // best single edge (one_to_one) or null
  finalScore: number;
  decidedBy: N3DecisionSource;
  groupMatchScore?: number;          // present for group decisions
  llmReasoning?: string;             // present when decidedBy = 'llm_adjudication'
};

// ── Group scoring (Phase 16) ──────────────────────────────────────────────────

/**
 * Scoring features for a group (one-to-many or many-to-one) match candidate.
 * §19.3 + §A.6 resolution.
 *
 * `combinedDescriptionCoverage`: Jaccard of (union of group item tokens) vs
 * source item tokens. §A.6 resolution: token overlap, not semantic average.
 */
export type N3GroupScoreFeatures = {
  combinedDescriptionCoverage: number;   // Jaccard(union(group tokens), source tokens)
  summedTotalSimilarity: number;         // amountSimilarity(Σ group totals, source total)
  tradeActionMaterialCoverage: number;   // fraction of source trade/action/material covered
  zoneCompatibility: number;             // fraction of group items in compatible zones
  sequenceProximity: number;             // are group items sequence-adjacent in their PDF?
  averagePairScore: number;              // mean finalScore of individual edges in the group
  specialFlagCompatibility: number;      // all flags mutually compatible (0 or 1)
};

// ── LLM telemetry ─────────────────────────────────────────────────────────────

/**
 * Per-call LLM telemetry for cost tracking and debug (Phase 20 dashboards).
 * Lives in `n3_llm_calls`.
 * §A.1: "llm_calls — no equivalent exists today — N1/N2 are cheap enough."
 * N3's higher per-job LLM-call count makes this load-bearing for cost ceilings.
 */
export type N3LlmCall = {
  id: string;
  comparisonId: string;
  phase: string;               // e.g. 'zone_detection' | 'adjudication' | 'explanation'
  model: string;               // e.g. 'claude-sonnet-4-6', 'claude-opus-4-7'
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  durationMs: number;
  success: boolean;
  errorMessage: string | null;
  createdAt: Date;
};

// ── Extraction warnings ───────────────────────────────────────────────────────

/** Warning categories from Phase 10 (extraction validation). §21.5. */
export type N3ExtractionWarningType =
  | 'subtotal_mismatch'          // extracted subtotal ≠ sum of zone items
  | 'total_reconciliation_fail'  // extracted total ≠ PDF-reported summary total
  | 'low_extraction_confidence'  // item's extractionConfidence below threshold
  | 'missing_page_text'          // text extraction returned empty for a page
  | 'duplicate_line_number';     // same sourceLineNumber appears twice in a zone

/**
 * An extraction warning from Phase 10. Lives in `n3_extraction_warnings`.
 * Surfaced in the UI (§21.5). ON DELETE CASCADE from Comparison.
 */
export type N3ExtractionWarning = {
  id: string;
  comparisonId: string;
  source: N3EstimateSource;
  warningType: N3ExtractionWarningType;
  pageNumber: number | null;
  lineItemId: string | null;
  zoneId: string | null;
  detail: string;
  createdAt: Date;
};
