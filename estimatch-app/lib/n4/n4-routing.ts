// ─────────────────────────────────────────────────────────────────────────────
// N4 Pipeline — routing gate and eligibility check
//
// Controls whether a comparison is routed to N4 (multi-format) instead of N3.
// N3 remains the default; N4 requires USE_N4_PIPELINE=true.
//
// Rollout plan:
//   Phase A dev:   USE_N4_PIPELINE=true in staging, validate against Gate 1
//   Phase B prod:  Enable for specific users/comparisons flagged with
//                  yourEstimateFormat='symbility' OR adjusterEstimateFormat='symbility'
//   Phase C prod:  USE_N4_PIPELINE=true globally — retire N3 routing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if N4 processing is enabled via environment variable.
 * Must be `USE_N4_PIPELINE=true` (exact string).
 */
export function isN4Enabled(): boolean {
  return process.env.USE_N4_PIPELINE === 'true';
}

/**
 * Returns true if this comparison should be processed by N4.
 *
 * Phase 1: purely gates on USE_N4_PIPELINE env var.
 * Phase B: will also auto-route when either side has a non-Xactimate format.
 */
export async function isN4Eligible(comparisonId: string): Promise<boolean> {
  void comparisonId;
  return isN4Enabled();
}

// ── Event payload type ────────────────────────────────────────────────────────

/**
 * Inngest event fired to trigger N4 pipeline processing.
 * Distinct event name prevents N3 and N4 from cross-triggering.
 */
export type N4ProcessRequestedEvent = {
  name: 'comparison/process-v4.requested';
  data: {
    comparisonId: string;
    trigger: 'create-route' | 'manual-route' | 'replay';
    /**
     * If true, re-run even if the comparison is already COMPLETED/FAILED.
     * Use with caution — will overwrite existing LineItems.
     */
    force?: boolean;
  };
};
