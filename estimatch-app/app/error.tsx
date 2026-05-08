'use client';

import Link from 'next/link';
import styles from './error-page.module.css';

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className={styles.wrapper}>
      <div className={styles.illustration}>
        <div className={styles.hat} />
        <div className={styles.question}>?</div>
      </div>
      <div className={styles.code}>Error 500</div>
      <h1 className={styles.title}>Well, that wasn&apos;t in the estimate</h1>
      <p className={styles.desc}>Something went wrong on our end. We&apos;re looking into it.</p>
      <div className={styles.actions}>
        <Link className={styles.btnPrimary} href="/">Go home</Link>
        <button className={styles.btnSecondary} onClick={reset}>Try again</button>
      </div>
      <div className={styles.foot}>
        If this keeps happening, <Link href="/contact">contact support</Link>.
      </div>
    </div>
  );
}
