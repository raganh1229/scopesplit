'use client';

import Link from 'next/link';
import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import TopNav from '@/components/marketing/TopNav';
import styles from './page.module.css';

type PlanKey = 'starter' | 'professional' | 'business';

type Tier = {
  key: PlanKey;
  name: string;
  price: string;
  limit: string;
  featured?: boolean;
  features: string[];
};

const tiers: Tier[] = [
  {
    key: 'starter',
    name: 'Starter',
    price: '$59',
    limit: '10 comparisons per month',
    features: [
      'AI-powered line-item matching',
      'Side-by-side comparison table',
      'Gap analysis dashboard',
      'PDF report export',
      'Mobile and desktop access',
    ],
  },
  {
    key: 'professional',
    name: 'Professional',
    price: '$179',
    limit: '35 comparisons per month',
    featured: true,
    features: [
      'Everything in Starter',
      'Priority support',
      'Higher comparison volume',
      'PDF report export',
      'Mobile and desktop access',
    ],
  },
  {
    key: 'business',
    name: 'Business',
    price: '$349',
    limit: '100 comparisons per month',
    features: [
      'Everything in Professional',
      'Maximum volume',
      'Priority support',
      'PDF report export',
      'Mobile and desktop access',
    ],
  },
];

// Next.js requires `useSearchParams()` to be called inside a Suspense
// boundary so the page can be statically prerendered. The default export
// wraps the actual content in <Suspense>; SubscribeContent below is the
// real component.
export default function SubscribePage() {
  return (
    <Suspense fallback={null}>
      <SubscribeContent />
    </Suspense>
  );
}

function SubscribeContent() {
  const [trialEligible, setTrialEligible] = useState<boolean | null>(null);
  const [loadingPlan, setLoadingPlan] = useState<PlanKey | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [waitingForActivation, setWaitingForActivation] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const checkoutStatus = searchParams.get('checkout');

  useEffect(() => {
    let cancelled = false;
    async function checkEligibility() {
      try {
        const res = await fetch('/api/user/trial-eligibility');
        const data = (await res.json()) as { eligible?: boolean };
        if (!cancelled) setTrialEligible(data.eligible ?? false);
      } catch {
        if (!cancelled) setTrialEligible(false);
      }
    }
    void checkEligibility();
    return () => { cancelled = true; };
  }, []);

  const showTrial = trialEligible === true;

  useEffect(() => {
    if (checkoutStatus !== 'success') return;

    let isCancelled = false;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    setWaitingForActivation(true);
    setCheckoutError(null);

    const pollActivation = async () => {
      if (isCancelled) return;
      attempts += 1;

      try {
        const response = await fetch('/api/stripe/finalize-checkout', {
          method: 'POST',
        });
        const payload = (await response.json()) as { plan?: string | null; error?: string };

        if (!isCancelled && response.ok && payload.plan) {
          router.replace('/app/new-comparison');
          return;
        }
      } catch {
        // noop: keep polling until timeout while Stripe/Clerk sync settles
      }

      if (isCancelled) return;

      if (attempts >= 12) {
        setWaitingForActivation(false);
        setCheckoutError('Payment succeeded, but account activation is still syncing. Please refresh in a few seconds.');
        return;
      }

      retryTimer = setTimeout(() => {
        void pollActivation();
      }, 2000);
    };

    void pollActivation();

    return () => {
      isCancelled = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
    };
  }, [checkoutStatus, router]);

  async function handleSelectPlan(plan: PlanKey) {
    setLoadingPlan(plan);
    setCheckoutError(null);

    try {
      const response = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'subscription',
          plan,
          trial: showTrial,
        }),
      });

      const payload = (await response.json()) as { url?: string; error?: string };

      if (!response.ok || !payload.url) {
        throw new Error(payload.error ?? 'Failed to start checkout.');
      }

      window.location.href = payload.url;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start checkout.';
      setCheckoutError(message);
      setLoadingPlan(null);
    }
  }

  return (
    <>
      <TopNav />
      <div className={styles.wrapper}>
      <div className={styles.header}>
        <h1>Choose your plan</h1>
        <p>Select the plan that fits your workload. All plans include every feature.</p>
      </div>

      {waitingForActivation && (
        <p className={styles.trialNote}>Payment confirmed. Finalizing your account access…</p>
      )}

      {showTrial && <p className={styles.trialNote}>Your card will not be charged during the 7-day trial. Cancel anytime.</p>}
      {checkoutError && <p className={styles.error}>{checkoutError}</p>}

      <div className={styles.grid}>
        {tiers.map(t => (
          <div key={t.name} className={`${styles.card} ${t.featured ? styles.cardFeatured : ''}`}>
            {t.featured && <div className={styles.popular}>Most Popular</div>}
            <div className={styles.tier}>{t.name}</div>
            <div className={styles.priceRow}>
              <span className={styles.price}>{t.price}<span>/mo</span></span>
            </div>
            {showTrial && <div className={styles.trialLabel}>Free for 7 days</div>}
            <div className={styles.limit}>{t.limit}</div>
            <ul className={styles.features}>
              {t.features.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
            <button
              className={`${styles.btn} ${t.featured ? styles.btnFeatured : ''}`}
              onClick={() => handleSelectPlan(t.key)}
              disabled={loadingPlan !== null}
            >
              {loadingPlan === t.key ? 'Redirecting…' : `Select ${t.name}`}
            </button>
          </div>
        ))}
      </div>

      <div className={styles.foot}>
        <p>Have questions? <Link href="/faq">Read the FAQ</Link> or <Link href="/contact">contact us</Link>.</p>
      </div>
      </div>
    </>
  );
}
