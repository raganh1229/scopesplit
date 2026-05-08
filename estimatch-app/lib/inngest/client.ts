// ─────────────────────────────────────────────────────────────────────────
// Inngest client (N1 conversion — Phase 5).
//
// Single shared `Inngest` instance for the app. Used by:
//   • `lib/inngest/functions/*` to define worker functions
//   • `app/api/inngest/route.ts` to register them with Inngest
//   • `app/api/comparisons/route.ts` (Phase 7) to enqueue events
//
// Configuration:
//   • `id` is the Inngest "App ID" — must be stable across deploys.
//   • Event/signing keys are read from env at runtime. In dev, the Inngest
//     dev server doesn't enforce them, so placeholders are fine. In prod,
//     `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` must be set on Vercel
//     — see `PRODUCTION_CUTOVER_CHECKLIST.md` for the cutover steps.
// ─────────────────────────────────────────────────────────────────────────

import { Inngest } from 'inngest';

export const inngest = new Inngest({
  id: 'estimatch-app',
});

/**
 * Documented event payload shapes. Inngest v4 removed the `EventSchemas`
 * client-typing API, so these types are not enforced by the SDK at compile
 * time; they exist as a reference contract. Worker handlers cast
 * `event.data` to the appropriate type, and `inngest.send()` call sites
 * import these types when constructing payloads.
 */
export type ComparisonProcessRequestedEvent = {
  name: 'comparison/process.requested';
  data: {
    comparisonId: string;
    trigger:
      | 'create-route'
      | 'manual-route'
      | 'idempotency-test'
      | 'replay';
    /**
     * If true, the worker will re-run the full 4-stage pipeline even if the
     * comparison row is already in a terminal state (`COMPLETED` / `FAILED`).
     * Defaults to false — replays of already-terminal comparisons are
     * short-circuited to protect user-authored notes / version edits / etc.
     * from accidental destruction by duplicate event sends.
     */
    force?: boolean;
  };
};
