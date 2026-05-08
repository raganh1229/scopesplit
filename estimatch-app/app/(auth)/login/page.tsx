'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useSignIn } from '@clerk/nextjs/legacy';
import { useUser } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';
import AuthShell from '@/components/auth/AuthShell';
import styles from '@/styles/auth.module.css';

export default function LoginPage() {
  const [showPw, setShowPw] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { signIn, setActive, isLoaded } = useSignIn();
  const { isSignedIn, isLoaded: isUserLoaded } = useUser();
  const router = useRouter();

  useEffect(() => {
    if (isUserLoaded && isSignedIn) {
      router.replace('/subscribe');
    }
  }, [isSignedIn, isUserLoaded, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isLoaded || !signIn) return;
    setError('');
    setLoading(true);
    try {
      const result = await signIn.create({ identifier: email, password });
      if (result.status === 'complete' && result.createdSessionId) {
        await setActive({ session: result.createdSessionId });
        router.push('/subscribe');
      }
    } catch (err: unknown) {
      const clerkError = err as { errors?: { code?: string; message?: string }[] };
      const code = clerkError.errors?.[0]?.code;
      if (code === 'session_exists') {
        router.replace('/subscribe');
      } else {
        setError(clerkError.errors?.[0]?.message || 'Invalid email or password.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    if (!isLoaded || !signIn) return;
    try {
      await signIn.authenticateWithRedirect({
        strategy: 'oauth_google',
        redirectUrl: '/sso-callback',
        redirectUrlComplete: '/subscribe',
      });
    } catch (err: unknown) {
      const clerkError = err as { errors?: { message?: string }[] };
      setError(clerkError.errors?.[0]?.message || 'Google sign-in failed.');
    }
  };

  return (
    <AuthShell>
      <div className={styles.card}>
        <h1>Welcome back</h1>
        <p className={styles.subtitle}>Sign in to your account</p>

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
            <label className={styles.formLabel} htmlFor="email">Email address</label>
            <input className={styles.formInput} type="email" id="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} required />
          </div>
          <div className={styles.formGroup}>
            <div className={styles.formRow}>
              <label className={styles.formLabel} htmlFor="password" style={{ marginBottom: 0 }}>Password</label>
              <Link className={styles.forgotLink} href="/forgot-password">Forgot password?</Link>
            </div>
            <div className={styles.passwordWrap} style={{ marginTop: 6 }}>
              <input className={styles.formInput} type={showPw ? 'text' : 'password'} id="password" placeholder="Enter your password" value={password} onChange={e => setPassword(e.target.value)} required />
              <button className={styles.pwToggle} type="button" onClick={() => setShowPw(!showPw)} aria-label="Show password">
                {showPw ? (
                  <svg viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
                ) : (
                  <svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                )}
              </button>
            </div>
          </div>
          {error && <div className={styles.formErrorShow}>{error}</div>}
          <button className={styles.formSubmit} type="submit" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>

      <div className={styles.footer}>
        Don&apos;t have an account? <Link href="/signup">Sign up</Link>
      </div>
    </AuthShell>
  );
}
