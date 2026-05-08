import styles from '../legal-pages.module.css';

export default function TermsPage() {
  return (
    <div className={styles.pageBackground}>
      <div className={styles.page}>
        <div className={styles.header}>
          <h1>Terms of Service</h1>
          <p>The rules and responsibilities for using ScopeSplit.</p>
        </div>

        <div className={styles.card}>
          <div className={styles.meta}>Effective date: April 23, 2026</div>

          <section className={styles.section}>
            <h2>Use of service</h2>
            <p>
              ScopeSplit is provided for business use to compare estimate files and assist users in preparing disputes.
              You are responsible for uploaded content and for compliance with your local laws and contracts.
            </p>
          </section>

          <section className={styles.section}>
            <h2>Account security</h2>
            <p>
              You must keep your login credentials secure and are responsible for activity under your account.
            </p>
          </section>

          <section className={styles.section}>
            <h2>Billing and subscriptions</h2>
            <p>
              Paid plans renew according to your selected billing cycle unless canceled. Plan limits and usage caps
              apply based on your active subscription and purchased add-ons.
            </p>
          </section>

          <section className={styles.section}>
            <h2>Disclaimers</h2>
            <p>
              ScopeSplit provides software tools and workflow assistance. Final claim, estimate, and dispute decisions
              remain your responsibility.
            </p>
          </section>

          <section className={styles.section}>
            <h2>Liability limits</h2>
            <p>
              To the fullest extent permitted by law, ScopeSplit is not liable for indirect, incidental, special,
              consequential, or punitive damages arising from use of the service.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
