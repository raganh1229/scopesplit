import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { SubscriptionTier } from '@/app/generated/prisma/client';
import prisma from '@/lib/prisma';
import { stripe, PLAN_PRICE_IDS, assertConfiguredPrice, type PlanKey } from '@/lib/stripe';

const MANAGEABLE_STATUSES = new Set(['trialing', 'active', 'past_due', 'unpaid']);

function tierToPlanKey(tier: SubscriptionTier): PlanKey {
  if (tier === SubscriptionTier.STARTER) return 'starter';
  if (tier === SubscriptionTier.PROFESSIONAL) return 'professional';
  return 'business';
}

export async function POST() {
  const { userId: clerkId } = await auth();

  if (!clerkId) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const appUser = await prisma.user.findUnique({
    where: { clerkId },
    select: {
      id: true,
      subscriptionTier: true,
      stripeCustomerId: true,
      pendingTierDowngrade: true,
      pendingTierEffectiveAt: true,
    },
  });

  if (!appUser) {
    return NextResponse.json({ error: 'User is not synced to the database yet.' }, { status: 409 });
  }

  if (!appUser.pendingTierDowngrade && !appUser.pendingTierEffectiveAt) {
    return NextResponse.json({ cancelled: false }, { status: 200 });
  }

  // Revert the Stripe subscription price back to the current (higher) tier BEFORE
  // clearing the pending state in Supabase. When the downgrade was scheduled,
  // change-plan immediately updated the Stripe price to the lower tier. If we only
  // clear the Supabase pending fields without reverting Stripe, any subsequent
  // customer.subscription.updated webhook (e.g. a Stripe retry or the next renewal)
  // will see incomingTier=lower-tier with pendingTierDowngrade=null, causing
  // syncSubscription to permanently overwrite subscriptionTier to the lower tier.
  if (appUser.stripeCustomerId && appUser.subscriptionTier) {
    const { data: subscriptions } = await stripe.subscriptions.list({
      customer: appUser.stripeCustomerId,
      status: 'all',
      limit: 20,
    });

    const subscription =
      subscriptions.find(sub => MANAGEABLE_STATUSES.has(sub.status) && !sub.ended_at) ??
      subscriptions.find(sub => MANAGEABLE_STATUSES.has(sub.status)) ??
      null;

    if (subscription) {
      const subscriptionItem = subscription.items.data[0];
      if (subscriptionItem?.id) {
        const planKey = tierToPlanKey(appUser.subscriptionTier);
        const targetPrice = assertConfiguredPrice(
          PLAN_PRICE_IDS[planKey],
          `STRIPE_PRICE_${planKey.toUpperCase()}_MONTHLY`
        );

        const currentPrice = subscriptionItem.price?.id ?? null;
        if (currentPrice !== targetPrice) {
          await stripe.subscriptions.update(subscription.id, {
            cancel_at_period_end: false,
            proration_behavior: 'none',
            items: [{ id: subscriptionItem.id, price: targetPrice }],
            metadata: { selectedPlan: planKey },
          });
        }
      }
    }
  }

  await prisma.user.update({
    where: { id: appUser.id },
    data: {
      pendingTierDowngrade: null,
      pendingTierEffectiveAt: null,
    },
  });

  return NextResponse.json({ cancelled: true }, { status: 200 });
}
