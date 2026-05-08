import styles from '../legal-pages.module.css';

export default function DataProcessingAddendumPage() {
  return (
    <div className={styles.pageBackground}>
      <div className={styles.page}>
        <div className={styles.header}>
          <h1>Data Processing Addendum</h1>
          <p>Terms for customers that require a formal data processing framework.</p>
        </div>

        <div className={styles.card}>
          <div className={styles.meta}>Effective date: April 23, 2026</div>

          <section className={styles.section}>
            <h2>Roles</h2>
            <p>
              For customer content, the customer acts as data controller and ScopeSplit acts as data processor,
              processing data only on documented customer instructions.
            </p>
          </section>

          <section className={styles.section}>
            <h2>Security measures</h2>
            <p>
              ScopeSplit maintains administrative, technical, and organizational safeguards intended to protect
              personal data against unauthorized access, alteration, disclosure, and destruction.
            </p>
          </section>

          <section className={styles.section}>
            <h2>Subprocessors</h2>
            <p>
              ScopeSplit uses vetted subprocessors to deliver services. Current infrastructure and service providers
              are listed in our Privacy Policy.
            </p>
          </section>

          <section className={styles.section}>
            <h2>Requesting a signed DPA</h2>
            <p>
              To request a signed DPA for your organization, contact us through the <a href="/contact">Contact page</a>
              with your legal entity name and billing email.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
