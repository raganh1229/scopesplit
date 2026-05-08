// ─────────────────────────────────────────────────────────────────────────────
// N2 Pipeline — routing gate and eligibility check
//
// Controls which comparisons are processed by N2 vs N1. N1 remains the
// default until N2 is fully validated in production.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ ⏸  N2 IS PAUSED — N3 DEVELOPMENT IN PROGRESS  (May 7, 2026)              ║
// ║                                                                          ║
// ║ All comparison creation flows route to N1. N2 code, schemas, prompts,    ║
// ║ Inngest function, and the ComparisonProcessingState table are left      ║
// ║ INTACT — nothing has been deleted. To restore N2 as the active pipeline ║
// ║ flip the constant `N2_PAUSED_FOR_N3` below to `false` and ensure        ║
// ║ N2_ENABLED=true is set in `.env.local`. No other code change required.  ║
// ║                                                                          ║
// ║ Why paused: N2's within-zone matching constraint is structurally        ║
// ║ fragile (Pass 3 wrong-pairing on Set3's Demolition zone, May 7 — see    ║
// ║ N2_SPEED_CAPACITY_ACCURACY.md §6 entry for that date). N3 replaces      ║
// ║ within-zone matching with global candidate generation + scoring +       ║
// ║ assignment, which removes that failure class entirely. While N3 is      ║
// ║ being built, N1 is the production pipeline and N2 is the second-tier   ║
// ║ fallback.                                                                ║
// ║                                                                          ║
// ║ Restoration path (when N3 is ready or N2 needs to be re-tested):        ║
// ║   1. Set `N2_PAUSED_FOR_N3 = false` in this file                        ║
// ║   2. Verify `N2_ENABLED=true` in `.env.local`                           ║
// ║   3. New comparisons will route through N2; existing N1 comparisons     ║
// ║      remain unchanged (they're stored under `pipelineVersion: 'n1'`).  ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// Rollout phases (Issue 28 — original N1→N2 plan, now superseded by N3):
//   Phase 1 dev:  N2_ENABLED=true in staging, isN2Eligible returns true for all
//   Phase 2 prod: percentage rollout or per-user opt-in flag (extend here)
//   Phase 3 prod: isN2Eligible always returns true
//   Retirement:   remove routing entirely, delete this file
//
// Usage in comparison creation route:
//   if (await isN2Eligible(comparisonId)) {
//     await prisma.comparison.update({ where: { id: comparisonId },
//       data: { pipelineVersion: 'n2' } });
//     await inngest.send({ name: 'comparison/process-v2.requested',
//       data: { comparisonId, trigger: 'create-route' } });
//   } else {
//     await inngest.send({ name: 'comparison/process.requested',
//       data: { comparisonId, trigger: 'create-route' } });
//   }
// ─────────────────────────────────────────────────────────────────────────────

// ── Hard pause flag ───────────────────────────────────────────────────────────

/**
 * Code-level pause for N2 routing. When `true`, every call to `isN2Eligible`
 * returns `false` regardless of the `N2_ENABLED` env var. This exists so
 * the N2 disconnection cannot be accidentally undone by an env-var flip.
 *
 * **Set to `false` to restore N2 routing.** See banner above.
 */
const N2_PAUSED_FOR_N3 = true;

// ── Env gate ──────────────────────────────────────────────────────────────────

/**
 * Returns true if N2 processing is enabled via environment variable.
 * Must be `N2_ENABLED=true` (exact string) — any other value is false.
 *
 * Safe to call on both server and edge runtimes.
 *
 * NOTE: when `N2_PAUSED_FOR_N3` is `true`, this function still reflects the
 * raw env var (the pause is enforced by `isN2Eligible`, not by this helper).
 * Diagnostic/admin code that wants to know the configured intent vs the
 * effective routing decision should call both this and `isN2Paused()`.
 */
export function isN2Enabled(): boolean {
  return process.env.N2_ENABLED === 'true';
}

/**
 * Returns true if N2 has been deliberately paused at the code level.
 * See the banner at the top of this file.
 */
export function isN2Paused(): boolean {
  return N2_PAUSED_FOR_N3;
}

// ── Eligibility check ─────────────────────────────────────────────────────────

/**
 * Returns true if this comparison should be processed by N2.
 *
 * Logic (in order):
 *   1. If `N2_PAUSED_FOR_N3` is true, return false (hard pause for N3 build).
 *   2. Else, gate on `N2_ENABLED` env var.
 *
 * Phase 6 (when N2 is restored) will extend this with percentage rollout,
 * per-user opt-in, or format-detection gating (Xactimate-only for V1).
 *
 * @param _comparisonId  Reserved for future per-comparison eligibility logic
 */
export async function isN2Eligible(comparisonId: string): Promise<boolean> {
  void comparisonId; // Phase 6: extend with per-comparison eligibility checks
  if (N2_PAUSED_FOR_N3) return false;
  return isN2Enabled();
}

// ── Event payload type ────────────────────────────────────────────────────────

/**
 * Inngest event fired to trigger N2 pipeline processing.
 * Intentionally parallel to ComparisonProcessRequestedEvent in client.ts
 * but uses a different event name so N1 and N2 never cross-trigger.
 */
export type N2ProcessRequestedEvent = {
  name: 'comparison/process-v2.requested';
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
