import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { SubscriptionStatus, SubscriptionTier } from '@/app/generated/prisma/client';
import prisma from '@/lib/prisma';
import { PLAN_PRICE_IDS, PLAN_MONTHLY_PRICES_CENTS, assertConfiguredPrice, mapPriceIdToPlan, stripe, type PlanKey } from '@/lib/stripe';

const MANAGEABLE_STATUSES = new Set(['trialing', 'active', 'past_due', 'unpaid']);

type ChangePlanRequestBody = {
  plan?: string;
};

const PLAN_LIMITS: Record<PlanKey, number> = {
  starter: 10,
  professional: 35,
  business: 100,
};

function isPlanKey(value: string | undefined): value is PlanKey {
  return value === 'starter' || value === 'professional' || value === 'business';
}

function toPrismaTier(plan: PlanKey): SubscriptionTier {
  if (plan === 'starter') return SubscriptionTier.STARTER;
  if (plan === 'professional') return SubscriptionTier.PROFESSIONAL;
  return SubscriptionTier.ENTERPRISE;
}

function fromPrismaTier(tier: SubscriptionTier | null): PlanKey | null {
  if (tier === SubscriptionTier.STARTER) return 'starter';
  if (tier === SubscriptionTier.PROFESSIONAL) return 'professional';
  if (tier === SubscriptionTier.ENTERPRISE) return 'business';
  return null;
}

function getPlanRank(plan: PlanKey): number {
  if (plan === 'starter') return 1;
  if (plan === 'professional') return 2;
  return 3;
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

async function findManageableSubscription(customerId: string) {
  const { data } = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 20,
  });

  return (
    data.find(sub => MANAGEABLE_STATUSES.has(sub.status) && !sub.ended_at) ??
    data.find(sub => MANAGEABLE_STATUSES.has(sub.status)) ??
    null
  );
}

export async function POST(request: Request) {
  const { userId: clerkId } = await auth();

  if (!clerkId) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  let body: ChangePlanRequestBody;
  try {
    body = (await request.json()) as ChangePlanRequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON request body.' }, { status: 400 });
  }

  if (!isPlanKey(body.plan)) {
    return NextResponse.json({ error: 'Invalid subscription plan.' }, { status: 400 });
  }

  const appUser = await prisma.user.findUnique({
    where: { clerkId },
    select: {
      id: true,
      stripeCustomerId: true,
      subscriptionTier: true,
      comparisonsUsedThisPeriod: true,
    },
  });

  if (!appUser?.stripeCustomerId) {
    return NextResponse.json({ error: 'No Stripe customer found for this account.' }, { status: 400 });
  }

  let didPreWritePendingDowngrade = false;

  try {
    const subscription = await findManageableSubscription(appUser.stripeCustomerId);

    if (!subscription) {
      return NextResponse.json({ error: 'No active subscription found to update.' }, { status: 404 });
    }

    const subscriptionItem = subscription.items.data[0];
    if (!subscriptionItem?.id) {
      return NextResponse.json({ error: 'Subscription has no billable items.' }, { status: 400 });
    }

    const targetPrice = assertConfiguredPrice(
      PLAN_PRICE_IDS[body.plan],
      `STRIPE_PRICE_${body.plan.toUpperCase()}_MONTHLY`
    );

    const currentPrice = subscriptionItem.price?.id ?? null;
    const mappedCurrentPlan = currentPrice ? mapPriceIdToPlan(currentPrice) : null;
    const currentPlan = mappedCurrentPlan ?? fromPrismaTier(appUser.subscriptionTier) ?? body.plan;
    const currentPlanRank = getPlanRank(currentPlan);
    const targetPlanRank = getPlanRank(body.plan);
    const isUpgrade = targetPlanRank > currentPlanRank;
    const isDowngrade = targetPlanRank < currentPlanRank;
    // During a trial all tier changes take effect immediately — no deferred downgrade.
    const isTrialing = subscription.status === 'trialing';
    const isEffectiveDowngrade = isDowngrade && !isTrialing;

    const prorationBehavior = isDowngrade ? 'none' : 'always_invoice';

    // For non-trialing downgrades: write pendingTierDowngrade to Prisma BEFORE
    // calling Stripe. stripe.subscriptions.update() immediately fires a
    // customer.subscription.updated webhook which calls syncSubscription. That
    // function reads pendingTierDowngrade to decide whether to preserve the higher
    // tier. If the webhook arrives before the post-Stripe Prisma write (a common
    // race), it sees pendingTierDowngrade=null and immediately overwrites
    // subscriptionTier to the lower tier, making the downgrade arrow disappear.
    // Pre-writing here guarantees the webhook always sees the correct pending state
    // regardless of delivery timing.
    // Trialing users are excluded: their tier changes always take effect immediately.
    if (isEffectiveDowngrade) {
      const earlyPeriodEnd = fromUnixSeconds(
        readUnixSecondsCandidate(subscription, 'current_period_end', 'currentPeriodEnd')
      );
      await prisma.user.update({
        where: { id: appUser.id },
        data: {
          pendingTierDowngrade: toPrismaTier(body.plan),
          pendingTierEffectiveAt: earlyPeriodEnd,
        },
      });
      didPreWritePendingDowngrade = true;
    }

    const updatedSubscription =
      currentPrice === targetPrice && !subscription.cancel_at_period_end
        ? subscription
        : await stripe.subscriptions.update(subscription.id, {
            cancel_at_period_end: false,
            proration_behavior: prorationBehavior,
            ...(isUpgrade ? { payment_behavior: 'error_if_incomplete' as const } : {}),
            items: [{
              id: subscriptionItem.id,
              price: targetPrice,
            }],
            metadata: {
              selectedPlan: body.plan,
            },
            ...(isUpgrade ? { expand: ['latest_invoice'] } : {}),
          });

    let subscriptionEndsAt = fromUnixSeconds(
      readUnixSecondsCandidate(
        updatedSubscription,
        'current_period_end',
        'currentPeriodEnd',
        'cancel_at',
        'cancelAt'
      )
    );

    if (!subscriptionEndsAt) {
      const refreshedSubscription = await stripe.subscriptions.retrieve(updatedSubscription.id);
      subscriptionEndsAt = fromUnixSeconds(
        readUnixSecondsCandidate(
          refreshedSubscription,
          'current_period_end',
          'currentPeriodEnd',
          'cancel_at',
          'cancelAt'
        )
      );
    }

    if (!subscriptionEndsAt) {
      subscriptionEndsAt = fromUnixSeconds(
        readUnixSecondsCandidate(
          subscription,
          'current_period_end',
          'currentPeriodEnd',
          'cancel_at',
          'cancelAt'
        )
      );
    }

    const updatedStripeStatus = updatedSubscription.status;
    const newPrismaStatus =
      updatedStripeStatus === 'trialing' ? SubscriptionStatus.TRIALING : SubscriptionStatus.ACTIVE;

    await prisma.user.update({
      where: { id: appUser.id },
      data: {
        subscriptionTier: isEffectiveDowngrade ? appUser.subscriptionTier : toPrismaTier(body.plan),
        pendingTierDowngrade: isEffectiveDowngrade ? toPrismaTier(body.plan) : null,
        pendingTierEffectiveAt: isEffectiveDowngrade ? subscriptionEndsAt : null,
        subscriptionStatus: newPrismaStatus,
        ...(subscriptionEndsAt
          ? {
              subscriptionEndsAt,
              periodResetDate: subscriptionEndsAt,
            }
          : {}),
      },
    });

    // For upgrades, read the actual prorated amount from the invoice Stripe created
    // via always_invoice. The expanded latest_invoice is present on the updated
    // subscription only when an upgrade was performed.
    let amountDueNowCents = 0;
    if (isUpgrade && currentPrice !== targetPrice) {
      const expandedInvoice = (updatedSubscription as unknown as {
        latest_invoice?: { amount_due?: number } | string | null;
      }).latest_invoice;
      if (expandedInvoice && typeof expandedInvoice === 'object') {
        amountDueNowCents = expandedInvoice.amount_due ?? 0;
      } else if (typeof expandedInvoice === 'string') {
        try {
          const invoice = await stripe.invoices.retrieve(expandedInvoice);
          amountDueNowCents = invoice.amount_due;
        } catch {
          amountDueNowCents = Math.max(
            PLAN_MONTHLY_PRICES_CENTS[body.plan] - PLAN_MONTHLY_PRICES_CENTS[currentPlan],
            0
          );
        }
      }
    }

    return NextResponse.json(
      {
        plan: body.plan,
        previousPlan: currentPlan,
        changeType: isUpgrade ? 'upgrade' : isEffectiveDowngrade ? 'downgrade' : 'none',
        cancelAtPeriodEnd: false,
        subscriptionEndsAt,
        comparisonsUsed: appUser.comparisonsUsedThisPeriod,
        effectiveComparisonLimit: isEffectiveDowngrade ? PLAN_LIMITS[currentPlan] : PLAN_LIMITS[body.plan],
        nextComparisonLimit: PLAN_LIMITS[body.plan],
        amountDueNowCents,
        nextChargeAmountCents: PLAN_MONTHLY_PRICES_CENTS[body.plan],
      },
      { status: 200 }
    );
  } catch (error) {
    // If we pre-wrote a pending downgrade but the Stripe call subsequently failed,
    // roll back those fields so the DB is not left in an inconsistent state.
    if (didPreWritePendingDowngrade) {
      await prisma.user.update({
        where: { id: appUser.id },
        data: { pendingTierDowngrade: null, pendingTierEffectiveAt: null },
      }).catch(() => {
        // Best-effort rollback — log but do not mask the original error.
        console.error('change-plan: failed to roll back pre-written pending downgrade for user', appUser.id);
      });
    }
    const message = error instanceof Error ? error.message : 'Unable to change subscription plan.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
