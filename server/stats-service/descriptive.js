"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toNumbers = toNumbers;
exports.mean = mean;
exports.variance = variance;
exports.stdDev = stdDev;
exports.median = median;
exports.mode = mode;
exports.quantile = quantile;
exports.skewness = skewness;
exports.kurtosis = kurtosis;
exports.describe = describe;
exports.histogram = histogram;
exports.boxPlot = boxPlot;
exports.qqPlot = qqPlot;
exports.describeByGroup = describeByGroup;
/**
 * Statistik Deskriptif — PRD 6.22.
 */
const distributions_ts_1 = require("./distributions.js");
function toNumbers(values) {
    const numbers = [];
    let missing = 0;
    for (const v of values) {
        if (v === null || v === undefined || v === '') {
            missing++;
            continue;
        }
        const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
        if (Number.isFinite(n))
            numbers.push(n);
        else
            missing++;
    }
    return { numbers, missing };
}
function mean(values) {
    if (values.length === 0)
        return NaN;
    return values.reduce((a, b) => a + b, 0) / values.length;
}
/** Varians sampel (pembagi n−1) — konvensi untuk data sampel, bukan populasi. */
function variance(values) {
    if (values.length < 2)
        return NaN;
    const m = mean(values);
    return values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1);
}
function stdDev(values) {
    return Math.sqrt(variance(values));
}
function median(values) {
    if (values.length === 0)
        return NaN;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
function mode(values) {
    if (values.length === 0)
        return [];
    const counts = new Map();
    for (const v of values)
        counts.set(v, (counts.get(v) ?? 0) + 1);
    const max = Math.max(...counts.values());
    if (max === 1)
        return []; // semua nilai unik → tidak ada modus
    return [...counts.entries()].filter(([, n]) => n === max).map(([v]) => v).sort((a, b) => a - b);
}
/**
 * Kuantil dengan interpolasi linier (metode 7 / definisi R default).
 * Metode dinyatakan eksplisit karena hasil kuartil berbeda antar-metode, dan output
 * ini dipakai untuk laporan resmi (PRD Domain 4).
 */
function quantile(values, p) {
    if (values.length === 0)
        return NaN;
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length === 1)
        return sorted[0];
    const h = (sorted.length - 1) * p;
    const lower = Math.floor(h);
    const upper = Math.ceil(h);
    if (lower === upper)
        return sorted[lower];
    return sorted[lower] + (h - lower) * (sorted[upper] - sorted[lower]);
}
/** Skewness sampel (G1, koreksi Fisher-Pearson yang disesuaikan). */
function skewness(values) {
    const n = values.length;
    if (n < 3)
        return NaN;
    const m = mean(values);
    const s = stdDev(values);
    if (s === 0)
        return 0;
    const sum = values.reduce((acc, v) => acc + ((v - m) / s) ** 3, 0);
    return (n / ((n - 1) * (n - 2))) * sum;
}
/** Excess kurtosis sampel (G2). Nilai 0 = sama runcingnya dengan distribusi normal. */
function kurtosis(values) {
    const n = values.length;
    if (n < 4)
        return NaN;
    const m = mean(values);
    const s = stdDev(values);
    if (s === 0)
        return 0;
    const sum = values.reduce((acc, v) => acc + ((v - m) / s) ** 4, 0);
    const g2 = ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * sum;
    return g2 - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
}
function describe(rawValues) {
    const { numbers, missing } = toNumbers(rawValues);
    const n = numbers.length;
    const m = mean(numbers);
    const v = variance(numbers);
    const sd = Math.sqrt(v);
    const se = n > 0 ? sd / Math.sqrt(n) : NaN;
    const q1 = quantile(numbers, 0.25);
    const q3 = quantile(numbers, 0.75);
    const min = n > 0 ? Math.min(...numbers) : NaN;
    const max = n > 0 ? Math.max(...numbers) : NaN;
    const z = (0, distributions_ts_1.normalQuantile)(0.975);
    return {
        n,
        missing,
        distinct: new Set(numbers).size,
        mean: m,
        median: median(numbers),
        mode: mode(numbers),
        stdDev: sd,
        variance: v,
        min,
        max,
        range: max - min,
        q1,
        q3,
        iqr: q3 - q1,
        skewness: skewness(numbers),
        kurtosis: kurtosis(numbers),
        sum: numbers.reduce((a, b) => a + b, 0),
        standardError: se,
        confidenceInterval95: [m - z * se, m + z * se],
    };
}
/** Histogram dengan lebar bin aturan Freedman–Diaconis (tahan terhadap outlier). */
function histogram(values, binCount) {
    if (values.length === 0)
        return [];
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (min === max)
        return [{ from: min, to: max, count: values.length }];
    let bins = binCount;
    if (!bins) {
        const iqr = quantile(values, 0.75) - quantile(values, 0.25);
        const width = iqr > 0 ? (2 * iqr) / Math.cbrt(values.length) : 0;
        bins = width > 0 ? Math.ceil((max - min) / width) : Math.ceil(Math.sqrt(values.length));
        bins = Math.max(1, Math.min(50, bins));
    }
    const width = (max - min) / bins;
    const result = Array.from({ length: bins }, (_, i) => ({
        from: min + i * width,
        to: min + (i + 1) * width,
        count: 0,
    }));
    for (const v of values) {
        const index = Math.min(bins - 1, Math.floor((v - min) / width));
        result[index].count++;
    }
    return result;
}
/** Box plot dengan aturan pagar 1.5×IQR. */
function boxPlot(values) {
    const q1 = quantile(values, 0.25);
    const q3 = quantile(values, 0.75);
    const iqr = q3 - q1;
    const lowerFence = q1 - 1.5 * iqr;
    const upperFence = q3 + 1.5 * iqr;
    const inliers = values.filter((v) => v >= lowerFence && v <= upperFence);
    return {
        min: inliers.length ? Math.min(...inliers) : q1,
        q1,
        median: median(values),
        q3,
        max: inliers.length ? Math.max(...inliers) : q3,
        outliers: values.filter((v) => v < lowerFence || v > upperFence).sort((a, b) => a - b),
    };
}
/** Q-Q plot untuk pemeriksaan normalitas (PRD 6.22). */
function qqPlot(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    if (n === 0)
        return [];
    const m = mean(sorted);
    const s = stdDev(sorted);
    return sorted.map((sample, i) => ({
        // Posisi plotting Blom
        theoretical: (0, distributions_ts_1.normalQuantile)((i + 1 - 0.375) / (n + 0.25)),
        sample: s > 0 ? (sample - m) / s : 0,
    }));
}
/** Analisis terpisah per kelompok (group by) — PRD 6.22. */
function describeByGroup(rows, valueField, groupField) {
    const groups = new Map();
    for (const row of rows) {
        const key = row[groupField] === null || row[groupField] === undefined ? '—' : String(row[groupField]);
        if (!groups.has(key))
            groups.set(key, []);
        groups.get(key).push(row[valueField]);
    }
    return [...groups.entries()]
        .map(([group, values]) => ({ group, stats: describe(values) }))
        .sort((a, b) => a.group.localeCompare(b.group));
}
//# sourceMappingURL=descriptive.js.map