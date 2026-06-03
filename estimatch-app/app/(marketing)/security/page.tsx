import styles from '../legal-pages.module.css';

export default function SecurityPage() {
  return (
    <div className={styles.pageBackground}>
      <div className={styles.page}>
        <div className={styles.header}>
          <h1>Security</h1>
          <p>How ScopeSplit approaches product and data security.</p>
        </div>

        <div className={styles.card}>
          <section className={styles.section}>
            <h2>Platform safeguards</h2>
            <ul>
              <li>Encrypted transport via HTTPS/TLS</li>
              <li>Authenticated access with Clerk</li>
              <li>Managed infrastructure and data services</li>
              <li>Access controls and role-limited operational access</li>
            </ul>
          </section>

          <section className={styles.section}>
            <h2>Operational security</h2>
            <p>
              We monitor service health, investigate suspicious activity, and patch known vulnerabilities as part of
              regular maintenance and deployment workflows.
            </p>
          </section>

          <section className={styles.section}>
            <h2>Report a security issue</h2>
            <p>
              If you believe you found a vulnerability, contact us immediately through the <a href="/contact">Contact page</a>{' '}
              and include reproduction details.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
