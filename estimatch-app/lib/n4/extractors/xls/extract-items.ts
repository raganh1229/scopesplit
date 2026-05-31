// ─────────────────────────────────────────────────────────────────────────────
// N4 Pipeline — XLS extractor: extract-items (P8)
//
// Deterministic line item extraction from XLS/CSV estimates. Zero AI calls.
//
// Column mapping — Xactimate XLS export → n3_line_items:
//   Desc        → rawDescription (+ normalizedDescription + descriptionTokens)
//   Qty         → rawQuantity
//   Unit Cost   → unitPrice
//   Sales Tax   → taxAmount
//   RCV         → totalAmount  (RCV = Item Amount + Sales Tax; consistent with
//                               the PDF extractor which captures the post-tax total)
//   Cat         → itemCode
//
// Fields left null (not available in this export):
//   rawUnit, removeAmount, replaceAmount, resetAmount, opAmount
//
// n3_zones.startPage / endPage are read back as startRow / endRow:
//   0-based indices into the flat rows array built from the workbook.
//   For single-sheet / Group Code comparisons: rows = primary sheet rows.
//   For multi-sheet comparisons: rows = sheets concatenated in workbook order.
// ─────────────────────────────────────────────────────────────────────────────

import prisma from '@/lib/prisma';
import { normalizeDescription, tokenizeDescription } from '@/lib/n3/normalization';
import type { N3EstimateSource } from '@/lib/n3/types';
import type { ExtractLineItemsResult, StepLogger } from '@/lib/n4/extractors/types';
import { loadPrimarySheet, loadAllSheets, type WorkbookRow } from './parse-workbook';
import { findColumn, COLUMN_ALIASES } from './column-map';
import type { XlsColumnMap } from './detect-columns';

/** Safely parses a cell value to a float, or null on failure. */
function toFloat(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/,/g, ''));
  return isFinite(n) ? n : null;
}

/** Returns string representation of a cell, or null if blank. */
function toStr(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = String(raw).trim();
  return s.length > 0 ? s : null;
}

export async function xlsExtractLineItems(
  comparisonId: string,
  side: 'yours' | 'adjuster',
  logger: StepLogger,
  reextractSource?: 'yours' | 'adjuster' | 'both',
): Promise<ExtractLineItemsResult> {
  // ── 1. Load comparison + zones for this side ─────────────────────────────────
  const comparison = await prisma.comparison.findUnique({
    where: { id: comparisonId },
    select: {
      yourEstimateStoragePath:     true,
      adjusterEstimateStoragePath: true,
      xlsColumnMapYours:           true,
      xlsColumnMapAdj:             true,
    },
  });
  if (!comparison) {
    throw new Error(`[n4/xls/extract-items] Comparison ${comparisonId} not found`);
  }

  // AI-detected column map stored during P4 (detect-zones). Used as primary
  // resolver; COLUMN_ALIASES is the fallback for any null entries.
  const storedMap = (side === 'yours'
    ? comparison.xlsColumnMapYours
    : comparison.xlsColumnMapAdj) as XlsColumnMap | null;

  const sourceFilter = reextractSource && reextractSource !== 'both'
    ? { source: reextractSource }
    : { source: side };

  const zones = await prisma.n3Zone.findMany({
    where: { comparisonId, ...sourceFilter },
    select: { id: true, source: true, name: true, startPage: true, endPage: true },
    orderBy: [{ source: 'asc' }, { startPage: 'asc' }],
  });

  if (zones.length === 0) {
    logger.warn('[n4/xls/extract-items] No zones found — P4 may not have run', {
      comparisonId, side,
    });
    return { itemCount: 0 };
  }

  // ── 2. Download + parse workbook ─────────────────────────────────────────────
  const storagePath = side === 'yours'
    ? comparison.yourEstimateStoragePath
    : comparison.adjusterEstimateStoragePath;

  logger.info('[n4/xls/extract-items] Loading workbook', { comparisonId, side });

  const primarySheet = await loadPrimarySheet(storagePath);

  // If any zone's endPage (= endRow) exceeds the primary sheet row count we are
  // in the multi-sheet path — build a flat combined array in workbook order.
  const maxEndRow = Math.max(...zones.map(z => z.endPage));
  let allRows: WorkbookRow[];

  if (maxEndRow >= primarySheet.rows.length) {
    const allSheets = await loadAllSheets(storagePath);
    const combined: WorkbookRow[] = [];
    for (const sheet of allSheets.values()) combined.push(...sheet.rows);
    allRows = combined;
  } else {
    allRows = primarySheet.rows;
  }

  logger.info('[n4/xls/extract-items] Workbook loaded', {
    comparisonId, side, totalRows: allRows.length, zones: zones.length,
  });

  // ── 3. Resolve column names once from the primary sheet headers ───────────────
  const hdrs = primarySheet.headers;

  // Primary: AI-detected header string from storedMap (set in P4 detect-zones).
  // Fallback: static alias matching via COLUMN_ALIASES.
  function resolveCol(
    aiKey: keyof XlsColumnMap,
    aliases: string[],
    defaultVal?: string,
  ): string | null {
    const aiHit = storedMap?.[aiKey] ?? null;
    if (aiHit) return aiHit;
    return findColumn(hdrs, aliases) ?? defaultVal ?? null;
  }

  const colDesc      = resolveCol('description', COLUMN_ALIASES.description ?? []);
  if (!colDesc) {
    throw new Error(
      `[n4/xls/extract-items] Could not resolve description column. ` +
      `AI map: ${JSON.stringify(storedMap)}, ` +
      `Headers: ${hdrs.slice(0, 20).join(', ')}`,
    );
  }
  const colQty       = resolveCol('quantity',    COLUMN_ALIASES.quantity    ?? []);
  const colUnitCost  = resolveCol('unitCost',    COLUMN_ALIASES.unitCost    ?? []);
  const colTax       = resolveCol('salesTax',    COLUMN_ALIASES.salesTax    ?? []);
  const colRcv       = resolveCol('total',       COLUMN_ALIASES.rcv         ?? []);
  const colCode      = resolveCol('itemCode',    COLUMN_ALIASES.itemCode    ?? []);
  const colGroupCode = resolveCol('zone',        COLUMN_ALIASES.groupCode   ?? []);

  logger.info('[n4/xls/extract-items] Resolved columns', {
    comparisonId, side,
    colDesc, colQty, colUnitCost, colTax, colRcv, colCode, colGroupCode,
  });

  // Pre-build a Group Code → rows map if the column exists, so non-contiguous
  // zones are extracted correctly (range slicing breaks when a zone's rows are
  // interleaved with rows from other zones).
  const rowsByGroupCode = colGroupCode
    ? allRows.reduce<Map<string, typeof allRows>>((acc, row) => {
        const gc = toStr(row[colGroupCode]);
        if (gc) {
          const bucket = acc.get(gc) ?? [];
          bucket.push(row);
          acc.set(gc, bucket);
        }
        return acc;
      }, new Map())
    : null;

  // ── 4. Build n3_line_items rows ─────────────────────────────────────────────
  type LineItemRow = {
    comparisonId: string;
    zoneId: string;
    source: string;
    sourceLineNumber: number;
    pageNumber: number;
    rawDescription: string;
    normalizedDescription: string;
    descriptionTokens: string[];
    itemCode: string | null;
    rawQuantity: string | null;
    rawUnit: string | null;
    removeAmount: number | null;
    replaceAmount: number | null;
    resetAmount: number | null;
    taxAmount: number | null;
    opAmount: number | null;
    totalAmount: number | null;
    unitPrice: number | null;
    specialFlags: string[];
    extractionConfidence: number;
  };

  const lineItemRows: LineItemRow[] = [];

  for (const zone of zones) {
    // When a Group Code column exists, use the anchor row at startPage to look
    // up the zone's Group Code, then pull all rows for that code from the
    // pre-built map. This handles non-contiguous zones correctly.
    // Falls back to range slicing when no Group Code column is present.
    let zoneRows: typeof allRows;
    if (rowsByGroupCode && colGroupCode) {
      const anchorRow = allRows[zone.startPage];
      const zoneCode  = anchorRow ? toStr(anchorRow[colGroupCode]) : null;
      zoneRows = zoneCode ? (rowsByGroupCode.get(zoneCode) ?? []) : allRows.slice(zone.startPage, zone.endPage + 1);
    } else {
      zoneRows = allRows.slice(zone.startPage, zone.endPage + 1);
    }

    let sourceLineNumber = 1;
    for (const row of zoneRows) {
      const rawDesc = toStr(row[colDesc]);
      if (!rawDesc) continue; // skip blank separator rows

      const normalized = normalizeDescription(rawDesc);
      const tokens     = tokenizeDescription(normalized);

      lineItemRows.push({
        comparisonId,
        zoneId: zone.id,
        source: zone.source as N3EstimateSource,
        sourceLineNumber,
        pageNumber: 1, // fixed — no pages in a spreadsheet
        rawDescription: rawDesc,
        normalizedDescription: normalized,
        descriptionTokens: tokens,
        itemCode:     colCode ? toStr(row[colCode])      : null,
        rawQuantity:  colQty  ? toStr(row[colQty])       : null,
        rawUnit:      null,
        removeAmount: null,
        replaceAmount: null,
        resetAmount:  null,
        taxAmount:    colTax     ? toFloat(row[colTax])     : null,
        opAmount:     null,
        totalAmount:  (() => {
          // RCV cells in some XLS exports are Excel formula stubs (=Qty*UnitCost+Tax).
          // SheetJS does not evaluate formulas — it reads the stale cached value (0)
          // and sheet_to_json returns null. Fall back to qty × unitCost so that
          // totalSimilarity scoring has meaningful values.
          const rcv = colRcv ? toFloat(row[colRcv]) : null;
          if (rcv !== null) return rcv;
          const qty = colQty ? toFloat(row[colQty]) : null;
          const uc  = colUnitCost ? toFloat(row[colUnitCost]) : null;
          return qty !== null && uc !== null ? Math.round(qty * uc * 100) / 100 : null;
        })(),
        unitPrice:    colUnitCost ? toFloat(row[colUnitCost]) : null,
        specialFlags: [],
        extractionConfidence: 1,
      });

      sourceLineNumber++;
    }
  }

  logger.info('[n4/xls/extract-items] Extraction complete', {
    comparisonId, side, itemCount: lineItemRows.length,
  });

  // ── 5. Per-side idempotent DB write ─────────────────────────────────────────
  const deleteFilter = reextractSource && reextractSource !== 'both'
    ? { comparisonId, source: reextractSource }
    : { comparisonId, source: side };

  await prisma.$transaction([
    prisma.n3LineItem.deleteMany({ where: deleteFilter }),
    prisma.n3LineItem.createMany({ data: lineItemRows }),
  ]);

  logger.info('[n4/xls/extract-items] n3_line_items written', {
    comparisonId, side, rows: lineItemRows.length,
  });

  return { itemCount: lineItemRows.length };
}
