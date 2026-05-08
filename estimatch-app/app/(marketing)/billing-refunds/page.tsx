import styles from '../legal-pages.module.css';

export default function BillingRefundsPage() {
  return (
    <div className={styles.pageBackground}>
      <div className={styles.page}>
        <div className={styles.header}>
          <h1>Billing & Refund Policy</h1>
          <p>Important details about subscriptions, renewals, and cancellations.</p>
        </div>

        <div className={styles.card}>
          <section className={styles.section}>
            <h2>Subscriptions and renewals</h2>
            <p>
              Paid plans renew automatically at the end of each billing period unless canceled beforehand from account
              settings.
            </p>
          </section>

          <section className={styles.section}>
            <h2>Upgrades and downgrades</h2>
            <p>
              Plan upgrades take effect immediately. Downgrades take effect at the next billing cycle unless otherwise
              stated in your account.
            </p>
          </section>

          <section className={styles.section}>
            <h2>Refunds</h2>
            <p>
              Fees are generally non-refundable unless required by law or explicitly approved by ScopeSplit in writing.
            </p>
          </section>

          <section className={styles.section}>
            <h2>Questions about charges</h2>
            <p>
              If you believe a charge is incorrect, contact support through our <a href="/contact">Contact page</a>
              with your account email and invoice details.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
