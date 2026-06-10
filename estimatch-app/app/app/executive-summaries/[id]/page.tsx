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
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Tables
  html = html.replace(/(\|.+\|\n)((?:\|[-: ]+\|\n))((?:\|.+\|\n)*)/g, (_, header, sep, body) => {
    const parseRow = (row: string) =>
      row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    const headers = parseRow(header);
    const rows = body ? body.trim().split('\n').map(parseRow) : [];
    const th = headers.map(h => `<th>${h}</th>`).join('');
    const tb = rows.map((r: string[]) => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
    return `<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`;
  });

  // Headings
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Horizontal rules
  html = html.replace(/^---+$/gm, '<hr>');

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Code
  html = html.replace(/`(.+?)`/g, '<code>$1</code>');

  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>');
  html = html.replace(/<\/ul>\s*<ul>/g, '');

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Paragraphs (double newlines)
  html = html
    .split(/\n{2,}/)
    .map(block => {
      block = block.trim();
      if (!block) return '';
      if (/^<(h[1-6]|ul|ol|table|hr|li)/.test(block)) return block;
      return `<p>${block.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');

  return html;
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
