"use strict";
/**
 * Fungsi distribusi probabilitas.
 *
 * ARCHITECTURE.md Bagian 3 & 11 menuntut `stats-service` DETERMINISTIK dan dapat
 * diaudit: input sama → output sama persis. Karena itu seluruh fungsi di sini murni,
 * tanpa keacakan, tanpa keadaan tersimpan, dan tanpa ketergantungan eksternal.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.logGamma = logGamma;
exports.logBeta = logBeta;
exports.incompleteBeta = incompleteBeta;
exports.lowerIncompleteGamma = lowerIncompleteGamma;
exports.erf = erf;
exports.normalCdf = normalCdf;
exports.normalQuantile = normalQuantile;
exports.studentTCdf = studentTCdf;
exports.tTestPValue = tTestPValue;
exports.studentTQuantile = studentTQuantile;
exports.chiSquareCdf = chiSquareCdf;
exports.chiSquarePValue = chiSquarePValue;
exports.fCdf = fCdf;
exports.fTestPValue = fTestPValue;
exports.tukeyCriticalQ = tukeyCriticalQ;
/** Fungsi gamma-log (Lanczos). Akurat ~15 digit untuk x > 0. */
function logGamma(x) {
    const coefficients = [
        676.5203681218851, -1259.1392167224028, 771.32342877765313,
        -176.61502916214059, 12.507343278686905, -0.13857109526572012,
        9.9843695780195716e-6, 1.5056327351493116e-7,
    ];
    if (x < 0.5) {
        // Refleksi Euler
        return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
    }
    const z = x - 1;
    let a = 0.99999999999980993;
    const t = z + 7.5;
    for (let i = 0; i < coefficients.length; i++)
        a += coefficients[i] / (z + i + 1);
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}
function logBeta(a, b) {
    return logGamma(a) + logGamma(b) - logGamma(a + b);
}
/** Fungsi beta tak lengkap teregularisasi I_x(a,b) — fraksi berlanjut Lentz. */
function incompleteBeta(x, a, b) {
    if (x <= 0)
        return 0;
    if (x >= 1)
        return 1;
    const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - logBeta(a, b));
    // Konvergensi lebih cepat pada sisi yang lebih kecil
    if (x > (a + 1) / (a + b + 2))
        return 1 - incompleteBeta(1 - x, b, a);
    const TINY = 1e-30;
    let f = 1;
    let c = 1;
    let d = 0;
    for (let i = 0; i <= 250; i++) {
        const m = Math.floor(i / 2);
        let numerator;
        if (i === 0)
            numerator = 1;
        else if (i % 2 === 0)
            numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
        else
            numerator = -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
        d = 1 + numerator * d;
        if (Math.abs(d) < TINY)
            d = TINY;
        d = 1 / d;
        c = 1 + numerator / c;
        if (Math.abs(c) < TINY)
            c = TINY;
        const delta = c * d;
        f *= delta;
        if (Math.abs(1 - delta) < 1e-14)
            break;
    }
    return (front * (f - 1)) / a;
}
/** Fungsi gamma tak lengkap bawah teregularisasi P(a,x). */
function lowerIncompleteGamma(a, x) {
    if (x <= 0)
        return 0;
    if (x < a + 1) {
        // Deret
        let sum = 1 / a;
        let term = sum;
        for (let n = 1; n < 500; n++) {
            term *= x / (a + n);
            sum += term;
            if (Math.abs(term) < Math.abs(sum) * 1e-15)
                break;
        }
        return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
    }
    // Fraksi berlanjut untuk Q(a,x)
    const TINY = 1e-300;
    let b = x + 1 - a;
    let c = 1 / TINY;
    let d = 1 / b;
    let h = d;
    for (let i = 1; i < 500; i++) {
        const an = -i * (i - a);
        b += 2;
        d = an * d + b;
        if (Math.abs(d) < TINY)
            d = TINY;
        c = b + an / c;
        if (Math.abs(c) < TINY)
            c = TINY;
        d = 1 / d;
        const delta = d * c;
        h *= delta;
        if (Math.abs(delta - 1) < 1e-15)
            break;
    }
    return 1 - Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}
/** Fungsi galat. */
function erf(x) {
    const sign = x < 0 ? -1 : 1;
    const abs = Math.abs(x);
    // Abramowitz & Stegun 7.1.26
    const t = 1 / (1 + 0.3275911 * abs);
    const y = 1 -
        ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
            t *
            Math.exp(-abs * abs);
    return sign * y;
}
/** CDF normal baku. */
function normalCdf(z) {
    return 0.5 * (1 + erf(z / Math.SQRT2));
}
/** Kuantil normal baku (inverse CDF) — algoritma Acklam. */
function normalQuantile(p) {
    if (p <= 0 || p >= 1)
        return p <= 0 ? -Infinity : Infinity;
    const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
    const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
    const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
    const pLow = 0.02425;
    let q;
    let r;
    if (p < pLow) {
        q = Math.sqrt(-2 * Math.log(p));
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p <= 1 - pLow) {
        q = p - 0.5;
        r = q * q;
        return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
            (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    }
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}
/** CDF distribusi t Student. */
function studentTCdf(t, df) {
    if (df <= 0)
        return NaN;
    const x = df / (df + t * t);
    const p = 0.5 * incompleteBeta(x, df / 2, 0.5);
    return t > 0 ? 1 - p : p;
}
/** Nilai-p dua arah untuk statistik t. */
function tTestPValue(t, df, tails = 2) {
    const p = 1 - studentTCdf(Math.abs(t), df);
    return Math.min(1, Math.max(0, tails === 2 ? 2 * p : p));
}
/** Kuantil t (inverse CDF) — pencarian biner atas CDF yang monoton. */
function studentTQuantile(p, df) {
    if (p <= 0)
        return -Infinity;
    if (p >= 1)
        return Infinity;
    let low = -1000;
    let high = 1000;
    for (let i = 0; i < 200; i++) {
        const mid = (low + high) / 2;
        if (studentTCdf(mid, df) < p)
            low = mid;
        else
            high = mid;
    }
    return (low + high) / 2;
}
/** CDF khi-kuadrat. */
function chiSquareCdf(x, df) {
    if (x <= 0)
        return 0;
    return lowerIncompleteGamma(df / 2, x / 2);
}
function chiSquarePValue(x, df) {
    return Math.min(1, Math.max(0, 1 - chiSquareCdf(x, df)));
}
/** CDF distribusi F. */
function fCdf(f, df1, df2) {
    if (f <= 0)
        return 0;
    return incompleteBeta((df1 * f) / (df1 * f + df2), df1 / 2, df2 / 2);
}
function fTestPValue(f, df1, df2) {
    return Math.min(1, Math.max(0, 1 - fCdf(f, df1, df2)));
}
/**
 * Nilai kritis Studentised Range (q) untuk uji lanjut Tukey.
 *
 * Tabel nilai kritis pada α=0.05 untuk k kelompok dan df galat; nilai antara
 * diinterpolasi. Pendekatan tabel dipilih karena integrasi numerik distribusi
 * studentised range akan menambah ketidakpastian numerik pada hasil yang dipakai
 * untuk laporan resmi (PRD Domain 4).
 */
const TUKEY_Q05 = {
    // df: [k=2, k=3, k=4, k=5, k=6, k=7, k=8]
    5: [3.64, 4.6, 5.22, 5.67, 6.03, 6.33, 6.58],
    6: [3.46, 4.34, 4.9, 5.30, 5.63, 5.90, 6.12],
    7: [3.34, 4.16, 4.68, 5.06, 5.36, 5.61, 5.82],
    8: [3.26, 4.04, 4.53, 4.89, 5.17, 5.40, 5.60],
    10: [3.15, 3.88, 4.33, 4.65, 4.91, 5.12, 5.30],
    12: [3.08, 3.77, 4.20, 4.51, 4.75, 4.95, 5.12],
    15: [3.01, 3.67, 4.08, 4.37, 4.59, 4.78, 4.94],
    20: [2.95, 3.58, 3.96, 4.23, 4.45, 4.62, 4.77],
    30: [2.89, 3.49, 3.85, 4.10, 4.30, 4.46, 4.60],
    60: [2.83, 3.40, 3.74, 3.98, 4.16, 4.31, 4.44],
    120: [2.80, 3.36, 3.68, 3.92, 4.10, 4.24, 4.36],
    1000: [2.77, 3.31, 3.63, 3.86, 4.03, 4.17, 4.29],
};
function tukeyCriticalQ(k, df) {
    const kIndex = Math.min(Math.max(k, 2), 8) - 2;
    const keys = Object.keys(TUKEY_Q05).map(Number).sort((a, b) => a - b);
    let lower = keys[0];
    let upper = keys[keys.length - 1];
    for (const key of keys) {
        if (key <= df)
            lower = key;
        if (key >= df) {
            upper = key;
            break;
        }
    }
    const qLow = TUKEY_Q05[lower][kIndex];
    const qHigh = TUKEY_Q05[upper][kIndex];
    if (lower === upper)
        return qLow;
    const ratio = (df - lower) / (upper - lower);
    return qLow + (qHigh - qLow) * ratio;
}
//# sourceMappingURL=distributions.js.map