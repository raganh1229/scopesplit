// ─────────────────────────────────────────────────────────────────────────────
// N3 Pipeline — normalization and similarity primitives
//
// Pure functions — no I/O, no DB access, no AI calls.
// All functions are deterministic on their inputs and safe to call in any context.
//
// Used by:
//   Phase 9  (normalization): normalizeDescription, expandUnit, parseAmount,
//                              detectSpecialFlags, tokenizeDescription
//   Phase 12 (candidates):    amountSimilarity, jaccardSimilarity
//   Phase 13 (scoring):       computeRawScore, computeFinalScore
// ─────────────────────────────────────────────────────────────────────────────

import type { N3SpecialFlag, N3CandidateScoreFeatures, N3ZoneBoost } from './types';
import {
  UNIT_EXPANSION,
  ABBREV_EXPANSION,
  DESCRIPTION_STOPWORDS,
  SPECIAL_FLAG_PATTERNS,
  SCORE_WEIGHTS,
  SCORE_THRESHOLDS,
} from './constants';

// ── Amount parsing ────────────────────────────────────────────────────────────

/**
 * Parse a raw financial value into a number.
 *
 * Handles:
 *   - Plain numbers: 1250, 1250.5
 *   - Currency strings: "$1,250.00"
 *   - Comma-formatted: "1,250.00"
 *   - Accounting negatives: "(250.00)" → -250
 *   - Negative strings: "-250.00"
 *   - null / undefined / "" → null
 *
 * Returns null for unparseable input; never throws.
 */
export function parseAmount(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return isFinite(raw) ? raw : null;

  const str = String(raw).trim();
  if (str === '') return null;

  const isAccountingNegative = str.startsWith('(') && str.endsWith(')');

  const cleaned = str
    .replace(/^\(/, '')
    .replace(/\)$/, '')
    .replace(/[$,\s]/g, '');

  const value = parseFloat(cleaned);
  if (!isFinite(value)) return null;

  return isAccountingNegative ? -value : value;
}

// ── Amount similarity (§16.4) ─────────────────────────────────────────────────

/**
 * Step-function amount similarity based on relative difference ratio.
 * §16.4: "Amount similarity should help but not dominate."
 *
 * ratio = |a - b| / max(|a|, |b|)
 *
 * Returns 0 when either value is null or both are 0 but only one is provided.
 * Returns 1.0 when both are 0 (two zero-cost items are equally "free").
 *
 * §A.6 hole: This is a step function; tiny ratio changes can shift the score
 * by 0.15. A smooth function (1 - clamp(ratio / 0.35, 0, 1)) is the
 * recommended future improvement. Step function is used for Phase 0 as
 * specified in §16.4.
 */
export function amountSimilarity(a: number | null, b: number | null): number {
  if (a === null || b === null) return 0;
  if (a === 0 && b === 0) return 1.0;
  if (a === 0 || b === 0) return 0;

  const ratio = Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b));

  if (ratio < 0.02) return 1.0;
  if (ratio < 0.05) return 0.9;
  if (ratio < 0.10) return 0.75;
  if (ratio < 0.20) return 0.5;
  if (ratio < 0.35) return 0.25;
  return 0.0;
}

// ── Special flag detection (§13.3) ────────────────────────────────────────────

/**
 * Detect special line-item flags from raw description text.
 * Pattern source: SPECIAL_FLAG_PATTERNS in constants.ts.
 * Returns an array of detected flags (may be empty; never throws).
 */
export function detectSpecialFlags(description: string): N3SpecialFlag[] {
  const lower = description.toLowerCase();
  const flags: N3SpecialFlag[] = [];

  for (const [flag, pattern] of Object.entries(SPECIAL_FLAG_PATTERNS)) {
    if (pattern.test(lower)) {
      flags.push(flag as N3SpecialFlag);
    }
  }

  return flags;
}

// ── Unit expansion (§13.2) ────────────────────────────────────────────────────

/**
 * Expand a unit abbreviation to its canonical English form.
 * Looks up the uppercase version in UNIT_EXPANSION.
 * Returns the original (unmodified) unit if not found, or null if input is null.
 *
 * Examples: "SF" → "square feet", "LF" → "linear feet", "EA" → "each"
 */
export function expandUnit(unit: string | null | undefined): string | null {
  if (!unit) return null;
  const upper = unit.trim().toUpperCase();
  return UNIT_EXPANSION[upper] ?? unit.trim();
}

// ── Description tokenization ──────────────────────────────────────────────────

/**
 * Tokenize a (normalized) description string for Jaccard similarity.
 *
 * Steps:
 *   1. Lowercase
 *   2. Split on any non-alphanumeric character sequence
 *   3. Filter: token must be >= 2 characters AND not a stopword
 *
 * Returns a string array (may be empty for very short descriptions).
 * Intended to be called on normalizedDescription, not rawDescription.
 */
export function tokenizeDescription(description: string): string[] {
  return description
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !DESCRIPTION_STOPWORDS.has(t));
}

// ── Jaccard similarity ────────────────────────────────────────────────────────

/**
 * Compute the Jaccard similarity coefficient between two token arrays.
 *
 * Jaccard similarity: |A ∩ B| / |A ∪ B|.
 * Edge cases:
 *   - Both empty → 0.0  (degenerate pair — no positive evidence of similarity;
 *                        consistent with score-candidates.ts and group-matching.ts
 *                        so all three Jaccard implementations agree.)
 *   - One empty  → 0.0  (no overlap possible)
 *
 * Returns a value in [0, 1].
 */
export function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0.0;

  const setA = new Set(a);
  const setB = new Set(b);

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1.0 : intersection / union;
}

// ── Description normalization (§13.2) ─────────────────────────────────────────

/**
 * Normalize a raw line-item description.
 *
 * Pipeline:
 *   1. Lowercase
 *   2. Expand abbreviations (ABBREV_EXPANSION, word-boundary matched)
 *      — must happen BEFORE punctuation stripping so "R&R" is caught
 *   3. Remove non-alphanumeric characters except spaces
 *   4. Collapse whitespace
 *
 * The result is suitable for tokenizeDescription() and fuzzy matching.
 */
export function normalizeDescription(description: string): string {
  let normalized = description.toLowerCase().trim();

  for (const [abbrev, expansion] of Object.entries(ABBREV_EXPANSION)) {
    const escaped = abbrev.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'gi');
    normalized = normalized.replace(re, expansion);
  }

  normalized = normalized.replace(/[^a-z0-9 ]+/g, ' ');
  normalized = normalized.replace(/\s+/g, ' ').trim();

  return normalized;
}

// ── Raw score computation (§16.2) ─────────────────────────────────────────────

/**
 * Compute the raw weighted feature sum from a feature vector.
 *
 *   rawScore = Σ (weight_i × feature_i)
 *
 * Result is in [0, 1] when all features are in [0, 1] (weights sum to 1.00).
 */
export function computeRawScore(features: N3CandidateScoreFeatures): number {
  let score = 0;
  for (const [key, weight] of Object.entries(SCORE_WEIGHTS)) {
    score += weight * (features[key as keyof N3CandidateScoreFeatures] ?? 0);
  }
  return score;
}

/**
 * Compute the raw weighted feature sum using a custom weight set.
 *
 * Identical to computeRawScore() but accepts a runtime weight override.
 * Used by Phase 13 to apply data-conditional weight boosting when item
 * codes or materials are present in the comparison.
 *
 * The provided weights MUST sum to 1.00 to maintain the [0, 1] score range.
 */
export function computeRawScoreWithWeights(
  features: N3CandidateScoreFeatures,
  weights: Record<keyof typeof SCORE_WEIGHTS, number>,
): number {
  let score = 0;
  for (const [key, weight] of Object.entries(weights)) {
    score += weight * (features[key as keyof N3CandidateScoreFeatures] ?? 0);
  }
  return score;
}

// ── Final score computation (§16.2 + §A.6 option 1) ──────────────────────────

/**
 * Compute the final clamped score from rawScore and zone boosts/penalties.
 *
 *   finalScore = clamp(rawScore + Σ boosts, 0, 1)
 *
 * Boosts accumulate; all applicable boosts/penalties are summed before clamping.
 */
export function computeFinalScore(rawScore: number, boosts: N3ZoneBoost[]): number {
  const adjustment = boosts.reduce((acc, b) => acc + b.value, 0);
  return Math.max(0, Math.min(1, rawScore + adjustment));
}

// ── Reject filter ─────────────────────────────────────────────────────────────

/**
 * Returns true if a candidate edge should be rejected (not entered into the
 * sparse graph). Rejection criteria:
 *   1. finalScore < SCORE_THRESHOLDS.REJECT
 *   2. Special-flag hard-reject: incompatible flags between source and target
 *      (e.g. 'tax' vs 'debris_removal' — no business case for this pair).
 *
 * §A.6 §17.1 fix: below-threshold edges are DROPPED entirely, not retained
 * as low-confidence ghosts, to keep connected-component splitting clean.
 *
 * Phase 0 note: special-flag hard-reject logic is a stub returning false
 * (no flags are hard-rejected yet). Phase 9 (normalization) will populate
 * the flag sets, and Phase 12 will wire the real logic.
 */
export function shouldRejectEdge(finalScore: number): boolean {
  if (finalScore < SCORE_THRESHOLDS.REJECT) return true;
  return false;
}
