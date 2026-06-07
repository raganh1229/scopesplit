// ─────────────────────────────────────────────────────────────────────────────
// auto-fail.ts
//
// Shared helper for marking a stuck/failed comparison as FAILED.
//
// Used by:
//   • /api/internal/sweep-stuck-comparisons (cron sweeper)
//   • onFailure handlers in the N3 and N4 Inngest functions
//
// Safety guarantees:
//   • Uses updateMany with a non-terminal status condition so the operation
//     is fully idempotent — concurrent calls from the cron AND onFailure
//     cannot double-mark or double-refund.
//   • The trial slot is only refunded by the caller that successfully
//     transitions the row (updateMany.count === 1). All subsequent callers
//     see count === 0 and skip the refund.
// ─────────────────────────────────────────────────────────────────────────────

import prisma from '@/lib/prisma';
import { SubscriptionStatus } from '@/app/generated/prisma/client';

export type AutoFailResult = {
  marked: boolean;
  trialRefunded: boolean;
};

/**
 * Atomically transition a comparison from any non-terminal status to FAILED.
 *
 * Returns `{ marked: true }` only for the single caller that performs the
 * transition. All concurrent or subsequent callers get `{ marked: false }`,
 * which prevents double-refunds even if the cron and the Inngest onFailure
 * handler fire at the same time.
 */
export async function autoFailComparison(
  comparisonId: string,
  errorMessage: string,
): Promise<AutoFailResult> {
  // Atomic transition — only succeeds if the comparison is not already terminal.
  const updated = await prisma.comparison.updateMany({
    where: {
      id: comparisonId,
      status: { notIn: ['COMPLETED', 'FAILED'] },
    },
    data: {
      status: 'FAILED',
      errorMessage,
    },
  });

  if (updated.count === 0) {
    // Already terminal — nothing to do.
    return { marked: false, trialRefunded: false };
  }

  // We were the caller that marked it FAILED — refund the trial slot if applicable.
  let trialRefunded = false;
  try {
    const row = await prisma.comparison.findUnique({
      where: { id: comparisonId },
      select: { userId: true },
    });
    if (row?.userId) {
      const refund = await prisma.user.updateMany({
        where: {
          id: row.userId,
          subscriptionStatus: SubscriptionStatus.TRIALING,
          comparisonsUsedThisPeriod: { gt: 0 },
        },
        data: { comparisonsUsedThisPeriod: { decrement: 1 } },
      });
      trialRefunded = refund.count > 0;
    }
  } catch (err) {
    // Non-fatal — the FAILED status was already written. Log and continue.
    console.error('[auto-fail] trial slot refund failed (non-fatal):', err);
  }

  return { marked: true, trialRefunded };
}
