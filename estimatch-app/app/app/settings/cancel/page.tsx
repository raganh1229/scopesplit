'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import MobileAppBar from '@/components/app/MobileAppBar';
import TrialBanner from '@/components/app/TrialBanner';
import styles from './page.module.css';

export default function CancelSubscriptionPage() {
  const router = useRouter();
  const [feedback, setFeedback] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCancelSubscription() {
    if (isSubmitting) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch('/api/stripe/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feedback,
          confirmCancel: true,
        }),
      });

      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? 'Unable to cancel subscription.');
      }

      window.dispatchEvent(new CustomEvent('billing-summary-updated'));
      router.push('/app/settings?cancelled=1');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to cancel subscription.');
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <MobileAppBar title="Cancel Subscription" />
      <TrialBanner />
      <div className={styles.wrap}>
        <div className={styles.card}>
          <div className={styles.icon}>
            <svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z" /></svg>
          </div>
          <h1>We&apos;re sorry to see you go</h1>
          <p className={styles.subtitle}>This software is built and supported by one person. Any feedback you can share would mean a lot.</p>

          <textarea
            className={styles.textarea}
            placeholder="What could we have done better?"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            disabled={isSubmitting}
          />
          <div className={styles.hint}>Optional &mdash; but we truly appreciate it.</div>
          {error ? <div className={styles.error}>{error}</div> : null}

          <button type="button" className={styles.cancelBtn} onClick={handleCancelSubscription} disabled={isSubmitting}>
            {isSubmitting ? 'Canceling…' : 'Cancel my subscription'}
          </button>

          <div className={styles.tierLink}>
            <Link href="/app/settings?tierSelector=1">Choose a different tier instead</Link>
          </div>

          <div className={styles.keepLink}>
            <Link href="/app/settings">Never mind, keep my subscription</Link>
          </div>
        </div>
      </div>
    </>
  );
}
