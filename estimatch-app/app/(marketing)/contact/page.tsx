'use client';

import Link from 'next/link';
import { useState } from 'react';
import styles from './page.module.css';

export default function ContactPage() {
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const handleSubmit = async () => {
    const name = (document.getElementById('contactName') as HTMLInputElement).value.trim();
    const email = (document.getElementById('contactEmail') as HTMLInputElement).value.trim();
    const message = (document.getElementById('contactMessage') as HTMLTextAreaElement).value.trim();

    if (!name || !email || !message) {
      setSubmitError('Please fill in all fields.');
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, message }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Failed to send your message.');
      }

      setSent(true);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to send your message.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.pageBackground}>
      <div className={styles.contactPage}>
        <h1>Contact Us</h1>
        <p className={styles.subtitle}>Have a question, feedback, or need help? Send us a message and we&apos;ll get back to you within 24 hours.</p>

        {!sent ? (
          <div className={styles.contactForm}>
            <div className={styles.formGroup}>
              <label className={styles.formLabel} htmlFor="contactName">Full name</label>
              <input className={styles.formInput} type="text" id="contactName" placeholder="Your name" />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.formLabel} htmlFor="contactEmail">Email address</label>
              <input className={styles.formInput} type="email" id="contactEmail" placeholder="you@example.com" />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.formLabel} htmlFor="contactMessage">Message</label>
              <textarea className={`${styles.formInput} ${styles.textarea}`} id="contactMessage" placeholder="How can we help?" />
            </div>
            {submitError && <p style={{ color: '#dc2626', marginTop: '-8px', marginBottom: '8px', fontSize: '14px' }}>{submitError}</p>}
            <button className={styles.formSubmit} type="button" onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Sending…' : 'Send message'}
            </button>
          </div>
        ) : (
          <div className={styles.contactSuccess}>
            <div className={styles.successIcon}>
              <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>
            </div>
            <h2>Message sent</h2>
            <p>Thanks for reaching out. We&apos;ll get back to you within 24 hours.</p>
            <Link href="/">&larr; Back to home</Link>
          </div>
        )}

      </div>
    </div>
  );
}
