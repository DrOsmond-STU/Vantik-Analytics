/**
 * Uji Hipotesis (Statistik Inferensial) — PRD 6.23.
 *
 * Dua kewajiban yang ditegakkan di seluruh berkas ini:
 *  1. Sistem MEMERIKSA & MELAPORKAN asumsi uji otomatis, dan MEMPERINGATKAN bila
 *     asumsi dilanggar disertai saran uji alternatif.
 *  2. Interpretasi TIDAK PERNAH menyimpulkan kausalitas dari uji yang hanya
 *     menunjukkan asosiasi — pembedaan ini eksplisit di teks interpretasi.
 */
import { mean, quantile, stdDev, variance } from './descriptive.ts';
import {
  chiSquarePValue,
  fTestPValue,
  normalCdf,
  studentTQuantile,
  tTestPValue,
  tukeyCriticalQ,
} from './distributions.ts';

export type Alpha = 0.01 | 0.05 | 0.1;
export type Tails = 1 | 2;

export interface AssumptionCheck {
  /** Kunci i18n nama asumsi, mis. `assumption.normality`. */
  nameKey: string;
  passed: boolean;
  statistic: number;
  pValue: number;
  /** Saran uji alternatif bila asumsi dilanggar (PRD 6.23). */
  alternativeTestKey?: string;
  detail?: Record<string, number>;
}

export interface EffectSize {
  nameKey: string;
  value: number;
  /** Interpretasi besaran (kecil/sedang/besar) mengikuti konvensi Cohen. */
  magnitudeKey: 'effect.negligible' | 'effect.small' | 'effect.medium' | 'effect.large';
}

export interface TestResult {
  testKey: string;
  statistic: number;
  df: number | [number, number];
  pValue: number;
  alpha: Alpha;
  tails: Tails;
  significant: boolean;
  effectSize?: EffectSize;
  confidenceInterval?: [number, number];
  assumptions: AssumptionCheck[];
  /** Peringatan bila asumsi dilanggar; berisi kunci i18n. */
  warnings: string[];
  /**
   * Kunci interpretasi + parameter. Teks final dirakit frontend dari kamus i18n
   * (DESIGN.md 8.2) — tidak ada kalimat tertanam di backend.
   */
  interpretation: { key: string; params: Record<string, string | number> };
  /**
   * Penegasan eksplisit bahwa uji ini menunjukkan asosiasi/perbedaan, BUKAN sebab-akibat.
   * Selalu terisi untuk uji observasional (PRD 6.23).
   */
  causalityNoteKey: string;
  groups?: Array<{ label: string; n: number; mean: number; stdDev: number }>;
}

function magnitude(value: number, thresholds: [number, number, number]): EffectSize['magnitudeKey'] {
  const abs = Math.abs(value);
  if (abs < thresholds[0]) return 'effect.negligible';
  if (abs < thresholds[1]) return 'effect.small';
  if (abs < thresholds[2]) return 'effect.medium';
  return 'effect.large';
}

/* ------------------------------------------------------------------ */
/* Pemeriksaan asumsi                                                  */
/* ------------------------------------------------------------------ */

/**
 * Uji normalitas Shapiro-Wilk (aproksimasi Royston 1992).
 * Berlaku untuk 3 ≤ n ≤ 5000.
 */
export function shapiroWilk(values: number[]): AssumptionCheck {
  const n = values.length;
  if (n < 3) {
    return {
      nameKey: 'assumption.normality',
      passed: true,
      statistic: NaN,
      pValue: NaN,
      detail: { n },
    };
  }

  const x = [...values].sort((a, b) => a - b);
  const m: number[] = [];
  for (let i = 1; i <= n; i++) {
    // Skor normal harapan (aproksimasi Blom)
    m.push(inverseNormal((i - 0.375) / (n + 0.25)));
  }
  const mSquaredSum = m.reduce((acc, v) => acc + v * v, 0);
  const rootM = Math.sqrt(mSquaredSum);
  const c = m.map((v) => v / rootM);

  const u = 1 / Math.sqrt(n);
  const a = [...c];
  const cn = c[n - 1]!;
  const cn1 = c[n - 2]!;

  const an =
    -2.706056 * u ** 5 + 4.434685 * u ** 4 - 2.071190 * u ** 3 - 0.147981 * u ** 2 + 0.221157 * u + cn;
  a[n - 1] = an;
  a[0] = -an;

  if (n > 5) {
    const an1 =
      -3.582633 * u ** 5 + 5.682633 * u ** 4 - 1.752461 * u ** 3 - 0.293762 * u ** 2 + 0.042981 * u + cn1;
    a[n - 2] = an1;
    a[1] = -an1;
    const phi =
      (mSquaredSum - 2 * m[n - 1]! ** 2 - 2 * m[n - 2]! ** 2) /
      (1 - 2 * an ** 2 - 2 * an1 ** 2);
    const scale = Math.sqrt(phi);
    for (let i = 2; i < n - 2; i++) a[i] = m[i]! / scale;
  } else {
    const phi = (mSquaredSum - 2 * m[n - 1]! ** 2) / (1 - 2 * an ** 2);
    const scale = Math.sqrt(phi);
    for (let i = 1; i < n - 1; i++) a[i] = m[i]! / scale;
  }

  const xMean = mean(x);
  const numerator = a.reduce((acc, ai, i) => acc + ai * x[i]!, 0) ** 2;
  const denominator = x.reduce((acc, v) => acc + (v - xMean) ** 2, 0);
  const W = denominator === 0 ? 1 : numerator / denominator;

  // Transformasi ke nilai-p (Royston)
  let pValue: number;
  if (n === 3) {
    const pi6 = 1.90985931710274;
    const stqr = 1.04719755119660;
    pValue = Math.max(0, Math.min(1, pi6 * (Math.asin(Math.sqrt(W)) - stqr)));
  } else {
    const logN = Math.log(n);
    let mu: number;
    let sigma: number;
    let w: number;
    if (n <= 11) {
      const gamma = -2.273 + 0.459 * n;
      mu = 0.5440 - 0.39978 * n + 0.025054 * n ** 2 - 0.0006714 * n ** 3;
      sigma = Math.exp(1.3822 - 0.77857 * n + 0.062767 * n ** 2 - 0.0020322 * n ** 3);
      w = -Math.log(gamma - Math.log(1 - W));
    } else {
      mu = -1.5861 - 0.31082 * logN - 0.083751 * logN ** 2 + 0.0038915 * logN ** 3;
      sigma = Math.exp(-0.4803 - 0.082676 * logN + 0.0030302 * logN ** 2);
      w = Math.log(1 - W);
    }
    pValue = Math.max(0, Math.min(1, 1 - normalCdf((w - mu) / sigma)));
  }

  return {
    nameKey: 'assumption.normality',
    passed: pValue >= 0.05,
    statistic: Number(W.toFixed(6)),
    pValue: Number(pValue.toFixed(6)),
    alternativeTestKey: pValue < 0.05 ? 'test.mann_whitney' : undefined,
    detail: { n },
  };
}

function inverseNormal(p: number): number {
  // Wrapper kecil agar shapiroWilk tidak bergantung langsung pada modul distribusi
  // untuk kuantil (menghindari siklus impor pada berkas ini).
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
    ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
}

/** Uji Levene (berbasis median / Brown-Forsythe — lebih tahan terhadap non-normalitas). */
export function levene(groups: number[][]): AssumptionCheck {
  const k = groups.length;
  const N = groups.reduce((acc, g) => acc + g.length, 0);
  if (k < 2 || N <= k) {
    return { nameKey: 'assumption.homogeneity', passed: true, statistic: NaN, pValue: NaN };
  }

  const z = groups.map((g) => {
    const med = quantile(g, 0.5);
    return g.map((v) => Math.abs(v - med));
  });
  const zGroupMeans = z.map(mean);
  const zGrandMean = mean(z.flat());

  const numerator =
    (N - k) * z.reduce((acc, g, i) => acc + g.length * (zGroupMeans[i]! - zGrandMean) ** 2, 0);
  const denominator =
    (k - 1) * z.reduce((acc, g, i) => acc + g.reduce((s, v) => s + (v - zGroupMeans[i]!) ** 2, 0), 0);

  const W = denominator === 0 ? 0 : numerator / denominator;
  const pValue = fTestPValue(W, k - 1, N - k);

  return {
    nameKey: 'assumption.homogeneity',
    passed: pValue >= 0.05,
    statistic: Number(W.toFixed(6)),
    pValue: Number(pValue.toFixed(6)),
    alternativeTestKey: pValue < 0.05 ? 'test.welch_or_kruskal' : undefined,
    detail: { k, N },
  };
}

/* ------------------------------------------------------------------ */
/* Uji beda rata-rata                                                  */
/* ------------------------------------------------------------------ */

const CAUSALITY_ASSOCIATION = 'note.difference_not_causation';

export function oneSampleTTest(
  values: number[],
  mu: number,
  alpha: Alpha = 0.05,
  tails: Tails = 2,
): TestResult {
  const n = values.length;
  const m = mean(values);
  const s = stdDev(values);
  const se = s / Math.sqrt(n);
  const t = (m - mu) / se;
  const df = n - 1;
  const p = tTestPValue(t, df, tails);
  const critical = studentTQuantile(1 - alpha / tails, df);
  const d = (m - mu) / s;

  const normality = shapiroWilk(values);
  const warnings: string[] = [];
  if (!normality.passed) warnings.push('warning.normality_violated');
  if (n < 30) warnings.push('warning.small_sample');

  return {
    testKey: 'test.one_sample_t',
    statistic: Number(t.toFixed(6)),
    df,
    pValue: Number(p.toFixed(6)),
    alpha,
    tails,
    significant: p < alpha,
    effectSize: {
      nameKey: 'effect.cohens_d',
      value: Number(d.toFixed(4)),
      magnitudeKey: magnitude(d, [0.2, 0.5, 0.8]),
    },
    confidenceInterval: [m - critical * se, m + critical * se],
    assumptions: [normality],
    warnings,
    interpretation: {
      key: p < alpha ? 'interpret.one_sample_t.significant' : 'interpret.one_sample_t.not_significant',
      params: { mean: Number(m.toFixed(4)), mu, pValue: Number(p.toFixed(4)), alpha },
    },
    causalityNoteKey: CAUSALITY_ASSOCIATION,
    groups: [{ label: 'sample', n, mean: m, stdDev: s }],
  };
}

export function independentTTest(
  groupA: number[],
  groupB: number[],
  alpha: Alpha = 0.05,
  tails: Tails = 2,
  options: { welch?: boolean; labels?: [string, string] } = {},
): TestResult {
  const n1 = groupA.length;
  const n2 = groupB.length;
  const m1 = mean(groupA);
  const m2 = mean(groupB);
  const v1 = variance(groupA);
  const v2 = variance(groupB);

  const homogeneity = levene([groupA, groupB]);
  // Bila asumsi homogenitas varians dilanggar, Welch dipakai OTOMATIS — bukan
  // membiarkan pengguna memakai uji yang asumsinya tidak terpenuhi (PRD 6.23).
  const useWelch = options.welch ?? !homogeneity.passed;

  let t: number;
  let df: number;
  let se: number;

  if (useWelch) {
    se = Math.sqrt(v1 / n1 + v2 / n2);
    t = (m1 - m2) / se;
    df = (v1 / n1 + v2 / n2) ** 2 / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1));
  } else {
    const pooled = ((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2);
    se = Math.sqrt(pooled * (1 / n1 + 1 / n2));
    t = (m1 - m2) / se;
    df = n1 + n2 - 2;
  }

  const p = tTestPValue(t, df, tails);
  const pooledSd = Math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2));
  const d = (m1 - m2) / pooledSd;
  const critical = studentTQuantile(1 - alpha / tails, df);

  const normalityA = shapiroWilk(groupA);
  const normalityB = shapiroWilk(groupB);
  const warnings: string[] = [];
  if (!normalityA.passed || !normalityB.passed) warnings.push('warning.normality_violated');
  if (!homogeneity.passed) warnings.push('warning.homogeneity_violated_welch_applied');

  const [labelA, labelB] = options.labels ?? ['A', 'B'];

  return {
    testKey: useWelch ? 'test.welch_t' : 'test.independent_t',
    statistic: Number(t.toFixed(6)),
    df: Number(df.toFixed(4)),
    pValue: Number(p.toFixed(6)),
    alpha,
    tails,
    significant: p < alpha,
    effectSize: {
      nameKey: 'effect.cohens_d',
      value: Number(d.toFixed(4)),
      magnitudeKey: magnitude(d, [0.2, 0.5, 0.8]),
    },
    confidenceInterval: [m1 - m2 - critical * se, m1 - m2 + critical * se],
    assumptions: [normalityA, normalityB, homogeneity],
    warnings,
    interpretation: {
      key: p < alpha ? 'interpret.independent_t.significant' : 'interpret.independent_t.not_significant',
      params: {
        groupA: labelA,
        groupB: labelB,
        meanA: Number(m1.toFixed(4)),
        meanB: Number(m2.toFixed(4)),
        pValue: Number(p.toFixed(4)),
        alpha,
      },
    },
    causalityNoteKey: CAUSALITY_ASSOCIATION,
    groups: [
      { label: labelA, n: n1, mean: m1, stdDev: Math.sqrt(v1) },
      { label: labelB, n: n2, mean: m2, stdDev: Math.sqrt(v2) },
    ],
  };
}

export function pairedTTest(before: number[], after: number[], alpha: Alpha = 0.05, tails: Tails = 2): TestResult {
  if (before.length !== after.length) {
    throw new Error('paired t-test requires equal-length samples');
  }
  const differences = before.map((v, i) => v - after[i]!);
  const result = oneSampleTTest(differences, 0, alpha, tails);
  return {
    ...result,
    testKey: 'test.paired_t',
    interpretation: {
      key: result.significant ? 'interpret.paired_t.significant' : 'interpret.paired_t.not_significant',
      params: {
        meanDifference: Number(mean(differences).toFixed(4)),
        pValue: result.pValue,
        alpha,
      },
    },
    groups: [
      { label: 'before', n: before.length, mean: mean(before), stdDev: stdDev(before) },
      { label: 'after', n: after.length, mean: mean(after), stdDev: stdDev(after) },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* ANOVA                                                               */
/* ------------------------------------------------------------------ */

export interface PostHocComparison {
  groupA: string;
  groupB: string;
  meanDifference: number;
  criticalDifference: number;
  significant: boolean;
}

export interface AnovaResult extends TestResult {
  postHoc: PostHocComparison[];
  ssBetween: number;
  ssWithin: number;
}

export function oneWayAnova(
  labelled: Array<{ label: string; values: number[] }>,
  alpha: Alpha = 0.05,
): AnovaResult {
  const k = labelled.length;
  const all = labelled.flatMap((g) => g.values);
  const N = all.length;
  const grandMean = mean(all);

  const ssBetween = labelled.reduce(
    (acc, g) => acc + g.values.length * (mean(g.values) - grandMean) ** 2,
    0,
  );
  const ssWithin = labelled.reduce((acc, g) => {
    const m = mean(g.values);
    return acc + g.values.reduce((s, v) => s + (v - m) ** 2, 0);
  }, 0);

  const dfBetween = k - 1;
  const dfWithin = N - k;
  const msBetween = ssBetween / dfBetween;
  const msWithin = ssWithin / dfWithin;
  const F = msWithin === 0 ? 0 : msBetween / msWithin;
  const p = fTestPValue(F, dfBetween, dfWithin);

  // Eta-squared: proporsi variansi total yang dijelaskan faktor kelompok.
  const etaSquared = ssBetween / (ssBetween + ssWithin);

  const homogeneity = levene(labelled.map((g) => g.values));
  const normality = labelled.map((g) => shapiroWilk(g.values));
  const warnings: string[] = [];
  if (!homogeneity.passed) warnings.push('warning.homogeneity_violated');
  if (normality.some((a) => !a.passed)) warnings.push('warning.normality_violated');
  if (warnings.length > 0) warnings.push('warning.consider_kruskal_wallis');

  // Uji lanjut Tukey HSD — hanya bermakna bila uji utama signifikan.
  const postHoc: PostHocComparison[] = [];
  if (p < alpha) {
    const q = tukeyCriticalQ(k, dfWithin);
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        const a = labelled[i]!;
        const b = labelled[j]!;
        const hsd = q * Math.sqrt((msWithin / 2) * (1 / a.values.length + 1 / b.values.length));
        const difference = mean(a.values) - mean(b.values);
        postHoc.push({
          groupA: a.label,
          groupB: b.label,
          meanDifference: Number(difference.toFixed(4)),
          criticalDifference: Number(hsd.toFixed(4)),
          significant: Math.abs(difference) > hsd,
        });
      }
    }
  }

  return {
    testKey: 'test.one_way_anova',
    statistic: Number(F.toFixed(6)),
    df: [dfBetween, dfWithin],
    pValue: Number(p.toFixed(6)),
    alpha,
    tails: 1,
    significant: p < alpha,
    effectSize: {
      nameKey: 'effect.eta_squared',
      value: Number(etaSquared.toFixed(4)),
      magnitudeKey: magnitude(etaSquared, [0.01, 0.06, 0.14]),
    },
    assumptions: [...normality, homogeneity],
    warnings,
    interpretation: {
      key: p < alpha ? 'interpret.anova.significant' : 'interpret.anova.not_significant',
      params: { groups: k, fStatistic: Number(F.toFixed(4)), pValue: Number(p.toFixed(4)), alpha },
    },
    causalityNoteKey: CAUSALITY_ASSOCIATION,
    groups: labelled.map((g) => ({
      label: g.label,
      n: g.values.length,
      mean: mean(g.values),
      stdDev: stdDev(g.values),
    })),
    postHoc,
    ssBetween: Number(ssBetween.toFixed(6)),
    ssWithin: Number(ssWithin.toFixed(6)),
  };
}

export interface TwoWayAnovaResult {
  factorA: { key: string; f: number; df: [number, number]; pValue: number; significant: boolean };
  factorB: { key: string; f: number; df: [number, number]; pValue: number; significant: boolean };
  interaction: { key: string; f: number; df: [number, number]; pValue: number; significant: boolean };
  alpha: Alpha;
  warnings: string[];
  causalityNoteKey: string;
}

/** ANOVA dua arah dengan desain seimbang. */
export function twoWayAnova(
  rows: Array<{ a: string; b: string; value: number }>,
  alpha: Alpha = 0.05,
): TwoWayAnovaResult {
  const levelsA = [...new Set(rows.map((r) => r.a))].sort();
  const levelsB = [...new Set(rows.map((r) => r.b))].sort();
  const all = rows.map((r) => r.value);
  const N = all.length;
  const grandMean = mean(all);

  const cell = (a: string, b: string): number[] =>
    rows.filter((r) => r.a === a && r.b === b).map((r) => r.value);

  const ssA = levelsA.reduce((acc, a) => {
    const values = rows.filter((r) => r.a === a).map((r) => r.value);
    return acc + values.length * (mean(values) - grandMean) ** 2;
  }, 0);
  const ssB = levelsB.reduce((acc, b) => {
    const values = rows.filter((r) => r.b === b).map((r) => r.value);
    return acc + values.length * (mean(values) - grandMean) ** 2;
  }, 0);

  let ssCells = 0;
  let ssWithin = 0;
  for (const a of levelsA) {
    for (const b of levelsB) {
      const values = cell(a, b);
      if (values.length === 0) continue;
      const m = mean(values);
      ssCells += values.length * (m - grandMean) ** 2;
      ssWithin += values.reduce((s, v) => s + (v - m) ** 2, 0);
    }
  }
  const ssInteraction = ssCells - ssA - ssB;

  const dfA = levelsA.length - 1;
  const dfB = levelsB.length - 1;
  const dfInteraction = dfA * dfB;
  const dfWithin = N - levelsA.length * levelsB.length;
  const msWithin = ssWithin / dfWithin;

  const build = (key: string, ss: number, df: number) => {
    const f = msWithin === 0 || df === 0 ? 0 : ss / df / msWithin;
    const p = fTestPValue(f, df, dfWithin);
    return {
      key,
      f: Number(f.toFixed(6)),
      df: [df, dfWithin] as [number, number],
      pValue: Number(p.toFixed(6)),
      significant: p < alpha,
    };
  };

  const warnings: string[] = [];
  if (dfWithin <= 0) warnings.push('warning.insufficient_replication');

  return {
    factorA: build('factor.a', ssA, dfA),
    factorB: build('factor.b', ssB, dfB),
    interaction: build('factor.interaction', ssInteraction, dfInteraction),
    alpha,
    warnings,
    causalityNoteKey: CAUSALITY_ASSOCIATION,
  };
}

/* ------------------------------------------------------------------ */
/* Uji non-parametrik                                                  */
/* ------------------------------------------------------------------ */

/** Peringkat dengan penanganan seri (rata-rata peringkat). */
export function rank(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  let position = 0;
  while (position < indexed.length) {
    let end = position;
    while (end + 1 < indexed.length && indexed[end + 1]!.v === indexed[position]!.v) end++;
    const averageRank = (position + end) / 2 + 1;
    for (let i = position; i <= end; i++) ranks[indexed[i]!.i] = averageRank;
    position = end + 1;
  }
  return ranks;
}

export function mannWhitneyU(groupA: number[], groupB: number[], alpha: Alpha = 0.05): TestResult {
  const n1 = groupA.length;
  const n2 = groupB.length;
  const ranks = rank([...groupA, ...groupB]);
  const rankSumA = ranks.slice(0, n1).reduce((a, b) => a + b, 0);

  const u1 = rankSumA - (n1 * (n1 + 1)) / 2;
  const u2 = n1 * n2 - u1;
  const U = Math.min(u1, u2);

  const muU = (n1 * n2) / 2;
  // Koreksi seri pada simpangan baku
  const all = [...groupA, ...groupB];
  const tieGroups = new Map<number, number>();
  for (const v of all) tieGroups.set(v, (tieGroups.get(v) ?? 0) + 1);
  const tieCorrection = [...tieGroups.values()].reduce((acc, t) => acc + (t ** 3 - t), 0);
  const N = n1 + n2;
  const sigmaU = Math.sqrt((n1 * n2 * (N + 1)) / 12 - (n1 * n2 * tieCorrection) / (12 * N * (N - 1)));

  const z = sigmaU === 0 ? 0 : (U - muU) / sigmaU;
  const p = Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));
  // Rank-biserial correlation sebagai effect size
  const r = 1 - (2 * U) / (n1 * n2);

  return {
    testKey: 'test.mann_whitney',
    statistic: U,
    df: NaN,
    pValue: Number(p.toFixed(6)),
    alpha,
    tails: 2,
    significant: p < alpha,
    effectSize: {
      nameKey: 'effect.rank_biserial',
      value: Number(r.toFixed(4)),
      magnitudeKey: magnitude(r, [0.1, 0.3, 0.5]),
    },
    // Uji non-parametrik tidak mengasumsikan normalitas — itu justru alasan memakainya.
    assumptions: [
      { nameKey: 'assumption.independence', passed: true, statistic: NaN, pValue: NaN },
    ],
    warnings: n1 < 10 || n2 < 10 ? ['warning.small_sample_normal_approx'] : [],
    interpretation: {
      key: p < alpha ? 'interpret.mann_whitney.significant' : 'interpret.mann_whitney.not_significant',
      params: { u: U, zScore: Number(z.toFixed(4)), pValue: Number(p.toFixed(4)), alpha },
    },
    causalityNoteKey: CAUSALITY_ASSOCIATION,
    groups: [
      { label: 'A', n: n1, mean: mean(groupA), stdDev: stdDev(groupA) },
      { label: 'B', n: n2, mean: mean(groupB), stdDev: stdDev(groupB) },
    ],
  };
}

export function wilcoxonSignedRank(before: number[], after: number[], alpha: Alpha = 0.05): TestResult {
  const differences = before
    .map((v, i) => v - after[i]!)
    .filter((d) => d !== 0); // pasangan seri dibuang (konvensi Wilcoxon)
  const n = differences.length;
  const ranks = rank(differences.map(Math.abs));

  let wPositive = 0;
  let wNegative = 0;
  differences.forEach((d, i) => {
    if (d > 0) wPositive += ranks[i]!;
    else wNegative += ranks[i]!;
  });
  const W = Math.min(wPositive, wNegative);

  const muW = (n * (n + 1)) / 4;
  const sigmaW = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24);
  const z = sigmaW === 0 ? 0 : (W - muW) / sigmaW;
  const p = Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));
  const r = Math.abs(z) / Math.sqrt(n);

  return {
    testKey: 'test.wilcoxon',
    statistic: W,
    df: NaN,
    pValue: Number(p.toFixed(6)),
    alpha,
    tails: 2,
    significant: p < alpha,
    effectSize: {
      nameKey: 'effect.r',
      value: Number(r.toFixed(4)),
      magnitudeKey: magnitude(r, [0.1, 0.3, 0.5]),
    },
    assumptions: [{ nameKey: 'assumption.symmetry', passed: true, statistic: NaN, pValue: NaN }],
    warnings: n < 10 ? ['warning.small_sample_normal_approx'] : [],
    interpretation: {
      key: p < alpha ? 'interpret.wilcoxon.significant' : 'interpret.wilcoxon.not_significant',
      params: { w: W, pValue: Number(p.toFixed(4)), alpha },
    },
    causalityNoteKey: CAUSALITY_ASSOCIATION,
  };
}

export function kruskalWallis(
  labelled: Array<{ label: string; values: number[] }>,
  alpha: Alpha = 0.05,
): TestResult {
  const all = labelled.flatMap((g) => g.values);
  const N = all.length;
  const ranks = rank(all);

  let offset = 0;
  let H = 0;
  for (const group of labelled) {
    const groupRanks = ranks.slice(offset, offset + group.values.length);
    const rankSum = groupRanks.reduce((a, b) => a + b, 0);
    H += rankSum ** 2 / group.values.length;
    offset += group.values.length;
  }
  H = (12 / (N * (N + 1))) * H - 3 * (N + 1);

  // Koreksi seri
  const tieGroups = new Map<number, number>();
  for (const v of all) tieGroups.set(v, (tieGroups.get(v) ?? 0) + 1);
  const tieSum = [...tieGroups.values()].reduce((acc, t) => acc + (t ** 3 - t), 0);
  const correction = 1 - tieSum / (N ** 3 - N);
  if (correction > 0) H /= correction;

  const df = labelled.length - 1;
  const p = chiSquarePValue(H, df);
  const epsilonSquared = (H - labelled.length + 1) / (N - labelled.length);

  return {
    testKey: 'test.kruskal_wallis',
    statistic: Number(H.toFixed(6)),
    df,
    pValue: Number(p.toFixed(6)),
    alpha,
    tails: 1,
    significant: p < alpha,
    effectSize: {
      nameKey: 'effect.epsilon_squared',
      value: Number(epsilonSquared.toFixed(4)),
      magnitudeKey: magnitude(epsilonSquared, [0.01, 0.08, 0.26]),
    },
    assumptions: [{ nameKey: 'assumption.independence', passed: true, statistic: NaN, pValue: NaN }],
    warnings: [],
    interpretation: {
      key: p < alpha ? 'interpret.kruskal.significant' : 'interpret.kruskal.not_significant',
      params: { h: Number(H.toFixed(4)), groups: labelled.length, pValue: Number(p.toFixed(4)), alpha },
    },
    causalityNoteKey: CAUSALITY_ASSOCIATION,
    groups: labelled.map((g) => ({
      label: g.label,
      n: g.values.length,
      mean: mean(g.values),
      stdDev: stdDev(g.values),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Uji data kategorik                                                  */
/* ------------------------------------------------------------------ */

export interface ChiSquareResult extends TestResult {
  observed: number[][];
  expected: number[][];
  rowLabels: string[];
  columnLabels: string[];
}

/** Chi-Square uji independensi pada tabel kontingensi. */
export function chiSquareIndependence(
  table: number[][],
  rowLabels: string[],
  columnLabels: string[],
  alpha: Alpha = 0.05,
): ChiSquareResult {
  const rowTotals = table.map((row) => row.reduce((a, b) => a + b, 0));
  const columnCount = table[0]?.length ?? 0;
  const columnTotals = Array.from({ length: columnCount }, (_, j) =>
    table.reduce((acc, row) => acc + (row[j] ?? 0), 0),
  );
  const grandTotal = rowTotals.reduce((a, b) => a + b, 0);

  const expected = table.map((_, i) =>
    Array.from({ length: columnCount }, (_, j) => (rowTotals[i]! * columnTotals[j]!) / grandTotal),
  );

  let chi = 0;
  let lowExpectedCells = 0;
  for (let i = 0; i < table.length; i++) {
    for (let j = 0; j < columnCount; j++) {
      const e = expected[i]![j]!;
      if (e < 5) lowExpectedCells++;
      if (e > 0) chi += (table[i]![j]! - e) ** 2 / e;
    }
  }

  const df = (table.length - 1) * (columnCount - 1);
  const p = chiSquarePValue(chi, df);
  // Cramér's V sebagai effect size
  const v = Math.sqrt(chi / (grandTotal * Math.min(table.length - 1, columnCount - 1)));

  const warnings: string[] = [];
  // Asumsi klasik: frekuensi harapan ≥5 pada minimal 80% sel.
  if (lowExpectedCells / (table.length * columnCount) > 0.2) {
    warnings.push('warning.low_expected_frequencies');
  }

  return {
    testKey: 'test.chi_square_independence',
    statistic: Number(chi.toFixed(6)),
    df,
    pValue: Number(p.toFixed(6)),
    alpha,
    tails: 1,
    significant: p < alpha,
    effectSize: {
      nameKey: 'effect.cramers_v',
      value: Number(v.toFixed(4)),
      magnitudeKey: magnitude(v, [0.1, 0.3, 0.5]),
    },
    assumptions: [
      {
        nameKey: 'assumption.expected_frequency',
        passed: lowExpectedCells / (table.length * columnCount) <= 0.2,
        statistic: lowExpectedCells,
        pValue: NaN,
        alternativeTestKey: lowExpectedCells > 0 ? 'test.fisher_exact' : undefined,
      },
    ],
    warnings,
    interpretation: {
      key: p < alpha ? 'interpret.chi_square.significant' : 'interpret.chi_square.not_significant',
      params: { chiSquare: Number(chi.toFixed(4)), df, pValue: Number(p.toFixed(4)), alpha },
    },
    // Asosiasi antar-variabel kategorik BUKAN bukti sebab-akibat (PRD 6.23).
    causalityNoteKey: 'note.association_not_causation',
    observed: table,
    expected: expected.map((row) => row.map((v2) => Number(v2.toFixed(4)))),
    rowLabels,
    columnLabels,
  };
}

/** Chi-Square goodness-of-fit. */
export function chiSquareGoodnessOfFit(
  observed: number[],
  expectedProportions: number[],
  labels: string[],
  alpha: Alpha = 0.05,
): ChiSquareResult {
  const total = observed.reduce((a, b) => a + b, 0);
  const expected = expectedProportions.map((p) => p * total);

  let chi = 0;
  for (let i = 0; i < observed.length; i++) {
    if (expected[i]! > 0) chi += (observed[i]! - expected[i]!) ** 2 / expected[i]!;
  }
  const df = observed.length - 1;
  const p = chiSquarePValue(chi, df);
  const w = Math.sqrt(chi / total);
  const lowExpected = expected.filter((e) => e < 5).length;

  return {
    testKey: 'test.chi_square_goodness_of_fit',
    statistic: Number(chi.toFixed(6)),
    df,
    pValue: Number(p.toFixed(6)),
    alpha,
    tails: 1,
    significant: p < alpha,
    effectSize: {
      nameKey: 'effect.cohens_w',
      value: Number(w.toFixed(4)),
      magnitudeKey: magnitude(w, [0.1, 0.3, 0.5]),
    },
    assumptions: [
      {
        nameKey: 'assumption.expected_frequency',
        passed: lowExpected / expected.length <= 0.2,
        statistic: lowExpected,
        pValue: NaN,
      },
    ],
    warnings: lowExpected / expected.length > 0.2 ? ['warning.low_expected_frequencies'] : [],
    interpretation: {
      key: p < alpha ? 'interpret.gof.significant' : 'interpret.gof.not_significant',
      params: { chiSquare: Number(chi.toFixed(4)), df, pValue: Number(p.toFixed(4)), alpha },
    },
    causalityNoteKey: 'note.association_not_causation',
    observed: [observed],
    expected: [expected.map((e) => Number(e.toFixed(4)))],
    rowLabels: ['observed'],
    columnLabels: labels,
  };
}
