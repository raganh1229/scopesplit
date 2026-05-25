import { NextResponse } from 'next/server';
import { auth, clerkClient } from '@clerk/nextjs/server';
import {
  SubscriptionStatus as PrismaSubscriptionStatus,
  SubscriptionTier as PrismaSubscriptionTier,
} from '@/app/generated/prisma/client';
import prisma from '@/lib/prisma';
import { mapPriceIdToPlan, stripe } from '@/lib/stripe';

type PlanMetadata = 'starter' | 'professional' | 'business';

function toPrismaTier(plan: PlanMetadata): PrismaSubscriptionTier {
  if (plan === 'starter') return PrismaSubscriptionTier.STARTER;
  if (plan === 'professional') return PrismaSubscriptionTier.PROFESSIONAL;
  return PrismaSubscriptionTier.ENTERPRISE;
}

function fromPrismaTier(tier: PrismaSubscriptionTier | null): PlanMetadata | null {
  if (tier === PrismaSubscriptionTier.STARTER) return 'starter';
  if (tier === PrismaSubscriptionTier.PROFESSIONAL) return 'professional';
  if (tier === PrismaSubscriptionTier.ENTERPRISE) return 'business';
  return null;
}

function toPrismaStatus(status: string): PrismaSubscriptionStatus {
  if (status === 'trialing') return PrismaSubscriptionStatus.TRIALING;
  if (status === 'active') return PrismaSubscriptionStatus.ACTIVE;
  if (status === 'past_due') return PrismaSubscriptionStatus.PAST_DUE;
  if (status === 'canceled' || status === 'unpaid' || status === 'incomplete_expired') {
    return PrismaSubscriptionStatus.CANCELED;
  }
  return PrismaSubscriptionStatus.EXPIRED;
}

function shouldGrantAppAccess(status: PrismaSubscriptionStatus): boolean {
  return (
    status === PrismaSubscriptionStatus.ACTIVE ||
    status === PrismaSubscriptionStatus.TRIALING ||
    status === PrismaSubscriptionStatus.PAST_DUE
  );
}

function fromUnixSeconds(value: number | null): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function readUnixSecondsCandidate(record: unknown, ...keys: string[]): number | null {
  if (!record || typeof record !== 'object') {
    return null;
  }

  const source = record as Record<string, unknown>;

  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

async function updateClerkPlanMetadata(clerkId: string, plan: PlanMetadata | null) {
  const client = await clerkClient();
  await client.users.updateUserMetadata(clerkId, {
    publicMetadata: {
      plan,
    },
  });
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
      stripeCustomerId: true,
      subscriptionTier: true,
      subscriptionStatus: true,
      subscriptionEndsAt: true,
    },
  });

  if (!appUser) {
    return NextResponse.json({ error: 'User is not synced to the database yet.' }, { status: 409 });
  }

  let stripeCustomerId = appUser.stripeCustomerId;

  if (!stripeCustomerId) {
    const customerMatches = await stripe.customers.search({
      query: `metadata['clerkId']:'${clerkId}'`,
      limit: 1,
    });

    stripeCustomerId = customerMatches.data[0]?.id ?? null;

    if (stripeCustomerId) {
      await prisma.user.update({
        where: { id: appUser.id },
        data: { stripeCustomerId },
      });
    }
  }

  if (!stripeCustomerId) {
    return NextResponse.json(
      {
        synced: false,
        plan: fromPrismaTier(appUser.subscriptionTier),
        pending: true,
        reason: 'missing_stripe_customer',
      },
      { status: 202 }
    );
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
    return NextResponse.json(
      {
        synced: false,
        plan: fromPrismaTier(appUser.subscriptionTier),
        pending: true,
        reason: 'missing_subscription',
      },
      { status: 202 }
    );
  }

  const priceId = subscription.items.data[0]?.price?.id ?? null;
  const plan = priceId ? mapPriceIdToPlan(priceId) : null;
  const mappedStatus = toPrismaStatus(subscription.status);
  const hasAccess = shouldGrantAppAccess(mappedStatus);

  if (!plan || !hasAccess) {
    return NextResponse.json(
      {
        synced: false,
        plan: fromPrismaTier(appUser.subscriptionTier),
        pending: true,
        reason: !plan ? 'unmapped_price' : 'subscription_not_access_granting',
      },
      { status: 202 }
    );
  }

  const subscriptionEndsAt = fromUnixSeconds(
    readUnixSecondsCandidate(subscription, 'current_period_end', 'currentPeriodEnd')
  );
  const trialEndsAt = fromUnixSeconds(
    readUnixSecondsCandidate(subscription, 'trial_end', 'trialEnd')
  );
  const hadPreviousPeriodEnd = appUser.subscriptionEndsAt?.getTime() ?? null;
  const nextPeriodEnd = subscriptionEndsAt?.getTime() ?? null;
  const shouldResetUsage =
    nextPeriodEnd !== null && (hadPreviousPeriodEnd === null || nextPeriodEnd > hadPreviousPeriodEnd);

  await prisma.user.update({
    where: { id: appUser.id },
    data: {
      subscriptionTier: toPrismaTier(plan),
      subscriptionStatus: mappedStatus,
      trialEndsAt,
      subscriptionEndsAt,
      periodResetDate: subscriptionEndsAt,
      ...(shouldResetUsage
        ? {
            comparisonsUsedThisPeriod: 0,
            llmEditsUsedThisPeriod: 0,
            executiveSummariesUsedThisPeriod: 0,
          }
        : {}),
    },
  });

  if (shouldResetUsage) {
    await prisma.$executeRaw`
      update public.users
      set addon_comparisons_this_period = 0
      where id = ${appUser.id}
    `;
  }

  await updateClerkPlanMetadata(clerkId, plan);

  return NextResponse.json({ synced: true, plan }, { status: 200 });
}
