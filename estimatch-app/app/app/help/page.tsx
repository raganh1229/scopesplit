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
      { q: 'Is ScopeSplit supported on tablet and phone?', a: 'Yes. ScopeSplit is supported on desktop, tablet, and mobile devices, so you can review comparisons and reports from the office or in the field. Note that editing comparisons — modifying line items, adding notes, and making changes — requires a tablet or desktop. Mobile is supported for viewing and reviewing only.' },
      { q: 'Can I edit ScopeSplit comparisons and export them as PDFs?', a: 'Yes. Once a comparison is generated, you can make changes to line items, add notes, and export the finalized comparison as a PDF.' },
      { q: 'How long does a comparison take?', a: 'Most comparisons complete in under 3 minutes. The time depends on the size of the estimates, but even large multi-zone estimates typically finish in under 5 minutes.' },
    ],
  },
  {
    title: 'Software Compatibility',
    items: [
      { q: 'What file formats do you support?', a: 'We support Xactimate PDFs, Symbility PDFs, and Xactimate XLS/CSV exports. You can also run cross-format comparisons — for example, comparing an Xactimate estimate against a Symbility estimate. Simply export your estimate in any supported format and upload it.' },
      { q: 'What estimate software does SplitScope support?', a: 'ScopeSplit supports both Xactimate and Symbility formats. You can compare Xactimate-to-Xactimate, Symbility-to-Symbility, and cross-compare Xactimate against Symbility to review differences line by line.' },
      { q: 'What if the two estimates use different zone names?', a: 'Our AI engine fuzzy-matches items even when zone names and descriptions differ slightly between the two estimates. For example, it will correctly match "Master Bedroom" with "MBR" or "Owner’s Suite" and pair similar line items across zones.' },
    ],
  },
  {
    title: 'Pricing & Billing',
    items: [
      { q: 'Is there a free trial?', a: 'Yes! Every new account gets a 7-day free trial with up to 3 comparisons. No credit card is required to start. You can cancel anytime during the trial at no cost.' },
      { q: 'What plans do you offer?', a: 'We offer three plans: Starter ($59/month, 10 comparisons), Professional ($179/month, 35 comparisons), and Business ($349/month, 100 comparisons). All plans include the same features — the difference is the number of comparisons you can run each month.' },
      { q: 'Can I purchase additional comparisons if I run out?', a: 'Yes. You can purchase additional comparison packs on your current tier without upgrading your monthly plan.' },
      { q: 'Can I change or cancel my plan?', a: 'Absolutely. You can upgrade, downgrade, or cancel your plan at any time from the Settings page. If you cancel, you’ll retain access until the end of your current billing period. Upgrades take effect immediately with prorated billing.' },
    ],
  },
  {
    title: 'Data & Security',
    items: [
      { q: 'Is my data secure?', a: 'Yes. All data is encrypted in transit (TLS/SSL) and at rest. Your uploaded PDFs are stored securely and are only accessible by your account. We use Supabase for data storage and Clerk for authentication — both industry-standard, SOC 2 compliant services.' },
      { q: 'Can I delete my data?', a: 'Yes. You can delete individual comparisons at any time from the Comparisons page. To delete your entire account and all associated data, please submit a Contact Us request — our team will process it promptly. Account deletion is permanent and cannot be undone. You can cancel your subscription at any time from the Settings page.' },
      { q: 'Do you use my estimates for training AI models?', a: 'No. Your estimate data is never used for AI model training. We use the Anthropic Claude API to process comparisons, and per Anthropic’s API terms, data sent through the API is not used for model training. Your estimates remain private.' },
    ],
  },
];

/* ── Patch notes data ── */
type PatchBadge = 'new' | 'fix' | 'improved';
interface PatchSection { badge: PatchBadge; label: string; items: string[] }
interface PatchEntry { version: string; date: string; title: string; subtitle: string; sections: PatchSection[] }

const BADGE_LABEL: Record<PatchBadge, string> = { new: 'New', fix: 'Fix', improved: 'Improved' };

const patchEntries: PatchEntry[] = [
  {
    version: 'v1.0.0',
    date: 'June 3, 2026',
    title: 'Initial Public Launch',
    subtitle: 'ScopeSplit is now live. This is the complete feature set included in our first public release — everything built from the ground up for v1.0.',
    sections: [
      {
        badge: 'new',
        label: 'Comparison Engine',
        items: [
          'AI-powered line-by-line comparison of contractor vs. adjuster estimates using the N3/N4 multi-format pipeline',
          'Supports Xactimate PDF, Symbility PDF, and Xactimate XLS/XLSX/CSV exports',
          'Cross-format comparisons — compare a Xactimate estimate against a Symbility estimate in a single run',
          'AI zone detection identifies all rooms and sections in both estimates, matching zones even when names differ (e.g. "Master Bedroom" vs. "MBR")',
          'Five match statuses: Match, Match (Unverified), Modified, Missing, and Adjuster Added',
          'Dollar gap calculation at zone level and across the full comparison',
          '98.5%+ match accuracy on standard Xactimate estimates',
        ],
      },
      {
        badge: 'new',
        label: 'Comparison Detail View',
        items: [
          'Side-by-side breakdown table showing your estimate vs. adjuster values for every line item',
          'Cost columns: Remove, Replace, Tax, O&P, and Total — per line item',
          'Color-coded status pills for instant visual scanning of matches, modifications, and disputes',
          'Expandable zone sections with per-zone dollar totals and item counts',
          'Filter by match status — isolate disputes, missing items, or price modifications with one click',
          'Column visibility toggle to show or hide specific cost breakdowns',
          'Match summary bar with counts and dollar totals for each status category',
        ],
      },
      {
        badge: 'new',
        label: 'Version History & Editing',
        items: [
          'Inline editing of any line item — update descriptions, quantities, or dollar values directly in the table',
          'AI Bulk Edit — describe a change in plain language (e.g. "add 15% overhead to all missing items") and the AI applies it across your estimate',
          'Every save automatically creates a new version snapshot so nothing is ever lost',
          'Full version history — browse all previous versions, activate any snapshot, or delete old versions',
          'Live diff preview showing exactly which line items will change before committing',
        ],
      },
      {
        badge: 'new',
        label: 'Executive Summary',
        items: [
          'AI-generated executive summary report for any completed comparison',
          'Highlights total dollar discrepancies, dispute categories, and key findings at a glance',
          'Export as a professional PDF for client delivery or dispute documentation',
          'Regenerate at any time after editing to reflect the latest version of the comparison',
        ],
      },
      {
        badge: 'new',
        label: 'Notes',
        items: [
          'Attach notes to any individual line item — ideal for dispute context, photo references, or follow-up flags',
          'General comparison-level notes for overall observations',
          'Full create, edit, and delete support on desktop and tablet',
          'View-only notes on mobile — read all notes without risk of accidental edits',
          'Note count badges on line items so nothing gets missed',
        ],
      },
      {
        badge: 'new',
        label: 'PDF Export',
        items: [
          'Export the full comparison as a printable PDF via browser print',
          'Includes comparison header, financial summary charts, zone-by-zone line item table, and notes',
          'Print-optimized layout — sidebar, navigation, and mobile UI hidden automatically in print',
          'Table content flows freely across pages without forced breaks for clean multi-page exports',
        ],
      },
      {
        badge: 'new',
        label: 'Authentication',
        items: [
          'Email/password signup and login with secure credential handling',
          'Google SSO — sign in or sign up with one click',
          'Email verification with a 6-digit code (auto-advance between fields, paste support, resend with cooldown timer)',
          'Forgot password and reset password flows',
          'Phone number verification for trial accounts to prevent free trial abuse',
        ],
      },
      {
        badge: 'new',
        label: 'Subscriptions & Billing',
        items: [
          '7-day free trial with 4 comparisons included — no credit card required',
          'Starter: $59/month — 10 comparisons, 5 AI edits, 3 executive summaries',
          'Professional: $179/month — 35 comparisons, 30 AI edits, 15 executive summaries',
          'Business: $349/month — 100 comparisons, 100 AI edits, 50 executive summaries',
          'One-time comparison add-on packs available for each plan tier when you need more',
          'Upgrade or downgrade at any time — upgrades are prorated immediately, downgrades apply at the next billing cycle',
          'Cancel and resume your subscription from within the app — no redirects to external billing portals',
          'Real-time usage counters in Settings to track remaining comparisons and AI credits',
        ],
      },
      {
        badge: 'new',
        label: 'Mobile Experience',
        items: [
          'Fully responsive design — desktop, tablet, and mobile all supported',
          'Mobile comparison view uses a card layout instead of table for comfortable scrolling on small screens',
          'Mobile filter pills stacked vertically for tap-friendly status filtering',
          'Dedicated "View Notes" button at the top of the mobile comparison for reading notes',
        ],
      },
      {
        badge: 'new',
        label: 'Dark Mode',
        items: [
          'Light mode and Dark mode toggle in Settings → Appearance',
          'Theme preference saved per device and persists across sessions',
          'Full dark palette: deep gray surfaces with high-contrast text and borders',
          'All five status colors have dedicated dark mode variants for consistent readability',
        ],
      },
      {
        badge: 'new',
        label: 'Settings & Account',
        items: [
          'Plan & Billing — view current plan, manage subscription, track usage counts, purchase add-on packs',
          'Appearance — toggle Light or Dark mode',
          'Notifications — opt in or out of product update emails',
          'Account deletion available on request via the Contact Us form',
        ],
      },
      {
        badge: 'new',
        label: 'Help & Support',
        items: [
          'FAQ covering product overview, software compatibility, billing, and data security',
          'Contact Us form with optional screenshot attachments (up to 3 images, delivered to our support team)',
          'Patch Notes — a running public log of everything added, fixed, and improved',
        ],
      },
    ],
  },
];

const MAX_IMAGES = 3;
const MAX_IMAGE_SIZE_MB = 5;
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const tabs = [
  { id: 'faq', label: 'FAQ', icon: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg> },
  { id: 'bug', label: 'Contact Us', icon: <svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg> },
  { id: 'patches', label: 'Patch Notes', icon: <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="9" y1="13" x2="15" y2="13" /><line x1="9" y1="17" x2="12" y2="17" /></svg> },
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
    else if (tab === 'patches') setActiveTab('patches');
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
      <MobileAppBar title={activeTab === 'patches' ? 'Patch Notes' : activeTab === 'bug' ? 'Contact Us' : 'FAQ'} />
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

          {/* ── Patch Notes Tab ── */}
          {activeTab === 'patches' && (
            <div className={styles.patchList}>
              {patchEntries.map((entry) => (
                <div key={entry.version} className={styles.patchEntry}>
                  <div className={styles.patchMeta}>
                    <span className={styles.patchVersionPill}>{entry.version}</span>
                    <span className={styles.patchDate}>{entry.date}</span>
                  </div>
                  <h2 className={styles.patchEntryTitle}>{entry.title}</h2>
                  <p className={styles.patchSubtitle}>{entry.subtitle}</p>
                  <div className={styles.patchSections}>
                    {entry.sections.map((section) => (
                      <div key={section.label} className={styles.patchSection}>
                        <div className={styles.patchSectionHead}>
                          <span className={`${styles.patchBadge} ${section.badge === 'new' ? styles.patchBadgeNew : section.badge === 'fix' ? styles.patchBadgeFix : styles.patchBadgeImproved}`}>
                            {BADGE_LABEL[section.badge]}
                          </span>
                          <span className={styles.patchSectionLabel}>{section.label}</span>
                        </div>
                        <div className={styles.patchItems}>
                          {section.items.map((item, i) => (
                            <div key={i} className={styles.patchItem}>
                              <span className={styles.patchItemDot} />
                              <span>{item}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
