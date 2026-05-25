// ─────────────────────────────────────────────────────────────────────────────
// N2 Pipeline — splitMispaired post-processor
//
// Scans every MODIFIED pair produced by Pass 4. If the two descriptions share
// zero meaningful tokens (after stopword removal), the pair is a mispair: the
// model matched two completely different items because they happened to be the
// last unmatched items in the zone. Split the pair into:
//   - MISSING_FROM_ADJUSTER (e1 item, no adjuster counterpart)
//   - ADDED_BY_ADJUSTER     (e2 item, no contractor counterpart)
//
// All other statuses (MATCH, MISSING_FROM_ADJUSTER, ADDED_BY_ADJUSTER) and
// MODIFIED pairs with any token overlap pass through unchanged.
//
// Called in extract-and-match.ts after all zone results are collected, before
// writing n2:zones_extracted to state.
//
// Architecture refs: N2_SPEED_CAPACITY_ACCURACY.md Issue 32
// ─────────────────────────────────────────────────────────────────────────────

import type { N2ItemPair } from '@/lib/n2/schemas/types';

// ── Stopword set ──────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'by', 'from',
  'it', 'its', 'this', 'that', 'as', 'if', 'so', 'no', 'not',
]);

// ── Token extraction ──────────────────────────────────────────────────────────

function tokenize(description: string): Set<string> {
  return new Set(
    description
      .toLowerCase()
      .replace(/[()&,/\-#@%]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 2 && !STOP_WORDS.has(t)),
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Post-process a zone's item pairs to catch model mispairs.
 *
 * A MODIFIED pair with zero token overlap between descriptions is a mispair.
 * Splits it into MISSING_FROM_ADJUSTER + ADDED_BY_ADJUSTER.
 *
 * @param pairs  Raw pairs from Pass 4A or LZF for one zone
 * @returns      Pairs with mispairs resolved
 */
export function splitMispaired(pairs: N2ItemPair[]): N2ItemPair[] {
  const result: N2ItemPair[] = [];

  for (const pair of pairs) {
    if (pair.status !== 'MODIFIED' || !pair.e1 || !pair.e2) {
      result.push(pair);
      continue;
    }

    const e1Tokens = tokenize(pair.e1.d);
    const e2Tokens = tokenize(pair.e2.d);
    const hasOverlap = [...e1Tokens].some(t => e2Tokens.has(t));

    if (!hasOverlap) {
      result.push({ status: 'MISSING_FROM_ADJUSTER', e1: pair.e1, e2: null });
      result.push({ status: 'ADDED_BY_ADJUSTER', e1: null, e2: pair.e2 });
    } else {
      result.push(pair);
    }
  }

  return result;
}
