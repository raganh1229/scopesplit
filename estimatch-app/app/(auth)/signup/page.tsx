'use client';

import Link from 'next/link';
import { useState, useCallback } from 'react';
import { useSignUp } from '@clerk/nextjs/legacy';
import { useClerk } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';
import AuthShell from '@/components/auth/AuthShell';
import styles from '@/styles/auth.module.css';
import local from './page.module.css';

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

export default function SignupPage() {
  const [showPw, setShowPw] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [emailVal, setEmailVal] = useState('');
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [captcha, setCaptcha] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { signUp, isLoaded } = useSignUp();
  const router = useRouter();

  const strength = getStrength(pw);
  const mismatch = confirm.length > 0 && confirm !== pw;
  const valid = pw.length >= 8 && confirm === pw && captcha;

  const handlePwToggle = useCallback(() => setShowPw(v => !v), []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isLoaded || !signUp || !valid) return;

    const trimmedFirstName = firstName.trim();
    const trimmedLastName = lastName.trim();

    if (!trimmedFirstName || !trimmedLastName) {
      setError('Please enter your first and last name.');
      return;
    }

    setError('');
    setLoading(true);
    try {
      await signUp.create({
        firstName: trimmedFirstName,
        lastName: trimmedLastName,
        emailAddress: emailVal,
        password: pw,
      });
      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
      router.push('/verify');
    } catch (err: unknown) {
      const clerkError = err as { errors?: { message?: string }[] };
      setError(clerkError.errors?.[0]?.message || 'Sign up failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const { signOut } = useClerk();

  const handleGoogle = async () => {
    if (!isLoaded || !signUp) return;
    try {
      await signUp.authenticateWithRedirect({
        strategy: 'oauth_google',
        redirectUrl: '/sso-callback',
        redirectUrlComplete: '/subscribe',
      });
    } catch (err: unknown) {
      const clerkError = err as { errors?: { code?: string; message?: string }[] };
      const code = clerkError.errors?.[0]?.code;
      if (code === 'session_exists') {
        await signOut();
        await signUp.authenticateWithRedirect({
          strategy: 'oauth_google',
          redirectUrl: '/sso-callback',
          redirectUrlComplete: '/subscribe',
        });
      } else {
        setError(clerkError.errors?.[0]?.message || 'Google sign-up failed.');
      }
    }
  };

  return (
    <AuthShell>
      <div className={styles.card}>
        <h1>Create your account</h1>
        <p className={styles.subtitle}>Start comparing estimates in minutes</p>

        <button className={styles.googleBtn} type="button" onClick={handleGoogle}>
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
          </svg>
          Continue with Google
        </button>

        <div className={styles.divider}><span className={styles.dividerText}>or</span></div>

        <form onSubmit={handleSubmit}>
          <div className={styles.formGroup}>
            <label className={styles.formLabel} htmlFor="firstName">First name</label>
            <input
              className={styles.formInput}
              type="text"
              id="firstName"
              placeholder="Jane"
              value={firstName}
              onChange={e => setFirstName(e.target.value)}
              required
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel} htmlFor="lastName">Last name</label>
            <input
              className={styles.formInput}
              type="text"
              id="lastName"
              placeholder="Doe"
              value={lastName}
              onChange={e => setLastName(e.target.value)}
              required
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel} htmlFor="email">Email address</label>
            <input className={styles.formInput} type="email" id="email" placeholder="you@example.com" value={emailVal} onChange={e => setEmailVal(e.target.value)} required />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel} htmlFor="password">Password</label>
            <div className={styles.passwordWrap}>
              <input
                className={styles.formInput}
                type={showPw ? 'text' : 'password'}
                id="password"
                placeholder="Create a password"
                value={pw}
                onChange={e => setPw(e.target.value)}
              />
              <button className={styles.pwToggle} type="button" onClick={handlePwToggle} aria-label="Show password">
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
            <label className={styles.formLabel} htmlFor="confirmPassword">Confirm password</label>
            <input
              className={`${styles.formInput} ${mismatch ? styles.formInputError : ''}`}
              type="password"
              id="confirmPassword"
              placeholder="Confirm your password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
            />
            {mismatch && <div className={styles.formErrorShow}>Passwords do not match.</div>}
          </div>

          <div className={local.captchaBox} onClick={() => setCaptcha(!captcha)}>
            <div className={`${local.captchaCheck} ${captcha ? local.checked : ''}`} />
            <span className={local.captchaLabel}>I&apos;m not a robot</span>
            <span className={local.captchaBrand}>Turnstile</span>
          </div>

          <div id="clerk-captcha" />
          {error && <div className={styles.formErrorShow}>{error}</div>}
          <button className={styles.formSubmit} type="submit" disabled={!valid || loading}>
            {loading ? 'Creating account...' : 'Sign up'}
          </button>
        </form>

        <div className={styles.terms}>
          By signing up, you agree to our <a href="#">Terms of Service</a> and <a href="#">Privacy Policy</a>.
        </div>
      </div>

      <div className={styles.footer}>
        Already have an account? <Link href="/login">Sign in</Link>
      </div>
    </AuthShell>
  );
}
