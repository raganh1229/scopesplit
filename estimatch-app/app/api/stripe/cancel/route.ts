import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { SubscriptionTier } from '@/app/generated/prisma/client';
import prisma from '@/lib/prisma';
import { stripe, PLAN_PRICE_IDS, assertConfiguredPrice, getSubscriptionPeriodEndUnix, type PlanKey } from '@/lib/stripe';

const CANCELLABLE_STATUSES = new Set(['trialing', 'active', 'past_due', 'unpaid']);

function tierToPlanKey(tier: SubscriptionTier): PlanKey {
  if (tier === SubscriptionTier.STARTER) return 'starter';
  if (tier === SubscriptionTier.PROFESSIONAL) return 'professional';
  return 'business';
}

type CancelRequestBody = {
  feedback?: string;
  confirmCancel?: boolean;
};

type CancellationFeedbackDelegate = {
  create: (args: {
    data: {
      userId: string;
      stripeCustomerId: string | null;
      stripeSubscriptionId: string;
      subscriptionTier: unknown;
      feedbackText: string | null;
      scheduledEndAt: Date | null;
    };
  }) => Promise<unknown>;
};

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

async function findCancellableSubscription(customerId: string) {
  const { data } = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 20,
  });

  return (
    data.find(sub => CANCELLABLE_STATUSES.has(sub.status) && !sub.ended_at) ??
    data.find(sub => CANCELLABLE_STATUSES.has(sub.status)) ??
    null
  );
}

export async function POST(request: Request) {
  const { userId: clerkId } = await auth();

  if (!clerkId) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const appUser = await prisma.user.findUnique({
    where: { clerkId },
    select: {
      id: true,
      stripeCustomerId: true,
      subscriptionTier: true,
      pendingTierDowngrade: true,
      pendingTierEffectiveAt: true,
    },
  });

  if (!appUser?.stripeCustomerId) {
    return NextResponse.json({ error: 'No Stripe customer found for this account.' }, { status: 400 });
  }

  let body: CancelRequestBody = {};
  try {
    body = (await request.json()) as CancelRequestBody;
  } catch {
    body = {};
  }

  const feedback = body.feedback?.trim() ?? '';
  if (body.confirmCancel !== true) {
    return NextResponse.json(
      { error: 'Cancellation was not confirmed.' },
      { status: 400 }
    );
  }

  try {
    const subscription = await findCancellableSubscription(appUser.stripeCustomerId);

    if (!subscription) {
      return NextResponse.json({ error: 'No active subscription found to cancel.' }, { status: 404 });
    }

    // If a downgrade is currently pending, cancelling the subscription should also
    // discard that scheduled downgrade and revert Stripe to the tier the user still
    // holds. The downgrade was set to take effect at the period boundary — the same
    // boundary at which the subscription now ends — so it would never apply anyway.
    // Reverting the price keeps the final (cancelling) period consistent with the
    // tier the user is keeping until expiry, and removes the confusing dual
    // "cancelling" + "downgrade scheduled" UI state.
    const hasPendingDowngrade = Boolean(
      appUser.pendingTierDowngrade || appUser.pendingTierEffectiveAt
    );
    const subscriptionItem = subscription.items.data[0];
    const currentPrice = subscriptionItem?.price?.id ?? null;

    let revertPrice: string | null = null;
    if (hasPendingDowngrade && appUser.subscriptionTier && subscriptionItem?.id) {
      try {
        const planKey = tierToPlanKey(appUser.subscriptionTier);
        const targetPrice = assertConfiguredPrice(
          PLAN_PRICE_IDS[planKey],
          `STRIPE_PRICE_${planKey.toUpperCase()}_MONTHLY`
        );
        if (currentPrice !== targetPrice) {
          revertPrice = targetPrice;
        }
      } catch (priceErr) {
        console.error('[cancel] Could not resolve revert price for pending downgrade:', priceErr);
      }
    }

    const needsStripeUpdate = !subscription.cancel_at_period_end || revertPrice !== null;
    const updatedSubscription = needsStripeUpdate
      ? await stripe.subscriptions.update(subscription.id, {
          cancel_at_period_end: true,
          cancellation_details: {
            feedback: 'other',
            ...(feedback ? { comment: feedback.slice(0, 1000) } : {}),
          },
          ...(revertPrice && subscriptionItem?.id
            ? {
                proration_behavior: 'none' as const,
                items: [{ id: subscriptionItem.id, price: revertPrice }],
              }
            : {}),
        })
      : subscription;

    let subscriptionEndsAt = fromUnixSeconds(
      readUnixSecondsCandidate(updatedSubscription, 'cancel_at', 'cancelAt') ??
        getSubscriptionPeriodEndUnix(updatedSubscription)
    );

    if (!subscriptionEndsAt) {
      const refreshedSubscription = await stripe.subscriptions.retrieve(updatedSubscription.id);
      subscriptionEndsAt = fromUnixSeconds(
        readUnixSecondsCandidate(refreshedSubscription, 'cancel_at', 'cancelAt') ??
          getSubscriptionPeriodEndUnix(refreshedSubscription)
      );
    }

    // Always clear pending-downgrade flags on cancel — a scheduled downgrade is moot
    // once the subscription is set to end.
    await prisma.user.update({
      where: { id: appUser.id },
      data: {
        pendingTierDowngrade: null,
        pendingTierEffectiveAt: null,
        ...(subscriptionEndsAt
          ? {
              subscriptionEndsAt,
              periodResetDate: subscriptionEndsAt,
            }
          : {}),
      },
    });

    const feedbackDelegate = (prisma as unknown as { subscriptionCancellationFeedback?: CancellationFeedbackDelegate })
      .subscriptionCancellationFeedback;

    if (feedbackDelegate?.create) {
      try {
        await feedbackDelegate.create({
          data: {
            userId: appUser.id,
            stripeCustomerId: appUser.stripeCustomerId,
            stripeSubscriptionId: updatedSubscription.id,
            subscriptionTier: appUser.subscriptionTier,
            feedbackText: feedback ? feedback.slice(0, 1000) : null,
            scheduledEndAt: subscriptionEndsAt,
          },
        });
      } catch (feedbackError) {
        console.error('Failed to persist cancellation feedback:', feedbackError);
      }
    } else {
      console.warn('Cancellation feedback table delegate unavailable; skipping feedback persistence.');
    }

    return NextResponse.json(
      {
        cancelAtPeriodEnd: true,
        subscriptionEndsAt,
      },
      { status: 200 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to cancel subscription.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
