# N4 — Multi-Format Estimate Pipeline

**Status:** ✅ COMPLETE — Jun 3, 2026 (active production pipeline)
**Predecessor:** N3 (Xactimate-only, 98.5% match accuracy)
**Successor:** N5 (Feedback-Aware Line Item Re-extraction — see `N5.md`; planned, not yet implemented)

---

## 1. Mission

Extend the matching pipeline to support estimates in **any format the user selects at upload time** — Xactimate, Symbility, and (future) CSV — including **mixed-format comparisons** (e.g. contractor in Xactimate, adjuster in Symbility).

**Non-goals:**
- No changes to N3. N3 stays as the production fallback.
- No accuracy regression on Xactimate-vs-Xactimate (98.5% baseline is non-negotiable).

---

## 2. Core Architectural Insight

The N3 pipeline naturally splits at a clean boundary:

| Phase | Format-aware? | Reason |
|---|---|---|
| 4. Detect zones | **YES** | Reads visual PDF structure (Xactimate room headers vs Symbility ROOFPLAN headers vs CSV column data) |
| 8. Extract line items | **YES** | Reads format-specific columns (Xactimate has 7 cost columns, Symbility has 1, CSV has whatever the user supplies) |
| 9. Normalize | **NO** | Pure functions on raw fields |
| 10. Embeddings | **NO** | Operates on `normalizedDescription` |
| 11. Zone correspondences | **NO** | Operates on normalized zone names |
| 12. Generate candidates | **NO** | Operates on normalized item shape |
| 13. Score | **NO** | All scoring features (`descriptionFuzzy`, `descriptionSemantic`, `tradeAction`, `quantityUnit`, `total`, `unitPrice`, `zoneCorrespondence`, `sequence`, `specialFlag`) are computed from normalized fields that exist in every format |
| 14. Components / Groups | **NO** | Pure graph operations |
| 15. LLM adjudication | **NO** | Reads normalized fields |
| 16. Assign matches | **NO** | Hungarian assignment on edge scores |
| 17. Persist decisions | **NO** | Writes `LineItem` rows from normalized data |

**Conclusion:** Only Phases 4 and 8 need format-specific code. Everything else is shared.

---

## 3. Plug-and-Play Architecture: The Extractor Contract

Every format implements the same interface, lives in its own folder, and registers itself once. Adding a new format = writing one new extractor + adding one line to the registry.

### The Contract

```ts
// lib/n4/extractors/types.ts
export interface Extractor {
  format: 'xactimate' | 'symbility' | 'csv';

  /**
   * Extract zones + line items for ONE side of a comparison.
   *
   * Reads:   Comparison.{your|adjuster}EstimateStoragePath
   * Writes:  n3_zones rows + n3_line_items rows where source = side
   * Idempotent: deletes own side's rows first, so retries are safe.
   */
  run(
    comparisonId: string,
    side: 'yours' | 'adjuster',
    logger: StepLogger,
  ): Promise<{ zoneCount: number; itemCount: number }>;
}
```

### The Registry

```ts
// lib/n4/extractors/registry.ts
export const EXTRACTORS: Record<EstimateFormat, Extractor> = {
  xactimate: xactimateExtractor,
  symbility: symbilityExtractor,
  // csv: csvExtractor,  ← N5 plugs in here
};
```

### The Orchestrator

```ts
// lib/n4/pipeline/orchestrator.ts (pseudocode)
async function runN4Pipeline(comparisonId: string) {
  const cmp = await loadComparison(comparisonId);

  // Per-side dispatch — runs in parallel
  await Promise.all([
    EXTRACTORS[cmp.yourEstimateFormat].run(comparisonId, 'yours', logger),
    EXTRACTORS[cmp.adjusterEstimateFormat].run(comparisonId, 'adjuster', logger),
  ]);

  // From here on: identical to N3, imported directly
  await normalizeLineItemsN3(comparisonId, logger);
  await generateEmbeddingsN3(comparisonId, logger);
  await proposeCorrespondencesN3(comparisonId, logger);
  await generateCandidatesN3(comparisonId, logger);
  await scoreCandidatesN3(comparisonId, logger);
  await buildComponentsN3(comparisonId, logger);
  await groupMatchingN3(comparisonId, logger);
  await llmAdjudicationN3(comparisonId, logger);
  await assignMatchesN3(comparisonId, logger);
  await persistDecisionsN3(comparisonId, logger);
}
```

**Key property:** the orchestrator does not know how each format extracts. It only knows the contract. New formats slot in without touching this file.

---

## 4. Folder Structure

```
lib/n4/
├── README.md                       Documents the contract; lives next to the code
│
├── extractors/
│   ├── types.ts                    Extractor interface
│   ├── registry.ts                 format → extractor map
│   │
│   ├── xactimate/
│   │   ├── index.ts                Exports the Xactimate Extractor
│   │   ├── detect-zones.ts         Per-side; imports N2 prompts + zone-merge utils
│   │   └── extract-line-items.ts   Per-side; imports N3 extraction prompt
│   │
│   ├── symbility/
│   │   ├── index.ts
│   │   ├── detect-zones.ts         Per-side; uses Symbility-aware prompt
│   │   ├── extract-line-items.ts   Per-side; uses Symbility-aware prompt
│   │   └── prompts/
│   │       ├── zone-detection.ts   ROOFPLAN-aware
│   │       └── extraction.ts       4-column schema
│   │
│   └── csv/                        ← N5 lives here, same shape as the others
│       └── (placeholder)
│
└── pipeline/
    ├── orchestrator.ts             Per-side dispatch + shared post-extraction
    └── inngest.ts                  process-comparison-n4 Inngest function
```

**Shared code stays in `lib/n3/`** — `normalize-line-items.ts`, `generate-embeddings.ts`, `propose-correspondences.ts`, `generate-candidates.ts`, `score-candidates.ts`, `build-components.ts`, `group-matching.ts`, `llm-adjudication.ts`, `assign-matches.ts`, `persist-decisions.ts`. N4 imports them. **N3 files are never modified.**

---

## 5. The One Concrete Risk for Mixed-Format: `comparableSubtotal`

**Issue:** Xactimate's `totalAmount` includes O&P + tax baked in (e.g. $307 for a $234-base item). Symbility's `totalAmount` excludes them (just $234 — O&P and tax are document-level). For the same physical work, totals differ by 25-35%.

**Impact:** `totalSimilarity` (weight 0.11) returns ~0.25 instead of ~1.0 on mixed-format true matches. That's ~0.083 lost on the score, which can push borderline matches below thresholds.

**Fix:** During Phase 9 normalization, compute a new field `comparableSubtotal`:
- For Xactimate items: `totalAmount - (taxAmount || 0) - (opAmount || 0)`
- For Symbility items: `totalAmount` (already excludes them)
- For CSV items: same logic — strip whatever document-level adjustments the schema declares

Update `totalSimilarity` to compare `comparableSubtotal` on both sides. Apples-to-apples.

This change lives in N4's normalization wrapper (or as a small additive change to the shared phase if we explicitly opt into it for N4 only). Either way, **N3 behavior is unchanged**.

---

## 6. Inngest / Vercel Compatibility

The N4 Inngest function uses one `step.run` per side, then chains the shared phases:

```ts
inngest.createFunction({ id: 'process-comparison-n4' }, { event: 'comparison/process.n4' }, async ({ event, step }) => {
  await step.run('extract-yours', () => EXTRACTORS[yourFormat].run(id, 'yours', logger));
  await step.run('extract-adjuster', () => EXTRACTORS[adjFormat].run(id, 'adjuster', logger));
  await step.run('normalize', () => normalizeLineItemsN3(id, logger));
  // ... etc
});
```

Each `step.run` gets independent retries. Each step fits within Vercel's 60s `maxDuration` because per-side extraction is half the work of the current both-sides extraction.

**Concurrency note:** N3's `detect-zones` runs both sides under a shared cap of 17 in-flight Anthropic calls. With per-side dispatch, two sides run independent caps → 34 in-flight. Drop each side's cap to 9 (so 2 × 9 = 18, ≈ Tier 3 limit) or pass a shared limiter from the orchestrator.

---

## 7. Routing — When N4 Runs

A single environment flag at the Inngest entry point:

```
USE_N4_PIPELINE=false  →  process-comparison-n3 (current production path)
USE_N4_PIPELINE=true   →  process-comparison-n4 (new path)
```

Default `false` until all accuracy gates pass. Flip to `true` once verified. Flipping back to `false` is the rollback. **N3 stays callable forever as a safety net.**

---

## 8. Development Phases

Each phase ends with a **gate** that must pass before the next phase begins. Gates are non-negotiable.

### Phase 1 — Scaffolding + Xactimate Port
**Build:**
- `lib/n4/extractors/types.ts` (Extractor interface)
- `lib/n4/extractors/registry.ts` (initially Xactimate-only)
- `lib/n4/extractors/xactimate/` — per-side wrapper around the existing N3 detect-zones + extract-line-items logic. Re-uses N2/N3 prompts and merge utilities verbatim. No prompt changes.
- `lib/n4/pipeline/orchestrator.ts` — dispatch + shared phase imports from `lib/n3/`
- `lib/n4/pipeline/inngest.ts` — `process-comparison-n4` function (feature-flagged off)
- `lib/n4/README.md` — extractor contract docs

**Gate 1 — Xactimate Regression:**
- Run N4 (with feature flag temporarily on for test environment) against the existing labeled Xactimate-Xactimate test comparisons used for the 98.5% baseline.
- Compare N4's output (zones, items, decisions) against N3's output for the same comparisons.
- **Pass condition:** match decisions are byte-identical to N3, OR documented benign differences only (e.g. floating-point drift in scoring < 1e-6).
- **Fail handling:** halt all subsequent phases, debug the port until identical.

### Phase 2 — Symbility Extractor
**Build:**
- `lib/n4/extractors/symbility/prompts/zone-detection.ts` — ROOFPLAN-aware zone detection prompt
- `lib/n4/extractors/symbility/prompts/extraction.ts` — 4-column extraction prompt with explicit skip rules for sub-category headers, note lines, measurement summaries, recap pages
- `lib/n4/extractors/symbility/detect-zones.ts` — per-side zone detection using the new prompt
- `lib/n4/extractors/symbility/extract-line-items.ts` — per-side extraction using the new prompt
- `lib/n4/extractors/symbility/index.ts` — register in `registry.ts`
- Fix `hasNumberedLineItems` regex in N4 (not N3) to accept both `1.` and `1 ` patterns

**Gate 2 — Symbility-Symbility Accuracy:**
- Build a small labeled Symbility-Symbility test set: 5–10 comparisons with known correct match decisions.
- Run N4 end-to-end on each.
- **Pass condition:** ≥95% match decision accuracy on the Symbility test set.
- **Fail handling:** iterate the prompts; common failure modes will be (a) sub-category labels reported as zones, (b) note lines extracted as line items, (c) summary pages mistaken for zones. Re-test until ≥95%.

### Phase 3 — Mixed-Format Normalization Fix
**Build:**
- Add `comparableSubtotal` derivation to N4's normalization step (either as a shared phase change or as a thin N4-only wrapper that calls the shared phase then patches the field).
- Update `totalSimilarity` feature computation to use `comparableSubtotal`.

**Gate 3 — Xactimate-Symbility Mixed Accuracy:**
- Hand-label 3–5 mixed-format comparisons (Xactimate one side, Symbility the other) with known correct decisions.
- Run N4 end-to-end on each.
- **Pass condition:** ≥90% match decision accuracy on mixed-format pairs (lower than same-format because true mixed pairs have inherent ambiguity — line item granularity differs between formats).
- **Fail handling:** investigate which scoring features are degrading; consider per-feature weight tuning specifically for mixed pairs (advanced, not expected to be needed).

### Phase 4 — Upload UI + Feature Flag Rollout
**Build:**
- Format selector dropdown on the upload page (Xactimate / Symbility — CSV greyed out for now).
- Wire selection to `Comparison.{your|adjuster}EstimateFormat` on creation.
- Routing logic at the Inngest entry point: read `USE_N4_PIPELINE` env flag, dispatch to N3 or N4 function accordingly.

**Gate 4 — Production Soak:**
- Deploy with `USE_N4_PIPELINE=false` (no behavior change, but N4 code in production).
- Manually flip flag for a single test comparison; verify it runs through N4.
- Once verified, flip flag globally.

### Phase 5 — XLS/CSV Extractor (Xactimate Spreadsheet Export)

**Scope:** See Section 12 (architecture) and Section 13 (phased development plan) for full detail.

**Build:**
- `lib/n4/extractors/xls/` — full extractor folder (index, detect-zones, extract-items, parse-workbook, column-map)
- `lib/n2/schemas/types.ts` — add `'xls'` to `EstimateFormat`
- `lib/n4/extractors/registry.ts` — register `xlsExtractor`
- Upload route — update file validation + Supabase `contentType` + `VALID_FORMATS` set
- Upload UI — add "Xactimate (Excel/CSV)" dropdown option

**No orchestrator or pipeline changes required.** That is the point of the plug-and-play architecture.

**Gate 5 — XLS accuracy:** ≥95% item extraction accuracy on labeled XLS test fixtures; zones detected correctly; pipeline completes end-to-end to COMPLETED status.

---

## 9. Adding Future Formats Beyond CSV

Any new format follows the same recipe:

1. Create `lib/n4/extractors/{format}/` with at least an `index.ts` exporting an `Extractor`.
2. Inside the extractor, write whatever logic is needed (vision prompts for PDF formats, parsers for structured formats, OCR for scanned formats, etc.) to produce `n3_zones` + `n3_line_items` rows for one side.
3. Add the format to `EstimateFormat` type union.
4. Register in `lib/n4/extractors/registry.ts`.
5. Add to upload UI dropdown.
6. Run accuracy gates.

No orchestrator changes. No shared phase changes. No N3 changes. No Inngest function changes.

---

## 10. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Xactimate per-side refactor introduces subtle behavior differences | Medium | High (regression on 98.5% baseline) | Gate 1 byte-identical regression test |
| Symbility prompts under-perform on edge cases not in the 2 sample PDFs | High | Medium | Gate 2 forces ≥95% on a labeled set; iterate prompts |
| Mixed-format `totalSimilarity` skew due to Xactimate O&P/tax baked in | High (already identified) | Medium | `comparableSubtotal` fix in Phase 3 |
| Inngest step IDs collide with N3 function during rollout | Low | Low | Distinct function ID `process-comparison-n4`; routing flag |
| Per-side concurrency exceeds Anthropic Tier 3 cap | Low | Low | Drop per-side cap to 9 (2 sides × 9 = 18 ≈ 17) |
| CSV schema variance across users (no standard) | Medium | Deferred to N5 | Define a canonical CSV schema; reject unknown columns at upload time |

---

## 11. Acceptance Criteria for "N4 Done"

- [ ] All 4 phases pass their respective gates
- [ ] N3 source files in `lib/n3/passes/` are unchanged from pre-N4 (verified with `git diff`)
- [ ] `USE_N4_PIPELINE=true` produces ≥98.5% accuracy on the original Xactimate test set (no regression)
- [ ] `USE_N4_PIPELINE=true` produces ≥95% accuracy on the new Symbility test set
- [ ] `USE_N4_PIPELINE=true` produces ≥90% accuracy on mixed-format pairs
- [ ] Adding a new format requires only: (a) one new folder under `extractors/`, (b) one new line in `registry.ts`, (c) one new entry in the format type union, (d) one new option in the upload UI
- [ ] Feature flag rollback works: flipping `USE_N4_PIPELINE=false` restores N3 behavior identically

---

## Appendix A — Files Touched / Created

**Created (all under `lib/n4/`):**
- `README.md`
- `extractors/types.ts`
- `extractors/registry.ts`
- `extractors/xactimate/index.ts`
- `extractors/xactimate/detect-zones.ts`
- `extractors/xactimate/extract-line-items.ts`
- `extractors/symbility/index.ts`
- `extractors/symbility/detect-zones.ts`
- `extractors/symbility/extract-line-items.ts`
- `extractors/symbility/prompts/zone-detection.ts`
- `extractors/symbility/prompts/extraction.ts`
- `pipeline/orchestrator.ts`
- `pipeline/inngest.ts`

**Modified (minimal, non-N3):**
- Upload UI component (format dropdown)
- Inngest entry-point routing (feature flag check)
- Possibly `EstimateFormat` type if not already inclusive

**Untouched (verified by `git diff` at end of N4):**
- All files in `lib/n3/`
- All files in `lib/n2/`
- All Prisma schema files (no schema changes — `Comparison.{your|adjuster}EstimateFormat` columns already exist)

---

## 12. XLS/CSV Extractor — Xactimate Spreadsheet Export

### 12.1 Overview

The XLS extractor adds native spreadsheet upload as a true plug-and-play lego piece. It lives entirely in `lib/n4/extractors/xls/` and implements the same `Extractor` interface as the PDF extractors. Zero changes to the orchestrator, Inngest function, or any phase from P9 onward.

**Key property: Zero AI in P4 and P8.** Unlike the PDF extractors which require Anthropic vision calls to detect zones and extract items, XLS/CSV parsing is fully deterministic. The column schema is machine-readable, making extraction:
- **Faster** — synchronous parsing, no AI round-trips
- **Cheaper** — no Anthropic API costs for P4/P8
- **More reliable** — no hallucination risk, no retry logic needed for parsing

### 12.2 Supported File Types

| Extension | MIME Type | Notes |
|---|---|---|
| `.xlsx` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | Primary target — Xactimate export default |
| `.xls` | `application/vnd.ms-excel` | Legacy Excel format |
| `.csv` | `text/csv` | Flat CSV, single-zone assumption unless zone column present |

All three are parsed by the `xlsx` (SheetJS) library. No native bindings required.

### 12.3 Folder Structure

```
lib/n4/extractors/xls/
├── index.ts            Exports xlsExtractor implementing Extractor
├── detect-zones.ts     P4: zone column scan → n3_zones rows
├── extract-items.ts    P8: column map → n3_line_items rows
├── parse-workbook.ts   Downloads file, finds header row, returns typed rows
└── column-map.ts       Alias table + column presence detection
```

### 12.4 Zone Detection Strategy — P4 (`detectZones`)

**Zero AI required.** The Xactimate XLS export encodes zones in the `Group Code` / `Group Description` columns directly.

#### Primary Path — Zone Column Present

1. Download file bytes from Supabase storage (same `supabaseAdmin.storage.download` pattern as PDF extractors)
2. Parse workbook with `xlsx` library; locate the active/first sheet
3. Scan first 10 rows to find the header row (row where a cell matches a known column alias)
4. Locate a zone column using the alias lookup table:

   | Alias checked | Priority |
   |---|---|
   | `Group Code` | 1 — canonical Xactimate export column |
   | `Group Description` | 2 — human-readable fallback |
   | `Room` | 3 — generic alias |
   | `Location` | 3 — generic alias |
   | `Area` | 3 — generic alias |
   | `Zone` | 3 — generic alias |

5. Group all data rows by the zone column value → one `n3_zones` row per unique value
6. `startPage` / `endPage` fields repurposed as `startRow` / `endRow` (same integer columns, semantically different — row indices instead of page numbers; no downstream code re-reads them after P8)
7. `approxItems` = count of rows for that zone
8. `flat = false`, `detectedFormat = 'xls'`

#### Fallback Path — No Zone Column Found

1. Same header detection as above
2. No zone column found → synthesize a single **General** zone containing all data rows
3. `flat = true`, `zoneCount = 1`
4. **No error thrown** — the pipeline's flat-list path is already proven correct (identical to the PDF flat-list fallback used by `synthesizeGeneralZone`)

#### Multi-Sheet XLSX Fallback

If no zone column is found on the active sheet AND the workbook has multiple sheets (each named after a room/area):
- Treat each sheet as a separate zone (sheet name = zone name)
- Collect all rows across sheets
- `flat = false`
- This is the secondary zone encoding convention used by some Xactimate XLS variants

#### Idempotency

Identical to PDF extractors: `prisma.n3Zone.deleteMany({ where: { comparisonId, source: side } })` before `createMany`. Safe to retry.

### 12.5 Line Item Extraction — P8 (`extractLineItems`)

Re-downloads the file, re-parses the workbook, reads `n3_zones` rows (using `startPage`/`endPage` as `startRow`/`endRow`), and maps each spreadsheet row in range to an `n3_line_items` row.

**Zero AI required.**

#### Column Mapping: Xactimate XLS → `n3_line_items`

| `n3_line_items` field | XLS Column | Notes |
|---|---|---|
| `rawDescription` | `Desc` | Direct string copy |
| `normalizedDescription` | computed | `normalizeDescription(Desc)` — same function as PDF extractors |
| `descriptionTokens` | computed | `tokenizeDescription(normalizedDescription)` |
| `rawQuantity` | `Qty` | String cast of numeric cell |
| `rawUnit` | `null` | Not present in this XLS export schema |
| `normalizedUnit` | `null` | Null — P9 normalization will leave it null |
| `unitPrice` | `Unit Cost` | Parse float |
| `removeAmount` | `null` | Not broken out in this XLS export (only item total is exported) |
| `replaceAmount` | `null` | Not broken out in this XLS export |
| `resetAmount` | `null` | Not applicable |
| `taxAmount` | `Sales Tax` | Parse float |
| `opAmount` | `null` | Not present in this XLS export |
| `totalAmount` | `RCV` | See §12.6 for rationale |
| `itemCode` | `Cat` | Xactimate category code (e.g. `FCC`, `RFG`) |
| `sourceLineNumber` | row index | 1-based sequential index within zone |
| `pageNumber` | `1` | Fixed — no pages in spreadsheet; P18 sort still works correctly |
| `specialFlags` | `[]` | Empty; `Coverage` column reserved for future flag mapping |
| `extractionConfidence` | `1.0` | Always 1.0 — deterministic parse, no AI uncertainty |

#### Idempotency + `reextractSource`

Identical pattern to PDF extractors:
```ts
const deleteFilter = reextractSource && reextractSource !== 'both'
  ? { comparisonId, source: reextractSource }
  : { comparisonId, source: side };

await prisma.$transaction([
  prisma.n3LineItem.deleteMany({ where: deleteFilter }),
  prisma.n3LineItem.createMany({ data: lineItemRows }),
]);
```
The `reextractSource` parameter from the Line Item Review gate (Phase 8.5) must be honored exactly as in the PDF extractors so the reextract flow works correctly for XLS comparisons.

### 12.6 Why `RCV` (not `Item Amount`) for `totalAmount`

`RCV = Item Amount + Sales Tax`. The PDF-based Xactimate extractor captures the line total as rendered in the PDF, which is the post-tax total. Using `RCV` aligns XLS extraction with PDF extraction behavior so:
- Cross-format XLS↔Xactimate-PDF comparisons score correctly
- `diffAmount` is computed against apples-to-apples totals
- The `comparableSubtotal` normalization (P9) produces the correct pre-tax value: `RCV − taxAmount = Item Amount`

Verification: `1418.11 qty × $4.94/unit = $7,005.46 (Item Amount)` + `$347.15 (Sales Tax)` = `$7,352.61 (RCV)` ✓

### 12.7 What Is Null and Why — Final View Impact

The following `n3_line_items` fields are null for all XLS-sourced items because they are not present in the Xactimate XLS export schema:

| Field | Null? | Final view column | Impact |
|---|---|---|---|
| `removeAmount` | ✓ | Remove (Yours / Adjuster) | Blank — expected; data not in export |
| `replaceAmount` | ✓ | Replace (Yours / Adjuster) | Blank — expected |
| `opAmount` | ✓ | O&P (Yours / Adjuster) | Blank — expected |
| `rawUnit` / `normalizedUnit` | ✓ | Unit suffix in Qty column | Qty shows numeric value only, no unit |

**No new columns are added to the final comparison view.** The existing columns (`Total`, `Tax`, `Diff`, `Zone`, `Description`, `Qty`, `Status`) are fully populated. The `Remove`, `Replace`, and `O&P` columns will be blank for XLS-sourced items, which is correct and honest — those breakdowns are simply not available in this export format.

### 12.8 Existing Files That Must Be Updated (Upload Route)

Three targeted changes to `app/api/comparisons/route.ts` — **no orchestrator, no Inngest, no N3 touches**:

#### Change 1 — `VALID_FORMATS` set (line 325)
```ts
// Before
const VALID_FORMATS = new Set(['xactimate', 'symbility', 'unknown']);
// After
const VALID_FORMATS = new Set(['xactimate', 'symbility', 'unknown', 'xls']);
```
**Critical:** Without this change, an `xls` format selection silently falls back to `'xactimate'`. The xactimate extractor then tries to PDF-parse the XLS bytes → guaranteed crash.

#### Change 2 — `validatePdf` → `validateEstimateFile`
The current function hard-rejects any non-`application/pdf` MIME type. It must be extended to also accept `.xlsx`, `.xls`, `.csv` MIME types. The function should be renamed to `validateEstimateFile(file, format)` and branch on `format`.

#### Change 3 — `uploadSingleFile` content type
The current function hardcodes `contentType: 'application/pdf'` in the Supabase upload call. This must pass the actual file MIME type so the stored object is semantically correct and can be downloaded with the right content type header.

**N4 auto-routing already handles XLS correctly** (lines 381–385): since `resolvedYourFmt !== 'xactimate'` when format is `'xls'`, the comparison is automatically sent to N4. No routing changes needed.

### 12.9 New Dependency

One new package: `xlsx` (SheetJS) — pure JavaScript, zero native bindings, no server-side compatibility issues.

```bash
npm install xlsx
```

No Prisma schema changes. No new DB tables. No Inngest changes. No N3 changes.

### 12.10 `detectedFormat` Signal

The XLS extractor's `detectZones` returns `detectedFormat: 'xls'`. The orchestrator logs this as a sanity-check signal. No downstream logic gates on `detectedFormat` — it is informational only. No code changes needed for this.

---

## 13. XLS/CSV Extractor — Development Phases

Each phase ends with a gate. Gates are non-negotiable before the next phase begins.

### Phase XLS-1 — Framework Wiring + Scaffolding

**Scope (changes to existing files — additive only):**
- `lib/n2/schemas/types.ts` — add `'xls'` to `EstimateFormat` union
- `lib/n4/extractors/xls/index.ts` — stub extractor (throws `NotImplemented` from both methods)
- `lib/n4/extractors/registry.ts` — register `xls: xlsExtractor`
- `package.json` — add `xlsx` dependency (`npm install xlsx`)

**Why stub first:** The registry entry must exist before any upload UI change goes live. If `'xls'` is in the DB but not in the registry, `resolveExtractor` silently falls back to xactimateExtractor and tries to PDF-parse XLS bytes → crash. Register the stub first; it throws a clear error instead of silently misrouting.

**Gate XLS-1:** TypeScript compiles with zero errors after `EstimateFormat` addition. Existing xactimate and symbility extractor behavior is byte-identical (verified with a regression run against a known comparison).

---

### Phase XLS-2 — Workbook Parsing Layer

**Scope (new files only):**
- `lib/n4/extractors/xls/parse-workbook.ts`
  - `downloadXlsBytes(storagePath)` — same Supabase download pattern as PDF extractors
  - `parseWorkbook(bytes, filename)` — detects `.xlsx`/`.xls`/`.csv` by extension, returns `{ headers: string[], rows: Record<string, unknown>[], sheets: string[] }`
  - `findHeaderRow(rawRows)` — scans first 10 rows, returns index of row matching known header aliases
  - `toTypedRows(raw, headerIdx)` — returns array of `Record<string, string | number | null>` keyed by header name
- `lib/n4/extractors/xls/column-map.ts`
  - `ZONE_COLUMN_ALIASES` — ordered list of aliases for zone grouping column
  - `REQUIRED_COLUMNS` — `['Desc']` minimum (fail if missing — surface clear user error)
  - `findZoneColumn(headers)` — returns first matching alias or `null`
  - `findColumn(headers, aliases)` — generic column finder used by extract-items

**Gate XLS-2:** Unit test against a real Xactimate XLS export file:
- All data rows parsed correctly
- Header row detected at correct index
- `Group Code` column identified as zone column
- `Desc`, `Qty`, `Unit Cost`, `RCV`, `Sales Tax`, `Cat` columns all found
- No data rows lost, no phantom rows added

---

### Phase XLS-3 — `detectZones` Implementation

**Scope (new file):**
- `lib/n4/extractors/xls/detect-zones.ts`
  - Full implementation of zone detection as described in §12.4
  - Calls `downloadXlsBytes` + `parseWorkbook` + `findZoneColumn`
  - Groups rows by zone → writes `n3_zones` (with `startPage`/`endPage` as `startRow`/`endRow`)
  - Flat fallback: synthesize General zone when no zone column found
  - Multi-sheet fallback: one zone per sheet when no zone column and multiple sheets
  - Per-side idempotent DB write
  - Returns `{ zoneCount, flat, detectedFormat: 'xls' }`
- Update stub in `index.ts` to call real implementation

**Gate XLS-3:** Run P4 in isolation on a test XLS file with known zones. Verify:
- Correct number of `n3_zones` rows written
- Zone names match `Group Description` values from the spreadsheet
- `approxItems` count is accurate per zone
- Flat fallback triggers on a single-zone/no-header-zone file

---

### Phase XLS-4 — `extractLineItems` Implementation

**Scope (new file):**
- `lib/n4/extractors/xls/extract-items.ts`
  - Full implementation as described in §12.5
  - Re-downloads file, re-parses workbook
  - Reads `n3_zones` rows; uses `startPage`/`endPage` as `startRow`/`endRow` for slice
  - Column mapping per §12.5 table
  - Applies `normalizeDescription` + `tokenizeDescription` (same imports as PDF extractors)
  - Honors `reextractSource` parameter identically to PDF extractors
  - Per-side idempotent DB write
  - Returns `{ itemCount }`
- Update stub in `index.ts` to call real implementation

**Gate XLS-4:** Run P4 + P8 in isolation on the test XLS file. Verify:
- Item count matches row count in source file
- `rawDescription` matches `Desc` column exactly
- `totalAmount` = `RCV` column value (float, 2dp)
- `taxAmount` = `Sales Tax` column value
- `unitPrice` = `Unit Cost` column value
- `itemCode` = `Cat` column value
- `removeAmount`, `replaceAmount`, `opAmount` are all `null`
- `pageNumber` = 1 for all items
- `sourceLineNumber` = 1-based row index within zone
- Duplicate rows absent

---

### Phase XLS-5 — Upload Flow + UI

**Scope (changes to existing files — targeted, additive):**

**`app/api/comparisons/route.ts`:**
- Add `'xls'` to `VALID_FORMATS` set
- Rename `validatePdf` → `validateEstimateFile(file, format)`:
  - PDF formats (`xactimate`, `symbility`, `unknown`): enforce `application/pdf` MIME type
  - XLS format: enforce `.xlsx` / `.xls` / `.csv` extension + corresponding MIME types
  - File size limit stays at 20MB for all formats
- Update `uploadSingleFile` to pass actual file MIME type to Supabase `contentType`

**Upload UI component:**
- Add "Xactimate (Excel / CSV)" option to the format dropdown for both sides
- No other UI changes

**Gate XLS-5:** End-to-end manual test:
1. Upload a real Xactimate XLS file via UI with format = "Xactimate (Excel / CSV)"
2. Verify `Comparison.yourEstimateFormat = 'xls'` written to DB
3. Verify N4 pipeline is triggered (auto-routing fires because format ≠ `'xactimate'`)
4. Verify P4 + P8 complete without error
5. Verify pipeline reaches COMPLETED status

---

### Phase XLS-6 — End-to-End Accuracy Gate

**Scope:** No code changes — testing only.

**Test fixture:**
- Take a real Xactimate XLS export with known zones and items
- Manually create a cheatsheet (zone list + item list with descriptions, totals)
- Run as a self-comparison (same XLS on both sides) — expected result: 100% MATCH
- Run as a cross-comparison (XLS contractor vs XLS adjuster with known differences) — verify MODIFIED/MISSING/ADDED classifications

**Pass condition:**
- ≥95% item extraction accuracy (items extracted / items in source file)
- All zones detected correctly (zone count and names match cheatsheet)
- Pipeline completes to COMPLETED status on both test fixtures
- `totalYours` / `totalAdjuster` on the Comparison row match the known totals from the XLS file
- `Remove` / `Replace` / `O&P` columns blank in final view (expected — data not in export)
- `Tax` and `Total` columns correctly populated

**Fail handling:** Debug at the phase level (P4 or P8 isolation) using the per-phase gates from XLS-3 and XLS-4 before re-running end-to-end.
