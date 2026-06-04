import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { SubscriptionStatus } from '@/app/generated/prisma/client';
import prisma from '@/lib/prisma';
import { stripe } from '@/lib/stripe';

export async function POST() {
  const { userId: clerkId } = await auth();
  if (!clerkId) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const appUser = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true, stripeCustomerId: true, subscriptionStatus: true },
  });

  if (!appUser) {
    return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  }

  if (!appUser.stripeCustomerId) {
    return NextResponse.json({ error: 'No Stripe customer found for this account.' }, { status: 400 });
  }

  if (appUser.subscriptionStatus !== SubscriptionStatus.TRIALING) {
    return NextResponse.json({ error: 'Account is not currently in a trial.' }, { status: 400 });
  }

  try {
    const { data: subscriptions } = await stripe.subscriptions.list({
      customer: appUser.stripeCustomerId,
      status: 'trialing',
      limit: 5,
    });

    const subscription = subscriptions.find((s) => !s.ended_at) ?? null;

    if (!subscription) {
      return NextResponse.json({ error: 'No active trial subscription found.' }, { status: 404 });
    }

    await stripe.subscriptions.update(subscription.id, { trial_end: 'now' });

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to convert trial.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
