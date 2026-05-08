import { NextResponse } from 'next/server';
import { auth, clerkClient } from '@clerk/nextjs/server';
import { SubscriptionStatus } from '@/app/generated/prisma/client';
import prisma from '@/lib/prisma';
import {
  ADDON_PRICE_IDS,
  PLAN_PRICE_IDS,
  assertConfiguredPrice,
  getCheckoutUrls,
  mapPlanToMetadata,
  stripe,
  type AddonKey,
  type PlanKey,
} from '@/lib/stripe';

type CheckoutRequestBody = {
  kind: 'subscription' | 'addon';
  plan?: string;
  addon?: string;
  trial?: boolean;
};

function isPlanKey(value: string | undefined): value is PlanKey {
  return value === 'starter' || value === 'professional' || value === 'business';
}

function isAddonKey(value: string | undefined): value is AddonKey {
  return (
    value === 'starter_addon_5' ||
    value === 'professional_addon_10' ||
    value === 'business_addon_10'
  );
}

function canUseTrial(status: SubscriptionStatus | null, hasUsedTrial: boolean): boolean {
  if (hasUsedTrial) return false;
  return status === null || status === SubscriptionStatus.EXPIRED || status === SubscriptionStatus.CANCELED;
}

type ClerkUserLike = {
  publicMetadata?: {
    phoneVerifiedForTrial?: boolean;
  };
  privateMetadata?: {
    trialPhoneNumber?: string;
  };
};

async function assertTrialEligibility(clerkId: string) {
  const client = await clerkClient();
  const clerkUser = (await client.users.getUser(clerkId)) as unknown as ClerkUserLike;

  const verifiedForTrial = clerkUser.publicMetadata?.phoneVerifiedForTrial === true;
  const phoneNumber = clerkUser.privateMetadata?.trialPhoneNumber?.trim() ?? '';

  if (!verifiedForTrial || !phoneNumber) {
    return {
      ok: false as const,
      status: 403,
      error: 'Please verify your phone number before starting a free trial.',
    };
  }

  return {
    ok: true as const,
  };
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
      email: true,
      stripeCustomerId: true,
      subscriptionStatus: true,
      hasUsedTrial: true,
    },
  });

  if (!appUser) {
    return NextResponse.json({ error: 'User is not synced to the database yet.' }, { status: 409 });
  }

  let body: CheckoutRequestBody;

  try {
    body = (await request.json()) as CheckoutRequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON request body.' }, { status: 400 });
  }

  if (body.kind !== 'subscription' && body.kind !== 'addon') {
    return NextResponse.json({ error: 'Invalid checkout kind.' }, { status: 400 });
  }

  let stripeCustomerId = appUser.stripeCustomerId;

  try {
    const { successUrl, cancelUrl } = getCheckoutUrls(request);

    if (body.kind === 'subscription') {
      if (!isPlanKey(body.plan)) {
        return NextResponse.json({ error: 'Invalid subscription plan.' }, { status: 400 });
      }

      const price = assertConfiguredPrice(
        PLAN_PRICE_IDS[body.plan],
        `STRIPE_PRICE_${body.plan.toUpperCase()}_MONTHLY`
      );

      const shouldApplyTrial = body.trial === true && canUseTrial(appUser.subscriptionStatus, appUser.hasUsedTrial);

      if (shouldApplyTrial) {
        const eligibility = await assertTrialEligibility(clerkId);

        if (!eligibility.ok) {
          return NextResponse.json({ error: eligibility.error }, { status: eligibility.status });
        }
      }

      if (!stripeCustomerId) {
        const customer = await stripe.customers.create({
          email: appUser.email,
          metadata: {
            clerkId,
          },
        });

        stripeCustomerId = customer.id;

        await prisma.user.update({
          where: { id: appUser.id },
          data: { stripeCustomerId },
        });
      }

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: stripeCustomerId,
        client_reference_id: clerkId,
        success_url: successUrl,
        cancel_url: cancelUrl,
        line_items: [{ price, quantity: 1 }],
        allow_promotion_codes: true,
        metadata: {
          clerkId,
          checkoutKind: 'subscription',
          selectedPlan: body.plan,
        },
        subscription_data: {
          metadata: {
            clerkId,
            selectedPlan: body.plan,
            selectedPlanMetadata: mapPlanToMetadata(body.plan),
          },
          ...(shouldApplyTrial ? { trial_period_days: 7 } : {}),
        },
      });

      if (shouldApplyTrial) {
        await prisma.user.update({
          where: { id: appUser.id },
          data: { hasUsedTrial: true },
        });
      }

      return NextResponse.json({ url: session.url }, { status: 200 });
    }

    if (!isAddonKey(body.addon)) {
      return NextResponse.json({ error: 'Invalid add-on product.' }, { status: 400 });
    }

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: appUser.email,
        metadata: { clerkId },
      });

      stripeCustomerId = customer.id;

      await prisma.user.update({
        where: { id: appUser.id },
        data: { stripeCustomerId },
      });
    }

    const addonPrice = assertConfiguredPrice(
      ADDON_PRICE_IDS[body.addon],
      `STRIPE_PRICE_${body.addon.toUpperCase()}`
    );

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: stripeCustomerId,
      client_reference_id: clerkId,
      success_url: successUrl,
      cancel_url: cancelUrl,
      line_items: [{ price: addonPrice, quantity: 1 }],
      allow_promotion_codes: true,
      metadata: {
        clerkId,
        checkoutKind: 'addon',
        addonKey: body.addon,
      },
    });

    return NextResponse.json({ url: session.url }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create Stripe checkout session.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
