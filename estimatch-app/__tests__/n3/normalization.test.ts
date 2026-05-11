import { describe, it, expect } from 'vitest';
import {
  parseAmount,
  amountSimilarity,
  detectSpecialFlags,
  expandUnit,
  tokenizeDescription,
  jaccardSimilarity,
  normalizeDescription,
  computeRawScore,
  computeFinalScore,
  shouldRejectEdge,
} from '@/lib/n3/normalization';
import {
  SCORE_WEIGHTS,
  SCORE_THRESHOLDS,
  ZONE_CONFIDENCE,
  ZONE_BOOSTS,
  GROUP_MATCH,
  COMPONENT_SIZE,
  CANDIDATE_BUDGETS,
  UNIT_EXPANSION,
  ABBREV_EXPANSION,
} from '@/lib/n3/constants';
import type { N3CandidateScoreFeatures, N3ZoneBoost } from '@/lib/n3/types';
import fixture from '@/lib/n3/__fixtures__/set3-cross-zone-pairs.json';

// ─────────────────────────────────────────────────────────────────────────────
// Constants validation
// ─────────────────────────────────────────────────────────────────────────────

describe('SCORE_WEIGHTS', () => {
  it('sums to exactly 1.00', () => {
    const sum = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it('has 11 features (§16.2 resolved)', () => {
    expect(Object.keys(SCORE_WEIGHTS)).toHaveLength(11);
  });

  it('all weights are positive', () => {
    for (const w of Object.values(SCORE_WEIGHTS)) {
      expect(w).toBeGreaterThan(0);
    }
  });

  it('descriptionFuzzySimilarity has the highest weight (0.20)', () => {
    const weights = Object.values(SCORE_WEIGHTS);
    expect(SCORE_WEIGHTS.descriptionFuzzySimilarity).toBe(Math.max(...weights));
  });
});

describe('SCORE_THRESHOLDS', () => {
  it('HIGH_CONFIDENCE > POSSIBLE_MATCH > WEAK_CANDIDATE >= REJECT', () => {
    expect(SCORE_THRESHOLDS.HIGH_CONFIDENCE).toBeGreaterThan(SCORE_THRESHOLDS.POSSIBLE_MATCH);
    expect(SCORE_THRESHOLDS.POSSIBLE_MATCH).toBeGreaterThan(SCORE_THRESHOLDS.WEAK_CANDIDATE);
    expect(SCORE_THRESHOLDS.WEAK_CANDIDATE).toBeGreaterThanOrEqual(SCORE_THRESHOLDS.REJECT);
  });

  it('all thresholds are in (0, 1)', () => {
    for (const t of Object.values(SCORE_THRESHOLDS)) {
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThan(1);
    }
  });

  it('REJECT equals WEAK_CANDIDATE (explicit alias)', () => {
    expect(SCORE_THRESHOLDS.REJECT).toBe(SCORE_THRESHOLDS.WEAK_CANDIDATE);
  });
});

describe('ZONE_CONFIDENCE', () => {
  it('user_corrected = 1.00 (highest trust)', () => {
    expect(ZONE_CONFIDENCE.user_corrected).toBe(1.0);
  });

  it('user_rejected = 0.00', () => {
    expect(ZONE_CONFIDENCE.user_rejected).toBe(0.0);
  });

  it('user_corrected > user_confirmed > ai_proposed > user_rejected', () => {
    expect(ZONE_CONFIDENCE.user_corrected).toBeGreaterThan(ZONE_CONFIDENCE.user_confirmed);
    expect(ZONE_CONFIDENCE.user_confirmed).toBeGreaterThan(ZONE_CONFIDENCE.ai_proposed);
    expect(ZONE_CONFIDENCE.ai_proposed).toBeGreaterThan(ZONE_CONFIDENCE.user_rejected);
  });
});

describe('ZONE_BOOSTS', () => {
  it('user_corrected boost is positive and largest', () => {
    expect(ZONE_BOOSTS.user_corrected).toBeGreaterThan(0);
    expect(ZONE_BOOSTS.user_corrected).toBeGreaterThanOrEqual(ZONE_BOOSTS.user_confirmed);
    expect(ZONE_BOOSTS.user_corrected).toBeGreaterThanOrEqual(ZONE_BOOSTS.ai_proposed);
  });

  it('outside_verified is a penalty (negative)', () => {
    expect(ZONE_BOOSTS.outside_verified).toBeLessThan(0);
  });
});

describe('GROUP_MATCH', () => {
  it('TOP_K_CANDIDATES limits combinations to ≤ 210 (§A.6 cap)', () => {
    const k = GROUP_MATCH.TOP_K_CANDIDATES;
    let combinations = 0;
    for (let r = GROUP_MATCH.MIN_GROUP_SIZE; r <= GROUP_MATCH.MAX_GROUP_SIZE; r++) {
      // C(k, r) combinations
      let c = 1;
      for (let i = 0; i < r; i++) c = (c * (k - i)) / (i + 1);
      combinations += Math.round(c);
    }
    expect(combinations).toBeLessThanOrEqual(210);
  });

  it('MIN_GROUP_SIZE < MAX_GROUP_SIZE', () => {
    expect(GROUP_MATCH.MIN_GROUP_SIZE).toBeLessThan(GROUP_MATCH.MAX_GROUP_SIZE);
  });
});

describe('COMPONENT_SIZE', () => {
  it('SMALL_MAX < MEDIUM_MAX', () => {
    expect(COMPONENT_SIZE.SMALL_MAX).toBeLessThan(COMPONENT_SIZE.MEDIUM_MAX);
  });
});

describe('CANDIDATE_BUDGETS', () => {
  it('verified_zone has the largest budget', () => {
    const max = Math.max(...Object.values(CANDIDATE_BUDGETS));
    expect(CANDIDATE_BUDGETS.verified_zone).toBe(max);
  });

  it('all budgets are positive integers', () => {
    for (const b of Object.values(CANDIDATE_BUDGETS)) {
      expect(b).toBeGreaterThan(0);
      expect(Number.isInteger(b)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseAmount
// ─────────────────────────────────────────────────────────────────────────────

describe('parseAmount', () => {
  it('returns null for null', () => expect(parseAmount(null)).toBeNull());
  it('returns null for undefined', () => expect(parseAmount(undefined)).toBeNull());
  it('returns null for empty string', () => expect(parseAmount('')).toBeNull());
  it('returns null for whitespace string', () => expect(parseAmount('   ')).toBeNull());
  it('returns null for NaN string', () => expect(parseAmount('abc')).toBeNull());

  it('passes through a plain number', () => expect(parseAmount(1250)).toBe(1250));
  it('returns null for Infinity', () => expect(parseAmount(Infinity)).toBeNull());
  it('passes through 0', () => expect(parseAmount(0)).toBe(0));
  it('passes through negative number', () => expect(parseAmount(-250)).toBe(-250));

  it('strips dollar sign', () => expect(parseAmount('$1250.00')).toBe(1250));
  it('strips commas', () => expect(parseAmount('1,250.00')).toBe(1250));
  it('strips dollar sign and commas', () => expect(parseAmount('$1,250.00')).toBe(1250));
  it('handles accounting negative (250.00)', () => expect(parseAmount('(250.00)')).toBe(-250));
  it('handles accounting negative with dollar ($1,000.00)', () =>
    expect(parseAmount('($1,000.00)')).toBe(-1000));
  it('handles plain negative string', () => expect(parseAmount('-250.00')).toBe(-250));

  it('parses Set3 identical total $4515.84', () => expect(parseAmount('$4,515.84')).toBe(4515.84));
  it('parses integer string', () => expect(parseAmount('300')).toBe(300));
  it('handles leading/trailing whitespace', () => expect(parseAmount('  $500.00  ')).toBe(500));
});

// ─────────────────────────────────────────────────────────────────────────────
// amountSimilarity
// ─────────────────────────────────────────────────────────────────────────────

describe('amountSimilarity', () => {
  it('returns 0 when either input is null', () => {
    expect(amountSimilarity(null, 1000)).toBe(0);
    expect(amountSimilarity(1000, null)).toBe(0);
    expect(amountSimilarity(null, null)).toBe(0);
  });

  it('returns 1.0 for identical values', () => {
    expect(amountSimilarity(4515.84, 4515.84)).toBe(1.0);
    expect(amountSimilarity(300, 300)).toBe(1.0);
  });

  it('returns 1.0 when both are zero', () => {
    expect(amountSimilarity(0, 0)).toBe(1.0);
  });

  it('returns 0 when only one value is zero', () => {
    expect(amountSimilarity(0, 100)).toBe(0);
    expect(amountSimilarity(100, 0)).toBe(0);
  });

  it('ratio < 0.02 → 1.0 (≈1% difference)', () => {
    expect(amountSimilarity(1000, 1010)).toBe(1.0);
  });

  it('ratio < 0.05 → 0.9 (≈4% difference)', () => {
    expect(amountSimilarity(1000, 1040)).toBe(0.9);
  });

  it('ratio < 0.10 → 0.75 (≈8% difference)', () => {
    expect(amountSimilarity(1000, 1080)).toBe(0.75);
  });

  it('ratio < 0.20 → 0.5 (≈15% difference)', () => {
    expect(amountSimilarity(1000, 1150)).toBe(0.5);
  });

  it('ratio < 0.35 → 0.25 (≈30% difference)', () => {
    expect(amountSimilarity(1000, 1300)).toBe(0.25);
  });

  it('ratio >= 0.35 → 0.0 (100% difference)', () => {
    expect(amountSimilarity(1000, 2000)).toBe(0.0);
  });

  it('is symmetric', () => {
    expect(amountSimilarity(1000, 1080)).toBe(amountSimilarity(1080, 1000));
  });

  it('validates all fixture amountSimilarityExpectations', () => {
    for (const { a, b, expected } of fixture.amountSimilarityExpectations) {
      expect(amountSimilarity(a, b)).toBe(expected);
    }
  });

  it('handles negative amounts (identical → 1.0)', () => {
    expect(amountSimilarity(-100, -100)).toBe(1.0);
  });

  it('handles negative amounts (10% diff → 0.75)', () => {
    // ratio = |-100 - (-110)| / max(100, 110) = 10/110 ≈ 9.1% → < 0.10 → 0.75
    expect(amountSimilarity(-100, -110)).toBe(0.75);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectSpecialFlags
// ─────────────────────────────────────────────────────────────────────────────

describe('detectSpecialFlags', () => {
  it('returns empty array for a plain item description', () => {
    expect(detectSpecialFlags('R&R Drywall 1/2 inch')).toEqual([]);
  });

  it('detects "tax" flag', () => {
    expect(detectSpecialFlags('State sales tax')).toContain('tax');
    expect(detectSpecialFlags('TAX on materials')).toContain('tax');
  });

  it('detects "op" flag for O&P', () => {
    expect(detectSpecialFlags('Overhead & Profit - O&P')).toContain('op');
  });

  it('detects "op" flag for overhead', () => {
    expect(detectSpecialFlags('General overhead markup')).toContain('op');
  });

  it('detects "depreciation" flag', () => {
    expect(detectSpecialFlags('Recoverable depreciation')).toContain('depreciation');
    expect(detectSpecialFlags('Depreciated value')).toContain('depreciation');
  });

  it('detects "permit" flag', () => {
    expect(detectSpecialFlags('Building permit fee')).toContain('permit');
  });

  it('detects "emergency_service" flag', () => {
    expect(detectSpecialFlags('Emergency water extraction')).toContain('emergency_service');
  });

  it('detects "debris_removal" flag', () => {
    expect(detectSpecialFlags('Debris hauling and removal')).toContain('debris_removal');
    expect(detectSpecialFlags('Construction debris disposal')).toContain('debris_removal');
  });

  it('detects multiple flags in one description', () => {
    const flags = detectSpecialFlags('Tax and overhead on emergency debris removal');
    expect(flags).toContain('tax');
    expect(flags).toContain('op');
    expect(flags).toContain('emergency_service');
    expect(flags).toContain('debris_removal');
  });

  it('"tax" must be a whole word (no false match on "Xactimate")', () => {
    const flags = detectSpecialFlags('Xactimate estimate line');
    expect(flags).not.toContain('tax');
  });

  it('is case-insensitive', () => {
    expect(detectSpecialFlags('DEBRIS HAULING')).toContain('debris_removal');
    expect(detectSpecialFlags('Permit required')).toContain('permit');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// expandUnit
// ─────────────────────────────────────────────────────────────────────────────

describe('expandUnit', () => {
  it('returns null for null input', () => expect(expandUnit(null)).toBeNull());
  it('returns null for undefined input', () => expect(expandUnit(undefined)).toBeNull());
  it('returns null for empty string', () => expect(expandUnit('')).toBeNull());

  it('expands SF → square feet', () => expect(expandUnit('SF')).toBe('square feet'));
  it('expands LF → linear feet', () => expect(expandUnit('LF')).toBe('linear feet'));
  it('expands EA → each', () => expect(expandUnit('EA')).toBe('each'));
  it('expands SY → square yard', () => expect(expandUnit('SY')).toBe('square yard'));
  it('expands CY → cubic yard', () => expect(expandUnit('CY')).toBe('cubic yard'));
  it('expands LS → lump sum', () => expect(expandUnit('LS')).toBe('lump sum'));
  it('expands SQFT → square feet', () => expect(expandUnit('SQFT')).toBe('square feet'));

  it('is case-insensitive (lowercase input)', () => {
    expect(expandUnit('sf')).toBe('square feet');
    expect(expandUnit('lf')).toBe('linear feet');
    expect(expandUnit('ea')).toBe('each');
  });

  it('returns unknown unit unchanged', () => {
    expect(expandUnit('SQ')).toBe('SQ');
    expect(expandUnit('UNIT')).toBe('UNIT');
  });

  it('trims whitespace before lookup', () => {
    expect(expandUnit('  SF  ')).toBe('square feet');
  });

  it('covers all entries in UNIT_EXPANSION', () => {
    for (const [abbrev, expansion] of Object.entries(UNIT_EXPANSION)) {
      expect(expandUnit(abbrev)).toBe(expansion);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tokenizeDescription
// ─────────────────────────────────────────────────────────────────────────────

describe('tokenizeDescription', () => {
  it('returns empty array for empty string', () => {
    expect(tokenizeDescription('')).toEqual([]);
  });

  it('splits on non-alphanumeric characters', () => {
    const tokens = tokenizeDescription('remove and replace');
    expect(tokens).toContain('remove');
    expect(tokens).toContain('replace');
  });

  it('filters out stopwords', () => {
    const tokens = tokenizeDescription('remove and replace');
    expect(tokens).not.toContain('and');
  });

  it('filters tokens shorter than 2 characters', () => {
    const tokens = tokenizeDescription('a b ceramic tile');
    expect(tokens).not.toContain('a');
    expect(tokens).not.toContain('b');
    expect(tokens).toContain('ceramic');
  });

  it('lowercases tokens', () => {
    const tokens = tokenizeDescription('Ceramic TILE');
    expect(tokens).toContain('ceramic');
    expect(tokens).toContain('tile');
  });

  it('handles punctuation separators (dashes, slashes)', () => {
    const tokens = tokenizeDescription('R&R Carpet - per SF');
    expect(tokens).toContain('carpet');
  });

  it('produces distinct tokens from normalized description', () => {
    const normalized = normalizeDescription('R&R Carpet - per SF');
    const tokens = tokenizeDescription(normalized);
    expect(tokens).toContain('remove');
    expect(tokens).toContain('replace');
    expect(tokens).toContain('carpet');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// jaccardSimilarity
// ─────────────────────────────────────────────────────────────────────────────

describe('jaccardSimilarity', () => {
  it('returns 1.0 for identical token arrays', () => {
    expect(jaccardSimilarity(['carpet', 'remove'], ['carpet', 'remove'])).toBe(1.0);
  });

  it('returns 0.0 for completely disjoint arrays', () => {
    expect(jaccardSimilarity(['carpet'], ['drywall'])).toBe(0.0);
  });

  it('returns 0.0 for two empty arrays (standardized across all N3 Jaccard impls)', () => {
    expect(jaccardSimilarity([], [])).toBe(0.0);
  });

  it('returns 0.0 when one array is empty and the other is not', () => {
    expect(jaccardSimilarity([], ['carpet'])).toBe(0.0);
    expect(jaccardSimilarity(['carpet'], [])).toBe(0.0);
  });

  it('computes correct value for partial overlap', () => {
    // A = {a, b, c}, B = {b, c, d} → |A∩B|=2, |A∪B|=4 → J=0.5
    expect(jaccardSimilarity(['a', 'b', 'c'], ['b', 'c', 'd'])).toBeCloseTo(0.5, 10);
  });

  it('uses set semantics (duplicates in input are deduplicated)', () => {
    // duplicates should not inflate the union
    expect(jaccardSimilarity(['a', 'a', 'b'], ['a', 'b'])).toBe(1.0);
  });

  it('is symmetric', () => {
    const a = ['tear', 'off', 'tpo', 'membrane'];
    const b = ['strip', 'tpo', 'membrane', 'roofing', 'system'];
    expect(jaccardSimilarity(a, b)).toBe(jaccardSimilarity(b, a));
  });

  it('Set3 TPO pair has higher Jaccard than unrelated pair', () => {
    const yours = tokenizeDescription(normalizeDescription('Tear off TPO membrane roofing'));
    const adjuster = tokenizeDescription(normalizeDescription('Strip TPO membrane roofing system'));
    const unrelated = tokenizeDescription(normalizeDescription('Remove and replace carpet per SF'));

    expect(jaccardSimilarity(yours, adjuster)).toBeGreaterThan(jaccardSimilarity(yours, unrelated));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizeDescription
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeDescription', () => {
  it('lowercases the description', () => {
    expect(normalizeDescription('DRYWALL')).toBe('drywall');
  });

  it('expands R&R abbreviation', () => {
    const result = normalizeDescription('R&R Carpet');
    expect(result).toContain('remove and replace');
    expect(result).toContain('carpet');
  });

  it('expands D&R abbreviation', () => {
    const result = normalizeDescription('D&R Light fixture');
    expect(result).toContain('detach and reset');
    expect(result).toContain('light fixture');
  });

  it('expands demo abbreviation', () => {
    const result = normalizeDescription('Demo drywall 1/2 inch');
    expect(result).toContain('demolition');
    expect(result).not.toContain('demo ');
  });

  it('strips punctuation after abbreviation expansion', () => {
    const result = normalizeDescription('R&R Carpet - per SF');
    expect(result).not.toContain('-');
    expect(result).not.toContain('/');
  });

  it('collapses multiple spaces', () => {
    const result = normalizeDescription('  R&R   Carpet  ');
    expect(result).not.toMatch(/\s{2,}/);
  });

  it('trims leading and trailing whitespace', () => {
    const result = normalizeDescription('  Drywall  ');
    expect(result).toBe('drywall');
  });

  it('does not expand mid-word demo (e.g. "demolition" stays as-is)', () => {
    const result = normalizeDescription('demolition');
    expect(result).toBe('demolition');
  });

  it('validates all fixture normalizationExpectations', () => {
    for (const { rawDescription, expectedNormalized } of fixture.normalizationExpectations) {
      expect(normalizeDescription(rawDescription)).toBe(expectedNormalized);
    }
  });

  it('abbreviation expansion happens BEFORE punctuation stripping (r&r test)', () => {
    // If punct is stripped first, "r&r" → "r r" and would NOT match the abbrev key
    const result = normalizeDescription('R&R Drywall');
    expect(result).toContain('remove and replace');
  });

  it('Set3 TPO yours and adjuster descriptions share key tokens after normalization', () => {
    const yours = normalizeDescription('Tear off TPO membrane roofing');
    const adj   = normalizeDescription('Strip TPO membrane roofing system');
    const tokensYours = tokenizeDescription(yours);
    const tokensAdj   = tokenizeDescription(adj);
    const shared = tokensYours.filter(t => tokensAdj.includes(t));
    expect(shared.length).toBeGreaterThanOrEqual(2); // at least "tpo" + "membrane"
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeRawScore
// ─────────────────────────────────────────────────────────────────────────────

describe('computeRawScore', () => {
  const zeroFeatures: N3CandidateScoreFeatures = {
    descriptionFuzzySimilarity: 0,
    descriptionSemanticSimilarity: 0,
    tradeActionSimilarity: 0,
    materialObjectSimilarity: 0,
    quantityUnitSimilarity: 0,
    totalSimilarity: 0,
    unitPriceSimilarity: 0,
    itemCodeSimilarity: 0,
    zoneCorrespondenceSimilarity: 0,
    sequenceSimilarity: 0,
    specialFlagCompatibility: 0,
  };

  const perfectFeatures: N3CandidateScoreFeatures = {
    descriptionFuzzySimilarity: 1,
    descriptionSemanticSimilarity: 1,
    tradeActionSimilarity: 1,
    materialObjectSimilarity: 1,
    quantityUnitSimilarity: 1,
    totalSimilarity: 1,
    unitPriceSimilarity: 1,
    itemCodeSimilarity: 1,
    zoneCorrespondenceSimilarity: 1,
    sequenceSimilarity: 1,
    specialFlagCompatibility: 1,
  };

  it('returns 0 for all-zero features', () => {
    expect(computeRawScore(zeroFeatures)).toBe(0);
  });

  it('returns 1.0 for all-one features (weights sum to 1)', () => {
    expect(computeRawScore(perfectFeatures)).toBeCloseTo(1.0, 10);
  });

  it('is proportional to individual feature weights', () => {
    const onlyFuzzy: N3CandidateScoreFeatures = { ...zeroFeatures, descriptionFuzzySimilarity: 1 };
    expect(computeRawScore(onlyFuzzy)).toBeCloseTo(SCORE_WEIGHTS.descriptionFuzzySimilarity, 10);
  });

  it('partial-perfect-match: identical total only scores 0.10', () => {
    const totalOnly: N3CandidateScoreFeatures = { ...zeroFeatures, totalSimilarity: 1 };
    expect(computeRawScore(totalOnly)).toBeCloseTo(SCORE_WEIGHTS.totalSimilarity, 10);
  });

  it('Set3 identical-total + good description pair scores > 0.30', () => {
    // Approximation of "Tear off TPO" vs "Strip TPO membrane roofing system"
    const features: N3CandidateScoreFeatures = {
      ...zeroFeatures,
      descriptionFuzzySimilarity: 0.6,     // Jaccard ~0.4 but some overlap
      totalSimilarity: 1.0,                // identical total
      quantityUnitSimilarity: 1.0,         // same qty + unit
    };
    expect(computeRawScore(features)).toBeGreaterThan(0.30);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeFinalScore
// ─────────────────────────────────────────────────────────────────────────────

describe('computeFinalScore', () => {
  it('clamps to 0 minimum', () => {
    const boosts: N3ZoneBoost[] = [{ type: 'outside_verified', value: -2.0 }];
    expect(computeFinalScore(0.3, boosts)).toBe(0);
  });

  it('clamps to 1 maximum', () => {
    const boosts: N3ZoneBoost[] = [{ type: 'user_corrected', value: 0.5 }];
    expect(computeFinalScore(0.9, boosts)).toBe(1);
  });

  it('returns rawScore unchanged with no boosts', () => {
    expect(computeFinalScore(0.75, [])).toBe(0.75);
  });

  it('applies user_corrected zone boost', () => {
    const boosts: N3ZoneBoost[] = [{ type: 'user_corrected', value: ZONE_BOOSTS.user_corrected }];
    const result = computeFinalScore(0.80, boosts);
    expect(result).toBeCloseTo(0.80 + ZONE_BOOSTS.user_corrected, 10);
  });

  it('applies outside_verified penalty', () => {
    const boosts: N3ZoneBoost[] = [{ type: 'outside_verified', value: ZONE_BOOSTS.outside_verified }];
    const result = computeFinalScore(0.80, boosts);
    expect(result).toBeCloseTo(0.80 + ZONE_BOOSTS.outside_verified, 10);
  });

  it('accumulates multiple boosts', () => {
    const boosts: N3ZoneBoost[] = [
      { type: 'user_corrected', value: 0.10 },
      { type: 'outside_verified', value: -0.05 },
    ];
    expect(computeFinalScore(0.70, boosts)).toBeCloseTo(0.75, 10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// shouldRejectEdge
// ─────────────────────────────────────────────────────────────────────────────

describe('shouldRejectEdge', () => {
  it('rejects edges below REJECT threshold', () => {
    expect(shouldRejectEdge(SCORE_THRESHOLDS.REJECT - 0.01)).toBe(true);
  });

  it('does not reject edges at exactly REJECT threshold', () => {
    expect(shouldRejectEdge(SCORE_THRESHOLDS.REJECT)).toBe(false);
  });

  it('does not reject high-confidence edges', () => {
    expect(shouldRejectEdge(0.95)).toBe(false);
  });

  it('does not reject possible-match edges', () => {
    expect(shouldRejectEdge(0.80)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixture integration: Set3 cross-zone pairs
// ─────────────────────────────────────────────────────────────────────────────

describe('fixture: set3-cross-zone-pairs — normalization pipeline', () => {
  it('fixture loads and has expected structure', () => {
    expect(fixture.yoursItems).toBeDefined();
    expect(fixture.adjusterItems).toBeDefined();
    expect(fixture.expectedPairs).toBeDefined();
    expect(fixture.yoursItems.length).toBeGreaterThan(0);
    expect(fixture.adjusterItems.length).toBeGreaterThan(0);
    expect(fixture.expectedPairs.length).toBe(fixture.yoursItems.length);
  });

  it('all yours totals parse as valid numbers', () => {
    for (const item of fixture.yoursItems) {
      expect(typeof item.totalAmount).toBe('number');
      expect(isFinite(item.totalAmount)).toBe(true);
    }
  });

  it('all adjuster totals parse as valid numbers', () => {
    for (const item of fixture.adjusterItems) {
      expect(typeof item.totalAmount).toBe('number');
      expect(isFinite(item.totalAmount)).toBe(true);
    }
  });

  it('failure mode #1: cross-zone identical-total pairs (y-001/a-001) have amountSimilarity = 1.0', () => {
    const yours = fixture.yoursItems.find((i) => i.id === 'y-001')!;
    const adj   = fixture.adjusterItems.find((i) => i.id === 'a-001')!;
    expect(amountSimilarity(yours.totalAmount, adj.totalAmount)).toBe(1.0);
  });

  it('failure mode #1: cross-zone identical-total pairs (y-002/a-002) have amountSimilarity = 1.0', () => {
    const yours = fixture.yoursItems.find((i) => i.id === 'y-002')!;
    const adj   = fixture.adjusterItems.find((i) => i.id === 'a-002')!;
    expect(amountSimilarity(yours.totalAmount, adj.totalAmount)).toBe(1.0);
  });

  it('failure mode #2: wrong-zone demolition pair (y-003/a-003) has amountSimilarity = 1.0', () => {
    const yours = fixture.yoursItems.find((i) => i.id === 'y-003')!;
    const adj   = fixture.adjusterItems.find((i) => i.id === 'a-003')!;
    expect(amountSimilarity(yours.totalAmount, adj.totalAmount)).toBe(1.0);
  });

  it('all expected pairs have amountSimilarity = 1.0 (Set3 fixture uses identical totals)', () => {
    for (const pair of fixture.expectedPairs) {
      const yours = fixture.yoursItems.find((i) => i.id === pair.yourId)!;
      const adj   = fixture.adjusterItems.find((i) => i.id === pair.adjusterId)!;
      expect(amountSimilarity(yours.totalAmount, adj.totalAmount)).toBe(1.0);
    }
  });

  it('cross-zone pairs have description token overlap after normalization', () => {
    const crossZonePairs = fixture.expectedPairs.filter((p) => p.crossZone);
    for (const pair of crossZonePairs) {
      const yours = fixture.yoursItems.find((i) => i.id === pair.yourId)!;
      const adj   = fixture.adjusterItems.find((i) => i.id === pair.adjusterId)!;
      const tokensYours = tokenizeDescription(normalizeDescription(yours.rawDescription));
      const tokensAdj   = tokenizeDescription(normalizeDescription(adj.rawDescription));
      const j = jaccardSimilarity(tokensYours, tokensAdj);
      // Cross-zone pairs should have SOME token overlap (> 0) after normalization
      expect(j).toBeGreaterThan(0);
    }
  });

  it('R&R pair (y-004/a-004): normalizedDescriptions share tokens after expansion', () => {
    const yours = fixture.yoursItems.find((i) => i.id === 'y-004')!;
    const adj   = fixture.adjusterItems.find((i) => i.id === 'a-004')!;
    const tokensYours = tokenizeDescription(normalizeDescription(yours.rawDescription));
    const tokensAdj   = tokenizeDescription(normalizeDescription(adj.rawDescription));
    // both should have 'remove', 'replace', 'carpet' after expansion
    expect(tokensYours).toContain('carpet');
    expect(tokensAdj).toContain('carpet');
    expect(jaccardSimilarity(tokensYours, tokensAdj)).toBeGreaterThan(0.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ABBREV_EXPANSION dictionary
// ─────────────────────────────────────────────────────────────────────────────

describe('ABBREV_EXPANSION', () => {
  it('all values are lowercase', () => {
    for (const v of Object.values(ABBREV_EXPANSION)) {
      expect(v).toBe(v.toLowerCase());
    }
  });

  it('all keys are lowercase', () => {
    for (const k of Object.keys(ABBREV_EXPANSION)) {
      expect(k).toBe(k.toLowerCase());
    }
  });

  it('r&r expands to "remove and replace"', () => {
    expect(ABBREV_EXPANSION['r&r']).toBe('remove and replace');
  });

  it('d&r expands to "detach and reset"', () => {
    expect(ABBREV_EXPANSION['d&r']).toBe('detach and reset');
  });
});
