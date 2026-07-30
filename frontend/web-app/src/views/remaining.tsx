/**
 * Modul Domain 2 (Visualisasi & Pelaporan), 3 (Analitik Cerdas), 6 (Monitoring),
 * 7 (Administrasi Sistem), dan 8 (Langganan & Billing).
 */
import { useState } from 'react';
import { useApp } from '../app/AppContext.tsx';
import { api, ApiError, type AuditRow, type Dataset, type KpiSummary, type MfaStatus } from '../lib/api.ts';
import { useAsync } from '../lib/useAsync.ts';
import {
  formatAuditTimestamp, formatBytes, formatCurrency, formatDate, formatDateTime,
  formatDecimal, formatNumber, currentPeriod,
} from '../lib/format.ts';
import { Bar, EmptyState, Field, Legend, LineChart, Panel, Segmented, StatTile, StatusTag, ThresholdRing, Toggle } from '../components/primitives.tsx';
import { PageHead, ViewState, WarningList } from './shared.tsx';

/* ================= Dashboard Designer — PRD 6.3 ================= */

interface DashboardRow { id: string; name: string; description: string | null; template_code: string | null; version: number; published_at: string | null; widgets: number; updated_at: string }

export function DashboardDesignerView(): JSX.Element {
  const { t, locale, can, session } = useApp();
  const state = useAsync(() => api.get<{ dashboards: DashboardRow[]; templates: Array<{ code: string; nameId: string; nameEn: string; sector: string }> }>('/dashboards'), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const detail = useAsync(
    () => (selected ? api.get<{ id: string; name: string; draft: Array<{ id: string; type: string; title: string }> }>(`/dashboards/${selected}`) : Promise.resolve(null)),
    [selected],
  );

  async function publish(): Promise<void> {
    if (!selected) return;
    try {
      await api.post(`/dashboards/${selected}/publish`);
      state.reload();
      setMessage('action.publish');
    } catch (error) {
      setMessage(error instanceof ApiError ? error.key : 'error.internal');
    }
  }

  return (
    <div className="view-enter">
      <PageHead title="Dashboard Designer" subtitle={locale === 'id' ? 'Susun widget, simpan sebagai draf, lalu publikasikan' : 'Arrange widgets, save as draft, then publish'} />
      {message && <div className="note info" style={{ marginBottom: 16 }}>{t(message)}</div>}
      <ViewState state={state}>
        {(data) => (
          <div className="designer">
            <div className="dz-panel">
              <div className="dz-title">{locale === 'id' ? 'Dashboard' : 'Dashboards'}</div>
              {data.dashboards.length === 0 ? (
                <EmptyState messageKey="empty.no_dashboard" />
              ) : (
                data.dashboards.map((d) => (
                  <button key={d.id} type="button" className="widget-item" onClick={() => setSelected(d.id)} style={{ borderColor: selected === d.id ? 'var(--accent)' : undefined }}>
                    <span style={{ flex: 1 }}>{d.name}</span>
                    <StatusTag status={d.published_at ? 'active' : 'draft'} />
                  </button>
                ))
              )}
              <div className="dz-title" style={{ marginTop: 16 }}>{locale === 'id' ? 'Template Lintas Bidang' : 'Cross-sector Templates'}</div>
              {data.templates.map((template) => (
                <div className="widget-item" key={template.code}>{locale === 'en' ? template.nameEn : template.nameId}</div>
              ))}
            </div>

            <div className="canvas-area">
              {!detail.data ? (
                <EmptyState messageKey="empty.no_dashboard" />
              ) : (
                <div className="canvas-grid">
                  {detail.data.draft.map((widget) => (
                    <div className="w-block" key={widget.id} style={{ gridColumn: widget.type === 'table' ? 'span 4' : 'span 2' }}>
                      <span className="tag">{widget.type}</span>
                      <div style={{ fontSize: 12.5, fontWeight: 600, marginTop: 4 }}>{widget.title}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="dz-panel">
              <div className="dz-title">{locale === 'id' ? 'Properti' : 'Properties'}</div>
              {selected && can('dashboard:publish') && !session?.flags.readOnly && (
                <button type="button" className="btn primary" onClick={() => void publish()}>{t('action.publish')}</button>
              )}
              <div className="note" style={{ marginTop: 12 }}>
                {locale === 'id' ? 'Perubahan tersimpan sebagai draf sebelum dipublikasikan.' : 'Changes are saved as a draft before publishing.'}
              </div>
            </div>
          </div>
        )}
      </ViewState>
    </div>
  );
}

/* ================= Report Designer — PRD 6.4 ================= */

export function ReportDesignerView(): JSX.Element {
  const { t, locale, session } = useApp();
  const state = useAsync(() => api.get<{ reports: Array<{ id: string; name: string; watermark: string | null; schedule_cron: string | null }> }>('/reports'), []);

  return (
    <div className="view-enter">
      <PageHead title="Report Designer" subtitle={locale === 'id' ? 'Laporan pixel-perfect siap cetak, dengan watermark & tanda tangan' : 'Pixel-perfect print-ready reports with watermark & signature'} />
      <ViewState state={state}>
        {(data) => (
          <div className="grid g-12">
            <Panel title={locale === 'id' ? 'Daftar Laporan' : 'Reports'} span="half">
              {data.reports.length === 0 ? (
                <EmptyState messageKey="empty.no_data" />
              ) : (
                data.reports.map((report) => (
                  <div className="feed-item" key={report.id}>
                    <div>
                      <b>{report.name}</b>
                      <div className="feed-time">
                        {report.watermark && report.watermark !== 'none' ? `${report.watermark} · ` : ''}
                        {report.schedule_cron ?? (locale === 'id' ? 'tanpa jadwal' : 'no schedule')}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </Panel>

            <Panel title={locale === 'id' ? 'Pratinjau Kertas A4' : 'A4 Paper Preview'} span="half">
              {/* Kertas SELALU putih di kedua mode — mewakili hasil cetak fisik (DESIGN.md 7.3). */}
              <div className="paper">
                <div className="wm">{data.reports[0]?.watermark?.toUpperCase() ?? 'DRAFT'}</div>
                <div className="paper-head">
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{session?.tenant.name}</div>
                    <div style={{ fontSize: 9, color: '#8d96aa' }}>{data.reports[0]?.name ?? '—'}</div>
                  </div>
                  <div style={{ fontSize: 9, color: '#8d96aa' }}>{formatDate(new Date().toISOString(), locale)}</div>
                </div>
                <div style={{ fontSize: 10, lineHeight: 1.7, color: '#4a5468' }}>
                  {locale === 'id'
                    ? 'Isi laporan dirender dari blok yang disusun di Report Designer. Hasil layar dan hasil cetak dibangun dari struktur yang sama agar identik.'
                    : 'Report content is rendered from blocks arranged in Report Designer. Screen and print output are built from the same structure so they match.'}
                </div>
                <div className="sig-block">
                  <div className="sig-box">
                    <div className="line">{locale === 'id' ? 'Tanda tangan digital' : 'Digital signature'}</div>
                  </div>
                </div>
                {/* BRAND.md Bagian 8: atribusi kecil di FOOTER, bukan header. */}
                <div className="paper-foot">
                  <span>{session?.tenant.name}</span>
                  {!session?.tenant.whiteLabel && <span>{t('ui.attribution')}</span>}
                </div>
              </div>
            </Panel>
          </div>
        )}
      </ViewState>
    </div>
  );
}

/* ================= Interactive Visualization — PRD 6.5 ================= */

export function VisualizationView(): JSX.Element {
  const { t, locale } = useApp();
  const state = useAsync(() => api.get<{ catalog: Array<{ code: string; label: string; family: string; supportsDrillDown: boolean; supportsCrossFilter: boolean }> }>('/visualizations'), []);
  const [family, setFamily] = useState<string>('all');

  return (
    <div className="view-enter">
      <ViewState state={state}>
        {(data) => {
          const families = ['all', ...new Set(data.catalog.map((v) => v.family))];
          const visible = family === 'all' ? data.catalog : data.catalog.filter((v) => v.family === family);
          return (
            <>
              <PageHead
                title="Interactive Visualization"
                subtitle={`${data.catalog.length} ${locale === 'id' ? 'jenis visual · drill-down, cross-filter, tooltip kontekstual' : 'visual types · drill-down, cross-filter, contextual tooltips'}`}
                actions={<Segmented value={family} onChange={setFamily} options={families.slice(0, 6).map((f) => ({ value: f, label: f }))} />}
              />
              <div className="grid g-12">
                <Panel span="full">
                  <div className="viz-grid">
                    {visible.map((visual) => (
                      <div className="viz-card" key={visual.code} title={`${visual.label} · ${visual.family}`}>
                        <div className="lbl">{visual.label}</div>
                        <div className="fam">{visual.family}</div>
                      </div>
                    ))}
                  </div>
                </Panel>
                <div className="note">{t('ui.showing_rows', { shown: visible.length, total: data.catalog.length })}</div>
              </div>
            </>
          );
        }}
      </ViewState>
    </div>
  );
}

/* ================= Embed Dashboard — PRD 6.21 ================= */

export function EmbedView(): JSX.Element {
  const { t, locale, can } = useApp();
  const dashboards = useAsync(() => api.get<{ dashboards: DashboardRow[] }>('/dashboards'), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [domains, setDomains] = useState('https://example.org');
  const [issued, setIssued] = useState<{ token: string; iframeSnippet: string; sdkSnippet: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const tokens = useAsync(
    () =>
      selected
        ? api.get<{ tokens: Array<{ id: string; label: string | null; mode: string; expires_at: string; revoked_at: string | null; domains: string[]; views: number }>; usage: { totalViews: number; denials: number } }>(`/dashboards/${selected}/embed-tokens`)
        : Promise.resolve(null),
    [selected],
  );

  async function issue(): Promise<void> {
    if (!selected) return;
    setMessage(null);
    try {
      setIssued(await api.post(`/dashboards/${selected}/embed-tokens`, {
        domainWhitelist: domains.split(',').map((d) => d.trim()).filter(Boolean),
        mode: 'interactive',
        expiresInDays: 30,
      }));
      tokens.reload();
    } catch (error) {
      setMessage(error instanceof ApiError ? error.key : 'error.internal');
    }
  }

  return (
    <div className="view-enter">
      <PageHead title="Embed Dashboard" subtitle={locale === 'id' ? 'Token per dashboard, domain whitelist, RLS diwariskan' : 'Per-dashboard tokens, domain whitelist, inherited RLS'} />
      {message && <div className="note warn" style={{ marginBottom: 16 }}>{t(message)}</div>}
      <ViewState state={dashboards}>
        {(data) => (
          <div className="grid g-12">
            <Panel title={locale === 'id' ? 'Pilih Dashboard' : 'Select Dashboard'} span="small">
              {data.dashboards.filter((d) => d.published_at).length === 0 ? (
                <EmptyState messageKey="empty.no_dashboard" />
              ) : (
                data.dashboards.filter((d) => d.published_at).map((d) => (
                  <button key={d.id} type="button" className="widget-item" onClick={() => setSelected(d.id)} style={{ borderColor: selected === d.id ? 'var(--accent)' : undefined }}>
                    {d.name}
                  </button>
                ))
              )}
              {selected && can('embed:write') && (
                <>
                  <Field label={locale === 'id' ? 'Domain Diizinkan' : 'Allowed Domains'} hint={locale === 'id' ? 'Ditegakkan di server, bukan hanya di klien.' : 'Enforced server-side, not only in the client.'}>
                    <input value={domains} onChange={(e) => setDomains(e.target.value)} />
                  </Field>
                  <button type="button" className="btn primary" onClick={() => void issue()}>{t('action.add_new')}</button>
                </>
              )}
            </Panel>

            <Panel title={locale === 'id' ? 'Token Sematan' : 'Embed Tokens'} span="wide">
              {!tokens.data || tokens.data.tokens.length === 0 ? (
                <EmptyState messageKey="empty.no_data" />
              ) : (
                <>
                  <div className="stat-grid" style={{ marginBottom: 14 }}>
                    <StatTile label={locale === 'id' ? 'Total Tampilan' : 'Total Views'} value={formatNumber(tokens.data.usage.totalViews, locale)} />
                    <StatTile label={locale === 'id' ? 'Permintaan Ditolak' : 'Denied Requests'} value={formatNumber(tokens.data.usage.denials, locale)} />
                  </div>
                  <div className="table-scroll">
                    <table className="stack-mobile">
                      <thead>
                        <tr><th>{t('table.name')}</th><th>{locale === 'id' ? 'Domain' : 'Domains'}</th><th>{locale === 'id' ? 'Kedaluwarsa' : 'Expires'}</th><th>{t('table.status')}</th></tr>
                      </thead>
                      <tbody>
                        {tokens.data.tokens.map((token) => (
                          <tr key={token.id}>
                            <td data-label={t('table.name')}>{token.label ?? token.id}</td>
                            <td className="mono" data-label="Domains">{token.domains.join(', ')}</td>
                            <td data-label="Expires">{formatDate(token.expires_at, locale)}</td>
                            <td data-label={t('table.status')}><StatusTag status={token.revoked_at ? 'rejected' : 'active'} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {issued && (
                <div style={{ marginTop: 16 }}>
                  <div className="dz-title">iframe</div>
                  <pre className="mono" style={{ background: 'var(--canvas)', padding: 12, borderRadius: 'var(--radius-sm)', overflowX: 'auto', fontSize: 11 }}>{issued.iframeSnippet}</pre>
                  <div className="dz-title">JS SDK</div>
                  <pre className="mono" style={{ background: 'var(--canvas)', padding: 12, borderRadius: 'var(--radius-sm)', overflowX: 'auto', fontSize: 11 }}>{issued.sdkSnippet}</pre>
                </div>
              )}
            </Panel>
          </div>
        )}
      </ViewState>
    </div>
  );
}

/* ================= AI Analytics — PRD 6.6 ================= */

export function AiAnalyticsView(): JSX.Element {
  const { t, locale } = useApp();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<{
    narrative: { key: string; params: Record<string, string | number> };
    breakdown: Array<{ label: string; value: number; sharePercent: number }>;
    sources: Array<{ datasetName: string; certification: string; period: string }>;
    provider: string;
  } | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function ask(): Promise<void> {
    if (!question.trim()) return;
    setBusy(true);
    setErrorKey(null);
    try {
      setAnswer(await api.post('/ai/ask', { question, locale }));
    } catch (error) {
      setAnswer(null);
      setErrorKey(error instanceof ApiError ? error.key : 'error.internal');
    } finally {
      setBusy(false);
    }
  }

  const max = Math.max(1, ...(answer?.breakdown.map((b) => b.value) ?? [1]));

  return (
    <div className="view-enter">
      <PageHead title="AI Analytics" subtitle={locale === 'id' ? 'Tanya dalam bahasa natural; jawaban selalu mencantumkan sumber data' : 'Ask in natural language; answers always cite their data sources'} />
      <div className="grid g-12">
        <Panel span="full">
          <div className="cop-input" style={{ border: 'none', padding: 0 }}>
            <input
              value={question}
              placeholder={t('ai.ask_placeholder')}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void ask()}
            />
            <button type="button" onClick={() => void ask()} disabled={busy} aria-label={t('action.run')}>→</button>
          </div>
        </Panel>

        {errorKey && <div className="note warn" style={{ gridColumn: 'span 12' }}>{t(errorKey)}</div>}

        {answer && (
          <>
            <Panel span="wide" title={locale === 'id' ? 'Jawaban' : 'Answer'}>
              <p style={{ fontSize: 13.4, lineHeight: 1.7 }}>{t(answer.narrative.key, answer.narrative.params)}</p>
              <div style={{ marginTop: 14 }}>
                {answer.breakdown.slice(0, 10).map((row) => (
                  <Bar key={row.label} label={row.label} value={row.value} max={max} formatted={`${formatDecimal(row.value, locale, 1)} · ${formatDecimal(row.sharePercent, locale, 1)}%`} />
                ))}
              </div>
            </Panel>

            {/* Sumber data & periode WAJIB tercantum (PRD 6.6, SECURITY.md 11). */}
            <Panel span="small" title={t('ai.sources_label')}>
              {answer.sources.map((source) => (
                <div className="feed-item" key={source.datasetName}>
                  <div>
                    <b>{source.datasetName}</b>
                    <div className="feed-time">
                      <StatusTag status={source.certification} /> · {formatDate(source.period, locale)}
                    </div>
                  </div>
                </div>
              ))}
              <div className="note" style={{ marginTop: 10 }}>provider: <span className="mono">{answer.provider}</span></div>
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}

/* ================= Forecast Analytics — PRD 6.7 ================= */

export function ForecastView(): JSX.Element {
  const { t, locale } = useApp();
  const kpis = useAsync(() => api.get<{ kpis: KpiSummary[] }>('/kpis'), []);
  const [kpiId, setKpiId] = useState<string | null>(null);
  const [method, setMethod] = useState<'linear_regression' | 'arima' | 'prophet'>('linear_regression');
  const [horizon, setHorizon] = useState(6);
  const [result, setResult] = useState<{ points: Array<{ period: number; value: number; lower: number; upper: number }>; mape: number; warnings: string[] } | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  async function run(): Promise<void> {
    if (!kpiId) return;
    setErrorKey(null);
    try {
      const history = await api.get<{ history: Array<{ period: string; value: number }> }>(`/kpis/${kpiId}/history?limit=36`);
      const series = [...history.history].reverse().map((h) => h.value);
      setResult(await api.post('/forecast', { series, horizon, method, kpiId }));
    } catch (error) {
      setResult(null);
      setErrorKey(error instanceof ApiError ? error.key : 'error.internal');
    }
  }

  return (
    <div className="view-enter">
      <PageHead title="Forecast Analytics" subtitle={locale === 'id' ? 'Linear Regression, ARIMA, Prophet — dengan interval kepercayaan & MAPE' : 'Linear Regression, ARIMA, Prophet — with confidence intervals & MAPE'} />
      <div className="grid g-12">
        <Panel title={locale === 'id' ? 'Konfigurasi' : 'Configuration'} span="small">
          <Field label="KPI Center">
            <select value={kpiId ?? ''} onChange={(e) => setKpiId(e.target.value || null)}>
              <option value="">—</option>
              {(kpis.data?.kpis ?? []).map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
            </select>
          </Field>
          <Field label={locale === 'id' ? 'Metode' : 'Method'}>
            <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
              <option value="linear_regression">Linear Regression</option>
              <option value="arima">ARIMA</option>
              <option value="prophet">Prophet</option>
            </select>
          </Field>
          <Field label={locale === 'id' ? 'Horizon (bulan)' : 'Horizon (months)'}>
            <select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
              {[1, 3, 6, 12].map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
          </Field>
          <button type="button" className="btn primary" disabled={!kpiId} onClick={() => void run()}>{t('action.run')}</button>
        </Panel>

        <Panel title={locale === 'id' ? 'Proyeksi' : 'Projection'} span="wide" actions={result && <Legend items={[{ label: locale === 'id' ? 'Proyeksi' : 'Forecast', colour: 'var(--series-1)' }, { label: locale === 'id' ? 'Batas Atas/Bawah' : 'Upper/Lower', colour: 'var(--text-400)' }]} />}>
          {errorKey && <div className="note warn">{t(errorKey)}</div>}
          {!result ? (
            <EmptyState messageKey="empty.no_data" />
          ) : (
            <>
              <div className="stat-grid" style={{ marginBottom: 14 }}>
                <StatTile label="MAPE" value={`${formatDecimal(result.mape, locale, 2)}%`} />
                <StatTile label={locale === 'id' ? 'Horizon' : 'Horizon'} value={String(result.points.length)} />
              </div>
              <LineChart
                series={[
                  { name: 'forecast', points: result.points.map((p) => p.value) },
                  { name: 'lower', points: result.points.map((p) => p.lower), colour: 'var(--text-400)', dashed: true },
                  { name: 'upper', points: result.points.map((p) => p.upper), colour: 'var(--text-400)', dashed: true },
                ]}
              />
              <div className="table-scroll" style={{ marginTop: 12 }}>
                <table className="stack-mobile">
                  <thead><tr><th>t+</th><th>{t('table.value')}</th><th>{locale === 'id' ? 'Bawah' : 'Lower'}</th><th>{locale === 'id' ? 'Atas' : 'Upper'}</th></tr></thead>
                  <tbody>
                    {result.points.map((p) => (
                      <tr key={p.period}>
                        <td className="mono" data-label="t+">{p.period}</td>
                        <td className="num" data-label={t('table.value')}>{formatDecimal(p.value, locale, 2)}</td>
                        <td className="num" data-label="Lower">{formatDecimal(p.lower, locale, 2)}</td>
                        <td className="num" data-label="Upper">{formatDecimal(p.upper, locale, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Panel>
        {result && <WarningList keys={result.warnings} />}
      </div>
    </div>
  );
}

/* ================= Root Cause Analysis — PRD 6.8 ================= */

export function RcaView(): JSX.Element {
  const { t, locale } = useApp();
  const state = useAsync(() => api.get<{ records: Array<{ id: string; title: string; status: string; created_at: string }> }>('/rca'), []);

  return (
    <div className="view-enter">
      <PageHead title="Root Cause Analysis" subtitle={locale === 'id' ? 'Fishbone, 5 Why, dan Pareto otomatis — selalu berstatus draf' : 'Automatic fishbone, 5 Why and Pareto — always in draft status'} />
      <ViewState state={state}>
        {(data) => (
          <div className="grid g-12">
            {/* BRAND.md Bagian 2: jujur tentang keterbatasan AI. */}
            <div className="note warn" style={{ gridColumn: 'span 12' }}>{t('rca.draft_requires_human_validation')}</div>
            <Panel span="full" title={locale === 'id' ? 'Catatan RCA' : 'RCA Records'}>
              {data.records.length === 0 ? (
                <EmptyState messageKey="empty.no_data" />
              ) : (
                <div className="table-scroll">
                  <table className="stack-mobile">
                    <thead><tr><th>{t('table.name')}</th><th>{t('table.status')}</th><th>{t('table.created_at')}</th></tr></thead>
                    <tbody>
                      {data.records.map((record) => (
                        <tr key={record.id}>
                          <td data-label={t('table.name')}>{record.title}</td>
                          <td data-label={t('table.status')}><StatusTag status={record.status} /></td>
                          <td data-label={t('table.created_at')}>{formatDate(record.created_at, locale)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </div>
        )}
      </ViewState>
    </div>
  );
}

/* ================= Data Discovery — PRD 6.9 ================= */

export function DiscoveryView(): JSX.Element {
  const { t, locale } = useApp();
  const datasets = useAsync(() => api.get<{ datasets: Dataset[] }>('/datasets'), []);
  const [datasetId, setDatasetId] = useState<string | null>(null);
  const result = useAsync(
    () =>
      datasetId
        ? api.get<{
            outliers: Array<{ field: string; rowIndex: number; value: number; zScore: number; method: string }>;
            correlations: Array<{ fieldA: string; fieldB: string; coefficient: number; pValue: number; significant: boolean }>;
            clusters: Array<{ id: number; size: number; centroid: Record<string, number> }>;
          }>(`/discovery/${datasetId}`)
        : Promise.resolve(null),
    [datasetId],
  );

  return (
    <div className="view-enter">
      <PageHead
        title="Data Discovery"
        subtitle={locale === 'id' ? 'Outlier, korelasi, dan clustering otomatis' : 'Automatic outliers, correlations and clustering'}
        actions={
          <select value={datasetId ?? ''} onChange={(e) => setDatasetId(e.target.value || null)} style={{ padding: '8px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-900)' }}>
            <option value="">—</option>
            {(datasets.data?.datasets ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        }
      />
      <div className="grid g-12">
        {!result.data ? (
          <Panel span="full"><EmptyState messageKey="empty.no_dataset" /></Panel>
        ) : (
          <>
            <Panel title={locale === 'id' ? 'Outlier & Anomali' : 'Outliers & Anomalies'} span="half">
              {result.data.outliers.length === 0 ? <EmptyState messageKey="empty.no_data" /> : (
                <div className="table-scroll">
                  <table className="stack-mobile">
                    <thead><tr><th>{locale === 'id' ? 'Kolom' : 'Column'}</th><th>{t('table.value')}</th><th>z</th><th>{locale === 'id' ? 'Metode' : 'Method'}</th></tr></thead>
                    <tbody>
                      {result.data.outliers.slice(0, 25).map((o, i) => (
                        <tr key={i}>
                          <td className="mono" data-label="Column">{o.field}</td>
                          <td className="num" data-label={t('table.value')}>{formatDecimal(o.value, locale, 2)}</td>
                          <td className="num" data-label="z">{formatDecimal(o.zScore, locale, 2)}</td>
                          <td data-label="Method">{o.method}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            <Panel title={locale === 'id' ? 'Korelasi Signifikan' : 'Significant Correlations'} span="half">
              {result.data.correlations.length === 0 ? <EmptyState messageKey="empty.no_data" /> : (
                <div className="table-scroll">
                  <table className="stack-mobile">
                    <thead><tr><th>A</th><th>B</th><th>r</th><th>{t('stats.p_value')}</th></tr></thead>
                    <tbody>
                      {result.data.correlations.map((c, i) => (
                        <tr key={i}>
                          <td className="mono" data-label="A">{c.fieldA}</td>
                          <td className="mono" data-label="B">{c.fieldB}</td>
                          <td className="num" data-label="r">{formatDecimal(c.coefficient, locale, 3)}</td>
                          <td className="num" data-label="p">{formatDecimal(c.pValue, locale, 4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="note info" style={{ marginTop: 10 }}>{t('note.correlation_not_causation')}</div>
            </Panel>

            <Panel title={locale === 'id' ? 'Klaster' : 'Clusters'} span="full">
              <div className="stat-grid">
                {result.data.clusters.map((cluster) => (
                  <StatTile key={cluster.id} label={`Cluster ${cluster.id + 1}`} value={`${formatNumber(cluster.size, locale)} ${t('table.rows').toLowerCase()}`} />
                ))}
              </div>
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}

/* ================= AI Narrative Report — PRD 6.10 ================= */

export function NarrativeView(): JSX.Element {
  const { t, locale } = useApp();
  const state = useAsync(() => api.get<{ reports: Array<{ id: string; period: string; generated_at: string; sent_at: string | null }> }>('/narrative'), []);
  const [generated, setGenerated] = useState<{
    sections: Array<{ headingKey: string; facts: Array<{ key: string; params: Record<string, string | number> }> }>;
    recommendations: Array<{ key: string; params: Record<string, string | number> }>;
  } | null>(null);

  async function generate(): Promise<void> {
    const period = currentPeriod();
    const [y, m] = period.split('-').map(Number);
    const compare = new Date(Date.UTC(y!, m! - 2, 1)).toISOString().slice(0, 7);
    setGenerated(await api.post('/narrative/generate', { period, comparePeriod: compare, locale }));
    state.reload();
  }

  return (
    <div className="view-enter">
      <PageHead
        title="AI Narrative Report"
        subtitle={locale === 'id' ? 'Ringkasan naratif otomatis dengan pembanding periode' : 'Automatic narrative summary with period comparison'}
        actions={<button type="button" className="btn primary" onClick={() => void generate()}>{t('action.generate')}</button>}
      />
      <div className="grid g-12">
        {generated ? (
          generated.sections.map((section) => (
            <Panel key={section.headingKey} title={t(section.headingKey)} span="full">
              {section.facts.length === 0 ? <EmptyState messageKey="empty.no_data" /> : (
                <ul style={{ margin: 0, paddingInlineStart: 18, lineHeight: 1.9, fontSize: 13 }}>
                  {section.facts.map((fact, i) => <li key={i}>{t(fact.key, fact.params)}</li>)}
                </ul>
              )}
            </Panel>
          ))
        ) : (
          <Panel span="full"><EmptyState messageKey="empty.no_data" /></Panel>
        )}
        {generated && generated.recommendations.length > 0 && (
          <Panel title={locale === 'id' ? 'Rekomendasi' : 'Recommendations'} span="full">
            <ul style={{ margin: 0, paddingInlineStart: 18, lineHeight: 1.9, fontSize: 13 }}>
              {generated.recommendations.map((r, i) => <li key={i}>{t(r.key, r.params)}</li>)}
            </ul>
          </Panel>
        )}
      </div>
    </div>
  );
}

/* ================= Alert Center — PRD 6.16 ================= */

export function AlertCenterView(): JSX.Element {
  const { t, locale, can } = useApp();
  const rules = useAsync(() => api.get<{ rules: Array<{ id: string; name: string; comparator: string; threshold: number; enabled: number; channels: string[]; recipients: string[] }> }>('/alerts/rules'), []);
  const history = useAsync(() => api.get<{ events: Array<{ event: { id: string; detected_at: string; observed_value: number; severity: string; acknowledged_at: string | null }; ruleName: string; deliveries: Array<{ channel: string; recipient: string; outcome: string }> }> }>('/alerts/history'), []);
  const latency = useAsync(() => api.get<{ median: number; p95: number; samples: number }>('/alerts/latency'), []);

  async function toggle(id: string, enabled: boolean): Promise<void> {
    await api.post(`/alerts/rules/${id}/toggle`, { enabled });
    rules.reload();
  }

  return (
    <div className="view-enter">
      <PageHead title="Alert Center" subtitle={locale === 'id' ? 'Email, WhatsApp, Telegram, SMS, Microsoft Teams, Slack' : 'Email, WhatsApp, Telegram, SMS, Microsoft Teams, Slack'} />
      <ViewState state={rules}>
        {(data) => (
          <div className="grid g-12">
            {latency.data && latency.data.samples > 0 && (
              <Panel span="full" title={locale === 'id' ? 'Waktu Deteksi ke Notifikasi' : 'Detection-to-Notification Time'} subtitle={locale === 'id' ? 'Target < 5 menit' : 'Target < 5 minutes'}>
                <div className="stat-grid">
                  <StatTile label="Median" value={`${formatDecimal(latency.data.median / 1000, locale, 1)} s`} />
                  <StatTile label="P95" value={`${formatDecimal(latency.data.p95 / 1000, locale, 1)} s`} />
                  <StatTile label={locale === 'id' ? 'Sampel' : 'Samples'} value={formatNumber(latency.data.samples, locale)} />
                </div>
              </Panel>
            )}

            <Panel title={locale === 'id' ? 'Aturan Notifikasi' : 'Alert Rules'} span="wide">
              {data.rules.length === 0 ? <EmptyState messageKey="empty.no_alert" /> : data.rules.map((rule) => (
                <div className="feed-item" key={rule.id} style={{ alignItems: 'center' }}>
                  <div style={{ flex: 1 }}>
                    <b>{rule.name}</b>
                    <div className="feed-time mono">
                      {t('table.threshold')} {rule.comparator === 'gte' ? '≥' : rule.comparator === 'lte' ? '≤' : rule.comparator === 'gt' ? '>' : '<'} {formatDecimal(rule.threshold, locale, 2)} · {rule.channels.join(', ')}
                    </div>
                  </div>
                  {can('alert:write') && <Toggle on={rule.enabled === 1} onChange={(next) => void toggle(rule.id, next)} label={rule.name} />}
                </div>
              ))}
            </Panel>

            <Panel title={locale === 'id' ? 'Riwayat Notifikasi' : 'Notification History'} span="small">
              {!history.data || history.data.events.length === 0 ? <EmptyState messageKey="empty.no_data" /> : history.data.events.slice(0, 12).map((entry) => (
                <div className="feed-item" key={entry.event.id}>
                  <span className="feed-dot" style={{ background: entry.event.severity === 'critical' ? 'var(--bad)' : 'var(--warn)' }} />
                  <div>
                    <div><b>{entry.ruleName}</b> · <span className="mono">{formatDecimal(entry.event.observed_value, locale, 2)}</span></div>
                    <div className="feed-time">
                      {formatDateTime(entry.event.detected_at, locale)} · {entry.deliveries.length} {locale === 'id' ? 'pengiriman' : 'deliveries'}
                      {entry.event.acknowledged_at && ` · ${t('action.acknowledge')}`}
                    </div>
                  </div>
                </div>
              ))}
            </Panel>
          </div>
        )}
      </ViewState>
    </div>
  );
}

/* ================= Digital Twin — PRD 6.17 ================= */

export function DigitalTwinView(): JSX.Element {
  const { t, locale } = useApp();
  const plan = useAsync(() => api.get<{ zones: Array<{ zone: { id: string; name: string } | null; assets: Array<{ id: string; code: string; name: string; category: string; status: string; health_score: number }> }> }>('/twin/floor-plan'), []);
  const queue = useAsync(() => api.get<{ queue: Array<{ asset: { id: string; name: string; code: string }; priority: number; prediction: { windowStart: string; windowEnd: string; confidence: number; lowConfidence: boolean } | null; reasonKeys: string[] }> }>('/twin/maintenance-queue'), []);
  const [selected, setSelected] = useState<string | null>(null);

  const detail = useAsync(
    () =>
      selected
        ? api.get<{
            asset: { id: string; name: string; code: string; status: string; health_score: number };
            readings: Array<{ sensorCode: string; label: string; unit: string; value: number; status: string; observedAt: string }>;
            prediction: { windowStart: string; windowEnd: string; confidence: number; lowConfidence: boolean } | null;
          }>(`/twin/assets/${selected}`)
        : Promise.resolve(null),
    [selected],
  );

  return (
    <div className="view-enter">
      <PageHead title="Digital Twin" subtitle={locale === 'id' ? 'Denah aset, skor kesehatan, dan prediksi berkeyakinan eksplisit' : 'Asset floor plan, health scores, and predictions with explicit confidence'} />
      <ViewState state={plan}>
        {(data) => (
          <div className="grid g-12">
            {data.zones.length === 0 ? (
              <Panel span="full"><EmptyState messageKey="empty.no_asset" /></Panel>
            ) : (
              data.zones.map((group, index) => (
                <Panel key={group.zone?.id ?? `unzoned-${index}`} title={group.zone?.name ?? (locale === 'id' ? 'Tanpa Zona' : 'Unzoned')} span="wide">
                  <div className="zone-map">
                    {group.assets.map((asset) => (
                      <div key={asset.id} className="asset-tile" role="button" tabIndex={0} onClick={() => setSelected(asset.id)} onKeyDown={(e) => e.key === 'Enter' && setSelected(asset.id)}>
                        <div className="code">{asset.code}</div>
                        <div className="nm">{asset.name}</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <ThresholdRing score={asset.health_score} status={asset.status} size={40} />
                          <StatusTag status={asset.status} />
                        </div>
                      </div>
                    ))}
                  </div>
                </Panel>
              ))
            )}

            <Panel title={locale === 'id' ? 'Antrean Pemeliharaan' : 'Maintenance Queue'} span="small">
              {!queue.data || queue.data.queue.length === 0 ? <EmptyState messageKey="empty.no_data" /> : queue.data.queue.slice(0, 8).map((entry) => (
                <div className="feed-item" key={entry.asset.id}>
                  <div>
                    <b>{entry.asset.name}</b>
                    <div className="feed-time">
                      {entry.reasonKeys.map((key) => t(key)).join(' · ')}
                      {/* Keyakinan rendah DITANDAI JELAS (PRD 6.17). */}
                      {entry.prediction?.lowConfidence && (
                        <> · <span style={{ color: 'var(--on-warn-soft)' }}>{t('ui.confidence_low')}</span></>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </Panel>

            {detail.data && (
              <Panel title={detail.data.asset.name} subtitle={detail.data.asset.code} span="full">
                <div className="stat-grid" style={{ marginBottom: 14 }}>
                  <StatTile label={t('twin.health_score')} value={formatDecimal(detail.data.asset.health_score, locale, 1)} />
                  {detail.data.prediction && (
                    <>
                      <StatTile label={t('twin.prediction_window')} value={`${formatDate(detail.data.prediction.windowStart, locale)} – ${formatDate(detail.data.prediction.windowEnd, locale)}`} />
                      <StatTile label={t('twin.confidence')} value={formatDecimal(detail.data.prediction.confidence * 100, locale, 0) + '%'} />
                    </>
                  )}
                </div>
                {detail.data.prediction?.lowConfidence && <div className="note warn">{t('twin.low_confidence_warning')}</div>}
                <div className="table-scroll">
                  <table className="stack-mobile">
                    <thead><tr><th>{locale === 'id' ? 'Sensor' : 'Sensor'}</th><th>{t('table.value')}</th><th>{t('table.unit')}</th><th>{t('table.status')}</th><th>{t('ui.updated_at')}</th></tr></thead>
                    <tbody>
                      {detail.data.readings.map((reading) => (
                        <tr key={reading.sensorCode}>
                          <td data-label="Sensor">{reading.label}</td>
                          <td className="num" data-label={t('table.value')}>{formatDecimal(reading.value, locale, 2)}</td>
                          <td data-label={t('table.unit')}>{reading.unit}</td>
                          <td data-label={t('table.status')}><StatusTag status={reading.status === 'warning' ? 'at_risk' : reading.status === 'critical' ? 'critical' : 'on_track'} /></td>
                          <td data-label={t('ui.updated_at')}>{formatDateTime(reading.observedAt, locale)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="note info" style={{ marginTop: 12 }}>{t('twin.simulation_is_projection_only')}</div>
              </Panel>
            )}
          </div>
        )}
      </ViewState>
    </div>
  );
}

/* ================= Master Pegawai — PRD 6.18 ================= */

export function EmployeeView(): JSX.Element {
  const { t, locale } = useApp();
  const state = useAsync(() => api.get<{ employees: Array<{ id: string; full_name: string; nik: string; division: string; position: string; email: string; status: string; linked_accounts: number; unlinked: boolean }> }>('/employees'), []);

  return (
    <div className="view-enter">
      <PageHead title="Master Pegawai" subtitle={locale === 'id' ? 'Data induk pegawai; NIK dimaskirkan pada tampilan non-esensial' : 'Employee master data; employee IDs masked in non-essential views'} />
      <ViewState state={state}>
        {(data) => (
          <div className="grid g-12">
            <Panel span="full">
              {data.employees.length === 0 ? <EmptyState messageKey="empty.no_data" /> : (
                <div className="table-scroll">
                  <table className="stack-mobile">
                    <thead>
                      <tr><th>{t('table.name')}</th><th>{t('table.nik')}</th><th>{t('table.division')}</th><th>{t('table.position')}</th><th>{t('table.email')}</th><th>{t('table.status')}</th><th>{locale === 'id' ? 'Akun' : 'Accounts'}</th></tr>
                    </thead>
                    <tbody>
                      {data.employees.map((employee) => (
                        <tr key={employee.id}>
                          <td data-label={t('table.name')}>{employee.full_name}</td>
                          <td className="mono" data-label={t('table.nik')}>{employee.nik}</td>
                          <td data-label={t('table.division')}>{employee.division}</td>
                          <td data-label={t('table.position')}>{employee.position}</td>
                          <td className="mono" data-label={t('table.email')}>{employee.email}</td>
                          <td data-label={t('table.status')}><StatusTag status={employee.status} /></td>
                          <td data-label="Accounts">
                            {/* Pegawai tanpa akun ditandai agar mudah ditindaklanjuti (PRD 6.18). */}
                            {employee.unlinked ? <StatusTag status="at_risk" label={locale === 'id' ? 'Belum terhubung' : 'Not linked'} /> : formatNumber(employee.linked_accounts, locale)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </div>
        )}
      </ViewState>
    </div>
  );
}

/* ================= Otorisasi User — PRD 6.19 ================= */

export function AuthorizationView(): JSX.Element {
  const { t, locale } = useApp();
  const users = useAsync(() => api.get<{ users: Array<{ id: string; email: string; status: string; mfa_enrolled: number; last_login_at: string | null; employee_name: string; division: string; roles: string[]; rls: Array<{ dimension: string; operator: string; values: string[] }> }> }>('/authorization/users'), []);
  const roles = useAsync(() => api.get<{ roles: Array<{ id: string; code: string; name_id: string; name_en: string; is_standard: number }> }>('/authorization/roles'), []);

  return (
    <div className="view-enter">
      <PageHead title="Otorisasi User" subtitle={locale === 'id' ? '13 peran standar, Row-Level Security, dan deny overrides allow' : '13 standard roles, Row-Level Security, and deny-overrides-allow'} />
      <ViewState state={users}>
        {(data) => (
          <div className="grid g-12">
            <Panel title={locale === 'id' ? 'Pengguna' : 'Users'} span="wide">
              <div className="table-scroll">
                <table className="stack-mobile">
                  <thead><tr><th>{t('table.name')}</th><th>{t('table.roles')}</th><th>RLS</th><th>MFA</th><th>{t('table.last_login')}</th><th>{t('table.status')}</th></tr></thead>
                  <tbody>
                    {data.users.map((user) => (
                      <tr key={user.id}>
                        <td data-label={t('table.name')}>
                          {user.employee_name}
                          <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-400)' }}>{user.email}</div>
                        </td>
                        <td data-label={t('table.roles')}>
                          <div className="pill-row">{user.roles.map((role) => <StatusTag key={role} status="info" label={role} />)}</div>
                        </td>
                        <td data-label="RLS">
                          {user.rls.length === 0 ? '—' : user.rls.map((rule, i) => (
                            <div key={i} className="mono" style={{ fontSize: 10.5 }}>{rule.dimension} {rule.operator} {rule.values.join(', ')}</div>
                          ))}
                        </td>
                        <td data-label="MFA"><StatusTag status={user.mfa_enrolled ? 'active' : 'at_risk'} label={user.mfa_enrolled ? 'ON' : 'OFF'} /></td>
                        <td data-label={t('table.last_login')}>{user.last_login_at ? formatDateTime(user.last_login_at, locale) : '—'}</td>
                        <td data-label={t('table.status')}><StatusTag status={user.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel title={locale === 'id' ? 'Peran Standar' : 'Standard Roles'} span="small">
              {(roles.data?.roles ?? []).map((role) => (
                <div className="feed-item" key={role.id}>
                  <div>
                    <b>{locale === 'en' ? role.name_en : role.name_id}</b>
                    <div className="feed-time mono">{role.code}</div>
                  </div>
                </div>
              ))}
            </Panel>
          </div>
        )}
      </ViewState>
    </div>
  );
}

/* ================= Log Aktivitas — PRD 6.20 ================= */

export function AuditLogView(): JSX.Element {
  const { t, locale, can } = useApp();
  const [filter, setFilter] = useState({ module: '', severity: '', outcome: '' });
  const query = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
  const state = useAsync(() => api.get<{ rows: AuditRow[]; total: number }>(`/audit?limit=100&${query}`), [query]);
  const summary = useAsync(() => api.get<{ total: number; denied: number; critical: number; byModule: Array<{ module: string; n: number }> }>('/audit/summary'), []);

  return (
    <div className="view-enter">
      <PageHead
        title="Log Aktivitas"
        subtitle={locale === 'id' ? 'Immutable — tidak dapat diedit atau dihapus oleh peran mana pun' : 'Immutable — cannot be edited or deleted by any role'}
        actions={can('audit:export') && <a className="btn" href="/api/v1/audit/export" download>{t('action.export')}</a>}
      />
      <div className="grid g-12">
        {summary.data && (
          <Panel span="full">
            <div className="stat-grid">
              <StatTile label={t('table.total')} value={formatNumber(summary.data.total, locale)} />
              <StatTile label={locale === 'id' ? 'Akses Ditolak' : 'Access Denied'} value={formatNumber(summary.data.denied, locale)} />
              <StatTile label={t('status.critical')} value={formatNumber(summary.data.critical, locale)} />
            </div>
          </Panel>
        )}

        <Panel span="full" actions={
          <div className="head-actions">
            <select value={filter.severity} onChange={(e) => setFilter({ ...filter, severity: e.target.value })} style={{ padding: '7px 9px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-900)' }}>
              <option value="">{t('table.severity')}</option>
              {['info', 'notice', 'warning', 'critical'].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={filter.outcome} onChange={(e) => setFilter({ ...filter, outcome: e.target.value })} style={{ padding: '7px 9px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-900)' }}>
              <option value="">{t('table.outcome')}</option>
              {['success', 'denied', 'failure'].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        }>
          <ViewState state={state}>
            {(data) =>
              data.rows.length === 0 ? <EmptyState messageKey="empty.no_log" /> : (
                <div className="table-scroll">
                  <table className="stack-mobile">
                    <thead><tr><th>{t('table.timestamp')}</th><th>{t('table.actor')}</th><th>{t('table.action')}</th><th>{t('table.module')}</th><th>{t('table.object')}</th><th>{t('table.severity')}</th><th>{t('table.outcome')}</th></tr></thead>
                    <tbody>
                      {data.rows.map((row) => (
                        <tr key={row.id}>
                          {/* DESIGN.md 8.3: Log Aktivitas SELALU format ISO 8601 tidak ambigu. */}
                          <td className="mono" data-label={t('table.timestamp')} style={{ whiteSpace: 'nowrap' }}>{formatAuditTimestamp(row.occurred_at)}</td>
                          <td data-label={t('table.actor')}>{row.actor_label}</td>
                          <td className="mono" data-label={t('table.action')}>{row.action}</td>
                          <td data-label={t('table.module')}>{row.module}</td>
                          <td data-label={t('table.object')}>{row.object_label ?? '—'}</td>
                          <td data-label={t('table.severity')}><StatusTag status={row.severity === 'critical' ? 'critical' : row.severity === 'warning' ? 'at_risk' : 'info'} label={row.severity} /></td>
                          <td data-label={t('table.outcome')}><StatusTag status={row.outcome === 'denied' ? 'critical' : row.outcome === 'failure' ? 'at_risk' : 'on_track'} label={row.outcome} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          </ViewState>
        </Panel>
      </div>
    </div>
  );
}

/* ================= Perangkat & Sesi — PRD 6.30 ================= */

/**
 * Verifikasi dua langkah (SECURITY.md Bagian 4).
 *
 * Ditempatkan di modul Perangkat & Sesi karena di situlah pengguna mengelola cara
 * akunnya diakses. Panel ini WAJIB dapat dipakai justru ketika peran pengguna sudah
 * memblokir segalanya karena MFA belum aktif — karena itu ia tidak bergantung pada izin
 * apa pun, dan `PageHead` di sekelilingnya tetap tampil meski panel lain gagal memuat.
 */
/**
 * Penggantian kata sandi mandiri.
 *
 * Sebelum panel ini ada, kata sandi tidak dapat diganti dari mana pun: `changePassword()`
 * ada di AuthService tetapi tidak terjangkau rute mana pun. Akibatnya kata sandi yang
 * ditetapkan saat akun dibuat berlaku selamanya — termasuk kata sandi demo yang tertulis
 * di dokumentasi publik.
 *
 * Kata sandi lama diminta karena server memang mewajibkannya: sesi yang dicuri tidak
 * boleh dapat merebut akun secara permanen.
 */
export function PasswordPanel(): JSX.Element {
  const { t } = useApp();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mismatch = confirm.length > 0 && next !== confirm;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setErrorKey(null);
    setDone(false);
    try {
      await api.post('/me/password', { currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
    } catch (error) {
      setErrorKey(error instanceof ApiError ? error.key : 'error.internal');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title={t('ui.password_title')} span="half">
      <form onSubmit={(event) => void submit(event)} style={{ display: 'grid', gap: 10 }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-600)' }}>{t('ui.password_policy')}</div>
        <Field label={t('ui.password_current')}>
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </Field>
        <Field label={t('ui.password_new')}>
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
        </Field>
        <Field label={t('ui.password_confirm')}>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </Field>

        {/* Ketidakcocokan ditangkap di sini supaya pengguna tidak menghabiskan jatah
            batas laju hanya karena salah ketik pada kolom konfirmasi. */}
        {mismatch && <div className="note warn">{t('error.password_confirm_mismatch')}</div>}
        {errorKey && <div className="note warn">{t(errorKey)}</div>}
        {done && <div className="note">{t('ui.password_changed')}</div>}

        <button type="submit" className="btn primary" disabled={busy || mismatch || next.length === 0}>
          {busy ? t('ui.loading') : t('action.password_change')}
        </button>
      </form>
    </Panel>
  );
}

/**
 * Diekspor agar dapat diuji sendiri.
 *
 * `DeviceView` yang memuatnya memanggil tiga endpoint lain saat dipasang, sehingga
 * menguji pendaftaran MFA lewat induknya berarti menyiapkan tiruan untuk hal yang tidak
 * sedang diuji — dan kegagalan salah satunya akan tampak seperti kegagalan MFA.
 */
export function MfaPanel(): JSX.Element {
  const { t, locale, refreshSession } = useApp();
  const status = useAsync(() => api.get<MfaStatus>('/mfa/status'), []);
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setErrorKey(null);
    try {
      await action();
    } catch (error) {
      setErrorKey(error instanceof ApiError ? error.key : 'error.internal');
    } finally {
      setBusy(false);
    }
  }

  const begin = (): Promise<void> =>
    run(async () => {
      setSetup(await api.post<{ secret: string; otpauthUri: string }>('/mfa/enroll', {}));
    });

  const activate = (): Promise<void> =>
    run(async () => {
      const result = await api.post<{ activated: boolean; recoveryCodes: string[] }>('/mfa/activate', { code });
      setCodes(result.recoveryCodes);
      setSetup(null);
      setCode('');
      status.reload();
      // Sesi memuat `mfaEnrolled`; tanpa memuat ulang, antarmuka tetap menganggap
      // pengguna terkunci walaupun MFA-nya baru saja aktif.
      await refreshSession();
    });

  return (
    <Panel title={t('ui.mfa_title')} span="half">
      <ViewState state={status}>
        {(data) => (
          <div style={{ display: 'grid', gap: 12 }}>
            <div className={data.enrolmentPending ? 'note warn' : 'note'}>
              {data.enrolled
                ? t('ui.mfa_active')
                : data.enrolmentPending
                  ? t('error.mfa_enrolment_required')
                  : t('ui.mfa_optional')}
            </div>

            {data.enrolled && (
              <div style={{ fontSize: 12.5, color: 'var(--text-600)' }}>
                {t('ui.mfa_recovery_left')}: <strong>{data.remainingRecoveryCodes}</strong>
              </div>
            )}

            {/* Kode pemulihan tampil SEKALI. Setelah ini hanya hash-nya tersimpan. */}
            {codes && (
              <div className="note warn">
                <div style={{ marginBottom: 8 }}>{t('ui.mfa_recovery_once')}</div>
                <div className="mono" style={{ display: 'grid', gap: 2 }}>
                  {codes.map((c) => (
                    <span key={c}>{c}</span>
                  ))}
                </div>
              </div>
            )}

            {!data.enrolled && !setup && (
              <button type="button" className="btn primary" disabled={busy} onClick={() => void begin()}>
                {busy ? t('ui.loading') : t('action.mfa_enroll')}
              </button>
            )}

            {setup && (
              <div style={{ display: 'grid', gap: 10 }}>
                <div style={{ fontSize: 12.5, color: 'var(--text-600)' }}>{t('ui.mfa_scan_hint')}</div>
                {/* Rahasia ditampilkan sebagai teks, bukan gambar QR: merender QR menuntut
                    pustaka tambahan, dan seluruh aplikasi autentikator menerima entri
                    manual. URI otpauth disertakan untuk yang ingin menempelkannya. */}
                <div className="mono" style={{ wordBreak: 'break-all', fontSize: 13 }}>{setup.secret}</div>
                <details>
                  <summary style={{ fontSize: 12.5, cursor: 'pointer' }}>{t('ui.mfa_uri')}</summary>
                  <div className="mono" style={{ wordBreak: 'break-all', fontSize: 11.5, marginTop: 6 }}>
                    {setup.otpauthUri}
                  </div>
                </details>
                <Field label={t('ui.mfa_code')} hint={t('ui.mfa_code_hint')}>
                  <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" />
                </Field>
                <button type="button" className="btn primary" disabled={busy || code.length === 0} onClick={() => void activate()}>
                  {busy ? t('ui.loading') : t('action.mfa_activate')}
                </button>
              </div>
            )}

            {data.enrolled && (
              <div style={{ display: 'grid', gap: 8 }}>
                <Field label={t('ui.mfa_code')} hint={t('ui.mfa_code_hint')}>
                  <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" />
                </Field>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || code.length === 0}
                  onClick={() =>
                    void run(async () => {
                      const result = await api.post<{ recoveryCodes: string[] }>('/mfa/recovery-codes', { code });
                      setCodes(result.recoveryCodes);
                      setCode('');
                      status.reload();
                    })
                  }
                >
                  {t('action.mfa_new_recovery_codes')}
                </button>
                {/* Tombol matikan hanya muncul bila peran TIDAK mewajibkannya — menampilkan
                    tombol yang pasti ditolak server hanya membingungkan. */}
                {!data.requiredByRole && (
                  <button
                    type="button"
                    className="btn danger"
                    disabled={busy || code.length === 0}
                    onClick={() =>
                      void run(async () => {
                        await api.post('/mfa/disable', { code });
                        setCode('');
                        setCodes(null);
                        status.reload();
                        await refreshSession();
                      })
                    }
                  >
                    {t('action.mfa_disable')}
                  </button>
                )}
              </div>
            )}

            {errorKey && <div className="note warn">{t(errorKey)}</div>}
            <div style={{ fontSize: 11.5, color: 'var(--text-600)' }}>
              {locale === 'id'
                ? 'Kode berlaku 30 detik dan tidak dapat dipakai dua kali.'
                : 'Codes last 30 seconds and cannot be reused.'}
            </div>
          </div>
        )}
      </ViewState>
    </Panel>
  );
}

export function DeviceView(): JSX.Element {
  const { t, locale, can } = useApp();
  const mine = useAsync(() => api.get<{ devices: Array<{ id: string; label: string | null; first_seen: string; last_seen: string; status: string; current: boolean }> }>('/devices/mine'), []);
  const all = useAsync(() => (can('device:read') ? api.get<{ devices: Array<{ id: string; user_email: string; label: string | null; status: string; last_seen: string; last_ip: string | null }> }>('/devices') : Promise.resolve(null)), []);
  const sessions = useAsync(() => (can('device:read') ? api.get<{ sessions: Array<{ id: string; user_email: string; issued_at: string; last_seen_at: string; ip: string | null; geo_label: string | null }> }>('/sessions') : Promise.resolve(null)), []);

  return (
    <div className="view-enter">
      <PageHead title="Perangkat & Sesi" subtitle={locale === 'id' ? 'Satu akun terikat perangkat terdaftar; satu sesi aktif per akun' : 'Accounts bound to registered devices; one active session per account'} />
      <div className="grid g-12">
        <MfaPanel />
        <PasswordPanel />
        {/* Transparansi WAJIB — data perangkat termasuk data pribadi (SECURITY.md 17.3). */}
        <Panel title={t('ui.my_devices')} span="half">
          <ViewState state={mine}>
            {(data) =>
              data.devices.length === 0 ? <EmptyState messageKey="empty.no_data" /> : (
                <div className="table-scroll">
                  <table className="stack-mobile">
                    <thead><tr><th>{t('table.device')}</th><th>{t('table.last_seen')}</th><th>{t('table.status')}</th></tr></thead>
                    <tbody>
                      {data.devices.map((device) => (
                        <tr key={device.id}>
                          <td data-label={t('table.device')}>
                            {device.label ?? device.id}
                            {device.current && <> · <StatusTag status="active" label={t('ui.current_device')} /></>}
                          </td>
                          <td data-label={t('table.last_seen')}>{formatDateTime(device.last_seen, locale)}</td>
                          <td data-label={t('table.status')}><StatusTag status={device.status === 'active' ? 'active' : 'inactive'} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          </ViewState>
        </Panel>

        {sessions.data && (
          <Panel title={locale === 'id' ? 'Sesi Aktif' : 'Active Sessions'} span="half">
            <div className="table-scroll">
              <table className="stack-mobile">
                <thead><tr><th>{t('table.actor')}</th><th>{t('table.ip')}</th><th>{t('table.last_seen')}</th></tr></thead>
                <tbody>
                  {sessions.data.sessions.map((session) => (
                    <tr key={session.id}>
                      <td data-label={t('table.actor')}>{session.user_email}</td>
                      <td className="mono" data-label={t('table.ip')}>{session.ip ?? '—'}</td>
                      <td data-label={t('table.last_seen')}>{formatDateTime(session.last_seen_at, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}

        {all.data && (
          <Panel title={locale === 'id' ? 'Semua Perangkat Terikat' : 'All Bound Devices'} span="full">
            <div className="table-scroll">
              <table className="stack-mobile">
                <thead><tr><th>{t('table.actor')}</th><th>{t('table.device')}</th><th>{t('table.ip')}</th><th>{t('table.last_seen')}</th><th>{t('table.status')}</th></tr></thead>
                <tbody>
                  {all.data.devices.map((device) => (
                    <tr key={device.id}>
                      <td data-label={t('table.actor')}>{device.user_email}</td>
                      <td data-label={t('table.device')}>{device.label ?? '—'}</td>
                      <td className="mono" data-label={t('table.ip')}>{device.last_ip ?? '—'}</td>
                      <td data-label={t('table.last_seen')}>{formatDateTime(device.last_seen, locale)}</td>
                      <td data-label={t('table.status')}><StatusTag status={device.status === 'active' ? 'active' : 'inactive'} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}

/* ================= Manajemen Tenant — PRD 6.26 ================= */

interface PendingRegistration {
  id: string;
  name: string;
  slug: string;
  plan_code: string;
  billing_cycle: string;
  admin_email: string;
  admin_name: string;
  approval_requested_at: string | null;
}

/**
 * Antrean pendaftaran mandiri yang menunggu keputusan.
 *
 * Hanya tampil bagi peran yang berwenang membuat tenant. Bagi peran lain, memanggil
 * rutenya akan ditolak server — jadi panelnya disembunyikan alih-alih menampilkan
 * kegagalan yang tidak dapat ditindaklanjuti siapa pun.
 */
function PendingRegistrationsPanel(): JSX.Element | null {
  const { t, locale, session } = useApp();
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const boleh = session?.permissions.includes('tenant:provision') ?? false;
  const state = useAsync(
    () => (boleh ? api.get<{ registrations: PendingRegistration[] }>('/tenants/pending') : Promise.resolve({ registrations: [] })),
    [nonce, boleh],
  );

  if (!boleh) return null;

  async function decide(id: string, decision: 'approved' | 'rejected'): Promise<void> {
    setBusy(id);
    setErrorKey(null);
    try {
      await api.post(`/tenants/${id}/approval`, { decision, note: notes[id] ?? '' });
      setNonce((n) => n + 1);
    } catch (error) {
      setErrorKey(error instanceof ApiError ? error.key : 'error.internal');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel title={t('ui.pending_registrations')} span="full">
      {errorKey && <div className="note warn" style={{ marginBottom: 12 }}>{t(errorKey)}</div>}
      {!state.data || state.data.registrations.length === 0 ? (
        <div className="note">{t('ui.pending_none')}</div>
      ) : (
        <div className="table-scroll">
          <table className="stack-mobile">
            <thead>
              <tr>
                <th>{t('table.name')}</th>
                <th>Slug</th>
                <th>{t('ui.plan_label')}</th>
                <th>{locale === 'id' ? 'Calon admin' : 'Prospective admin'}</th>
                <th>{t('ui.approval_note')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {state.data.registrations.map((r) => (
                <tr key={r.id}>
                  <td data-label={t('table.name')}>
                    {r.name}
                    <div className="feed-time">{r.approval_requested_at ? formatDate(r.approval_requested_at, locale) : '—'}</div>
                  </td>
                  <td className="mono" data-label="Slug">{r.slug}</td>
                  <td data-label={t('ui.plan_label')}>
                    {r.plan_code}
                    <div className="feed-time">{t(`ui.cycle_${r.billing_cycle}`)}</div>
                  </td>
                  <td data-label="Admin">
                    {r.admin_name}
                    <div className="feed-time">{r.admin_email}</div>
                  </td>
                  <td data-label={t('ui.approval_note')}>
                    <input
                      value={notes[r.id] ?? ''}
                      placeholder={t('ui.approval_reject_hint')}
                      onChange={(e) => setNotes((prev) => ({ ...prev, [r.id]: e.target.value }))}
                    />
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button type="button" className="btn primary" disabled={busy === r.id} onClick={() => void decide(r.id, 'approved')}>
                        {t('action.approve')}
                      </button>
                      <button type="button" className="btn" disabled={busy === r.id} onClick={() => void decide(r.id, 'rejected')}>
                        {t('action.reject')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/** Faktur yang menunggu pembayaran, lintas tenant. */
interface UnpaidInvoice {
  id: string;
  number: string;
  tenant_name: string;
  tenant_slug: string;
  plan_code: string;
  billing_cycle: string;
  total: number;
  due_at: string;
  period_end: string;
  first_payment: number;
}

/**
 * Antrean pembayaran operator platform.
 *
 * Ada karena wewenang menyatakan sebuah faktur lunas sengaja DIPINDAHKAN dari pelanggan ke
 * sisi platform: pihak yang berutang tidak boleh menjadi pihak yang menyatakan utangnya
 * lunas. Tanpa panel ini, pemindahan itu berarti pembayaran hanya dapat dicatat lewat
 * panggilan API manual — dan pelanggan yang sudah transfer tetap terkunci.
 *
 * Disembunyikan bagi yang tidak memegang `billing:settle`, sehingga tidak ada tombol yang
 * mengarah ke penolakan.
 */
function UnpaidInvoicesPanel(): JSX.Element | null {
  const { t, locale, session } = useApp();
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const boleh = session?.permissions.includes('billing:settle') ?? false;
  const state = useAsync(
    () =>
      boleh
        ? api.get<{ invoices: UnpaidInvoice[] }>('/system/invoices/unpaid')
        : Promise.resolve({ invoices: [] }),
    [nonce, boleh],
  );

  if (!boleh) return null;

  async function record(id: string): Promise<void> {
    setBusy(id);
    setErrorKey(null);
    try {
      await api.post(`/system/invoices/${id}/payment`, {
        reference: refs[id] ?? '',
        methodLabel: locale === 'id' ? 'Transfer bank' : 'Bank transfer',
      });
      setNonce((n) => n + 1);
    } catch (error) {
      setErrorKey(error instanceof ApiError ? error.key : 'error.internal');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel title={t('ui.unpaid_invoices')} span="full">
      {errorKey && <div className="note warn" style={{ marginBottom: 12 }}>{t(errorKey)}</div>}
      {!state.data || state.data.invoices.length === 0 ? (
        <div className="note">{t('ui.unpaid_invoices_none')}</div>
      ) : (
        <div className="table-scroll">
          <table className="stack-mobile">
            <thead>
              <tr>
                <th>{t('ui.invoice_number')}</th>
                <th>{t('table.name')}</th>
                <th>{t('ui.plan_label')}</th>
                <th>{t('ui.invoice_total')}</th>
                <th>{t('ui.payment_reference')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {state.data.invoices.map((inv) => (
                <tr key={inv.id}>
                  <td className="mono" data-label={t('ui.invoice_number')}>
                    {inv.number}
                    <div className="feed-time">{formatDate(inv.due_at, locale)}</div>
                  </td>
                  <td data-label={t('table.name')}>
                    {inv.tenant_name}
                    <div className="feed-time">{inv.tenant_slug}</div>
                  </td>
                  <td data-label={t('ui.plan_label')}>
                    {inv.plan_code}
                    <div className="feed-time">
                      {t(`ui.cycle_${inv.billing_cycle}`)}
                      {/* Pembayaran pertama ditandai: menyetujui pendaftaran tidak sama
                          dengan mengaktifkan ruang kerjanya. */}
                      {inv.first_payment ? ` · ${t('ui.first_payment')}` : ''}
                    </div>
                  </td>
                  <td data-label={t('ui.invoice_total')}>{formatCurrency(inv.total, locale)}</td>
                  <td data-label={t('ui.payment_reference')}>
                    <input
                      value={refs[inv.id] ?? ''}
                      placeholder={t('ui.payment_reference_hint')}
                      onChange={(e) => setRefs((prev) => ({ ...prev, [inv.id]: e.target.value }))}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={busy === inv.id || !(refs[inv.id] ?? '').trim()}
                      onClick={() => void record(inv.id)}
                    >
                      {t('action.record_payment')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export function TenantView(): JSX.Element {
  const { t, locale, session } = useApp();
  const state = useAsync(() => api.get<{ tenants: Array<{ id: string; name: string; slug: string; status: string; isolation_level: string; created_at: string }> }>('/tenants'), []);
  const operatorTrail = useAsync(() => api.get<{ trail: AuditRow[] }>('/tenant/operator-access'), []);

  return (
    <div className="view-enter">
      <PageHead title="Manajemen Tenant" subtitle={locale === 'id' ? 'Isolasi data penuh antar-tenant' : 'Full data isolation between tenants'} />
      <ViewState state={state}>
        {(data) => (
          <div className="grid g-12">
            <PendingRegistrationsPanel />
            <UnpaidInvoicesPanel />

            <Panel span="wide">
              <div className="table-scroll">
                <table className="stack-mobile">
                  <thead><tr><th>{t('table.name')}</th><th>Slug</th><th>{locale === 'id' ? 'Isolasi' : 'Isolation'}</th><th>{t('table.status')}</th><th>{t('table.created_at')}</th></tr></thead>
                  <tbody>
                    {data.tenants.map((tenant) => (
                      <tr key={tenant.id}>
                        <td data-label={t('table.name')}>{tenant.name}</td>
                        <td className="mono" data-label="Slug">{tenant.slug}</td>
                        <td className="mono" data-label="Isolation">{tenant.isolation_level}</td>
                        <td data-label={t('table.status')}><StatusTag status={tenant.status} /></td>
                        <td data-label={t('table.created_at')}>{formatDate(tenant.created_at, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            {/* SECURITY.md 16.2 — transparansi akses vendor. */}
            <Panel title={locale === 'id' ? 'Jejak Akses Platform Operator' : 'Platform Operator Access Trail'} span="small">
              {!operatorTrail.data || operatorTrail.data.trail.length === 0 ? <EmptyState messageKey="empty.no_log" /> : operatorTrail.data.trail.slice(0, 10).map((row) => (
                <div className="feed-item" key={row.id}>
                  <div>
                    <b className="mono" style={{ fontSize: 11.5 }}>{row.action}</b>
                    <div className="feed-time">{formatAuditTimestamp(row.occurred_at)} · {row.actor_label}</div>
                  </div>
                </div>
              ))}
            </Panel>

            <div className="note">{session?.tenant.name} · {t('ui.plan_label')}: {session?.flags.plan}</div>
          </div>
        )}
      </ViewState>
    </div>
  );
}

/* ================= Langganan & Paket — PRD 6.27 ================= */

interface SubscriptionPayload {
  subscription: {
    plan_code: string;
    plan_name: string;
    billing_cycle: string;
    cycle_months: number;
    status: string;
    trial_ends_at: string | null;
    activated_at: string | null;
    current_period_end: string;
    pending_plan_code: string | null;
    expires_at: string;
    days_remaining: number;
    expired: boolean;
    price: number;
    quotas: Record<string, number>;
  };
  plans: Array<{ code: string; name: string; monthlyPrice: number; annualPrice: number; quotas: Record<string, number> }>;
  cycles: Array<{ code: string; months: number; discount: number; sortOrder: number }>;
}

export function SubscriptionView(): JSX.Element {
  const { t, locale, refreshSession } = useApp();
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [noticeKey, setNoticeKey] = useState<string | null>(null);
  const state = useAsync(() => api.get<SubscriptionPayload>('/subscription'), [nonce]);

  const [invoice, setInvoice] = useState<{
    number: string;
    total: number;
    period_end: string;
    pay_url: string | null;
    charge_error: string | null;
  } | null>(null);

  /**
   * Meminta faktur perpanjangan.
   *
   * Tombol ini TIDAK memperpanjang apa pun. Ia menerbitkan tagihan; masa berlaku maju hanya
   * setelah pembayarannya tercatat — oleh webhook payment gateway atau oleh operator yang
   * mencocokkannya dengan mutasi rekening. Sebelumnya tombol ini mengirim token pembayaran
   * karangan dan langsung memperpanjang, yang berarti siapa pun dapat memperpanjang
   * ruang kerjanya gratis.
   */
  async function requestRenewal(): Promise<void> {
    setBusy(true);
    setNoticeKey(null);
    try {
      const hasil = await api.post<{
        invoice: {
          number: string;
          total: number;
          period_end: string;
          pay_url: string | null;
          charge_error: string | null;
        };
      }>('/subscription/renew', {});
      setInvoice(hasil.invoice);
      setNonce((n) => n + 1);
      // Sesi memuat `flags.readOnly`. Ruang kerja BELUM terbuka di sini — memuat ulang
      // sesi tetap benar supaya angka masa berlakunya mutakhir bila ternyata sudah dibayar
      // lewat jalur lain.
      await refreshSession();
    } catch (error) {
      setNoticeKey(error instanceof ApiError ? error.key : 'error.internal');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="view-enter">
      <PageHead title="Langganan & Paket" subtitle={locale === 'id' ? 'Upgrade berlaku segera; downgrade pada awal siklus berikutnya' : 'Upgrades apply immediately; downgrades at the next billing cycle'} />
      <ViewState state={state}>
        {(data) => (
          <div className="grid g-12">
            <Panel title={locale === 'id' ? 'Paket Aktif' : 'Active Plan'} span="wide">
              <div className="stat-grid">
                <StatTile label={t('ui.plan_label')} value={data.subscription.plan_name} />
                <StatTile
                  label={locale === 'id' ? 'Jangka waktu' : 'Term'}
                  value={t(`ui.cycle_${data.subscription.billing_cycle}`)}
                />
                <StatTile
                  label={locale === 'id' ? 'Berlaku sampai' : 'Valid until'}
                  value={formatDate(data.subscription.expires_at, locale)}
                />
                <StatTile
                  label={locale === 'id' ? 'Sisa waktu' : 'Time left'}
                  value={
                    data.subscription.expired
                      ? t('ui.subscription_expired_days', { days: Math.abs(data.subscription.days_remaining) })
                      : t('ui.subscription_days_left', { days: data.subscription.days_remaining })
                  }
                />
              </div>

              {/* Keadaan yang paling perlu dijelaskan, dijelaskan paling jelas: apa yang
                  terjadi sekarang, dan apa yang membukanya kembali. */}
              {data.subscription.expired && !data.subscription.activated_at ? (
                <div className="note warn" style={{ marginTop: 12 }}>
                  <div>{t('error.subscription_unpaid')}</div>
                  <div style={{ marginTop: 6 }}>{t('ui.subscription_unpaid_hint')}</div>
                </div>
              ) : data.subscription.expired ? (
                <div className="note warn" style={{ marginTop: 12 }}>
                  <div>{t('error.subscription_expired')}</div>
                  <div style={{ marginTop: 6 }}>{t('ui.subscription_renew_hint')}</div>
                </div>
              ) : data.subscription.days_remaining <= 7 ? (
                <div className="note info" style={{ marginTop: 12 }}>
                  {t('ui.subscription_expiring_soon', { days: data.subscription.days_remaining })}
                </div>
              ) : null}

              {noticeKey && <div className="note warn" style={{ marginTop: 12 }}>{t(noticeKey)}</div>}

              {/* Faktur sudah terbit tetapi BELUM dibayar. Mengatakannya apa adanya lebih
                  baik daripada membiarkan pengguna menebak mengapa ruang kerjanya masih
                  terkunci setelah menekan tombol. */}
              {invoice && (
                <div className="note info" style={{ marginTop: 12 }} data-testid="renewal-invoice">
                  <div>
                    {t('ui.invoice_issued', {
                      number: invoice.number,
                      total: formatCurrency(invoice.total, locale),
                    })}
                  </div>

                  {/* Tautan bayar bila payment gateway dikonfigurasi. Halaman penyedia-lah
                      yang menampilkan QRIS, virtual account, dan e-wallet — sistem ini tidak
                      menggambar kode QR sendiri, dan tidak pernah menyentuh data kartu. */}
                  {invoice.pay_url ? (
                    <div style={{ marginTop: 10 }}>
                      <a
                        className="btn primary"
                        href={invoice.pay_url}
                        target="_blank"
                        rel="noreferrer noopener"
                        data-testid="pay-now"
                      >
                        {t('action.pay_now')}
                      </a>
                      <div style={{ marginTop: 6 }}>{t('ui.pay_now_hint')}</div>
                    </div>
                  ) : (
                    <div style={{ marginTop: 6 }}>
                      {/* Dibedakan: belum dikonfigurasi bukan hal yang sama dengan gagal
                          dihubungi, dan pelanggan berhak tahu yang mana. */}
                      {t(invoice.charge_error ? 'ui.pay_link_failed' : 'ui.invoice_awaiting_payment')}
                    </div>
                  )}
                </div>
              )}

              <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn primary" disabled={busy} onClick={() => void requestRenewal()}>
                  {busy
                    ? t('ui.loading')
                    : t(data.subscription.activated_at ? 'action.request_renewal_for' : 'action.request_activation_for', {
                        cycle: t(`ui.cycle_${data.subscription.billing_cycle}`),
                        price: formatCurrency(data.subscription.price, locale),
                      })}
                </button>
              </div>

              {data.subscription.pending_plan_code && (
                <div className="note info" style={{ marginTop: 12 }}>
                  {locale === 'id' ? 'Perubahan paket berlaku pada siklus berikutnya: ' : 'Plan change takes effect next cycle: '}
                  <b>{data.subscription.pending_plan_code}</b>
                </div>
              )}
            </Panel>

            <Panel title={locale === 'id' ? 'Paket Tersedia' : 'Available Plans'} span="full">
              <div className="table-scroll">
                <table className="stack-mobile">
                  <thead><tr><th>{t('ui.plan_label')}</th><th>{locale === 'id' ? 'Bulanan' : 'Monthly'}</th><th>{locale === 'id' ? 'Tahunan' : 'Annual'}</th><th>{locale === 'id' ? 'Pengguna' : 'Users'}</th><th>Dataset</th><th>{locale === 'id' ? 'Koneksi' : 'Connections'}</th></tr></thead>
                  <tbody>
                    {data.plans.map((plan) => (
                      <tr key={plan.code} style={{ fontWeight: plan.code === data.subscription.plan_code ? 600 : undefined }}>
                        <td data-label={t('ui.plan_label')}>{plan.name}</td>
                        <td className="num" data-label="Monthly">{plan.monthlyPrice === 0 ? '—' : formatCurrency(plan.monthlyPrice, locale)}</td>
                        <td className="num" data-label="Annual">{plan.annualPrice === 0 ? '—' : formatCurrency(plan.annualPrice, locale)}</td>
                        <td className="num" data-label="Users">{quotaLabel(plan.quotas.users, locale)}</td>
                        <td className="num" data-label="Datasets">{quotaLabel(plan.quotas.datasets, locale)}</td>
                        <td className="num" data-label="Connections">{quotaLabel(plan.quotas.connections, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>
        )}
      </ViewState>
    </div>
  );
}

/* ================= Billing & Faktur — PRD 6.28 ================= */

export function BillingView(): JSX.Element {
  const { t, locale } = useApp();
  const state = useAsync(() => api.get<{ invoices: Array<{ id: string; number: string; period_start: string; period_end: string; total: number; currency: string; status: string; due_at: string; paid_at: string | null; payment_method_label: string | null }> }>('/invoices'), []);

  return (
    <div className="view-enter">
      <PageHead title="Billing & Faktur" subtitle={locale === 'id' ? 'Data kartu tidak pernah disimpan sistem Vantik' : 'Card data is never stored by Vantik'} />
      <ViewState state={state}>
        {(data) => (
          <div className="grid g-12">
            <Panel span="full">
              {data.invoices.length === 0 ? <EmptyState messageKey="empty.no_data" /> : (
                <div className="table-scroll">
                  <table className="stack-mobile">
                    <thead><tr><th>{t('table.invoice_number')}</th><th>{t('table.period')}</th><th>{t('table.amount')}</th><th>{t('table.due_date')}</th><th>{t('table.status')}</th></tr></thead>
                    <tbody>
                      {data.invoices.map((invoice) => (
                        <tr key={invoice.id}>
                          <td className="mono" data-label={t('table.invoice_number')}>{invoice.number}</td>
                          <td data-label={t('table.period')}>{formatDate(invoice.period_start, locale)} – {formatDate(invoice.period_end, locale)}</td>
                          <td className="num" data-label={t('table.amount')}>{formatCurrency(invoice.total, locale, invoice.currency)}</td>
                          <td data-label={t('table.due_date')}>{formatDate(invoice.due_at, locale)}</td>
                          <td data-label={t('table.status')}><StatusTag status={invoice.status === 'paid' ? 'active' : invoice.status === 'failed' ? 'critical' : 'at_risk'} label={invoice.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </div>
        )}
      </ViewState>
    </div>
  );
}

/* ================= Usage & Kuota — PRD 6.29 ================= */

export function UsageView(): JSX.Element {
  const { t, locale } = useApp();
  const state = useAsync(() => api.get<{
    snapshot: Array<{ metric: string; used: number; quota: number; ratio: number; behaviour: string; unlimited: boolean; projectedExhaustionAt: string | null }>;
    ai: { calls: number; quota: number; bySource: Array<{ source: string; n: number }> };
    breaches: Array<{ metric: string; ratio: number; threshold: number }>;
  }>('/usage'), []);

  return (
    <div className="view-enter">
      <PageHead title="Usage & Kuota" subtitle={locale === 'id' ? 'Penggunaan berjalan vs kuota paket, dengan proyeksi' : 'Current usage vs plan quota, with projection'} />
      <ViewState state={state}>
        {(data) => (
          <div className="grid g-12">
            {data.breaches.length > 0 && (
              <div className="note warn" style={{ gridColumn: 'span 12' }}>
                {locale === 'id' ? 'Ambang penggunaan terlampaui: ' : 'Usage thresholds breached: '}
                {data.breaches.map((b) => `${b.metric} (${Math.round(b.threshold * 100)}%)`).join(', ')}
              </div>
            )}

            <Panel span="wide" title={locale === 'id' ? 'Penggunaan vs Kuota' : 'Usage vs Quota'}>
              {data.snapshot.map((row) => (
                <div key={row.metric} style={{ marginBottom: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
                    <span>{row.metric}</span>
                    <span className="mono">
                      {row.metric === 'storage_mb' ? formatBytes(row.used * 1024 * 1024, locale) : formatNumber(row.used, locale)}
                      {' / '}
                      {row.unlimited ? '∞' : row.metric === 'storage_mb' ? formatBytes(row.quota * 1024 * 1024, locale) : formatNumber(row.quota, locale)}
                    </span>
                  </div>
                  <div className="meter">
                    <span
                      style={{
                        width: `${Math.min(100, row.ratio * 100)}%`,
                        background: row.ratio >= 1 ? 'var(--bad)' : row.ratio >= 0.8 ? 'var(--warn)' : 'var(--good)',
                      }}
                    />
                  </div>
                  <div className="hint" style={{ fontSize: 10.5, color: 'var(--text-400)', marginTop: 4 }}>
                    {/* Perilaku saat kuota terlampaui diberitahukan DI MUKA (PRD 6.29). */}
                    {row.behaviour === 'block'
                      ? locale === 'id' ? 'Melebihi kuota akan memblokir penggunaan tambahan.' : 'Exceeding the quota blocks further usage.'
                      : locale === 'id' ? 'Kelebihan pemakaian akan ditagih (overage).' : 'Usage beyond the quota is billed as overage.'}
                    {row.projectedExhaustionAt && ` · ${locale === 'id' ? 'Diperkirakan penuh' : 'Projected full'}: ${formatDate(row.projectedExhaustionAt, locale)}`}
                  </div>
                </div>
              ))}
            </Panel>

            {/* Metering AI dihitung & ditampilkan TERPISAH (PRD 6.29). */}
            <Panel span="small" title={locale === 'id' ? 'Pemanggilan AI' : 'AI Calls'}>
              <div className="stat-grid" style={{ marginBottom: 12 }}>
                <StatTile label={locale === 'id' ? 'Bulan Ini' : 'This Month'} value={formatNumber(data.ai.calls, locale)} />
                <StatTile label={t('table.quota')} value={data.ai.quota < 0 ? '∞' : formatNumber(data.ai.quota, locale)} />
              </div>
              {data.ai.bySource.map((source) => (
                <Bar key={source.source} label={source.source} value={source.n} max={Math.max(1, ...data.ai.bySource.map((s) => s.n))} formatted={formatNumber(source.n, locale)} />
              ))}
            </Panel>
          </div>
        )}
      </ViewState>
    </div>
  );
}

/** Kuota bernilai negatif berarti tidak dibatasi / sesuai kontrak (PRD 2.1). */
function quotaLabel(quota: number | undefined, locale: 'id' | 'en'): string {
  if (quota === undefined) return '—';
  return quota < 0 ? '∞' : formatNumber(quota, locale);
}
