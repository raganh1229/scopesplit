// ─────────────────────────────────────────────────────────────────────────────
// N4 Pipeline — XLS extractor: detect-zones (P4)
//
// Zone detection for XLS/CSV estimates. Makes one AI call to normalise
// column names for the current file, then runs deterministic zone grouping.
//
// Zone detection strategy (in priority order):
//   1. Group Code or alias column present  → group rows by unique column value
//   2. No zone column + multiple sheets    → one zone per sheet (sheet name = zone)
//   3. No zone column + single sheet       → flat General zone (flat = true)
//
// The n3_zones.startPage / endPage fields are repurposed as startRow / endRow:
//   - 0-based indices into the ParsedSheet.rows array
//   - extract-items reads these back to slice the correct rows per zone
//   - No downstream phase re-reads these fields after P8, so repurposing is safe
// ─────────────────────────────────────────────────────────────────────────────

import prisma from '@/lib/prisma';
import { normalizeDescription } from '@/lib/n3/normalization';
import type { N3EstimateSource } from '@/lib/n3/types';
import type { DetectZonesResult, StepLogger } from '@/lib/n4/extractors/types';
import { loadPrimarySheet, loadAllSheets } from './parse-workbook';
import {
  findZoneColumn,
  findZoneDisplayColumn,
} from './column-map';
import { detectXlsColumns } from './detect-columns';

const GENERAL_ZONE_NAME = 'General';

export async function xlsDetectZones(
  comparisonId: string,
  side: 'yours' | 'adjuster',
  logger: StepLogger,
): Promise<DetectZonesResult> {
  // ── 1. Load comparison storage path ─────────────────────────────────────────
  const comparison = await prisma.comparison.findUnique({
    where: { id: comparisonId },
    select: {
      yourEstimateStoragePath: true,
      adjusterEstimateStoragePath: true,
    },
  });
  if (!comparison) {
    throw new Error(`[n4/xls/detect-zones] Comparison ${comparisonId} not found`);
  }

  const storagePath = side === 'yours'
    ? comparison.yourEstimateStoragePath
    : comparison.adjusterEstimateStoragePath;

  logger.info('[n4/xls/detect-zones] Loading workbook', { comparisonId, side });

  // ── 2. Parse the primary sheet ───────────────────────────────────────────────
  const { headers, rows, sheetNames } = await loadPrimarySheet(storagePath);

  logger.info('[n4/xls/detect-zones] Workbook parsed', {
    comparisonId, side,
    totalRows: rows.length,
    sheets: sheetNames.length,
    headerSample: headers.slice(0, 6).join(', '),
  });

  // ── 2a. AI column detection — runs once per side, stored for P8 reuse ────────
  const columnMap = await detectXlsColumns(headers, rows);

  const colMapField = side === 'yours' ? 'xlsColumnMapYours' : 'xlsColumnMapAdj';
  await prisma.comparison.update({
    where: { id: comparisonId },
    data:  { [colMapField]: columnMap },
  });

  logger.info('[n4/xls/detect-zones] Column map stored', {
    comparisonId, side, columnMap,
  });

  // ── 3. Determine zone strategy ───────────────────────────────────────────────
  // AI-detected zone column takes priority; fall back to alias matching.
  const zoneCol    = columnMap.zone ?? findZoneColumn(headers);
  const displayCol = findZoneDisplayColumn(headers);

  type ZoneEntry = {
    name: string;
    normalizedName: string;
    startRow: number;
    endRow: number;
    approxItems: number;
  };

  let zoneEntries: ZoneEntry[] = [];
  let flat = false;

  if (zoneCol) {
    // ── Strategy 1: zone column present — group rows by unique cell value ────
    logger.info('[n4/xls/detect-zones] Zone column found — grouping by cell value', {
      comparisonId, side, zoneCol, displayCol,
    });

    const zoneOrder: string[] = [];
    const zoneRanges = new Map<string, { start: number; end: number; displayName: string; count: number }>();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const rawKey = row[zoneCol];
      if (rawKey === null || rawKey === undefined || rawKey === '') continue;

      const key = String(rawKey).trim();
      if (!key) continue;

      // Use display column (Group Description) if distinct from group key column
      const rawDisplay = displayCol && displayCol !== zoneCol ? row[displayCol] : null;
      const displayName = rawDisplay ? String(rawDisplay).trim() : key;

      if (!zoneRanges.has(key)) {
        zoneOrder.push(key);
        zoneRanges.set(key, { start: i, end: i, displayName, count: 1 });
      } else {
        const entry = zoneRanges.get(key)!;
        entry.end   = i;
        entry.count++;
      }
    }

    zoneEntries = zoneOrder.map(key => {
      const range = zoneRanges.get(key)!;
      return {
        name: range.displayName,
        normalizedName: normalizeDescription(range.displayName),
        startRow: range.start,
        endRow: range.end,
        approxItems: range.count,
      };
    });

  } else if (sheetNames.length > 1) {
    // ── Strategy 2: multiple sheets, no zone column — sheet name = zone ──────
    logger.info('[n4/xls/detect-zones] No zone column — using multi-sheet strategy', {
      comparisonId, side, sheets: sheetNames.length,
    });

    const allSheets = await loadAllSheets(storagePath);
    let globalRowOffset = 0;

    for (const [sheetName, sheet] of allSheets) {
      if (sheet.rows.length === 0) continue;
      zoneEntries.push({
        name: sheetName,
        normalizedName: normalizeDescription(sheetName),
        startRow: globalRowOffset,
        endRow: globalRowOffset + sheet.rows.length - 1,
        approxItems: sheet.rows.length,
      });
      globalRowOffset += sheet.rows.length;
    }

  } else {
    // ── Strategy 3: flat fallback — synthesize single General zone ───────────
    flat = true;
    logger.info('[n4/xls/detect-zones] No zone column — flat General zone fallback', {
      comparisonId, side, totalRows: rows.length,
    });
    zoneEntries = [{
      name: GENERAL_ZONE_NAME,
      normalizedName: normalizeDescription(GENERAL_ZONE_NAME),
      startRow: 0,
      endRow: Math.max(0, rows.length - 1),
      approxItems: rows.length,
    }];
  }

  logger.info('[n4/xls/detect-zones] Zone detection complete', {
    comparisonId, side, zones: zoneEntries.length, flat,
    zoneNames: zoneEntries.map(z => z.name),
  });

  // ── 4. Per-side idempotent DB write ─────────────────────────────────────────
  const zoneRows = zoneEntries.map(z => ({
    comparisonId,
    source: side as N3EstimateSource,
    name: z.name,
    normalizedName: z.normalizedName,
    startPage: z.startRow,   // repurposed: 0-based row index
    endPage: z.endRow,       // repurposed: 0-based row index (inclusive)
    approxItems: z.approxItems,
    verificationStatus: 'ai_proposed' as const,
  }));

  await prisma.$transaction([
    prisma.n3Zone.deleteMany({ where: { comparisonId, source: side } }),
    prisma.n3Zone.createMany({ data: zoneRows }),
  ]);

  logger.info('[n4/xls/detect-zones] n3_zones written', {
    comparisonId, side, rows: zoneRows.length,
  });

  return { zoneCount: zoneEntries.length, flat, detectedFormat: 'xls' };
}
