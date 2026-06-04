'use client';

import { useCallback, useEffect, useState } from 'react';
import styles from './TrialLimitBanner.module.css';

type TrialLimitDetail = {
  kind: 'comparison' | 'llmEdit' | 'executiveSummary';
  limit: number;
};

const KIND_LABELS: Record<string, string> = {
  comparison: 'comparisons',
  llmEdit: 'bulk edits',
  executiveSummary: 'executive summaries',
};

export default function TrialLimitBanner() {
  const [visible, setVisible] = useState(false);
  const [detail, setDetail] = useState<TrialLimitDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [upgraded, setUpgraded] = useState(false);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);

  useEffect(() => {
    function handleTrialLimit(e: Event) {
      const custom = e as CustomEvent<TrialLimitDetail>;
      setDetail(custom.detail);
      setUpgraded(false);
      setUpgradeError(null);
      setVisible(true);
    }
    window.addEventListener('trial-limit-reached', handleTrialLimit);
    return () => window.removeEventListener('trial-limit-reached', handleTrialLimit);
  }, []);

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

  return (
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
            onClick={() => void handleUpgrade()}
            disabled={loading}
          >
            {loading ? 'Processing\u2026' : 'Upgrade Now'}
          </button>
        </div>
      )}
      {upgradeError && <p className={styles.errorText}>{upgradeError}</p>}
    </div>
  );
}
