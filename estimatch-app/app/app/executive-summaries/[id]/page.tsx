'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import styles from './page.module.css';

type SummaryDetail = {
  id: string;
  markdown: string;
  instructions: string | null;
  createdAt: string;
  comparisonId: string;
  comparison: {
    name: string | null;
    insuredName: string | null;
    claimNumber: string | null;
    yourEstimateFilename: string;
    adjusterEstimateFilename: string;
  };
};

function markdownToHtml(md: string): string {
  function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function inline(s: string): string {
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>');
  }
  function parseRow(row: string): string[] {
    return row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  }

  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i].trim();

    if (!raw) { i++; continue; }

    // Headings
    if (raw.startsWith('### ')) { out.push(`<h3>${inline(raw.slice(4))}</h3>`); i++; continue; }
    if (raw.startsWith('## '))  { out.push(`<h2>${inline(raw.slice(3))}</h2>`); i++; continue; }
    if (raw.startsWith('# '))   { out.push(`<h1>${inline(raw.slice(2))}</h1>`); i++; continue; }

    // Horizontal rule
    if (/^---+$/.test(raw)) { out.push('<hr>'); i++; continue; }

    // Table — header row starts with |, next line is separator (|---|)
    if (raw.startsWith('|') && /^\|[\s\-:|]+\|/.test((lines[i + 1] ?? '').trim())) {
      const headers = parseRow(raw);
      i += 2; // skip header + separator
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        bodyRows.push(parseRow(lines[i]));
        i++;
      }
      const th = headers.map(h => `<th>${inline(h)}</th>`).join('');
      const tb = bodyRows.map(r =>
        `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`
      ).join('');
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`);
      continue;
    }

    // Unordered list
    if (raw.startsWith('- ') || raw.startsWith('* ')) {
      const items: string[] = [];
      while (i < lines.length) {
        const r = lines[i].trim();
        if (r.startsWith('- ') || r.startsWith('* ')) { items.push(`<li>${inline(r.slice(2))}</li>`); i++; }
        else if (!r) { i++; break; }
        else break;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+\. /.test(raw)) {
      const items: string[] = [];
      while (i < lines.length) {
        const r = lines[i].trim();
        if (/^\d+\. /.test(r)) { items.push(`<li>${inline(r.replace(/^\d+\. /, ''))}</li>`); i++; }
        else if (!r) { i++; break; }
        else break;
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // Paragraph — collect consecutive plain lines
    const para: string[] = [];
    while (i < lines.length) {
      const r = lines[i].trim();
      if (!r) { i++; break; }
      if (/^#{1,3} /.test(r) || r.startsWith('|') || r.startsWith('- ') || r.startsWith('* ') || /^\d+\. /.test(r) || /^---+$/.test(r)) break;
      para.push(inline(r));
      i++;
    }
    if (para.length) out.push(`<p>${para.join('<br>')}</p>`);
  }

  return out.join('\n');
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function summaryTitle(s: SummaryDetail): string {
  if (s.comparison.name) return s.comparison.name;
  if (s.comparison.insuredName) return s.comparison.insuredName;
  return `${s.comparison.yourEstimateFilename} vs ${s.comparison.adjusterEstimateFilename}`;
}

export default function ExecutiveSummaryViewPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const summaryId = params?.id;

  const [summary, setSummary] = useState<SummaryDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!summaryId) return;
    let isMounted = true;
    async function load() {
      setIsLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/executive-summaries/${summaryId}`);
        const payload = (await res.json()) as { error?: string; summary?: SummaryDetail };
        if (!res.ok) throw new Error(payload.error ?? 'Failed to load summary.');
        if (isMounted) setSummary(payload.summary ?? null);
      } catch (err) {
        if (isMounted) setError(err instanceof Error ? err.message : 'Failed to load summary.');
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }
    void load();
    return () => { isMounted = false; };
  }, [summaryId]);

  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  if (isLoading) {
    return (
      <div className={styles.loadingShell}>
        <div className={styles.spinner} />
        <p>Loading summary…</p>
      </div>
    );
  }

  if (error || !summary) {
    return (
      <div className={styles.errorShell}>
        <p>{error ?? 'Summary not found.'}</p>
        <button className={styles.backBtn} onClick={() => router.push('/app/executive-summaries')}>
          ← Back to summaries
        </button>
      </div>
    );
  }

  const htmlContent = markdownToHtml(summary.markdown);

  return (
    <div className={styles.page}>
      {/* ── Toolbar ── */}
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <Link href="/app/executive-summaries" className={styles.backBtn}>
            <svg viewBox="0 0 24 24" width="16" height="16"><polyline points="15 18 9 12 15 6" /></svg>
            Summaries
          </Link>
          <div className={styles.toolbarDivider} />
          <div className={styles.toolbarMeta}>
            <span className={styles.toolbarTitle}>{summaryTitle(summary)}</span>
            <span className={styles.toolbarDate}>{formatDate(summary.createdAt)}</span>
          </div>
        </div>
        <div className={styles.toolbarRight}>
          <Link href={`/app/comparison/${summary.comparisonId}`} className={styles.toolbarSecondaryBtn}>
            Open comparison
          </Link>
          <button className={styles.toolbarPrintBtn} onClick={handlePrint}>
            <svg viewBox="0 0 24 24" width="15" height="15"><polyline points="6 9 6 2 18 2 18 9" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="8" /></svg>
            Print / Save PDF
          </button>
        </div>
      </div>

      {/* ── Report body ── */}
      <div className={styles.reportShell}>
        <div className={styles.reportHeader}>
          <h1 className={styles.reportTitle}>Executive Summary</h1>
          <div className={styles.reportMeta}>
            <span>{summaryTitle(summary)}</span>
            {summary.comparison.claimNumber && (
              <span>Claim #{summary.comparison.claimNumber}</span>
            )}
            <span>{formatDate(summary.createdAt)}</span>
          </div>
          {summary.instructions && (
            <div className={styles.reportInstructions}>
              <strong>Custom instructions:</strong> {summary.instructions}
            </div>
          )}
        </div>
        <div
          className={styles.reportContent}
          dangerouslySetInnerHTML={{ __html: htmlContent }}
        />
        <div className={styles.reportFooter}>
          Generated by ScopeSplit &mdash; {formatDate(summary.createdAt)}
        </div>
      </div>
    </div>
  );
}
