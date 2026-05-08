'use client';

import { useState, useRef, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import MobileAppBar from '@/components/app/MobileAppBar';
import TrialBanner from '@/components/app/TrialBanner';
import styles from './page.module.css';

/* ── FAQ data ── */
interface FaqItem { q: string; a: string }
interface FaqSection { title: string; items: FaqItem[] }

const faqSections: FaqSection[] = [
  {
    title: 'General',
    items: [
      { q: 'What is ScopeSplit?', a: 'ScopeSplit is an estimate comparison tool built specifically for roofing and restoration contractors. It takes two Xactimate estimate PDFs — yours and the insurance adjuster’s — and automatically compares them line by line, highlighting matches, modifications, missing items, and items the adjuster added. This helps you build stronger disputes faster.' },
      { q: 'Who is this tool for?', a: 'ScopeSplit is built for roofing and restoration contractors, estimators, and public adjusters who regularly compare their Xactimate estimates against insurance adjuster estimates. If you spend hours highlighting and cross-referencing PDFs, this tool is for you.' },
      { q: 'Is ScopeSplit supported on tablet and phone?', a: 'Yes. ScopeSplit is supported on desktop, tablet, and mobile devices, so you can review comparisons and reports from the office or in the field.' },
      { q: 'Can I edit ScopeSplit comparisons and export them as PDFs?', a: 'Yes. Once a comparison is generated, you can make changes to line items, add notes, and export the finalized comparison as a PDF.' },
      { q: 'How long does a comparison take?', a: 'Most comparisons complete in under 3 minutes. The time depends on the size of the estimates, but even large multi-zone estimates typically finish in under 5 minutes.' },
    ],
  },
  {
    title: 'SOftware Compatability',
    items: [
      { q: 'What file formats do you support?', a: 'We support Xactimate estimate PDFs — the standard PDF export from Xactimate. This is the format most insurance companies and contractors use to share estimates. Simply export your estimate as a PDF from Xactimate and upload it.' },
      { q: 'What estimate software does SplitScope support?', a: 'ScopeSplit supports both Xactimate and Symbility formats. You can compare Xactimate-to-Xactimate, Symbility-to-Symbility, and cross-compare Xactimate against Symbility to review differences line by line.' },
      { q: 'What if the two estimates use different zone names?', a: 'Our AI engine fuzzy-matches items even when zone names and descriptions differ slightly between the two estimates. For example, it will correctly match "Master Bedroom" with "MBR" or "Owner’s Suite" and pair similar line items across zones.' },
    ],
  },
  {
    title: 'Pricing & Billing',
    items: [
      { q: 'Is there a free trial?', a: 'Yes! Every new account gets a 7-day free trial with up to 3 comparisons. No credit card is required to start. You can cancel anytime during the trial at no cost.' },
      { q: 'What plans do you offer?', a: 'We offer three plans: Starter ($49.99/month, 10 comparisons), Professional ($99/month, 50 comparisons), and Business ($249/month, 200 comparisons). All plans include the same features — the difference is the number of comparisons you can run each month.' },
      { q: 'Can I purchase additional comparisons if I run out?', a: 'Yes. You can purchase additional comparison packs on your current tier without upgrading your monthly plan.' },
      { q: 'Can I change or cancel my plan?', a: 'Absolutely. You can upgrade, downgrade, or cancel your plan at any time from the Settings page. If you cancel, you’ll retain access until the end of your current billing period. Upgrades take effect immediately with prorated billing.' },
    ],
  },
  {
    title: 'Data & Security',
    items: [
      { q: 'Is my data secure?', a: 'Yes. All data is encrypted in transit (TLS/SSL) and at rest. Your uploaded PDFs are stored securely and are only accessible by your account. We use Supabase for data storage and Clerk for authentication — both industry-standard, SOC 2 compliant services.' },
      { q: 'Can I delete my data?', a: 'Yes. You can delete individual comparisons at any time from the Comparisons page. If you’d like to delete your entire account and all associated data, you can do so from the Settings page. Account deletion is permanent and cannot be undone.' },
      { q: 'Do you use my estimates for training AI models?', a: 'No. Your estimate data is never used for AI model training. We use the Anthropic Claude API to process comparisons, and per Anthropic’s API terms, data sent through the API is not used for model training. Your estimates remain private.' },
    ],
  },
];

const MAX_IMAGES = 3;
const MAX_IMAGE_SIZE_MB = 5;
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const tabs = [
  { id: 'faq', label: 'FAQ', icon: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg> },
  { id: 'bug', label: 'Contact Us', icon: <svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg> },
];

// Next.js requires `useSearchParams()` to be inside a Suspense boundary so
// the page can be statically prerendered. The default export wraps the
// actual content in <Suspense>; HelpContent below is the real page.
export default function HelpPage() {
  return (
    <Suspense fallback={null}>
      <HelpContent />
    </Suspense>
  );
}

function HelpContent() {
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState('faq');

  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab === 'bug') setActiveTab('bug');
  }, [searchParams]);
  const [openFaq, setOpenFaq] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [images, setImages] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const toggleFaq = (key: string) => {
    setOpenFaq(prev => (prev === key ? null : key));
  };

  const handleAddImages = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    const newFiles: File[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!ALLOWED_IMAGE_TYPES.includes(file.type)) continue;
      if (file.size > MAX_IMAGE_SIZE_MB * 1024 * 1024) continue;
      newFiles.push(file);
    }

    setImages(prev => {
      const combined = [...prev, ...newFiles];
      return combined.slice(0, MAX_IMAGES);
    });

    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleRemoveImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    const name = (document.getElementById('helpName') as HTMLInputElement)?.value.trim();
    const email = (document.getElementById('helpEmail') as HTMLInputElement)?.value.trim();
    const message = (document.getElementById('helpMessage') as HTMLTextAreaElement)?.value.trim();

    if (!name || !email || !message) {
      setSubmitError('Please fill in all required fields.');
      return;
    }


    setSubmitting(true);
    setSubmitError(null);

    try {
      const formData = new FormData();
      formData.append('name', name);
      formData.append('email', email);
      formData.append('message', message);
      images.forEach((img) => formData.append('images', img));

      const res = await fetch('/api/bug-report', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Failed to send your message.');
      }

      setSubmitted(true);
      setImages([]);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to send your message.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <MobileAppBar title="Contact Us" />
      <TrialBanner />

      <div className={styles.helpHeader}>
        <h1>Get Help</h1>
        <p className={styles.helpSubtitle}>Browse common questions or get in touch with our team.</p>
      </div>

      <div className={styles.helpBody}>
        {/* Tabs */}
        <div className={styles.tabs}>
          {tabs.map(t => (
            <button
              key={t.id}
              className={`${styles.tab} ${activeTab === t.id ? styles.tabActive : ''}`}
              onClick={() => setActiveTab(t.id)}
            >
              <span className={styles.tabIcon}>{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>

        {/* Panel */}
        <div className={styles.panel}>
          {/* ── FAQ Tab ── */}
          {activeTab === 'faq' && (
            <>
              {faqSections.map((section, si) => (
                <div key={si}>
                  <div className={styles.faqSectionTitle}>{section.title}</div>
                  {section.items.map((item, qi) => {
                    const key = `${si}-${qi}`;
                    const isOpen = openFaq === key;
                    return (
                      <div key={key} className={styles.faqItem}>
                        <button className={styles.faqQuestion} onClick={() => toggleFaq(key)}>
                          {item.q}
                          <svg className={`${styles.faqChevron} ${isOpen ? styles.faqChevronOpen : ''}`} viewBox="0 0 24 24">
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>
                        <div className={`${styles.faqAnswer} ${isOpen ? styles.faqAnswerOpen : ''}`}>
                          <div className={styles.faqAnswerInner}>{item.a}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </>
          )}

          {/* ── Contact Us Tab ── */}
          {activeTab === 'bug' && !submitted && (
            <>
              <p className={styles.contactIntro}>
                Report a bug, ask a billing question, or get in touch about any other concern. Describe your issue below — attach screenshots if it helps — and we&apos;ll get back to you as soon as possible.
              </p>
              <div className={styles.contactForm}>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel} htmlFor="helpName">Full name</label>
                  <input className={styles.formInput} type="text" id="helpName" placeholder="Your name" />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel} htmlFor="helpEmail">Email address</label>
                  <input className={styles.formInput} type="email" id="helpEmail" placeholder="you@example.com" />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel} htmlFor="helpMessage">Your message</label>
                  <textarea className={`${styles.formInput} ${styles.formTextarea}`} id="helpMessage" placeholder="How can we help? Describe your question, feedback, or any issue you're experiencing." />
                </div>

                {/* Image uploader */}
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Screenshots <span className={styles.formHint}>(optional, up to {MAX_IMAGES})</span></label>
                  <div className={styles.imageUploadArea}>
                    {images.map((img, i) => (
                      <div key={i} className={styles.imageThumb}>
                        <img src={URL.createObjectURL(img)} alt={`Screenshot ${i + 1}`} />
                        <button type="button" className={styles.imageRemove} onClick={() => handleRemoveImage(i)} aria-label="Remove image">&times;</button>
                      </div>
                    ))}
                    {images.length < MAX_IMAGES && (
                      <label className={styles.imageAddBtn}>
                        <svg viewBox="0 0 24 24" width="20" height="20"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                        <span>Add image</span>
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="image/jpeg,image/png,image/gif,image/webp"
                          multiple
                          hidden
                          onChange={handleAddImages}
                        />
                      </label>
                    )}
                  </div>
                </div>

                {submitError && <p className={styles.submitError}>{submitError}</p>}

                <button className={styles.formSubmit} type="button" onClick={handleSubmit} disabled={submitting}>
                  {submitting ? 'Sending...' : 'Send Message'}
                </button>
              </div>
            </>
          )}

          {activeTab === 'bug' && submitted && (
            <div className={styles.contactSuccess}>
              <div className={styles.successIcon}>
                <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>
              </div>
              <h2>Message sent</h2>
              <p>Thanks for reaching out. We&apos;ll look into it and follow up if we need more details.</p>
              <button className={styles.backLink} onClick={() => { setSubmitted(false); setSubmitError(null); }}>
                &larr; Send another message
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
