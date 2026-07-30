/**
 * Domain 5 — Manajemen Data: Dataset (6.11), Koneksi Eksternal (6.12),
 * Data Modeling (6.13), Data Quality Center (6.14), KPI Center (6.15).
 */
import { useRef, useState } from 'react';
import { useApp } from '../app/AppContext.tsx';
import { api, ApiError, type Dataset, type KpiSummary } from '../lib/api.ts';
import { useAsync } from '../lib/useAsync.ts';
import { formatBytes, formatDate, formatDecimal, formatNumber } from '../lib/format.ts';
import { Bar, EmptyState, Field, Panel, StatusTag, ThresholdRing } from '../components/primitives.tsx';
import { PageHead, ViewState } from './shared.tsx';

/* ================= Dataset (Upload CSV) — PRD 6.11 ================= */

export function DatasetView(): JSX.Element {
  const { t, locale, can, session } = useApp();
  const state = useAsync(() => api.get<{ datasets: Dataset[] }>('/datasets'), []);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [feedbackKey, setFeedbackKey] = useState<string | null>(null);

  async function handleUpload(file: File): Promise<void> {
    setBusy(true);
    setFeedbackKey(null);
    try {
      const buffer = await file.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      await api.post('/datasets/upload', { filename: file.name, contentBase64: base64 });
      state.reload();
    } catch (error) {
      setFeedbackKey(error instanceof ApiError ? error.key : 'error.upload_failed');
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  return (
    <div className="view-enter">
      <PageHead
        title="Dataset (Upload CSV)"
        subtitle={locale === 'id' ? 'Unggah CSV — divalidasi, dipindai, lalu diperiksa Data Quality Center' : 'Upload CSV — validated, scanned, then checked by Data Quality Center'}
        actions={
          can('dataset:upload') &&
          !session?.flags.readOnly && (
            <>
              <input
                ref={fileInput}
                type="file"
                accept=".csv,.xlsx"
                style={{ display: 'none' }}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleUpload(file);
                }}
              />
              <button type="button" className="btn primary" disabled={busy} onClick={() => fileInput.current?.click()}>
                {busy ? t('ui.loading') : t('action.upload')}
              </button>
            </>
          )
        }
      />

      {/* Pesan kesalahan MENJELASKAN, bukan meminta maaf (DESIGN.md Bagian 12). */}
      {feedbackKey && <div className="note warn" style={{ marginBottom: 16 }}>{t(feedbackKey)}</div>}

      <ViewState state={state}>
        {(data) =>
          data.datasets.length === 0 ? (
            <Panel span="full">
              <EmptyState messageKey="empty.no_dataset" />
            </Panel>
          ) : (
            <div className="grid g-12">
              <Panel span="full">
                <div className="table-scroll">
                  <table className="stack-mobile">
                    <thead>
                      <tr>
                        <th>{t('table.name')}</th>
                        <th>{t('table.rows')}</th>
                        <th>{t('table.size')}</th>
                        <th>{t('table.quality_score')}</th>
                        <th>{t('table.classification')}</th>
                        <th>{t('table.certification')}</th>
                        <th>{t('table.status')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.datasets.map((dataset) => (
                        <tr key={dataset.id}>
                          <td data-label={t('table.name')}>
                            {dataset.name}
                            <div className="sub mono" style={{ fontSize: 10.5, color: 'var(--text-400)' }}>
                              {dataset.original_filename} · {formatDate(dataset.created_at, locale)}
                            </div>
                            {/* Alasan kegagalan jelas & dapat ditelusuri (PRD 6.11). */}
                            {dataset.failure_reason_key && (
                              <div style={{ color: 'var(--bad)', fontSize: 11, marginTop: 4 }}>
                                {t(dataset.failure_reason_key)}
                              </div>
                            )}
                          </td>
                          <td className="num" data-label={t('table.rows')}>{formatNumber(dataset.row_count, locale)}</td>
                          <td className="num" data-label={t('table.size')}>{formatBytes(dataset.size_bytes, locale)}</td>
                          <td className="num" data-label={t('table.quality_score')}>
                            {dataset.quality_score === null ? '—' : formatDecimal(dataset.quality_score, locale, 1)}
                          </td>
                          <td data-label={t('table.classification')}>
                            <StatusTag
                              status={dataset.classification === 'restricted' ? 'critical' : 'info'}
                              label={dataset.classification}
                            />
                          </td>
                          <td data-label={t('table.certification')}>
                            <StatusTag status={dataset.certification} />
                          </td>
                          <td data-label={t('table.status')}>
                            <StatusTag status={dataset.status} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </div>
          )
        }
      </ViewState>
    </div>
  );
}

/* ================= Data Quality Center — PRD 6.14 ================= */

export function DataQualityView(): JSX.Element {
  const { t, locale, can } = useApp();
  const state = useAsync(() => api.get<{ datasets: Dataset[] }>('/datasets'), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const detail = useAsync(
    () =>
      selected
        ? api.get<{
            dataset: Dataset;
            latestRun: {
              score: number;
              rowsChecked: number;
              duplicateRows: number;
              missingCells: number;
              invalidCells: number;
              certifiable: boolean;
              findings: Array<{ messageKey: string; column?: string; count: number; severity: string }>;
            } | null;
          }>(`/datasets/${selected}`)
        : Promise.resolve(null),
    [selected],
  );

  async function act(datasetId: string, action: 'check' | 'certify' | 'reject'): Promise<void> {
    setMessage(null);
    try {
      if (action === 'check') await api.post(`/datasets/${datasetId}/quality-check`);
      else await api.post(`/datasets/${datasetId}/certify`, { decision: action === 'certify' ? 'certified' : 'rejected' });
      state.reload();
      detail.reload();
    } catch (error) {
      setMessage(error instanceof ApiError ? error.key : 'error.internal');
    }
  }

  return (
    <div className="view-enter">
      <PageHead
        title="Data Quality Center"
        subtitle={locale === 'id' ? 'Skor kualitas 0–100 per dataset, dengan histori' : 'Quality score 0–100 per dataset, with history'}
      />
      {message && <div className="note warn" style={{ marginBottom: 16 }}>{t(message)}</div>}

      <ViewState state={state}>
        {(data) => (
          <div className="grid g-12">
            <Panel title={t('table.name')} span="half">
              {data.datasets.length === 0 ? (
                <EmptyState messageKey="empty.no_dataset" />
              ) : (
                data.datasets.map((dataset) => (
                  <button
                    key={dataset.id}
                    type="button"
                    className="widget-item"
                    onClick={() => setSelected(dataset.id)}
                    style={{ borderColor: selected === dataset.id ? 'var(--accent)' : undefined }}
                  >
                    <ThresholdRing score={dataset.quality_score ?? 0} size={34} />
                    <span style={{ flex: 1, textAlign: 'left' }}>{dataset.name}</span>
                    <StatusTag status={dataset.certification} />
                  </button>
                ))
              )}
            </Panel>

            <Panel
              title={locale === 'id' ? 'Temuan Kualitas' : 'Quality Findings'}
              span="half"
              actions={
                selected && (
                  <div className="head-actions">
                    <button type="button" className="btn" onClick={() => void act(selected, 'check')}>
                      {t('action.run')}
                    </button>
                    {/* Sertifikasi hanya untuk Data Steward (PRD 6.14). */}
                    {can('dataquality:certify') && (
                      <>
                        <button type="button" className="btn primary" onClick={() => void act(selected, 'certify')}>
                          {t('action.certify')}
                        </button>
                        <button type="button" className="btn danger" onClick={() => void act(selected, 'reject')}>
                          {t('action.reject')}
                        </button>
                      </>
                    )}
                  </div>
                )
              }
            >
              {!selected ? (
                <EmptyState messageKey="empty.no_data" />
              ) : detail.loading ? (
                <div className="empty">{t('ui.loading')}</div>
              ) : !detail.data?.latestRun ? (
                <EmptyState messageKey="empty.no_data" />
              ) : (
                <>
                  <div className="stat-grid" style={{ marginBottom: 14 }}>
                    <div className="stat-tile">
                      <div className="k">{t('table.quality_score')}</div>
                      <div className="v">{formatDecimal(detail.data.latestRun.score, locale, 1)}</div>
                    </div>
                    <div className="stat-tile">
                      <div className="k">{t('table.rows')}</div>
                      <div className="v">{formatNumber(detail.data.latestRun.rowsChecked, locale)}</div>
                    </div>
                    <div className="stat-tile">
                      <div className="k">{t('dq.duplicate_rows')}</div>
                      <div className="v">{formatNumber(detail.data.latestRun.duplicateRows, locale)}</div>
                    </div>
                    <div className="stat-tile">
                      <div className="k">{t('stats.missing')}</div>
                      <div className="v">{formatNumber(detail.data.latestRun.missingCells, locale)}</div>
                    </div>
                  </div>

                  {!detail.data.latestRun.certifiable && (
                    <div className="note warn">{t('error.dq_below_threshold')}</div>
                  )}

                  <div className="table-scroll">
                    <table className="stack-mobile">
                      <thead>
                        <tr>
                          <th>{locale === 'id' ? 'Temuan' : 'Finding'}</th>
                          <th>{locale === 'id' ? 'Kolom' : 'Column'}</th>
                          <th>{t('table.total')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.data.latestRun.findings.map((finding, index) => (
                          <tr key={`${finding.messageKey}-${finding.column ?? index}`}>
                            <td data-label="Finding">
                              <StatusTag
                                status={finding.severity === 'critical' ? 'critical' : finding.severity === 'warning' ? 'at_risk' : 'on_track'}
                                label={t(finding.messageKey)}
                              />
                            </td>
                            <td data-label="Column" className="mono">{finding.column ?? '—'}</td>
                            <td className="num" data-label={t('table.total')}>{formatNumber(finding.count, locale)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </Panel>
          </div>
        )}
      </ViewState>
    </div>
  );
}

/* ================= Koneksi Eksternal — PRD 6.12 ================= */

interface Connection {
  id: string;
  name: string;
  kind: string;
  host: string | null;
  status: string;
  read_only: number;
  schedule: string | null;
  last_sync_at: string | null;
  consecutive_failures: number;
  secret_fields: string[];
}

export function ExternalConnectionView(): JSX.Element {
  const { t, locale, can, session } = useApp();
  const state = useAsync(() => api.get<{ connections: Connection[] }>('/connections'), []);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', kind: 'postgresql', host: '', database: '', username: '', secret: '' });

  async function create(): Promise<void> {
    setMessage(null);
    try {
      await api.post('/connections', {
        name: form.name,
        kind: form.kind,
        host: form.host,
        databaseName: form.database,
        username: form.username,
        secrets: form.kind === 'rest_api' ? { api_key: form.secret } : { password: form.secret },
        readOnly: true,
      });
      setForm({ name: '', kind: 'postgresql', host: '', database: '', username: '', secret: '' });
      state.reload();
    } catch (error) {
      setMessage(error instanceof ApiError ? error.key : 'error.internal');
    }
  }

  async function test(id: string): Promise<void> {
    setMessage(null);
    try {
      const result = await api.post<{ ok: boolean; reasonKey?: string }>(`/connections/${id}/test`);
      setMessage(result.ok ? 'status.connected' : (result.reasonKey ?? 'status.auth_failed'));
      state.reload();
    } catch (error) {
      setMessage(error instanceof ApiError ? error.key : 'error.internal');
    }
  }

  return (
    <div className="view-enter">
      <PageHead
        title="Koneksi Eksternal"
        subtitle={locale === 'id' ? 'REST API, PostgreSQL, MySQL, Oracle, Google Sheets' : 'REST API, PostgreSQL, MySQL, Oracle, Google Sheets'}
      />
      {message && <div className="note info" style={{ marginBottom: 16 }}>{t(message)}</div>}

      <ViewState state={state}>
        {(data) => (
          <div className="grid g-12">
            <Panel title={locale === 'id' ? 'Koneksi Terdaftar' : 'Registered Connections'} span="wide">
              {data.connections.length === 0 ? (
                <EmptyState messageKey="empty.no_connection" />
              ) : (
                <div className="table-scroll">
                  <table className="stack-mobile">
                    <thead>
                      <tr>
                        <th>{t('table.name')}</th>
                        <th>{t('table.type')}</th>
                        <th>{t('table.status')}</th>
                        <th>{locale === 'id' ? 'Sinkron Terakhir' : 'Last Sync'}</th>
                        <th>{t('table.actions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.connections.map((connection) => (
                        <tr key={connection.id}>
                          <td data-label={t('table.name')}>
                            {connection.name}
                            <div style={{ fontSize: 10.5, color: 'var(--text-400)' }} className="mono">
                              {connection.host ?? '—'}
                              {/* Kredensial TIDAK PERNAH ditampilkan sebagai teks biasa
                                  setelah disimpan (PRD 6.12, SECURITY.md Bagian 6). */}
                              {connection.secret_fields.length > 0 && ` · ${connection.secret_fields.map(() => '••••••').join(' ')}`}
                            </div>
                          </td>
                          <td data-label={t('table.type')} className="mono">{connection.kind}</td>
                          <td data-label={t('table.status')}>
                            <StatusTag status={connection.status} />
                          </td>
                          <td data-label="Sync">{connection.last_sync_at ? formatDate(connection.last_sync_at, locale) : '—'}</td>
                          <td data-label={t('table.actions')}>
                            {can('connection:test') && (
                              <button type="button" className="btn" onClick={() => void test(connection.id)}>
                                {t('action.test_connection')}
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            {can('connection:write') && !session?.flags.readOnly && (
              <Panel title={t('action.add_new')} span="small">
                <Field label={t('table.name')}>
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </Field>
                <Field label={t('table.type')}>
                  <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                    <option value="postgresql">PostgreSQL</option>
                    <option value="mysql">MySQL</option>
                    <option value="oracle">Oracle Database</option>
                    <option value="rest_api">REST API</option>
                    <option value="google_sheets">Google Sheets</option>
                  </select>
                </Field>
                <Field label="Host / URL">
                  <input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
                </Field>
                {form.kind !== 'rest_api' && form.kind !== 'google_sheets' && (
                  <>
                    <Field label={locale === 'id' ? 'Nama Basis Data' : 'Database Name'}>
                      <input value={form.database} onChange={(e) => setForm({ ...form, database: e.target.value })} />
                    </Field>
                    <Field label={locale === 'id' ? 'Nama Pengguna' : 'Username'}>
                      <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
                    </Field>
                  </>
                )}
                <Field
                  label={form.kind === 'rest_api' ? 'API Key' : t('ui.login_password')}
                  hint={
                    locale === 'id'
                      ? 'Disimpan terenkripsi di vault terpisah; tidak pernah ditampilkan kembali.'
                      : 'Stored encrypted in a separate vault; never displayed again.'
                  }
                >
                  <input type="password" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} />
                </Field>
                <button type="button" className="btn primary" onClick={() => void create()} disabled={!form.name}>
                  {t('action.add_new')}
                </button>
              </Panel>
            )}
          </div>
        )}
      </ViewState>
    </div>
  );
}

/* ================= Data Modeling — PRD 6.13 ================= */

export function DataModelingView(): JSX.Element {
  const { t, locale } = useApp();
  const state = useAsync(
    () =>
      api.get<{
        tables: Array<{
          id: string;
          name: string;
          kind: string;
          grain: string | null;
          scd_type: number | null;
          fields: Array<{ id: string; name: string; data_type: string; role: string; formula: string | null }>;
        }>;
      }>('/model/tables'),
    [],
  );
  const dictionary = useAsync(
    () => api.get<{ terms: Array<{ term: string; definition_id: string; definition_en: string | null }> }>('/model/dictionary'),
    [],
  );

  return (
    <div className="view-enter">
      <PageHead
        title="Data Modeling"
        subtitle={locale === 'id' ? 'Fact & dimension, lineage otomatis, Formula Builder tanpa SQL' : 'Fact & dimension, automatic lineage, no-SQL Formula Builder'}
      />
      <ViewState state={state}>
        {(data) => (
          <div className="grid g-12">
            <Panel title={locale === 'id' ? 'Tabel Model' : 'Model Tables'} span="wide">
              {data.tables.length === 0 ? (
                <EmptyState messageKey="empty.no_data" />
              ) : (
                data.tables.map((table) => (
                  <div key={table.id} style={{ marginBottom: 18 }}>
                    <div className="panel-head">
                      <div>
                        <h3 className="mono">{table.name}</h3>
                        <div className="sub">
                          <StatusTag status={table.kind === 'fact' ? 'info' : 'on_track'} label={table.kind} />{' '}
                          {table.grain && `· grain: ${table.grain}`}
                          {table.scd_type && ` · SCD ${table.scd_type}`}
                        </div>
                      </div>
                    </div>
                    <div className="table-scroll">
                      <table className="stack-mobile">
                        <thead>
                          <tr>
                            <th>{t('table.name')}</th>
                            <th>{t('table.type')}</th>
                            <th>{t('table.role')}</th>
                            <th>Formula</th>
                          </tr>
                        </thead>
                        <tbody>
                          {table.fields.map((field) => (
                            <tr key={field.id}>
                              <td className="mono" data-label={t('table.name')}>{field.name}</td>
                              <td data-label={t('table.type')}>{field.data_type}</td>
                              <td data-label={t('table.role')}>{field.role}</td>
                              <td className="mono" data-label="Formula">{field.formula ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))
              )}
            </Panel>

            <Panel title={locale === 'id' ? 'Business Dictionary' : 'Business Dictionary'} span="small">
              {!dictionary.data || dictionary.data.terms.length === 0 ? (
                <EmptyState messageKey="empty.no_data" />
              ) : (
                dictionary.data.terms.map((term) => (
                  <div className="feed-item" key={term.term}>
                    <div>
                      <b>{term.term}</b>
                      <div className="feed-time">{locale === 'en' ? (term.definition_en ?? term.definition_id) : term.definition_id}</div>
                    </div>
                  </div>
                ))
              )}
            </Panel>
          </div>
        )}
      </ViewState>
    </div>
  );
}

/* ================= KPI Center — PRD 6.15 ================= */

export function KpiCenterView(): JSX.Element {
  const { t, locale } = useApp();
  const state = useAsync(() => api.get<{ kpis: KpiSummary[] }>('/kpis'), []);
  const [selected, setSelected] = useState<string | null>(null);

  const history = useAsync(
    () =>
      selected
        ? api.get<{ history: Array<{ period: string; value: number; score: number; status: string }> }>(
            `/kpis/${selected}/history?limit=24`,
          )
        : Promise.resolve(null),
    [selected],
  );

  return (
    <div className="view-enter">
      <PageHead
        title="KPI Center"
        subtitle={locale === 'id' ? 'Definisi, bobot, target, dan ambang batas terstandardisasi' : 'Standardised definitions, weights, targets and thresholds'}
      />
      <ViewState state={state}>
        {(data) =>
          data.kpis.length === 0 ? (
            <Panel span="full">
              <EmptyState messageKey="empty.no_kpi" />
            </Panel>
          ) : (
            <div className="grid g-12">
              {data.kpis.map((kpi) => (
                <div
                  className="card kpi-card"
                  key={kpi.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelected(kpi.id)}
                  onKeyDown={(e) => e.key === 'Enter' && setSelected(kpi.id)}
                  style={{ cursor: 'pointer', borderColor: selected === kpi.id ? 'var(--accent)' : undefined }}
                >
                  <ThresholdRing score={kpi.latest?.score ?? 0} status={kpi.latest?.status} />
                  <div className="kpi-meta">
                    <div className="name">{kpi.name}</div>
                    <div className="row mono">
                      {kpi.code}
                      {kpi.latest && <StatusTag status={kpi.latest.status} />}
                    </div>
                    <div className="row">
                      {t('table.target')}: {kpi.target === null ? '—' : formatDecimal(kpi.target, locale, 2)} {kpi.unit ?? ''}
                    </div>
                  </div>
                </div>
              ))}

              <Panel
                title={locale === 'id' ? 'Ambang Batas & Histori' : 'Thresholds & History'}
                subtitle={data.kpis.find((k) => k.id === selected)?.name}
                span="full"
              >
                {!selected ? (
                  <EmptyState messageKey="empty.no_data" />
                ) : (
                  <>
                    <div className="pill-row" style={{ marginBottom: 14 }}>
                      {data.kpis
                        .find((k) => k.id === selected)
                        ?.thresholds.map((threshold, index) => (
                          <StatusTag
                            key={index}
                            status={threshold.level}
                            label={`${t('table.threshold')} ${t(`status.${threshold.level}`)}: ${threshold.comparator === 'gte' ? '≥' : '≤'} ${formatDecimal(threshold.value, locale, 2)}`}
                          />
                        ))}
                    </div>
                    {history.loading ? (
                      <div className="empty">{t('ui.loading')}</div>
                    ) : !history.data || history.data.history.length === 0 ? (
                      <EmptyState messageKey="empty.no_data" />
                    ) : (
                      <div className="table-scroll">
                        <table className="stack-mobile">
                          <thead>
                            <tr>
                              <th>{t('table.period')}</th>
                              <th>{t('table.value')}</th>
                              <th>{t('table.score')}</th>
                              <th>{t('table.status')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {history.data.history.map((row) => (
                              <tr key={row.period}>
                                <td className="mono" data-label={t('table.period')}>{row.period}</td>
                                <td className="num" data-label={t('table.value')}>{formatDecimal(row.value, locale, 2)}</td>
                                <td className="num" data-label={t('table.score')}>{formatDecimal(row.score, locale, 1)}</td>
                                <td data-label={t('table.status')}>
                                  <StatusTag status={row.status} />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                )}
              </Panel>
            </div>
          )
        }
      </ViewState>
    </div>
  );
}
