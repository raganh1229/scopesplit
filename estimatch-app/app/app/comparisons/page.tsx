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
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
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

  const handleRenameSubmit = useCallback(async (id: string) => {
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    setRenameSaving(true);
    try {
      const res = await fetch(`/api/comparisons/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      const payload = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(payload.error ?? 'Failed to rename.');
      setComparisons(prev => prev.map(c => c.id === id ? { ...c, title: trimmed } : c));
      setRenamingId(null);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to rename comparison.');
    } finally {
      setRenameSaving(false);
    }
  }, [renameValue]);

  const fetchComparisons = useCallback(async (cursor?: string) => {
    const url = cursor ? `/api/comparisons?cursor=${cursor}` : '/api/comparisons';
    const response = await fetch(url, { method: 'GET' });
    const payload = (await response.json()) as {
      error?: string;
      comparisons?: ApiComparison[];
      nextCursor?: string | null;
    };
    if (!response.ok) throw new Error(payload.error ?? 'Failed to load comparisons.');
    return payload;
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function loadComparisons() {
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const payload = await fetchComparisons();
        if (!isMounted) return;
        setComparisons(payload.comparisons ?? []);
        setNextCursor(payload.nextCursor ?? null);
      } catch (error) {
        if (!isMounted) return;
        setErrorMessage(error instanceof Error ? error.message : 'Failed to load comparisons.');
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }

    void loadComparisons();
    return () => { isMounted = false; };
  }, [fetchComparisons]);

  const handleLoadMore = useCallback(async () => {
    if (!nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const payload = await fetchComparisons(nextCursor);
      setComparisons(prev => [...prev, ...(payload.comparisons ?? [])]);
      setNextCursor(payload.nextCursor ?? null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load more.');
    } finally {
      setIsLoadingMore(false);
    }
  }, [nextCursor, isLoadingMore, fetchComparisons]);

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
                {renamingId === comparison.id ? (
                  <div className={styles.rowLink}>
                    <div className={styles.colName}>
                      <form onSubmit={(e) => { e.preventDefault(); void handleRenameSubmit(comparison.id); }}>
                        <input
                          className={styles.renameInput}
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Escape') setRenamingId(null); }}
                          autoFocus
                          maxLength={200}
                          disabled={renameSaving}
                        />
                      </form>
                    </div>
                    <div className={styles.colDate}>{formatDate(comparison.createdAt)}</div>
                    <div className={styles.colStatus}>
                      <span className={`${styles.statusBadge} ${statusColor(comparison.status)}`}>
                        {formatStatus(comparison.status)}
                      </span>
                    </div>
                    <div className={`${styles.colGap} ${gapColorClass(comparison.totalGap)}`}>{formatGap(comparison.totalGap)}</div>
                  </div>
                ) : (
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
                )}
                <div className={styles.colActions} ref={openMenuId === comparison.id ? menuRef : undefined}>
                  {renamingId === comparison.id ? (
                    <div className={styles.renameActions}>
                      <button
                        className={styles.renameOkBtn}
                        onClick={() => void handleRenameSubmit(comparison.id)}
                        disabled={renameSaving || !renameValue.trim()}
                        aria-label="Save rename"
                      >
                        {renameSaving ? <span className={styles.miniSpinner} /> : <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><polyline points="1,7 5,11 13,3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                      </button>
                      <button
                        className={styles.renameCxBtn}
                        onClick={() => setRenamingId(null)}
                        disabled={renameSaving}
                        aria-label="Cancel rename"
                      >
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><line x1="1" y1="1" x2="11" y2="11" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><line x1="11" y1="1" x2="1" y2="11" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                      </button>
                    </div>
                  ) : (
                    <>
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
                            <>
                              <button className={styles.dropItem} onClick={() => { setOpenMenuId(null); setRenamingId(comparison.id); setRenameValue(comparison.title); }}>Rename</button>
                              <button className={styles.dropItemDanger} onClick={() => setConfirmDeleteId(comparison.id)}>Delete</button>
                            </>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))
            : null}
        </div>

        {nextCursor ? (
          <div className={styles.loadMoreRow}>
            <button
              className={styles.loadMoreBtn}
              onClick={() => void handleLoadMore()}
              disabled={isLoadingMore}
            >
              {isLoadingMore ? <span className={styles.miniSpinner} /> : null}
              {isLoadingMore ? 'Loading...' : 'Load more'}
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}
