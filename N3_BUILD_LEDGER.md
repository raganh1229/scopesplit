# N3 Build Ledger

**Status:** Phase 0 ✅ · Phase 1 ✅ · Phase 2 ✅ · Phase 3 ✅ · Phase 4 ✅ · Phase 6 ✅ · Phase 8 ✅ · Phase 9 ✅ · Phase 11 ✅ · Phase 12 ✅ · Phase 13 ✅ · Phase 14 ✅ · Phase 15 ✅ · Phase 16 ✅ · Phase 17 ✅ · Phase 18 ✅ · UI gates (5, 7, 10) + calibration pending  
**Last updated:** May 10, 2026  
**Spec reference:** `N3.md` (spec only — do not confuse with this ledger)

---

## Document Purpose

This document is the **implementation ledger** for N3. It records only what has been *built and verified*, not what is planned. The specification lives in `N3.md`. When phases diverge from the spec, this ledger takes precedence as the ground truth for what is actually in the codebase.

---

## Document History

| Date | Entry |
|------|-------|
| May 10, 2026 | **Third-party review remediation (11 items + 2 follow-ups)** — addressed all findings from external N3 flaw analysis plus two cleanup items surfaced during review. **Follow-up A:** All 4 N3 phases that call Anthropic are now consistently on `claude-sonnet-4-6` — `detect-zones.ts`, `propose-correspondences.ts`, `extract-line-items.ts` updated to match `llm-adjudication.ts`. **Follow-up B:** Pre-existing TS2322 error at `extract-line-items.ts:153` resolved — `ExtractedZoneResult.items` now uses `z.input<typeof N3ExtractedItemSchema>` to match what `parseAndValidate<T>(...schema: z.ZodSchema<T>): T` actually returns (T is inferred from schema input shape). Downstream consumption already coalesces with `?? null`, so the change is type-only. Full codebase now type-checks clean (`tsc --noEmit` exit 0). **Correctness:** (1) `llm-adjudication.ts` model `claude-sonnet-4-5` → `claude-sonnet-4-6`. (2) Phase 17 silent `possible`-leak fix: when LLM omits an index in its JSON response, the decision now converts to `unmatched` instead of falling through to `persist-decisions` default of `MODIFIED` (which would have surfaced uncertain pairs as confirmed price-different matches). (3) `MAX_TOKENS` now scales with `pairs.length × 80` (floor 2000) so large adjudication batches do not silently truncate. **Algorithmic:** (4) Phase 16 `zoneCompatibility` feature now uses `N3ZoneCorrespondence` lookup (matching Phase 13 behaviour) so cross-zone correspondences (e.g. "Master Bath" ↔ "Master Bathroom") no longer score `f5 = 0`. (5) Standardised Jaccard empty-set behaviour to `0.0` across all three implementations (`normalization.ts:jaccardSimilarity`, `score-candidates.ts:computeJaccard`, `group-matching.ts:jaccard`); test updated. (6) `score-candidates.ts:computeJaccard` now dedups `tokensB` and uses set-size denominator (previously raw `tokensB.length` inflated intersection on duplicate tokens). **Performance:** (7) `assign-matches.ts` now pre-builds `edgesByYours` and `edgesByAdj` indices once after `edgeLookup`; both the bidirectional-best rescue pass and the zone-conflict repair pass now use O(degree) lookups instead of O(all-edges) scans per decision (~960k iterations → ~80k for typical comparison). (8) `score-candidates.ts` per-edge updates replaced with bulk `UPDATE … FROM (VALUES …)` via `$executeRawUnsafe`, batched 1000 rows per round trip (was 50 per round trip = 300 RTs for 15k edges → 15 RTs). **Documentation:** (9) `score-candidates.ts:46-49` `byBucket` threshold comments now match actual `SCORE_THRESHOLDS` constants (0.75/0.55/0.30, was 0.90/0.75/0.60). (10) `build-components.ts:38-39` swapped singleton comments fixed (yours-only → MISSING_FROM_ADJUSTER, adj-only → ADDED_BY_ADJUSTER). (11) `process-comparison-v3.ts:16` Phase 11 step comment fixed: "OpenAI embeddings" → "Voyage AI embeddings (voyage-3-lite)". All touched files lint-clean. |
| May 7, 2026 | Phase 0 complete: types, constants, normalization, fixture, 128 passing tests |
| May 7, 2026 | Phase 1 complete: 8 n3_* Prisma models + migration `20260512000000_n3_foundation` applied to Supabase |
| May 8, 2026 | Phase 2 complete: `n3-routing.ts` gate + `process-comparison-v3.ts` 16-step Inngest scaffold registered in route |
| May 8, 2026 | Phase 3 complete: Accuracy Runner `--mode flat` — 1864/1971 GT pairs found across 9 sets (93% recall, 2 of 11 features) |
| May 8, 2026 | Phase 4 complete: `lib/n3/passes/detect-zones.ts` — Sonnet vision + pdf-parse text grounding → `n3_zones` rows, wired in Inngest step |
| May 8, 2026 | Phase 6 complete: `lib/n3/passes/propose-correspondences.ts` — Sonnet zone correspondence proposal → `n3_zone_correspondences` rows, wired in Inngest step |
| May 8, 2026 | Phase 8 complete: `lib/n3/passes/extract-line-items.ts` — Sonnet vision per-zone extraction → 149 `n3_line_items` rows (75 yours + 74 adj) on 12 zones. Validated against ground truth: 100% accurate |
| May 8, 2026 | Phase 9 complete: `lib/n3/passes/normalize-line-items.ts` — deterministic normalization → 149/149 quantity, 149/149 unit, 94/149 trade, 78/149 action, 8/149 specialFlags |
| May 8, 2026 | Phase 11 complete: `lib/n3/passes/generate-embeddings.ts` — Voyage AI `voyage-3-lite` 512-dim embeddings → `n3_line_items.embedding vector(512)`. DB migration applied via raw SQL. VOYAGE_API_KEY env var required |
| May 9, 2026 | Phase 18 complete: `lib/n3/passes/persist-decisions.ts` — projects N3MatchDecision rows → `line_items` table. Mapping: one_to_one (±1% amounts) → MATCH/MODIFIED, grouped → GROUPED, unmatched-yours → MISSING_FROM_ADJUSTER, orphaned-adj → ADDED_BY_ADJUSTER. Atomic deleteMany+createMany+comparison-update transaction. Aggregates (totalGap, yourEstimateTotal, adjEstimateTotal, counts) written to Comparison. Pipeline now end-to-end functional with no stubs blocking output. |
| May 9, 2026 | Phase 17 complete: `lib/n3/passes/llm-adjudication.ts` — batched Sonnet call for all 20 `possible` decisions. Accepted 17 (→ one_to_one), rejected 3 (→ unmatched). Cost $0.028/run (~3¢). N3LlmCall telemetry row written. |
| May 9, 2026 | Phase 16 complete: `lib/n3/passes/group-matching.ts` — union-find group search for unmatched yours items over top-K=8 adj candidates. groupedCount: 0 on test comparison (unmatched item is genuinely unique — correct). |
| May 9, 2026 | Phase 15 complete: `lib/n3/passes/assign-matches.ts` — O(n³) Hungarian (dual-variable Jonker–Volgenant) on 5 components. 75 decisions: 54 one_to_one (≥0.55), 20 possible (0.30–0.55), 1 unmatched yours, 0 unmatched adj. All 74 adj items assigned; 1 yours item correctly surfaces as “added”. Math verified: 54+20+1=75 ✔️ |
| May 9, 2026 | Phase 14 complete: `lib/n3/passes/build-components.ts` — Union-Find (path compression + union-by-rank) over 515 surviving edges → 5 components (4 small, 1 medium, 0 large). 0 singletons on either side — all 149 items connected. Medium component contains bulk of items (~100+); Phase 15 will solve as one ~50×54 Hungarian matrix. Ran in 313ms |
| May 9, 2026 | Phase 13 complete: `lib/n3/passes/score-candidates.ts` — computes all 11 features per edge, rawScore+finalScore via computeRawScore/computeFinalScore, zone boosts from correspondence lookup, isRejected via shouldRejectEdge. 515/3366 edges survive (15.3%): 1 highConfidence, 55 possibleMatch, 459 weakCandidate. SCORE_THRESHOLDS.REJECT lowered 0.60→0.30 pre-calibration (materialObject+itemCode stubs subtract 0.15 from all scores; will be raised after Phase 10 NLP). Batch-updated 3366 rows in ~20s via 68 parallel chunks of 50 |
| May 9, 2026 | **Bug fix — `constants.ts` weight redistribution:** `materialObjectSimilarity` (stub, always 0) and `itemCodeSimilarity` (stub, always 0) each reduced from their original allocations to 0.01 (slot-reservation only). The freed weight (+0.13 total) redistributed to active features: fuzzy +0.03, semantic +0.04, tradeAction +0.02, qty +0.02, total +0.01, zone +0.01. Ensures stub features do not silently cap max achievable raw score at 0.85. |
| May 9, 2026 | **Bug fix — `normalize-line-items.ts` trade keyword ordering:** `cabinetry` pattern now tested before `flooring` pattern. Previously `'laminate'` in the flooring block matched `"laminate countertop"` items before the cabinetry block could claim them, producing `tradeActionSimilarity = 0` on cabinet/countertop pairs. Also tightened `'laminate'` → `'laminate floor'` to prevent countertop false-positives. |
| May 9, 2026 | **Bug fix — `persist-decisions.ts` orphaned contractor items:** Added orphan-detection pass (§5c) after the main decision loop. Any `yours`-side `N3LineItem` not referenced by any `N3MatchDecision` is now persisted as `MISSING_FROM_ADJUSTER`. Previously such items were silently dropped (e.g. ALE / contractor-only items whose edges were all rejected and who received no `unmatched` decision from Phase 15). |
| May 9, 2026 | **Bug fix — `assign-matches.ts` mutual-best rescue pass (§4):** Added a post-Hungarian bidirectional-best-match rescue pass. Hungarian's global cost minimization can sacrifice a clearly-mutual-best pair for a marginal aggregate gain elsewhere (§A.6 known limitation). The rescue pass detects pairs where (a) both items are unmatched, (b) each item's highest-scoring edge to any remaining unmatched counterpart is the same edge, and (c) that edge scores ≥ `POSSIBLE_MATCH`. Such pairs are merged into a `one_to_one` decision with `decidedBy: 'mutual_best_rescue'`. Fixed the carpet pad cross-zone mis-assignment on V1. |
| May 9, 2026 | **V1 end-to-end validation:** Triggered full N3 pipeline run against V1 verified-set PDFs (comparison `29811a19-5070-430f-a1ea-f513bd753040`). Results: 53/54 line-item pairs correct (98.1%). Counts match cheatsheet exactly: 36 MATCH, 9 MODIFIED, 5 MISSING, 2 ADDED. Dollar totals match: contractor $45,905.62, adjuster $36,510.72, gap $9,394.90. One known composition error: Master Bedroom closet items swapped (walk-in organizer incorrectly paired with wire shelving; closet wire shelving incorrectly MISSING). Total gap preserved by coincidence. Pending fix. |
| May 9, 2026 | Phase 12 complete: `lib/n3/passes/generate-candidates.ts` — 5 retrieval sources (ai_proposed_zone, semantic, fuzzy_description, total_similarity, item_code). 3,367 candidate edges generated from 149 items (75 yours + 74 adj). item_code=0 (no Xactimate codes in test PDFs). Retrieval sources are unioned and deduplicated into `n3_candidate_edges` with placeholder scores for Phase 13 |

---

## Invariants (Architectural Decisions, Locked)

These decisions were made before Phase 0 and are binding for all subsequent phases:

- **Build discipline:** N3 lives entirely in `lib/n3/` and `app/api/.../n3/`. No N2 files are modified until N3 is fully validated. N2 is hard-coded paused via `N2_PAUSED_FOR_N3 = true` in `lib/n2/n2-routing.ts`.
- **Side identity:** Asymmetric — `yours` (contractor) and `adjuster`. N3 spec's symmetric `e1/e2` is translated throughout.
- **Line-item model:** Denormalized output. Existing `LineItem` Prisma model is preserved for the UI and results renderer. `N3LineItem` is intermediate processing state only; decisions project down to `LineItem` rows at persist time.
- **Schema naming:** `n3_*` prefix during build. Prefix dropped in the N2→N3 cutover commit.
- **Scoring domain:** Raw weighted feature sum clamped to `[0, 1]` after boosts/penalties (§A.6 option 1). No unbounded additive domain.
- **Below-threshold edges are dropped**, not retained as low-confidence ghosts (§A.6 §17.1 fix).
- **Zone correspondences are priors, not hard walls** (§A.4). A match outside a verified zone gets a penalty; it is not blocked.
- **Candidate generation is bidirectional** (yours→adjuster AND adjuster→yours), deduplicated to (yours=source, adjuster=target) direction.
- **Embeddings:** Voyage AI `voyage-3-lite` (512-dim) + pgvector for Phase 11. Implemented and live. `VOYAGE_API_KEY` env var required. (Original spec said OpenAI `text-embedding-3-small`; switched to Voyage AI per Anthropic recommendation.)
- **Group matching UI:** Flat-with-link badge (deferred to Phase 21).

---

## Phase 0 — Types, Constants, Normalization, Fixtures

**Completed:** May 7, 2026  
**Test gate:** 128 tests passing (`__tests__/n3/normalization.test.ts`)  
**Spec reference:** N3.md §B.1 Phase 0 row

### Files Created

#### `estimatch-app/lib/n3/types.ts`

Single source of truth for all N3 TypeScript types. Import from here — never re-declare inline.

| Type | Description |
|------|-------------|
| `N3EstimateSource` | `'yours' \| 'adjuster'` |
| `N3EstimateFormat` | `'xactimate' \| 'symbility' \| 'unknown'` |
| `N3SpecialFlag` | `'tax' \| 'op' \| 'depreciation' \| 'permit' \| 'emergency_service' \| 'debris_removal'` |
| `N3ZoneCorrespondenceType` | `'one_to_one' \| 'one_to_many' \| 'many_to_one' \| 'many_to_many' \| 'unmatched_zone'` |
| `N3VerificationStatus` | `'ai_proposed' \| 'user_confirmed' \| 'user_corrected' \| 'user_rejected'` |
| `N3Zone` | Detected zone (Phase 4). Maps to `n3_zones` table. |
| `N3ZoneCorrespondence` | AI-proposed or user-verified zone pair. Maps to `n3_zone_correspondences`. |
| `N3NormalizedLineItem` | Intermediate item shape after extraction + normalization. Maps to `n3_line_items`. |
| `N3RetrievalSource` | 9 retrieval strategies for candidate generation (Phase 12). |
| `N3CandidateScoreFeatures` | 11 combined scoring features (§16.2 resolved). All `[0, 1]`. |
| `N3ZoneBoost` | Zone boost/penalty record applied after raw weighted sum. |
| `N3CandidateEdge` | A candidate edge between one yours-side item and one adjuster-side item. Maps to `n3_candidate_edges`. |
| `N3ComponentSize` | `'small' \| 'medium' \| 'large'` |
| `N3MatchComponent` | Connected component in the sparse bipartite candidate graph. Maps to `n3_match_components`. |
| `N3DecisionSource` | How a decision was produced (6 sources, priority-ordered). |
| `N3MatchDecisionType` | `'one_to_one' \| 'one_to_many' \| 'many_to_one' \| 'grouped' \| 'possible' \| 'unmatched'` |
| `N3MatchDecision` | A match decision produced by assignment/adjudication. Maps to `n3_match_decisions`. |
| `N3GroupScoreFeatures` | 7 group scoring features for one-to-many/many-to-one candidates. |
| `N3LlmCall` | Per-call LLM telemetry. Maps to `n3_llm_calls`. |
| `N3ExtractionWarningType` | 5 warning categories from extraction validation. |
| `N3ExtractionWarning` | An extraction warning from Phase 10. Maps to `n3_extraction_warnings`. |

---

#### `estimatch-app/lib/n3/constants.ts`

All numeric and dictionary constants. Imports `N3CandidateScoreFeatures` and `N3RetrievalSource` from `types.ts`.

| Constant | Type | Value / Notes |
|----------|------|---------------|
| `SCORE_WEIGHTS` | `Record<keyof N3CandidateScoreFeatures, number>` | 11 weights, sum = 1.00. Enforced at compile time with `satisfies`. |
| `ZONE_BOOSTS` | `const` object | `user_corrected: +0.15`, `user_confirmed: +0.12`, `ai_proposed: +0.06`, `outside_verified: -0.08` |
| `SCORE_THRESHOLDS` | `const` object | `HIGH_CONFIDENCE: 0.90`, `POSSIBLE_MATCH: 0.75`, `WEAK_CANDIDATE: 0.60`, `REJECT: 0.60` |
| `ZONE_CONFIDENCE` | `const` object | `user_corrected: 1.0`, `user_confirmed: 0.95`, `ai_proposed: 0.75`, `user_rejected: 0.0` |
| `COMPONENT_SIZE` | `const` object | `SMALL_MAX: 50`, `MEDIUM_MAX: 250` |
| `GROUP_MATCH` | `const` object | `TOP_K_CANDIDATES: 8`, `MAX_GROUP_SIZE: 5`, `MIN_GROUP_SIZE: 2` (caps combinations at ≤210) |
| `CANDIDATE_BUDGETS` | `Record<N3RetrievalSource, number>` | Per-retrieval-source candidate fetch limits (pre-dedup) |
| `UNIT_EXPANSION` | `Record<string, string>` | 15 unit abbreviations → canonical English |
| `ABBREV_EXPANSION` | `Record<string, string>` | 8 description abbreviations → expansions (`r&r`, `d&r`, `demo`, etc.) |
| `DESCRIPTION_STOPWORDS` | `ReadonlySet<string>` | 22 tokens filtered during tokenization |
| `SPECIAL_FLAG_PATTERNS` | `Record<string, RegExp>` | 6 regex patterns for `detectSpecialFlags()` |

**Calibration note:** `SCORE_WEIGHTS` and `SCORE_THRESHOLDS` are initial values from §16.2–§16.3. They must be recalibrated against labeled fixture data before Phase 13 is production-ready.

**Score weights breakdown** *(as of May 9, 2026 redistribution — see Bug Fixes section)*:

| Feature | Weight | Notes |
|---------|--------|-------|
| `descriptionFuzzySimilarity` | 0.23 | +0.03 from stubs |
| `descriptionSemanticSimilarity` | 0.19 | +0.04 from stubs |
| `tradeActionSimilarity` | 0.14 | +0.02 from stubs |
| `quantityUnitSimilarity` | 0.12 | +0.02 from stubs |
| `totalSimilarity` | 0.11 | +0.01 from stubs |
| `zoneCorrespondenceSimilarity` | 0.09 | +0.01 from stubs |
| `unitPriceSimilarity` | 0.06 | |
| `sequenceSimilarity` | 0.02 | |
| `specialFlagCompatibility` | 0.02 | |
| `materialObjectSimilarity` | 0.01 | **Stub** (Phase 10 NLP not built); 0.01 preserves slot |
| `itemCodeSimilarity` | 0.01 | **Stub** (0% on real-description PDFs); 0.01 preserves slot |
| **Sum** | **1.00** | |

---

#### `estimatch-app/lib/n3/normalization.ts`

Pure functions — no I/O, no DB, no AI. Safe to call in any context.

| Function | Signature | Description |
|----------|-----------|-------------|
| `parseAmount` | `(raw: string \| number \| null \| undefined) → number \| null` | Parses dollar strings including `$1,250.00`, `(250.00)` accounting negatives, `-250`, plain numbers. Returns `null` for unparseable input. |
| `amountSimilarity` | `(a: number \| null, b: number \| null) → number` | Step-function similarity: identical→1.0, <2%→1.0, <5%→0.9, <10%→0.75, <20%→0.5, <35%→0.25, ≥35%→0.0. Both null→0, both zero→1.0. |
| `detectSpecialFlags` | `(description: string) → N3SpecialFlag[]` | Detects tax, O&P, depreciation, permit, emergency, debris from description text. Case-insensitive; whole-word matching. |
| `expandUnit` | `(unit: string \| null \| undefined) → string \| null` | Looks up `UNIT_EXPANSION[unit.toUpperCase()]`. Returns original unit if not found. |
| `tokenizeDescription` | `(description: string) → string[]` | Lowercase → split on non-alphanumeric → filter (len<2 or stopword). Intended for use on `normalizedDescription`. |
| `jaccardSimilarity` | `(a: string[], b: string[]) → number` | `\|A∩B\| / \|A∪B\|`. Both empty→1.0, one empty→0.0. Set semantics (deduplicates input). |
| `normalizeDescription` | `(description: string) → string` | Lowercase → expand abbreviations (BEFORE punctuation strip, so `r&r` expands) → strip non-alphanumeric → collapse whitespace. |
| `computeRawScore` | `(features: N3CandidateScoreFeatures) → number` | `Σ(weight_i × feature_i)`. Result in `[0,1]` when all features in `[0,1]`. |
| `computeFinalScore` | `(rawScore: number, boosts: N3ZoneBoost[]) → number` | `clamp(rawScore + Σboosts, 0, 1)`. |
| `shouldRejectEdge` | `(finalScore: number) → boolean` | Returns `true` if `finalScore < SCORE_THRESHOLDS.REJECT`. Special-flag hard-reject logic is a stub (Phase 12 will wire it). |

**Key normalization ordering invariant:** In `normalizeDescription`, abbreviation expansion happens *before* punctuation stripping. If the order were reversed, `"R&R"` would become `"r r"` (ampersand stripped) and would not match the `"r&r"` key in `ABBREV_EXPANSION`. Tests enforce this.

---

#### `estimatch-app/lib/n3/__fixtures__/set3-cross-zone-pairs.json`

Test fixture encoding the two empirical N2 failure modes that motivated N3 (§27.10, §27.11).

**Structure:**
- `yoursItems` — 7 contractor-side line items
- `adjusterItems` — 7 adjuster-side line items
- `expectedPairs` — 7 one-to-one expected matches (all have identical totals)
- `normalizationExpectations` — 4 raw→normalized string assertions
- `amountSimilarityExpectations` — 7 `(a, b, expected)` step-function assertions

**Failure modes captured:**

| ID | Failure mode | Description |
|----|-------------|-------------|
| `y-001` / `a-001` | Mode #1 — attention-budget recall | "Tear off TPO membrane roofing" vs "Strip TPO membrane roofing system" — identical total $4,515.84, cross-zone |
| `y-002` / `a-002` | Mode #1 — attention-budget recall | "Tear off polyiso insulation 2.5 inch" vs "Tear off polyiso" — identical total $890.12, cross-zone |
| `y-003` / `a-003` | Mode #2 — wrong-zone pairing | "Demolition - remove drywall 1/2 inch" vs "Demo drywall - 1/2 in. gypsum board" — adjuster filed to `Demolition & Debris Hauling`, invisible to N2 Pass 5 |
| `y-004` / `a-004` | R&R expansion | "R&R Carpet - per SF" should tokenize to `remove replace carpet` matching "Carpet - remove and replace" |
| `y-005` / `a-005` | Abbreviation parity | "Remove and replace ceramic tile" vs "Ceramic floor tile - R&R" |
| `y-006` / `a-006` | D&R expansion | "D&R Light fixture - recessed" vs "Detach and reset recessed light fixture" |
| `y-007` / `a-007` | Token overlap | "Temporary protection - poly sheeting" vs "Poly sheeting - temporary weather protection" |

---

#### `estimatch-app/__tests__/n3/normalization.test.ts`

**128 tests, 0 failures.** Full test suite for all Phase 0 code.

| `describe` block | Tests | What it validates |
|-----------------|-------|-------------------|
| `SCORE_WEIGHTS` | 4 | Weights sum to 1.00, count = 11, all positive, `descriptionFuzzy` is max |
| `SCORE_THRESHOLDS` | 3 | Ordering, bounds, `REJECT === WEAK_CANDIDATE` alias |
| `ZONE_CONFIDENCE` | 3 | `user_corrected = 1.0`, `user_rejected = 0.0`, ordering |
| `ZONE_BOOSTS` | 2 | `user_corrected` is largest positive, `outside_verified` is negative |
| `GROUP_MATCH` | 2 | Combination count ≤ 210 (§A.6 cap), `MIN < MAX` |
| `COMPONENT_SIZE` | 1 | `SMALL_MAX < MEDIUM_MAX` |
| `CANDIDATE_BUDGETS` | 2 | `verified_zone` is max, all positive integers |
| `parseAmount` | 14 | null/undefined/"", plain numbers, Infinity, currency strings, accounting negatives, commas, whitespace |
| `amountSimilarity` | 13 | null handling, both-zero, one-zero, all 5 step-function bands, symmetry, fixture validation, negatives |
| `detectSpecialFlags` | 10 | Each flag, multi-flag, whole-word guard ("Xactimate" doesn't match "tax"), case-insensitivity |
| `expandUnit` | 11 | null/empty, each common unit, case-insensitivity, unknown passthrough, whitespace trimming, full dictionary coverage |
| `tokenizeDescription` | 7 | Empty, split, stopword filter, length filter, lowercasing, punctuation, pipeline integration |
| `jaccardSimilarity` | 8 | Identical, disjoint, both-empty, one-empty, partial overlap, set semantics, symmetry, Set3 TPO ranking |
| `normalizeDescription` | 11 | Lowercase, R&R/D&R/demo expansion, punctuation strip, whitespace collapse, trim, mid-word guard, fixture assertions, ordering invariant, Set3 TPO token check |
| `computeRawScore` | 5 | Zero features→0, all-one→1.0, weight proportionality, single-feature spot check, Set3 realistic pair |
| `computeFinalScore` | 6 | Floor clamp, ceiling clamp, no boosts passthrough, boost application, penalty application, accumulation |
| `shouldRejectEdge` | 4 | Below threshold, at threshold, high-confidence, possible-match |
| `fixture: set3-cross-zone-pairs` | 12 | Structure, all totals parse, both failure-mode pairs score 1.0, all pairs identical total, cross-zone token overlap, R&R expansion |
| `ABBREV_EXPANSION` | 4 | All keys lowercase, all values lowercase, `r&r`, `d&r` spot checks |

---

#### `estimatch-app/vitest.config.ts` (updated)

Added `lib/n3/**/*.ts` to the coverage `include` array alongside `lib/n2/**/*.ts`.

---

## Phase 1 — Prisma Schema + Migration

**Completed:** May 7, 2026  
**Migration name:** `20260512000000_n3_foundation`  
**Migration status:** Applied to Supabase (`aws-1-us-east-1.pooler.supabase.com:5432`)  
**Spec reference:** N3.md §B.1 Phase 1 row

### Schema changes (`estimatch-app/prisma/schema.prisma`)

8 new Prisma models + 8 back-relations added to `Comparison`. All models use `@@map("n3_*")` for Postgres table naming.

**All new tables have `ON DELETE CASCADE` from `Comparison` for GDPR compliance (§B.4).**

#### New models

| Prisma model | Table | Phase written | Purpose |
|-------------|-------|--------------|---------|
| `N3Zone` | `n3_zones` | Phase 4 | Detected zones from zone detection pass |
| `N3ZoneCorrespondence` | `n3_zone_correspondences` | Phase 6/7 | AI-proposed + user-verified zone pairs |
| `N3LineItem` | `n3_line_items` | Phase 8/9 | Extracted + normalized line items (intermediate) |
| `N3CandidateEdge` | `n3_candidate_edges` | Phase 12/13 | Scored candidate matches |
| `N3MatchComponent` | `n3_match_components` | Phase 14 | Connected components of the sparse bipartite graph |
| `N3MatchDecision` | `n3_match_decisions` | Phase 15/16/17 | Final match decisions before LineItem persist |
| `N3LlmCall` | `n3_llm_calls` | Phase 20 | Per-call LLM telemetry (cost tracking) |
| `N3ExtractionWarning` | `n3_extraction_warnings` | Phase 10 | Extraction validation warnings surfaced in UI |

#### Implicit join tables (Prisma many-to-many)

| Table | Connects |
|-------|---------|
| `_YourZoneCorrespondences` | `N3Zone` ↔ `N3ZoneCorrespondence` (yours side) |
| `_AdjusterZoneCorrespondences` | `N3Zone` ↔ `N3ZoneCorrespondence` (adjuster side) |
| `_ComponentEdges` | `N3CandidateEdge` ↔ `N3MatchComponent` |

#### Key indexes

| Index | Table | Columns | Purpose |
|-------|-------|---------|---------|
| `idx_n3_zones_comparison_source` | `n3_zones` | `(comparison_id, source)` | Zone fetch per comparison side |
| `idx_n3_line_items_comparison_source` | `n3_line_items` | `(comparison_id, source)` | Item fetch per comparison side |
| `idx_n3_line_items_comparison_total` | `n3_line_items` | `(comparison_id, total_amount)` | Total-similarity retrieval (Phase 12) |
| `uq_n3_candidate_edge_pair` | `n3_candidate_edges` | `(source_item_id, target_item_id)` | Dedup upsert key |
| `idx_n3_candidate_edges_score` | `n3_candidate_edges` | `(comparison_id, final_score)` | Top-K edge queries (Phase 13/14) |
| `idx_n3_candidate_edges_rejected` | `n3_candidate_edges` | `(comparison_id, is_rejected)` | Graph construction filter |
| `idx_n3_match_decisions_type` | `n3_match_decisions` | `(comparison_id, decision_type)` | Decision summary queries |

#### Notable column decisions

- `N3ZoneCorrespondence.confidence` — `DECIMAL(4,3)` — stored explicitly (derived from `verificationStatus`) for query-time zone boost lookups without a join.
- `N3CandidateEdge.boostsJson`, `featuresJson` — `JSONB` — avoids 11 separate nullable columns for features; typed at the TypeScript layer via `N3CandidateScoreFeatures` and `N3ZoneBoost[]`.
- `N3LineItem.descriptionTokens`, `specialFlags`, `retrievalSources` — `TEXT[]` — native Postgres array columns for token overlap and flag queries without JSON overhead.
- `N3LineItem` has no `embeddingVector` column yet — pgvector extension column will be added in Phase 11 migration (`vector(1536)`).

#### Housekeeping performed

Pre-existing schema drift: migration `20260503_add_awaiting_match_review_status` had been applied to the DB directly but was not recorded in `_prisma_migrations`. Resolved with:
```bash
npx prisma migrate resolve --applied 20260503_add_awaiting_match_review_status
```
Then `20260512000000_n3_foundation` applied cleanly.

---

## Phase 2 — N3 Routing Gate + Inngest Scaffold

**Completed:** May 8, 2026  
**Lint:** 0 errors, 0 warnings  
**Spec reference:** N3.md §B.1 Phase 2 row

### Files Created

#### `estimatch-app/lib/n3/n3-routing.ts`

Mirrors `lib/n2/n2-routing.ts` exactly. Disabled by default — requires `N3_ENABLED=true` to activate.

| Export | Type | Description |
|--------|------|-------------|
| `isN3Enabled()` | `() → boolean` | Returns `process.env.N3_ENABLED === 'true'` |
| `isN3Eligible(comparisonId)` | `async (string) → boolean` | Phase 2: delegates to `isN3Enabled()`. Reserved for per-comparison logic. |
| `N3ProcessRequestedEvent` | type | Inngest event payload for `'comparison/process-v3.requested'` |

#### `estimatch-app/lib/n3/inngest/process-comparison-v3.ts`

16-step durable Inngest function. All phase steps are stubs that log and return immediately. Wiring begins at Phase 4.

**Vercel / Inngest constraints respected:**
- Each `step.run()` is a single Vercel Lambda invocation (route `maxDuration = 300s`)
- Step outputs are tiny status objects — no data payloads (4 MB limit respected)
- `concurrency: { key: 'event.data.comparisonId', limit: 1 }` — prevents concurrent retries corrupting n3_* rows
- `mark-failed` step inside `catch` — surfaces FAILED to the UI polling loop after retry exhaustion
- 3 retries (`RETRY_COUNT = 3`)

**Zone review gates (Phase 5, 7):** Currently `step.run()` stubs that auto-proceed. Will be replaced with `step.waitForEvent('comparison/n3-zone-review.completed', { timeout: '24h', match: 'data.comparisonId' })` when Phase 5/7 UI is built. Skip intent documented via `N3_SKIP_ZONE_VERIFICATION` env var.

| Step name | Phase | Status | Notes |
|-----------|-------|--------|-------|
| `check-already-terminal` | — | Real logic | Idempotency guard, same as N2 |
| `store-run-id` | — | Real logic | Writes `pipelineVersion='n3'`, flips `PROCESSING` |
| `p4-detect-zones` | 4 | **Stub** | TODO: read PDFs, write N3Zone rows |
| `p5-zone-review-gate` | 5 | **Stub** | TODO: replace with `step.waitForEvent` |
| `p6-propose-correspondences` | 6 | **Stub** | TODO: AI correspondence proposal → N3ZoneCorrespondence rows |
| `p7-correspondence-gate` | 7 | **Stub** | TODO: replace with `step.waitForEvent` |
| `p8-extract-line-items` | 8 | **Stub** | TODO: per-zone extraction → N3LineItem rows |
| `p9-normalize-line-items` | 9 | **Stub** | TODO: wire `normalizeDescription`, `parseAmount`, etc. |
| `p10-extraction-validation` | 10 | **Stub** | TODO: write N3ExtractionWarning rows |
| `p11-generate-embeddings` | 11 | **Stub** | TODO: OpenAI text-embedding-3-small + pgvector migration |
| `p12-generate-candidates` | 12 | **Stub** | TODO: 9 retrieval sources → N3CandidateEdge rows |
| `p13-score-candidates` | 13 | **Stub** | TODO: `computeRawScore` + zone boosts + `shouldRejectEdge` |
| `p14-build-components` | 14 | **Stub** | TODO: BFS/union-find → N3MatchComponent rows |
| `p15-assign-matches` | 15 | **Stub** | TODO: Hungarian/greedy → N3MatchDecision rows |
| `p16-group-matching` | 16 | **Stub** | TODO: one-to-many combos → grouped decisions |
| `p17-llm-adjudication` | 17 | **Stub** | TODO: Claude Sonnet for ambiguous components |
| `p18-persist-decisions` | 18 | **Stub** | TODO: project decisions → LineItem rows, flip COMPLETED |

### Files Updated

#### `estimatch-app/app/api/inngest/route.ts`

Added `processComparisonV3` to the `serve()` functions array. All three pipeline functions (N1, N2, N3) are now registered under the single `estimatch-app` Inngest App ID.

---

## Phase 3 — Accuracy Runner Flat Mode

**Completed:** May 8, 2026  
**Spec reference:** N3.md §B.1 Phase 3 row

### Purpose

Provides an honest N3 baseline before any pipeline code is wired. Uses a JS port of the N3 normalization primitives to pair contractor vs adjuster items purely from cheatsheet description text and amount data (2 of 11 N3 scoring features). The recall number establishes a floor that N3 Phase 18 must exceed.

### Usage

```bash
# All sets
node runner.js --mode flat

# Single set
node runner.js --mode flat --set Set3

# Multiple sets
node runner.js --mode flat --set Set4,Set5,Set6
```

No browser, no auth, no running app required.

### Files Created

#### `Accuracy Runner/lib/flat-compare.js`

Self-contained N3 normalization port + pairing algorithm.

**N3 primitives ported (JS):**
- `normalizeDescription(s)` — lowercase → abbrev expand → strip non-alphanum → collapse spaces
- `tokenize(normalizedDesc)` — split, filter stopwords + length < 2
- `jaccardSimilarity(a, b)` — set-based, dedup, both-empty → 1.0
- `amountSimilarity(a, b)` — step function identical to TS source

**Flat scoring formula:** `flatScore = 0.667 × jaccardSim + 0.333 × amountSim`
- Weights are N3's `descriptionFuzzySimilarity` (0.20) and `totalSimilarity` (0.10) normalized to sum to 1.0
- Pairing threshold: `FLAT_SCORE_THRESHOLD = 0.15`

**Algorithm:**
1. Flatten all cheatsheet items to a yours pool (has `contractorDesc`) and adjuster pool (has `adjusterDesc`)
2. Compute all M×N pairwise flat scores
3. Greedy assignment: sort descending, assign highest-scoring unmatched pairs ≥ threshold
4. Ground truth = items where both sides have descriptions AND status is `match` or `modified`
5. Compute precision, recall, F1 vs ground truth

**Exports:** `flatCompare(cheatsheet)`, `printFlatSummary(result)`, `printFlatAggregateSummary(results)`, `writeFlatReport(results, dir)`

### Files Updated

#### `Accuracy Runner/runner.js`

Added `--mode flat` flag. In flat mode the Playwright browser is never launched; the function returns before the auth check. Full mode unchanged.

### Baseline Results (May 8, 2026)

Run across all 13 discovered sets. Sets B–E have 0 ground-truth pairs (all-MISSING/ADDED cheatsheets) and are excluded from analysis.

| Set | GT pairs | TP | Precision | Recall | F1 |
|-----|----------|----|-----------|--------|----|
| Set1 | — | — | — | — | — |
| Set2 | — | — | — | — | — |
| Set3 | 71 | 71 | 99% | 100% | 99% |
| Set4 | 81 | 66 | 94% | 81% | 87% |
| Set5 | 81 | 68 | 92% | 84% | 88% |
| Set6 | 163 | 133 | 92% | 82% | 86% |
| Set7 | 162 | 158 | 96% | 98% | 97% |
| Set8 | 635 | 631 | 99% | 99% | 99% |
| Set9 | 233 | 233 | 100% | 100% | 100% |
| **Total** | **1971** | **1864** | — | **~94%** | — |

**Key finding:** With only description Jaccard + amount similarity (2/11 features), the algorithm already finds 94% of ground-truth pairs. The 6% misses are concentrated in sets where vocabulary diverges significantly (e.g., `"semi-custom"` vs `"custom"` cabinetry, `"LGR dehumidifier daily rate"` vs `"Drying chamber - LGR dehumidifier per day"`). These are precisely the cases the embedding feature (Phase 11) and trade/action parsing (Phase 9) are designed to fix.

**N3 Phase 18 target:** recall ≥ 95%, precision ≥ 90% (both achievable with the remaining 9 features).

---

## Phase 4 — Zone Detection

**Completed:** May 8, 2026  
**Lint:** 0 errors, 0 warnings  
**Tests:** 220/220 passing (no regressions)

### Files Created

#### `estimatch-app/lib/n3/passes/detect-zones.ts`

Full zone detection orchestrator. Algorithm is identical to N2's `detect-zones.ts`; the output target is the key difference (DB table vs JSON blob).

**N2 code reused directly (no duplication of logic):**
- `buildChunks` / `PdfChunk` — `lib/n2/utils/chunk-pdf.ts`
- `loadPdf` / `slicePages` — `lib/n2/utils/pdf-slicer.ts`
- `withRetry` / `AIResponseError` / `parseAndValidate` / `isTruncated` — `lib/n2/utils/ai-response.ts`
- `mergeChunkZones` / `preDeduplicateZones` / `synthesizeGeneralZone` — `lib/n2/utils/zone-merge.ts`
- Pass 1 chunk 1/N prompts — `lib/n2/prompts/pass1-chunk1.ts` / `pass1-chunk-n.ts`
- `Pass1Chunk1ResponseSchema` / `Pass2ChunkNResponseSchema` — `lib/n2/schemas/pass-responses.ts`

**N3-specific additions:**
- `normalizedName`: `normalizeDescription(name)` from `lib/n3/normalization.ts`
- `source`: `'yours' | 'adjuster'` (N3 asymmetric side identity)
- `verificationStatus`: `'ai_proposed'` — will be changed by Phase 5 UI gate
- Output target: `prisma.n3Zone.createMany()` to `n3_zones` table
- Idempotency: `prisma.n3Zone.deleteMany({ where: { comparisonId } })` in the same transaction before `createMany` — retries are clean

**Model:** `claude-sonnet-4-5` (Sonnet, not Haiku)

**Concurrency:** `CONCURRENT_CHUNK_CALLS = 5` — same cap as N2 to stay within Anthropic rate limits

**Flat-list fallback:** if either side detects < 2 zones, `synthesizeGeneralZone` writes a single `General` zone spanning the full document (same behaviour as N2)

**Return type:** `DetectZonesN3Result` — `{ yoursZoneCount, adjusterZoneCount, yoursFlat, adjusterFlat, yoursFormat, adjusterFormat }`

### Live Test Results (May 8, 2026)

Fired against comparison `a040af8b-2986-4b64-b20b-8fd5654ff306` via Inngest dev dashboard:

| Side | Pages | Chunks | Zones detected | Format |
|------|-------|--------|----------------|--------|
| yours (contractor) | 7 | 1 | **7** | `xactimate` |
| adjuster | 4 | 1 | **5** | `unknown` |

12 rows written to `n3_zones`. Adjuster format `unknown` is expected on short non-Xactimate PDFs — zones were still detected correctly. Idempotency guard correctly blocked re-runs without `force: true`.

### Files Updated

#### `estimatch-app/lib/n3/inngest/process-comparison-v3.ts`

Imported `detectZonesN3` and replaced the `p4-detect-zones` stub with a real call. The step existence-checks the comparison row first (guard against deletion mid-run), then delegates to `detectZonesN3`. The step return value includes the full `DetectZonesN3Result` so the Inngest dashboard shows zone counts per run.

---

## Phase 6 — Zone Correspondence Proposal

**Completed:** May 8, 2026  
**Lint:** 0 errors, 0 warnings  
**Tests:** 220/220 passing (no regressions)

### Files Created

#### `estimatch-app/lib/n3/prompts/zone-correspondence.ts`

Builds the Sonnet system + user prompt for zone correspondence proposal. Zones are presented as short-key lists (`Y1`–`Yn`, `A1`–`Am`) so the model has unambiguous references. Prompt handles:
- Room-grouped contractor vs trade-grouped adjuster (many-to-one pattern)
- `one_to_one`, `one_to_many`, `many_to_one` types
- Confidence scoring (0–1)
- Explicit `unmatchedYours` / `unmatchedAdjuster` lists

#### `estimatch-app/lib/n3/passes/propose-correspondences.ts`

| Property | Value |
|----------|-------|
| Model | `claude-sonnet-4-5` |
| Max tokens | 1500 |
| Retries | 3 (via `withRetry`) |
| Idempotency | `deleteMany` + sequential `create` per correspondence in a Prisma transaction |
| Output | `N3ZoneCorrespondence` rows with `verificationStatus='ai_proposed'` and model-returned confidence |
| Schema validation | Zod — key format (`/^Y\d+$/`, `/^A\d+$/`), type enum, confidence range |

**Reuses from N2:** `withRetry`, `AIResponseError`, `parseAndValidate`, `isTruncated` from `lib/n2/utils/ai-response.ts`.

**DB write:** Uses Prisma nested `connect` on the implicit many-to-many join tables (`_YourZoneCorrespondences`, `_AdjusterZoneCorrespondences`).

### Live Test Results (May 8, 2026)

Fired against comparison `a040af8b-2986-4b64-b20b-8fd5654ff306` (7 yours zones / 5 adjuster zones):

| Metric | Value |
|--------|-------|
| Correspondences proposed | **7** |
| Unmatched yours | 0 |
| Unmatched adjuster | 0 |
| Rows written to `n3_zone_correspondences` | **7** |
| p6 step duration | ~7s |

All 12 zones were paired. 0 unmatched is expected for this small clean document. Larger trade-grouped adjuster PDFs will produce many-to-one patterns with some unmatched contractor zones.

### Files Updated

#### `estimatch-app/lib/n3/inngest/process-comparison-v3.ts`

Imported `proposeCorrespondencesN3` and replaced the `p6-propose-correspondences` stub.

---

## What Is Not Yet Built

Phases 8–18 are all complete. The following remain pending:

| Phase / Item | Deliverable | Key dependencies |
|---|---|---|
| **5** | Zone verification UI (gate currently auto-proceeds) | Phase 4 zones in DB |
| **7** | Zone correspondence verification UI (gate currently auto-proceeds) | Phase 6 |
| **10** | Extraction validation + `N3ExtractionWarning` rows | Phase 9 |
| **19** | `pipelineVersion = 'n3'` routing gate (production cutover) | Phase 18 verified end-to-end |
| **20** | LLM telemetry dashboard (`/app/n3-dashboard/[id]`) | Phase 17; see `N3_VERIFICATION_DASHBOARD.md` |
| **21** | Group matching UI (flat-with-link badge) | Phase 18 |
| **V2/V3 validation** | Run pipeline against V2 and V3 verified-set PDFs to confirm generalization | V1 confirmed ✅ |
| **Closet pair fix** | Master Bedroom: walk-in closet organizer incorrectly paired with wire shelving. Root cause: semantic similarity between "closet organizer system" and "wire shelving system" overcomes total-similarity signal (12:1 ratio). Fix: probe scores for these items; likely requires raising `totalSimilarity` weight or adding a per-item total-ratio hard guard for 10:1+ divergence. |

---

## Diagnostic Scripts

Scripts in `estimatch-app/scripts/` for pipeline inspection and verification. All use the same Prisma + SSL pg.Pool pattern as `lib/prisma.ts`. Run via `npx tsx scripts/<name>.ts`.

| Script | Purpose | Key arg |
|--------|---------|---------|
| `run-v1-n3.ts` | Upload V1 PDFs → Supabase, create Comparison row, fire `comparison/process-v3.requested` Inngest event | hardcoded V1 file paths |
| `check-comparison.ts` | Print status, metrics, and zone names for a comparison | `COMPARISON_ID` env var |
| `dump-results.ts` | Full line-item dump grouped by zone: status, descriptions, totals, diffs | `COMPARISON_ID` env var |
| `dashboard.ts` | Multi-phase N3 diagnostic dashboard: zone counts, candidate edge stats, decision breakdown, LLM telemetry | `COMPARISON_ID` env var |
| `probe-scores.ts` | Targeted edge/decision probe for specific items (carpet pad, ALE, etc.) | `COMPARISON_ID` env var |
| `probe-errors.ts` | Probe specific known-error pairs (kitchen drywall walls, countertop, carpet pad) by lookup → edges → decisions | `COMPARISON_ID` env var |

**Usage pattern** (safe to auto-run — read-only DB):
```bash
COMPARISON_ID=29811a19-5070-430f-a1ea-f513bd753040 npx tsx scripts/check-comparison.ts
COMPARISON_ID=29811a19-5070-430f-a1ea-f513bd753040 npx tsx scripts/dump-results.ts
```

---

## V1 Verified Set — End-to-End Validation Results

**Run date:** May 9, 2026  
**Comparison ID:** `29811a19-5070-430f-a1ea-f513bd753040`  
**Verified set:** `PDFS/Generated Sets/Verified Sets/V1/` — Water Damage, Burst Supply Line, Tampa FL Condo  
**Cheatsheet:** `V1_Cheatsheet.md`

### Summary Metrics

| Metric | Expected | Actual | ✓ |
|--------|----------|--------|---|
| MATCH | 36 | 36 | ✅ |
| MODIFIED | 9 | 9 | ✅ |
| MISSING_FROM_ADJUSTER | 5 | 5 | ✅ |
| ADDED_BY_ADJUSTER | 2 | 2 | ✅ |
| Contractor total | $45,905.62 | $45,905.62 | ✅ |
| Adjuster total | $36,510.72 | $36,510.72 | ✅ |
| Total gap | $9,394.90 | $9,394.90 | ✅ |
| Zone pairings | 5/5 | 5/5 | ✅ |
| Correct line-item pairs | 54/54 expected | **53/54** | ⚠️ |

### Zone-by-Zone Pair Accuracy

| Zone pair | Expected items | Pipeline items | Correct pairs | Notes |
|---|---|---|---|---|
| General Conditions / Project General Conditions | 6 | 6 | 6/6 | ✅ |
| Kitchen / Kitchen | 11 | 11 | 11/11 | ✅ |
| Hall Bathroom / Secondary Bathroom | 8 | 8 | 8/8 | ✅ |
| Living & Dining Room / Main Living Area | 15 | 15 | 15/15 | ✅ |
| Master Bedroom / Primary Bedroom Suite | 12 | 12 | **11/12** | ⚠️ closet swap |

### Known Composition Error — Master Bedroom Closet Swap

| Item | Expected | Actual |
|------|----------|--------|
| "Closet wire shelving — ventilated, per LF" ($244.80) | MOD-QTY ↔ "Wire shelving system — closet" ($183.60) | **MISSING** ❌ |
| "Walk-in closet organizer system — standard" ($2,220) | MISSING | **MODIFIED** ↔ Wire shelving ($183.60) ❌ |

**Root cause:** LLM semantic similarity between "walk-in closet organizer system" and "wire shelving system — closet" (both share "system" and "closet") scores higher than "closet wire shelving — ventilated" ↔ "wire shelving system — closet" despite the organizer having a 12:1 total ratio ($2,220/$183.60 vs $244.80/$183.60 ≈ 0.75). Hungarian optimization selects the semantically-inflated pair.

**Dollar impact:** Total gap is preserved ($2,036.40 + $244.80 = $61.20 + $2,220 = $2,281.20) but the per-item breakdown is misleading — a $61 MOD-QTY is displayed as a $2,036 MODIFIED, and the walk-in closet organizer appears as a small missing item instead of a large one.

**Fix target:** Probe closet item edge scores; consider raising `totalSimilarity` weight or adding a hard rejection guard when total ratio > 8:1 and `descriptionFuzzySimilarity` < 0.6.

---

## Potential Algorithm Improvements

This section tracks known limitations in the current implementation that are worth revisiting once the full matching pipeline is running and accuracy can be measured. Items are not prioritized — measure first, then decide.

---

### 1. AI-Powered Trade / Action / Special Flag Classification (Phase 9)

**Current behavior:** `trade`, `action`, and `specialFlags` are populated by a hardcoded static keyword list in `lib/n3/passes/normalize-line-items.ts`. The list is fixed at build time and never changes. On the first live test (149 items), coverage was:

- `withTrade`: 94/149 (63%) — 55 items unclassified
- `withAction`: 78/149 (52%) — 71 items unclassified
- `withSpecialFlags`: 8/149 (5%) — expected to be low

**The problem:** Descriptions outside the keyword list (e.g. `"Applied microbial solution to affected areas"`, `"Content manipulation - per hour"`, `"LGR Dehumidifier - per day"`) return `null` for trade and action. In Phase 13, those features simply score 0 rather than contributing positive signal. If these items are commonly mismatched, null classification is a silent accuracy leak.

**Potential fix — Option A: Expand the keyword list**
Audit unclassified items across all 9 test sets, extract common patterns, and add them to the static map. Zero cost, deterministic. Likely gets coverage to ~85%.

**Potential fix — Option B: AI classification pass**
Add a Sonnet call during Phase 9 that batches ~20 descriptions per call and returns `{ trade, action, specialFlags }` per item. Cost: ~8 calls per comparison (negligible). Coverage: ~98%. Could be added to the existing Phase 8 extraction prompt as an additional output field to eliminate a separate API round-trip.

**Potential fix — Option C: Hybrid**
Keep the static list as a fast first pass. Only call AI for items where the static list returned `null`. Minimizes token cost while covering the long tail.

**When to act:** After Phase 15 (assignment) is running and we have a measurable accuracy number. If null-trade items correlate with mismatches, implement Option B or C. If accuracy is already at target, skip.

---

### 2. Extraction Validation Warnings (Phase 10)

**Current behavior:** Phase 10 is a stub — it logs and immediately passes through. No `N3ExtractionWarning` rows are ever written.

**What is missing:** After Phase 9 normalization, the pipeline should scan all `n3_line_items` for data quality red flags and write warning rows to alert the user before matching begins. Specific checks that should run:

- Zone extracted 0 items (entire zone missed by Phase 8)
- Large delta between Phase 4's `approxItems` estimate and Phase 8's actual count (e.g., Phase 4 estimated 12 items, Phase 8 extracted 3 — likely missed items)
- Item has no `totalAmount` (possible extraction failure on that row)
- Duplicate `sourceLineNumber` within the same zone (possible hallucination)
- `normalizedQuantity` is unrealistically large (e.g., > 50,000 — likely OCR garbage)

**When to act:** After Phase 18 is running and the UI is being built. This powers a warning banner in the comparison UI surface ("2 items may have been missed in Kitchen"). Not an accuracy blocker — a trust and transparency feature.

---

### 3. Semantic Embeddings for Candidate Retrieval (Phase 11)

**Current behavior:** Phase 11 is a stub — pgvector migration not applied, no embeddings generated. Phase 12 currently operates without the semantic retrieval source.

**What is missing:** Each `n3_line_items.normalizedDescription` should be encoded as a dense vector and stored in a `vector(N)` column. Phase 12 would then use cosine similarity ANN search to find semantically close items across the two sides — catching cases where descriptions are paraphrased differently (e.g., `"Remove and replace gypsum board"` vs `"R&R Drywall"`).

**Why Claude Sonnet cannot be used:** Claude is a text generation model, not an embedding model. Anthropic does not offer an embeddings API. Options:

- **Voyage AI** — Anthropic's recommended embedding partner (acquired by Anthropic). Optimized for use alongside Claude. Requires a Voyage API key.
- **OpenAI `text-embedding-3-small`** — Industry standard, cheap (~$0.00002/1K tokens), fast. Requires an OpenAI API key.
- **Skip entirely** — Phase 12 has 5 non-embedding retrieval sources that function without vectors. Benchmark accuracy first; add embeddings only if the gap is significant.

**Infrastructure required:** A Prisma migration to add `vector(1536)` column to `n3_line_items` (requires pgvector extension enabled on Supabase — available on Pro plan).

**When to act:** After Phase 15 produces a first accuracy benchmark. If semantic paraphrasing mismatches are a top error category, implement with Voyage AI or OpenAI.

---

### 4. ⚠️ SCALE FAILURE — pgvector Brute-Force Retrieval (Phase 12 / generate-candidates.ts)

**Current behavior:** `lib/n3/passes/generate-candidates.ts` retrieves semantic candidates via a raw `CROSS JOIN` that computes cosine distance between every yours-item and every adjuster-item in the comparison. There is no HNSW or IVFFlat index on the `embedding` column.

**The problem:** Query cost is **O(n × m)** where n and m are the item counts on each side. At small test sizes this is unnoticeable, but:

- 100 × 100 items → 10,000 distance computations
- 500 × 500 items → 250,000 distance computations
- 1,000 × 1,000 items → 1,000,000 distance computations (multi-second sequential scan)

PostgreSQL must read every embedding row from disk on every comparison. Without an approximate nearest-neighbor index, Phase 12 becomes the pipeline bottleneck at any estimate size above ~200 items per side.

**When it fails hard:** Any comparison involving large commercial or restoration estimates (500+ line items per side). Phase 12 will time out or lock the database under concurrent load.

**Deferred fix:** Add an HNSW index via Prisma migration: `CREATE INDEX ON n3_line_items USING hnsw (embedding vector_cosine_ops);`. Requires pgvector ≥ 0.5.0.

---

### 5. ⚠️ SCALE FAILURE — Voyage AI Partial Response Crash (Phase 11 / generate-embeddings.ts)

**Current behavior:** `lib/n3/passes/generate-embeddings.ts` calls the Voyage AI batch embedding endpoint and maps the returned `data` array back to items by index position (i.e., `data[0]` → item 0, `data[1]` → item 1, etc.).

**The problem:** Voyage AI's API does not guarantee that a partial-failure batch returns vectors for every input. If the API returns fewer vectors than items sent (due to a rate limit, a content filter, or a transient error on any single item), the index mapping silently misaligns: item N receives item N+1's embedding. This produces incorrect cosine scores with no error or warning in the logs.

**Failure mode:** Silent — the pipeline continues, embeddings are stored, and Phase 12 retrieves plausible-but-wrong candidates. Accuracy degrades without any observable error.

**Approximate scale trigger:** Voyage AI batch endpoint has an input limit of ~128 texts per request. The current code batches in chunks. Any single chunk where one item is rejected by the API will corrupt the embedding alignment for that entire chunk.

**Deferred fix:** After receiving each batch response, validate `data.length === chunk.length` and that each `data[i].index` matches the expected position before writing. Reject and re-queue any chunk that fails this check.

---

### 6. ⚠️ SCALE FAILURE — PostgreSQL Bind Parameter Limit in Batch Inserts (Phase 18 / persist-decisions.ts)

**Current behavior:** `lib/n3/passes/persist-decisions.ts` uses Prisma `createMany` to bulk-insert `N3MatchDecision` rows inside a transaction. Prisma compiles `createMany` into a single parameterized SQL statement with one bind parameter per field per row.

**The problem:** PostgreSQL enforces a hard limit of **65,535 bind parameters** per statement. Each `N3MatchDecision` row has approximately 80 fields. This means:

- Safe limit: **~819 decisions per `createMany` call** (65,535 ÷ 80 ≈ 819)
- A comparison with 900+ match decisions will throw `ERROR: too many parameters` and the entire Phase 18 transaction will roll back.

**Practical impact:** A comparison with ~410 line items per side could produce up to ~820 match decisions — already at the boundary. Any commercial estimate exceeding ~400 items per side is at risk of a complete Phase 18 failure with no partial save.

**When it fails hard:** Estimates with more than ~820 total match decisions (roughly 410+ items per side). The transaction rolls back, no decisions are persisted, and the comparison is left in an incomplete state.

**Deferred fix:** Chunk the `createMany` payload into batches of ≤800 rows before insertion. Alternatively, switch to a raw `INSERT ... VALUES` with unnested arrays to sidestep the parameter limit entirely.

---

## Test Coverage Status

| Suite | File | Tests | Status |
|-------|------|-------|--------|
| N3 normalization | `__tests__/n3/normalization.test.ts` | 128 | ✅ All passing |
| N2 zone merge | `__tests__/n2/zone-merge.test.ts` | — | ✅ Unaffected |
| N2 AI response | `__tests__/n2/ai-response.test.ts` | — | ✅ Unaffected |
| N2 chunk PDF | `__tests__/n2/chunk-pdf.test.ts` | — | ✅ Unaffected |
| N2 match zones parse | `__tests__/n2/match-zones-parse.test.ts` | — | ✅ Unaffected |
| N2 API match review | `__tests__/n2/api-match-review.test.ts` | — | ✅ Unaffected |
| **Total** | | **220** | **✅ 6/6 files passing** |
