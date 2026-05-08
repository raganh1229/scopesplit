"use client";

import { useEffect, useState } from 'react';
import styles from './TrialBanner.module.css';

type BillingSummary = {
  status: 'TRIALING' | 'ACTIVE' | 'CANCELED' | 'PAST_DUE' | 'EXPIRED' | null;
  trialEndsAt: string | null;
  plan: 'starter' | 'professional' | 'business' | null;
};

const PLAN_LABELS: Record<NonNullable<BillingSummary['plan']>, string> = {
  starter: 'Starter',
  professional: 'Professional',
  business: 'Business',
};

function formatDate(value: string | null): string {
  if (!value) return 'Not available';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';

  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

const BILLING_SUMMARY_CACHE_TTL_MS = 15_000;
let billingSummaryCache:
  | {
      fetchedAt: number;
      value: BillingSummary;
    }
  | null = null;

function getDaysRemaining(trialEndsAt: string | null): number {
  if (!trialEndsAt) return 0;

  const trialEnd = new Date(trialEndsAt);
  if (Number.isNaN(trialEnd.getTime())) return 0;

  const now = new Date();
  const diffMs = trialEnd.getTime() - now.getTime();
  if (diffMs <= 0) return 0;

  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

export default function TrialBanner() {
  const [daysRemaining, setDaysRemaining] = useState(0);
  const [visible, setVisible] = useState(false);
  const [billingSummary, setBillingSummary] = useState<BillingSummary | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadTrialState() {
      try {
        const now = Date.now();
        const cached = billingSummaryCache;
        const payload =
          cached && now - cached.fetchedAt < BILLING_SUMMARY_CACHE_TTL_MS
            ? cached.value
            : await (async () => {
                const response = await fetch('/api/billing/summary');

                if (!response.ok) {
                  if (!cancelled) setVisible(false);
                  return null;
                }

                const freshPayload = (await response.json()) as BillingSummary;
                billingSummaryCache = {
                  fetchedAt: Date.now(),
                  value: freshPayload,
                };
                return freshPayload;
              })();

        if (!payload) {
          return;
        }
        const nextDays = getDaysRemaining(payload.trialEndsAt);
        const isTrialing = payload.status === 'TRIALING';

        if (!cancelled) {
          setBillingSummary(payload);
          setDaysRemaining(nextDays);
          setVisible(isTrialing && nextDays > 0);
        }
      } catch {
        if (!cancelled) setVisible(false);
      }
    }

    void loadTrialState();

    return () => {
      cancelled = true;
    };
  }, []);

  if (!visible) return null;
  if (daysRemaining <= 0) return null;

  const tierLabel = billingSummary?.plan ? `${PLAN_LABELS[billingSummary.plan]} tier` : 'your selected tier';
  const enrollmentDate = formatDate(billingSummary?.trialEndsAt ?? null);

  return (
    <div className={styles.banner}>
      <div className={styles.inner}>
        <span className={styles.text}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
          Free trial &mdash; <strong>{daysRemaining} day{daysRemaining !== 1 ? 's' : ''} remaining</strong>
        </span>
        <span className={styles.dot} aria-hidden="true">•</span>
        <span className={styles.notice}>You will be enrolled in {tierLabel} on {enrollmentDate}.</span>
      </div>
    </div>
  );
}
