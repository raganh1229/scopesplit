'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import styles from './NotesPanel.module.css';

/* ── Types ── */
export type NoteLineItemContext = {
  id: string;
  sortOrder?: number | null;
  descriptionYours: string | null;
  descriptionAdjuster: string | null;
  zoneCanonical: string | null;
};

export type Note = {
  id: string;
  lineItemId: string | null;
  versionLineItemId: string | null;
  content: string;
  createdAt: string;
  updatedAt: string;
  lineItem: (NoteLineItemContext & { sortOrder?: number | null }) | null;
  versionLineItem: (NoteLineItemContext & { sortOrder?: number | null }) | null;
};

type NotesPanelProps = {
  comparisonId: string;
  isOpen: boolean;
  onClose: () => void;
  /** Pre-select a line item for the next note */
  targetLineItem: NoteLineItemContext | null;
  onClearTarget: () => void;
  /** Expose note count to parent */
  onNotesLoaded?: (count: number) => void;
  /** Map of lineItemId → note count for row indicators */
  onNotesByLineItem?: (map: Map<string, number>) => void;
  /** Full notes array exposed to parent (e.g. for print export) */
  onNotesData?: (notes: Note[]) => void;
  /** Jump from a line-item note card to the matching comparison row */
  onLineItemNoteNavigate?: (lineItemId: string) => void;
  /** Live row-position map for accurate line item numbers in note cards */
  rowNumberMap?: Map<string, number>;
  /** IDs of items present in the currently active zones — used to detect version-deleted items */
  activeItemIds?: Set<string>;
};

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;

  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function NotesPanel({
  comparisonId,
  isOpen,
  onClose,
  targetLineItem,
  onClearTarget,
  onNotesLoaded,
  onNotesByLineItem,
  onNotesData,
  onLineItemNoteNavigate,
  rowNumberMap,
  activeItemIds,
}: NotesPanelProps) {
  const [hasMounted, setHasMounted] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [composerText, setComposerText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const threadRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  useEffect(() => {
    onNotesLoaded?.(notes.length);
    onNotesData?.(notes);

    const map = new Map<string, number>();
    for (const n of notes) {
      if (n.lineItemId) {
        map.set(n.lineItemId, (map.get(n.lineItemId) ?? 0) + 1);
      }
      if (n.versionLineItemId) {
        map.set(n.versionLineItemId, (map.get(n.versionLineItemId) ?? 0) + 1);
      }
    }
    onNotesByLineItem?.(map);
  }, [notes, onNotesLoaded, onNotesData, onNotesByLineItem]);

  /* ── Fetch notes ── */
  const loadNotes = useCallback(async () => {
    if (!comparisonId) return;
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/comparisons/${comparisonId}/notes`);
      if (!res.ok) {
        const payload = await res.json().catch(() => ({ error: 'Failed to load notes.' }));
        throw new Error(payload.error ?? 'Failed to load notes.');
      }
      const data = await res.json();
      const loaded: Note[] = data.notes ?? [];
      setNotes(loaded);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load notes.');
    } finally {
      setIsLoading(false);
    }
  }, [comparisonId]);

  useEffect(() => {
    if (comparisonId) {
      void loadNotes();
    }
  }, [comparisonId, loadNotes]);

  /* Auto-scroll to bottom when notes change or panel opens */
  useEffect(() => {
    if (isOpen && threadRef.current) {
      requestAnimationFrame(() => {
        threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' });
      });
    }
  }, [isOpen, notes.length]);

  /* Focus composer when panel opens */
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => composerRef.current?.focus(), 300);
    }
  }, [isOpen]);

  /* ── Create note ── */
  const handleSend = useCallback(async () => {
    if (!comparisonId) {
      setErrorMessage('Missing comparison id. Please refresh this page.');
      return;
    }
    if (targetLineItem?.id.startsWith('__new__')) {
      setErrorMessage('Save as a new version before adding a note to this item.');
      return;
    }
    const content = composerText.trim();
    if (!content || isSending) return;
    setIsSending(true);
    setErrorMessage(null);
    try {
      const body: { content: string; lineItemId?: string } = { content };
      if (targetLineItem) {
        body.lineItemId = targetLineItem.id;
      }
      const res = await fetch(`/api/comparisons/${comparisonId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({ error: 'Failed to create note.' }));
        throw new Error(payload.error ?? 'Failed to create note.');
      }
      const data = await res.json();
      const newNote: Note = data.note;
      setNotes(prev => [...prev, newNote]);
      setComposerText('');
      onClearTarget();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create note.');
    } finally {
      setIsSending(false);
    }
  }, [composerText, isSending, targetLineItem, comparisonId, onClearTarget]);

  /* ── Edit note ── */
  const handleStartEdit = useCallback((note: Note) => {
    setEditingId(note.id);
    setEditText(note.content);
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!editingId || !editText.trim()) return;
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/comparisons/${comparisonId}/notes/${editingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editText.trim() }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({ error: 'Failed to update note.' }));
        throw new Error(payload.error ?? 'Failed to update note.');
      }
      const data = await res.json();
      setNotes(prev => prev.map(n => n.id === editingId ? data.note : n));
      setEditingId(null);
      setEditText('');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to update note.');
    }
  }, [editingId, editText, comparisonId]);

  /* ── Delete note ── */
  const handleDelete = useCallback(async (noteId: string) => {
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/comparisons/${comparisonId}/notes/${noteId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({ error: 'Failed to delete note.' }));
        throw new Error(payload.error ?? 'Failed to delete note.');
      }
      setNotes(prev => prev.filter(n => n.id !== noteId));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to delete note.');
    }
  }, [comparisonId]);

  /* ── Keyboard shortcuts ── */
  const handleComposerKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSend();
    }
  }, [handleSend]);

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSaveEdit();
    }
    if (e.key === 'Escape') {
      setEditingId(null);
      setEditText('');
    }
  }, [handleSaveEdit]);

  const lineItemDesc = (li: NoteLineItemContext) =>
    li.descriptionYours || li.descriptionAdjuster || 'Line item';

  const handleLineItemNoteCardClick = useCallback((e: React.MouseEvent<HTMLDivElement>, note: Note) => {
    const navigateId = note.versionLineItemId ?? note.lineItemId;
    if (!navigateId || !onLineItemNoteNavigate) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, textarea, input, a')) return;
    onLineItemNoteNavigate(navigateId);
  }, [onLineItemNoteNavigate]);

  if (!hasMounted) {
    return null;
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className={`${styles.backdrop} ${isOpen ? styles.backdropOpen : ''}`}
        onClick={onClose}
      />

      {/* Drawer */}
      <div className={`${styles.drawer} ${isOpen ? styles.drawerOpen : ''}`}>
        {/* Header */}
        <div className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>
            Notes
            {notes.length > 0 && <span className={styles.noteCount}>{notes.length}</span>}
          </h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close notes">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M5 5L13 13M13 5L5 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Thread */}
        <div className={styles.thread} ref={threadRef}>
          {errorMessage ? <div className={styles.errorBanner}>{errorMessage}</div> : null}
          {isLoading && notes.length === 0 ? (
            <div className={styles.emptyState}>Loading notes...</div>
          ) : notes.length === 0 ? (
            <div className={styles.emptyState}>
              <svg className={styles.emptyIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>No notes yet</span>
              <span>Add a general note or click a line item to annotate it.</span>
            </div>
          ) : (
            notes.map(note => (
              <div
                key={note.id}
                className={`${styles.noteCard} ${(note.lineItemId ?? note.versionLineItemId) ? styles.noteCardLineItem : styles.noteCardGeneral} ${(note.lineItemId ?? note.versionLineItemId) ? styles.noteCardLineItemInteractive : ''}`}
                onClick={(e) => handleLineItemNoteCardClick(e, note)}
              >
                {/* Line-item context */}
                {(note.lineItem ?? note.versionLineItem) ? (() => {
                  const refId = note.lineItemId ?? note.versionLineItemId;
                  const isRemoved = !!refId && !!activeItemIds && !activeItemIds.has(refId);
                  if (isRemoved) {
                    return (
                      <div className={styles.lineItemContextRemoved}>
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={styles.lineItemContextIcon}>
                          <path d="M4 8h8" strokeLinecap="round" />
                          <circle cx="8" cy="8" r="6" />
                        </svg>
                        <span>Removed in this version</span>
                      </div>
                    );
                  }
                  return (
                  <div className={styles.lineItemContext}>
                    <svg className={styles.lineItemContextIcon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M4 6h8M4 10h5" strokeLinecap="round" />
                    </svg>
                    <div>
                      {(note.lineItem ?? note.versionLineItem)!.zoneCanonical && (
                        <div className={styles.lineItemContextZone}>{(note.lineItem ?? note.versionLineItem)!.zoneCanonical}</div>
                      )}
                      <div className={styles.lineItemContextText}>
                        {(() => {
                          const liveNum =
                            (note.lineItemId ? rowNumberMap?.get(note.lineItemId) : undefined) ??
                            (note.versionLineItemId ? rowNumberMap?.get(note.versionLineItemId) : undefined);
                          const displayNum = liveNum ?? (note.lineItem ?? note.versionLineItem)!.sortOrder;
                          return displayNum != null
                            ? <span className={styles.lineItemNum}>#{displayNum}</span>
                            : null;
                        })()}
                        {lineItemDesc((note.lineItem ?? note.versionLineItem)!)}
                      </div>
                    </div>
                  </div>
                  );
                })() : (
                  <div className={styles.generalBadge}>
                    <svg className={styles.generalBadgeIcon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M3 3h10v10H3z" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M6 6h4M6 9h2" strokeLinecap="round" />
                    </svg>
                    General
                  </div>
                )}

                {/* Content or edit mode */}
                {editingId === note.id ? (
                  <>
                    <textarea
                      className={styles.editTextarea}
                      value={editText}
                      onChange={e => setEditText(e.target.value)}
                      onKeyDown={handleEditKeyDown}
                      autoFocus
                    />
                    <div className={styles.editActions}>
                      <button className={styles.editCancelBtn} onClick={() => { setEditingId(null); setEditText(''); }}>Cancel</button>
                      <button className={styles.editSaveBtn} onClick={handleSaveEdit} disabled={!editText.trim()}>Save</button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className={styles.noteContent}>{note.content}</p>
                    <div className={styles.noteFooter}>
                      <span className={styles.noteTimestamp}>{formatTimestamp(note.createdAt)}</span>
                      <div className={styles.noteActions}>
                        <button
                          className={styles.noteActionBtn}
                          onClick={() => handleStartEdit(note)}
                          title="Edit"
                        >
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                        <button
                          className={`${styles.noteActionBtn} ${styles.noteActionBtnDanger}`}
                          onClick={() => handleDelete(note.id)}
                          title="Delete"
                        >
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M3 5h10M5 5v8h6V5M7 7v4M9 7v4M6 5V3h4v2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            ))
          )}
        </div>

        {/* Composer */}
        <div className={styles.composer}>
          <p className={styles.composerLabel}>
            {targetLineItem ? 'Note on line item' : 'Add a note'}
          </p>
          {targetLineItem && (
            <div className={styles.composerContext}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M4 6h8M4 10h5" strokeLinecap="round" />
              </svg>
              <span className={styles.composerContextDesc}>{lineItemDesc(targetLineItem)}</span>
              <button className={styles.composerContextClear} onClick={onClearTarget} title="Clear line item">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M2 2l6 6M8 2l-6 6" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          )}
          <div className={styles.composerRow}>
            <textarea
              ref={composerRef}
              className={`${styles.composerInput} ${targetLineItem ? styles.composerInputWithContext : ''}`}
              placeholder="Write a note..."
              value={composerText}
              onChange={e => setComposerText(e.target.value)}
              onKeyDown={handleComposerKeyDown}
              rows={1}
            />
            <button
              className={styles.composerSendBtn}
              onClick={handleSend}
              disabled={!composerText.trim() || isSending}
              title="Send (Ctrl+Enter)"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
