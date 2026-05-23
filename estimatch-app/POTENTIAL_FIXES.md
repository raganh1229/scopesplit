# Potential Fixes — Large Component Matching Failures

## Context
On Set18 (704 items, single large component), 4 "Content manipulation / Move and reset" pairs were mislabeled as MISSING+ADDED instead of MOD-QTY. Dollar gap was still 100% correct. Root cause: greedy algorithm in P15 is zone-blind.

---

## Option 1 — Zone-Affinity Score Boost (P13)
Add a `zoneCorrrespondenceBoost` feature to the scoring step. If a contractor item and adjuster item belong to confirmed corresponding zones (from P6), apply a small additive boost (e.g. +0.08) to the final score.

- **Pro:** Fixes the root cause directly. Uses already-known data.
- **Con:** Real estimates may have items billed in the wrong zone — cross-zone correct matches would be penalized. Also depends on P6 zone pairing being accurate.

---

## Option 2 — Zone-Affinity Tiebreaker (P15)
In the greedy assignment loop, when two edges have scores within a small threshold of each other (e.g. 0.05), prefer the one where both items share the same zone correspondence.

- **Pro:** Only intervenes when scores are close. Doesn't affect clear-cut matches.
- **Con:** Still zone-dependent. Adds complexity to greedy loop. Threshold tuning required.

---

## Option 3 — Increase MEDIUM_MAX Threshold
Bump the dynamic scaling formula so that 700-item estimates stay in MEDIUM territory and use the near-optimal algorithm instead of greedy.

- **Pro:** Simple change. No new logic. Would have avoided this failure entirely.
- **Con:** Addresses the symptom not the root cause. At some estimate size (1000+ items) greedy will be unavoidable anyway.

---

## Option 4 — Run More Test Sets First (No Change)
The 4 failures are labeling-only — dollar gap was 100% correct. Hold off on any fix until we see this pattern repeat on multiple large estimates.

- **Pro:** No risk of regressions. Safe.
- **Con:** Known gap in decision-label accuracy for 700+ item estimates.
