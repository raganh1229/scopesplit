'use client';

import React, { useState, useRef } from 'react';
import styles from './ZoneReview.module.css';

export type ReviewZone = {
  name: string;
  startPage: number;
  endPage: number;
  approxItems: number;
};

type Props = {
  comparisonId: string;
  initialE1Zones: ReviewZone[];
  initialE2Zones: ReviewZone[];
  onConfirmed: (data: { reEntry: boolean }) => void;
  onExit?: () => void;
};

function renderBold(text: string): React.ReactNode {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return parts.map((part, i) =>
    i % 2 === 1 ? <strong key={i}>{part}</strong> : part
  );
}

function renderAgentMessage(text: string): React.ReactNode {
  const segments = text.split(/(?=\d+\.\s)/);
  if (segments.length <= 1) {
    return <p style={{ margin: 0 }}>{renderBold(text)}</p>;
  }
  const [intro, ...items] = segments;
  return (
    <>
      {intro?.trim() && <p style={{ margin: '0 0 8px' }}>{renderBold(intro.trim())}</p>}
      <ol style={{ margin: 0, paddingLeft: '1.25rem', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {items.map((item, i) => (
          <li key={i}>{renderBold(item.replace(/^\d+\.\s*/, '').trim())}</li>
        ))}
      </ol>
    </>
  );
}

function isFlagged(zone: ReviewZone, totalPagesHint: number): boolean {
  if (zone.approxItems < 2) return true;
  if (totalPagesHint > 0 && totalPagesHint < 30 && zone.endPage - zone.startPage > 20) return true;
  return false;
}

function ZoneCell({
  zone,
  totalPagesHint,
}: {
  zone: ReviewZone | null;
  totalPagesHint: number;
}) {
  if (!zone) {
    return <div className={styles.emptyCell}>—</div>;
  }
  const flagged = isFlagged(zone, totalPagesHint);
  return (
    <div className={styles.zoneCell}>
      {flagged && <span className={styles.flagDot} title="Possible detection issue" />}
      <div className={styles.zoneInfo}>
        <span className={styles.zoneName}>{zone.name}</span>
        <span className={styles.zoneMeta}>
          pp. {zone.startPage}–{zone.endPage} · ~{zone.approxItems} items
        </span>
      </div>
    </div>
  );
}

export default function ZoneReview({
  comparisonId,
  initialE1Zones,
  initialE2Zones,
  onConfirmed,
  onExit,
}: Props) {
  const [e1Zones, setE1Zones] = useState<ReviewZone[]>(initialE1Zones);
  const [e2Zones, setE2Zones] = useState<ReviewZone[]>(initialE2Zones);
  const [description, setDescription] = useState('');
  const [correcting, setCorrecting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [agentMessage, setAgentMessage] = useState<string | null>(null);
  const [correctionError, setCorrectionError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const rowCount = Math.max(e1Zones.length, e2Zones.length);
  const totalPagesHint = Math.max(
    e1Zones.length > 0 ? e1Zones[e1Zones.length - 1]!.endPage : 0,
    e2Zones.length > 0 ? e2Zones[e2Zones.length - 1]!.endPage : 0,
  );

  async function handleCorrect(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim() || correcting) return;
    setCorrecting(true);
    setAgentMessage(null);
    setCorrectionError(null);

    try {
      const res = await fetch(`/api/comparisons/${comparisonId}/zone-correction`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: description.trim() }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setCorrectionError(body.error ?? `Request failed (${res.status})`);
        return;
      }

      const data = await res.json() as {
        e1Zones: ReviewZone[];
        e2Zones: ReviewZone[];
        agentMessage: string | null;
      };

      if (data.agentMessage) {
        setAgentMessage(data.agentMessage);
        setTimeout(() => textareaRef.current?.focus(), 50);
      } else {
        setE1Zones(data.e1Zones);
        setE2Zones(data.e2Zones);
        setDescription('');
      }
    } catch {
      setCorrectionError('Network error — please try again.');
    } finally {
      setCorrecting(false);
    }
  }

  async function handleConfirm() {
    if (confirming) return;
    setConfirming(true);
    try {
      const res = await fetch(`/api/comparisons/${comparisonId}/zone-review/confirm`, {
        method: 'POST',
      });
      if (!res.ok) {
        setCorrectionError('Could not confirm — please try again.');
        setConfirming(false);
        return;
      }
      const data = await res.json() as { ok: boolean; reEntry?: boolean };
      onConfirmed({ reEntry: data.reEntry ?? false });
    } catch {
      setCorrectionError('Network error — please try again.');
      setConfirming(false);
    }
  }

  return (
    <div className={styles.shell}>
      <div className={styles.header}>
        <h1 className={styles.title}>Step 1 of 4 — Zone Detection Review</h1>
        <p className={styles.subtitle}>
          These zones have been detected but <strong>not yet matched to each other</strong>. Before
          matching begins, confirm both lists look right. If a zone is missing, misnamed, or
          shouldn&apos;t exist, describe the issue below and the agent will correct it. When
          everything looks accurate, click <strong>Looks good →</strong>.
        </p>
      </div>

      <div className={styles.tableWrap}>
        <div className={styles.tableGrid}>
          <div className={styles.colHead}>Your Estimate</div>
          <div className={styles.colHead}>Adjuster&apos;s Estimate</div>

          <div className={styles.zoneRows}>
            {Array.from({ length: rowCount }).map((_, i) => (
              <React.Fragment key={i}>
                <ZoneCell zone={e1Zones[i] ?? null} totalPagesHint={totalPagesHint} />
                <ZoneCell zone={e2Zones[i] ?? null} totalPagesHint={totalPagesHint} />
              </React.Fragment>
            ))}
            {rowCount === 0 && (
              <>
                <div className={styles.emptyCell}>No zones detected</div>
                <div className={styles.emptyCell}>No zones detected</div>
              </>
            )}
          </div>
        </div>
      </div>

      {agentMessage && (
        <div className={styles.agentMessage}>{renderAgentMessage(agentMessage)}</div>
      )}

      {correctionError && (
        <div className={styles.errorMessage}>{correctionError}</div>
      )}

      <form id="zone-correction-form" className={styles.inputSection} onSubmit={handleCorrect}>
        <label className={styles.inputLabel} htmlFor="zone-correction-input">
          Describe what needs to be corrected
        </label>
        <p className={styles.inputHint}>
          Tip: the more specific you are — naming the exact zone and what&apos;s wrong — the more
          accurately the agent can fix it before matching begins.{' '}This correction is powered by
          AI and may take up to 30 seconds to respond.
        </p>
        <textarea
          id="zone-correction-input"
          ref={textareaRef}
          className={styles.textarea}
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder='e.g. "The Kitchen zone is missing from my estimate" or "Master Suite and Master Bath should be treated as the same zone"'
          disabled={correcting || confirming}
        />
      </form>

      <div className={styles.bottomBar}>
        <span className={styles.hint}>
          {e1Zones.length} zone{e1Zones.length !== 1 ? 's' : ''} · {e2Zones.length} zone
          {e2Zones.length !== 1 ? 's' : ''}
        </span>
        <div className={styles.bottomActions}>
          {onExit && (
            <button type="button" className={styles.exitBtn} onClick={onExit} disabled={correcting || confirming}>
              Exit
            </button>
          )}
          <button
            type="submit"
            form="zone-correction-form"
            className={styles.submitBtn}
            disabled={!description.trim() || correcting || confirming}
          >
            {correcting ? 'Correcting…' : 'Apply correction'}
          </button>
          <button
            className={styles.confirmBtn}
            onClick={handleConfirm}
            disabled={correcting || confirming}
          >
            {confirming ? 'Starting…' : 'Looks good →'}
          </button>
        </div>
      </div>
    </div>
  );
}
