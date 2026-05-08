import styles from '../legal-pages.module.css';

export default function PrivacyPage() {
  return (
    <div className={styles.pageBackground}>
      <div className={styles.page}>
        <div className={styles.header}>
          <h1>Privacy Policy</h1>
          <p>How ScopeSplit collects, uses, and protects your information when you use our platform.</p>
        </div>

        <div className={styles.card}>
          <div className={styles.meta}>Effective date: April 23, 2026</div>

          <section className={styles.section}>
            <h2>Information we collect</h2>
            <p>
              We collect account information (like name and email), billing details handled through Stripe,
              usage data needed to run the app, and estimate files and comparison outputs you upload.
            </p>
          </section>

          <section className={styles.section}>
            <h2>How we use information</h2>
            <ul>
              <li>Provide, maintain, and improve ScopeSplit</li>
              <li>Process comparisons and generate dispute-ready outputs</li>
              <li>Authenticate users and secure accounts</li>
              <li>Process billing and subscription events</li>
              <li>Respond to support and bug-report requests</li>
            </ul>
          </section>

          <section className={styles.section}>
            <h2>Vendors and subprocessors</h2>
            <p>
              We use service providers including Clerk (authentication), Stripe (billing), Supabase (data/storage),
              Anthropic (AI processing), and Resend (support email delivery) to operate the product.
            </p>
          </section>

          <section className={styles.section}>
            <h2>Data retention and deletion</h2>
            <p>
              You can delete comparisons from your account. Account deletion requests remove associated account data,
              except where we must retain records for security, fraud prevention, legal, or accounting purposes.
            </p>
          </section>

          <section className={styles.section}>
            <h2>Contact</h2>
            <p>
              Questions about privacy can be sent through our <a href="/contact">Contact page</a>.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
