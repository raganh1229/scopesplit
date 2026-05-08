'use client';

import { useState } from 'react';
import { useSignIn } from '@clerk/nextjs/legacy';
import { useRouter } from 'next/navigation';
import AuthShell from '@/components/auth/AuthShell';
import styles from '@/styles/auth.module.css';

function getStrength(pw: string): number {
  let s = 0;
  if (pw.length >= 8) s++;
  if (/[A-Z]/.test(pw)) s++;
  if (/[0-9]/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return s;
}

function strengthClass(strength: number, barIndex: number): string {
  if (barIndex >= strength) return styles.pwStrengthBar;
  const cls = [styles.pwStrengthActive1, styles.pwStrengthActive2, styles.pwStrengthActive3, styles.pwStrengthActive4];
  return `${styles.pwStrengthBar} ${cls[strength - 1] || ''}`;
}

export default function ResetPasswordPage() {
  const [showPw, setShowPw] = useState(false);
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { signIn, setActive, isLoaded } = useSignIn();
  const router = useRouter();
  const strength = getStrength(pw);
  const mismatch = confirm.length > 0 && confirm !== pw;
  const valid = pw.length >= 8 && confirm === pw;

  const handleReset = async () => {
    if (!isLoaded || !signIn || !valid) return;
    setError('');
    setLoading(true);
    try {
      const result = await signIn.resetPassword({ password: pw });
      if (result.status === 'complete' && result.createdSessionId) {
        await setActive({ session: result.createdSessionId });
        router.push('/subscribe');
      }
    } catch (err: unknown) {
      const clerkError = err as { errors?: { message?: string }[] };
      setError(clerkError.errors?.[0]?.message || 'Failed to reset password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell>
      <div className={styles.card}>
        <h1>Set new password</h1>
        <p className={styles.subtitle}>Enter your new password below.</p>

        <form onSubmit={e => e.preventDefault()}>
          <div className={styles.formGroup}>
            <label className={styles.formLabel} htmlFor="password">New password</label>
            <div className={styles.passwordWrap}>
              <input className={styles.formInput} type={showPw ? 'text' : 'password'} id="password" placeholder="Enter new password" value={pw} onChange={e => setPw(e.target.value)} />
              <button className={styles.pwToggle} type="button" onClick={() => setShowPw(!showPw)} aria-label="Show password">
                {showPw ? (
                  <svg viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
                ) : (
                  <svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                )}
              </button>
            </div>
            <div className={styles.pwStrength}>
              {[0, 1, 2, 3].map(i => <div key={i} className={strengthClass(strength, i)} />)}
            </div>
            <div className={styles.formHint}>At least 8 characters</div>
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel} htmlFor="confirmPassword">Confirm new password</label>
            <input className={`${styles.formInput} ${mismatch ? styles.formInputError : ''}`} type="password" id="confirmPassword" placeholder="Confirm new password" value={confirm} onChange={e => setConfirm(e.target.value)} />
            {mismatch && <div className={styles.formErrorShow}>Passwords do not match.</div>}
          </div>
          {error && <div className={styles.formErrorShow} style={{ marginBottom: 8 }}>{error}</div>}
          <button className={styles.formSubmit} type="button" disabled={!valid || loading} onClick={handleReset}>
            {loading ? 'Resetting...' : 'Reset password'}
          </button>
        </form>
      </div>
    </AuthShell>
  );
}
