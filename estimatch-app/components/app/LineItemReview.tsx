'use client';

import React, { useState } from 'react';
import styles from './LineItemReview.module.css';

export type LineItemZoneRow = {
  zoneName:    string;
  itemCount:   number;
  approxItems: number;
};

type Props = {
  comparisonId:   string;
  initialYours:   LineItemZoneRow[];
  initialAdj:     LineItemZoneRow[];
  yoursTotal:     number;
  adjusterTotal:  number;
  onConfirmed:    () => void;
  onExit?:        () => void;
};

export default function LineItemReview({
  comparisonId,
  initialYours,
  initialAdj,
  yoursTotal,
  adjusterTotal,
  onConfirmed,
  onExit,
}: Props) {
  const [feedbackOpen,  setFeedbackOpen]  = useState(false);
  const [feedbackText,  setFeedbackText]  = useState('');
  const [source,        setSource]        = useState<'yours' | 'adjuster' | 'both'>('both');
  const [submitting,    setSubmitting]    = useState(false);
  const [confirming,    setConfirming]    = useState(false);
  const [error,         setError]         = useState<string | null>(null);
  const [creditWarning, setCreditWarning] = useState(false);

  const maxRows = Math.max(initialYours.length, initialAdj.length);

  function handleFeedbackChange(val: string) {
    setFeedbackText(val);
    const looksGeneric = val.trim().length > 10 && !/(zone|section|room)/i.test(val);
    setCreditWarning(looksGeneric && source === 'both');
  }

  function handleSourceChange(val: 'yours' | 'adjuster' | 'both') {
    setSource(val);
    setCreditWarning(val === 'both' && feedbackText.trim().length > 10);
  }

  async function handleConfirm() {
    if (confirming) return;
    setConfirming(true);
    setError(null);
    try {
      const res = await fetch(`/api/comparisons/${comparisonId}/line-item-review/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? `Request failed (${res.status})`);
        setConfirming(false);
        return;
      }
      onConfirmed();
    } catch {
      setError('Network error. Please try again.');
      setConfirming(false);
    }
  }

  async function handleReextract(e: React.FormEvent) {
    e.preventDefault();
    if (!feedbackText.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/comparisons/${comparisonId}/line-item-review/reextract`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source, feedback: feedbackText.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? `Request failed (${res.status})`);
        setSubmitting(false);
        return;
      }
      onConfirmed();
    } catch {
      setError('Network error. Please try again.');
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.shell}>
      <div className={styles.header}>
        <h1 className={styles.title}>Step 3 of 4 — Line Item Extraction Review</h1>
        <p className={styles.subtitle}>
          Verify the number of line items extracted per zone. If the counts look off, describe
          what&apos;s missing and we&apos;ll re-extract. You can always add or remove items manually
          on the final screen.
        </p>
      </div>

      {/* ── Item count table ──────────────────────────────────────── */}
      <div className={styles.tableWrap}>
        <div className={styles.tableGrid}>
          <div className={styles.colHead}>
            Your Estimate
            <span className={styles.totalBadge}>{yoursTotal} items</span>
          </div>
          <div className={styles.colHead}>
            Adjuster&apos;s Estimate
            <span className={styles.totalBadge}>{adjusterTotal} items</span>
          </div>

          {Array.from({ length: maxRows }).map((_, i) => {
            const yr  = initialYours[i];
            const adj = initialAdj[i];
            return (
              <React.Fragment key={i}>
                {yr ? (
                  <div className={styles.zoneCell}>
                    <div className={styles.zoneInfo}>
                      <span className={styles.zoneName}>{yr.zoneName}</span>
                      <span className={styles.zoneMeta}>
                        {yr.itemCount} items extracted
                        {yr.approxItems > 0 && ` · ~${yr.approxItems} expected`}
                      </span>
                    </div>
                    {yr.approxItems > 0 && Math.abs(yr.itemCount - yr.approxItems) > 3 && (
                      <span className={styles.warningDot} title="Count differs significantly from estimate" />
                    )}
                  </div>
                ) : (
                  <div className={styles.emptyCell}>—</div>
                )}
                {adj ? (
                  <div className={styles.zoneCell}>
                    <div className={styles.zoneInfo}>
                      <span className={styles.zoneName}>{adj.zoneName}</span>
                      <span className={styles.zoneMeta}>
                        {adj.itemCount} items extracted
                        {adj.approxItems > 0 && ` · ~${adj.approxItems} expected`}
                      </span>
                    </div>
                    {adj.approxItems > 0 && Math.abs(adj.itemCount - adj.approxItems) > 3 && (
                      <span className={styles.warningDot} title="Count differs significantly from estimate" />
                    )}
                  </div>
                ) : (
                  <div className={styles.emptyCell}>—</div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* ── Feedback section ─────────────────────────────────────── */}
      {!feedbackOpen ? (
        <div className={styles.flagRow}>
          <button
            type="button"
            className={styles.flagBtn}
            onClick={() => setFeedbackOpen(true)}
            disabled={confirming}
          >
            Something looks off
          </button>
          <span className={styles.flagHint}>Counts look wrong? Let us know and we&apos;ll re-extract.</span>
        </div>
      ) : (
        <form className={styles.feedbackSection} onSubmit={handleReextract}>
          <div className={styles.sourceRow}>
            <span className={styles.sourceLabel}>Which estimate needs re-extraction?</span>
            <div className={styles.sourceBtns}>
              {(['yours', 'adjuster', 'both'] as const).map(s => (
                <button
                  key={s}
                  type="button"
                  className={source === s ? styles.sourceBtnActive : styles.sourceBtn}
                  onClick={() => handleSourceChange(s)}
                  disabled={submitting}
                >
                  {s === 'yours' ? 'Yours' : s === 'adjuster' ? 'Adjuster' : 'Both'}
                </button>
              ))}
            </div>
          </div>

          {creditWarning && (
            <div className={styles.creditWarning}>
              <strong>Credit notice:</strong> A full re-extraction of both estimates will use
              additional AI credits. For a targeted fix, describe the specific zone or section
              that&apos;s missing items — we&apos;ll only re-scan those pages.
              <br />
              <span className={styles.escapeHint}>
                You can always add, remove, or correct items manually on the final screen.
              </span>
            </div>
          )}

          <label className={styles.inputLabel} htmlFor="lir-feedback">
            Describe what&apos;s missing
          </label>
          <p className={styles.inputHint}>
            Be specific for best results — e.g. &ldquo;Kitchen is missing about 4 items&rdquo; or
            &ldquo;Zone 3 in the adjuster&apos;s estimate should have more items.&rdquo;
          </p>
          <textarea
            id="lir-feedback"
            className={styles.textarea}
            value={feedbackText}
            onChange={e => handleFeedbackChange(e.target.value)}
            placeholder="e.g. Zone 3 (adjuster) is missing approximately 4 items around pages 8–11."
            rows={3}
            disabled={submitting}
          />
          <div className={styles.feedbackActions}>
            <button
              type="button"
              className={styles.cancelBtn}
              onClick={() => { setFeedbackOpen(false); setFeedbackText(''); setCreditWarning(false); }}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={styles.submitBtn}
              disabled={!feedbackText.trim() || submitting}
            >
              {submitting ? 'Re-extracting…' : 'Re-extract'}
            </button>
          </div>
        </form>
      )}

      {error && <div className={styles.errorMessage}>{error}</div>}

      {/* ── Bottom bar ───────────────────────────────────────────── */}
      <div className={styles.bottomBar}>
        <span className={styles.hint}>
          Counts look right? Confirm to continue matching.
        </span>
        <div className={styles.bottomActions}>
          {onExit && (
            <button
              type="button"
              className={styles.exitBtn}
              onClick={onExit}
              disabled={confirming || submitting}
            >
              Exit
            </button>
          )}
          <button
            type="button"
            className={styles.confirmBtn}
            onClick={handleConfirm}
            disabled={confirming || submitting}
          >
            {confirming ? 'Confirming…' : 'Looks good — continue ✓'}
          </button>
        </div>
      </div>
    </div>
  );
}
