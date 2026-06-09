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
  const [confirming, setConfirming] = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  const maxRows = Math.max(initialYours.length, initialAdj.length);

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

  return (
    <div className={styles.shell}>
      <div className={styles.header}>
        <h1 className={styles.title}>Step 3 of 4 — Line Item Extraction Review</h1>
        <p className={styles.subtitle}>
          Verify the number of line items extracted per zone. You can add or remove items
          manually on the final screen.
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
              disabled={confirming}
            >
              Exit
            </button>
          )}
          <button
            type="button"
            className={styles.confirmBtn}
            onClick={handleConfirm}
            disabled={confirming}
          >
            {confirming ? 'Confirming…' : 'Looks good — continue ✓'}
          </button>
        </div>
      </div>
    </div>
  );
}
