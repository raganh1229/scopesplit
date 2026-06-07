'use client';

import { useCallback, useEffect, useState } from 'react';
import styles from './TrialLimitBanner.module.css';

type TrialLimitDetail = {
  kind: 'comparison' | 'llmEdit' | 'executiveSummary';
  limit: number;
};

type BillingSummaryLite = {
  plan: 'starter' | 'professional' | 'business' | null;
  pendingDowngradePlan: 'starter' | 'professional' | 'business' | null;
};

const KIND_LABELS: Record<string, string> = {
  comparison: 'comparisons',
  llmEdit: 'bulk edits',
  executiveSummary: 'executive summaries',
};

const PLAN_LABELS: Record<string, string> = {
  starter: 'Starter',
  professional: 'Professional',
  business: 'Business',
};

const PLAN_PRICES: Record<string, string> = {
  starter: '$59/mo',
  professional: '$179/mo',
  business: '$349/mo',
};

export default function TrialLimitBanner() {
  const [visible, setVisible] = useState(false);
  const [detail, setDetail] = useState<TrialLimitDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [upgraded, setUpgraded] = useState(false);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [billingSummary, setBillingSummary] = useState<BillingSummaryLite | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);

  const fetchBillingSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      const res = await fetch('/api/billing/summary', { cache: 'no-store' });
      if (res.ok) {
        const data = (await res.json()) as BillingSummaryLite;
        setBillingSummary(data);
      }
    } catch {
      // Non-critical — modal will still appear, just without plan detail
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  useEffect(() => {
    function handleTrialLimit(e: Event) {
      const custom = e as CustomEvent<TrialLimitDetail>;
      setDetail(custom.detail);
      setUpgraded(false);
      setUpgradeError(null);
      setConfirming(false);
      setVisible(true);
      void fetchBillingSummary();
    }
    window.addEventListener('trial-limit-reached', handleTrialLimit);
    return () => window.removeEventListener('trial-limit-reached', handleTrialLimit);
  }, [fetchBillingSummary]);

  const handleUpgrade = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setUpgradeError(null);
    try {
      const res = await fetch('/api/stripe/convert-trial', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setUpgradeError(data?.error ?? 'Something went wrong. Please try again.');
        setLoading(false);
        return;
      }
      setUpgraded(true);
      setTimeout(() => window.location.reload(), 3000);
    } catch {
      setUpgradeError('Something went wrong. Please try again.');
      setLoading(false);
    }
  }, [loading]);

  if (!visible || !detail) return null;

  const kindLabel = KIND_LABELS[detail.kind] ?? detail.kind;
  const enrolledPlan = billingSummary?.pendingDowngradePlan ?? billingSummary?.plan ?? null;

  return (
    <>
      <div className={styles.banner} role="alert" aria-live="assertive">
        <button
          type="button"
          className={styles.close}
          onClick={() => setVisible(false)}
          aria-label="Dismiss"
          disabled={loading}
        >
          ×
        </button>
        <div className={styles.header}>
          <svg
            className={styles.icon}
            viewBox="0 0 24 24"
            width="17"
            height="17"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span className={styles.title}>Trial Limit Reached</span>
        </div>
        <p className={styles.message}>
          {upgraded
            ? 'Upgrading your plan\u2026 page will reload in a moment.'
            : `The maximum number of ${kindLabel} during your trial is ${detail.limit}. Upgrade now to unlock your full plan.`}
        </p>
        {!upgraded && (
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.upgradeBtn}
              onClick={() => setConfirming(true)}
              disabled={loading}
            >
              Upgrade Now
            </button>
          </div>
        )}
        {upgradeError && <p className={styles.errorText}>{upgradeError}</p>}
      </div>

      {confirming && (
        <div
          className={styles.overlay}
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-upgrade-title"
          onClick={(e) => { if (e.target === e.currentTarget) setConfirming(false); }}
        >
          <div className={styles.modal}>
            <h2 className={styles.modalTitle} id="confirm-upgrade-title">Confirm Upgrade</h2>
            {summaryLoading ? (
              <p className={styles.modalBody}>Loading plan details\u2026</p>
            ) : enrolledPlan ? (
              <p className={styles.modalBody}>
                Your card will be charged immediately. You will be enrolled in the{' '}
                <span className={styles.planHighlight}>
                  {PLAN_LABELS[enrolledPlan]} plan ({PLAN_PRICES[enrolledPlan]})
                </span>.
              </p>
            ) : (
              <p className={styles.modalBody}>
                Your card will be charged immediately based on your current plan.
              </p>
            )}
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.modalConfirmBtn}
                onClick={() => { setConfirming(false); void handleUpgrade(); }}
                disabled={loading || summaryLoading}
              >
                {loading ? 'Processing\u2026' : 'Yes, Upgrade'}
              </button>
              <button
                type="button"
                className={styles.modalCancelBtn}
                onClick={() => setConfirming(false)}
                disabled={loading}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
