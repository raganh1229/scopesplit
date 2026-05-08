'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import MobileAppBar from '@/components/app/MobileAppBar';
import TrialBanner from '@/components/app/TrialBanner';
import styles from './page.module.css';

type ApiComparison = {
  id: string;
  title: string;
  status: 'PROCESSING' | 'COMPLETED' | 'FAILED';
  totalGap: number | null;
  createdAt: string;
};

function statusColor(status: string) {
  if (status === 'COMPLETED') return styles.statusGreen;
  if (status === 'PROCESSING') return styles.statusAmber;
  return styles.statusGray;
}

function formatStatus(status: ApiComparison['status']): string {
  if (status === 'COMPLETED') return 'Completed';
  if (status === 'PROCESSING') return 'Processing';
  return 'Failed';
}

function formatGap(totalGap: number | null): string {
  if (totalGap === null) return '—';
  const prefix = totalGap > 0 ? '-' : totalGap < 0 ? '+' : '';
  const absoluteGap = Math.abs(totalGap);
  return `${prefix}$${absoluteGap.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function gapColorClass(totalGap: number | null): string {
  if (totalGap === null || totalGap === 0) return '';
  return totalGap > 0 ? styles.gapDanger : styles.gapSuccess;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function ComparisonsPage() {
  const [comparisons, setComparisons] = useState<ApiComparison[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuId(null);
      }
    }
    if (openMenuId) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [openMenuId]);

  const handleDelete = useCallback(async (id: string) => {
    setDeletingId(id);
    setConfirmDeleteId(null);
    setOpenMenuId(null);
    try {
      const res = await fetch(`/api/comparisons/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? 'Delete failed.');
      }
      setComparisons(prev => prev.filter(c => c.id !== id));
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      setDeletingId(null);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function loadComparisons() {
      setIsLoading(true);
      setErrorMessage(null);

      try {
        const response = await fetch('/api/comparisons', { method: 'GET' });
        const payload = (await response.json()) as {
          error?: string;
          comparisons?: ApiComparison[];
        };

        if (!response.ok) {
          throw new Error(payload.error ?? 'Failed to load comparisons.');
        }

        if (!isMounted) return;
        setComparisons(payload.comparisons ?? []);
      } catch (error) {
        if (!isMounted) return;
        setErrorMessage(error instanceof Error ? error.message : 'Failed to load comparisons.');
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    void loadComparisons();

    return () => {
      isMounted = false;
    };
  }, []);

  return (
    <>
      <MobileAppBar title="Comparisons" />
      <TrialBanner />
      <div className={styles.content}>
        <div className={styles.header}>
          <h1>Comparisons</h1>
          <Link className={styles.newBtn} href="/app/new-comparison">
            <svg viewBox="0 0 24 24" width="16" height="16"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
            New Comparison
          </Link>
        </div>

        <div className={styles.table}>
          <div className={styles.tableHead}>
            <div className={styles.colName}>Name</div>
            <div className={styles.colDate}>Date</div>
            <div className={styles.colStatus}>Status</div>
            <div className={styles.colGap}>Gap</div>
          </div>

          {errorMessage ? <div className={styles.stateRow}>{errorMessage}</div> : null}

          {!errorMessage && isLoading ? <div className={styles.stateRow}>Loading comparisons...</div> : null}

          {!errorMessage && !isLoading && comparisons.length === 0 ? (
            <div className={styles.stateRow}>No comparisons yet. Create your first one to get started.</div>
          ) : null}

          {!errorMessage && !isLoading
            ? comparisons.map((comparison) => (
              <div key={comparison.id} className={styles.tableRow}>
                <Link className={styles.rowLink} href={`/app/comparison/${comparison.id}`}>
                  <div className={styles.colName}>{comparison.title}</div>
                  <div className={styles.colDate}>{formatDate(comparison.createdAt)}</div>
                  <div className={styles.colStatus}>
                    <span className={`${styles.statusBadge} ${statusColor(comparison.status)}`}>
                      {formatStatus(comparison.status)}
                    </span>
                  </div>
                  <div className={`${styles.colGap} ${gapColorClass(comparison.totalGap)}`}>{formatGap(comparison.totalGap)}</div>
                </Link>
                <div className={styles.colActions} ref={openMenuId === comparison.id ? menuRef : undefined}>
                  <button
                    className={styles.moreBtn}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpenMenuId(prev => prev === comparison.id ? null : comparison.id); }}
                    aria-label="More options"
                    disabled={deletingId === comparison.id}
                  >
                    {deletingId === comparison.id ? (
                      <span className={styles.miniSpinner} />
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="3" r="1.2" fill="currentColor" /><circle cx="8" cy="8" r="1.2" fill="currentColor" /><circle cx="8" cy="13" r="1.2" fill="currentColor" /></svg>
                    )}
                  </button>
                  {openMenuId === comparison.id && (
                    <div className={styles.dropMenu}>
                      {confirmDeleteId === comparison.id ? (
                        <>
                          <span className={styles.dropConfirmText}>Delete this comparison?</span>
                          <button className={styles.dropItemDanger} onClick={() => handleDelete(comparison.id)}>Yes, delete</button>
                          <button className={styles.dropItem} onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                        </>
                      ) : (
                        <button className={styles.dropItemDanger} onClick={() => setConfirmDeleteId(comparison.id)}>Delete</button>
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
