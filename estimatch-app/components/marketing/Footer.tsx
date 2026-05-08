import Link from 'next/link';
import Image from 'next/image';
import styles from './Footer.module.css';

export default function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <Link className={styles.logo} href="/">
          <Image src="/logo_black.png" alt="ScopeSplit" width={360} height={84} unoptimized className={styles.logoImg} />
        </Link>
        <div className={styles.linkGrid}>
          <div className={styles.linkGroup}>
            <div className={styles.groupTitle}>Company</div>
            <div className={styles.links}>
              <Link className={styles.link} href="/">Home</Link>
              <Link className={styles.link} href="/faq">FAQ</Link>
              <Link className={styles.link} href="/contact">Contact</Link>
              <Link className={styles.link} href="/login">Log in</Link>
              <Link className={styles.link} href="/signup">Sign up</Link>
            </div>
          </div>

          <div className={styles.linkGroup}>
            <div className={styles.groupTitle}>Legal</div>
            <div className={styles.links}>
              <Link className={styles.link} href="/privacy">Privacy Policy</Link>
              <Link className={styles.link} href="/terms">Terms of Service</Link>
              <Link className={styles.link} href="/cookies">Cookie Policy</Link>
              <Link className={styles.link} href="/privacy-choices">Your Privacy Choices</Link>
              <Link className={styles.link} href="/security">Security</Link>
              <Link className={styles.link} href="/acceptable-use">Acceptable Use</Link>
              <Link className={styles.link} href="/billing-refunds">Billing &amp; Refunds</Link>
              <Link className={styles.link} href="/data-processing-addendum">Data Processing Addendum</Link>
            </div>
          </div>
        </div>
        <div className={styles.copy}>&copy; 2026 ScopeSplit. All rights reserved.</div>
      </div>
    </footer>
  );
}
