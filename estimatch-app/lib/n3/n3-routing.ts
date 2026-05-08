// ─────────────────────────────────────────────────────────────────────────────
// N3 Pipeline — routing gate and eligibility check
//
// Controls which comparisons are processed by N3. N1 remains the production
// pipeline until N3 is fully validated end-to-end.
//
// Mirrors lib/n2/n2-routing.ts structure exactly. N3 is DISABLED by default
// — requires `N3_ENABLED=true` in the environment to activate.
//
// Rollout plan (after Phase 18 is complete + accuracy gate passes):
//   Phase A dev:   N3_ENABLED=true in staging, isN3Eligible returns true for all
//   Phase B prod:  percentage rollout or per-user opt-in flag (extend here)
//   Phase C prod:  isN3Eligible always returns true — retire N1/N2
//   Retirement:    remove routing entirely, delete this file
//
// Usage in comparison creation route:
//   if (await isN3Eligible(comparisonId)) {
//     await inngest.send({ name: 'comparison/process-v3.requested',
//       data: { comparisonId, trigger: 'create-route' } });
//   } else {
//     // fall through to N1 (or N2 if restored)
//   }
// ─────────────────────────────────────────────────────────────────────────────

// ── Env gate ──────────────────────────────────────────────────────────────────

/**
 * Returns true if N3 processing is enabled via environment variable.
 * Must be `N3_ENABLED=true` (exact string) — any other value is false.
 *
 * Safe to call on both server and edge runtimes.
 */
export function isN3Enabled(): boolean {
  return process.env.N3_ENABLED === 'true';
}

// ── Eligibility check ─────────────────────────────────────────────────────────

/**
 * Returns true if this comparison should be processed by N3.
 *
 * Phase 2 implementation: purely gates on `N3_ENABLED` env var.
 * Future phases will extend with percentage rollout, per-user opt-in,
 * or format-detection gating (Xactimate-only for V1).
 *
 * @param _comparisonId  Reserved for future per-comparison eligibility logic
 */
export async function isN3Eligible(comparisonId: string): Promise<boolean> {
  void comparisonId;
  return isN3Enabled();
}

// ── Event payload type ────────────────────────────────────────────────────────

/**
 * Inngest event fired to trigger N3 pipeline processing.
 * Uses a distinct event name so N1, N2, and N3 never cross-trigger.
 */
export type N3ProcessRequestedEvent = {
  name: 'comparison/process-v3.requested';
  data: {
    comparisonId: string;
    trigger: 'create-route' | 'manual-route' | 'replay';
    /**
     * If true, re-run even if comparison is already COMPLETED/FAILED.
     * Use with caution — will overwrite existing LineItems.
     */
    force?: boolean;
  };
};
