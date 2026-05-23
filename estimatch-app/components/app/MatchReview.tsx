'use client';

import React, { useState, useMemo, useRef } from 'react';
import styles from './MatchReview.module.css';

export type MatchPair = {
  e1Zones: string[];
  e2Zones: string[];
  canonical: string;
  isMerged: boolean;
  confidence: number;
};

type Props = {
  comparisonId: string;
  initialPairs: MatchPair[];
  initialUnmatchedE1: string[];
  initialUnmatchedE2: string[];
  onConfirmed: () => void;
  onBack?: () => void;
  onExit?: () => void;
};

function joinNames(names: string[]): string {
  return names.join(' + ');
}

export default function MatchReview({
  comparisonId,
  initialPairs,
  initialUnmatchedE1,
  initialUnmatchedE2,
  onConfirmed,
  onBack,
  onExit,
}: Props) {
  // ── Initialize slots ──────────────────────────────────────────────────
  // Parallel arrays: same index = same row. null = no zone on that side.
  const initSlots = (): { e1: (string | null)[]; e2: (string | null)[] } => {
    const e1: (string | null)[] = [];
    const e2: (string | null)[] = [];
    for (const pair of initialPairs) {
      e1.push(joinNames(pair.e1Zones));
      e2.push(joinNames(pair.e2Zones));
    }
    for (const name of initialUnmatchedE1) {
      e1.push(name);
      e2.push(null);
    }
    for (const name of initialUnmatchedE2) {
      e1.push(null);
      e2.push(name);
    }
    return { e1, e2 };
  };

  const { e1: initE1, e2: initE2 } = initSlots();
  const [e1Slots, setE1Slots] = useState<(string | null)[]>(initE1);
  const [e2Slots, setE2Slots] = useState<(string | null)[]>(initE2);
  const [confirming, setConfirming] = useState(false);

  const [corrDescription, setCorrDescription] = useState('');
  const [correcting, setCorrecting] = useState(false);
  const [corrAgentMessage, setCorrAgentMessage] = useState<string | null>(null);
  const [corrError, setCorrError] = useState<string | null>(null);
  const corrTextareaRef = useRef<HTMLTextAreaElement>(null);

  const isDirty =
    e1Slots.some((v, i) => v !== initE1[i]) ||
    e2Slots.some((v, i) => v !== initE2[i]);

  const hasLowConfidence = useMemo(
    () => initialPairs.some(p => p.confidence > 0 && p.confidence < 70),
    [initialPairs],
  );

  const [warnDismissed, setWarnDismissed] = useState(false);

  function handleUnpair(i: number) {
    setE1Slots(prev => {
      const next = [...prev];
      next.splice(i, 1);
      next.push(null);
      return next;
    });
    setE2Slots(prev => {
      const next = [...prev];
      const e2Name = next[i];
      next.splice(i, 1);
      next.push(e2Name);
      return next;
    });
  }

  function handleReset() {
    setE1Slots([...initE1]);
    setE2Slots([...initE2]);
  }
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [goingBack, setGoingBack] = useState(false);

  const confidenceMap = useMemo(
    () =>
      new Map(
        initialPairs.map(p => [
          `${joinNames(p.e1Zones)}|${joinNames(p.e2Zones)}`,
          p.confidence,
        ]),
      ),
    [initialPairs],
  );

  // ── Drag state ────────────────────────────────────────────────────────
  const [dragFrom, setDragFrom] = useState<{ col: 'e1' | 'e2'; index: number } | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<{ col: 'e1' | 'e2'; index: number } | null>(null);

  function handleDragStart(col: 'e1' | 'e2', index: number) {
    setDragFrom({ col, index });
  }

  function handleDragOver(e: React.DragEvent, col: 'e1' | 'e2', index: number) {
    e.preventDefault();
    if (dragFrom?.col === col) {
      setDragOverIndex({ col, index });
    }
  }

  function handleDrop(e: React.DragEvent, col: 'e1' | 'e2', toIndex: number) {
    e.preventDefault();
    if (!dragFrom || dragFrom.col !== col || dragFrom.index === toIndex) {
      setDragFrom(null);
      setDragOverIndex(null);
      return;
    }
    const fromIndex = dragFrom.index;
    const setter = col === 'e1' ? setE1Slots : setE2Slots;
    setter(prev => {
      const next = [...prev];
      [next[fromIndex], next[toIndex]] = [next[toIndex], next[fromIndex]];
      return next;
    });
    setDragFrom(null);
    setDragOverIndex(null);
  }

  function handleDragEnd() {
    setDragFrom(null);
    setDragOverIndex(null);
  }

  // ── AI correction ─────────────────────────────────────────
  async function handleCorrect(e: React.FormEvent) {
    e.preventDefault();
    if (!corrDescription.trim() || correcting) return;
    setCorrecting(true);
    setCorrAgentMessage(null);
    setCorrError(null);
    try {
      const res = await fetch(`/api/comparisons/${comparisonId}/match-review/correction`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: corrDescription.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setCorrError(body.error ?? `Request failed (${res.status})`);
        return;
      }
      const data = await res.json() as {
        pairs: Array<{ e1Zones: string[]; e2Zones: string[] }>;
        unmatchedE1: string[];
        unmatchedE2: string[];
        agentMessage: string | null;
      };
      if (data.agentMessage) {
        setCorrAgentMessage(data.agentMessage);
        setTimeout(() => corrTextareaRef.current?.focus(), 50);
      } else {
        const newE1: (string | null)[] = [];
        const newE2: (string | null)[] = [];
        for (const pair of data.pairs) {
          newE1.push(pair.e1Zones.join(' + '));
          newE2.push(pair.e2Zones.join(' + '));
        }
        for (const name of data.unmatchedE1) { newE1.push(name); newE2.push(null); }
        for (const name of data.unmatchedE2) { newE1.push(null); newE2.push(name); }
        setE1Slots(newE1);
        setE2Slots(newE2);
        setCorrDescription('');
      }
    } catch {
      setCorrError('Network error — please try again.');
    } finally {
      setCorrecting(false);
    }
  }

  // ── Back ──────────────────────────────────────────────────
  async function handleBack() {
    if (goingBack || confirming || !onBack) return;
    setGoingBack(true);
    setConfirmError(null);
    try {
      const res = await fetch(`/api/comparisons/${comparisonId}/match-review/back`, {
        method: 'POST',
      });
      if (!res.ok) {
        setConfirmError('Could not go back — please try again.');
        setGoingBack(false);
        return;
      }
      onBack();
    } catch {
      setConfirmError('Network error — please try again.');
      setGoingBack(false);
    }
  }

  // ── Confirm ──────────────────────────────────────────────────
  async function handleConfirm() {
    if (confirming) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      const res = await fetch(`/api/comparisons/${comparisonId}/match-review/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ e1Slots, e2Slots }),
      });
      if (!res.ok) {
        setConfirmError('Could not confirm — please try again.');
        setConfirming(false);
        return;
      }
      onConfirmed();
    } catch {
      setConfirmError('Network error — please try again.');
      setConfirming(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────
  const rowCount = Math.max(e1Slots.length, e2Slots.length);

  return (
    <div className={styles.shell}>
      <div className={styles.header}>
        <h1 className={styles.title}>Step 2 of 4 — Confirm Zone Pairings</h1>
        <p className={styles.subtitle}>
          The AI has matched zones from your estimate to the adjuster&apos;s estimate.
          Review each pairing — zones highlighted in green are high-confidence matches.
          Drag any zone within its column to correct a mismatch. Zones without a
          counterpart will be extracted independently.
          When everything looks right, click <strong>Confirm pairings →</strong>.
        </p>
      </div>

      {hasLowConfidence && !warnDismissed && (
        <div className={styles.warnBanner}>
          <svg className={styles.warnIcon} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <div className={styles.warnText}>
            <strong>Some zone pairings have low confidence.</strong> The AI may have grouped zones incorrectly — review carefully. You can drag zones to fix mismatches, or use the ✕ button to unpair any row.
          </div>
          <button className={styles.warnClose} onClick={() => setWarnDismissed(true)} aria-label="Dismiss">✕</button>
        </div>
      )}

      <div className={styles.tableWrap}>
        <div className={styles.colHeads}>
          <div className={styles.colHead}>Your Estimate</div>
          <div className={styles.colHeadMid} aria-hidden />
          <div className={styles.colHead}>Adjuster&apos;s Estimate</div>
          <div className={styles.colHeadAction} aria-hidden />
        </div>

        <div className={styles.rows}>
          {Array.from({ length: rowCount }).map((_, i) => {
            const e1Name = e1Slots[i] ?? null;
            const e2Name = e2Slots[i] ?? null;
            const confKey = e1Name && e2Name ? `${e1Name}|${e2Name}` : null;
            const confidence = confKey ? confidenceMap.get(confKey) : undefined;
            const isPaired = e1Name !== null && e2Name !== null;
            const isLowConf = isPaired && confidence !== undefined && confidence < 70;
            const isHighConf = isPaired && confidence !== undefined && confidence >= 90;
            const isDragOverE1 =
              dragOverIndex?.col === 'e1' &&
              dragOverIndex.index === i &&
              dragFrom?.col === 'e1';
            const isDragOverE2 =
              dragOverIndex?.col === 'e2' &&
              dragOverIndex.index === i &&
              dragFrom?.col === 'e2';

            return (
              <div
                key={i}
                className={`${styles.row} ${isHighConf ? styles.rowHighConf : ''} ${isLowConf ? styles.rowLowConf : ''}`}
              >
                {/* ── E1 cell ─── */}
                <div
                  className={`${styles.cell} ${isDragOverE1 ? styles.cellDragOver : ''} ${
                    !e1Name ? styles.cellEmpty : ''
                  }`}
                  draggable={e1Name !== null}
                  onDragStart={() => e1Name !== null && handleDragStart('e1', i)}
                  onDragOver={e => handleDragOver(e, 'e1', i)}
                  onDrop={e => handleDrop(e, 'e1', i)}
                  onDragEnd={handleDragEnd}
                >
                  {e1Name ? (
                    <>
                      <span className={styles.dragHandle} aria-hidden="true">⠿</span>
                      <span className={styles.zoneName}>{e1Name}</span>
                    </>
                  ) : (
                    <span className={styles.emptyLabel}>—</span>
                  )}
                </div>

                {/* ── Confidence column ─── */}
                <div className={styles.confCol}>
                  {isPaired && confidence !== undefined && (
                    <span
                      className={`${styles.confBadge} ${
                        confidence >= 90
                          ? styles.confHigh
                          : confidence >= 70
                          ? styles.confMid
                          : styles.confLow
                      }`}
                    >
                      {confidence.toFixed(2)}%
                    </span>
                  )}
                </div>

                {/* ── E2 cell ─── */}
                <div
                  className={`${styles.cell} ${isDragOverE2 ? styles.cellDragOver : ''} ${
                    !e2Name ? styles.cellEmpty : ''
                  }`}
                  draggable={e2Name !== null}
                  onDragStart={() => e2Name !== null && handleDragStart('e2', i)}
                  onDragOver={e => handleDragOver(e, 'e2', i)}
                  onDrop={e => handleDrop(e, 'e2', i)}
                  onDragEnd={handleDragEnd}
                >
                  {e2Name ? (
                    <>
                      <span className={styles.dragHandle} aria-hidden="true">⠿</span>
                      <span className={styles.zoneName}>{e2Name}</span>
                    </>
                  ) : (
                    <span className={styles.emptyLabel}>—</span>
                  )}
                </div>

                {/* ── Unpair action ─── */}
                <div className={styles.rowAction}>
                  {isPaired && (
                    <button
                      className={styles.unpairBtn}
                      onClick={() => handleUnpair(i)}
                      title="Unpair these zones — they will be extracted independently"
                      disabled={confirming || correcting || goingBack}
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {confirmError && <div className={styles.errorMessage}>{confirmError}</div>}

      {corrAgentMessage && (
        <div className={styles.agentMessage}>{corrAgentMessage}</div>
      )}

      {corrError && <div className={styles.errorMessage}>{corrError}</div>}

      <form id="match-correction-form" className={styles.correctionSection} onSubmit={handleCorrect}>
        <label className={styles.correctionLabel} htmlFor="match-correction-input">
          Describe a pairing issue
        </label>
        <p className={styles.correctionHint}>
          e.g. &ldquo;Master Bedroom and Master Bath should pair with Primary Suite&rdquo; or
          &ldquo;Exterior zone has no counterpart on the adjuster side&rdquo;
        </p>
        <textarea
          id="match-correction-input"
          ref={corrTextareaRef}
          className={styles.correctionTextarea}
          value={corrDescription}
          onChange={e => setCorrDescription(e.target.value)}
          placeholder='Describe what looks wrong with the zone pairings…'
          rows={2}
          disabled={correcting || confirming || goingBack}
        />
      </form>

      <div className={styles.bottomBar}>
        <span className={styles.hint}>
          {e1Slots.filter(Boolean).length} zone
          {e1Slots.filter(Boolean).length !== 1 ? 's' : ''} ·{' '}
          {e2Slots.filter(Boolean).length} zone
          {e2Slots.filter(Boolean).length !== 1 ? 's' : ''}
        </span>
        <div className={styles.bottomBarActions}>
          {onExit && (
            <button className={styles.exitBtn} onClick={onExit} disabled={goingBack || confirming}>
              Exit
            </button>
          )}
          {isDirty && (
            <button
              className={styles.backBtn}
              onClick={handleReset}
              disabled={goingBack || confirming || correcting}
            >
              Reset to default
            </button>
          )}
          {onBack && (
            <button
              className={styles.backBtn}
              onClick={handleBack}
              disabled={goingBack || confirming || correcting}
            >
              {goingBack ? 'Going back…' : '← Revise zones'}
            </button>
          )}
          <button
            type="submit"
            form="match-correction-form"
            className={styles.correctionSubmitBtn}
            disabled={!corrDescription.trim() || correcting || confirming || goingBack}
          >
            {correcting ? 'Correcting…' : 'Apply correction'}
          </button>
          <button
            className={styles.confirmBtn}
            onClick={handleConfirm}
            disabled={confirming || goingBack || correcting}
          >
            {confirming ? 'Starting extraction…' : 'Confirm pairings →'}
          </button>
        </div>
      </div>
    </div>
  );
}
