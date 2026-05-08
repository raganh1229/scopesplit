'use client';

import { useEffect, useState } from 'react';
import { useSession, useUser } from '@clerk/nextjs';
import styles from './EmailOptInToast.module.css';

type EmailOptInPreference = {
  emailOptIn: boolean;
  neverShowAgain: boolean;
  error?: string;
};

const TOAST_SEEN_PREFIX = 'email-opt-in-toast-seen';

export default function EmailOptInToast() {
  const { isSignedIn, user } = useUser();
  const { session } = useSession();
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isSignedIn || !user || !session?.id) {
      setVisible(false);
      return;
    }

    if (typeof window === 'undefined') return;

    if (window.matchMedia('(max-width: 768px)').matches) {
      setVisible(false);
      return;
    }

    const sessionKey = `${TOAST_SEEN_PREFIX}:${session.id}`;
    if (window.sessionStorage.getItem(sessionKey) === '1') {
      return;
    }

    let cancelled = false;

    async function loadPreference() {
      try {
        const response = await fetch('/api/user/email-opt-in');
        const payload = (await response.json()) as EmailOptInPreference;

        if (!response.ok) {
          return;
        }

        if (cancelled) return;

        const shouldShow = !payload.emailOptIn && !payload.neverShowAgain;
        setVisible(shouldShow);
      } finally {
        window.sessionStorage.setItem(sessionKey, '1');
      }
    }

    void loadPreference();

    return () => {
      cancelled = true;
    };
  }, [isSignedIn, session?.id, user]);

  async function optIn() {
    if (loading) return;
    setLoading(true);

    try {
      const response = await fetch('/api/user/email-opt-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enrolled: true }),
      });
      const payload = (await response.json()) as EmailOptInPreference;
      window.dispatchEvent(
        new CustomEvent('email-opt-in-updated', {
          detail: { emailOptIn: payload.emailOptIn },
        })
      );
      setVisible(false);
    } finally {
      setLoading(false);
    }
  }

  async function neverShowAgain() {
    if (loading) return;
    setLoading(true);

    try {
      const response = await fetch('/api/user/email-opt-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ neverShowAgain: true }),
      });
      const payload = (await response.json()) as EmailOptInPreference;
      window.dispatchEvent(
        new CustomEvent('email-opt-in-updated', {
          detail: { emailOptIn: payload.emailOptIn },
        })
      );
      setVisible(false);
    } finally {
      setLoading(false);
    }
  }

  if (!visible) return null;

  return (
    <div className={styles.toast} role="status" aria-live="polite">
      <button
        type="button"
        className={styles.close}
        onClick={() => setVisible(false)}
        aria-label="Dismiss"
      >
        ×
      </button>
      <p className={styles.message}>
        Would you like to be emailed about new features and updates to ScopeSplit?
      </p>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={() => void optIn()} disabled={loading}>
          Yes
        </button>
        <button type="button" className={styles.secondary} onClick={() => void neverShowAgain()} disabled={loading}>
          Never show again
        </button>
      </div>
    </div>
  );
}
