// ── Plan constants ──
// Pure data module with no external dependencies. Imported by lib/stripe.ts
// and directly by tests so pricing constants can be verified without needing a
// Stripe API key in the test environment.

export type PlanKey = 'starter' | 'professional' | 'business';

// ── Per-plan monthly prices (cents) ──
// Single source of truth for plan pricing. Used in change-plan calculations
// and any place that needs to display or compute plan costs.
export const PLAN_MONTHLY_PRICES_CENTS: Record<PlanKey, number> = {
  starter: 5900,
  professional: 17900,
  business: 34900,
};

// ── Per-plan monthly usage caps ──
// Comparisons, LLM Bulk Edits, and Executive Summaries all reset together when
// the billing period rolls over. Indexed by the Prisma SubscriptionTier enum
// string so callers can index without converting.
// (ENTERPRISE is the historical Prisma name for what users see as "Business".)
export const PLAN_COMPARISON_LIMITS: Record<'STARTER' | 'PROFESSIONAL' | 'ENTERPRISE', number> = {
  STARTER: 10,
  PROFESSIONAL: 35,
  ENTERPRISE: 100,
};

export const PLAN_LLM_EDIT_LIMITS: Record<'STARTER' | 'PROFESSIONAL' | 'ENTERPRISE', number> = {
  STARTER: 5,
  PROFESSIONAL: 30,
  ENTERPRISE: 100,
};

export const PLAN_EXECUTIVE_SUMMARY_LIMITS: Record<'STARTER' | 'PROFESSIONAL' | 'ENTERPRISE', number> = {
  STARTER: 3,
  PROFESSIONAL: 15,
  ENTERPRISE: 50,
};

// ── Trial period usage caps ──
// Applied when subscriptionStatus === 'TRIALING', regardless of plan tier.
export const TRIAL_COMPARISON_LIMIT = 4;
export const TRIAL_LLM_EDIT_LIMIT = 2;
export const TRIAL_EXECUTIVE_SUMMARY_LIMIT = 2;
