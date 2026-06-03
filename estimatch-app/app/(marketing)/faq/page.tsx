'use client';

import Link from 'next/link';
import { useState } from 'react';
import styles from './page.module.css';

const faqData = [
  {
    section: 'General',
    items: [
      { q: 'What is ScopeSplit?', a: 'ScopeSplit is an estimate comparison tool built specifically for roofing and restoration contractors. It takes two Xactimate estimate PDFs — yours and the insurance adjuster\'s — and automatically compares them line by line, highlighting matches, modifications, missing items, and items the adjuster added. This helps you build stronger disputes faster.' },
      { q: 'Who is this tool for?', a: 'ScopeSplit is built for roofing and restoration contractors, estimators, and public adjusters who regularly compare their Xactimate estimates against insurance adjuster estimates. If you spend hours highlighting and cross-referencing PDFs, this tool is for you.' },
      { q: 'Is ScopeSplit supported on tablet and phone?', a: 'Yes. ScopeSplit is supported on desktop, tablet, and mobile devices, so you can review comparisons and reports from the office or in the field.' },
      { q: 'Can I edit ScopeSplit comparisons and export them as PDFs?', a: 'Yes. Once a comparison is generated, you can make changes to line items, add notes, and export the finalized comparison as a PDF.' },
      { q: 'How long does a comparison take?', a: 'Most comparisons complete in under 3 minutes. The time depends on the size of the estimates, but even large multi-zone estimates typically finish in under 5 minutes.' },
    ]
  },
  {
    section: 'SOftware Compatability',
    items: [
      { q: 'What file formats do you support?', a: 'We support Xactimate estimate PDFs — the standard PDF export from Xactimate. This is the format most insurance companies and contractors use to share estimates. Simply export your estimate as a PDF from Xactimate and upload it.' },
      { q: 'What estimate software does SplitScope support?', a: 'ScopeSplit supports both Xactimate and Symbility formats. You can compare Xactimate-to-Xactimate, Symbility-to-Symbility, and cross-compare Xactimate against Symbility to review differences line by line.' },
      { q: 'What if the two estimates use different zone names?', a: 'Our AI engine fuzzy-matches items even when zone names and descriptions differ slightly between the two estimates. For example, it will correctly match "Master Bedroom" with "MBR" or "Owner\'s Suite" and pair similar line items across zones.' },
    ]
  },
  {
    section: 'Pricing & Billing',
    items: [
      { q: 'Is there a free trial?', a: 'Yes! Every new account gets a 7-day free trial with up to 3 comparisons. No credit card is required to start. You can cancel anytime during the trial at no cost.' },
      { q: 'What plans do you offer?', a: 'We offer three plans: Starter ($59/month, 10 comparisons), Professional ($179/month, 35 comparisons), and Business ($349/month, 100 comparisons). All plans include the same features — the difference is the number of comparisons you can run each month.' },
      { q: 'Can I purchase additional comparisons if I run out?', a: 'Yes. You can purchase additional comparison packs on your current tier without upgrading your monthly plan.' },
      { q: 'Can I change or cancel my plan?', a: 'Absolutely. You can upgrade, downgrade, or cancel your plan at any time from the Settings page. If you cancel, you\'ll retain access until the end of your current billing period. Upgrades take effect immediately with prorated billing.' },
    ]
  },
  {
    section: 'Data & Security',
    items: [
      { q: 'Is my data secure?', a: 'Yes. All data is encrypted in transit (TLS/SSL) and at rest. Your uploaded PDFs are stored securely and are only accessible by your account. We use Supabase for data storage and Clerk for authentication — both industry-standard, SOC 2 compliant services.' },
      { q: 'Can I delete my data?', a: 'Yes. You can delete individual comparisons at any time from the Comparisons page. If you\'d like to delete your entire account and all associated data, you can do so from the Settings page. Account deletion is permanent and cannot be undone.' },
      { q: 'Do you use my estimates for training AI models?', a: 'No. Your estimate data is never used for AI model training. We use the Anthropic Claude API to process comparisons, and per Anthropic\'s API terms, data sent through the API is not used for model training. Your estimates remain private.' },
    ]
  }
];

export default function FaqPage() {
  const [openIndex, setOpenIndex] = useState<string | null>(null);

  const toggleItem = (key: string) => {
    setOpenIndex(prev => prev === key ? null : key);
  };

  return (
    <div className={styles.pageBackground}>
      <div className={styles.pageHeader}>
        <h1>Frequently Asked Questions</h1>
        <p>Everything you need to know about ScopeSplit and how it works with your Xactimate estimates.</p>
      </div>

      <div className={styles.faqContainer}>
        {faqData.map((section, si) => (
          <div key={si}>
            <div className={styles.faqSectionTitle}>{section.section}</div>
            {section.items.map((item, ii) => {
              const key = `${si}-${ii}`;
              const isOpen = openIndex === key;
              return (
                <div key={key} className={`${styles.faqItem} ${isOpen ? styles.faqItemOpen : ''}`}>
                  <button className={styles.faqQuestion} onClick={() => toggleItem(key)}>
                    {item.q}
                    <svg className={styles.faqChevron} viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9" /></svg>
                  </button>
                  <div className={styles.faqAnswer}>
                    <div className={styles.faqAnswerInner}>{item.a}</div>
                  </div>
                </div>
              );
            })}
          </div>
        ))}

        <div className={styles.faqCta}>
          <h3>Still have questions?</h3>
          <p>We&apos;d love to help. Reach out and we&apos;ll get back to you within 24 hours.</p>
          <Link className={styles.faqCtaBtn} href="/contact">Contact us</Link>
        </div>
      </div>
    </div>
  );
}
