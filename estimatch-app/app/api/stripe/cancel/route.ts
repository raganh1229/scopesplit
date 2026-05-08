import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import prisma from '@/lib/prisma';
import { stripe } from '@/lib/stripe';

const CANCELLABLE_STATUSES = new Set(['trialing', 'active', 'past_due', 'unpaid']);

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

    const updatedSubscription = subscription.cancel_at_period_end
      ? subscription
      : await stripe.subscriptions.update(subscription.id, {
          cancel_at_period_end: true,
          cancellation_details: {
            feedback: 'other',
            ...(feedback ? { comment: feedback.slice(0, 1000) } : {}),
          },
        });

    let subscriptionEndsAt = fromUnixSeconds(
      readUnixSecondsCandidate(
        updatedSubscription,
        'cancel_at',
        'cancelAt',
        'current_period_end',
        'currentPeriodEnd'
      )
    );

    if (!subscriptionEndsAt) {
      const refreshedSubscription = await stripe.subscriptions.retrieve(updatedSubscription.id);
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
