// ─────────────────────────────────────────────────────────────────────────
// Inngest webhook endpoint.
//
// This is the URL Inngest hits to:
//   • Discover registered functions (introspection on `PUT`)
//   • Invoke a step in a registered function (`POST`)
//   • Health-check the registration (`GET`)
//
// N3 is the sole active pipeline. N1 and N2 have been deprecated and
// archived to `DELETED CHANGES/n1-deprecated/` and `n2-deprecated/`.
//
// `maxDuration` is set high so individual step lambdas have headroom on
// Vercel Pro. Inngest invokes one step per HTTP call, so this only needs
// to cover the longest single N3 phase (Sonnet vision in Phase 8).
// ─────────────────────────────────────────────────────────────────────────

import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest/client';
import { processComparisonV3 } from '@/lib/n3/inngest/process-comparison-v3';

export const maxDuration = 300; // seconds — Vercel Pro ceiling

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [processComparisonV3],
});
