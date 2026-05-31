'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import MobileAppBar from '@/components/app/MobileAppBar';
import TrialBanner from '@/components/app/TrialBanner';
import styles from './page.module.css';

const ZONE_DETECTION_HEADLINE = 'Compiling zones from your estimates...';

const XLS_MIME_TYPES_CLIENT = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'application/csv',
]);
const XLS_EXTENSIONS_CLIENT = new Set(['.xlsx', '.xls', '.csv']);

function isValidEstimateFile(file: File, format: string): boolean {
  if (format === 'xls') {
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    return XLS_MIME_TYPES_CLIENT.has(file.type) || XLS_EXTENSIONS_CLIENT.has(ext);
  }
  return file.type === 'application/pdf';
}

function acceptAttr(format: string): string {
  return format === 'xls' ? '.xlsx,.xls,.csv' : '.pdf';
}

function fileHint(format: string, side: string): string {
  return format === 'xls'
    ? `Drag & drop ${side} Excel/CSV here, or`
    : `Drag & drop ${side} PDF here, or`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return 'your next billing refresh date';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'your next billing refresh date';

  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

export default function NewComparisonPage() {
  const router = useRouter();
  const [comparisonName, setComparisonName] = useState('');
  const [file1, setFile1] = useState<File | null>(null);
  const [file2, setFile2] = useState<File | null>(null);
  const [format1, setFormat1] = useState<string>('');
  const [format2, setFormat2] = useState<string>('');
  const [processing, setProcessing] = useState(false);
  const [pendingComparisonId, setPendingComparisonId] = useState<string | null>(null);
  const [progressPercent, setProgressPercent] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [qualifiesVisible, setQualifiesVisible] = useState(false);
  const [qualifiesFlash, setQualifiesFlash] = useState(0);
  const qualifiesRef = useRef<HTMLDivElement>(null);

  const handleQualifiesClick = () => {
    setQualifiesVisible(true);
    setQualifiesFlash(f => f + 1);
  };

  useEffect(() => {
    if (qualifiesFlash === 0) return;
    const timer = setTimeout(() => {
      qualifiesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 80);
    return () => clearTimeout(timer);
  }, [qualifiesFlash]);

  const handleDrop = (setter: (file: File) => void, format: string) => (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (!isValidEstimateFile(file, format)) {
      setErrorMessage(
        format === 'xls'
          ? 'Please upload an Excel or CSV file (.xlsx, .xls, .csv).'
          : 'Only PDF files are allowed.',
      );
      return;
    }
    setErrorMessage(null);
    setter(file);
  };

  const handleFile = (setter: (file: File) => void, format: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!isValidEstimateFile(file, format)) {
      setErrorMessage(
        format === 'xls'
          ? 'Please upload an Excel or CSV file (.xlsx, .xls, .csv).'
          : 'Only PDF files are allowed.',
      );
      return;
    }
    setErrorMessage(null);
    setter(file);
  };

  const handleCompare = async () => {
    if (!comparisonName.trim()) {
      setErrorMessage('Please enter a name for this comparison.');
      return;
    }

    if (!file1 || !file2) {
      setErrorMessage('Please upload both estimate files before comparing.');
      return;
    }

    if (!format1 || !format2) {
      setErrorMessage('Please select the estimate format for both files.');
      return;
    }

    setProcessing(true);
    setProgressPercent(8);
    setElapsedSeconds(0);
    setErrorMessage(null);

    try {
      const formData = new FormData();
      formData.append('name', comparisonName.trim());
      formData.append('yourEstimate', file1);
      formData.append('yourEstimateFormat', format1);
      formData.append('adjusterEstimate', file2);
      formData.append('adjusterEstimateFormat', format2);

      const response = await fetch('/api/comparisons', {
        method: 'POST',
        body: formData,
      });

      const payload = (await response.json()) as {
        error?: string;
        code?: string;
        used?: number;
        limit?: number;
        refreshDate?: string | null;
        comparison?: { id: string };
      };

      if (!response.ok) {
        if (payload.code === 'USAGE_LIMIT_REACHED') {
          const used = typeof payload.used === 'number' ? payload.used : 0;
          const limit = typeof payload.limit === 'number' ? payload.limit : 0;
          throw new Error(
            `You have used ${used}/${limit} comparisons for this period. You can create more on ${formatDate(payload.refreshDate)}.`
          );
        }

        throw new Error(payload.error ?? 'Failed to upload files.');
      }

      if (!payload.comparison?.id) {
        throw new Error('Comparison was created but no ID was returned.');
      }

      setPendingComparisonId(payload.comparison.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Upload failed.';
      setErrorMessage(message);
      setProcessing(false);
    }
  };

  useEffect(() => {
    if (!pendingComparisonId) return;

    let cancelled = false;
    const startedAt = Date.now();

    const progressTicker = window.setInterval(() => {
      if (cancelled) return;

      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const target = Math.min(94, 12 + elapsed * 1.4);

      setElapsedSeconds(elapsed);
      setProgressPercent((prev) => (prev < target ? Math.min(target, prev + 2) : prev));
    }, 1000);

    const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — generous for Phase 4 zone detection

    async function pollStatus() {
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        if (cancelled) return;
        setErrorMessage(
          'This is taking longer than expected. Try refreshing — if the issue persists, contact support.'
        );
        setPendingComparisonId(null);
        setProcessing(false);
        setProgressPercent(0);
        return;
      }

      try {
        const response = await fetch(`/api/comparisons/${pendingComparisonId}`, {
          method: 'GET',
          cache: 'no-store',
        });

        const payload = (await response.json()) as {
          error?: string;
          comparison?: { status: 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'AWAITING_ZONE_REVIEW' | 'AWAITING_MATCH_REVIEW' | 'AWAITING_LINE_ITEM_REVIEW'; errorMessage?: string | null };
        };

        if (!response.ok || !payload.comparison) {
          return;
        }

        if (
          payload.comparison.status === 'COMPLETED' ||
          payload.comparison.status === 'AWAITING_ZONE_REVIEW' ||
          payload.comparison.status === 'AWAITING_MATCH_REVIEW' ||
          payload.comparison.status === 'AWAITING_LINE_ITEM_REVIEW'
        ) {
          if (cancelled) return;
          setProgressPercent(100);
          window.setTimeout(() => {
            if (!cancelled) {
              router.replace(`/app/comparison/${pendingComparisonId}`);
            }
          }, 300);
          return;
        }

        if (payload.comparison.status === 'FAILED') {
          if (cancelled) return;
          setErrorMessage(
            payload.comparison.errorMessage
              ? `Comparison processing failed: ${payload.comparison.errorMessage}`
              : 'Comparison processing failed.'
          );
          setPendingComparisonId(null);
          setProcessing(false);
          setProgressPercent(0);
        }
      } catch {
        // Keep polling; transient errors are expected during local dev.
      }
    }

    void pollStatus();
    const pollTicker = window.setInterval(() => {
      void pollStatus();
    }, 2500);

    return () => {
      cancelled = true;
      window.clearInterval(progressTicker);
      window.clearInterval(pollTicker);
    };
  }, [pendingComparisonId, router]);


  return (
    <>
      <MobileAppBar title="New Comparison" />
      <TrialBanner />
      <div className={styles.content}>
        {!processing && (
          <>
            <div className={styles.header}>
              <h1>New Comparison</h1>
              <p>Upload two insurance estimate PDFs or spreadsheets to compare them side by side.</p>
              <p className={styles.headerNote}>
                A file type must be specified before uploading.{' '}
                <button type="button" className={styles.qualifiesLink} onClick={handleQualifiesClick}>
                  What Qualifies?
                </button>
              </p>
            </div>
            <div className={styles.nameField}>
              <label className={styles.nameLabel} htmlFor="comparison-name">Comparison Name</label>
              <input
                id="comparison-name"
                className={styles.nameInput}
                type="text"
                placeholder="e.g. 123 Main St — Roof Claim"
                maxLength={80}
                value={comparisonName}
                onChange={e => setComparisonName(e.target.value)}
              />
              <span className={styles.nameCount}>{comparisonName.length}/80</span>
            </div>

            <div className={styles.uploaders}>
              {/* ── Your Estimate card ── */}
              <div className={styles.uploadCard} onDragOver={e => { if (format1) e.preventDefault(); }} onDrop={format1 ? handleDrop(setFile1, format1) : undefined}>
                <div className={styles.uploadLabel}>Your Estimate</div>

                <div className={styles.formatRow}>
                  <label className={styles.formatLabel} htmlFor="format1">Estimate format <span style={{ color: 'var(--error-text)' }}>*</span></label>
                  <select id="format1" className={styles.formatSelect} value={format1} onChange={e => { setFormat1(e.target.value); setFile1(null); }}>
                    <option value="" disabled>Select format...</option>
                    <option value="xactimate">Xactimate (PDF)</option>
                    <option value="symbility">Symbility (PDF)</option>
                    <option value="xls">Xactimate (Excel / CSV)</option>
                  </select>
                </div>

                <div className={`${styles.dropZone} ${!format1 ? styles.dropZoneDisabled : ''}`}>
                  <div className={styles.uploadIcon}>
                    <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                  </div>
                  {file1 ? (
                    <div className={styles.fileName}>
                      <svg viewBox="0 0 24 24" width="16" height="16"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
                      {file1.name}
                      <button onClick={() => setFile1(null)} className={styles.removeBtn}>&times;</button>
                    </div>
                  ) : (
                    <>
                      <p className={styles.uploadHint}>
                        {format1 ? fileHint(format1, 'your') : 'Select a format above, then drop your file here, or'}
                      </p>
                      <label className={`${styles.browseBtn} ${!format1 ? styles.browseBtnDisabled : ''}`}>
                        Browse files
                        {format1 && <input type="file" accept={acceptAttr(format1)} hidden onChange={handleFile(setFile1, format1)} />}
                      </label>
                    </>
                  )}
                </div>
              </div>

              {/* ── Adjuster Estimate card ── */}
              <div className={styles.uploadCard} onDragOver={e => { if (format2) e.preventDefault(); }} onDrop={format2 ? handleDrop(setFile2, format2) : undefined}>
                <div className={styles.uploadLabel}>Adjuster&apos;s Estimate</div>

                <div className={styles.formatRow}>
                  <label className={styles.formatLabel} htmlFor="format2">Estimate format <span style={{ color: 'var(--error-text)' }}>*</span></label>
                  <select id="format2" className={styles.formatSelect} value={format2} onChange={e => { setFormat2(e.target.value); setFile2(null); }}>
                    <option value="" disabled>Select format...</option>
                    <option value="xactimate">Xactimate (PDF)</option>
                    <option value="symbility">Symbility (PDF)</option>
                    <option value="xls">Xactimate (Excel / CSV)</option>
                  </select>
                </div>

                <div className={`${styles.dropZone} ${!format2 ? styles.dropZoneDisabled : ''}`}>
                  <div className={styles.uploadIcon}>
                    <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                  </div>
                  {file2 ? (
                    <div className={styles.fileName}>
                      <svg viewBox="0 0 24 24" width="16" height="16"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
                      {file2.name}
                      <button onClick={() => setFile2(null)} className={styles.removeBtn}>&times;</button>
                    </div>
                  ) : (
                    <>
                      <p className={styles.uploadHint}>
                        {format2 ? fileHint(format2, "adjuster's") : 'Select a format above, then drop your file here, or'}
                      </p>
                      <label className={`${styles.browseBtn} ${!format2 ? styles.browseBtnDisabled : ''}`}>
                        Browse files
                        {format2 && <input type="file" accept={acceptAttr(format2)} hidden onChange={handleFile(setFile2, format2)} />}
                      </label>
                    </>
                  )}
                </div>
              </div>
            </div>

            {errorMessage ? <p className={styles.errorText}>{errorMessage}</p> : null}

            <button className={styles.compareBtn} disabled={!(comparisonName.trim() && file1 && file2 && format1 && format2)} onClick={handleCompare}>
              <svg viewBox="0 0 24 24" width="18" height="18"><polyline points="16 3 21 3 21 8" /><line x1="4" y1="20" x2="21" y2="3" /><polyline points="21 16 21 21 16 21" /><line x1="15" y1="15" x2="21" y2="21" /><line x1="4" y1="4" x2="9" y2="9" /></svg>
              Compare Estimates
            </button>

            <p className={styles.aiDisclaimer}>Results are generated by AI and may not be perfectly accurate. Please review all line items carefully before making decisions.</p>
          </>
        )}

        {/* ── What Qualifies? inline section ── */}
        {qualifiesVisible && (
          <div ref={qualifiesRef} className={styles.qualifiesWrap}>
            <div key={qualifiesFlash} className={styles.qualifiesSection}>
              <div className={styles.qualifiesSectionHeader}>
                <h2 className={styles.qualifiesSectionTitle}>What Qualifies?</h2>
                <button type="button" className={styles.qualifiesCloseBtn} onClick={() => setQualifiesVisible(false)} aria-label="Close">
                  <svg viewBox="0 0 24 24" width="15" height="15"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
              </div>

              <div className={styles.qualifiesGrid}>
                <div className={styles.qualifiesCard}>
                  <div className={styles.qualifiesCardBadge} data-type="pdf">
                    <svg viewBox="0 0 24 24" width="12" height="12"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
                    PDF Estimates
                  </div>
                  <ul className={styles.qualifiesList}>
                    <li><strong>Line items must be numbered</strong> — sequential numbering is required to identify and match scope items across both estimates.</li>
                    <li><strong>Zones are strongly encouraged</strong> — grouping by room or area (e.g. &ldquo;Kitchen&rdquo;, &ldquo;Roof&rdquo;) significantly improves accuracy.</li>
                    <li><strong>Complete line item data</strong> — description, quantity, unit cost, and total all improve scoring confidence.</li>
                    <li><strong>Supported:</strong> Xactimate PDF and Symbility PDF exports.</li>
                  </ul>
                </div>

                <div className={styles.qualifiesCard}>
                  <div className={styles.qualifiesCardBadge} data-type="xls">
                    <svg viewBox="0 0 24 24" width="12" height="12"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18" /></svg>
                    Excel / CSV
                  </div>
                  <ul className={styles.qualifiesList}>
                    <li><strong>Description column is required</strong> — e.g. &ldquo;Desc&rdquo;, &ldquo;Description&rdquo;, &ldquo;Item Description&rdquo;.</li>
                    <li>
                      <strong>Recommended columns:</strong>
                      <ul className={styles.qualifiesSubList}>
                        <li><strong>Zone / Group Code</strong> — room or area grouping</li>
                        <li><strong>Quantity</strong> and <strong>Unit Cost</strong></li>
                        <li><strong>Total / RCV</strong> — used to compute the dollar gap</li>
                        <li><strong>Item Code / Category</strong> — for scoring</li>
                      </ul>
                    </li>
                    <li><strong>Column names can vary</strong> — AI automatically identifies non-standard names like &ldquo;Extended Price&rdquo; or &ldquo;Scope of Work&rdquo;.</li>
                    <li><strong>File types:</strong> .xlsx, .xls, .csv</li>
                    <li><strong>Formula cells:</strong> save as &ldquo;values only&rdquo; before uploading for best results.</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        )}

        {processing && (
          <div className={styles.processingState}>
            <div className={styles.spinner} />
            <h2 className={styles.processingHeadline}>
              {ZONE_DETECTION_HEADLINE}
            </h2>
            <div className={styles.progressWrap}>
              <div className={styles.progressTrack}>
                <div className={styles.progressFill} style={{ width: `${progressPercent}%` }} />
              </div>
              <div className={styles.progressMeta}>
                <span>{Math.round(progressPercent)}%</span>
                <span>{elapsedSeconds}s elapsed</span>
              </div>
            </div>
            <p className={styles.processingDisclaimer}>
              AI is scanning both PDFs to identify the zones in each estimate. This typically takes under 30 seconds.
            </p>
            <p className={styles.processingWarning}>
              You&apos;ll have a chance to review and correct the detected zones before analysis begins.
            </p>
          </div>
        )}
      </div>
    </>
  );
}
