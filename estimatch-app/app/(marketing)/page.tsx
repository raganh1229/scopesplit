import Link from 'next/link';
import Image from 'next/image';
import styles from './page.module.css';
import HeroMockup from '@/components/marketing/HeroMockup';

export default function HomePage() {
  return (
    <>
      <div className={`${styles.sectionBand} ${styles.sectionBandHero}`}>
        {/* Hero */}
        <section className={styles.hero}>
          <div className={styles.heroBadge}>Xactimate ↔ Symbility SUPPORTED</div>
          <Image
            className={styles.heroTitleLogo}
            src="/logo_black.png"
            alt="ScopeSplit"
            width={1200}
            height={300}
            unoptimized
            priority
          />
          <p className={styles.heroSub}>
            ScopeSplit is an AI-powered comparison tool that makes it simple to review Xactimate, Symbility, and other popular estimating platform outputs side by side.
          </p>
          <div className={styles.heroActions}>
            <Link className={styles.btnPrimary} href="/signup">
              <svg viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
              Start free trial
            </Link>
            <a className={styles.btnSecondary} href="#how-it-works">See how it works</a>
          </div>
          <p className={styles.heroNote}>7-day free trial &middot; No credit card required</p>

          <HeroMockup />
        </section>

        {/* Stats */}
        <div className={styles.section} style={{ paddingTop: 0, paddingBottom: 56 }}>
          <div className={styles.stats}>
            <div className={styles.statItem}>
              <span className={`${styles.statNum} ${styles.statNumBlue}`}>2.1 min</span>
              <span className={styles.statLabel}>Average comparison time</span>
            </div>
            <span className={styles.statDivider} />
            <div className={styles.statItem}>
              <span className={`${styles.statNum} ${styles.statNumGreen}`}>$12K</span>
              <span className={styles.statLabel}>Avg dispute recovered</span>
            </div>
            <span className={styles.statDivider} />
            <div className={styles.statItem}>
              <span className={`${styles.statNum} ${styles.statNumAmber}`}>100%</span>
              <span className={styles.statLabel}>Xactimate compatible</span>
            </div>
          </div>
        </div>
      </div>

      {/* How it works */}
      <div className={`${styles.sectionBand} ${styles.sectionBandHowItWorks}`}>
        <section className={styles.section} id="how-it-works">
          <div className={styles.sectionHeaderBlock}>
            <div className={styles.sectionLabelRow}>
              <span className={styles.sectionLabelDot} />
              <div className={styles.sectionLabel}>How it works</div>
            </div>
            <h2 className={styles.sectionTitle}>Three steps. Zero guesswork.</h2>
            <p className={styles.sectionDesc}>Upload your estimates and let our AI do the tedious line-by-line comparison work for you.</p>
          </div>
          <div className={styles.steps}>
            <div className={styles.stepCard}>
              <div className={styles.stepNum}>1</div>
              <h3>Upload both estimates</h3>
              <p>Drop in your Xactimate PDF and the adjuster&apos;s PDF. We support both Xactimate and Symbility formats.</p>
            </div>
            <div className={styles.stepCard}>
              <div className={styles.stepNum}>2</div>
              <h3>AI matches line items</h3>
              <p>Our engine matches items across estimates, even when descriptions and zone names differ slightly.</p>
            </div>
            <div className={styles.stepCard}>
              <div className={styles.stepNum}>3</div>
              <h3>Review the comparison</h3>
              <p>See every match and missing line-items in a clear side-by-side view. Make modifications and download a PDF report to support your dispute.</p>
            </div>
          </div>
        </section>
      </div>

      {/* Features */}
      <div className={`${styles.sectionBand} ${styles.sectionBandFeatures}`}>
        <section className={`${styles.section} ${styles.featuresSection}`}>
          <div className={styles.sectionLabel}>Features</div>
          <h2 className={styles.sectionTitle}>Everything you need to win disputes</h2>
          <p className={`${styles.sectionDesc} ${styles.featuresDesc}`}>Built specifically for roofing and restoration contractors who work insurance claims.</p>
          <div className={styles.features}>
            <div className={styles.featureCard}>
              <div className={`${styles.featureIcon} ${styles.featureIconAmber}`}>
                <svg viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>
              </div>
              <h3>Gap analysis dashboard</h3>
              <p>See total dollar gaps by zone, category, and overall so you know exactly where the biggest discrepancies are.</p>
            </div>
            <div className={styles.featureCard}>
              <div className={`${styles.featureIcon} ${styles.featureIconRed}`}>
                <svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
              </div>
              <h3>Missing item detection</h3>
              <p>Instantly see which line items the adjuster left out entirely so you can include them in your dispute.</p>
            </div>
            <div className={styles.featureCard}>
              <div className={`${styles.featureIcon} ${styles.featureIconGreen}`}>
                <svg viewBox="0 0 24 24"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z" /></svg>
              </div>
              <h3>Edit line items and add notes</h3>
              <p>Make adjustments and add notes to any line item within the report so your dispute package is clear and complete.</p>
            </div>
            <div className={styles.featureCard}>
              <div className={`${styles.featureIcon} ${styles.featureIconBlue}`}>
                <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>
              </div>
              <h3>PDF report export</h3>
              <p>Download a professional comparison report to attach to your dispute or share with the adjuster.</p>
            </div>
          </div>
        </section>
      </div>

      {/* Pricing + CTA */}
      <div className={`${styles.sectionBand} ${styles.sectionBandPricingCta}`}>
        <section className={styles.section} id="pricing">
          <div style={{ textAlign: 'center' }}>
            <div className={styles.sectionLabel}>Pricing</div>
            <h2 className={styles.sectionTitle} style={{ maxWidth: 'none' }}>Simple, transparent pricing</h2>
            <div className={styles.trialCallout}>
              <span className={styles.trialCalloutBadge}>7-Day Free Trial</span>
              <p className={styles.trialCalloutText}>Every plan includes a full 7-day trial. Cancel anytime.</p>
            </div>
          </div>
          <div className={styles.pricingGrid}>
            <div className={styles.pricingCard}>
              <div className={styles.pricingTier}>Starter</div>
              <div className={styles.pricingPrice}>$59<span>/mo</span></div>
              <div className={styles.pricingLimit}>10 comparisons per month</div>
              <ul className={styles.pricingFeatures}>
                <li>AI-powered line-item matching</li>
                <li>Side-by-side comparison table</li>
                <li>Gap analysis dashboard</li>
                <li>PDF report export</li>
                <li>Mobile and desktop access</li>
              </ul>
              <Link className={styles.pricingBtn} href="/signup">Start free trial</Link>
            </div>
            <div className={`${styles.pricingCard} ${styles.pricingCardFeatured}`}>
              <div className={styles.pricingPopular}>Most Popular</div>
              <div className={styles.pricingTier}>Professional</div>
              <div className={styles.pricingPrice}>$179<span>/mo</span></div>
              <div className={styles.pricingLimit}>35 comparisons per month</div>
              <ul className={styles.pricingFeatures}>
                <li>Everything in Starter</li>
                <li>Priority support</li>
                <li>Higher comparison volume</li>
                <li>PDF report export</li>
                <li>Mobile and desktop access</li>
              </ul>
              <Link className={`${styles.pricingBtn} ${styles.pricingBtnFeatured}`} href="/signup">Start free trial</Link>
            </div>
            <div className={styles.pricingCard}>
              <div className={styles.pricingTier}>Business</div>
              <div className={styles.pricingPrice}>$349<span>/mo</span></div>
              <div className={styles.pricingLimit}>100 comparisons per month</div>
              <ul className={styles.pricingFeatures}>
                <li>Everything in Professional</li>
                <li>Maximum volume</li>
                <li>Priority support</li>
                <li>PDF report export</li>
                <li>Mobile and desktop access</li>
              </ul>
              <Link className={styles.pricingBtn} href="/signup">Start free trial</Link>
            </div>
          </div>
          <p className={styles.pricingAddonNote}>
            Additional comparisons can be purchased at any tier without needing to upgrade.
          </p>
        </section>
        <div className={styles.ctaBanner}>
          <div className={styles.ctaBannerInner}>
            <h2>Ready to stop leaving money on the table?</h2>
            <p>Join contractors who are recovering thousands more on every dispute with ScopeSplit.</p>
            <Link className={styles.btnWhite} href="/signup">
              Start your free trial
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
