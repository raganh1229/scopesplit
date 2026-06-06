'use client';

import { useEffect, useMemo, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useClerk } from '@clerk/nextjs';
import TopNav from '@/components/marketing/TopNav';
import styles from './page.module.css';

const COUNTRY_OPTIONS = [
  { code: '+1', label: 'United States / Canada' },
  { code: '+44', label: 'United Kingdom' },
  { code: '+61', label: 'Australia' },
];

function formatNorthAmericanPhone(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 10);

  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

// Next.js requires `useSearchParams()` to be inside a Suspense boundary so
// the page can be statically prerendered. The default export wraps the
// actual content in <Suspense>; VerifyPhoneContent below is the real page.
export default function VerifyPhonePage() {
  return (
    <Suspense fallback={null}>
      <VerifyPhoneContent />
    </Suspense>
  );
}

function VerifyPhoneContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { session } = useClerk();

  const [countryCode, setCountryCode] = useState('+1');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const returnTo = useMemo(() => {
    const value = searchParams.get('returnTo');
    if (!value || !value.startsWith('/')) return '/subscribe';
    return value;
  }, [searchParams]);

  useEffect(() => {
    if (resendCooldown <= 0) return;

    const timeoutId = window.setTimeout(() => {
      setResendCooldown((prev) => Math.max(prev - 1, 0));
    }, 1000);

    return () => window.clearTimeout(timeoutId);
  }, [resendCooldown]);

  async function sendCode() {
    setError(null);
    setSuccess(null);
    setSending(true);

    try {
      const response = await fetch('/api/verification/phone/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          countryCode,
          phoneNumber,
          channel: 'sms',
        }),
      });

      const payload = (await response.json()) as { error?: string };

      if (!response.ok) {
        throw new Error(payload.error ?? 'Unable to send verification code.');
      }

      setCodeSent(true);
      setResendCooldown(15);
      setSuccess('Verification code sent by SMS.');
    } catch (sendError) {
      const message = sendError instanceof Error ? sendError.message : 'Unable to send verification code.';
      setError(message);
    } finally {
      setSending(false);
    }
  }

  async function verifyCode() {
    setError(null);
    setSuccess(null);
    setVerifying(true);

    try {
      const response = await fetch('/api/verification/phone/confirm', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          countryCode,
          phoneNumber,
          code,
        }),
      });

      const payload = (await response.json()) as { error?: string };

      if (!response.ok) {
        throw new Error(payload.error ?? 'Unable to verify code.');
      }

      setSuccess('Phone verified. Redirecting...');
      // Reload the Clerk session so the updated publicMetadata
      // (phoneVerifiedForTrial: true) is written to the JWT cookie
      // before we navigate. Without this the middleware reads stale
      // session claims and redirects back to /verify-phone.
      await session?.reload();
      router.replace(returnTo);
    } catch (verifyError) {
      const message = verifyError instanceof Error ? verifyError.message : 'Unable to verify code.';
      setError(message);
    } finally {
      setVerifying(false);
    }
  }

  const trimmedPhone = phoneNumber.trim();
  const canResend = codeSent && resendCooldown === 0;
  const sendButtonLabel = sending
    ? 'Sending…'
    : !codeSent
      ? 'Send code via SMS'
      : resendCooldown > 0
        ? `Re-send verification code? (${resendCooldown}s)`
        : 'Resend verification code';

  return (
    <>
      <TopNav />
      <main className={styles.page}>
        <section className={styles.card}>
          <div className={styles.illustrationWrap} aria-hidden="true">
            <div className={styles.illustration}>
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <rect x="7" y="2.5" width="10" height="19" rx="2" />
                <line x1="10" y1="5.5" x2="14" y2="5.5" />
                <circle cx="12" cy="18" r="1" />
              </svg>
            </div>
          </div>

          <div className={styles.content}>
            <h1>We&apos;ll also need to verify your phone number</h1>
            <ul className={styles.points}>
              <li>To help protect against spam, fraud, and trial abuse.</li>
              <li>To verify every account owner with a real reachable number.</li>
              <li>To secure billing and account recovery actions.</li>
              <li>You only need to complete this once.</li>
            </ul>

            <div className={styles.formRow}>
              <div className={styles.fieldGroupSmall}>
                <label htmlFor="countryCode">Country</label>
                <select
                  id="countryCode"
                  className={styles.select}
                  value={countryCode}
                  onChange={(event) => {
                    const nextCountryCode = event.target.value;
                    setCountryCode(nextCountryCode);

                    if (nextCountryCode === '+1') {
                      setPhoneNumber((prev) => formatNorthAmericanPhone(prev));
                      return;
                    }

                    setPhoneNumber((prev) => prev.replace(/\D/g, ''));
                  }}
                >
                  {COUNTRY_OPTIONS.map((option) => (
                    <option key={option.code} value={option.code}>
                      {option.code} {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className={styles.fieldGroupLarge}>
                <label htmlFor="phoneNumber">Phone Number</label>
                <input
                  id="phoneNumber"
                  className={styles.input}
                  value={phoneNumber}
                  onChange={(event) => {
                    if (countryCode === '+1') {
                      setPhoneNumber(formatNorthAmericanPhone(event.target.value));
                      return;
                    }

                    setPhoneNumber(event.target.value.replace(/\D/g, ''));
                  }}
                  placeholder="(555) 123-4567"
                  inputMode="tel"
                />
              </div>
            </div>

            <div className={styles.actions}>
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={sendCode}
                disabled={sending || trimmedPhone.length === 0 || (codeSent && !canResend)}
              >
                {sendButtonLabel}
              </button>
            </div>

            {codeSent && (
              <div className={styles.verifyBox}>
                <label htmlFor="code">Verification Code</label>
                <input
                  id="code"
                  className={styles.input}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="Enter 6-digit code"
                  inputMode="numeric"
                />
                <button
                  type="button"
                  className={styles.primaryBtn}
                  onClick={verifyCode}
                  disabled={verifying || code.trim().length === 0}
                >
                  {verifying ? 'Verifying…' : 'Verify phone number'}
                </button>
              </div>
            )}

            {error && <p className={styles.error}>{error}</p>}
            {success && <p className={styles.success}>{success}</p>}
          </div>
        </section>
      </main>
    </>
  );
}
