# N4 — Multi-Format Estimate Pipeline

**Status:** Planning
**Predecessor:** N3 (Xactimate-only, 98.5% match accuracy)
**Successor placeholder:** N5 (CSV ingest — slot already provisioned)

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

### Phase 5 (Future, when CSV is prioritized) — N5 CSV Extractor
**Build:**
- `lib/n4/extractors/csv/index.ts` — implements the same `Extractor` interface
- `lib/n4/extractors/csv/parse-csv.ts` — deterministic CSV → `n3_zones` + `n3_line_items` rows. No AI calls.
- `lib/n4/extractors/csv/schema.ts` — defines the expected CSV column schema (zone, description, qty, unit, unit_price, total, optional tax, optional op)
- Register in `registry.ts`
- Enable CSV option in upload UI

**No orchestrator or pipeline changes required.** That is the point of the plug-and-play architecture.

**Gate 5 — CSV accuracy:** ≥95% on labeled CSV-CSV pairs and ≥90% on CSV-Xactimate / CSV-Symbility mixed.

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
