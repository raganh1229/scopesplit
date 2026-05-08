import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { SubscriptionTier } from '@/app/generated/prisma/client';
import prisma from '@/lib/prisma';
import {
  PLAN_COMPARISON_LIMITS,
  PLAN_EXECUTIVE_SUMMARY_LIMITS,
  PLAN_LLM_EDIT_LIMITS,
  stripe,
} from '@/lib/stripe';

type PlanName = 'starter' | 'professional' | 'business' | null;

const PLAN_NAMES: Record<SubscriptionTier, PlanName> = {
  STARTER: 'starter',
  PROFESSIONAL: 'professional',
  ENTERPRISE: 'business',
};

const ADDON_OPTIONS: Record<SubscriptionTier, { key: string; label: string; priceLabel: string }> = {
  STARTER: {
    key: 'starter_addon_5',
    label: '5 extra comparisons',
    priceLabel: '$34.99 one-time',
  },
  PROFESSIONAL: {
    key: 'professional_addon_10',
    label: '10 extra comparisons',
    priceLabel: '$39.99 one-time',
  },
  ENTERPRISE: {
    key: 'business_addon_10',
    label: '10 extra comparisons',
    priceLabel: '$34.99 one-time',
  },
};

function nextMonthlyDate(date: Date): Date {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

function fromUnixSeconds(value: number | null): Date | null {
  if (!value || !Number.isFinite(value)) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function readUnixSecondsCandidate(record: unknown, ...keys: string[]): number | null {
  if (!record || typeof record !== 'object') return null;

  const source = record as Record<string, unknown>;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

async function getStripeSubscriptionSummary(stripeCustomerId: string | null) {
  if (!stripeCustomerId) {
    return {
      cancelAtPeriodEnd: false,
      subscriptionEndsAt: null as Date | null,
    };
  }

  const { data } = await stripe.subscriptions.list({
    customer: stripeCustomerId,
    status: 'all',
    limit: 20,
  });

  const subscription =
    data.find(sub => ['trialing', 'active', 'past_due', 'unpaid'].includes(sub.status) && !sub.ended_at) ??
    data.find(sub => ['trialing', 'active', 'past_due', 'unpaid'].includes(sub.status)) ??
    null;

  if (!subscription) {
    return {
      cancelAtPeriodEnd: false,
      subscriptionEndsAt: null as Date | null,
    };
  }

  let subscriptionEndsAt = fromUnixSeconds(
    readUnixSecondsCandidate(
      subscription,
      'cancel_at',
      'cancelAt',
      'current_period_end',
      'currentPeriodEnd'
    )
  );

  if (!subscriptionEndsAt) {
    const refreshedSubscription = await stripe.subscriptions.retrieve(subscription.id);
    subscriptionEndsAt = fromUnixSeconds(
      readUnixSecondsCandidate(
        refreshedSubscription,
        'cancel_at',
        'cancelAt',
        'current_period_end',
        'currentPeriodEnd'
      )
    );
  }

  return {
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    subscriptionEndsAt,
  };
}

async function getAddonComparisonsThisPeriod(userId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ addonComparisonsThisPeriod: number | null }>>`
    select coalesce(addon_comparisons_this_period, 0) as "addonComparisonsThisPeriod"
    from public.users
    where id = ${userId}
    limit 1
  `;

  return rows[0]?.addonComparisonsThisPeriod ?? 0;
}

export async function GET() {
  const { userId: clerkId } = await auth();

  if (!clerkId) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const appUser = await prisma.user.findUnique({
    where: { clerkId },
    select: {
      id: true,
      fullName: true,
      email: true,
      phoneNumber: true,
      stripeCustomerId: true,
      subscriptionTier: true,
      subscriptionStatus: true,
      comparisonsUsedThisPeriod: true,
      llmEditsUsedThisPeriod: true,
      executiveSummariesUsedThisPeriod: true,
      periodResetDate: true,
      trialEndsAt: true,
      subscriptionEndsAt: true,
      pendingTierDowngrade: true,
      pendingTierEffectiveAt: true,
    },
  });

  if (!appUser) {
    return NextResponse.json({ error: 'User is not synced to the database yet.' }, { status: 409 });
  }

  let comparisonsUsed = appUser.comparisonsUsedThisPeriod;
  let llmEditsUsed = appUser.llmEditsUsedThisPeriod;
  let executiveSummariesUsed = appUser.executiveSummariesUsedThisPeriod;
  let addonComparisonsThisPeriod = await getAddonComparisonsThisPeriod(appUser.id);
  let periodResetDate = appUser.periodResetDate ?? appUser.subscriptionEndsAt ?? appUser.trialEndsAt ?? null;

  const now = new Date();
  if (periodResetDate && periodResetDate <= now) {
    comparisonsUsed = 0;
    llmEditsUsed = 0;
    executiveSummariesUsed = 0;

    while (periodResetDate <= now) {
      periodResetDate = nextMonthlyDate(periodResetDate);
    }

    await prisma.user.update({
      where: { id: appUser.id },
      data: {
        comparisonsUsedThisPeriod: 0,
        llmEditsUsedThisPeriod: 0,
        executiveSummariesUsedThisPeriod: 0,
        addonComparisonsThisPeriod: 0,
        periodResetDate,
      },
    });
    addonComparisonsThisPeriod = 0;
  } else if (!appUser.periodResetDate && periodResetDate) {
    await prisma.user.update({
      where: { id: appUser.id },
      data: {
        periodResetDate,
      },
    });
  }

  const tier = appUser.subscriptionTier;
  const comparisonLimit = tier
    ? PLAN_COMPARISON_LIMITS[tier] + addonComparisonsThisPeriod
    : null;
  const llmEditLimit = tier ? PLAN_LLM_EDIT_LIMITS[tier] : null;
  const executiveSummaryLimit = tier ? PLAN_EXECUTIVE_SUMMARY_LIMITS[tier] : null;
  const planName = tier ? PLAN_NAMES[tier] : null;
  const pendingDowngradePlan = appUser.pendingTierDowngrade ? PLAN_NAMES[appUser.pendingTierDowngrade] : null;
  const addonOption = tier ? ADDON_OPTIONS[tier] : null;
  const stripeSummary = await getStripeSubscriptionSummary(appUser.stripeCustomerId);
  const subscriptionEndsAt = stripeSummary.subscriptionEndsAt ?? appUser.subscriptionEndsAt;

  return NextResponse.json(
    {
      fullName: appUser.fullName,
      email: appUser.email,
      phoneNumber: appUser.phoneNumber,
      plan: planName,
      pendingDowngradePlan,
      pendingDowngradeEffectiveAt: appUser.pendingTierEffectiveAt,
      status: appUser.subscriptionStatus,
      trialEndsAt: appUser.trialEndsAt,
      subscriptionEndsAt,
      cancelAtPeriodEnd: stripeSummary.cancelAtPeriodEnd,
      // Comparisons usage (unchanged shape)
      comparisonsUsed,
      comparisonLimit,
      addonComparisonsThisPeriod,
      // AI tool usage (new — flat per-tier caps)
      llmEditsUsed,
      llmEditLimit,
      executiveSummariesUsed,
      executiveSummaryLimit,
      periodResetDate,
      usageLocked: comparisonLimit !== null ? comparisonsUsed >= comparisonLimit : true,
      llmEditsLocked: llmEditLimit !== null ? llmEditsUsed >= llmEditLimit : true,
      executiveSummariesLocked: executiveSummaryLimit !== null ? executiveSummariesUsed >= executiveSummaryLimit : true,
      addonOption,
    },
    { status: 200 }
  );
}
