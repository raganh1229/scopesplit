import styles from '../legal-pages.module.css';

export default function CookiesPage() {
  return (
    <div className={styles.pageBackground}>
      <div className={styles.page}>
        <div className={styles.header}>
          <h1>Cookie Policy</h1>
          <p>How cookies and similar technologies are used on ScopeSplit.</p>
        </div>

        <div className={styles.card}>
          <div className={styles.meta}>Effective date: April 23, 2026</div>

          <section className={styles.section}>
            <h2>What are cookies?</h2>
            <p>
              Cookies are small text files stored in your browser that help websites remember preferences,
              authentication state, and usage behavior.
            </p>
          </section>

          <section className={styles.section}>
            <h2>How we use them</h2>
            <ul>
              <li>Essential cookies for sign-in and session security</li>
              <li>Performance and analytics cookies to improve product usability</li>
              <li>Preference cookies to remember interface settings where applicable</li>
            </ul>
          </section>

          <section className={styles.section}>
            <h2>Managing cookies</h2>
            <p>
              You can manage cookies through your browser settings. Disabling certain cookies may affect how parts of
              ScopeSplit function.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
