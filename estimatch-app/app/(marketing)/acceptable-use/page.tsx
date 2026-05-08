import styles from '../legal-pages.module.css';

export default function AcceptableUsePage() {
  return (
    <div className={styles.pageBackground}>
      <div className={styles.page}>
        <div className={styles.header}>
          <h1>Acceptable Use Policy</h1>
          <p>Rules that keep ScopeSplit reliable and safe for all customers.</p>
        </div>

        <div className={styles.card}>
          <section className={styles.section}>
            <h2>Allowed use</h2>
            <p>
              Use ScopeSplit for lawful estimate comparison and dispute preparation workflows within your business.
            </p>
          </section>

          <section className={styles.section}>
            <h2>Prohibited activity</h2>
            <ul>
              <li>Attempting to access data that is not yours</li>
              <li>Uploading malware or harmful code</li>
              <li>Abusing rate limits, automation, or service infrastructure</li>
              <li>Reverse engineering, scraping, or unauthorized data extraction</li>
              <li>Using the platform for unlawful, deceptive, or fraudulent conduct</li>
            </ul>
          </section>

          <section className={styles.section}>
            <h2>Enforcement</h2>
            <p>
              We may suspend or terminate accounts that violate this policy to protect the platform and other users.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
