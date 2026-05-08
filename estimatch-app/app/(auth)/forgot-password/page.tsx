'use client';

import Link from 'next/link';
import { useState, useRef, useCallback } from 'react';
import { useSignIn } from '@clerk/nextjs/legacy';
import { useRouter } from 'next/navigation';
import AuthShell from '@/components/auth/AuthShell';
import styles from '@/styles/auth.module.css';
import local from './page.module.css';

export default function ForgotPasswordPage() {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [digits, setDigits] = useState<string[]>(Array(6).fill(''));
  const codeRefs = useRef<(HTMLInputElement | null)[]>([]);
  const { signIn, isLoaded } = useSignIn();
  const router = useRouter();

  const handleSendCode = async () => {
    if (!isLoaded || !signIn || !email) return;
    setError('');
    setLoading(true);
    try {
      await signIn.create({ strategy: 'reset_password_email_code', identifier: email });
      setStep('code');
    } catch (err: unknown) {
      const clerkError = err as { errors?: { message?: string }[] };
      setError(clerkError.errors?.[0]?.message || 'Could not send reset code.');
    } finally {
      setLoading(false);
    }
  };

  const handleCodeVerify = useCallback(async (code: string) => {
    if (!isLoaded || !signIn) return;
    setError('');
    setLoading(true);
    try {
      const result = await signIn.attemptFirstFactor({ strategy: 'reset_password_email_code', code });
      if (result.status === 'needs_new_password') {
        router.push('/reset-password');
      }
    } catch (err: unknown) {
      const clerkError = err as { errors?: { message?: string }[] };
      setError(clerkError.errors?.[0]?.message || 'Invalid code. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [isLoaded, signIn, router]);

  const handleCodeInput = useCallback((i: number, val: string) => {
    const d = val.replace(/[^0-9]/g, '').slice(0, 1);
    setDigits(prev => {
      const n = [...prev]; n[i] = d;
      if (d && n.every(ch => ch.length === 1)) handleCodeVerify(n.join(''));
      return n;
    });
    if (d && i < 5) codeRefs.current[i + 1]?.focus();
  }, [handleCodeVerify]);

  const handleCodeKey = useCallback((i: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !digits[i] && i > 0) codeRefs.current[i - 1]?.focus();
  }, [digits]);

  const handleCodePaste = useCallback((i: number, e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/[^0-9]/g, '');
    setDigits(prev => {
      const n = [...prev];
      for (let j = 0; j < Math.min(pasted.length, 6 - i); j++) n[i + j] = pasted[j];
      if (n.every(ch => ch.length === 1)) handleCodeVerify(n.join(''));
      return n;
    });
    const next = Math.min(i + pasted.length, 5);
    codeRefs.current[next]?.focus();
  }, [handleCodeVerify]);

  const allFilled = digits.every(d => d.length === 1);

  return (
    <AuthShell>
      <div className={`${styles.card} ${local.center}`}>
        {step === 'email' ? (
          <>
            <h1>Forgot your password?</h1>
            <p className={styles.subtitle}>Enter your email and we&apos;ll send you a code to reset your password.</p>
            <div className={styles.formGroup} style={{ textAlign: 'left' }}>
              <label className={styles.formLabel} htmlFor="email">Email address</label>
              <input className={styles.formInput} type="email" id="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} />
            </div>
            {error && <div className={styles.formErrorShow} style={{ marginBottom: 8 }}>{error}</div>}
            <button className={styles.formSubmit} style={{ marginTop: 0 }} onClick={handleSendCode} disabled={loading || !email}>
              {loading ? 'Sending...' : 'Send reset code'}
            </button>
            <div className={local.backLink}><Link href="/login">&larr; Back to sign in</Link></div>
          </>
        ) : (
          <>
            <div className={local.sentIcon}>
              <svg viewBox="0 0 24 24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><polyline points="22,6 12,13 2,6" /></svg>
            </div>
            <h1>Enter reset code</h1>
            <p className={styles.subtitle}>We sent a code to <strong>{email}</strong></p>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 24 }}>
              {digits.map((d, i) => (
                <input
                  key={i}
                  ref={el => { codeRefs.current[i] = el; }}
                  style={{ width: 48, height: 56, border: '0.5px solid var(--border-default)', borderRadius: 10, textAlign: 'center', fontSize: 24, fontWeight: 600, fontFamily: 'var(--font-stack)', color: 'var(--text-primary)', background: 'var(--bg-page)' }}
                  type="text"
                  maxLength={1}
                  inputMode="numeric"
                  value={d}
                  onChange={e => handleCodeInput(i, e.target.value)}
                  onKeyDown={e => handleCodeKey(i, e)}
                  onPaste={e => handleCodePaste(i, e)}
                />
              ))}
            </div>
            {error && <div className={styles.formErrorShow} style={{ marginBottom: 12 }}>{error}</div>}
            <button className={styles.formSubmit} disabled={!allFilled || loading} onClick={() => allFilled && handleCodeVerify(digits.join(''))}>
              {loading ? 'Verifying...' : 'Verify code'}
            </button>
            <div className={local.backLink}><Link href="/login">&larr; Back to sign in</Link></div>
          </>
        )}
      </div>
    </AuthShell>
  );
}
