/**
 * Domain 1 — Kepemimpinan: Executive Cockpit (6.1), Operational Cockpit (6.2),
 * Balanced Scorecard (6.25).
 */
import { useState } from 'react';
import { useApp } from '../app/AppContext.tsx';
import { api } from '../lib/api.ts';
import { useAsync } from '../lib/useAsync.ts';
import { currentPeriod, formatDecimal, formatPeriod } from '../lib/format.ts';
import { Card, EmptyState, Legend, LineChart, Panel, Segmented, StatusTag, ThresholdRing } from '../components/primitives.tsx';
import { PageHead, ViewState } from './shared.tsx';

interface CockpitKpi {
  id: string;
  name: string;
  unit: string | null;
  score: number;
  value: number;
  target: number | null;
  status: string;
  ownerLabel: string | null;
  trend: Array<{ period: string; score: number }>;
  /** `null` = agregat seluruh organisasi; berisi nama dimensi bila angkanya sebagian. */
  dimensionScope: string | null;
}

export function ExecutiveCockpitView(): JSX.Element {
  const { t, locale } = useApp();
  const [period, setPeriod] = useState(currentPeriod());

  const state = useAsync(
    () =>
      api.get<{
        period: string;
        overallScore: number;
        kpis: CockpitKpi[];
        topRisks: Array<{ label: string; score: number; trendKey: string }>;
        excludedUncertifiedCount: number;
      }>(`/cockpit/executive?period=${period}`),
    [period],
  );

  return (
    <div className="view-enter">
      <PageHead
        title="Executive Cockpit"
        subtitle={`${t('table.period')}: ${formatPeriod(period, locale)}`}
        actions={
          <Segmented
            value={period}
            onChange={setPeriod}
            options={recentPeriods().map((p) => ({ value: p, label: formatPeriod(p, locale) }))}
          />
        }
      />
      <ViewState state={state}>
        {(data) => (
          <div className="grid g-12">
            <div className="ai-banner">
              <div className="ico">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M12 3l1.8 4.9L19 9.5l-4.9 1.8L12 16l-1.8-4.9L5 9.5l4.9-1.8L12 3z" />
                </svg>
              </div>
              <div>
                <div className="eyebrow">{t('ai.banner_eyebrow')}</div>
                <p>
                  {t('ui.overall_score')}: <b>{formatDecimal(data.overallScore, locale, 1)}</b> —{' '}
                  {data.kpis.length} KPI, {data.topRisks.length} {t('status.at_risk')}.
                  {data.excludedUncertifiedCount > 0 && (
                    <>
                      {' '}
                      <span className="chip">{data.excludedUncertifiedCount}</span> KPI{' '}
                      {locale === 'id' ? 'dikecualikan karena sumbernya belum Certified' : 'excluded — source not Certified'}.
                    </>
                  )}
                </p>
              </div>
            </div>

            {data.kpis.length === 0 ? (
              <Panel span="full">
                <EmptyState messageKey="empty.no_kpi" />
              </Panel>
            ) : (
              data.kpis.slice(0, 8).map((kpi) => (
                <Card className="kpi-card" key={kpi.id}>
                  <ThresholdRing score={kpi.score} status={kpi.status} />
                  <div className="kpi-meta">
                    <div className="name" title={kpi.name}>
                      {kpi.name}
                    </div>
                    <div className="row mono">
                      {kpi.target !== null && `${t('table.target')} ${formatDecimal(kpi.target, locale, 1)}`}
                      <StatusTag status={kpi.status} />
                    </div>
                    {kpi.ownerLabel && <div className="row">{kpi.ownerLabel}</div>}
                    {kpi.dimensionScope !== null && (
                      <div className="row">{t('ui.scope_dimension', { scope: kpi.dimensionScope })}</div>
                    )}
                  </div>
                </Card>
              ))
            )}

            {data.kpis[0] && (
              <Panel
                title={locale === 'id' ? 'Tren Skor vs Target' : 'Score Trend vs Target'}
                subtitle={data.kpis[0].name}
                span="wide"
                actions={
                  <Legend
                    items={[
                      { label: locale === 'id' ? 'Aktual' : 'Actual', colour: 'var(--series-1)' },
                      { label: t('table.target'), colour: 'var(--text-400)' },
                    ]}
                  />
                }
              >
                <LineChart
                  series={[
                    { name: 'actual', points: data.kpis[0].trend.map((p) => p.score) },
                    {
                      name: 'target',
                      points: data.kpis[0].trend.map(() => 85),
                      colour: 'var(--text-400)',
                      dashed: true,
                    },
                  ]}
                />
              </Panel>
            )}

            <Panel title={locale === 'id' ? 'Top Risiko Terbuka' : 'Top Open Risks'} span="small">
              {data.topRisks.length === 0 ? (
                <EmptyState messageKey="empty.no_data" />
              ) : (
                <div className="table-scroll">
                  <table className="stack-mobile">
                    <thead>
                      <tr>
                        <th>{t('table.name')}</th>
                        <th>{t('table.score')}</th>
                        <th>{t('table.trend')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.topRisks.map((risk) => (
                        <tr key={risk.label}>
                          <td data-label={t('table.name')}>{risk.label}</td>
                          <td className="num" data-label={t('table.score')}>
                            {formatDecimal(risk.score, locale, 1)}
                          </td>
                          <td data-label={t('table.trend')}>
                            <StatusTag
                              status={risk.trendKey === 'rising' ? 'critical' : risk.trendKey === 'falling' ? 'on_track' : 'at_risk'}
                              label={risk.trendKey === 'rising' ? '▲' : risk.trendKey === 'falling' ? '▼' : '—'}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            {/* PRD 6.1: hanya dataset Certified. */}
            <div className="note">{t('ui.certified_only_note')}</div>
          </div>
        )}
      </ViewState>
    </div>
  );
}

export function OperationalCockpitView(): JSX.Element {
  const { t, locale, session } = useApp();
  const [period, setPeriod] = useState(currentPeriod());

  const state = useAsync(
    () =>
      api.get<{
        kpis: CockpitKpi[];
        openAlerts: Array<{ id: string; label: string; severity: string; detectedAt: string }>;
        rlsApplied: boolean;
        rlsDimensions: string[];
      }>(`/cockpit/operational?period=${period}`),
    [period],
  );

  return (
    <div className="view-enter">
      <PageHead
        title="Operational Cockpit"
        subtitle={session?.tenant.name}
        actions={
          <Segmented
            value={period}
            onChange={setPeriod}
            options={recentPeriods().map((p) => ({ value: p, label: formatPeriod(p, locale) }))}
          />
        }
      />
      <ViewState state={state}>
        {(data) => (
          <div className="grid g-12">
            {/* RLS bukan sekadar disembunyikan di UI — ini pemberitahuan bahwa server
                memang membatasi data yang dikirim (SECURITY.md Bagian 5). */}
            {data.rlsApplied && (
              <div className="note info" style={{ gridColumn: 'span 12' }}>
                {t('ui.rls_active', { dimensions: data.rlsDimensions.join(', ') || '—' })}
              </div>
            )}

            {data.kpis.length === 0 ? (
              <Panel span="full">
                <EmptyState messageKey="empty.no_data" />
              </Panel>
            ) : (
              data.kpis.map((kpi) => (
                <Card className="kpi-card" key={kpi.id}>
                  <ThresholdRing score={kpi.score} status={kpi.status} />
                  <div className="kpi-meta">
                    <div className="name">{kpi.name}</div>
                    <div className="row mono">
                      {formatDecimal(kpi.value, locale, 2)} {kpi.unit ?? ''}
                      <StatusTag status={kpi.status} />
                    </div>
                    {/* Pengguna ber-RLS menerima angka SATU dimensi, bukan agregat
                        organisasi. Tanpa penanda ini keduanya tampak sama persis. */}
                    {kpi.dimensionScope !== null && (
                      <div className="row">{t('ui.scope_dimension', { scope: kpi.dimensionScope })}</div>
                    )}
                  </div>
                </Card>
              ))
            )}

            <Panel title="Alert Center" subtitle={t('status.active')} span="full">
              {data.openAlerts.length === 0 ? (
                <EmptyState messageKey="empty.no_alert" />
              ) : (
                data.openAlerts.map((alert) => (
                  <div className="feed-item" key={alert.id}>
                    <span
                      className="feed-dot"
                      style={{ background: alert.severity === 'critical' ? 'var(--bad)' : 'var(--warn)' }}
                    />
                    <div>
                      <div className="feed-text">
                        <b>{alert.label}</b>
                      </div>
                      <div className="feed-time">{new Date(alert.detectedAt).toLocaleString(locale === 'en' ? 'en-US' : 'id-ID')}</div>
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

interface Scorecard {
  compositeScore: number;
  perspectives: Array<{
    id: string;
    code: string;
    name: string;
    weight: number;
    score: number;
    objectives: Array<{
      id: string;
      name: string;
      ownerLabel: string | null;
      kpiName: string | null;
      achievement: number | null;
      status: string | null;
      initiatives: string[];
    }>;
  }>;
  comparison: { period: string; compositeScore: number } | null;
}

export function BalancedScorecardView(): JSX.Element {
  const { t, locale } = useApp();
  const period = currentPeriod();
  const previous = previousPeriod(period);
  const state = useAsync(() => api.get<Scorecard>(`/scorecard?period=${period}&compare=${previous}`), [period]);

  return (
    <div className="view-enter">
      <PageHead title="Balanced Scorecard" subtitle={formatPeriod(period, locale)} />
      <ViewState state={state}>
        {(data) => (
          <div className="grid g-12">
            <Card className="kpi-card" style={{ gridColumn: 'span 4' }}>
              <ThresholdRing score={data.compositeScore} />
              <div className="kpi-meta">
                <div className="name">{locale === 'id' ? 'Skor Komposit Organisasi' : 'Organisation Composite Score'}</div>
                <div className="row mono">
                  {data.comparison
                    ? `${formatPeriod(data.comparison.period, locale)}: ${formatDecimal(data.comparison.compositeScore, locale, 1)}`
                    : '—'}
                </div>
              </div>
            </Card>

            {data.perspectives.map((perspective) => (
              <Panel
                key={perspective.id}
                title={perspective.name}
                subtitle={`${t('table.score')} ${formatDecimal(perspective.score, locale, 1)} · ${locale === 'id' ? 'bobot' : 'weight'} ${formatDecimal(perspective.weight * 100, locale, 0)}%`}
                span="half"
              >
                {perspective.objectives.length === 0 ? (
                  <EmptyState messageKey="empty.no_data" />
                ) : (
                  <div className="table-scroll">
                    <table className="stack-mobile">
                      <thead>
                        <tr>
                          <th>{locale === 'id' ? 'Sasaran Strategis' : 'Strategic Objective'}</th>
                          <th>KPI Center</th>
                          <th>{t('table.score')}</th>
                          <th>{t('table.status')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {perspective.objectives.map((objective) => (
                          <tr key={objective.id}>
                            <td data-label={locale === 'id' ? 'Sasaran' : 'Objective'}>
                              {objective.name}
                              {objective.ownerLabel && <div className="sub">{objective.ownerLabel}</div>}
                            </td>
                            {/* KPI ditarik dari KPI Center — tidak ada definisi ganda (PRD 6.25). */}
                            <td data-label="KPI">{objective.kpiName ?? '—'}</td>
                            <td className="num" data-label={t('table.score')}>
                              {objective.achievement === null ? '—' : formatDecimal(objective.achievement, locale, 1)}
                            </td>
                            <td data-label={t('table.status')}>
                              {objective.status ? <StatusTag status={objective.status} /> : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            ))}

            <div className="note">{t('ui.certified_only_note')}</div>
          </div>
        )}
      </ViewState>
    </div>
  );
}

function recentPeriods(count = 3): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = count - 1; i >= 0; i--) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(date.toISOString().slice(0, 7));
  }
  return out;
}

function previousPeriod(period: string): string {
  const [year, month] = period.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 2, 1));
  return date.toISOString().slice(0, 7);
}
