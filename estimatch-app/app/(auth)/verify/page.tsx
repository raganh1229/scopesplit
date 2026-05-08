'use client';

import Link from 'next/link';
import { useState, useRef, useCallback } from 'react';
import { useSignUp } from '@clerk/nextjs/legacy';
import { useRouter } from 'next/navigation';
import AuthShell from '@/components/auth/AuthShell';
import styles from '@/styles/auth.module.css';
import local from './page.module.css';

export default function VerifyPage() {
  const [digits, setDigits] = useState<string[]>(Array(6).fill(''));
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const { signUp, setActive, isLoaded } = useSignUp();
  const router = useRouter();

  const allFilled = digits.every(d => d.length === 1);
  const emailDisplay = signUp?.emailAddress || '';

  const handleVerify = useCallback(async (code: string) => {
    if (!isLoaded || !signUp) return;
    setError('');
    setLoading(true);
    try {
      const result = await signUp.attemptEmailAddressVerification({ code });
      if (result.status === 'complete' && result.createdSessionId) {
        await setActive({ session: result.createdSessionId });
        router.push('/subscribe');
      }
    } catch (err: unknown) {
      const clerkError = err as { errors?: { message?: string }[] };
      setError(clerkError.errors?.[0]?.message || 'Invalid code. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [isLoaded, signUp, setActive, router]);

  const handleInput = useCallback((i: number, val: string) => {
    const d = val.replace(/[^0-9]/g, '').slice(0, 1);
    setDigits(prev => {
      const n = [...prev]; n[i] = d;
      if (d && n.every(ch => ch.length === 1)) {
        handleVerify(n.join(''));
      }
      return n;
    });
    if (d && i < 5) refs.current[i + 1]?.focus();
  }, [handleVerify]);

  const handleKey = useCallback((i: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !digits[i] && i > 0) refs.current[i - 1]?.focus();
  }, [digits]);

  const handlePaste = useCallback((i: number, e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/[^0-9]/g, '');
    setDigits(prev => {
      const n = [...prev];
      for (let j = 0; j < Math.min(pasted.length, 6 - i); j++) n[i + j] = pasted[j];
      if (n.every(ch => ch.length === 1)) {
        handleVerify(n.join(''));
      }
      return n;
    });
    const next = Math.min(i + pasted.length, 5);
    refs.current[next]?.focus();
  }, [handleVerify]);

  const resend = useCallback(async () => {
    if (!isLoaded || !signUp) return;
    try {
      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
      setCooldown(60);
      const timer = setInterval(() => {
        setCooldown(prev => {
          if (prev <= 1) { clearInterval(timer); return 0; }
          return prev - 1;
        });
      }, 1000);
    } catch {
      setError('Failed to resend code.');
    }
  }, [isLoaded, signUp]);

  const handleSubmitBtn = () => {
    if (allFilled) handleVerify(digits.join(''));
  };

  return (
    <AuthShell>
      <div className={`${styles.card} ${local.center}`}>
        <div className={local.verifyIcon}>
          <svg viewBox="0 0 24 24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><polyline points="22,6 12,13 2,6" /></svg>
        </div>
        <h1>Check your email</h1>
        <p className={styles.subtitle}>We sent a verification code to<br /><strong>{emailDisplay || 'your email'}</strong></p>

        <div className={local.codeInputs}>
          {digits.map((d, i) => (
            <input
              key={i}
              ref={el => { refs.current[i] = el; }}
              className={`${local.codeInput} ${d ? local.filled : ''}`}
              type="text"
              maxLength={1}
              inputMode="numeric"
              value={d}
              onChange={e => handleInput(i, e.target.value)}
              onKeyDown={e => handleKey(i, e)}
              onPaste={e => handlePaste(i, e)}
            />
          ))}
        </div>

        {error && <div className={styles.formErrorShow} style={{ marginBottom: 12 }}>{error}</div>}
        <button className={styles.formSubmit} disabled={!allFilled || loading} onClick={handleSubmitBtn}>
          {loading ? 'Verifying...' : 'Verify'}
        </button>

        <div className={local.resendRow}>
          Didn&apos;t receive a code?{' '}
          <button className={local.resendLink} onClick={resend} disabled={cooldown > 0}>
            {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
          </button>
        </div>

        <div className={local.backLink}>
          <Link href="/signup">&larr; Use a different email</Link>
        </div>
      </div>
    </AuthShell>
  );
}
