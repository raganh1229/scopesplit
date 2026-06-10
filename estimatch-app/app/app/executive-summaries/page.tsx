'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import MobileAppBar from '@/components/app/MobileAppBar';
import styles from './page.module.css';

type ApiSummary = {
  id: string;
  comparisonId: string;
  instructions: string | null;
  createdAt: string;
  comparison: {
    name: string | null;
    insuredName: string | null;
    claimNumber: string | null;
    yourEstimateFilename: string;
    adjusterEstimateFilename: string;
  };
};

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function summaryTitle(s: ApiSummary): string {
  if (s.comparison.name) return s.comparison.name;
  if (s.comparison.insuredName) return s.comparison.insuredName;
  return `${s.comparison.yourEstimateFilename} vs ${s.comparison.adjusterEstimateFilename}`;
}

export default function ExecutiveSummariesPage() {
  const [summaries, setSummaries] = useState<ApiSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuId(null);
      }
    }
    if (openMenuId) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [openMenuId]);

  useEffect(() => {
    let isMounted = true;
    async function load() {
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const res = await fetch('/api/executive-summaries');
        const payload = (await res.json()) as { error?: string; summaries?: ApiSummary[] };
        if (!res.ok) throw new Error(payload.error ?? 'Failed to load summaries.');
        if (isMounted) setSummaries(payload.summaries ?? []);
      } catch (err) {
        if (isMounted) setErrorMessage(err instanceof Error ? err.message : 'Failed to load summaries.');
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }
    void load();
    return () => { isMounted = false; };
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    setDeletingId(id);
    setConfirmDeleteId(null);
    setOpenMenuId(null);
    try {
      const res = await fetch(`/api/executive-summaries/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? 'Delete failed.');
      }
      setSummaries(prev => prev.filter(s => s.id !== id));
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      setDeletingId(null);
    }
  }, []);

  return (
    <>
      <MobileAppBar title="Executive Summaries" />
      <div className={styles.content}>
        <div className={styles.header}>
          <h1>Executive Summaries</h1>
          <Link className={styles.newBtn} href="/app/comparisons">
            <svg viewBox="0 0 24 24" width="16" height="16"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><rect x="8" y="2" width="8" height="4" rx="1" /><line x1="9" y1="12" x2="15" y2="12" /><line x1="9" y1="16" x2="13" y2="16" /></svg>
            View Comparisons
          </Link>
        </div>

        <div className={styles.table}>
          <div className={styles.tableHead}>
            <div className={styles.colName}>Comparison</div>
            <div className={styles.colDate}>Generated</div>
            <div className={styles.colContext}>Context</div>
          </div>

          {errorMessage ? <div className={styles.stateRow}>{errorMessage}</div> : null}
          {!errorMessage && isLoading ? <div className={styles.stateRow}>Loading summaries...</div> : null}
          {!errorMessage && !isLoading && summaries.length === 0 ? (
            <div className={styles.stateRow}>No executive summaries yet. Generate one from any completed comparison.</div>
          ) : null}

          {!errorMessage && !isLoading
            ? summaries.map((summary) => (
              <div key={summary.id} className={styles.tableRow}>
                <Link className={styles.rowLink} href={`/app/executive-summaries/${summary.id}`}>
                  <div className={styles.colName}>{summaryTitle(summary)}</div>
                  <div className={styles.colDate}>{formatDate(summary.createdAt)}</div>
                  <div className={styles.colContext}>
                    {summary.instructions
                      ? <span className={styles.contextBadge} title={summary.instructions}>Custom instructions</span>
                      : <span className={styles.contextNone}>Standard</span>}
                  </div>
                </Link>
                <div className={styles.colActions} ref={openMenuId === summary.id ? menuRef : undefined}>
                  <button
                    className={styles.moreBtn}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpenMenuId(prev => prev === summary.id ? null : summary.id); }}
                    aria-label="More options"
                    disabled={deletingId === summary.id}
                  >
                    {deletingId === summary.id ? (
                      <span className={styles.miniSpinner} />
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="3" r="1.2" fill="currentColor" /><circle cx="8" cy="8" r="1.2" fill="currentColor" /><circle cx="8" cy="13" r="1.2" fill="currentColor" /></svg>
                    )}
                  </button>
                  {openMenuId === summary.id && (
                    <div className={styles.dropMenu}>
                      {confirmDeleteId === summary.id ? (
                        <>
                          <span className={styles.dropConfirmText}>Delete this summary?</span>
                          <button className={styles.dropItemDanger} onClick={() => void handleDelete(summary.id)}>Yes, delete</button>
                          <button className={styles.dropItem} onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                        </>
                      ) : (
                        <>
                          <Link className={styles.dropItemLink} href={`/app/executive-summaries/${summary.id}`}>View</Link>
                          <Link className={styles.dropItemLink} href={`/app/comparison/${summary.comparisonId}`}>Open comparison</Link>
                          <button className={styles.dropItemDanger} onClick={() => setConfirmDeleteId(summary.id)}>Delete</button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))
            : null}
        </div>
      </div>
    </>
  );
}
