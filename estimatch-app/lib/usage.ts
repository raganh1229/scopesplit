import type { SubscriptionTier } from '@/app/generated/prisma/client';
import prisma from '@/lib/prisma';
import {
  PLAN_EXECUTIVE_SUMMARY_LIMITS,
  PLAN_LLM_EDIT_LIMITS,
} from '@/lib/stripe';

// ── UsageKind ──
// Quota-bearing user actions that share the billing-period reset lifecycle.
// Comparisons have their own bespoke usage handling in
// `app/api/comparisons/route.ts` (because they additionally honor the
// purchasable comparison add-on); the helpers here cover the AI tools, which
// are flat per-tier monthly caps with no purchase path.

export type UsageKind = 'llmEdit' | 'executiveSummary';

type UsageKindConfig = {
  // Plan-included monthly quota by SubscriptionTier.
  planLimit: Record<SubscriptionTier, number>;
  // Schema field on `users` tracking how many slots are used this period.
  usedField: keyof UsedFields;
  // Human-readable labels for error messages.
  labelSingular: string;
  labelPlural: string;
};

type UsedFields = {
  llmEditsUsedThisPeriod: number;
  executiveSummariesUsedThisPeriod: number;
};

export const USAGE_KIND_CONFIG: Record<UsageKind, UsageKindConfig> = {
  llmEdit: {
    planLimit: PLAN_LLM_EDIT_LIMITS as Record<SubscriptionTier, number>,
    usedField: 'llmEditsUsedThisPeriod',
    labelSingular: 'LLM bulk edit',
    labelPlural: 'LLM bulk edits',
  },
  executiveSummary: {
    planLimit: PLAN_EXECUTIVE_SUMMARY_LIMITS as Record<SubscriptionTier, number>,
    usedField: 'executiveSummariesUsedThisPeriod',
    labelSingular: 'executive summary',
    labelPlural: 'executive summaries',
  },
};

// ── Custom error type ──

export class UsageLimitError extends Error {
  kind: UsageKind;
  used: number;
  limit: number;
  refreshDate: Date | null;

  constructor(kind: UsageKind, used: number, limit: number, refreshDate: Date | null) {
    const config = USAGE_KIND_CONFIG[kind];
    super(`${capitalize(config.labelSingular)} limit reached for this billing period.`);
    this.kind = kind;
    this.used = used;
    this.limit = limit;
    this.refreshDate = refreshDate;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Period rollover ──
// Billing-cycle-anchored monthly reset. When the period flips, we zero out
// AI-tool counters AND the comparisons counter atomically so a user doesn't
// see one bar reset before the others. Comparisons add-on balance is also
// reset (consistent with existing behavior — see comparisons route).

export function nextMonthlyDate(date: Date): Date {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

type RolloverInput = {
  id: string;
  comparisonsUsedThisPeriod: number;
  addonComparisonsThisPeriod: number;
  llmEditsUsedThisPeriod: number;
  executiveSummariesUsedThisPeriod: number;
  periodResetDate: Date | null;
  trialEndsAt: Date | null;
  subscriptionEndsAt: Date | null;
};

type RolloverOutput = {
  comparisonsUsedThisPeriod: number;
  addonComparisonsThisPeriod: number;
  llmEditsUsedThisPeriod: number;
  executiveSummariesUsedThisPeriod: number;
  periodResetDate: Date | null;
};

export async function rolloverPeriodIfNeeded(user: RolloverInput): Promise<RolloverOutput> {
  const now = new Date();
  let refreshDate = user.periodResetDate ?? user.subscriptionEndsAt ?? user.trialEndsAt ?? null;

  if (refreshDate && refreshDate <= now) {
    while (refreshDate <= now) {
      refreshDate = nextMonthlyDate(refreshDate);
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        comparisonsUsedThisPeriod: 0,
        addonComparisonsThisPeriod: 0,
        llmEditsUsedThisPeriod: 0,
        executiveSummariesUsedThisPeriod: 0,
        periodResetDate: refreshDate,
      },
    });

    return {
      comparisonsUsedThisPeriod: 0,
      addonComparisonsThisPeriod: 0,
      llmEditsUsedThisPeriod: 0,
      executiveSummariesUsedThisPeriod: 0,
      periodResetDate: refreshDate,
    };
  }

  // First-time backfill: the user has a derived refresh date from
  // subscription/trial end but no explicit periodResetDate yet.
  if (!user.periodResetDate && refreshDate) {
    await prisma.user.update({
      where: { id: user.id },
      data: { periodResetDate: refreshDate },
    });
  }

  return {
    comparisonsUsedThisPeriod: user.comparisonsUsedThisPeriod,
    addonComparisonsThisPeriod: user.addonComparisonsThisPeriod,
    llmEditsUsedThisPeriod: user.llmEditsUsedThisPeriod,
    executiveSummariesUsedThisPeriod: user.executiveSummariesUsedThisPeriod,
    periodResetDate: refreshDate,
  };
}

// ── Limit assertion ──
// AI tools are flat per-tier caps with no add-on extension. Throws
// UsageLimitError if the user is at or above the cap.

export function assertWithinLimit(
  kind: UsageKind,
  tier: SubscriptionTier,
  used: number,
  refreshDate: Date | null
): { limit: number } {
  const config = USAGE_KIND_CONFIG[kind];
  const limit = config.planLimit[tier];
  if (used >= limit) {
    throw new UsageLimitError(kind, used, limit, refreshDate);
  }
  return { limit };
}

// ── Atomic increment ──
// Race-safe single-shot increment with a guard predicate. Returns true if the
// increment happened, false if the user already exceeded the limit since the
// pre-check (which means a parallel request consumed the last slot).

export async function tryIncrementUsage(
  userId: string,
  kind: UsageKind,
  effectiveLimit: number
): Promise<boolean> {
  const config = USAGE_KIND_CONFIG[kind];

  const result = await prisma.user.updateMany({
    where: {
      id: userId,
      [config.usedField]: { lt: effectiveLimit },
    } as Record<string, unknown>,
    data: {
      [config.usedField]: { increment: 1 },
    } as Record<string, unknown>,
  });

  return result.count > 0;
}
