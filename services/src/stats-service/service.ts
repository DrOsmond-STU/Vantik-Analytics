/**
 * Antarmuka stats-service ke aplikasi: mengambil data (dengan RLS), menjalankan
 * analisis deterministik, dan meng-cache hasil.
 *
 * Cache aman karena hasil deterministik (ARCHITECTURE.md Bagian 3) — kunci cache
 * adalah hash spesifikasi analisis, sehingga spesifikasi sama selalu memberi hasil
 * yang sama persis dan dapat diverifikasi ulang oleh auditor.
 */
import { newId, nowIso } from '../platform/db.ts';
import { sha256 } from '../platform/crypto.ts';
import { NotFoundError, ValidationError } from '../platform/errors.ts';
import type { RequestContext } from '../platform/context.ts';
import type { DatasetRow } from '../data-platform-service/dataQuality.ts';
import { boxPlot, describe, describeByGroup, histogram, qqPlot, toNumbers, type DescriptiveResult } from './descriptive.ts';
import {
  chiSquareGoodnessOfFit,
  chiSquareIndependence,
  independentTTest,
  kruskalWallis,
  mannWhitneyU,
  oneSampleTTest,
  oneWayAnova,
  pairedTTest,
  twoWayAnova,
  wilcoxonSignedRank,
  type Alpha,
  type Tails,
  type TestResult,
} from './hypothesis.ts';
import {
  correlationMatrix,
  linearRegression,
  logisticRegression,
  type CorrelationMatrix,
  type LinearRegressionResult,
  type LogisticRegressionResult,
} from './regression.ts';

export type HypothesisTestKind =
  | 'one_sample_t'
  | 'independent_t'
  | 'paired_t'
  | 'one_way_anova'
  | 'two_way_anova'
  | 'mann_whitney'
  | 'wilcoxon'
  | 'kruskal_wallis'
  | 'chi_square_independence'
  | 'chi_square_goodness_of_fit';

export interface DescriptiveSpec {
  datasetId: string;
  fields: string[];
  groupBy?: string;
}

export interface HypothesisSpec {
  datasetId: string;
  test: HypothesisTestKind;
  valueField?: string;
  groupField?: string;
  secondFactorField?: string;
  pairedWithField?: string;
  categoryFieldA?: string;
  categoryFieldB?: string;
  mu?: number;
  expectedProportions?: number[];
  alpha?: Alpha;
  tails?: Tails;
}

export interface RegressionSpec {
  datasetId: string;
  kind: 'linear' | 'logistic';
  responseField: string;
  predictorFields: string[];
}

export interface CorrelationSpec {
  datasetId: string;
  fields: string[];
  method?: 'pearson' | 'spearman' | 'kendall';
}

export interface DescriptiveOutput {
  perField: Array<{
    field: string;
    stats: DescriptiveResult;
    histogram: ReturnType<typeof histogram>;
    boxPlot: ReturnType<typeof boxPlot>;
    qqPlot: ReturnType<typeof qqPlot>;
  }>;
  byGroup?: Array<{ field: string; groups: Array<{ group: string; stats: DescriptiveResult }> }>;
  /** Sumber data & periode — transparansi wajib untuk laporan resmi (SECURITY.md 11). */
  source: { datasetId: string; datasetName: string; rowsAnalysed: number; generatedAt: string };
}

export class StatsService {
  constructor(private readonly ctx: RequestContext) {}

  private loadRows(datasetId: string): { rows: DatasetRow[]; name: string } {
    const dataset = this.ctx.db.get<{ id: string; name: string }>('dataset_catalog', { id: datasetId });
    if (!dataset) throw new NotFoundError();
    // RLS diterapkan di sisi server sebelum data masuk perhitungan apa pun.
    const rows = this.ctx.rls.filter(
      this.ctx.db
        .all<{ data_json: string }>('dataset_rows', { dataset_id: datasetId }, { orderBy: 'row_index' })
        .map((r) => JSON.parse(r.data_json) as DatasetRow),
    );
    return { rows, name: dataset.name };
  }

  private numericField(rows: DatasetRow[], field: string): number[] {
    const { numbers } = toNumbers(rows.map((r) => r[field]));
    if (numbers.length === 0) throw new ValidationError('error.field_not_numeric', { field });
    return numbers;
  }

  private cached<T>(kind: string, spec: object, compute: () => T): T {
    const specHash = sha256(`${kind}:${JSON.stringify(spec)}`);
    const hit = this.ctx.db.get<{ result_json: string }>('stat_analyses', { spec_hash: specHash });
    if (hit) return JSON.parse(hit.result_json) as T;

    const result = compute();
    this.ctx.db.insert('stat_analyses', {
      id: newId('sta'),
      dataset_id: (spec as { datasetId?: string }).datasetId ?? '',
      kind,
      spec_json: JSON.stringify(spec),
      spec_hash: specHash,
      result_json: JSON.stringify(result),
      created_at: nowIso(),
      created_by: this.ctx.actor.userId,
    });
    return result;
  }

  /* ---------------- Statistik Deskriptif — PRD 6.22 ---------------- */

  descriptive(spec: DescriptiveSpec): DescriptiveOutput {
    this.ctx.require('stats:run', { module: 'Statistik Deskriptif' });
    this.ctx.requireModule('descriptive_statistics');

    const { rows, name } = this.loadRows(spec.datasetId);

    const output = this.cached('descriptive', spec, () => {
      const perField = spec.fields.map((field) => {
        const values = this.numericField(rows, field);
        return {
          field,
          stats: describe(rows.map((r) => r[field])),
          histogram: histogram(values),
          boxPlot: boxPlot(values),
          qqPlot: qqPlot(values),
        };
      });

      const byGroup = spec.groupBy
        ? spec.fields.map((field) => ({
            field,
            groups: describeByGroup(rows, field, spec.groupBy!),
          }))
        : undefined;

      return {
        perField,
        byGroup,
        source: {
          datasetId: spec.datasetId,
          datasetName: name,
          rowsAnalysed: rows.length,
          generatedAt: nowIso(),
        },
      } satisfies DescriptiveOutput;
    });

    this.ctx.log({
      action: 'stats.descriptive',
      module: 'Statistik Deskriptif',
      objectType: 'dataset',
      objectId: spec.datasetId,
      objectLabel: name,
      detail: { fields: spec.fields, groupBy: spec.groupBy, rows: rows.length },
    });

    return output;
  }

  /* ---------------- Uji Hipotesis — PRD 6.23 ---------------- */

  hypothesis(spec: HypothesisSpec): TestResult | ReturnType<typeof twoWayAnova> {
    this.ctx.require('stats:run', { module: 'Uji Hipotesis' });
    this.ctx.requireModule('hypothesis_testing');

    const { rows, name } = this.loadRows(spec.datasetId);
    const alpha = spec.alpha ?? 0.05;
    const tails = spec.tails ?? 2;

    const result = this.cached('hypothesis', spec, () => {
      switch (spec.test) {
        case 'one_sample_t': {
          this.assertField(spec.valueField, 'valueField');
          if (spec.mu === undefined) throw new ValidationError('error.mu_required');
          return oneSampleTTest(this.numericField(rows, spec.valueField!), spec.mu, alpha, tails);
        }
        case 'independent_t':
        case 'mann_whitney': {
          const groups = this.twoGroups(rows, spec);
          return spec.test === 'independent_t'
            ? independentTTest(groups.a.values, groups.b.values, alpha, tails, {
                labels: [groups.a.label, groups.b.label],
              })
            : mannWhitneyU(groups.a.values, groups.b.values, alpha);
        }
        case 'paired_t':
        case 'wilcoxon': {
          this.assertField(spec.valueField, 'valueField');
          this.assertField(spec.pairedWithField, 'pairedWithField');
          const before = this.numericField(rows, spec.valueField!);
          const after = this.numericField(rows, spec.pairedWithField!);
          if (before.length !== after.length) throw new ValidationError('error.paired_length_mismatch');
          return spec.test === 'paired_t'
            ? pairedTTest(before, after, alpha, tails)
            : wilcoxonSignedRank(before, after, alpha);
        }
        case 'one_way_anova':
        case 'kruskal_wallis': {
          const labelled = this.groupedValues(rows, spec);
          if (labelled.length < 3 && spec.test === 'one_way_anova') {
            // Dua kelompok → t-test lebih tepat; peringatkan, jangan diam-diam jalan.
            throw new ValidationError('error.anova_needs_three_groups', { groups: labelled.length });
          }
          return spec.test === 'one_way_anova'
            ? oneWayAnova(labelled, alpha)
            : kruskalWallis(labelled, alpha);
        }
        case 'two_way_anova': {
          this.assertField(spec.valueField, 'valueField');
          this.assertField(spec.groupField, 'groupField');
          this.assertField(spec.secondFactorField, 'secondFactorField');
          const observations = rows
            .map((r) => ({
              a: String(r[spec.groupField!] ?? ''),
              b: String(r[spec.secondFactorField!] ?? ''),
              value: Number(r[spec.valueField!]),
            }))
            .filter((o) => Number.isFinite(o.value) && o.a !== '' && o.b !== '');
          return twoWayAnova(observations, alpha);
        }
        case 'chi_square_independence': {
          this.assertField(spec.categoryFieldA, 'categoryFieldA');
          this.assertField(spec.categoryFieldB, 'categoryFieldB');
          const { table, rowLabels, columnLabels } = crossTabulate(
            rows,
            spec.categoryFieldA!,
            spec.categoryFieldB!,
          );
          return chiSquareIndependence(table, rowLabels, columnLabels, alpha);
        }
        case 'chi_square_goodness_of_fit': {
          this.assertField(spec.categoryFieldA, 'categoryFieldA');
          const counts = new Map<string, number>();
          for (const row of rows) {
            const key = String(row[spec.categoryFieldA!] ?? '—');
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          const labels = [...counts.keys()].sort();
          const observed = labels.map((l) => counts.get(l)!);
          const expected =
            spec.expectedProportions ?? labels.map(() => 1 / labels.length); // default: seragam
          if (expected.length !== labels.length) {
            throw new ValidationError('error.expected_proportions_mismatch');
          }
          return chiSquareGoodnessOfFit(observed, expected, labels, alpha);
        }
        default:
          throw new ValidationError('error.unknown_test', { test: spec.test });
      }
    });

    this.ctx.log({
      action: 'stats.hypothesis',
      module: 'Uji Hipotesis',
      objectType: 'dataset',
      objectId: spec.datasetId,
      objectLabel: name,
      detail: { test: spec.test, alpha, tails, rows: rows.length },
    });

    return result;
  }

  private assertField(value: string | undefined, name: string): void {
    if (!value) throw new ValidationError('error.field_required', { field: name });
  }

  private twoGroups(
    rows: DatasetRow[],
    spec: HypothesisSpec,
  ): { a: { label: string; values: number[] }; b: { label: string; values: number[] } } {
    const groups = this.groupedValues(rows, spec);
    if (groups.length !== 2) throw new ValidationError('error.two_groups_required', { found: groups.length });
    return { a: groups[0]!, b: groups[1]! };
  }

  private groupedValues(rows: DatasetRow[], spec: HypothesisSpec): Array<{ label: string; values: number[] }> {
    this.assertField(spec.valueField, 'valueField');
    this.assertField(spec.groupField, 'groupField');
    const buckets = new Map<string, number[]>();
    for (const row of rows) {
      const label = String(row[spec.groupField!] ?? '—');
      const value = Number(row[spec.valueField!]);
      if (!Number.isFinite(value)) continue;
      if (!buckets.has(label)) buckets.set(label, []);
      buckets.get(label)!.push(value);
    }
    return [...buckets.entries()]
      .map(([label, values]) => ({ label, values }))
      .filter((g) => g.values.length >= 2)
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  /* ---------------- Regresi & Korelasi — PRD 6.24 ---------------- */

  correlation(spec: CorrelationSpec): CorrelationMatrix & { source: { datasetName: string; n: number } } {
    this.ctx.require('stats:run', { module: 'Regresi & Korelasi' });
    this.ctx.requireModule('regression_correlation');

    const { rows, name } = this.loadRows(spec.datasetId);

    const result = this.cached('correlation', spec, () => {
      // Hanya baris yang lengkap pada seluruh variabel (listwise deletion) —
      // metode penanganan data hilang dinyatakan eksplisit karena memengaruhi hasil.
      const complete = rows.filter((r) =>
        spec.fields.every((f) => r[f] !== null && r[f] !== undefined && Number.isFinite(Number(r[f]))),
      );
      const data: Record<string, number[]> = {};
      for (const field of spec.fields) data[field] = complete.map((r) => Number(r[field]));
      return {
        ...correlationMatrix(data, spec.method ?? 'pearson'),
        source: { datasetName: name, n: complete.length },
      };
    });

    this.ctx.log({
      action: 'stats.correlation',
      module: 'Regresi & Korelasi',
      objectType: 'dataset',
      objectId: spec.datasetId,
      objectLabel: name,
      detail: { fields: spec.fields, method: spec.method ?? 'pearson' },
    });

    return result;
  }

  regression(spec: RegressionSpec): (LinearRegressionResult | LogisticRegressionResult) & {
    source: { datasetName: string; n: number };
  } {
    this.ctx.require('stats:run', { module: 'Regresi & Korelasi' });
    this.ctx.requireModule('regression_correlation');

    const { rows, name } = this.loadRows(spec.datasetId);

    const result = this.cached('regression', spec, () => {
      const fields = [spec.responseField, ...spec.predictorFields];
      const complete = rows.filter((r) =>
        fields.every((f) => r[f] !== null && r[f] !== undefined && Number.isFinite(Number(r[f]))),
      );
      if (complete.length <= spec.predictorFields.length + 1) {
        throw new ValidationError('error.insufficient_observations', {
          rows: complete.length,
          predictors: spec.predictorFields.length,
        });
      }

      const predictors: Record<string, number[]> = {};
      for (const field of spec.predictorFields) predictors[field] = complete.map((r) => Number(r[field]));
      const response = complete.map((r) => Number(r[spec.responseField]));

      const model =
        spec.kind === 'linear'
          ? linearRegression(predictors, response, { responseName: spec.responseField })
          : logisticRegression(predictors, response as Array<0 | 1>, { responseName: spec.responseField });

      return { ...model, source: { datasetName: name, n: complete.length } };
    });

    this.ctx.log({
      action: 'stats.regression',
      module: 'Regresi & Korelasi',
      objectType: 'dataset',
      objectId: spec.datasetId,
      objectLabel: name,
      detail: { kind: spec.kind, response: spec.responseField, predictors: spec.predictorFields },
    });

    return result;
  }
}

/** Tabulasi silang dua variabel kategorik untuk uji Chi-Square. */
export function crossTabulate(
  rows: DatasetRow[],
  fieldA: string,
  fieldB: string,
): { table: number[][]; rowLabels: string[]; columnLabels: string[] } {
  const rowLabels = [...new Set(rows.map((r) => String(r[fieldA] ?? '—')))].sort();
  const columnLabels = [...new Set(rows.map((r) => String(r[fieldB] ?? '—')))].sort();
  const index = new Map(rowLabels.map((l, i) => [l, i]));
  const columnIndex = new Map(columnLabels.map((l, i) => [l, i]));

  const table = rowLabels.map(() => new Array<number>(columnLabels.length).fill(0));
  for (const row of rows) {
    const i = index.get(String(row[fieldA] ?? '—'))!;
    const j = columnIndex.get(String(row[fieldB] ?? '—'))!;
    table[i]![j]!++;
  }
  return { table, rowLabels, columnLabels };
}
