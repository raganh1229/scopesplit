import Stripe from 'stripe';
import {
  type PlanKey,
  PLAN_MONTHLY_PRICES_CENTS,
  PLAN_COMPARISON_LIMITS,
  PLAN_LLM_EDIT_LIMITS,
  PLAN_EXECUTIVE_SUMMARY_LIMITS,
} from '@/lib/plan-constants';

export { PlanKey, PLAN_MONTHLY_PRICES_CENTS, PLAN_COMPARISON_LIMITS, PLAN_LLM_EDIT_LIMITS, PLAN_EXECUTIVE_SUMMARY_LIMITS };

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

if (!stripeSecretKey) {
  throw new Error('Missing STRIPE_SECRET_KEY environment variable.');
}

// API version is pinned to '2025-03-31.basil' (older than what the current
// Stripe SDK ships as `LatestApiVersion`). The runtime value is intentionally
// kept on the older version so existing webhook handlers and response parsers
// keep matching the response shapes Stripe sends. The SDK type was widened in
// a newer release; the cast preserves runtime behavior without forcing a
// risky API-version migration. Tracked in OUTSTANDING_WORK.md #28 for a
// proper migration to '2025-08-27.basil' once response handlers are audited.
export const stripe = new Stripe(stripeSecretKey, {
  apiVersion: '2025-03-31.basil' as Stripe.LatestApiVersion,
});

export type AddonKey = 'starter_addon_5' | 'professional_addon_10' | 'business_addon_10';

// ── Per-addon grant amounts ──
// Comparison add-on purchases grant extra comparisons in the current period.
// AI-tool quotas (LLM Bulk Edit, Executive Summary) are flat per-tier monthly
// caps and are NOT extendable via add-on purchase.

export const ADDON_COMPARISON_GRANTS: Record<AddonKey, number> = {
  starter_addon_5: 5,
  professional_addon_10: 10,
  business_addon_10: 10,
};

export const PLAN_PRICE_IDS: Record<PlanKey, string> = {
  starter: process.env.STRIPE_PRICE_STARTER_MONTHLY ?? '',
  professional: process.env.STRIPE_PRICE_PROFESSIONAL_MONTHLY ?? '',
  business: process.env.STRIPE_PRICE_BUSINESS_MONTHLY ?? '',
};

export const ADDON_PRICE_IDS: Record<AddonKey, string> = {
  starter_addon_5: process.env.STRIPE_PRICE_STARTER_ADDON_5 ?? '',
  professional_addon_10: process.env.STRIPE_PRICE_PROFESSIONAL_ADDON_10 ?? '',
  business_addon_10: process.env.STRIPE_PRICE_BUSINESS_ADDON_10 ?? '',
};

export function assertConfiguredPrice(priceId: string | undefined, keyName: string): string {
  if (!priceId) {
    throw new Error(`Missing ${keyName} environment variable.`);
  }

  return priceId;
}

// In Stripe API version 2025-03-31.basil the `current_period_end` (and
// `current_period_start`) fields moved OFF the Subscription object and ONTO the
// individual Subscription Item. Code that still reads `subscription.current_period_end`
// gets `undefined`, which silently breaks every downstream calculation that relies
// on the billing period (e.g. pendingTierEffectiveAt, periodResetDate). This helper
// reads the item first and falls back to the subscription object for safety.
export function getSubscriptionPeriodEndUnix(subscription: unknown): number | null {
  const readPositiveNumber = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
  };

  if (!subscription || typeof subscription !== 'object') return null;
  const sub = subscription as {
    current_period_end?: unknown;
    items?: { data?: Array<{ current_period_end?: unknown }> };
  };

  const itemEnd = readPositiveNumber(sub.items?.data?.[0]?.current_period_end);
  if (itemEnd !== null) return itemEnd;

  return readPositiveNumber(sub.current_period_end);
}

// Default paths for post-checkout redirects. These can be overridden via env
// vars (STRIPE_CHECKOUT_SUCCESS_PATH / STRIPE_CHECKOUT_CANCEL_PATH) but the
// origin is ALWAYS derived from the incoming request to guarantee the URL
// matches the current deployment (prevents `localhost` leaking into prod).
const DEFAULT_SUCCESS_PATH = '/app/new-comparison?checkout=success';
const DEFAULT_CANCEL_PATH = '/subscribe?checkout=cancel';

function deriveOrigin(request: Request): string {
  // Prefer standard forwarded headers (Vercel sets these), then Origin, then Host.
  const headers = request.headers;
  const forwardedProto = headers.get('x-forwarded-proto');
  const forwardedHost = headers.get('x-forwarded-host') ?? headers.get('host');

  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  const origin = headers.get('origin');
  if (origin) return origin;

  // Last-resort fallback: parse from the request URL itself.
  try {
    const u = new URL(request.url);
    return `${u.protocol}//${u.host}`;
  } catch {
    throw new Error('Unable to derive request origin for Stripe checkout URLs.');
  }
}

export function getCheckoutUrls(request: Request) {
  const origin = deriveOrigin(request);
  const successPath = process.env.STRIPE_CHECKOUT_SUCCESS_PATH ?? DEFAULT_SUCCESS_PATH;
  const cancelPath = process.env.STRIPE_CHECKOUT_CANCEL_PATH ?? DEFAULT_CANCEL_PATH;

  return {
    successUrl: `${origin}${successPath.startsWith('/') ? '' : '/'}${successPath}`,
    cancelUrl: `${origin}${cancelPath.startsWith('/') ? '' : '/'}${cancelPath}`,
  };
}

export function mapPlanToMetadata(plan: PlanKey): string {
  return plan;
}

export function mapPriceIdToPlan(priceId: string): PlanKey | null {
  if (priceId === PLAN_PRICE_IDS.starter) return 'starter';
  if (priceId === PLAN_PRICE_IDS.professional) return 'professional';
  if (priceId === PLAN_PRICE_IDS.business) return 'business';
  return null;
}
