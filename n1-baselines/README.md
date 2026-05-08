# N1 Inngest Conversion — Baselines

This directory holds JSON snapshots of COMPLETED comparisons captured **before** the N1 Inngest conversion begins. They are the ground truth for verifying that the refactor preserves behavior.

## DO NOT MODIFY

These files are immutable references. Any change here invalidates the verification process.

## Filename Convention

`<label>--<comparisonId>.json`

- `<label>` — short kebab-case tag identifying the scenario, e.g. `small-residential`, `medium-multi-zone`, `large-commercial`
- `<comparisonId>` — the UUID of the original comparison in the dev DB

## How to Regenerate Baselines

From `estimatch-app/`:

```bash
# 1. List COMPLETED comparisons to choose from:
npx tsx scripts/n1-list-baseline-candidates.ts

# 2. Capture each:
npx tsx scripts/n1-capture-baseline.ts <comparisonId> <label>
```

## How to Verify a Refactor Against a Baseline

After a refactor phase, re-process the same PDF pair as a new comparison, then:

1. Capture the new comparison's output using the same script (to a different label, e.g. `post-phase-3--<id>.json`).
2. Diff the two JSON files, focusing on:
   - **Aggregates**: `matchCount`, `modifiedCount`, `missingCount`, `addedCount`, `yourEstimateTotal`, `adjusterEstimateTotal`, `totalGap` — these must match exactly.
   - **Line items**: deterministic fields (`zoneCanonical`, `matchStatus`, cost columns for items paired by the deterministic prematcher) should match exactly. Fields derived from Claude responses may vary slightly due to LLM stochasticity.
3. Any material divergence = stop and investigate before proceeding.

See `../N1_INNGEST_CONVERSION.md` §1 (Non-Negotiable Invariant) and §3 (Phase Plan) for full verification rules per phase.
