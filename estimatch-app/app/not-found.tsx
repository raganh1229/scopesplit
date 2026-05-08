import Link from 'next/link';
import styles from './error-page.module.css';

export default function NotFound() {
  return (
    <div className={styles.wrapper}>
      <div className={styles.illustration}>
        <div className={styles.hat} />
        <div className={styles.question}>?</div>
      </div>
      <div className={styles.code}>Error 404</div>
      <h1 className={styles.title}>Page not found</h1>
      <p className={styles.desc}>The page you&apos;re looking for doesn&apos;t exist or has been moved.</p>
      <div className={styles.actions}>
        <Link className={styles.btnPrimary} href="/">Go home</Link>
      </div>
      <div className={styles.foot}>
        If this keeps happening, <Link href="/contact">contact support</Link>.
      </div>
    </div>
  );
}
