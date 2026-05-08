import styles from '../legal-pages.module.css';

export default function PrivacyChoicesPage() {
  return (
    <div className={styles.pageBackground}>
      <div className={styles.page}>
        <div className={styles.header}>
          <h1>Your Privacy Choices</h1>
          <p>Options and rights related to your personal information.</p>
        </div>

        <div className={styles.card}>
          <section className={styles.section}>
            <h2>Access, update, or delete data</h2>
            <p>
              You can request access to, correction of, or deletion of personal information associated with your
              account, subject to legal and security obligations.
            </p>
          </section>

          <section className={styles.section}>
            <h2>Marketing and communication preferences</h2>
            <p>
              You can opt out of non-essential communications at any time using unsubscribe links or by contacting us.
            </p>
          </section>

          <section className={styles.section}>
            <h2>Region-specific rights</h2>
            <p>
              Depending on where you live, you may have additional rights under privacy laws such as CCPA/CPRA or
              GDPR. We honor valid requests in accordance with applicable law.
            </p>
          </section>

          <section className={styles.section}>
            <h2>Submit a request</h2>
            <p>
              Use our <a href="/contact">Contact page</a> and include &quot;Privacy Request&quot; in your message subject.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
