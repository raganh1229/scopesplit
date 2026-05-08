import { NextResponse } from 'next/server';
import { clerkClient } from '@clerk/nextjs/server';
import {
  SubscriptionStatus as PrismaSubscriptionStatus,
  SubscriptionTier as PrismaSubscriptionTier,
} from '@/app/generated/prisma/client';
import prisma from '@/lib/prisma';
import { ADDON_COMPARISON_GRANTS, mapPriceIdToPlan, stripe } from '@/lib/stripe';

type PlanMetadata = 'starter' | 'professional' | 'business';

function toPrismaTier(plan: PlanMetadata): PrismaSubscriptionTier {
  if (plan === 'starter') return PrismaSubscriptionTier.STARTER;
  if (plan === 'professional') return PrismaSubscriptionTier.PROFESSIONAL;
  return PrismaSubscriptionTier.ENTERPRISE;
}

function tierRank(tier: PrismaSubscriptionTier): number {
  if (tier === PrismaSubscriptionTier.STARTER) return 1;
  if (tier === PrismaSubscriptionTier.PROFESSIONAL) return 2;
  return 3;
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

async function updateClerkPlanMetadata(clerkId: string, plan: PlanMetadata | null) {
  const client = await clerkClient();
  await client.users.updateUserMetadata(clerkId, {
    publicMetadata: {
      plan,
    },
  });
}

function fromUnixSeconds(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

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

async function syncSubscription(subscription: {
  id: string;
  customer: string;
  status: string;
  currentPeriodEnd: number | null;
  trialEnd: number | null;
  priceId: string | null;
}) {
  if (!subscription.customer) return;

  const user = await prisma.user.findFirst({
    where: { stripeCustomerId: subscription.customer },
    select: {
      id: true,
      clerkId: true,
      stripeCustomerId: true,
      subscriptionTier: true,
      pendingTierDowngrade: true,
      pendingTierEffectiveAt: true,
      subscriptionEndsAt: true,
    },
  });

  if (!user) {
    return;
  }

  const planFromPrice = subscription.priceId ? mapPriceIdToPlan(subscription.priceId) : null;

  if (!planFromPrice) {
    // Structured log so this is grep-able in Vercel logs / log drains.
    // Pattern: STRIPE_WEBHOOK_UNMAPPED_PRICE — alert on this in production.
    // Common cause: a new Stripe price was created but the corresponding
    // STRIPE_PRICE_* env var is not deployed. The user has paid but won't
    // receive plan access until this is fixed.
    console.error(
      JSON.stringify({
        event: 'STRIPE_WEBHOOK_UNMAPPED_PRICE',
        severity: 'critical',
        priceId: subscription.priceId,
        subscriptionId: subscription.id,
        stripeCustomerId: subscription.customer,
        userClerkId: user.clerkId,
        userId: user.id,
        message:
          'Stripe webhook received a price that does not match any STRIPE_PRICE_* env var. ' +
          'User has been charged but plan access was NOT granted. Manual intervention required.',
      })
    );
    return;
  }

  const mappedStatus = toPrismaStatus(subscription.status);
  const hasAccess = shouldGrantAppAccess(mappedStatus);
  const trialEndsAt = fromUnixSeconds(subscription.trialEnd);
  const subscriptionEndsAt = fromUnixSeconds(subscription.currentPeriodEnd);
  const incomingTier = toPrismaTier(planFromPrice);
  const now = Date.now();
  const pendingEffectiveAt = user.pendingTierEffectiveAt?.getTime() ?? null;
  const shouldHoldDowngradeTier =
    hasAccess &&
    user.subscriptionTier !== null &&
    user.pendingTierDowngrade !== null &&
    pendingEffectiveAt !== null &&
    now < pendingEffectiveAt &&
    tierRank(incomingTier) < tierRank(user.subscriptionTier);

  const resolvedTier = hasAccess
    ? shouldHoldDowngradeTier
      ? user.subscriptionTier
      : incomingTier
    : null;

  const shouldClearPendingDowngrade =
    !hasAccess ||
    user.pendingTierDowngrade === null ||
    pendingEffectiveAt === null ||
    now >= pendingEffectiveAt ||
    !shouldHoldDowngradeTier;

  const hadPreviousPeriodEnd = user.subscriptionEndsAt?.getTime() ?? null;
  const nextPeriodEnd = subscriptionEndsAt?.getTime() ?? null;
  const shouldResetUsage =
    hasAccess &&
    nextPeriodEnd !== null &&
    (hadPreviousPeriodEnd === null || nextPeriodEnd > hadPreviousPeriodEnd);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      subscriptionTier: resolvedTier,
      subscriptionStatus: mappedStatus,
      trialEndsAt,
      subscriptionEndsAt,
      periodResetDate: hasAccess ? subscriptionEndsAt : null,
      ...(shouldClearPendingDowngrade
        ? {
            pendingTierDowngrade: null,
            pendingTierEffectiveAt: null,
          }
        : {}),
      ...(shouldResetUsage
        ? {
            comparisonsUsedThisPeriod: 0,
            addonComparisonsThisPeriod: 0,
            llmEditsUsedThisPeriod: 0,
            executiveSummariesUsedThisPeriod: 0,
          }
        : {}),
    },
  });

  await updateClerkPlanMetadata(user.clerkId, hasAccess ? planFromPrice : null);
}

async function applyAddonPurchaseGrant(session: {
  id: string;
  payment_status?: string | null;
  metadata?: Record<string, string | undefined>;
  client_reference_id?: string | null;
}) {
  if (session.payment_status !== 'paid') {
    return;
  }

  const checkoutKind = session.metadata?.checkoutKind;
  if (checkoutKind !== 'addon') {
    return;
  }

  const addonKey = session.metadata?.addonKey;
  const comparisonsGranted = addonKey ? ADDON_COMPARISON_GRANTS[addonKey as keyof typeof ADDON_COMPARISON_GRANTS] : null;

  if (!addonKey || !comparisonsGranted) {
    return;
  }

  const clerkId = session.client_reference_id ?? session.metadata?.clerkId ?? null;
  if (!clerkId) {
    return;
  }

  await prisma.$transaction(async (tx) => {
    const users = await tx.$queryRaw<Array<{ id: string }>>`
      select id from public.users where clerk_id = ${clerkId} limit 1
    `;

    const userId = users[0]?.id;
    if (!userId) {
      return;
    }

    const insertedRows = await tx.$queryRaw<Array<{ id: string }>>`
      insert into public.addon_purchases (user_id, stripe_session_id, addon_key, comparisons_granted)
      values (${userId}, ${session.id}, ${addonKey}, ${comparisonsGranted})
      on conflict (stripe_session_id) do nothing
      returning id
    `;

    if (insertedRows.length === 0) {
      return;
    }

    await tx.user.update({
      where: { id: userId },
      data: {
        addonComparisonsThisPeriod: { increment: comparisonsGranted },
      },
    });
  });
}

export async function POST(request: Request) {
  const signature = request.headers.get('stripe-signature');
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signature || !webhookSecret) {
    return NextResponse.json({ error: 'Missing Stripe webhook configuration.' }, { status: 400 });
  }

  const payload = await request.text();

  let event;

  try {
    event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  } catch (error) {
    console.error('Stripe webhook signature verification failed:', error);
    return NextResponse.json({ error: 'Invalid Stripe signature.' }, { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;

        if (session.customer && typeof session.customer === 'string') {
          const clerkId =
            (typeof session.client_reference_id === 'string' ? session.client_reference_id : null) ??
            (typeof session.metadata?.clerkId === 'string' ? session.metadata.clerkId : null);

          if (clerkId) {
            await prisma.user.updateMany({
              where: { clerkId },
              data: { stripeCustomerId: session.customer },
            });
          }
        }

        await applyAddonPurchaseGrant({
          id: session.id,
          payment_status: session.payment_status,
          metadata: session.metadata ?? undefined,
          client_reference_id: typeof session.client_reference_id === 'string' ? session.client_reference_id : null,
        });

        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const priceId = subscription.items.data[0]?.price?.id ?? null;
        const customerId =
          typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;

        await syncSubscription({
          id: subscription.id,
          customer: customerId,
          status: subscription.status,
          currentPeriodEnd: readUnixSecondsCandidate(
            subscription,
            'current_period_end',
            'currentPeriodEnd'
          ),
          trialEnd: readUnixSecondsCandidate(subscription, 'trial_end', 'trialEnd'),
          priceId,
        });
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = typeof invoice.customer === 'string' ? invoice.customer : null;
        if (!customerId) break;

        const user = await prisma.user.findFirst({
          where: { stripeCustomerId: customerId },
          select: { id: true, clerkId: true, subscriptionTier: true },
        });

        if (!user) break;

        await prisma.user.update({
          where: { id: user.id },
          data: {
            subscriptionStatus: PrismaSubscriptionStatus.PAST_DUE,
          },
        });

        const metadataPlan: PlanMetadata | null =
          user.subscriptionTier === PrismaSubscriptionTier.STARTER
            ? 'starter'
            : user.subscriptionTier === PrismaSubscriptionTier.PROFESSIONAL
              ? 'professional'
              : user.subscriptionTier === PrismaSubscriptionTier.ENTERPRISE
                ? 'business'
                : null;

        await updateClerkPlanMetadata(user.clerkId, metadataPlan);
        break;
      }

      default:
        break;
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error('Stripe webhook handler failed:', error);
    return NextResponse.json({ error: 'Webhook handler failed.' }, { status: 500 });
  }
}
