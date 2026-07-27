/**
 * presentation-service — Executive Cockpit (6.1), Operational Cockpit (6.2),
 * Balanced Scorecard (6.25).
 *
 * Layanan ini BACA-SAJA: mengagregasi dari semantic layer, tidak pernah menulis data
 * operasional (ARCHITECTURE.md Bagian 3).
 */
import { newId, nowIso } from '../platform/db.ts';
import { NotFoundError, ValidationError } from '../platform/errors.ts';
import type { RequestContext } from '../platform/context.ts';
import type { KpiDefinition, KpiScore, KpiStatus } from '../data-platform-service/kpi.ts';

export interface CockpitKpi {
  id: string;
  name: string;
  unit: string | null;
  score: number;
  value: number;
  target: number | null;
  status: KpiStatus;
  ownerLabel: string | null;
  trend: Array<{ period: string; score: number }>;
}

export interface ExecutiveCockpit {
  period: string;
  overallScore: number;
  kpis: CockpitKpi[];
  topRisks: Array<{ label: string; score: number; trendKey: 'rising' | 'stable' | 'falling' }>;
  /** Executive Cockpit HANYA menampilkan data dari dataset "Certified" (PRD 6.1). */
  certifiedOnly: true;
  excludedUncertifiedCount: number;
  generatedAt: string;
}

export class CockpitService {
  constructor(private readonly ctx: RequestContext) {}

  /**
   * Executive Cockpit — gambaran kinerja korporat lintas fungsi (PRD 6.1).
   * Susunan KPI dapat dikonfigurasi sesuai bidang organisasi; tidak ada metrik
   * yang ditanam di kode (PRD 3.1 — domain-agnostic).
   */
  executive(period: string): ExecutiveCockpit {
    this.ctx.require('executive_cockpit:read', { module: 'Executive Cockpit' });
    this.ctx.requireModule('executive_cockpit');
    if (!/^\d{4}-\d{2}$/.test(period)) throw new ValidationError('error.invalid_period');

    const allKpis = this.ctx.db.all<KpiDefinition>('kpi_definition');

    // Saring KPI yang bersumber dari dataset non-Certified.
    const certified = new Set(
      this.ctx.db
        .all<{ id: string }>('dataset_catalog', { certification: 'certified' })
        .map((d) => d.id),
    );
    const eligible = allKpis.filter((k) => k.dataset_id === null || certified.has(k.dataset_id));
    const excludedUncertifiedCount = allKpis.length - eligible.length;

    const kpis = eligible
      .map((kpi) => this.buildCockpitKpi(kpi, period))
      .filter((k): k is CockpitKpi => k !== null);

    const totalWeight = eligible.reduce((acc, k) => acc + (k.weight || 1), 0);
    const overallScore =
      kpis.length === 0
        ? 0
        : Number(
            (
              kpis.reduce((acc, k) => {
                const weight = eligible.find((e) => e.id === k.id)?.weight ?? 1;
                return acc + k.score * weight;
              }, 0) / Math.max(1, totalWeight)
            ).toFixed(2),
          );

    const topRisks = kpis
      .filter((k) => k.status !== 'on_track')
      .sort((a, b) => a.score - b.score)
      .slice(0, 8)
      .map((k) => {
        const [latest, previous] = k.trend.slice(-2).reverse();
        const trendKey: 'rising' | 'stable' | 'falling' =
          !latest || !previous
            ? 'stable'
            : latest.score > previous.score + 1
              ? 'falling' // skor naik → risiko turun
              : latest.score < previous.score - 1
                ? 'rising'
                : 'stable';
        return { label: k.name, score: k.score, trendKey };
      });

    this.ctx.log({
      action: 'cockpit.executive_view',
      module: 'Executive Cockpit',
      objectType: 'period',
      objectId: period,
      detail: { kpis: kpis.length, excludedUncertified: excludedUncertifiedCount },
    });

    return {
      period,
      overallScore,
      kpis,
      topRisks,
      certifiedOnly: true,
      excludedUncertifiedCount,
      generatedAt: nowIso(),
    };
  }

  /**
   * Operational Cockpit — data khusus per divisi (PRD 6.2).
   * Dibatasi Row-Level Security peran pengguna; tidak menuntut sertifikasi dataset
   * karena operasional harian sering memakai data yang masih berjalan.
   */
  operational(period: string, division?: string): {
    period: string;
    division: string | null;
    kpis: CockpitKpi[];
    openAlerts: Array<{ id: string; label: string; severity: string; detectedAt: string }>;
    rlsApplied: boolean;
    rlsDimensions: string[];
  } {
    this.ctx.require('operational_cockpit:read', { module: 'Operational Cockpit' });
    this.ctx.requireModule('operational_cockpit');

    const kpis = this.ctx.db
      .all<KpiDefinition>('kpi_definition')
      .map((kpi) => this.buildCockpitKpi(kpi, period, division))
      .filter((k): k is CockpitKpi => k !== null);

    const alerts = this.ctx.db
      .all<{ id: string; rule_id: string; severity: string; detected_at: string; acknowledged_at: string | null }>(
        'alert_events',
        { acknowledged_at: null },
        { orderBy: 'detected_at DESC', limit: 20 },
      )
      .map((event) => ({
        id: event.id,
        label: this.ctx.db.get<{ name: string }>('alert_rules', { id: event.rule_id })?.name ?? '—',
        severity: event.severity,
        detectedAt: event.detected_at,
      }));

    return {
      period,
      division: division ?? null,
      kpis,
      openAlerts: alerts,
      rlsApplied: !this.ctx.rls.isUnrestricted,
      rlsDimensions: this.ctx.rls.dimensions(),
    };
  }

  private buildCockpitKpi(kpi: KpiDefinition, period: string, dimensionKey?: string): CockpitKpi | null {
    const scores = this.ctx.db.all<KpiScore & { dimension_key: string | null }>(
      'kpi_score_history',
      { kpi_id: kpi.id },
      { orderBy: 'period DESC', limit: 120 },
    );

    // RLS: baris di luar cakupan pengguna tidak pernah masuk hasil.
    const permitted = scores.filter((row) => {
      if (dimensionKey && row.dimension_key !== dimensionKey) return false;
      if (this.ctx.rls.isUnrestricted) return true;
      if (row.dimension_key === null) return false; // agregat lintas dimensi disembunyikan
      const dimension = this.ctx.rls.dimensions()[0];
      return dimension ? this.ctx.rls.permits({ [dimension]: row.dimension_key }) : false;
    });

    const current = permitted.find((s) => s.period === period);
    if (!current) return null;

    const owner = kpi.owner_employee_id
      ? this.ctx.db.get<{ full_name: string; position: string }>('employee_master', { id: kpi.owner_employee_id })
      : undefined;

    return {
      id: kpi.id,
      name: kpi.name,
      unit: kpi.unit,
      score: current.score,
      value: current.value,
      target: kpi.target,
      status: current.status,
      ownerLabel: owner ? `${owner.full_name} · ${owner.position}` : null,
      trend: permitted
        .slice(0, 24)
        .reverse()
        .map((s) => ({ period: s.period, score: s.score })),
    };
  }
}

/* ------------------------------------------------------------------ */
/* Balanced Scorecard — PRD 6.25                                       */
/* ------------------------------------------------------------------ */

export interface BscPerspective {
  id: string;
  code: string;
  name: string;
  weight: number;
  scorecardLevel: string;
  score: number;
  objectives: Array<{
    id: string;
    name: string;
    ownerLabel: string | null;
    target: number | null;
    kpiId: string | null;
    kpiName: string | null;
    achievement: number | null;
    status: KpiStatus | null;
    initiatives: string[];
    /** Strategy Map: sasaran lain yang dipengaruhi sasaran ini. */
    causes: string[];
  }>;
}

export interface Scorecard {
  level: string;
  period: string;
  compositeScore: number;
  perspectives: BscPerspective[];
  comparison: { period: string; compositeScore: number } | null;
  certifiedOnly: true;
}

/** Empat perspektif standar BSC + kemampuan menambah perspektif kustom (PRD 6.25). */
export const STANDARD_PERSPECTIVES = [
  { code: 'financial', nameId: 'Financial', nameEn: 'Financial', weight: 0.3 },
  { code: 'customer', nameId: 'Customer', nameEn: 'Customer', weight: 0.25 },
  { code: 'internal_process', nameId: 'Internal Business Process', nameEn: 'Internal Business Process', weight: 0.25 },
  { code: 'learning_growth', nameId: 'Learning & Growth', nameEn: 'Learning & Growth', weight: 0.2 },
] as const;

export class BalancedScorecardService {
  constructor(private readonly ctx: RequestContext) {}

  /** Menyiapkan empat perspektif standar untuk tenant (idempoten). */
  seedStandardPerspectives(level: 'corporate' | 'division' = 'corporate', parentScorecard?: string): void {
    this.ctx.require('balanced_scorecard:read', { module: 'Balanced Scorecard' });
    this.ctx.requireModule('balanced_scorecard');
    this.ctx.requireWritable();

    STANDARD_PERSPECTIVES.forEach((perspective, index) => {
      const existing = this.ctx.db.get('bsc_perspectives', {
        code: perspective.code,
        scorecard_level: level,
      });
      if (existing) return;
      this.ctx.db.insert('bsc_perspectives', {
        id: newId('bsp'),
        code: perspective.code,
        name: perspective.nameEn,
        weight: perspective.weight,
        sort_order: index,
        scorecard_level: level,
        parent_scorecard: parentScorecard ?? null,
      });
    });
  }

  addPerspective(input: { code: string; name: string; weight: number; level?: 'corporate' | 'division' }): { id: string } {
    this.ctx.require('balanced_scorecard:read', { module: 'Balanced Scorecard' });
    this.ctx.requireWritable();

    const id = newId('bsp');
    this.ctx.db.insert('bsc_perspectives', {
      id,
      code: input.code,
      name: input.name,
      weight: input.weight,
      sort_order: this.ctx.db.count('bsc_perspectives'),
      scorecard_level: input.level ?? 'corporate',
      parent_scorecard: null,
    });

    this.ctx.log({
      action: 'bsc.perspective_added',
      module: 'Balanced Scorecard',
      objectType: 'bsc_perspective',
      objectId: id,
      objectLabel: input.name,
      detail: { code: input.code, weight: input.weight },
    });
    return { id };
  }

  /**
   * Menambah sasaran strategis. `kpiId` WAJIB merujuk KPI Center — tidak ada definisi
   * KPI ganda/terpisah, sehingga skor selalu konsisten dengan modul lain (PRD 6.25).
   */
  addObjective(input: {
    perspectiveId: string;
    name: string;
    kpiId?: string;
    ownerEmployeeId?: string;
    target?: number;
    initiatives?: string[];
    causes?: string[];
  }): { id: string } {
    this.ctx.require('balanced_scorecard:read', { module: 'Balanced Scorecard' });
    this.ctx.requireWritable();

    if (!this.ctx.db.get('bsc_perspectives', { id: input.perspectiveId })) throw new NotFoundError();
    if (input.kpiId && !this.ctx.db.get('kpi_definition', { id: input.kpiId })) {
      throw new ValidationError('error.kpi_unknown');
    }

    const id = newId('bso');
    this.ctx.db.insert('bsc_objectives', {
      id,
      perspective_id: input.perspectiveId,
      name: input.name,
      owner_employee_id: input.ownerEmployeeId ?? null,
      target: input.target ?? null,
      kpi_id: input.kpiId ?? null,
      initiatives_json: JSON.stringify(input.initiatives ?? []),
      causes_json: JSON.stringify(input.causes ?? []),
    });

    this.ctx.log({
      action: 'bsc.objective_added',
      module: 'Balanced Scorecard',
      objectType: 'bsc_objective',
      objectId: id,
      objectLabel: input.name,
      detail: { perspectiveId: input.perspectiveId, kpiId: input.kpiId },
    });
    return { id };
  }

  /** Scorecard lengkap dengan skor komposit tertimbang (PRD 6.25). */
  scorecard(period: string, options: { level?: 'corporate' | 'division'; comparePeriod?: string } = {}): Scorecard {
    this.ctx.require('balanced_scorecard:read', { module: 'Balanced Scorecard' });
    this.ctx.requireModule('balanced_scorecard');

    const level = options.level ?? 'corporate';
    const certified = new Set(
      this.ctx.db.all<{ id: string }>('dataset_catalog', { certification: 'certified' }).map((d) => d.id),
    );

    const perspectiveRows = this.ctx.db.all<{
      id: string;
      code: string;
      name: string;
      weight: number;
      scorecard_level: string;
    }>('bsc_perspectives', { scorecard_level: level }, { orderBy: 'sort_order' });

    const perspectives: BscPerspective[] = perspectiveRows.map((p) => {
      const objectiveRows = this.ctx.db.all<{
        id: string;
        name: string;
        owner_employee_id: string | null;
        target: number | null;
        kpi_id: string | null;
        initiatives_json: string;
        causes_json: string;
      }>('bsc_objectives', { perspective_id: p.id });

      const objectives = objectiveRows.map((o) => {
        const kpi = o.kpi_id ? this.ctx.db.get<KpiDefinition>('kpi_definition', { id: o.kpi_id }) : undefined;
        // Sama seperti Executive Cockpit: hanya dataset Certified (PRD 6.25).
        const eligible = !kpi || kpi.dataset_id === null || certified.has(kpi.dataset_id);
        const score = eligible && kpi
          ? this.ctx.db.get<KpiScore>('kpi_score_history', {
              kpi_id: kpi.id,
              period,
              dimension_key: null,
            })
          : undefined;

        const owner = o.owner_employee_id
          ? this.ctx.db.get<{ full_name: string; position: string }>('employee_master', { id: o.owner_employee_id })
          : undefined;

        return {
          id: o.id,
          name: o.name,
          ownerLabel: owner ? `${owner.full_name} · ${owner.position}` : null,
          target: o.target,
          kpiId: o.kpi_id,
          kpiName: kpi?.name ?? null,
          achievement: score?.score ?? null,
          status: (score?.status as KpiStatus) ?? null,
          initiatives: JSON.parse(o.initiatives_json) as string[],
          causes: JSON.parse(o.causes_json) as string[],
        };
      });

      const scored = objectives.filter((o) => o.achievement !== null);
      const score =
        scored.length === 0
          ? 0
          : Number((scored.reduce((acc, o) => acc + (o.achievement ?? 0), 0) / scored.length).toFixed(2));

      return {
        id: p.id,
        code: p.code,
        name: p.name,
        weight: p.weight,
        scorecardLevel: p.scorecard_level,
        score,
        objectives,
      };
    });

    const totalWeight = perspectives.reduce((acc, p) => acc + p.weight, 0) || 1;
    const compositeScore = Number(
      (perspectives.reduce((acc, p) => acc + p.score * p.weight, 0) / totalWeight).toFixed(2),
    );

    let comparison: Scorecard['comparison'] = null;
    if (options.comparePeriod) {
      const previous = this.scorecardCompositeOnly(options.comparePeriod, level);
      comparison = { period: options.comparePeriod, compositeScore: previous };
    }

    return { level, period, compositeScore, perspectives, comparison, certifiedOnly: true };
  }

  private scorecardCompositeOnly(period: string, level: string): number {
    const perspectiveRows = this.ctx.db.all<{ id: string; weight: number }>('bsc_perspectives', {
      scorecard_level: level,
    });
    let weighted = 0;
    let totalWeight = 0;
    for (const p of perspectiveRows) {
      const objectives = this.ctx.db.all<{ kpi_id: string | null }>('bsc_objectives', { perspective_id: p.id });
      const scores = objectives
        .map((o) =>
          o.kpi_id
            ? this.ctx.db.get<KpiScore>('kpi_score_history', { kpi_id: o.kpi_id, period, dimension_key: null })
            : undefined,
        )
        .filter((s): s is KpiScore => Boolean(s));
      if (scores.length === 0) continue;
      const score = scores.reduce((acc, s) => acc + s.score, 0) / scores.length;
      weighted += score * p.weight;
      totalWeight += p.weight;
    }
    return totalWeight === 0 ? 0 : Number((weighted / totalWeight).toFixed(2));
  }

  /**
   * Strategy Map — visualisasi hubungan sebab-akibat antar-sasaran strategis
   * lintas perspektif (PRD 6.25).
   */
  strategyMap(level: 'corporate' | 'division' = 'corporate'): {
    nodes: Array<{ id: string; name: string; perspective: string; achievement: number | null }>;
    edges: Array<{ from: string; to: string }>;
  } {
    this.ctx.require('balanced_scorecard:read', { module: 'Balanced Scorecard' });

    const card = this.scorecard(new Date().toISOString().slice(0, 7), { level });
    const nodes = card.perspectives.flatMap((p) =>
      p.objectives.map((o) => ({
        id: o.id,
        name: o.name,
        perspective: p.code,
        achievement: o.achievement,
      })),
    );
    const edges = card.perspectives.flatMap((p) =>
      p.objectives.flatMap((o) => o.causes.map((target) => ({ from: o.id, to: target }))),
    );
    return { nodes, edges };
  }

  /**
   * Cascading: menurunkan scorecard korporat menjadi scorecard divisi,
   * dengan keterkaitan yang terlihat jelas (PRD 6.25).
   */
  cascade(parentPerspectiveId: string, divisionName: string): { created: number } {
    this.ctx.require('balanced_scorecard:read', { module: 'Balanced Scorecard' });
    this.ctx.requireWritable();

    const parent = this.ctx.db.get<{ id: string; code: string; name: string; weight: number }>(
      'bsc_perspectives',
      { id: parentPerspectiveId },
    );
    if (!parent) throw new NotFoundError();

    const id = newId('bsp');
    this.ctx.db.insert('bsc_perspectives', {
      id,
      code: `${parent.code}_${divisionName.toLowerCase().replace(/\s+/g, '_')}`,
      name: `${parent.name} — ${divisionName}`,
      weight: parent.weight,
      sort_order: this.ctx.db.count('bsc_perspectives'),
      scorecard_level: 'division',
      parent_scorecard: parentPerspectiveId,
    });

    this.ctx.log({
      action: 'bsc.cascaded',
      module: 'Balanced Scorecard',
      objectType: 'bsc_perspective',
      objectId: id,
      objectLabel: divisionName,
      detail: { parentPerspectiveId },
    });

    return { created: 1 };
  }
}
