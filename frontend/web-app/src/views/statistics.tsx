/**
 * Domain 4 — Analisis Statistik: Statistik Deskriptif (6.22), Uji Hipotesis (6.23),
 * Regresi & Korelasi (6.24).
 *
 * Setiap output WAJIB menampilkan: pemeriksaan asumsi, peringatan bila dilanggar,
 * effect size, dan pembedaan eksplisit antara asosiasi dan kausalitas.
 */
import { useState } from 'react';
import { useApp } from '../app/AppContext.tsx';
import { api, ApiError, type Dataset } from '../lib/api.ts';
import { useAsync } from '../lib/useAsync.ts';
import { formatDecimal, formatNumber } from '../lib/format.ts';
import { EmptyState, Field, Panel, StatTile, StatusTag } from '../components/primitives.tsx';
import { CausalityNote, PageHead, ViewState, WarningList } from './shared.tsx';

function useDatasets(): { datasets: Dataset[]; loading: boolean } {
  const state = useAsync(() => api.get<{ datasets: Dataset[] }>('/datasets'), []);
  return { datasets: state.data?.datasets ?? [], loading: state.loading };
}

function useColumns(datasetId: string | null): Array<{ name: string; type: string }> {
  const state = useAsync(
    () =>
      datasetId
        ? api.get<{ columns: Array<{ name: string; type: string }> }>(`/datasets/${datasetId}`)
        : Promise.resolve(null),
    [datasetId],
  );
  return state.data?.columns ?? [];
}

/* ================= Statistik Deskriptif — PRD 6.22 ================= */

interface DescriptiveStats {
  n: number;
  missing: number;
  distinct: number;
  mean: number;
  median: number;
  mode: number[];
  stdDev: number;
  variance: number;
  min: number;
  max: number;
  range: number;
  q1: number;
  q3: number;
  iqr: number;
  skewness: number;
  kurtosis: number;
}

export function DescriptiveStatisticsView(): JSX.Element {
  const { t, locale } = useApp();
  const { datasets } = useDatasets();
  const [datasetId, setDatasetId] = useState<string | null>(null);
  const [field, setField] = useState('');
  const [groupBy, setGroupBy] = useState('');
  const [result, setResult] = useState<{
    perField: Array<{ field: string; stats: DescriptiveStats; boxPlot: { outliers: number[] } }>;
    byGroup?: Array<{ field: string; groups: Array<{ group: string; stats: DescriptiveStats }> }>;
    source: { datasetName: string; rowsAnalysed: number };
  } | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const columns = useColumns(datasetId);

  async function run(): Promise<void> {
    if (!datasetId || !field) return;
    setErrorKey(null);
    try {
      setResult(await api.post('/stats/descriptive', { datasetId, fields: [field], groupBy: groupBy || undefined }));
    } catch (error) {
      setResult(null);
      setErrorKey(error instanceof ApiError ? error.key : 'error.internal');
    }
  }

  const stats = result?.perField[0]?.stats;

  return (
    <div className="view-enter">
      <PageHead title="Statistik Deskriptif" subtitle={locale === 'id' ? 'Pemusatan, penyebaran, bentuk distribusi' : 'Central tendency, dispersion, distribution shape'} />
      <div className="grid g-12">
        <Panel title={locale === 'id' ? 'Konfigurasi Analisis' : 'Analysis Configuration'} span="small">
          <Field label="Dataset">
            <select value={datasetId ?? ''} onChange={(e) => { setDatasetId(e.target.value || null); setField(''); }}>
              <option value="">—</option>
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </Field>
          <Field label={locale === 'id' ? 'Variabel Numerik' : 'Numeric Variable'}>
            <select value={field} onChange={(e) => setField(e.target.value)}>
              <option value="">—</option>
              {columns.filter((c) => c.type === 'number').map((c) => (
                <option key={c.name} value={c.name}>{c.name}</option>
              ))}
            </select>
          </Field>
          <Field label={locale === 'id' ? 'Kelompokkan menurut (opsional)' : 'Group by (optional)'}>
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
              <option value="">—</option>
              {columns.filter((c) => c.type === 'text').map((c) => (
                <option key={c.name} value={c.name}>{c.name}</option>
              ))}
            </select>
          </Field>
          <button type="button" className="btn primary" disabled={!datasetId || !field} onClick={() => void run()}>
            {t('action.run')}
          </button>
        </Panel>

        <Panel title={locale === 'id' ? 'Hasil' : 'Results'} span="wide">
          {errorKey && <div className="note warn">{t(errorKey)}</div>}
          {!stats ? (
            <EmptyState messageKey="empty.no_data" />
          ) : (
            <>
              <div className="stat-grid">
                <StatTile label={t('stats.n')} value={formatNumber(stats.n, locale)} />
                <StatTile label={t('stats.missing')} value={formatNumber(stats.missing, locale)} />
                <StatTile label={t('stats.distinct')} value={formatNumber(stats.distinct, locale)} />
                <StatTile label={t('stats.mean')} value={formatDecimal(stats.mean, locale, 3)} />
                <StatTile label={t('stats.median')} value={formatDecimal(stats.median, locale, 3)} />
                <StatTile label={t('stats.mode')} value={stats.mode.length ? stats.mode.map((m) => formatDecimal(m, locale, 2)).join(', ') : '—'} />
                <StatTile label={t('stats.std_dev')} value={formatDecimal(stats.stdDev, locale, 3)} />
                <StatTile label={t('stats.variance')} value={formatDecimal(stats.variance, locale, 3)} />
                <StatTile label={t('stats.range')} value={formatDecimal(stats.range, locale, 3)} />
                <StatTile label="Q1" value={formatDecimal(stats.q1, locale, 3)} />
                <StatTile label="Q3" value={formatDecimal(stats.q3, locale, 3)} />
                <StatTile label={t('stats.iqr')} value={formatDecimal(stats.iqr, locale, 3)} />
                <StatTile label={t('stats.skewness')} value={formatDecimal(stats.skewness, locale, 3)} />
                <StatTile label={t('stats.kurtosis')} value={formatDecimal(stats.kurtosis, locale, 3)} />
              </div>

              {result?.byGroup?.[0] && (
                <div className="table-scroll" style={{ marginTop: 18 }}>
                  <table className="stack-mobile">
                    <thead>
                      <tr>
                        <th>{groupBy}</th>
                        <th>N</th>
                        <th>{t('stats.mean')}</th>
                        <th>{t('stats.median')}</th>
                        <th>{t('stats.std_dev')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.byGroup[0].groups.map((g) => (
                        <tr key={g.group}>
                          <td data-label={groupBy}>{g.group}</td>
                          <td className="num" data-label="N">{formatNumber(g.stats.n, locale)}</td>
                          <td className="num" data-label={t('stats.mean')}>{formatDecimal(g.stats.mean, locale, 3)}</td>
                          <td className="num" data-label={t('stats.median')}>{formatDecimal(g.stats.median, locale, 3)}</td>
                          <td className="num" data-label={t('stats.std_dev')}>{formatDecimal(g.stats.stdDev, locale, 3)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="note" style={{ marginTop: 12 }}>
                {t('ai.sources_label')}: {result?.source.datasetName} · {formatNumber(result?.source.rowsAnalysed ?? 0, locale)} {t('table.rows').toLowerCase()}
              </div>
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}

/* ================= Uji Hipotesis — PRD 6.23 ================= */

interface TestResult {
  testKey: string;
  statistic: number;
  df: number | [number, number];
  pValue: number;
  alpha: number;
  significant: boolean;
  effectSize?: { nameKey: string; value: number; magnitudeKey: string };
  confidenceInterval?: [number, number];
  assumptions: Array<{ nameKey: string; passed: boolean; statistic: number; pValue: number; alternativeTestKey?: string }>;
  warnings: string[];
  interpretation: { key: string; params: Record<string, string | number> };
  causalityNoteKey: string;
  groups?: Array<{ label: string; n: number; mean: number; stdDev: number }>;
}

const TESTS = [
  'one_sample_t', 'independent_t', 'paired_t', 'one_way_anova',
  'mann_whitney', 'wilcoxon', 'kruskal_wallis',
  'chi_square_independence', 'chi_square_goodness_of_fit',
] as const;

export function HypothesisTestingView(): JSX.Element {
  const { t, locale } = useApp();
  const { datasets } = useDatasets();
  const [datasetId, setDatasetId] = useState<string | null>(null);
  const [test, setTest] = useState<string>('independent_t');
  const [valueField, setValueField] = useState('');
  const [groupField, setGroupField] = useState('');
  const [alpha, setAlpha] = useState(0.05);
  const [result, setResult] = useState<TestResult | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const columns = useColumns(datasetId);
  const isCategorical = test.startsWith('chi_square');

  async function run(): Promise<void> {
    if (!datasetId) return;
    setErrorKey(null);
    try {
      setResult(
        await api.post('/stats/hypothesis', {
          datasetId,
          test,
          alpha,
          valueField: valueField || undefined,
          groupField: groupField || undefined,
          categoryFieldA: isCategorical ? groupField : undefined,
          categoryFieldB: isCategorical ? valueField : undefined,
          mu: test === 'one_sample_t' ? 0 : undefined,
        }),
      );
    } catch (error) {
      setResult(null);
      setErrorKey(error instanceof ApiError ? error.key : 'error.internal');
    }
  }

  return (
    <div className="view-enter">
      <PageHead title="Uji Hipotesis" subtitle={locale === 'id' ? 'Uji formal dengan pemeriksaan asumsi otomatis' : 'Formal tests with automatic assumption checks'} />
      <div className="grid g-12">
        <Panel title={locale === 'id' ? 'Konfigurasi Uji' : 'Test Configuration'} span="small">
          <Field label="Dataset">
            <select value={datasetId ?? ''} onChange={(e) => setDatasetId(e.target.value || null)}>
              <option value="">—</option>
              {datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
          <Field label={locale === 'id' ? 'Jenis Uji' : 'Test Type'}>
            <select value={test} onChange={(e) => setTest(e.target.value)}>
              {TESTS.map((key) => <option key={key} value={key}>{t(`test.${key}`)}</option>)}
            </select>
          </Field>
          <Field label={isCategorical ? (locale === 'id' ? 'Variabel Kategorik B' : 'Categorical Variable B') : (locale === 'id' ? 'Variabel Numerik' : 'Numeric Variable')}>
            <select value={valueField} onChange={(e) => setValueField(e.target.value)}>
              <option value="">—</option>
              {columns.filter((c) => (isCategorical ? c.type === 'text' : c.type === 'number')).map((c) => (
                <option key={c.name} value={c.name}>{c.name}</option>
              ))}
            </select>
          </Field>
          <Field label={isCategorical ? (locale === 'id' ? 'Variabel Kategorik A' : 'Categorical Variable A') : (locale === 'id' ? 'Variabel Kelompok' : 'Grouping Variable')}>
            <select value={groupField} onChange={(e) => setGroupField(e.target.value)}>
              <option value="">—</option>
              {columns.filter((c) => c.type === 'text').map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
          </Field>
          <Field label={t('stats.alpha')}>
            <select value={alpha} onChange={(e) => setAlpha(Number(e.target.value))}>
              <option value={0.01}>0.01</option>
              <option value={0.05}>0.05</option>
              <option value={0.1}>0.10</option>
            </select>
          </Field>
          <button type="button" className="btn primary" disabled={!datasetId} onClick={() => void run()}>
            {t('action.run')}
          </button>
        </Panel>

        <Panel title={locale === 'id' ? 'Hasil Uji' : 'Test Result'} span="wide">
          {errorKey && <div className="note warn">{t(errorKey)}</div>}
          {!result ? (
            <EmptyState messageKey="empty.no_data" />
          ) : (
            <>
              <h3 style={{ marginBottom: 10 }}>{t(result.testKey)}</h3>
              <div className="stat-grid">
                <StatTile label={t('stats.statistic')} value={formatDecimal(result.statistic, locale, 4)} />
                <StatTile label={t('stats.df')} value={Array.isArray(result.df) ? result.df.join(', ') : formatDecimal(result.df, locale, 2)} />
                <StatTile label={t('stats.p_value')} value={result.pValue < 0.0001 ? '< 0.0001' : formatDecimal(result.pValue, locale, 4)} />
                <StatTile label={t('stats.alpha')} value={String(result.alpha)} />
                {result.effectSize && (
                  <StatTile label={t(result.effectSize.nameKey)} value={`${formatDecimal(result.effectSize.value, locale, 3)} (${t(result.effectSize.magnitudeKey)})`} />
                )}
                {result.confidenceInterval && (
                  <StatTile
                    label={t('stats.confidence_interval')}
                    value={`[${formatDecimal(result.confidenceInterval[0], locale, 3)}, ${formatDecimal(result.confidenceInterval[1], locale, 3)}]`}
                  />
                )}
              </div>

              <div style={{ margin: '14px 0' }}>
                <StatusTag status={result.significant ? 'critical' : 'on_track'} label={t(result.significant ? 'stats.significant' : 'stats.not_significant')} />
              </div>

              <p style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text-900)' }}>
                {t(result.interpretation.key, result.interpretation.params)}
              </p>

              <h3 style={{ marginTop: 18, marginBottom: 8, fontSize: 13 }}>{t('stats.assumptions')}</h3>
              <div className="table-scroll">
                <table className="stack-mobile">
                  <thead>
                    <tr>
                      <th>{locale === 'id' ? 'Asumsi' : 'Assumption'}</th>
                      <th>{t('table.status')}</th>
                      <th>{t('stats.statistic')}</th>
                      <th>{t('stats.p_value')}</th>
                      <th>{locale === 'id' ? 'Alternatif' : 'Alternative'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.assumptions.map((assumption, index) => (
                      <tr key={`${assumption.nameKey}-${index}`}>
                        <td data-label="Assumption">{t(assumption.nameKey)}</td>
                        <td data-label={t('table.status')}>
                          <StatusTag status={assumption.passed ? 'on_track' : 'critical'} label={t(assumption.passed ? 'assumption.passed' : 'assumption.violated')} />
                        </td>
                        <td className="num" data-label={t('stats.statistic')}>{Number.isFinite(assumption.statistic) ? formatDecimal(assumption.statistic, locale, 4) : '—'}</td>
                        <td className="num" data-label={t('stats.p_value')}>{Number.isFinite(assumption.pValue) ? formatDecimal(assumption.pValue, locale, 4) : '—'}</td>
                        <td data-label="Alternative">{assumption.alternativeTestKey ? t(assumption.alternativeTestKey) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {result.groups && (
                <div className="table-scroll" style={{ marginTop: 14 }}>
                  <table className="stack-mobile">
                    <thead>
                      <tr><th>{locale === 'id' ? 'Kelompok' : 'Group'}</th><th>N</th><th>{t('stats.mean')}</th><th>{t('stats.std_dev')}</th></tr>
                    </thead>
                    <tbody>
                      {result.groups.map((g) => (
                        <tr key={g.label}>
                          <td data-label="Group">{g.label}</td>
                          <td className="num" data-label="N">{formatNumber(g.n, locale)}</td>
                          <td className="num" data-label={t('stats.mean')}>{formatDecimal(g.mean, locale, 3)}</td>
                          <td className="num" data-label={t('stats.std_dev')}>{formatDecimal(g.stdDev, locale, 3)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </Panel>

        {result && <WarningList keys={result.warnings} />}
        {result && <CausalityNote noteKey={result.causalityNoteKey} />}
      </div>
    </div>
  );
}

/* ================= Regresi & Korelasi — PRD 6.24 ================= */

interface RegressionResult {
  modelKey: string;
  coefficients: Array<{ name: string; estimate: number; standardError: number; tValue: number; pValue: number; confidenceInterval: [number, number]; vif?: number; oddsRatio?: number }>;
  rSquared?: number;
  adjustedRSquared?: number;
  mcFaddenR2?: number;
  fStatistic?: number;
  fPValue?: number;
  accuracy?: number;
  n: number;
  equation: string;
  diagnostics?: { durbinWatson: number; durbinWatsonVerdictKey: string; maxVif: number; multicollinearityVerdictKey: string; influentialPoints: unknown[]; normalityOfResidualsPValue: number };
  warnings: string[];
  causalityNoteKey: string;
}

export function RegressionView(): JSX.Element {
  const { t, locale } = useApp();
  const { datasets } = useDatasets();
  const [datasetId, setDatasetId] = useState<string | null>(null);
  const [mode, setMode] = useState<'correlation' | 'linear' | 'logistic'>('correlation');
  const [response, setResponse] = useState('');
  const [predictors, setPredictors] = useState<string[]>([]);
  const [method, setMethod] = useState<'pearson' | 'spearman' | 'kendall'>('pearson');
  const [correlation, setCorrelation] = useState<{ variables: string[]; matrix: number[][]; pValues: number[][]; causalityNoteKey: string } | null>(null);
  const [regression, setRegression] = useState<RegressionResult | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const columns = useColumns(datasetId);
  const numeric = columns.filter((c) => c.type === 'number').map((c) => c.name);

  async function run(): Promise<void> {
    if (!datasetId) return;
    setErrorKey(null);
    setCorrelation(null);
    setRegression(null);
    try {
      if (mode === 'correlation') {
        setCorrelation(await api.post('/stats/correlation', { datasetId, fields: numeric.slice(0, 8), method }));
      } else {
        setRegression(await api.post('/stats/regression', { datasetId, kind: mode, responseField: response, predictorFields: predictors }));
      }
    } catch (error) {
      setErrorKey(error instanceof ApiError ? error.key : 'error.internal');
    }
  }

  return (
    <div className="view-enter">
      <PageHead title="Regresi & Korelasi" subtitle={locale === 'id' ? 'Dengan diagnostik model otomatis (VIF, Durbin-Watson, outlier)' : 'With automatic model diagnostics (VIF, Durbin-Watson, outliers)'} />
      <div className="grid g-12">
        <Panel title={locale === 'id' ? 'Konfigurasi' : 'Configuration'} span="small">
          <Field label="Dataset">
            <select value={datasetId ?? ''} onChange={(e) => setDatasetId(e.target.value || null)}>
              <option value="">—</option>
              {datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
          <Field label={locale === 'id' ? 'Analisis' : 'Analysis'}>
            <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
              <option value="correlation">{locale === 'id' ? 'Matriks Korelasi' : 'Correlation Matrix'}</option>
              <option value="linear">{t('model.linear_regression')}</option>
              <option value="logistic">{t('model.logistic_regression')}</option>
            </select>
          </Field>
          {mode === 'correlation' ? (
            <Field label={locale === 'id' ? 'Metode' : 'Method'}>
              <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                <option value="pearson">{t('correlation.pearson')}</option>
                <option value="spearman">{t('correlation.spearman')}</option>
                <option value="kendall">{t('correlation.kendall')}</option>
              </select>
            </Field>
          ) : (
            <>
              <Field label={locale === 'id' ? 'Variabel Terikat' : 'Response Variable'}>
                <select value={response} onChange={(e) => setResponse(e.target.value)}>
                  <option value="">—</option>
                  {numeric.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </Field>
              <Field label={locale === 'id' ? 'Prediktor' : 'Predictors'} hint={locale === 'id' ? 'Tahan Ctrl untuk memilih beberapa' : 'Hold Ctrl to select several'}>
                <select
                  multiple
                  size={5}
                  value={predictors}
                  onChange={(e) => setPredictors(Array.from(e.target.selectedOptions).map((o) => o.value))}
                >
                  {numeric.filter((n) => n !== response).map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </Field>
            </>
          )}
          <button type="button" className="btn primary" disabled={!datasetId} onClick={() => void run()}>{t('action.run')}</button>
        </Panel>

        <Panel title={locale === 'id' ? 'Hasil' : 'Results'} span="wide">
          {errorKey && <div className="note warn">{t(errorKey)}</div>}

          {correlation && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th />
                    {correlation.variables.map((v) => <th key={v}>{v}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {correlation.variables.map((rowVar, i) => (
                    <tr key={rowVar}>
                      <td><b>{rowVar}</b></td>
                      {correlation.variables.map((_, j) => {
                        const value = correlation.matrix[i]![j]!;
                        const p = correlation.pValues[i]![j]!;
                        const intensity = Math.abs(value);
                        return (
                          <td key={j} className="num">
                            <span
                              className="heat-cell"
                              style={{
                                background: `color-mix(in srgb, ${value >= 0 ? 'var(--series-1)' : 'var(--series-6)'} ${Math.round(intensity * 55)}%, transparent)`,
                              }}
                              title={`p = ${p.toFixed(4)}`}
                            >
                              {formatDecimal(value, locale, 2)}
                              {p < 0.05 && i !== j ? '*' : ''}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="note">* p &lt; 0.05</div>
            </div>
          )}

          {regression && (
            <>
              <div className="mono" style={{ background: 'var(--canvas)', padding: '10px 12px', borderRadius: 'var(--radius-sm)', marginBottom: 14, fontSize: 12 }}>
                {regression.equation}
              </div>
              <div className="stat-grid" style={{ marginBottom: 14 }}>
                {regression.rSquared !== undefined && <StatTile label="R²" value={formatDecimal(regression.rSquared, locale, 4)} />}
                {regression.adjustedRSquared !== undefined && <StatTile label="Adj. R²" value={formatDecimal(regression.adjustedRSquared, locale, 4)} />}
                {regression.mcFaddenR2 !== undefined && <StatTile label="McFadden R²" value={formatDecimal(regression.mcFaddenR2, locale, 4)} />}
                {regression.fStatistic !== undefined && <StatTile label="F" value={formatDecimal(regression.fStatistic, locale, 3)} />}
                {regression.accuracy !== undefined && <StatTile label={locale === 'id' ? 'Akurasi' : 'Accuracy'} value={formatDecimal(regression.accuracy * 100, locale, 1) + '%'} />}
                <StatTile label="N" value={formatNumber(regression.n, locale)} />
                {regression.diagnostics && <StatTile label="Durbin-Watson" value={`${formatDecimal(regression.diagnostics.durbinWatson, locale, 3)} · ${t(regression.diagnostics.durbinWatsonVerdictKey)}`} />}
                {regression.diagnostics && <StatTile label="Max VIF" value={`${formatDecimal(regression.diagnostics.maxVif, locale, 2)} · ${t(regression.diagnostics.multicollinearityVerdictKey)}`} />}
              </div>

              <div className="table-scroll">
                <table className="stack-mobile">
                  <thead>
                    <tr>
                      <th>{locale === 'id' ? 'Koefisien' : 'Coefficient'}</th>
                      <th>{locale === 'id' ? 'Estimasi' : 'Estimate'}</th>
                      <th>Std. Error</th>
                      <th>t / z</th>
                      <th>{t('stats.p_value')}</th>
                      <th>95% CI</th>
                      {regression.coefficients.some((c) => c.vif !== undefined) && <th>VIF</th>}
                      {regression.coefficients.some((c) => c.oddsRatio !== undefined) && <th>Odds Ratio</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {regression.coefficients.map((c) => (
                      <tr key={c.name}>
                        <td className="mono" data-label="Coefficient">{c.name}</td>
                        <td className="num" data-label="Estimate">{formatDecimal(c.estimate, locale, 4)}</td>
                        <td className="num" data-label="SE">{formatDecimal(c.standardError, locale, 4)}</td>
                        <td className="num" data-label="t/z">{formatDecimal(c.tValue, locale, 3)}</td>
                        <td className="num" data-label="p">{c.pValue < 0.0001 ? '< 0.0001' : formatDecimal(c.pValue, locale, 4)}</td>
                        <td className="num" data-label="CI">[{formatDecimal(c.confidenceInterval[0], locale, 3)}, {formatDecimal(c.confidenceInterval[1], locale, 3)}]</td>
                        {c.vif !== undefined && <td className="num" data-label="VIF">{formatDecimal(c.vif, locale, 2)}</td>}
                        {c.oddsRatio !== undefined && <td className="num" data-label="OR">{formatDecimal(c.oddsRatio, locale, 3)}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {!correlation && !regression && !errorKey && <EmptyState messageKey="empty.no_data" />}
        </Panel>

        {regression && <WarningList keys={regression.warnings} />}
        {(correlation || regression) && <CausalityNote noteKey={(regression ?? correlation)!.causalityNoteKey} />}
      </div>
    </div>
  );
}
