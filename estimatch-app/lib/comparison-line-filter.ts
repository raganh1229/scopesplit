export type FilterableLineRecord = {
  lineNumber: number;
  text: string;
};

export type FilterStats = {
  inputCount: number;
  outputCount: number;
  droppedPageChrome: number;
  droppedMetadata: number;
  droppedBoilerplate: number;
  droppedSummaryLines: number;
  droppedDuplicates: number;
  estimatedTokensSaved: number;
};

export type FilterResult = {
  lines: FilterableLineRecord[];
  stats: FilterStats;
};

export function isPreFilterEnabled(): boolean {
  return process.env.COMPARISON_PROCESSING_PRE_FILTER !== 'false';
}

// ---------------------------------------------------------------------------
// Scope-line detection — these lines are NEVER dropped
// ---------------------------------------------------------------------------

const XACTIMATE_UNITS =
  /\b(SQ|LF|SF|EA|CY|HR|MO|WK|DY|LS|CF|BF|FF|RF|TN|GL|RL|BG|CS|PR|PC|CT|MBF|MLF)\b/;

const XACTIMATE_CATEGORIES =
  /\b(RFG|PLM|DRY|ELC|FLR|PNT|INS|CLN|FNC|GNL|WDW|SID|CNT|DOR|CAB|APL|DML|GRD|HTG|MAS|STR|WDP|CLG|EXT|INT)\b/;

const QTY_WITH_UNIT =
  /\d+\.?\d*\s*(SQ|LF|SF|EA|CY|HR|MO|WK|DY|LS|CF|BF|FF|TN|GL|RL)\b/i;

const PRICE_PAIR = /\d+\.\d{2}\s+\d+\.\d{2}/;

function isLikelyScopeLineItem(text: string): boolean {
  if (XACTIMATE_UNITS.test(text)) return true;
  if (XACTIMATE_CATEGORIES.test(text)) return true;
  if (QTY_WITH_UNIT.test(text)) return true;
  if (PRICE_PAIR.test(text) && text.length > 15) return true;
  if (/[a-zA-Z]{3,}/.test(text) && /\d+\.\d{2}/.test(text) && text.length > 25) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Removal patterns
// ---------------------------------------------------------------------------

function isPageChrome(text: string): boolean {
  const t = text.trim();
  if (/^page\s+\d+\s+(of|\/)\s+\d+$/i.test(t)) return true;
  if (/^-?\s*\d{1,4}\s*-?$/.test(t)) return true;
  if (
    /^\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}\s+\d{1,2}:\d{2}/i.test(t) &&
    t.length < 30
  )
    return true;
  return false;
}

function isDocumentMetadata(text: string): boolean {
  const t = text.trim();
  const lower = t.toLowerCase();
  if (/^\(?\d{3}\)?[\s\-.]\d{3}[\s\-.]\d{4}$/.test(t)) return true;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return true;
  if (/^https?:\/\/\S+$/i.test(t)) return true;
  if (/^www\.\S+$/i.test(t)) return true;
  if (
    /^(claim|policy|file|insured|adjuster|date of loss|type of loss|date received)\s*(#|number|no\.?)?[:\s]/i.test(
      lower
    ) &&
    t.length < 80
  )
    return true;
  if (/xactimate|xactanalysis|xact\s*ware/i.test(lower) && t.length < 60)
    return true;
  return false;
}

function isBoilerplate(text: string): boolean {
  const t = text.trim();
  if (/^[\-=*_~]{3,}$/.test(t)) return true;
  if (/^[(\[]?\s*(continued|cont['']?d)\s*[)\]]?\.?$/i.test(t)) return true;
  return false;
}

function isSummaryLine(text: string): boolean {
  const lower = text.trim().toLowerCase();
  if (
    /^(sub\s*total|page\s*total|grand\s*total|net\s*claim|total[:\s])/i.test(
      lower
    )
  )
    return true;
  if (
    /^(line\s*item\s*total|replacement\s*cost\s*value|actual\s*cash\s*value)\s*[:\s$\d]/i.test(
      lower
    )
  )
    return true;
  if (/^(sales\s*tax|tax\s*total|total\s*tax)\b/i.test(lower)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Repeated-header / near-duplicate detection
// ---------------------------------------------------------------------------

function findRepeatedLines(
  lines: FilterableLineRecord[],
  threshold: number = 3
): Set<string> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const key = line.text.trim().toLowerCase();
    if (key.length < 5) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const repeated = new Set<string>();
  for (const [key, count] of counts) {
    if (count >= threshold) {
      repeated.add(key);
    }
  }
  return repeated;
}

function isDuplicateInWindow(
  text: string,
  recentLines: string[],
  windowSize: number = 5
): boolean {
  const normalized = text.trim().toLowerCase();
  if (normalized.length < 10) return false;
  const start = Math.max(0, recentLines.length - windowSize);
  for (let i = start; i < recentLines.length; i += 1) {
    if (recentLines[i] === normalized) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Normalization (applied to surviving lines)
// ---------------------------------------------------------------------------

function normalizeLine(text: string): string {
  let result = text;
  result = result.replace(/[\t ]+/g, ' ');
  result = result.replace(/\$\s?(?=\d)/g, '');
  result = result.replace(/(\d),(\d{3})/g, '$1$2');
  result = result.replace(/(\d),(\d{3})/g, '$1$2');
  result = result.trim();
  return result;
}

// ---------------------------------------------------------------------------
// Main filter entry point
// ---------------------------------------------------------------------------

export function filterExtractedLines(
  lines: FilterableLineRecord[]
): FilterResult {
  const stats: FilterStats = {
    inputCount: lines.length,
    outputCount: 0,
    droppedPageChrome: 0,
    droppedMetadata: 0,
    droppedBoilerplate: 0,
    droppedSummaryLines: 0,
    droppedDuplicates: 0,
    estimatedTokensSaved: 0,
  };

  if (!isPreFilterEnabled()) {
    return { lines, stats: { ...stats, outputCount: lines.length } };
  }

  const repeatedLines = findRepeatedLines(lines);
  const recentNormalized: string[] = [];
  const result: FilterableLineRecord[] = [];
  let inputTokenEstimate = 0;
  let outputTokenEstimate = 0;

  for (const line of lines) {
    const lineTokens = Math.ceil(line.text.length / 4);
    inputTokenEstimate += lineTokens;

    if (isSummaryLine(line.text)) {
      stats.droppedSummaryLines += 1;
      continue;
    }

    if (isLikelyScopeLineItem(line.text)) {
      const normalized = normalizeLine(line.text);
      const normalizedTokens = Math.ceil(normalized.length / 4);
      outputTokenEstimate += normalizedTokens;
      result.push({ lineNumber: line.lineNumber, text: normalized });
      recentNormalized.push(normalized.toLowerCase());
      continue;
    }

    if (isPageChrome(line.text)) {
      stats.droppedPageChrome += 1;
      continue;
    }

    if (isDocumentMetadata(line.text)) {
      stats.droppedMetadata += 1;
      continue;
    }

    if (isBoilerplate(line.text)) {
      stats.droppedBoilerplate += 1;
      continue;
    }

    const lowerTrimmed = line.text.trim().toLowerCase();
    if (repeatedLines.has(lowerTrimmed)) {
      stats.droppedPageChrome += 1;
      continue;
    }

    if (isDuplicateInWindow(line.text, recentNormalized)) {
      stats.droppedDuplicates += 1;
      continue;
    }

    const normalized = normalizeLine(line.text);
    const normalizedTokens = Math.ceil(normalized.length / 4);
    outputTokenEstimate += normalizedTokens;
    result.push({ lineNumber: line.lineNumber, text: normalized });
    recentNormalized.push(normalized.toLowerCase());
  }

  stats.outputCount = result.length;
  stats.estimatedTokensSaved = inputTokenEstimate - outputTokenEstimate;

  return { lines: result, stats };
}
