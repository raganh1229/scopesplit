'use client';

import { useEffect, useState, use } from 'react';
import Link from 'next/link';
import styles from './page.module.css';
import type { N3DashboardMetrics, FeatureStats, DecisionDetail } from '@/lib/n3/metrics/types';

type PageProps = { params: Promise<{ id: string }> };

export default function N3DashboardPage({ params }: PageProps) {
  const { id } = use(params);
  const [metrics, setMetrics] = useState<N3DashboardMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchMetrics = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/n3/dashboard/${id}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as N3DashboardMetrics;
      setMetrics(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchMetrics(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return <div className={styles.page}><p>Loading metrics…</p></div>;
  }
  if (error) {
    return (
      <div className={styles.page}>
        <Link href={`/app/comparison/${id}`} className={styles.backLink}>← Back to comparison</Link>
        <div className={styles.errorBox}>Failed to load metrics: {error}</div>
      </div>
    );
  }
  if (!metrics) return null;

  return (
    <div className={styles.page}>
      <Link href={`/app/comparison/${id}`} className={styles.backLink}>← Back to comparison</Link>

      <div className={styles.header}>
        <h1>N3 Verification Dashboard</h1>
        <div className={styles.headerMeta}>
          comparison <code>{metrics.comparisonId}</code><br/>
          generated {new Date(metrics.generatedAt).toLocaleString()}
        </div>
      </div>

      <PipelineHealthSection metrics={metrics} />
      <Phase4Section  metrics={metrics} />
      <Phase6Section  metrics={metrics} />
      <Phase8Section  metrics={metrics} />
      <Phase9Section  metrics={metrics} />
      <Phase11Section metrics={metrics} />
      <Phase12Section metrics={metrics} />
      <Phase13Section metrics={metrics} />
      <Phase14Section metrics={metrics} />
      <Phase15Section metrics={metrics} />
      <Phase16Section metrics={metrics} />
      <Phase17Section metrics={metrics} />
      <Phase18Section metrics={metrics} />
      <DecisionsSection metrics={metrics} />
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  const cls = status === 'green' ? styles.statusGreen : status === 'yellow' ? styles.statusYellow : styles.statusRed;
  return <span className={`${styles.statusDot} ${cls}`} />;
}

function fmt(n: number, digits = 2): string {
  if (Number.isNaN(n) || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className={styles.kv}><span className={styles.key}>{label}</span><span className={styles.value}>{value}</span></div>;
}

function Histogram({ values, labels, max }: { values: number[]; labels: string[]; max?: number }) {
  const peakValue = max ?? Math.max(...values, 1);
  return (
    <div>
      {values.map((v, i) => (
        <div key={i} className={styles.histogramRow}>
          <span className={styles.label}>{labels[i]}</span>
          <span><span className={styles.bar} style={{ width: `${(v / peakValue) * 100}%` }} /></span>
          <span className={styles.count}>{v}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Pipeline health ──────────────────────────────────────────────────────────

function PipelineHealthSection({ metrics }: { metrics: N3DashboardMetrics }) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2>Pipeline Health</h2>
      </div>
      <div className={styles.healthGrid}>
        {metrics.health.map(h => (
          <div key={h.phase} className={`${styles.healthCard} ${styles[h.status]}`}>
            <span className={styles.label}>{h.phase} {h.label}</span>
            <span className={styles.head}>{h.headline}</span>
            {h.flags.map((f, i) => <span key={i} className={styles.flag}>⚠ {f}</span>)}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Phase 4 ──────────────────────────────────────────────────────────────────

function Phase4Section({ metrics }: { metrics: N3DashboardMetrics }) {
  const h = metrics.health[0];
  const p = metrics.p4;
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <StatusDot status={h.status} /><h2>Phase 4 — Zone Detection</h2>
        <span className={styles.headline}>{h.headline}</span>
      </div>
      <div className={styles.kvGrid}>
        <KV label="yours zones"      value={p.yoursZoneCount} />
        <KV label="adj zones"        value={p.adjZoneCount} />
        <KV label="yours pages"      value={p.yoursPagesCovered} />
        <KV label="adj pages"        value={p.adjPagesCovered} />
        <KV label="empty zones"      value={p.emptyZones} />
        <KV label="oversized zones"  value={p.oversizedZones} />
      </div>
      <details>
        <summary>Zone listing ({p.zones.length})</summary>
        <table>
          <thead><tr><th>Side</th><th>Name</th><th className="num">Pages</th><th className="num">~Items</th></tr></thead>
          <tbody>
            {p.zones.map((z, i) => (
              <tr key={i}>
                <td>{z.side}</td>
                <td>{z.name}</td>
                <td className="num">{z.startPage}–{z.endPage}</td>
                <td className="num">{z.approxItems}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

// ─── Phase 6 ──────────────────────────────────────────────────────────────────

function Phase6Section({ metrics }: { metrics: N3DashboardMetrics }) {
  const h = metrics.health[1];
  const p = metrics.p6;
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <StatusDot status={h.status} /><h2>Phase 6 — Zone Correspondences</h2>
        <span className={styles.headline}>{h.headline}</span>
      </div>
      <div className={styles.kvGrid}>
        <KV label="correspondences"  value={p.correspondenceCount} />
        <KV label="avg confidence"   value={fmt(p.avgConfidence, 3)} />
        <KV label="unmatched yours"  value={p.unmatchedYoursZones} />
        <KV label="unmatched adj"    value={p.unmatchedAdjZones} />
        <KV label="one_to_one"       value={p.byType.one_to_one} />
        <KV label="one_to_many"      value={p.byType.one_to_many} />
        <KV label="many_to_one"      value={p.byType.many_to_one} />
      </div>
      <details>
        <summary>Correspondence list ({p.correspondences.length})</summary>
        <table>
          <thead><tr><th>Type</th><th className="num">Conf</th><th>Yours</th><th>Adj</th></tr></thead>
          <tbody>
            {p.correspondences.map((c, i) => (
              <tr key={i}>
                <td><span className={`${styles.tag} ${styles[c.type]}`}>{c.type}</span></td>
                <td className="num">{fmt(c.confidence, 2)}</td>
                <td>{c.yoursZones.join(', ')}</td>
                <td>{c.adjZones.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

// ─── Phase 8 ──────────────────────────────────────────────────────────────────

function Phase8Section({ metrics }: { metrics: N3DashboardMetrics }) {
  const h = metrics.health[2];
  const p = metrics.p8;
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <StatusDot status={h.status} /><h2>Phase 8 — Line Item Extraction</h2>
        <span className={styles.headline}>{h.headline}</span>
      </div>
      <div className={styles.kvGrid}>
        <KV label="yours items"          value={p.yoursItemCount} />
        <KV label="adj items"            value={p.adjItemCount} />
        <KV label="total items"          value={p.totalItems} />
        <KV label="items per zone (med)" value={fmt(p.itemsPerZone.median, 1)} />
        <KV label="items per zone range" value={`${p.itemsPerZone.min}–${p.itemsPerZone.max}`} />
        <KV label="avg extraction conf"  value={fmt(p.avgExtractionConfidence, 3)} />
        <KV label="missing total"        value={p.itemsMissingTotal} />
        <KV label="missing quantity"     value={p.itemsMissingQuantity} />
        <KV label="low confidence"       value={p.itemsLowConfidence} />
        <KV label="yours total $"        value={fmtMoney(p.yoursTotalAmount)} />
        <KV label="adj total $"          value={fmtMoney(p.adjTotalAmount)} />
        <KV label="estimate gap"         value={fmtMoney(p.estimateGap)} />
      </div>
    </div>
  );
}

// ─── Phase 9 ──────────────────────────────────────────────────────────────────

function Phase9Section({ metrics }: { metrics: N3DashboardMetrics }) {
  const h = metrics.health[3];
  const p = metrics.p9;
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <StatusDot status={h.status} /><h2>Phase 9 — Normalization</h2>
        <span className={styles.headline}>{h.headline}</span>
      </div>
      <div className={styles.kvGrid}>
        <KV label="quantity"      value={fmtPct(p.pctWithQuantity)} />
        <KV label="unit"          value={fmtPct(p.pctWithUnit)} />
        <KV label="trade"         value={fmtPct(p.pctWithTrade)} />
        <KV label="action"        value={fmtPct(p.pctWithAction)} />
        <KV label="special flags" value={fmtPct(p.pctWithSpecialFlags)} />
        <KV label="distinct trades"  value={p.distinctTrades} />
        <KV label="distinct actions" value={p.distinctActions} />
      </div>
      <details>
        <summary>Top trades / actions / flags</summary>
        <div className={styles.kvGrid}>
          <div>
            <strong>Top trades</strong>
            {p.topTrades.map((t, i) => <div key={i}>{t.value} ({t.count})</div>)}
          </div>
          <div>
            <strong>Top actions</strong>
            {p.topActions.map((t, i) => <div key={i}>{t.value} ({t.count})</div>)}
          </div>
          <div>
            <strong>Top flags</strong>
            {p.topFlags.map((t, i) => <div key={i}>{t.value} ({t.count})</div>)}
          </div>
        </div>
      </details>
    </div>
  );
}

// ─── Phase 11 ─────────────────────────────────────────────────────────────────

function Phase11Section({ metrics }: { metrics: N3DashboardMetrics }) {
  const h = metrics.health[4];
  const p = metrics.p11;
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <StatusDot status={h.status} /><h2>Phase 11 — Embeddings</h2>
        <span className={styles.headline}>{h.headline}</span>
      </div>
      <div className={styles.kvGrid}>
        <KV label="total rows"  value={p.totalRows} />
        <KV label="embedded"    value={p.embedded} />
        <KV label="missing"     value={p.missing} />
        <KV label="% embedded"  value={fmtPct(p.pctEmbedded)} />
      </div>
    </div>
  );
}

// ─── Phase 12 ─────────────────────────────────────────────────────────────────

function Phase12Section({ metrics }: { metrics: N3DashboardMetrics }) {
  const h = metrics.health[5];
  const p = metrics.p12;
  const nonZeroSources = Object.entries(p.bySource).filter(([, v]) => v > 0);
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <StatusDot status={h.status} /><h2>Phase 12 — Candidate Generation</h2>
        <span className={styles.headline}>{h.headline}</span>
      </div>
      <div className={styles.kvGrid}>
        <KV label="total edges"            value={p.totalEdges} />
        <KV label="items with 0 candidates" value={p.itemsWithZeroCandidates} />
        <KV label="avg candidates / yours"  value={fmt(p.avgCandidatesPerYours, 1)} />
        <KV label="avg candidates / adj"    value={fmt(p.avgCandidatesPerAdj, 1)} />
      </div>
      <h4 style={{ margin: '12px 0 4px' }}>Edges by retrieval source</h4>
      <Histogram
        values={nonZeroSources.map(([, v]) => v)}
        labels={nonZeroSources.map(([k]) => k)}
      />
      <h4 style={{ margin: '12px 0 4px' }}>Candidates per yours item</h4>
      <Histogram
        values={p.yoursCandidatesHistogram}
        labels={['0', '1–5', '6–15', '16–30', '31+']}
      />
      <h4 style={{ margin: '12px 0 4px' }}>Candidates per adj item</h4>
      <Histogram
        values={p.adjCandidatesHistogram}
        labels={['0', '1–5', '6–15', '16–30', '31+']}
      />
    </div>
  );
}

// ─── Phase 13 ─────────────────────────────────────────────────────────────────

function Phase13Section({ metrics }: { metrics: N3DashboardMetrics }) {
  const h = metrics.health[6];
  const p = metrics.p13;
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <StatusDot status={h.status} /><h2>Phase 13 — Scoring ⭐</h2>
        <span className={styles.headline}>{h.headline}</span>
      </div>
      <div className={styles.kvGrid}>
        <KV label="scored count"     value={p.scoredCount} />
        <KV label="survival rate"    value={fmtPct(p.survivalRate)} />
        <KV label="highConfidence"   value={p.bucketCounts.highConfidence} />
        <KV label="possibleMatch"    value={p.bucketCounts.possibleMatch} />
        <KV label="weakCandidate"    value={p.bucketCounts.weakCandidate} />
        <KV label="rejected"         value={p.bucketCounts.rejected} />
        <KV label="near REJECT"      value={p.borderline.nearReject} />
        <KV label="near POSSIBLE"    value={p.borderline.nearPossible} />
        <KV label="near HIGH_CONF"   value={p.borderline.nearHighConf} />
        <KV label="edges with boost" value={p.boostStats.edgesWithBoost} />
        <KV label="avg boost mag"    value={fmt(p.boostStats.avgBoostMagnitude, 3)} />
      </div>

      <h4 style={{ margin: '12px 0 4px' }}>Score histogram (all edges)</h4>
      <Histogram
        values={p.scoreHistogram}
        labels={['0.0–0.1', '0.1–0.2', '0.2–0.3', '0.3–0.4', '0.4–0.5', '0.5–0.6', '0.6–0.7', '0.7–0.8', '0.8–0.9', '0.9–1.0']}
      />

      <h4 style={{ margin: '12px 0 4px' }}>Per-feature contribution (sorted by discriminative power)</h4>
      <FeatureTable features={p.featureStats} />
    </div>
  );
}

function FeatureTable({ features }: { features: FeatureStats[] }) {
  return (
    <table className={styles.featureTable}>
      <thead>
        <tr>
          <th>Feature</th>
          <th className="num">Weight</th>
          <th className="num">Mean (all)</th>
          <th className="num">Mean (high)</th>
          <th className="num">Mean (rej)</th>
          <th className="num">Discrim</th>
          <th className="num">Std</th>
          <th className="num">% zero</th>
          <th className="num">Contrib</th>
        </tr>
      </thead>
      <tbody>
        {features.map(f => {
          const isDead = f.discriminativePower < 0.05;
          const isStrong = f.discriminativePower > 0.3;
          const cls = isDead ? styles.deadFeature : isStrong ? styles.strongFeature : '';
          return (
            <tr key={f.name} className={cls}>
              <td>{f.name}</td>
              <td className="num">{fmt(f.weight, 2)}</td>
              <td className="num">{fmt(f.meanAll, 3)}</td>
              <td className="num">{fmt(f.meanHighConf, 3)}</td>
              <td className="num">{fmt(f.meanRejected, 3)}</td>
              <td className="num"><strong>{fmt(f.discriminativePower, 3)}</strong></td>
              <td className="num">{fmt(f.std, 3)}</td>
              <td className="num">{fmtPct(f.pctZero)}</td>
              <td className="num">{fmt(f.weightedContribAll, 3)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── Phase 14 ─────────────────────────────────────────────────────────────────

function Phase14Section({ metrics }: { metrics: N3DashboardMetrics }) {
  const h = metrics.health[7];
  const p = metrics.p14;
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <StatusDot status={h.status} /><h2>Phase 14 — Components</h2>
        <span className={styles.headline}>{h.headline}</span>
      </div>
      <div className={styles.kvGrid}>
        <KV label="component count"      value={p.componentCount} />
        <KV label="largest size"         value={p.largestComponentSize} />
        <KV label="small / med / large"  value={`${p.bySize.small} / ${p.bySize.medium} / ${p.bySize.large}`} />
        <KV label="singletons (yours)"   value={p.singletonsYours} />
        <KV label="singletons (adj)"     value={p.singletonsAdj} />
      </div>
      <table>
        <thead>
          <tr>
            <th>#</th><th>Size</th><th className="num">Yours</th><th className="num">Adj</th>
            <th className="num">Edges</th><th className="num">Density</th><th>Ambiguous</th>
          </tr>
        </thead>
        <tbody>
          {p.components.map(c => (
            <tr key={c.idx}>
              <td>{c.idx}</td>
              <td>{c.size}</td>
              <td className="num">{c.yoursCount}</td>
              <td className="num">{c.adjCount}</td>
              <td className="num">{c.edgeCount}</td>
              <td className="num">{fmt(c.edgeDensity, 3)}</td>
              <td>{c.isAmbiguous ? 'yes' : 'no'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Phase 15 ─────────────────────────────────────────────────────────────────

function Phase15Section({ metrics }: { metrics: N3DashboardMetrics }) {
  const h = metrics.health[8];
  const p = metrics.p15;
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <StatusDot status={h.status} /><h2>Phase 15 — Hungarian Assignment</h2>
        <span className={styles.headline}>{h.headline}</span>
      </div>
      <div className={styles.kvGrid}>
        <KV label="decisions"        value={p.decisionCount} />
        <KV label="matched"          value={p.matchedCount} />
        <KV label="possible"         value={p.possibleCount} />
        <KV label="unmatched yours"  value={p.unmatchedYours} />
        <KV label="unmatched adj"    value={p.unmatchedAdj} />
        <KV label="matched score (mean)"  value={fmt(p.matchedScores.mean, 3)} />
        <KV label="matched score (range)" value={`${fmt(p.matchedScores.min, 3)}–${fmt(p.matchedScores.max, 3)}`} />
        <KV label="possible score (mean)" value={fmt(p.possibleScores.mean, 3)} />
        <KV label="possible score (range)" value={`${fmt(p.possibleScores.min, 3)}–${fmt(p.possibleScores.max, 3)}`} />
      </div>
      <h4 style={{ margin: '12px 0 4px' }}>Score histogram — matched (one_to_one)</h4>
      <Histogram
        values={p.scoreHistogramMatched}
        labels={['0.0–0.1', '0.1–0.2', '0.2–0.3', '0.3–0.4', '0.4–0.5', '0.5–0.6', '0.6–0.7', '0.7–0.8', '0.8–0.9', '0.9–1.0']}
      />
      <h4 style={{ margin: '12px 0 4px' }}>Score histogram — possible</h4>
      <Histogram
        values={p.scoreHistogramPossible}
        labels={['0.0–0.1', '0.1–0.2', '0.2–0.3', '0.3–0.4', '0.4–0.5', '0.5–0.6', '0.6–0.7', '0.7–0.8', '0.8–0.9', '0.9–1.0']}
      />
    </div>
  );
}

// ─── Phase 16 ─────────────────────────────────────────────────────────────────

function Phase16Section({ metrics }: { metrics: N3DashboardMetrics }) {
  const h = metrics.health[9];
  const p = metrics.p16;
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <StatusDot status={h.status} /><h2>Phase 16 — Group Matching</h2>
        <span className={styles.headline}>{h.headline}</span>
      </div>
      <div className={styles.kvGrid}>
        <KV label="grouped decisions"     value={p.groupedCount} />
        <KV label="adj items relinquished" value={p.relinquishedAdj} />
      </div>
    </div>
  );
}

// ─── Phase 17 ─────────────────────────────────────────────────────────────────

function Phase17Section({ metrics }: { metrics: N3DashboardMetrics }) {
  const h = metrics.health[10];
  const p = metrics.p17;
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <StatusDot status={h.status} /><h2>Phase 17 — LLM Adjudication</h2>
        <span className={styles.headline}>{h.headline}</span>
      </div>
      <div className={styles.kvGrid}>
        <KV label="adjudicated"  value={p.adjudicatedCount} />
        <KV label="accepted"     value={p.acceptedCount} />
        <KV label="rejected"     value={p.rejectedCount} />
        <KV label="cost"         value={`$${fmt(p.estimatedCostUsd, 4)}`} />
        <KV label="duration"     value={`${p.durationMs} ms`} />
        <KV label="agreement"    value={fmtPct(p.agreementRate)} />
      </div>

      {p.adjudicatedCount > 0 && (
        <>
          <h4 style={{ margin: '12px 0 4px' }}>Algo vs LLM confusion matrix</h4>
          <div className={styles.confusionMatrix}>
            <div className={styles.header}></div>
            <div className={styles.header}>LLM accept</div>
            <div className={styles.header}>LLM reject</div>
            <div className={styles.header}>Algo high (≥0.55)</div>
            <div className={styles.diag}>{p.confusionMatrix.algoHigh_llmAccept}</div>
            <div>{p.confusionMatrix.algoHigh_llmReject}</div>
            <div className={styles.header}>Algo low (&lt;0.55)</div>
            <div>{p.confusionMatrix.algoLow_llmAccept}</div>
            <div className={styles.diag}>{p.confusionMatrix.algoLow_llmReject}</div>
          </div>

          <h4 style={{ margin: '12px 0 4px' }}>Reasoning samples</h4>
          <table>
            <thead><tr><th>Decision</th><th className="num">Score</th><th>Yours</th><th>Adj</th><th>Reasoning</th></tr></thead>
            <tbody>
              {p.reasoningSamples.map(s => (
                <tr key={s.pairIndex}>
                  <td><span className={`${styles.tag} ${s.decision === 'match' ? styles.match : styles.unmatched}`}>{s.decision}</span></td>
                  <td className="num">{fmt(s.finalScore, 3)}</td>
                  <td>{s.yoursDesc}</td>
                  <td>{s.adjDesc}</td>
                  <td style={{ fontSize: 11, color: '#444' }}>{s.reasoning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// ─── Phase 18 ─────────────────────────────────────────────────────────────────

function Phase18Section({ metrics }: { metrics: N3DashboardMetrics }) {
  const h = metrics.health[11];
  const p = metrics.p18;
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <StatusDot status={h.status} /><h2>Phase 18 — Persisted Decisions</h2>
        <span className={styles.headline}>{h.headline}</span>
      </div>
      <div className={styles.kvGrid}>
        <KV label="line items"            value={p.lineItemCount} />
        <KV label="MATCH"                 value={p.byStatus.MATCH} />
        <KV label="MODIFIED"              value={p.byStatus.MODIFIED} />
        <KV label="MISSING_FROM_ADJUSTER" value={p.byStatus.MISSING_FROM_ADJUSTER} />
        <KV label="ADDED_BY_ADJUSTER"     value={p.byStatus.ADDED_BY_ADJUSTER} />
        <KV label="GROUPED"               value={p.byStatus.GROUPED} />
        <KV label="yours total $"         value={fmtMoney(p.yourEstimateTotal)} />
        <KV label="adj total $"           value={fmtMoney(p.adjEstimateTotal)} />
        <KV label="total gap"             value={fmtMoney(p.totalGap)} />
        <KV label="matched dollars"       value={fmtMoney(p.matchedDollars)} />
        <KV label="matched $ %"           value={fmtPct(p.matchedDollarPct)} />
      </div>
      <h4 style={{ margin: '12px 0 4px' }}>Decision provenance</h4>
      <table>
        <thead><tr><th>decided_by</th><th className="num">count</th></tr></thead>
        <tbody>
          {Object.entries(p.byProvenance).map(([k, v]) => (
            <tr key={k}><td>{k}</td><td className="num">{v}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Per-decision drill-down ──────────────────────────────────────────────────

function DecisionsSection({ metrics }: { metrics: N3DashboardMetrics }) {
  const [filter, setFilter] = useState<string>('all');

  const filtered = filter === 'all'
    ? metrics.decisions
    : metrics.decisions.filter(d => d.decisionType === filter);

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2>Per-Decision Drill-Down ({metrics.decisions.length})</h2>
        <select value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="all">all</option>
          <option value="one_to_one">one_to_one</option>
          <option value="possible">possible</option>
          <option value="unmatched">unmatched</option>
          <option value="grouped">grouped</option>
        </select>
      </div>
      <table className={styles.decisionTable}>
        <thead>
          <tr>
            <th>Type</th>
            <th>Decided by</th>
            <th className="num">Score</th>
            <th>Yours</th>
            <th>Adj</th>
            <th className="num">Yours $</th>
            <th className="num">Adj $</th>
            <th className="num">Diff</th>
            <th>Reasoning</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((d: DecisionDetail) => (
            <tr key={d.id}>
              <td><span className={`${styles.tag} ${styles[d.decisionType]}`}>{d.decisionType}</span></td>
              <td>{d.decidedBy}</td>
              <td className="num">{fmt(d.finalScore, 3)}</td>
              <td title={d.yoursDesc ?? ''}>{d.yoursDesc?.slice(0, 60)}</td>
              <td title={d.adjDesc ?? ''}>{d.adjDesc?.slice(0, 60)}</td>
              <td className="num">{d.yoursTotal != null ? fmtMoney(d.yoursTotal) : '—'}</td>
              <td className="num">{d.adjTotal   != null ? fmtMoney(d.adjTotal)   : '—'}</td>
              <td className="num">{d.diff       != null ? fmtMoney(d.diff)       : '—'}</td>
              <td title={d.llmReasoning ?? ''} style={{ fontSize: 11, color: '#666' }}>
                {d.llmReasoning?.slice(0, 80)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
