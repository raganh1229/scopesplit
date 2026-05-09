# N3 Verification Dashboard — Architecture

**Purpose:** A diagnostic surface for the N3 matching pipeline. Surfaces, at every phase, *what happened, why, and what to tune*. This is **not a customer-facing artifact** — it is an internal debugging instrument used to:

1. Confirm each phase produced sane output before promoting N3 to production.
2. Identify which features/sources are pulling weight and which are dead.
3. Calibrate score weights and thresholds against real data.
4. Detect regressions when prompts or weights change.
5. Build intuition for where the pipeline fails on edge cases.

**Status:** Design document. Build target.
**Read this with:** `N3.md` (spec) and `N3_BUILD_LEDGER.md` (current state).

---

## Why This Exists

The N3 pipeline has 18 phases, ~11 scoring features, 9 retrieval sources, 5 LLM calls, and produces a single number (`finalScore`) per edge that flows into Hungarian → decisions → line items. When something goes wrong — a missed match, a wrong assignment, an over-confident score — there is currently **no way to introspect** which phase or feature was responsible without manually querying Supabase tables.

This dashboard makes the entire pipeline observable in one screen.

---

## Design Principles

- **Zero new schema.** All metrics are computed on-demand from the existing `n3_*` tables. No migrations. No additional writes during the pipeline. The dashboard is purely a *read-side* projection.
- **Information density over polish.** This is a debug tool. Tables, histograms, and raw numbers — not pretty charts.
- **Phase-by-phase narrative.** The dashboard reads top-to-bottom in pipeline order, telling the story of one comparison run.
- **Always-available.** Works for any comparison that completed N3, not just the most recent.
- **Drill-down ready.** Headline metrics → per-phase tables → per-edge / per-decision detail.

---

## Surfaces

```
GET /api/n3/dashboard/[comparisonId]   → JSON metrics blob (all phases)
GET /app/n3-dashboard/[comparisonId]   → Rendered debug page
```

The comparison page (`/app/comparison/[id]`) gets a "View N3 Dashboard" link visible whenever N3 metrics are available.

---

## Per-Phase Metrics

The dashboard surfaces specific metrics per phase. Each section answers two questions:

1. **Did this phase produce sane output?** (a few headline numbers)
2. **What can I tune here?** (deeper breakdown for calibration)

### Phase 4 — Zone Detection (`detect-zones`)

Headline:
- Yours zone count, adj zone count
- Detected format per side (xactimate / unknown / etc.)
- Total page coverage (zones span pages 1–N?)

Diagnostics:
- Zones with `approxItems = 0` (suspicious — empty zone?)
- Zones spanning > 3 pages (likely too coarse)
- Singleton "flat" detection (one zone covering all pages — sign of failed zone detection)

**Tuning signals:**
- Too few zones → loosen the zone-detection prompt
- Too many tiny zones → tighten the prompt to require minimum item counts

### Phase 6 — Zone Correspondences (`propose-correspondences`)

Headline:
- Correspondence count
- Unmatched yours zones, unmatched adj zones
- Avg confidence

Diagnostics:
- Correspondence type distribution (`one_to_one` / `one_to_many` / `many_to_one`)
- Per-correspondence confidence histogram
- Zones that are unmatched on both sides (red flag for missed correspondences)

**Tuning signals:**
- Many unmatched zones with similar names → prompt is too strict
- Low average confidence (<0.7) → AI is uncertain; prompt may need examples

### Phase 8 — Line Item Extraction (`extract-line-items`)

Headline:
- Yours item count, adj item count, total
- Items per zone (min, median, max)
- Avg extraction confidence

Diagnostics:
- Items with no `totalAmount` (extraction missed money)
- Items with no `normalizedQuantity` (extraction missed qty)
- Items with `extractionConfidence < 0.7` (low confidence flags)
- $ total per side (sanity check vs PDF)

**Tuning signals:**
- High null-quantity rate → extraction prompt needs strengthening
- Mismatch between sum-of-items and PDF reported total → subtotal validation needed (Phase 10 work)

### Phase 9 — Normalization (`normalize-line-items`)

Headline:
- % items with quantity, unit, trade, action, special flags

Diagnostics:
- Distinct trades, distinct actions detected
- Most common special flags
- Items with no description tokens (ungramable)

**Tuning signals:**
- Low trade/action coverage → expand `TRADE_PATTERNS` / `ACTION_PATTERNS` in `normalization.ts`
- Few special flags detected → check `SPECIAL_FLAG_PATTERNS`

### Phase 11 — Embeddings (`generate-embeddings`)

Headline:
- Embedded count, batches, model
- Total duration

Diagnostics:
- Items missing embeddings (should be 0)
- Average pairwise cosine across a sample (sanity check — embeddings should not be identical)

**Tuning signals:**
- Skip rate > 0 → embedding generation broken for some items
- Average cosine close to 1.0 → embeddings are not differentiating (model issue)

### Phase 12 — Candidate Generation (`generate-candidates`)

Headline:
- Total edges
- Edges by source (verified_zone, ai_proposed_zone, semantic, fuzzy_description, total_similarity, item_code, trade_action_material, quantity_unit, sequence_nearby)

Diagnostics:
- **Items with 0 candidates** (these CANNOT be matched — pipeline-killer signal)
- Candidates-per-yours-item histogram (1–5, 6–15, 16–30, 31+)
- Candidates-per-adj-item histogram
- Source overlap (edges contributed by 1, 2, 3+ sources after dedup)

**Tuning signals:**
- Items with 0 candidates → loosen retrieval (raise topK, lower thresholds, add sources)
- Highly duplicate edges → sources are redundant; can prune
- One source dominating (>80% of edges) → other sources are ineffective

### Phase 13 — Scoring (`score-candidates`) ⭐ Most Important

Headline:
- Bucket distribution: highConfidence / possibleMatch / weakCandidate / rejected
- Score histogram (10 buckets, 0.0–1.0)
- Survival rate (non-rejected / total)

Diagnostics:
- **Per-feature contribution analysis:**
  - For each of the 11 features: mean, std, min, max
  - Mean score *per feature* in highConfidence bucket vs rejected bucket
  - Variance: features with low variance (std < 0.05) provide little signal — candidates for removal
- **Per-feature weighted contribution** to `rawScore` (mean × weight)
- **Boost contribution:** how often did zone-correspondence boost flip an edge from rejected to weakCandidate?
- **Score deltas around thresholds:**
  - Edges within 0.02 of `REJECT` threshold (borderline — small calibration changes will move them)
  - Edges within 0.02 of `POSSIBLE_MATCH` threshold
  - Edges within 0.02 of `HIGH_CONFIDENCE` threshold

**Tuning signals:**
- Feature mean ≈ 0 across all buckets → feature is broken (always returns 0)
- Feature mean equal in matched and rejected buckets → feature has no discriminative power
- Score histogram is bimodal (0–0.1 and 0.9–1.0 only) → thresholds are wide enough; calibration is healthy
- Score histogram is uniform 0.2–0.5 → features lack discriminative power; need more / better features

### Phase 14 — Components (`build-components`)

Headline:
- Component count
- Size distribution: small / medium / large
- Singletons: yours / adj

Diagnostics:
- Largest component size (Hungarian scaling concern at >250)
- Edge density per component (edges / max_possible_edges)
- Ambiguity per component (multiple yours items connected to multiple adj items)

**Tuning signals:**
- One giant component swallowing everything → REJECT threshold too low; too many edges surviving
- Many singletons → REJECT threshold too high; legitimate edges being killed
- Low edge density per component → graph is sparse; Hungarian will struggle

### Phase 15 — Assignment (`assign-matches`)

Headline:
- Decision counts: matched (one_to_one) / possible / unmatched yours / unmatched adj
- Per-component cost (sum of assigned edge costs)

Diagnostics:
- Score distribution among `one_to_one` decisions
- Score distribution among `possible` decisions
- Number of decisions that were forced (only one option in component) vs competed (multiple candidates)

**Tuning signals:**
- High `possible` count → many weak matches; LLM bill goes up; consider raising `POSSIBLE_MATCH` threshold
- Many forced decisions → graph too sparse; need more candidates

### Phase 16 — Group Matching (`group-matching`)

Headline:
- groupedCount, relinquishedAdj
- Unmatched yours items processed

Diagnostics:
- Best group score per processed item (even if not accepted)
- Why groups were rejected (below threshold vs below margin)

**Tuning signals:**
- Always 0 groups → group threshold too aggressive, OR the test data has no real one_to_many cases
- Many low-margin rejections → margin too tight

### Phase 17 — LLM Adjudication (`llm-adjudication`)

Headline:
- adjudicatedCount, accepted, rejected
- Cost (USD), duration (ms)

Diagnostics:
- **Algorithm vs LLM agreement rate:**
  - For each adjudicated pair, the algo gave a `finalScore`. Did the LLM agree?
  - Confusion matrix: (algo high score, LLM accept) / (algo high score, LLM reject) / (algo low score, LLM accept) / (algo low score, LLM reject)
- **Sample reasoning** for the 3 most-rejected and 3 most-accepted pairs

**Tuning signals:**
- LLM rejects high-score pairs → score weights are over-weighting something LLM doesn't trust
- LLM accepts low-score pairs → algorithm is missing a feature LLM uses (likely material/object semantics — Phase 10 NLP)
- High agreement rate (>90%) → calibration is good; LLM is rubber-stamping

### Phase 18 — Persist Decisions (`persist-decisions`)

Headline:
- Final breakdown: MATCH / MODIFIED / MISSING_FROM_ADJUSTER / ADDED_BY_ADJUSTER / GROUPED
- Total gap, yours total, adj total

Diagnostics:
- Decision provenance: how many came from `auto_high_confidence` / `assignment` / `llm_adjudication` / `group_match`
- Items per zone in final output
- Cost-weighted match rate (% of dollars matched, not just items)

**Tuning signals:**
- Most decisions from `assignment` (Hungarian) → algorithm is doing the work; LLM is fallback
- Most decisions from `llm_adjudication` → algorithm is undecided; calibrate
- Big total gap with most items matching → MODIFIED items hide the dollar discrepancy

---

## Cross-Cutting Sections

Beyond per-phase metrics, the dashboard also includes:

### Pipeline Health Summary

Single-screen status check, shown at top:

| Phase | Status | Headline |
|-------|--------|----------|
| 4  Zones      | 🟢 | 7 yours · 5 adj |
| 6  Corresps   | 🟢 | 7 corresps, 0 unmatched |
| 8  Extract    | 🟢 | 75 + 74 = 149 items |
| 9  Normalize  | 🟢 | 100% qty, 100% unit, 63% trade |
| 11 Embed      | 🟢 | 149/149 embedded |
| 12 Candidates | 🟢 | 3,371 edges, 0 items with no candidates |
| 13 Score      | 🟡 | 1 highConf · 55 possible · 459 weak · 2,856 rejected (REJECT=0.30 pre-cal) |
| 14 Components | 🟢 | 1 medium · 4 small · 0 large · 0 singletons |
| 15 Assign     | 🟢 | 54 matched · 20 possible · 1 unmatched yours |
| 16 Group      | 🟢 | 0 groups (no candidates qualified) |
| 17 LLM        | 🟢 | 17 accept · 3 reject · $0.029 |
| 18 Persist    | 🟢 | 78 line items, gap -$17,963 |

Heuristics for status colors:
- 🟢 green: phase produced expected output and no diagnostic flags fired
- 🟡 yellow: phase succeeded but at least one diagnostic flag fired (e.g. low confidence, threshold borderline cases)
- 🔴 red: phase produced unusable output (e.g. 0 candidates, all rejected, schema validation failures)

### Per-Decision Drill-Down

Optional table at the bottom listing every `N3MatchDecision`, sorted by `finalScore` descending, showing:
- Decision id, type, decided_by
- Yours item description, adj item description (truncated)
- finalScore, top contributing features
- LLM reasoning (if applicable)

This is the table you scan to find "wrong" decisions — high-score MISSING items, low-score MATCH items, etc.

### Score Histogram (text-based bar chart)

```
Score    Count
0.0–0.1  ████████████████████████████ 2,341
0.1–0.2  ████████ 514
0.2–0.3  ███ 187
0.3–0.4  ██ 116
0.4–0.5  █ 87
0.5–0.6  █ 71
0.6–0.7  · 28
0.7–0.8  · 14
0.8–0.9  · 8
0.9–1.0  · 5
```

Renders directly in the page as ASCII for portability.

---

## Implementation Plan

```
lib/n3/metrics/
  types.ts                  Typed shapes for all metrics
  compute-metrics.ts        Main entry: computePipelineMetrics(comparisonId)
  phase-helpers/
    p13-feature-analysis.ts Per-feature distribution and contribution analysis
    p17-llm-agreement.ts    Algorithm-vs-LLM confusion matrix
    histograms.ts           Score histogram builder

app/api/n3/dashboard/[id]/route.ts          GET → JSON metrics blob
app/app/n3-dashboard/[id]/page.tsx          Server component, renders dashboard
app/app/n3-dashboard/[id]/page.module.css   Styles
```

The compute-metrics pipeline runs read-only queries against the existing N3 tables. Total query count is small (10–15) and predictable. For a 3,400-edge comparison the dashboard renders in <500ms.

---

## What This Doesn't Solve

This dashboard tells you *what happened*. It does not:

- **Compare against ground truth** — that requires a labeled correctness dataset and the Phase 3 accuracy runner. The dashboard tells you the pipeline produced 71 matches; only ground truth tells you how many of those 71 are correct.
- **Track changes over time** — historical metric comparison across pipeline runs would require a `n3_metrics_snapshot` table. Future work.
- **A/B test weights** — that's a separate calibration tool that would re-score with alternate weights and compare.

---

## Acceptance Criteria

When this is built and shipped:

- [ ] `/app/n3-dashboard/[id]` renders for any completed N3 comparison
- [ ] All 12 phase sections present and populated
- [ ] Pipeline Health summary table at top with color-coded status
- [ ] Phase 13 feature analysis shows per-feature contribution
- [ ] Phase 17 algo-vs-LLM confusion matrix renders
- [ ] Per-decision drill-down table with at least 50 rows visible
- [ ] Score histogram renders as ASCII bars
- [ ] Comparison page links to N3 dashboard when available
- [ ] Total render time <2 seconds for 150-item comparison
