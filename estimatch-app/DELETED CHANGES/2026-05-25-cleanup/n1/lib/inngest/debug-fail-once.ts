// ─────────────────────────────────────────────────────────────────────────
// Debug-only: one-shot forced stage failure (N1 Phase 8.1 retry test).
//
// The test script `scripts/n1-verify-phase8-retry.ts` drops a sentinel file
// into `scripts/debug-sentinels/fail-once-<stage>.flag`. On the next worker
// invocation, `maybeFailStageOnce(stage)` at the top of that stage's
// `step.run(...)` callback consumes the sentinel and throws. Inngest then
// retries the step; on the retry the sentinel is gone, so the stage runs
// normally. This empirically proves:
//   (1) Inngest's 4-retry policy fires on a thrown step.
//   (2) Step memoization skips previously-successful steps on retry —
//       e.g. injecting a failure in `pair` means the retry does not
//       re-run `extract` or `reconcile-and-prematch` (they stay memoized).
//
// Hard-gated to non-production via `NODE_ENV`. In prod this is a zero-syscall
// no-op. Used exclusively from `lib/inngest/functions/process-comparison.ts`.
// ─────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';

const SENTINEL_DIR = path.join(process.cwd(), 'scripts', 'debug-sentinels');

export function maybeFailStageOnce(stage: string): void {
  if (process.env.NODE_ENV === 'production') return;
  const sentinelPath = path.join(SENTINEL_DIR, `fail-once-${stage}.flag`);
  if (!fs.existsSync(sentinelPath)) return;
  try {
    fs.unlinkSync(sentinelPath);
  } catch {
    /* best-effort; sentinel may have been removed by a concurrent run */
  }
  throw new Error(`[DEBUG-FAIL-ONCE] Forced transient failure in "${stage}" stage.`);
}

/**
 * Debug-only: if a PERSISTENT sentinel file at
 * `scripts/debug-sentinels/fail-always-<stage>.flag` exists, throw every time
 * this stage is entered. The sentinel is NOT consumed — the test script is
 * responsible for deleting it at the end. Used by
 * `scripts/n1-verify-phase8-permanent-failure.ts` to force the Inngest retry
 * budget to be exhausted and verify the worker's `mark-failed` fallback.
 * No-op in production.
 */
export function maybeFailStageAlways(stage: string): void {
  if (process.env.NODE_ENV === 'production') return;
  const sentinelPath = path.join(SENTINEL_DIR, `fail-always-${stage}.flag`);
  if (!fs.existsSync(sentinelPath)) return;
  throw new Error(`[DEBUG-FAIL-ALWAYS] Forced unrecoverable failure in "${stage}" stage.`);
}
