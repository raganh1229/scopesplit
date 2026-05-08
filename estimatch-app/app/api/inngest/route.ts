// ─────────────────────────────────────────────────────────────────────────
// Inngest webhook endpoint (N1 conversion — Phase 5).
//
// This is the URL Inngest hits to:
//   • Discover registered functions (introspection on `PUT`)
//   • Invoke a step in a registered function (`POST`)
//   • Health-check the registration (`GET`)
//
// Functions are registered by adding them to the `functions` array passed
// to `serve()`. Phase 5 ships an empty registry to verify the endpoint is
// reachable; Phase 6 will add the `process-comparison` worker.
//
// `maxDuration` is set high so individual step lambdas have headroom on
// Vercel Pro. Inngest invokes one step per HTTP call, so this only needs
// to cover the longest single stage (Sonnet pairing in Stage C).
// ─────────────────────────────────────────────────────────────────────────

import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest/client';
import { processComparison } from '@/lib/inngest/functions/process-comparison';
import { processComparisonV2 } from '@/lib/n2/inngest/process-comparison-v2';
import { processComparisonV3 } from '@/lib/n3/inngest/process-comparison-v3';

export const maxDuration = 300; // seconds — Vercel Pro ceiling

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [processComparison, processComparisonV2, processComparisonV3],
});
