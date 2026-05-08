import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import prisma from '@/lib/prisma';
import { stripe } from '@/lib/stripe';

const RESUMABLE_STATUSES = new Set(['trialing', 'active', 'past_due', 'unpaid']);

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

async function findResumableSubscription(customerId: string) {
  const { data } = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 20,
  });

  return (
    data.find((sub) => RESUMABLE_STATUSES.has(sub.status) && !sub.ended_at) ??
    data.find((sub) => RESUMABLE_STATUSES.has(sub.status)) ??
    null
  );
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
    },
  });

  if (!appUser?.stripeCustomerId) {
    return NextResponse.json({ error: 'No Stripe customer found for this account.' }, { status: 400 });
  }

  try {
    const subscription = await findResumableSubscription(appUser.stripeCustomerId);

    if (!subscription) {
      return NextResponse.json({ error: 'No active subscription found to resume.' }, { status: 404 });
    }

    const updatedSubscription = subscription.cancel_at_period_end
      ? await stripe.subscriptions.update(subscription.id, {
          cancel_at_period_end: false,
        })
      : subscription;

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

    await prisma.user.update({
      where: { id: appUser.id },
      data: {
        ...(subscriptionEndsAt
          ? {
              subscriptionEndsAt,
              periodResetDate: subscriptionEndsAt,
            }
          : {}),
      },
    });

    return NextResponse.json(
      {
        cancelAtPeriodEnd: false,
        subscriptionEndsAt,
      },
      { status: 200 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to resume subscription.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
