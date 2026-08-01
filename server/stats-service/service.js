"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StatsService = void 0;
exports.crossTabulate = crossTabulate;
/**
 * Antarmuka stats-service ke aplikasi: mengambil data (dengan RLS), menjalankan
 * analisis deterministik, dan meng-cache hasil.
 *
 * Cache aman karena hasil deterministik (ARCHITECTURE.md Bagian 3) — kunci cache
 * adalah hash spesifikasi analisis, sehingga spesifikasi sama selalu memberi hasil
 * yang sama persis dan dapat diverifikasi ulang oleh auditor.
 */
const db_ts_1 = require("../platform/db.js");
const crypto_ts_1 = require("../platform/crypto.js");
const errors_ts_1 = require("../platform/errors.js");
const descriptive_ts_1 = require("./descriptive.js");
const hypothesis_ts_1 = require("./hypothesis.js");
const regression_ts_1 = require("./regression.js");
class StatsService {
    ctx;
    constructor(ctx) {
        this.ctx = ctx;
    }
    loadRows(datasetId) {
        const dataset = this.ctx.db.get('dataset_catalog', { id: datasetId });
        if (!dataset)
            throw new errors_ts_1.NotFoundError();
        // RLS diterapkan di sisi server sebelum data masuk perhitungan apa pun.
        const rows = this.ctx.rls.filter(this.ctx.db
            .all('dataset_rows', { dataset_id: datasetId }, { orderBy: 'row_index' })
            .map((r) => JSON.parse(r.data_json)));
        return { rows, name: dataset.name };
    }
    numericField(rows, field) {
        const { numbers } = (0, descriptive_ts_1.toNumbers)(rows.map((r) => r[field]));
        if (numbers.length === 0)
            throw new errors_ts_1.ValidationError('error.field_not_numeric', { field });
        return numbers;
    }
    /**
     * Bentuk kanonik cakupan RLS pemanggil, untuk dijadikan bagian kunci cache.
     *
     * Dinormalisasi (huruf kecil, nilai terurut, aturan terurut) supaya dua pengguna
     * dengan cakupan efektif SAMA tetap berbagi cache — tanpa itu cache akan terpecah
     * per pengguna dan kehilangan gunanya. Huruf kecil sejalan dengan `RlsScope.permits()`
     * yang juga membandingkan tanpa memedulikan besar-kecil huruf.
     */
    rlsCacheKey() {
        const rules = this.ctx.rls.toJSON();
        if (rules.length === 0)
            return '*';
        return rules
            .map((rule) => JSON.stringify({
            d: rule.dimension.toLowerCase(),
            o: rule.operator,
            v: [...rule.values].map((v) => v.toLowerCase()).sort(),
        }))
            .sort()
            .join('|');
    }
    /**
     * Cache hasil analisis.
     *
     * Aman karena hasilnya deterministik — TETAPI kuncinya wajib memuat cakupan RLS
     * pemanggil, bukan hanya spesifikasi analisis. Dua pengguna dapat mengirim
     * spesifikasi yang identik dan tetap berhak atas HIMPUNAN BARIS yang berbeda.
     *
     * Tanpa cakupan di dalam kunci, hasil pertama yang tersimpan akan disajikan kepada
     * siapa pun yang mengirim spesifikasi sama: administrator tanpa batas menghitung
     * rata-rata seluruh wilayah, lalu analis yang hanya berhak atas satu wilayah
     * menerimanya utuh. Tidak satu baris pun dikembalikan, namun agregatnya tetap
     * membocorkan wilayah yang tidak boleh ia lihat — dan `loadRows()` yang menerapkan
     * RLS tidak pernah dijalankan pada cache hit (SECURITY.md Bagian 5, TESTING.md Bagian 4).
     */
    cached(kind, spec, compute) {
        const rlsScope = this.rlsCacheKey();
        const specHash = (0, crypto_ts_1.sha256)(`${kind}:${JSON.stringify(spec)}:rls=${rlsScope}`);
        const hit = this.ctx.db.get('stat_analyses', { spec_hash: specHash });
        if (hit)
            return JSON.parse(hit.result_json);
        const result = compute();
        this.ctx.db.insert('stat_analyses', {
            id: (0, db_ts_1.newId)('sta'),
            dataset_id: spec.datasetId ?? '',
            kind,
            spec_json: JSON.stringify(spec),
            spec_hash: specHash,
            // Disimpan agar barisnya dapat dijelaskan sendiri: spec_json yang sama dengan
            // hasil berbeda bukan tanda kerusakan, melainkan cakupan yang berbeda.
            rls_scope_json: JSON.stringify(this.ctx.rls.toJSON()),
            result_json: JSON.stringify(result),
            created_at: (0, db_ts_1.nowIso)(),
            created_by: this.ctx.actor.userId,
        });
        return result;
    }
    /* ---------------- Statistik Deskriptif — PRD 6.22 ---------------- */
    descriptive(spec) {
        this.ctx.require('stats:run', { module: 'Statistik Deskriptif' });
        this.ctx.requireModule('descriptive_statistics');
        const { rows, name } = this.loadRows(spec.datasetId);
        const output = this.cached('descriptive', spec, () => {
            const perField = spec.fields.map((field) => {
                const values = this.numericField(rows, field);
                return {
                    field,
                    stats: (0, descriptive_ts_1.describe)(rows.map((r) => r[field])),
                    histogram: (0, descriptive_ts_1.histogram)(values),
                    boxPlot: (0, descriptive_ts_1.boxPlot)(values),
                    qqPlot: (0, descriptive_ts_1.qqPlot)(values),
                };
            });
            const byGroup = spec.groupBy
                ? spec.fields.map((field) => ({
                    field,
                    groups: (0, descriptive_ts_1.describeByGroup)(rows, field, spec.groupBy),
                }))
                : undefined;
            return {
                perField,
                byGroup,
                source: {
                    datasetId: spec.datasetId,
                    datasetName: name,
                    rowsAnalysed: rows.length,
                    generatedAt: (0, db_ts_1.nowIso)(),
                },
            };
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
    hypothesis(spec) {
        this.ctx.require('stats:run', { module: 'Uji Hipotesis' });
        this.ctx.requireModule('hypothesis_testing');
        const { rows, name } = this.loadRows(spec.datasetId);
        const alpha = spec.alpha ?? 0.05;
        const tails = spec.tails ?? 2;
        const result = this.cached('hypothesis', spec, () => {
            switch (spec.test) {
                case 'one_sample_t': {
                    this.assertField(spec.valueField, 'valueField');
                    if (spec.mu === undefined)
                        throw new errors_ts_1.ValidationError('error.mu_required');
                    return (0, hypothesis_ts_1.oneSampleTTest)(this.numericField(rows, spec.valueField), spec.mu, alpha, tails);
                }
                case 'independent_t':
                case 'mann_whitney': {
                    const groups = this.twoGroups(rows, spec);
                    return spec.test === 'independent_t'
                        ? (0, hypothesis_ts_1.independentTTest)(groups.a.values, groups.b.values, alpha, tails, {
                            labels: [groups.a.label, groups.b.label],
                        })
                        : (0, hypothesis_ts_1.mannWhitneyU)(groups.a.values, groups.b.values, alpha);
                }
                case 'paired_t':
                case 'wilcoxon': {
                    this.assertField(spec.valueField, 'valueField');
                    this.assertField(spec.pairedWithField, 'pairedWithField');
                    const before = this.numericField(rows, spec.valueField);
                    const after = this.numericField(rows, spec.pairedWithField);
                    if (before.length !== after.length)
                        throw new errors_ts_1.ValidationError('error.paired_length_mismatch');
                    return spec.test === 'paired_t'
                        ? (0, hypothesis_ts_1.pairedTTest)(before, after, alpha, tails)
                        : (0, hypothesis_ts_1.wilcoxonSignedRank)(before, after, alpha);
                }
                case 'one_way_anova':
                case 'kruskal_wallis': {
                    const labelled = this.groupedValues(rows, spec);
                    if (labelled.length < 3 && spec.test === 'one_way_anova') {
                        // Dua kelompok → t-test lebih tepat; peringatkan, jangan diam-diam jalan.
                        throw new errors_ts_1.ValidationError('error.anova_needs_three_groups', { groups: labelled.length });
                    }
                    return spec.test === 'one_way_anova'
                        ? (0, hypothesis_ts_1.oneWayAnova)(labelled, alpha)
                        : (0, hypothesis_ts_1.kruskalWallis)(labelled, alpha);
                }
                case 'two_way_anova': {
                    this.assertField(spec.valueField, 'valueField');
                    this.assertField(spec.groupField, 'groupField');
                    this.assertField(spec.secondFactorField, 'secondFactorField');
                    const observations = rows
                        .map((r) => ({
                        a: String(r[spec.groupField] ?? ''),
                        b: String(r[spec.secondFactorField] ?? ''),
                        value: Number(r[spec.valueField]),
                    }))
                        .filter((o) => Number.isFinite(o.value) && o.a !== '' && o.b !== '');
                    return (0, hypothesis_ts_1.twoWayAnova)(observations, alpha);
                }
                case 'chi_square_independence': {
                    this.assertField(spec.categoryFieldA, 'categoryFieldA');
                    this.assertField(spec.categoryFieldB, 'categoryFieldB');
                    const { table, rowLabels, columnLabels } = crossTabulate(rows, spec.categoryFieldA, spec.categoryFieldB);
                    return (0, hypothesis_ts_1.chiSquareIndependence)(table, rowLabels, columnLabels, alpha);
                }
                case 'chi_square_goodness_of_fit': {
                    this.assertField(spec.categoryFieldA, 'categoryFieldA');
                    const counts = new Map();
                    for (const row of rows) {
                        const key = String(row[spec.categoryFieldA] ?? '—');
                        counts.set(key, (counts.get(key) ?? 0) + 1);
                    }
                    const labels = [...counts.keys()].sort();
                    const observed = labels.map((l) => counts.get(l));
                    const expected = spec.expectedProportions ?? labels.map(() => 1 / labels.length); // default: seragam
                    if (expected.length !== labels.length) {
                        throw new errors_ts_1.ValidationError('error.expected_proportions_mismatch');
                    }
                    return (0, hypothesis_ts_1.chiSquareGoodnessOfFit)(observed, expected, labels, alpha);
                }
                default:
                    throw new errors_ts_1.ValidationError('error.unknown_test', { test: spec.test });
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
    assertField(value, name) {
        if (!value)
            throw new errors_ts_1.ValidationError('error.field_required', { field: name });
    }
    twoGroups(rows, spec) {
        const groups = this.groupedValues(rows, spec);
        if (groups.length !== 2)
            throw new errors_ts_1.ValidationError('error.two_groups_required', { found: groups.length });
        return { a: groups[0], b: groups[1] };
    }
    groupedValues(rows, spec) {
        this.assertField(spec.valueField, 'valueField');
        this.assertField(spec.groupField, 'groupField');
        const buckets = new Map();
        for (const row of rows) {
            const label = String(row[spec.groupField] ?? '—');
            const value = Number(row[spec.valueField]);
            if (!Number.isFinite(value))
                continue;
            if (!buckets.has(label))
                buckets.set(label, []);
            buckets.get(label).push(value);
        }
        return [...buckets.entries()]
            .map(([label, values]) => ({ label, values }))
            .filter((g) => g.values.length >= 2)
            .sort((a, b) => a.label.localeCompare(b.label));
    }
    /* ---------------- Regresi & Korelasi — PRD 6.24 ---------------- */
    correlation(spec) {
        this.ctx.require('stats:run', { module: 'Regresi & Korelasi' });
        this.ctx.requireModule('regression_correlation');
        const { rows, name } = this.loadRows(spec.datasetId);
        const result = this.cached('correlation', spec, () => {
            // Hanya baris yang lengkap pada seluruh variabel (listwise deletion) —
            // metode penanganan data hilang dinyatakan eksplisit karena memengaruhi hasil.
            const complete = rows.filter((r) => spec.fields.every((f) => r[f] !== null && r[f] !== undefined && Number.isFinite(Number(r[f]))));
            const data = {};
            for (const field of spec.fields)
                data[field] = complete.map((r) => Number(r[field]));
            return {
                ...(0, regression_ts_1.correlationMatrix)(data, spec.method ?? 'pearson'),
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
    regression(spec) {
        this.ctx.require('stats:run', { module: 'Regresi & Korelasi' });
        this.ctx.requireModule('regression_correlation');
        const { rows, name } = this.loadRows(spec.datasetId);
        const result = this.cached('regression', spec, () => {
            const fields = [spec.responseField, ...spec.predictorFields];
            const complete = rows.filter((r) => fields.every((f) => r[f] !== null && r[f] !== undefined && Number.isFinite(Number(r[f]))));
            if (complete.length <= spec.predictorFields.length + 1) {
                throw new errors_ts_1.ValidationError('error.insufficient_observations', {
                    rows: complete.length,
                    predictors: spec.predictorFields.length,
                });
            }
            const predictors = {};
            for (const field of spec.predictorFields)
                predictors[field] = complete.map((r) => Number(r[field]));
            const response = complete.map((r) => Number(r[spec.responseField]));
            const model = spec.kind === 'linear'
                ? (0, regression_ts_1.linearRegression)(predictors, response, { responseName: spec.responseField })
                : (0, regression_ts_1.logisticRegression)(predictors, response, { responseName: spec.responseField });
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
exports.StatsService = StatsService;
/** Tabulasi silang dua variabel kategorik untuk uji Chi-Square. */
function crossTabulate(rows, fieldA, fieldB) {
    const rowLabels = [...new Set(rows.map((r) => String(r[fieldA] ?? '—')))].sort();
    const columnLabels = [...new Set(rows.map((r) => String(r[fieldB] ?? '—')))].sort();
    const index = new Map(rowLabels.map((l, i) => [l, i]));
    const columnIndex = new Map(columnLabels.map((l, i) => [l, i]));
    const table = rowLabels.map(() => new Array(columnLabels.length).fill(0));
    for (const row of rows) {
        const i = index.get(String(row[fieldA] ?? '—'));
        const j = columnIndex.get(String(row[fieldB] ?? '—'));
        table[i][j]++;
    }
    return { table, rowLabels, columnLabels };
}
//# sourceMappingURL=service.js.map