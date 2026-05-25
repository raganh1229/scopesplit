/**
 * N2 Deterministic Pre-Match Layer
 *
 * Adapted from deterministic-prematch.ts for the N2 Large Zone Flow.
 * Operates on already-extracted JSON items from Step 1 (no PDF text parsing).
 * Pairs obvious line-item matches using description-primary matching with
 * tightened thresholds (0.90 confidence) to maximize precision.
 *
 * Design principles:
 *  - Description is king: if descriptions clearly refer to the same work
 *    item, it's a pair — regardless of cost/qty/position differences
 *  - High precision, moderate recall: only auto-match near-certain pairs,
 *    leave ambiguous cases for the AI matching step
 *  - One-to-one: each item can only match once (best reciprocal pair)
 *  - Auditable: every auto-match carries a confidence score + source tag
 *  - Zero data loss: unmatched items pass through untouched to AI
 */

import { N2ExtractedItem } from '@/lib/n2/schemas/types';

// ── Types ────────────────────────────────────────────────────────────────────

export type N2ParsedItem = {
  n: number;
  d: string;
  descriptionTokens: string[];
  q: string | null;
  u: string | null;
  rm: number | null;
  rp: number | null;
  rs: number | null;
  tx: number | null;
  op: number | null;
  t: number | null;
};

export type N2DeterministicMatch = {
  e1: N2ExtractedItem;
  e2: N2ExtractedItem;
  confidence: number;
  status: 'MATCH' | 'MODIFIED';
  resolutionSource: 'deterministic';
};

export type N2PrematchResult = {
  matches: N2DeterministicMatch[];
  unmatchedE1: N2ExtractedItem[];
  unmatchedE2: N2ExtractedItem[];
  stats: N2PrematchStats;
};

export type N2PrematchStats = {
  e1InputCount: number;
  e2InputCount: number;
  autoMatchedCount: number;
  exactMatchCount: number;
  modifiedMatchCount: number;
  unmatchedE1Count: number;
  unmatchedE2Count: number;
  avgConfidence: number;
};

// ── Configuration ────────────────────────────────────────────────────────────

const MIN_DESCRIPTION_SCORE = 0.80;
const MIN_OVERALL_CONFIDENCE = 0.90; // Tightened from 0.82 — high precision for N2
const MIN_TOKEN_OVERLAP = 2;
const COST_TOLERANCE = 0.005; // half a cent

// ── Stopwords (stripped from descriptions before comparison) ──────────────────

const STOPWORDS = new Set([
  // ── Articles / prepositions / conjunctions ──
  'the', 'a', 'an', 'of', 'for', 'per', 'to', 'in', 'on', 'at', 'by',
  'with', 'and', 'or', 'up', 'is', 'it', 'be', 'as', 'from', 'that',
  'this', 'into', 'over', 'under', 'through', 'its', 'each', 'all',
  'no', 'not', 'but', 'so', 'if', 'then', 'than', 'too', 'very',
  'can', 'will', 'do', 'does', 'did', 'has', 'have', 'had', 'was',
  'were', 'been', 'being', 'are', 'am',
  // ── Estimate filler (appear in many descriptions without adding identity) ──
  'new', 'existing', 'old', 'after', 'before', 'during', 'about',
  'also', 'only', 'other', 'any', 'some', 'most', 'such',
  'including', 'includes', 'included', 'upon', 'within',
  'use', 'using', 'used', 'type', 'style', 'grade', 'class',
  'based', 'item', 'line', 'note', 'see', 'ref', 'below', 'above',
]);

// ── Abbreviation expansion (common Xactimate shorthand) ──────────────────────

const ABBREVIATIONS = new Map<string, string>([
  // ── Management / admin ──
  ['mgmt', 'management'],
  ['mgt', 'management'],
  ['supv', 'supervisor'],
  ['coord', 'coordinator'],
  // ── Size / grade ──
  ['ext', 'exterior'],
  ['int', 'interior'],
  ['std', 'standard'],
  ['hi', 'high'],
  ['med', 'medium'],
  ['lrg', 'large'],
  ['lg', 'large'],
  ['sm', 'small'],
  ['sml', 'small'],
  ['dbl', 'double'],
  ['sgl', 'single'],
  ['hvy', 'heavy'],
  ['lt', 'light'],
  ['min', 'minimum'],
  ['max', 'maximum'],
  ['avg', 'average'],
  // ── General descriptors ──
  ['approx', 'approximately'],
  ['temp', 'temporary'],
  ['perm', 'permanent'],
  ['resi', 'residential'],
  ['resid', 'residential'],
  ['comm', 'commercial'],
  ['orig', 'original'],
  ['incl', 'including'],
  ['excl', 'excluding'],
  ['addl', 'additional'],
  ['misc', 'miscellaneous'],
  // ── Materials ──
  ['wd', 'wood'],
  ['hwd', 'hardwood'],
  ['ply', 'plywood'],
  ['osb', 'oriented strand board'],
  ['alum', 'aluminum'],
  ['galv', 'galvanized'],
  ['conc', 'concrete'],
  ['lam', 'laminate'],
  ['cer', 'ceramic'],
  ['porc', 'porcelain'],
  ['gran', 'granite'],
  ['mrbl', 'marble'],
  ['qtz', 'quartz'],
  ['vct', 'vinyl composition tile'],
  ['lvp', 'luxury vinyl plank'],
  ['lvt', 'luxury vinyl tile'],
  ['fgl', 'fiberglass'],
  ['fbg', 'fiberglass'],
  ['gyp', 'gypsum'],
  ['sheetrock', 'drywall'],
  ['gypbd', 'drywall'],
  ['dw', 'drywall'],
  // ── Rooms / areas ──
  ['ceil', 'ceiling'],
  ['clg', 'ceiling'],
  ['flr', 'floor'],
  ['bdrm', 'bedroom'],
  ['bth', 'bathroom'],
  ['kit', 'kitchen'],
  ['gar', 'garage'],
  ['bsmt', 'basement'],
  ['mstr', 'master'],
  ['mst', 'master'],
  // ── Trades / systems ──
  ['instl', 'installation'],
  ['insul', 'insulation'],
  ['furn', 'furnace'],
  ['equip', 'equipment'],
  ['struct', 'structural'],
  ['repl', 'replacement'],
  ['pntg', 'painting'],
  ['plmbg', 'plumbing'],
  ['plmb', 'plumbing'],
  ['elec', 'electrical'],
  ['mech', 'mechanical'],
  // ── Building components ──
  ['wdw', 'window'],
  ['win', 'window'],
  ['cab', 'cabinet'],
  ['cabs', 'cabinet'],
  ['cpt', 'carpet'],
  ['crpt', 'carpet'],
  ['bsbd', 'baseboard'],
  ['trm', 'trim'],
  ['mldg', 'molding'],
  ['csg', 'casing'],
  ['ctop', 'countertop'],
  ['bksp', 'backsplash'],
  ['shwr', 'shower'],
  ['disp', 'disposal'],
  ['frig', 'refrigerator'],
  ['refrig', 'refrigerator'],
  ['micro', 'microwave'],
  // ── Roofing ──
  ['shgl', 'shingle'],
  ['shing', 'shingle'],
  ['rdg', 'ridge'],
  ['vlly', 'valley'],
  ['flshg', 'flashing'],
  ['undrlmt', 'underlayment'],
  ['dck', 'decking'],
  ['rfg', 'roofing'],
  ['gtr', 'gutter'],
  ['dnspt', 'downspout'],
  // ── Finishes ──
  ['pnt', 'paint'],
  ['prmr', 'primer'],
  ['stn', 'stain'],
  ['var', 'varnish'],
  ['txt', 'texture'],
  ['tex', 'texture'],
  ['egl', 'eggshell'],
  // ── Measurements ──
  ['dia', 'diameter'],
  ['thk', 'thick'],
  ['ht', 'height'],
  ['ln', 'linear'],
  ['det', 'detach'],
]);

// ── Action-verb synonyms (Xactimate descriptions use interchangeable verbs) ──

const ACTION_SYNONYMS = new Map<string, string>([
  // ── install family ──
  ['hang', 'install'],
  ['apply', 'install'],
  ['lay', 'install'],
  ['set', 'install'],
  ['mount', 'install'],
  ['affix', 'install'],
  ['attach', 'install'],
  ['fasten', 'install'],
  ['place', 'install'],
  ['secure', 'install'],
  // ── remove family ──
  ['tear', 'remove'],
  ['demo', 'remove'],
  ['demolish', 'remove'],
  ['strip', 'remove'],
  ['rip', 'remove'],
  ['pull', 'remove'],
  ['gut', 'remove'],
  ['extract', 'remove'],
  ['dispose', 'remove'],
  ['haul', 'remove'],
  // ── detach family ──
  ['disconnect', 'detach'],
  ['unhook', 'detach'],
  ['unfasten', 'detach'],
  // ── reset family (remove & reinstall) ──
  ['reinstall', 'reset'],
  ['rehang', 'reset'],
  ['reconnect', 'reset'],
  ['reattach', 'reset'],
  ['remount', 'reset'],
  // ── seal family ──
  ['prime', 'seal'],
  ['caulk', 'seal'],
  ['weatherstrip', 'seal'],
  // ── repair family ──
  ['patch', 'repair'],
  ['mend', 'repair'],
  ['fix', 'repair'],
  ['restore', 'repair'],
  // ── build / construct family ──
  ['construct', 'build'],
  ['erect', 'build'],
  ['assemble', 'build'],
  ['fabricate', 'build'],
  ['frame', 'build'],
]);

// ── Plural normalization (simple suffix rules for token matching) ────────────

function normalizePlural(token: string): string {
  if (token.length <= 3) return token;
  // -ing suffix: masking→mask, framing→frame, sistering→sister
  // Guard against short stems (e.g. "ring" → "r" would be bad)
  if (token.endsWith('ing') && token.length > 5) return token.slice(0, -3);
  if (token.endsWith('ies') && token.length > 4) return token.slice(0, -3) + 'y';
  if (token.endsWith('ches') || token.endsWith('shes')) return token.slice(0, -2);
  if (token.endsWith('xes') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

// ── Description tokenization ─────────────────────────────────────────────────

function descriptionToTokens(desc: string): string[] {
  let text = desc.toLowerCase();

  // Expand "R&R" before punctuation stripping destroys the ampersand.
  // "R&R Tile floor" → "remove replace Tile floor"
  text = text.replace(/\br\s*&\s*r\b/gi, 'remove replace');

  // Preserve inch measurements before punctuation stripping:
  // "3.5"" → " dim3p5in ", "1"" → " dim1in ", "6"" → " dim6in "
  // This keeps product-spec dimensions as matchable tokens.
  text = text.replace(/(\d+(?:\.\d+)?)\s*[""″]/g, (_, num: string) =>
    ` dim${num.replace('.', 'p')}in `
  );
  // Preserve foot measurements: "8'" → " dim8ft "
  text = text.replace(/(\d+(?:\.\d+)?)\s*[''′]/g, (_, num: string) =>
    ` dim${num.replace('.', 'p')}ft `
  );

  return text
    .replace(/[/\-]/g, ' ')              // split on / and - (word separators)
    .replace(/[^a-z0-9\s]/g, '')         // strip remaining punctuation
    .split(/\s+/)
    .filter((t) => t.length >= 2)         // drop single chars (truncation artifacts)
    .filter((t) => !/^\d+$/.test(t))      // drop pure numbers (dims are now "dim3p5in", safe)
    .filter((t) => !STOPWORDS.has(t))     // drop stopwords
    .map((t) => ABBREVIATIONS.get(t) ?? t) // expand abbreviations
    .map((t) => ACTION_SYNONYMS.get(t) ?? t) // normalize action verbs
    .map(normalizePlural);                   // normalize plurals (coats→coat)
}

// ── Description similarity (hybrid: Jaccard + containment) ───────────────────

function descriptionScore(tokensA: string[], tokensB: string[]): {
  score: number;
  overlap: number;
} {
  if (tokensA.length === 0 && tokensB.length === 0) return { score: 0, overlap: 0 };
  if (tokensA.length === 0 || tokensB.length === 0) return { score: 0, overlap: 0 };

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection += 1;
  }

  // Allow single-token descriptions (e.g. "Toilet") to match each other.
  // When either side has multiple tokens, still require the full overlap minimum.
  const effectiveMinOverlap = (setA.size <= 1 && setB.size <= 1) ? 1 : MIN_TOKEN_OVERLAP;
  if (intersection < effectiveMinOverlap) return { score: 0, overlap: intersection };

  const union = new Set([...setA, ...setB]).size;
  const jaccard = union > 0 ? intersection / union : 0;

  // Containment: all tokens of the shorter set appear in the longer?
  // Handles "nails" vs "bag of nails"
  const smallerSize = Math.min(setA.size, setB.size);
  const containment = smallerSize > 0 ? intersection / smallerSize : 0;

  return {
    score: Math.max(jaccard, containment),
    overlap: intersection,
  };
}

// ── Cost comparison ──────────────────────────────────────────────────────────

function costsAllMatch(e1: N2ExtractedItem, e2: N2ExtractedItem): boolean {
  const fields: (keyof Pick<N2ExtractedItem, 'rm' | 'rp' | 'rs' | 'tx' | 'op' | 't'>)[] =
    ['rm', 'rp', 'rs', 'tx', 'op', 't'];
  for (const f of fields) {
    const va = e1[f];
    const vb = e2[f];
    if (va === null && vb === null) continue;
    if (va === null || vb === null) continue; // skip fields where one side is missing
    if (Math.abs(va - vb) > COST_TOLERANCE) return false;
  }
  return true;
}

function quantitiesEqual(a: string | null, b: string | null): boolean {
  if (a === b) return true; // exact match or both null
  if (a === null || b === null) return false;
  const numA = parseFloat(a);
  const numB = parseFloat(b);
  if (isNaN(numA) || isNaN(numB)) return a === b; // fallback to string compare
  return Math.abs(numA - numB) < 0.001;
}

// ── Core matching logic (description-primary) ────────────────────────────────

function parseItem(item: N2ExtractedItem): N2ParsedItem {
  return {
    ...item,
    descriptionTokens: descriptionToTokens(item.d),
  };
}

function computePairConfidence(e1: N2ParsedItem, e2: N2ParsedItem): number {
  // Primary signal: description similarity
  const desc = descriptionScore(e1.descriptionTokens, e2.descriptionTokens);
  if (desc.score < MIN_DESCRIPTION_SCORE) return 0;

  // Hard gate: unit mismatch is a red flag (SF vs LF = different items)
  if (e1.u !== null && e2.u !== null && e1.u !== e2.u) return 0;

  // Start with description score as the base (weighted 70%)
  let confidence = desc.score * 0.70;

  // Boost: qty match (10%)
  if (e1.q !== null && e2.q !== null && e1.q === e2.q) {
    confidence += 0.10;
  } else if (e1.q !== null && e2.q !== null) {
    confidence += 0.03; // both have qty but differ — small boost for having structure
  } else {
    confidence += 0.05; // one or both missing qty — neutral
  }

  // Boost: unit match (10%)
  if (e1.u !== null && e2.u !== null && e1.u === e2.u) {
    confidence += 0.10;
  } else {
    confidence += 0.05;
  }

  // Boost: cost structure similarity (10%) — total present on both sides
  const e1HasTotal = e1.t !== null;
  const e2HasTotal = e2.t !== null;
  if (e1HasTotal && e2HasTotal) {
    confidence += 0.10;
  } else {
    confidence += 0.03;
  }

  return confidence;
}

// ── Best reciprocal matching (greedy best-pair) ──────────────────────────────

type CandidatePair = {
  e1Index: number;
  e2Index: number;
  confidence: number;
};

function findBestReciprocalMatches(
  e1Parsed: N2ParsedItem[],
  e2Parsed: N2ParsedItem[],
  e1Items: N2ExtractedItem[],
  e2Items: N2ExtractedItem[]
): N2DeterministicMatch[] {
  const candidates: CandidatePair[] = [];
  for (let i = 0; i < e1Parsed.length; i++) {
    for (let j = 0; j < e2Parsed.length; j++) {
      const conf = computePairConfidence(e1Parsed[i]!, e2Parsed[j]!);
      if (conf >= MIN_OVERALL_CONFIDENCE) {
        candidates.push({ e1Index: i, e2Index: j, confidence: conf });
      }
    }
  }

  // Sort by confidence descending for greedy best-pair
  candidates.sort((a, b) => b.confidence - a.confidence);

  const usedE1 = new Set<number>();
  const usedE2 = new Set<number>();
  const matches: N2DeterministicMatch[] = [];

  for (const c of candidates) {
    if (usedE1.has(c.e1Index) || usedE2.has(c.e2Index)) continue;
    usedE1.add(c.e1Index);
    usedE2.add(c.e2Index);

    const e1 = e1Items[c.e1Index]!;
    const e2 = e2Items[c.e2Index]!;
    const allCostsEqual = costsAllMatch(e1, e2);
    const qtyEqual = quantitiesEqual(e1.q, e2.q);
    const status: 'MATCH' | 'MODIFIED' = allCostsEqual && qtyEqual ? 'MATCH' : 'MODIFIED';

    matches.push({
      e1,
      e2,
      confidence: Math.round(c.confidence * 1000) / 1000,
      status,
      resolutionSource: 'deterministic',
    });
  }

  return matches;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Run deterministic prematch on two extracted item lists from the Large Zone Flow.
 *
 * Input: Two arrays of N2ExtractedItem (output of Step 1 extraction).
 * Output: High-confidence matches + unmatched items for AI matching.
 *
 * Items are matched purely by description similarity with tightened thresholds
 * (0.90 confidence). This is a precision-first pre-filter — it catches the
 * obvious 60-80% of pairs and leaves ambiguous cases for the AI step.
 */
export function runN2Prematch(
  e1Items: N2ExtractedItem[],
  e2Items: N2ExtractedItem[]
): N2PrematchResult {
  // Parse descriptions into tokens for matching
  const e1Parsed = e1Items.map(parseItem);
  const e2Parsed = e2Items.map(parseItem);

  // Run reciprocal matching
  const matches = findBestReciprocalMatches(e1Parsed, e2Parsed, e1Items, e2Items);

  // Build unmatched lists
  const matchedE1Nums = new Set(matches.map((m) => m.e1.n));
  const matchedE2Nums = new Set(matches.map((m) => m.e2.n));

  const unmatchedE1 = e1Items.filter((item) => !matchedE1Nums.has(item.n));
  const unmatchedE2 = e2Items.filter((item) => !matchedE2Nums.has(item.n));

  const avgConfidence =
    matches.length > 0
      ? matches.reduce((sum, m) => sum + m.confidence, 0) / matches.length
      : 0;

  return {
    matches,
    unmatchedE1,
    unmatchedE2,
    stats: {
      e1InputCount: e1Items.length,
      e2InputCount: e2Items.length,
      autoMatchedCount: matches.length,
      exactMatchCount: matches.filter((m) => m.status === 'MATCH').length,
      modifiedMatchCount: matches.filter((m) => m.status === 'MODIFIED').length,
      unmatchedE1Count: unmatchedE1.length,
      unmatchedE2Count: unmatchedE2.length,
      avgConfidence: Math.round(avgConfidence * 1000) / 1000,
    },
  };
}
