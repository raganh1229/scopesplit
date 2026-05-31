// ─────────────────────────────────────────────────────────────────────────────
// N4 Pipeline — XLS extractor: workbook parsing
//
// Downloads a spreadsheet file from Supabase storage and parses it into typed
// row records using the SheetJS (xlsx) library.
//
// Design:
//   - Handles .xlsx, .xls, .csv via SheetJS auto-detection
//   - Scans first MAX_HEADER_SCAN_ROWS rows to locate the header row
//   - Returns typed rows keyed by header name
//   - loadAllSheets() supports multi-sheet zone fallback in detect-zones
// ─────────────────────────────────────────────────────────────────────────────

import * as XLSX from 'xlsx';
import { supabaseAdmin } from '@/lib/supabase';
import { countHeaderHits, HEADER_DETECTION_MIN_HITS } from './column-map';

const ESTIMATES_BUCKET = 'estimates';
const MAX_HEADER_SCAN_ROWS = 10;

export type WorkbookRow = Record<string, string | number | null>;

export type ParsedSheet = {
  sheetName: string;
  headers: string[];
  rows: WorkbookRow[];
};

/** Downloads file bytes from Supabase storage. */
export async function downloadFileBytes(storagePath: string): Promise<Buffer> {
  const { data, error } = await supabaseAdmin.storage
    .from(ESTIMATES_BUCKET)
    .download(storagePath);
  if (error || !data) {
    throw new Error(
      `[n4/xls/parse-workbook] Failed to download file at '${storagePath}': ${error?.message ?? 'Unknown error'}`,
    );
  }
  return Buffer.from(await data.arrayBuffer());
}

/** Parses bytes into an XLSX WorkBook object. */
function readWorkbook(bytes: Buffer): XLSX.WorkBook {
  return XLSX.read(bytes, { type: 'buffer', raw: false, cellDates: false });
}

/**
 * Scans the first MAX_HEADER_SCAN_ROWS rows of an AoA (array-of-arrays) to
 * find the header row — the row with the most known column alias hits.
 *
 * Returns the 0-based index of the header row, or -1 if not found.
 */
function findHeaderRowIndex(aoa: unknown[][]): number {
  let bestIdx = -1;
  let bestHits = HEADER_DETECTION_MIN_HITS - 1; // must beat this threshold

  const scanLimit = Math.min(MAX_HEADER_SCAN_ROWS, aoa.length);
  for (let i = 0; i < scanLimit; i++) {
    const row = (aoa[i] ?? []).map(c => (c == null ? '' : String(c)));
    const hits = countHeaderHits(row);
    if (hits > bestHits) {
      bestHits = hits;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Converts an AoA + header index into typed WorkbookRow records. */
function buildTypedRows(
  aoa: unknown[][],
  headerIdx: number,
): { headers: string[]; rows: WorkbookRow[] } {
  const rawHeader = aoa[headerIdx] ?? [];
  const headers: string[] = rawHeader.map(c => (c == null ? '' : String(c).trim()));

  const rows: WorkbookRow[] = [];
  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const rawRow = aoa[i] ?? [];
    const obj: WorkbookRow = {};
    let hasValue = false;

    for (let j = 0; j < headers.length; j++) {
      const key = headers[j];
      if (!key) continue; // skip blank header columns

      const raw = rawRow[j] ?? null;
      if (raw !== null && raw !== '') hasValue = true;

      if (raw === null || raw === undefined || raw === '') {
        obj[key] = null;
      } else if (typeof raw === 'number') {
        obj[key] = raw;
      } else {
        obj[key] = String(raw).trim();
      }
    }

    // Skip fully blank rows (common between Xactimate section separators)
    if (hasValue) rows.push(obj);
  }

  return { headers, rows };
}

/**
 * Downloads a spreadsheet from Supabase and parses the first (active) sheet.
 * Returns parsed headers, typed data rows, and the full sheet name list.
 *
 * Throws if no header row can be detected.
 */
export async function loadPrimarySheet(
  storagePath: string,
): Promise<ParsedSheet & { sheetNames: string[] }> {
  const bytes = await downloadFileBytes(storagePath);
  const wb = readWorkbook(bytes);
  const sheetNames = wb.SheetNames;

  const sheetName = sheetNames[0] ?? 'Sheet1';
  const ws = wb.Sheets[sheetName];
  if (!ws) {
    throw new Error(
      `[n4/xls/parse-workbook] Workbook contains no sheets at '${storagePath}'`,
    );
  }

  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
  const headerIdx = findHeaderRowIndex(aoa);

  if (headerIdx === -1) {
    throw new Error(
      `[n4/xls/parse-workbook] Could not locate a header row in the first ` +
      `${MAX_HEADER_SCAN_ROWS} rows of '${storagePath}'. ` +
      `Expected columns such as "Desc", "Group Code", "Qty", "RCV".`,
    );
  }

  const { headers, rows } = buildTypedRows(aoa, headerIdx);
  return { sheetName, headers, rows, sheetNames };
}

/**
 * Downloads a spreadsheet and parses ALL sheets.
 * Returns a Map of sheet name → ParsedSheet, in workbook sheet order.
 * Sheets with no recognisable header row are silently skipped.
 *
 * Used for the multi-sheet zone fallback in detect-zones.
 */
export async function loadAllSheets(storagePath: string): Promise<Map<string, ParsedSheet>> {
  const bytes = await downloadFileBytes(storagePath);
  const wb = readWorkbook(bytes);
  const result = new Map<string, ParsedSheet>();

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;

    const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
    const headerIdx = findHeaderRowIndex(aoa);
    if (headerIdx === -1) continue; // skip sheets without a recognisable header

    const { headers, rows } = buildTypedRows(aoa, headerIdx);
    if (rows.length > 0) {
      result.set(sheetName, { sheetName, headers, rows });
    }
  }

  return result;
}
