// ─────────────────────────────────────────────────────────────────────────────
// N4 Pipeline — XLS extractor: column map
//
// Defines canonical column aliases for Xactimate XLS exports and provides
// helper functions for locating columns in a parsed header row.
//
// Priority ordering matters: the first alias that matches wins.
// ─────────────────────────────────────────────────────────────────────────────

/** Ordered aliases for the zone grouping column. First match wins. */
export const ZONE_COLUMN_ALIASES: string[] = [
  'Group Code',
  'Group Description',
  'Room',
  'Location',
  'Area',
  'Zone',
];

/** Ordered aliases for the zone display-name column (separate from grouping key). */
export const ZONE_DISPLAY_COLUMN_ALIASES: string[] = [
  'Group Description',
  'Group Code',
  'Room',
  'Location',
  'Area',
  'Zone',
];

/** Aliases for each extracted field — ordered by specificity/priority. */
export const COLUMN_ALIASES: Record<string, string[]> = {
  description: ['Desc', 'Description', 'Item Description', 'Line Item Description'],
  quantity:    ['Qty', 'Quantity', 'Qty.'],
  unitCost:    ['Unit Cost', 'Unit Price', 'Price/Unit', 'Cost/Unit'],
  salesTax:    ['Sales Tax', 'Tax Amount', 'Tax$'],
  rcv:         ['RCV', 'Replacement Cost Value', 'Replacement Cost'],
  acv:         ['ACV', 'Actual Cash Value'],
  itemCode:    ['Cat', 'Category', 'Item Code', 'Code', 'Category Code'],
  itemAmount:  ['Item Amount', 'Item Total', 'Line Total', 'Amount'],
  groupCode:   ['Group Code'],
  groupDesc:   ['Group Description'],
  coverage:    ['Coverage'],
};

/**
 * Minimum number of recognised alias hits needed to declare a row as the
 * header row when scanning the workbook. Must be ≥2 to avoid false positives
 * on data rows that happen to match one alias.
 */
export const HEADER_DETECTION_MIN_HITS = 2;

/**
 * Returns the exact header string (cell text) that matches one of the given
 * aliases, or null if none match. Comparison is case-insensitive and trimmed.
 */
export function findColumn(headers: string[], aliases: string[]): string | null {
  const normalised = headers.map(h => h.trim().toLowerCase());
  for (const alias of aliases) {
    const idx = normalised.indexOf(alias.trim().toLowerCase());
    if (idx !== -1) return headers[idx] ?? null;
  }
  return null;
}

/**
 * Returns the first matching zone-grouping column name from the headers,
 * or null if none of the ZONE_COLUMN_ALIASES are present.
 */
export function findZoneColumn(headers: string[]): string | null {
  return findColumn(headers, ZONE_COLUMN_ALIASES);
}

/**
 * Returns the zone display-name column (preferred for human-readable zone
 * names in the UI). Falls back to the grouping key if not found.
 */
export function findZoneDisplayColumn(headers: string[]): string | null {
  return findColumn(headers, ZONE_DISPLAY_COLUMN_ALIASES);
}

/**
 * Counts how many known column aliases appear in the given row (as strings).
 * Used by the header-row detection scan.
 */
export function countHeaderHits(row: string[]): number {
  const normalised = row.map(c => (c ?? '').toString().trim().toLowerCase());
  const allAliases = [
    ...ZONE_COLUMN_ALIASES,
    ...Object.values(COLUMN_ALIASES).flat(),
  ].map(a => a.trim().toLowerCase());
  return normalised.filter(c => allAliases.includes(c)).length;
}

/**
 * Throws a descriptive error if the minimum required column ('Desc' or alias)
 * is not present in the headers. Call after header detection.
 */
export function validateRequiredColumns(headers: string[]): void {
  const desc = findColumn(headers, COLUMN_ALIASES.description ?? []);
  if (!desc) {
    throw new Error(
      `[n4/xls] Missing required column: no "Desc" / "Description" column found. ` +
      `Detected headers: ${headers.slice(0, 20).join(', ')}`,
    );
  }
}
