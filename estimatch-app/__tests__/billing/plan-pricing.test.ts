import { describe, it, expect } from 'vitest';

// Import from the pure constants module — no Stripe SDK dependency, no API key
// required. lib/stripe.ts imports and re-exports these same objects, so any
// accidental mutation there would still be caught by these tests.
import {
  PLAN_MONTHLY_PRICES_CENTS,
  PLAN_COMPARISON_LIMITS,
  PLAN_LLM_EDIT_LIMITS,
  PLAN_EXECUTIVE_SUMMARY_LIMITS,
} from '@/lib/plan-constants';

// ── Plan Pricing Consistency Tests ──
// These tests act as a regression guard for the agreed-upon pricing structure:
//   Starter:      $59/mo  ·  10 comparisons  ·  5 LLM edits  ·  3 exec summaries
//   Professional: $179/mo · 35 comparisons  · 30 LLM edits  · 15 exec summaries
//   Business:     $349/mo · 100 comparisons · 100 LLM edits · 50 exec summaries
//
// If you need to change these values, update lib/stripe.ts (the single source of
// truth) AND update the expected values below to match.

describe('PLAN_MONTHLY_PRICES_CENTS', () => {
  it('starter is $59/month (5900 cents)', () => {
    expect(PLAN_MONTHLY_PRICES_CENTS.starter).toBe(5900);
  });

  it('professional is $179/month (17900 cents)', () => {
    expect(PLAN_MONTHLY_PRICES_CENTS.professional).toBe(17900);
  });

  it('business is $349/month (34900 cents)', () => {
    expect(PLAN_MONTHLY_PRICES_CENTS.business).toBe(34900);
  });

  it('plans are ordered cheapest → most expensive', () => {
    expect(PLAN_MONTHLY_PRICES_CENTS.starter)
      .toBeLessThan(PLAN_MONTHLY_PRICES_CENTS.professional);
    expect(PLAN_MONTHLY_PRICES_CENTS.professional)
      .toBeLessThan(PLAN_MONTHLY_PRICES_CENTS.business);
  });
});

describe('PLAN_COMPARISON_LIMITS', () => {
  it('STARTER allows 10 comparisons', () => {
    expect(PLAN_COMPARISON_LIMITS.STARTER).toBe(10);
  });

  it('PROFESSIONAL allows 35 comparisons', () => {
    expect(PLAN_COMPARISON_LIMITS.PROFESSIONAL).toBe(35);
  });

  it('ENTERPRISE (Business) allows 100 comparisons', () => {
    expect(PLAN_COMPARISON_LIMITS.ENTERPRISE).toBe(100);
  });

  it('limits are ordered smallest → largest', () => {
    expect(PLAN_COMPARISON_LIMITS.STARTER)
      .toBeLessThan(PLAN_COMPARISON_LIMITS.PROFESSIONAL);
    expect(PLAN_COMPARISON_LIMITS.PROFESSIONAL)
      .toBeLessThan(PLAN_COMPARISON_LIMITS.ENTERPRISE);
  });
});

describe('PLAN_LLM_EDIT_LIMITS', () => {
  it('STARTER allows 5 LLM bulk edits', () => {
    expect(PLAN_LLM_EDIT_LIMITS.STARTER).toBe(5);
  });

  it('PROFESSIONAL allows 30 LLM bulk edits', () => {
    expect(PLAN_LLM_EDIT_LIMITS.PROFESSIONAL).toBe(30);
  });

  it('ENTERPRISE (Business) allows 100 LLM bulk edits', () => {
    expect(PLAN_LLM_EDIT_LIMITS.ENTERPRISE).toBe(100);
  });
});

describe('PLAN_EXECUTIVE_SUMMARY_LIMITS', () => {
  it('STARTER allows 3 executive summaries', () => {
    expect(PLAN_EXECUTIVE_SUMMARY_LIMITS.STARTER).toBe(3);
  });

  it('PROFESSIONAL allows 15 executive summaries', () => {
    expect(PLAN_EXECUTIVE_SUMMARY_LIMITS.PROFESSIONAL).toBe(15);
  });

  it('ENTERPRISE (Business) allows 50 executive summaries', () => {
    expect(PLAN_EXECUTIVE_SUMMARY_LIMITS.ENTERPRISE).toBe(50);
  });
});

describe('per-credit pricing consistency', () => {
  it('professional cost-per-comparison is lower than starter (volume discount)', () => {
    const starterCPU = PLAN_MONTHLY_PRICES_CENTS.starter / PLAN_COMPARISON_LIMITS.STARTER;
    const proCPU = PLAN_MONTHLY_PRICES_CENTS.professional / PLAN_COMPARISON_LIMITS.PROFESSIONAL;
    expect(proCPU).toBeLessThan(starterCPU);
  });

  it('business cost-per-comparison is lower than professional (volume discount)', () => {
    const proCPU = PLAN_MONTHLY_PRICES_CENTS.professional / PLAN_COMPARISON_LIMITS.PROFESSIONAL;
    const bizCPU = PLAN_MONTHLY_PRICES_CENTS.business / PLAN_COMPARISON_LIMITS.ENTERPRISE;
    expect(bizCPU).toBeLessThan(proCPU);
  });
});
