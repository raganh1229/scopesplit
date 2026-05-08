/**
 * Deterministic Pre-Match Layer (v2)
 *
 * Pairs obvious line-item matches between two Xactimate estimates
 * using description-primary matching. Costs determine MATCH vs MODIFIED
 * status but do NOT gate whether two items are the same line item.
 *
 * Design principles:
 *  - Description is king: if descriptions clearly refer to the same work
 *    item, it's a pair — regardless of cost/qty/position differences
 *  - Zone-scoped: items only match within the same room/zone
 *  - Position-independent within zone: items can appear in any order
 *  - One-to-one: each line can only match once (best reciprocal pair)
 *  - Auditable: every auto-match carries a confidence score + source tag
 *  - Zero data loss: unmatched lines pass through untouched to AI
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type PrematchLineRecord = {
  lineNumber: number;
  text: string;
};

export type ParsedScopeFields = {
  lineNumber: number;
  rawText: string;
  description: string;
  descriptionTokens: string[];
  quantity: string | null;
  unit: string | null;
  costs: ExtractedCosts;
  zone: string | null;
  category: string | null;
};

export type ExtractedCosts = {
  remove: number | null;
  replace: number | null;
  reset: number | null;
  tax: number | null;
  op: number | null;
  total: number | null;
};

export type DeterministicMatch = {
  yourLine: ParsedScopeFields;
  adjusterLine: ParsedScopeFields;
  confidence: number;
  status: 'MATCH' | 'MODIFIED';
  resolutionSource: 'deterministic';
};

export type PrematchResult = {
  matches: DeterministicMatch[];
  unmatchedYourLines: PrematchLineRecord[];
  unmatchedAdjusterLines: PrematchLineRecord[];
  yourParsedMap: Map<number, ParsedScopeFields>;
  adjusterParsedMap: Map<number, ParsedScopeFields>;
  stats: PrematchStats;
};

export type PrematchStats = {
  yourInputCount: number;
  adjusterInputCount: number;
  autoMatchedCount: number;
  exactMatchCount: number;
  modifiedMatchCount: number;
  unmatchedYoursCount: number;
  unmatchedAdjusterCount: number;
  avgConfidence: number;
};

// ── Configuration ────────────────────────────────────────────────────────────

const MIN_DESCRIPTION_SCORE = 0.80;
const MIN_OVERALL_CONFIDENCE = 0.82;
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

// ── Column layout detection ──────────────────────────────────────────────────

export type CostColumnName = 'remove' | 'replace' | 'reset' | 'tax' | 'op' | 'total';

export type ColumnLayout = {
  columns: CostColumnName[];
};

const DEFAULT_5_COL: ColumnLayout = { columns: ['remove', 'replace', 'tax', 'op', 'total'] };
const WATER_6_COL: ColumnLayout = { columns: ['reset', 'remove', 'replace', 'tax', 'op', 'total'] };
const RESET_AFTER_REPLACE_6_COL: ColumnLayout = { columns: ['remove', 'replace', 'reset', 'tax', 'op', 'total'] };

/**
 * Detect the cost column layout from PDF lines by finding the DESCRIPTION header row.
 * Returns null if no header found (caller should use fallback heuristic).
 */
export function detectColumnLayout(lines: Array<{ text: string }>): ColumnLayout | null {
  for (const line of lines) {
    const t = line.text.trim().toUpperCase().replace(/\s+/g, '');
    if (!t.includes('DESCRIPTION')) continue;
    if (!t.includes('TOTAL') && !t.includes('ACV') && !t.includes('RCV')) continue;

    // Water damage format: RESET before REMOVE
    if (t.includes('RESET') && t.includes('REMOVE') && t.includes('REPLACE')) {
      if (t.indexOf('RESET') < t.indexOf('REMOVE')) {
        return WATER_6_COL;
      }
      return RESET_AFTER_REPLACE_6_COL;
    }

    // Standard fire format: REMOVE, REPLACE, TAX, O&P, TOTAL
    if (t.includes('REMOVE') && t.includes('REPLACE')) {
      return DEFAULT_5_COL;
    }

    // RRA depreciation format: UNIT PRICE, TAX, O&P, RCV — map to replace/tax/op/total
    if (t.includes('UNITPRICE') || t.includes('UNIT PRICE')) {
      return { columns: ['replace', 'tax', 'op', 'total'] };
    }
  }
  return null;
}

// ── Cost extraction ──────────────────────────────────────────────────────────

const MONEY_PATTERN = /[\d,]+\.\d{2}/g;

function parseMoney(s: string): number | null {
  const cleaned = s.replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function stripQtyPatterns(text: string): string {
  // Only strip qty-then-unit (e.g. "200.00SF") — Xactimate column format.
  // Do NOT strip unit-then-qty here; it false-positives on description text
  // like "superintendent - hr" followed by cost numbers.
  return text.replace(new RegExp(QTY_UNIT_PATTERN.source, 'gi'), ' ');
}

function extractCosts(text: string, layout?: ColumnLayout | null): ExtractedCosts {
  // Strip qty+unit patterns so the quantity value doesn't pollute cost columns
  const costText = stripQtyPatterns(text);
  const matches = costText.match(MONEY_PATTERN);
  if (!matches || matches.length === 0) {
    return { remove: null, replace: null, reset: null, tax: null, op: null, total: null };
  }
  const nums = matches.map(parseMoney).filter((n): n is number => n !== null);
  if (nums.length === 0) {
    return { remove: null, replace: null, reset: null, tax: null, op: null, total: null };
  }

  // Layout-aware extraction: map values to columns by detected header order
  if (layout) {
    const result: ExtractedCosts = { remove: null, replace: null, reset: null, tax: null, op: null, total: null };
    const cols = layout.columns;
    for (let i = 0; i < Math.min(nums.length, cols.length); i++) {
      result[cols[i]!] = nums[i]!;
    }
    // Total is always the last value regardless of column count
    result.total = nums[nums.length - 1]!;
    return result;
  }

  // Fallback heuristic when no header detected
  const total = nums[nums.length - 1]!;
  if (nums.length <= 5) {
    return {
      remove: nums[0] ?? null,
      replace: nums[1] ?? null,
      reset: null,
      tax: nums[2] ?? null,
      op: nums[3] ?? null,
      total,
    };
  }
  return {
    remove: nums[0] ?? null,
    replace: nums[1] ?? null,
    reset: nums[2] ?? null,
    tax: nums[3] ?? null,
    op: nums[4] ?? null,
    total,
  };
}

export function costsAllMatch(a: ExtractedCosts, b: ExtractedCosts): boolean {
  const fields: (keyof ExtractedCosts)[] = ['remove', 'replace', 'reset', 'tax', 'op', 'total'];
  for (const f of fields) {
    const va = a[f];
    const vb = b[f];
    if (va === null && vb === null) continue;
    if (va === null || vb === null) continue; // skip fields where parser couldn't extract one side
    if (Math.abs(va - vb) > COST_TOLERANCE) return false;
  }
  return true;
}

export function quantitiesEqual(a: string | null, b: string | null): boolean {
  if (a === b) return true; // exact match or both null
  if (a === null || b === null) return false;
  const numA = parseFloat(a);
  const numB = parseFloat(b);
  if (isNaN(numA) || isNaN(numB)) return a === b; // fallback to string compare
  return Math.abs(numA - numB) < 0.001;
}

/**
 * Loose zone candidate detector — used to decide which non-scope lines to
 * include in the Claude payload as [ZONE?] markers. Over-inclusive by design;
 * Claude validates which candidates are real zone headers.
 */
export function isZoneCandidate(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > 80) return false;
  if (trimmed.length < 3) return false;
  // Lines with dollar amounts or decimal prices are scope items, not headers
  if (/\d+\.\d{2}/.test(trimmed)) return false;
  // Lines starting with item numbers are scope items
  if (/^\d+\.?\s/.test(trimmed)) return false;
  // Page numbers, dates
  if (/^page\s+\d/i.test(trimmed)) return false;
  if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(trimmed)) return false;
  // Must have at least some alphabetic content
  if (!/[a-zA-Z]{3,}/.test(trimmed)) return false;
  // Pure separators
  if (/^[\-=*_~]{3,}$/.test(trimmed)) return false;
  return true;
}

// ── Field extraction ─────────────────────────────────────────────────────────

const UNIT_PATTERN =
  /\b(SQ|LF|SF|EA|CY|HR|MO|WK|DY|LS|CF|BF|FF|RF|TN|GL|RL|BG|CS|PR|PC|CT|MBF|MLF)\b/i;

const QTY_UNIT_PATTERN =
  /(\d+\.?\d*)\s*(SQ|LF|SF|EA|CY|HR|MO|WK|DY|DA|LS|CF|BF|FF|RF|TN|GL|RL|BG|CS|PR|PC|CT|MBF|MLF)(?=[^a-zA-Z]|$)/i;

// Reverse pattern: unit appears BEFORE quantity (common Xactimate column layout)
const UNIT_QTY_PATTERN =
  /\b(SQ|LF|SF|EA|CY|HR|MO|WK|DY|DA|LS|CF|BF|FF|RF|TN|GL|RL|BG|CS|PR|PC|CT|MBF|MLF)\s+(\d+\.?\d*)/i;

const CATEGORY_PATTERN =
  /\b(RFG|PLM|DRY|ELC|FLR|PNT|INS|CLN|FNC|GNL|WDW|SID|CNT|DOR|CAB|APL|DML|GRD|HTG|MAS|STR|WDP|CLG|EXT|INT)\b/;

function extractDescription(text: string): string {
  let desc = text.replace(/^\d+\|/, '');
  // Strip leading item numbers (e.g. "1.", "247.")
  desc = desc.replace(/^\d+\.\s*/, '');
  // Strip quantities with units (globally) — both qty-unit and unit-qty orders
  desc = desc.replace(new RegExp(QTY_UNIT_PATTERN.source, 'gi'), '');
  desc = desc.replace(new RegExp(UNIT_QTY_PATTERN.source, 'gi'), '');
  // Strip money values
  desc = desc.replace(MONEY_PATTERN, '');
  // Split camelCase boundaries (e.g., "ToiletEA" → "Toilet EA") so that unit
  // abbreviations concatenated to description words become extractable.
  desc = desc.replace(/([a-z])([A-Z])/g, '$1 $2');
  // Strip category codes
  desc = desc.replace(new RegExp(CATEGORY_PATTERN.source, 'g'), '');
  // Strip unit abbreviations standing alone
  desc = desc.replace(new RegExp(UNIT_PATTERN.source, 'gi'), '');
  // Strip empty parentheses left after category/unit removal, e.g. "(CLN)" → "()"
  desc = desc.replace(/\(\s*\)/g, '');
  // Strip trailing separator fragments left after stripping, e.g. " - " at end
  desc = desc.replace(/[\s\-]+$/, '');
  // Collapse whitespace
  desc = desc.replace(/\s+/g, ' ').trim();
  return desc;
}

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

function extractQuantityAndUnit(text: string): { quantity: string | null; unit: string | null } {
  // Try qty-then-unit first (e.g. "306.28 SF")
  const m = text.match(QTY_UNIT_PATTERN);
  if (m) {
    return { quantity: m[1] ?? null, unit: (m[2] ?? '').toUpperCase() || null };
  }
  // Try unit-then-qty (Xactimate column layout: "SF 306.28")
  const r = text.match(UNIT_QTY_PATTERN);
  if (r) {
    return { quantity: r[2] ?? null, unit: (r[1] ?? '').toUpperCase() || null };
  }
  return { quantity: null, unit: null };
}

function extractCategory(text: string): string | null {
  const m = text.match(CATEGORY_PATTERN);
  return m ? m[0].toUpperCase() : null;
}

export function parseLineToFields(line: PrematchLineRecord, zone?: string, layout?: ColumnLayout | null): ParsedScopeFields {
  const { quantity, unit } = extractQuantityAndUnit(line.text);
  const description = extractDescription(line.text);
  return {
    lineNumber: line.lineNumber,
    rawText: line.text,
    description,
    descriptionTokens: descriptionToTokens(description),
    quantity,
    unit,
    costs: extractCosts(line.text, layout),
    zone: zone ?? null,
    category: extractCategory(line.text),
  };
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

// ── Multi-line joining (handles PDFs where description + numbers are split) ──

// A description-only line: starts with an item number, has alpha words, but NO
// decimal cost patterns like "123.45". This catches lines like:
//   "1. Dumpster load - approx. 20 yards, 4 tons"
const ITEM_NUMBER_PREFIX = /^\d+\.\s+/;
const HAS_ALPHA_WORD = /[a-zA-Z]{3,}/;
const HAS_DECIMAL = /\d+\.\d{2}/;

function isDescriptionOnlyLine(text: string): boolean {
  return ITEM_NUMBER_PREFIX.test(text) && HAS_ALPHA_WORD.test(text) && !HAS_DECIMAL.test(text);
}

// A numbers-only line: dominated by decimal values with a unit abbreviation
// embedded (possibly concatenated with no spaces). This catches lines like:
//   "1.00EA712.000.0068.41142.40922.81"   (no spaces)
//   "1.00 EA 712.00 0.00 68.41 142.40"    (spaced)
const LOOSE_QTY_UNIT = /\d+\.?\d*\s*(?:SQ|LF|SF|EA|CY|HR|MO|WK|DY|LS|CF|BF|FF|RF|TN|GL|RL|BG|CS|PR|PC|CT|MBF|MLF|DA)/i;

function isNumbersOnlyLine(text: string): boolean {
  if (!HAS_DECIMAL.test(text)) return false;
  if (!LOOSE_QTY_UNIT.test(text)) return false;
  // Count alphabetic words (3+ letters) — numbers-only lines have very few
  const alphaWords = text.match(/[a-zA-Z]{3,}/g) ?? [];
  return alphaWords.length <= 1; // at most a unit abbreviation
}

/**
 * Join split lines: when a description-only line is immediately followed by a
 * numbers-only line, merge them into a single line. This normalizes PDFs where
 * the layout puts descriptions and cost data on separate lines.
 *
 * Lines that are already combined (Set 1 style) pass through unchanged.
 */
function joinSplitLines(lines: PrematchLineRecord[]): PrematchLineRecord[] {
  const result: PrematchLineRecord[] = [];
  let i = 0;
  while (i < lines.length) {
    const current = lines[i]!;
    const next = i + 1 < lines.length ? lines[i + 1]! : null;

    if (next && isDescriptionOnlyLine(current.text) && isNumbersOnlyLine(next.text)) {
      // Merge: description + space + numbers, keep the description line's lineNumber
      result.push({
        lineNumber: current.lineNumber,
        text: current.text + ' ' + next.text,
      });
      i += 2; // skip both lines
    } else {
      result.push(current);
      i += 1;
    }
  }
  return result;
}

// ── Zone tracking (assigns each line to the room/zone it belongs to) ────────

const KNOWN_ZONE_PREFIXES = new RegExp(
  '^(?:' +
  [
    // ── Administrative / general ──
    'general(?:\\s+items)?',
    // ── Living spaces ──
    'living', 'living\\s*room', 'family\\s+room', 'great\\s+room', 'den',
    'sunroom', 'sun\\s+room', 'bonus\\s+room', 'game\\s+room',
    'recreation\\s+room', 'rec\\s+room', 'media\\s+room',
    'theater\\s+room', 'home\\s+theater', 'loft', 'alcove',
    // ── Kitchen / dining ──
    'kitchen', 'dining\\s*room', 'breakfast\\s+nook',
    'eat[\\s-]*in\\s+kitchen', "butler(?:'?s)?\\s+pantry", 'pantry',
    // ── Bedrooms ──
    'bedroom(?:\\s*\\d+)?', 'primary\\s+bedroom', 'master\\s+bedroom',
    'guest\\s+(?:room|bedroom|bath(?:room)?)', 'nursery',
    'in[\\s-]*law\\s+suite', 'mother[\\s-]*in[\\s-]*law\\s+suite',
    // ── Bathrooms ──
    'bath(?:room)?(?:\\s*\\d+)?', 'primary\\s+bath(?:room)?',
    'master\\s+bath(?:room)?', 'half\\s+bath', 'powder\\s+room',
    'jack\\s+and\\s+jill\\s+bath(?:room)?',
    // ── Hallways / transitions ──
    'hallway(?:\\s*\\d+)?', 'hall(?:\\s*\\d+)?', 'foyer', 'entry(?:way)?',
    'vestibule', 'breezeway', 'mudroom', 'mud\\s*room',
    'stairs', 'stairway', 'staircase', 'landing(?:\\s*\\d+)?',
    // ── Storage / utility ──
    'closet(?:\\s*\\d+)?', 'walk[\\s-]*in\\s+closet',
    'laundry(?:\\s+room)?', 'utility(?:\\s+room)?',
    'storage(?:\\s+room)?', 'mechanical\\s+room',
    'safe\\s+room', 'storm\\s+shelter',
    // ── Basement / attic / crawlspace ──
    'basement', 'attic', 'crawl\\s*space',
    // ── Garage ──
    'garage(?:\\s*\\d+)?', 'detached\\s+garage', 'carport',
    // ── Outdoor living ──
    '(?:front\\s+|back\\s+|rear\\s+|side\\s+|screen(?:ed)?\\s+|covered\\s+|enclosed\\s+)?porch',
    '(?:covered\\s+)?patio', 'deck', 'balcony', 'terrace', 'veranda', 'lanai',
    'pergola', 'gazebo', 'arbor',
    'pool\\s+(?:house|area)', 'hot\\s+tub\\s+area',
    // ── Outbuildings ──
    'shed', 'outbuilding', 'guest\\s+house', 'pool\\s+house',
    'workshop', 'workroom',
    // ── Specialty rooms ──
    'office(?:\\s*\\d+)?', 'home\\s+office', 'study',
    'exercise\\s+room', 'gym', 'sauna', 'spa',
    'wine\\s+cellar', 'wet\\s+bar',
    // ── Roofing areas ──
    'roof(?:\\s*\\d+)?', 'main\\s+roof', 'low\\s+roof', 'steep\\s+roof',
    'flat\\s+roof', 'garage\\s+roof', 'porch\\s+roof',
    'dormer(?:\\s*\\d+)?', 'chimney', 'skylight\\s+area',
    // NOTE: soffit, fascia, eave, overhang, gutter, ridge, valley, hip
    // removed — these are roofing COMPONENTS that appear as line items,
    // not zone headers. They caused false zone detection (e.g. "Fascia board R&R"
    // being treated as a zone header). Claude now validates zone candidates.
    // ── Exterior sections ──
    'exterior(?:\\s+\\w+)?', 'interior',
    'siding', 'foundation', 'concrete', 'flatwork',
    'fence', 'fencing', 'driveway', 'walkway', 'sidewalk',
    'retaining\\s+wall', 'landscape', 'landscaping',
    'grading', 'drainage', 'irrigation',
    // ── Floor levels ──
    '(?:first|second|third|1st|2nd|3rd)\\s+floor',
    '(?:main|upper|lower|ground)\\s+level',
    // ── Damage / services sections ──
    'contents', 'temporary\\s+(?:repairs|housing)',
    'emergency\\s+services', 'mitigation',
    'mold\\s+remediation', 'water\\s+damage',
    'fire\\s+damage', 'smoke\\s+damage',
    'additional\\s+living\\s+expense(?:s)?', 'ale',
    // ── Misc ──
    'primary\\s+suite',
  ].join('|') +
  ')',
  'i'
);

const TOTALS_PREFIX = /^(?:sub\s*)?totals?\s*[:\s]/i;
const GRAND_TOTAL = /^grand\s*total/i;
const SUMMARY_LINE = /^(?:replacement\s*cost\s*value|net\s*claim|line\s*item\s*total|actual\s*cash\s*value|(?:overhead|profit)\s*[\d$]|summary$)/i;

// Words allowed in zone header remainders (compound zone names like
// "Utility / Mechanical Room", "2nd Floor Hallway", "Office / Den").
const ZONE_REMAINDER_WORDS = new Set([
  // Generic suffixes
  'room', 'area', 'items', 'suite', 'unit', 'space',
  // Room types that appear as secondary descriptors
  'hallway', 'hall', 'den', 'lanai', 'porch', 'patio', 'bath', 'bathroom',
  'bedroom', 'closet', 'kitchen', 'dining', 'office', 'nursery', 'nook',
  'balcony', 'terrace', 'garage', 'basement', 'attic',
  // Trade / section qualifiers
  'mechanical', 'additional', 'charges', 'plumbing', 'electrical',
  'mep', 'hvac', 'remediation', 'services', 'misc',
  // Directional / positional qualifiers
  'screen', 'screened', 'covered', 'enclosed', 'front', 'back',
  'rear', 'side', 'upper', 'lower', 'main', 'north', 'south', 'east', 'west',
]);

/**
 * Normalize a zone name to a canonical form so that variant names match.
 * Examples: "Master Bathroom" → "master bath", "Living Room" → "living",
 * "General Items" → "general", "Office / Den" → "office"
 */
function normalizeZoneName(raw: string): string {
  let z = raw.toLowerCase()
    .replace(/\s*\(continued\)\s*/g, '')
    .replace(/height\s*:\s*\d+[''\u2032]?\s*/gi, '')
    .replace(/\s+/g, ' ').trim();

  // Take primary zone name (before first / or &)
  const sepIdx = z.search(/\s*[\/&]\s*/);
  if (sepIdx > 0) z = z.slice(0, sepIdx).trim();

  // "bathroom" → "bath" everywhere
  z = z.replace(/\bbathroom\b/g, 'bath');
  // Strip trailing "room" ("living room" → "living", "utility room" → "utility")
  z = z.replace(/\s+room$/, '');
  // Strip trailing "items" ("general items" → "general")
  z = z.replace(/\s+items$/, '');
  // Strip trailing "area" ("pool area" → "pool")
  z = z.replace(/\s+area$/, '');

  return z.trim();
}

/**
 * Detect if a line is a zone/room header (e.g., "Kitchen", "General Items").
 * Returns the normalized zone name, or null if not a zone header.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function detectZoneHeader(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length > 80) return null;
  if (trimmed.length < 3) return null;
  if (HAS_DECIMAL.test(trimmed)) return null;       // has costs → not a header
  if (ITEM_NUMBER_PREFIX.test(trimmed)) return null; // item number → scope line
  if (TOTALS_PREFIX.test(trimmed)) return null;
  if (GRAND_TOTAL.test(trimmed)) return null;

  // Strip height annotation before matching (e.g., "KitchenHeight: 8'")
  const cleaned = trimmed.replace(/height\s*:\s*\d+[''\u2032]?\s*/gi, '').trim();

  const m = cleaned.match(KNOWN_ZONE_PREFIXES);
  if (m) {
    let remainder = cleaned.slice(m[0].length).trim();
    // Allow "(CONTINUED)" as a valid suffix for multi-page zones.
    remainder = remainder.replace(/\(continued\)/i, '').trim();
    // Allow "/" and "&" separators and known zone-related words in remainder.
    // Reject if ANY remainder word is not in the allowlist (e.g., "GENERAL
    // REQUIREMENTS" → "REQUIREMENTS" not allowed → reject).
    const remainderWords = remainder.replace(/[\/&,\-]/g, ' ').split(/\s+/)
      .filter(w => /[a-zA-Z]{3,}/.test(w));
    if (remainderWords.length > 0) {
      const allAllowed = remainderWords.every(w => ZONE_REMAINDER_WORDS.has(w.toLowerCase()));
      if (!allAllowed) return null;
    }
    return normalizeZoneName(cleaned);
  }
  return null;
}

/**
 * Detect totals/grand total lines that should be excluded from matching.
 */
function isTotalsOrGrandTotal(text: string): boolean {
  const trimmed = text.trim();
  return TOTALS_PREFIX.test(trimmed) || GRAND_TOTAL.test(trimmed) || SUMMARY_LINE.test(trimmed);
}

type ZonedLineRecord = PrematchLineRecord & { assignedZone: string };

/**
 * Walk through lines, skipping totals but KEEPING zone header lines.
 * Zone assignment is deferred to Claude — all items get __UNZONED__.
 * Zone header lines are preserved so they flow through to Claude as
 * document structure context ([ZONE?] markers).
 */
function assignZonesToLines(lines: PrematchLineRecord[]): ZonedLineRecord[] {
  const result: ZonedLineRecord[] = [];

  for (const line of lines) {
    if (isTotalsOrGrandTotal(line.text)) continue; // skip totals
    result.push({ ...line, assignedZone: '__UNZONED__' });
  }

  return result;
}

// ── Numbered-item extraction (primary scope-line detection) ──────────────────

const NUMBERED_ITEM = /^\s*\d+\.\s+/;
const CONTINUATION_ALPHA = /[a-zA-Z]{3,}/;
const NOTE_PREFIX = /^\s*(NOTE|Explanation)\s*[-:]/i;
const COLUMN_HEADER_LINE = /DESCRIPTION/i;

/**
 * Extract scope items by identifying numbered lines (e.g. "1.  Dumpster load...").
 * Non-numbered lines following a numbered item are treated as description
 * continuations and concatenated. Everything else is noise and skipped.
 *
 * Returns merged PrematchLineRecords ready for parsing.
 */
function extractNumberedItems(lines: PrematchLineRecord[]): PrematchLineRecord[] {
  const result: PrematchLineRecord[] = [];
  let current: PrematchLineRecord | null = null;

  for (const line of lines) {
    const t = line.text.trim();

    // Skip empty, totals, grand totals, summary lines, column headers
    if (t.length === 0) continue;
    if (isTotalsOrGrandTotal(t)) continue;
    if (COLUMN_HEADER_LINE.test(t) && t.length < 120) continue;
    if (NOTE_PREFIX.test(t)) continue;

    if (NUMBERED_ITEM.test(t)) {
      // Flush previous item
      if (current) result.push(current);
      current = { lineNumber: line.lineNumber, text: t };
    } else if (current) {
      // Continuation line: has alpha content, no money values → append to description
      // Lines with money values that aren't numbered are noise (measurement lines, etc.)
      if (CONTINUATION_ALPHA.test(t) && !HAS_DECIMAL.test(t)) {
        current = { lineNumber: current.lineNumber, text: current.text + ' ' + t };
      }
      // Otherwise skip (measurement summary, dimension, page header, etc.)
    }
    // Lines before the first numbered item are noise (headers, metadata)
  }
  // Flush last item
  if (current) result.push(current);

  return result;
}

/**
 * Check if a set of lines contains numbered items (Xactimate standard format).
 * If fewer than 30% of money-bearing lines are numbered, return false (fallback mode).
 */
function hasNumberedFormat(lines: PrematchLineRecord[]): boolean {
  let numbered = 0;
  let withMoney = 0;
  for (const line of lines) {
    const t = line.text.trim();
    if (HAS_DECIMAL.test(t) && CONTINUATION_ALPHA.test(t) && t.length > 20) {
      withMoney++;
      if (NUMBERED_ITEM.test(t)) numbered++;
    }
  }
  if (withMoney === 0) return false;
  return (numbered / withMoney) > 0.30;
}

// ── Scope-line detection (fallback for non-numbered PDFs) ────────────────────

const PRICE_PAIR = /\d+\.\d{2}\s+\d+\.\d{2}/;

function isLikelyScopeLine(text: string): boolean {
  if (UNIT_PATTERN.test(text)) return true;
  if (CATEGORY_PATTERN.test(text)) return true;
  if (QTY_UNIT_PATTERN.test(text)) return true;
  if (PRICE_PAIR.test(text) && text.length > 15) return true;
  if (/[a-zA-Z]{3,}/.test(text) && /\d+\.\d{2}/.test(text) && text.length > 25) return true;
  return false;
}

// ── Dimension-line filter (room measurement annotations, not scope items) ────

const AREA_TERMS = new Set([
  'walls', 'wall', 'ceiling', 'ceilings', 'ceil', 'floor', 'floors',
  'perimeter', 'flooring', 'sq', 'sf', 'sy', 'lf',
]);

function isDimensionLine(parsed: ParsedScopeFields): boolean {
  // A dimension line's description tokens consist entirely of generic area terms
  // e.g. "137.99 SF Walls" → tokens: ["walls"] → dimension line
  // e.g. "217.55 SF Walls & Ceiling" → tokens: ["walls", "ceiling"] → dimension line
  // Real scope items have work-specific tokens: "Seal attic framing (shellac)"
  if (parsed.descriptionTokens.length === 0) return true;
  return parsed.descriptionTokens.every((t) => AREA_TERMS.has(t));
}

// ── Core matching logic (description-primary) ────────────────────────────────

function computePairConfidence(yours: ParsedScopeFields, adj: ParsedScopeFields): number {
  // Primary signal: description similarity
  const desc = descriptionScore(yours.descriptionTokens, adj.descriptionTokens);
  if (desc.score < MIN_DESCRIPTION_SCORE) return 0;

  // Hard gate: unit mismatch is a red flag (SF vs LF = different items)
  if (yours.unit !== null && adj.unit !== null && yours.unit !== adj.unit) return 0;

  // Start with description score as the base (weighted 70%)
  let confidence = desc.score * 0.70;

  // Boost: qty match (10%)
  if (yours.quantity !== null && adj.quantity !== null && yours.quantity === adj.quantity) {
    confidence += 0.10;
  } else if (yours.quantity !== null && adj.quantity !== null) {
    confidence += 0.03; // both have qty but differ — small boost for having structure
  } else {
    confidence += 0.05; // one or both missing qty — neutral
  }

  // Boost: unit match (10%)
  if (yours.unit !== null && adj.unit !== null && yours.unit === adj.unit) {
    confidence += 0.10;
  } else {
    confidence += 0.05;
  }

  // Boost: category match (5%) — informational only, never a blocker
  if (yours.category !== null && adj.category !== null && yours.category === adj.category) {
    confidence += 0.05;
  } else {
    confidence += 0.02;
  }

  // Boost: cost structure similarity (5%) — having costs on both sides is a signal
  const yCosts = yours.costs.total !== null;
  const aCosts = adj.costs.total !== null;
  if (yCosts && aCosts) {
    confidence += 0.05;
  } else {
    confidence += 0.02;
  }

  return confidence;
}

// ── Best reciprocal matching (greedy best-pair) ──────────────────────────────

type CandidatePair = {
  yourIndex: number;
  adjIndex: number;
  confidence: number;
};

function findBestReciprocalMatches(
  yourParsed: ParsedScopeFields[],
  adjParsed: ParsedScopeFields[]
): DeterministicMatch[] {
  const candidates: CandidatePair[] = [];
  for (let yi = 0; yi < yourParsed.length; yi++) {
    for (let ai = 0; ai < adjParsed.length; ai++) {
      const conf = computePairConfidence(yourParsed[yi]!, adjParsed[ai]!);
      if (conf >= MIN_OVERALL_CONFIDENCE) {
        candidates.push({ yourIndex: yi, adjIndex: ai, confidence: conf });
      }
    }
  }

  // Sort by confidence descending for greedy best-pair
  candidates.sort((a, b) => b.confidence - a.confidence);

  const usedYours = new Set<number>();
  const usedAdj = new Set<number>();
  const matches: DeterministicMatch[] = [];

  for (const c of candidates) {
    if (usedYours.has(c.yourIndex) || usedAdj.has(c.adjIndex)) continue;
    usedYours.add(c.yourIndex);
    usedAdj.add(c.adjIndex);

    const yours = yourParsed[c.yourIndex]!;
    const adj = adjParsed[c.adjIndex]!;
    const allCostsEqual = costsAllMatch(yours.costs, adj.costs);
    const qtyEqual = quantitiesEqual(yours.quantity, adj.quantity);
    const status: 'MATCH' | 'MODIFIED' = allCostsEqual && qtyEqual ? 'MATCH' : 'MODIFIED';

    matches.push({
      yourLine: yours,
      adjusterLine: adj,
      confidence: Math.round(c.confidence * 1000) / 1000,
      status,
      resolutionSource: 'deterministic',
    });
  }

  return matches;
}

// ── Vision-mode prematch (items already parsed by Haiku, zones reconciled) ───

/**
 * Run deterministic prematch on vision-extracted items that already have
 * canonical zone assignments from Haiku + zone reconciliation.
 *
 * Takes pre-parsed ParsedScopeFields with canonical zones already set on the
 * `zone` field. Groups by zone and runs reciprocal matching within each zone
 * (never across zones).
 */
export function runVisionPrematch(
  yourParsed: ParsedScopeFields[],
  adjParsed: ParsedScopeFields[]
): PrematchResult {
  // Group by canonical zone
  const yourByZone = new Map<string, ParsedScopeFields[]>();
  for (const p of yourParsed) {
    const zone = p.zone ?? '__UNZONED__';
    if (!yourByZone.has(zone)) yourByZone.set(zone, []);
    yourByZone.get(zone)!.push(p);
  }

  const adjByZone = new Map<string, ParsedScopeFields[]>();
  for (const p of adjParsed) {
    const zone = p.zone ?? '__UNZONED__';
    if (!adjByZone.has(zone)) adjByZone.set(zone, []);
    adjByZone.get(zone)!.push(p);
  }

  // Match within each zone
  const allMatches: DeterministicMatch[] = [];
  const allZones = new Set([...yourByZone.keys(), ...adjByZone.keys()]);

  for (const zone of allZones) {
    const yourInZone = yourByZone.get(zone) ?? [];
    const adjInZone = adjByZone.get(zone) ?? [];
    if (yourInZone.length === 0 || adjInZone.length === 0) continue;
    const zoneMatches = findBestReciprocalMatches(yourInZone, adjInZone);
    allMatches.push(...zoneMatches);
  }

  // Build unmatched lists as PrematchLineRecord
  const matchedYourLineNums = new Set(allMatches.map((m) => m.yourLine.lineNumber));
  const matchedAdjLineNums = new Set(allMatches.map((m) => m.adjusterLine.lineNumber));

  const unmatchedYourLines = yourParsed
    .filter((p) => !matchedYourLineNums.has(p.lineNumber))
    .map((p) => ({ lineNumber: p.lineNumber, text: p.rawText }));
  const unmatchedAdjusterLines = adjParsed
    .filter((p) => !matchedAdjLineNums.has(p.lineNumber))
    .map((p) => ({ lineNumber: p.lineNumber, text: p.rawText }));

  const avgConfidence =
    allMatches.length > 0
      ? allMatches.reduce((sum, m) => sum + m.confidence, 0) / allMatches.length
      : 0;

  const yourParsedMap = new Map<number, ParsedScopeFields>();
  for (const p of yourParsed) yourParsedMap.set(p.lineNumber, p);
  const adjusterParsedMap = new Map<number, ParsedScopeFields>();
  for (const p of adjParsed) adjusterParsedMap.set(p.lineNumber, p);

  return {
    matches: allMatches,
    unmatchedYourLines,
    unmatchedAdjusterLines,
    yourParsedMap,
    adjusterParsedMap,
    stats: {
      yourInputCount: yourParsed.length,
      adjusterInputCount: adjParsed.length,
      autoMatchedCount: allMatches.length,
      exactMatchCount: allMatches.filter((m) => m.status === 'MATCH').length,
      modifiedMatchCount: allMatches.filter((m) => m.status === 'MODIFIED').length,
      unmatchedYoursCount: unmatchedYourLines.length,
      unmatchedAdjusterCount: unmatchedAdjusterLines.length,
      avgConfidence: Math.round(avgConfidence * 1000) / 1000,
    },
  };
}

// ── Parse all lines with zone detection (for non-prematch code path) ─────────

export function parseAllLinesWithZones(
  lines: PrematchLineRecord[],
  allLines?: PrematchLineRecord[]
): Map<number, ParsedScopeFields> {
  // Use unfiltered lines for layout detection (pre-filter may drop column headers)
  const layout = detectColumnLayout(allLines ?? lines);
  const joined = joinSplitLines(lines);

  let parsed: ParsedScopeFields[];
  if (hasNumberedFormat(joined)) {
    const items = extractNumberedItems(joined);
    parsed = items.map((l) => parseLineToFields(l, '__UNZONED__', layout));
  } else {
    const zoned = assignZonesToLines(joined);
    parsed = zoned
      .filter((l) => isLikelyScopeLine(l.text))
      .map((l) => parseLineToFields(l, l.assignedZone, layout))
      .filter((p) => !isDimensionLine(p));
  }

  const map = new Map<number, ParsedScopeFields>();
  for (const p of parsed) map.set(p.lineNumber, p);
  return map;
}

// ── Convert deterministic matches to RawLineItem shape ───────────────────────

export function deterministicMatchesToRawLineItems(
  matches: DeterministicMatch[]
): Array<{
  matchStatus: string;
  zoneYours: string | null;
  zoneAdjuster: string | null;
  descriptionYours: string | null;
  descriptionAdjuster: string | null;
  qtyYours: string | null;
  qtyAdjuster: string | null;
  removeYours: number | null;
  removeAdjuster: number | null;
  replaceYours: number | null;
  replaceAdjuster: number | null;
  resetYours: number | null;
  resetAdjuster: number | null;
  taxYours: number | null;
  taxAdjuster: number | null;
  opYours: number | null;
  opAdjuster: number | null;
  totalYours: number | null;
  totalAdjuster: number | null;
  diffAmount: number | null;
  category: string | null;
  sortOrder: number;
  groupId: string | null;
}> {
  return matches.map((m, index) => {
    const yTotal = m.yourLine.costs.total;
    const aTotal = m.adjusterLine.costs.total;
    const diff = yTotal !== null && aTotal !== null ? yTotal - aTotal : null;

    return {
      matchStatus: m.status,
      zoneYours: m.yourLine.zone,
      zoneAdjuster: m.adjusterLine.zone,
      descriptionYours: m.yourLine.description || m.yourLine.rawText,
      descriptionAdjuster: m.adjusterLine.description || m.adjusterLine.rawText,
      qtyYours: m.yourLine.quantity,
      qtyAdjuster: m.adjusterLine.quantity,
      removeYours: m.yourLine.costs.remove,
      removeAdjuster: m.adjusterLine.costs.remove,
      replaceYours: m.yourLine.costs.replace,
      replaceAdjuster: m.adjusterLine.costs.replace,
      resetYours: m.yourLine.costs.reset,
      resetAdjuster: m.adjusterLine.costs.reset,
      taxYours: m.yourLine.costs.tax,
      taxAdjuster: m.adjusterLine.costs.tax,
      opYours: m.yourLine.costs.op,
      opAdjuster: m.adjusterLine.costs.op,
      totalYours: yTotal,
      totalAdjuster: aTotal,
      diffAmount: diff !== null ? Math.round(diff * 100) / 100 : null,
      category: m.yourLine.category ?? m.adjusterLine.category,
      sortOrder: index,
      groupId: null,
    };
  });
}
