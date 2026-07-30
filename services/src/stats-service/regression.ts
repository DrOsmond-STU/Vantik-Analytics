/**
 * Analisis Regresi & Korelasi — PRD 6.24.
 *
 * Kewajiban dokumen yang ditegakkan di sini:
 *  - Output MEMBEDAKAN SECARA EKSPLISIT antara korelasi dan kausalitas, dan
 *    mengingatkan bahwa hasil regresi observasional tidak membuktikan sebab-akibat.
 *  - Diagnostik model OTOMATIS: multikolinearitas (VIF), residual plot,
 *    autokorelasi (Durbin-Watson), dan deteksi outlier berpengaruh.
 */
import { mean, stdDev } from './descriptive.ts';
import { rank } from './hypothesis.ts';
import { fTestPValue, normalCdf, studentTQuantile, tTestPValue } from './distributions.ts';

/* ------------------------------------------------------------------ */
/* Aljabar matriks minimal                                             */
/* ------------------------------------------------------------------ */

export type Matrix = number[][];

export function transpose(m: Matrix): Matrix {
  const rows = m.length;
  const cols = m[0]?.length ?? 0;
  return Array.from({ length: cols }, (_, j) => Array.from({ length: rows }, (_, i) => m[i]![j]!));
}

export function multiply(a: Matrix, b: Matrix): Matrix {
  const n = a.length;
  const m = b[0]!.length;
  const k = b.length;
  const out: Matrix = Array.from({ length: n }, () => new Array<number>(m).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      let sum = 0;
      for (let x = 0; x < k; x++) sum += a[i]![x]! * b[x]![j]!;
      out[i]![j] = sum;
    }
  }
  return out;
}

/** Inversi matriks via eliminasi Gauss-Jordan dengan pivot parsial. */
export function invert(matrix: Matrix): Matrix | null {
  const n = matrix.length;
  const a = matrix.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row]![col]!) > Math.abs(a[pivot]![col]!)) pivot = row;
    }
    if (Math.abs(a[pivot]![col]!) < 1e-12) return null; // singular → multikolinearitas sempurna
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];

    const pivotValue = a[col]![col]!;
    for (let j = 0; j < 2 * n; j++) a[col]![j]! /= pivotValue;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row]![col]!;
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) a[row]![j]! -= factor * a[col]![j]!;
    }
  }
  return a.map((row) => row.slice(n));
}

/* ------------------------------------------------------------------ */
/* Korelasi                                                            */
/* ------------------------------------------------------------------ */

export interface CorrelationResult {
  methodKey: 'correlation.pearson' | 'correlation.spearman' | 'correlation.kendall';
  coefficient: number;
  pValue: number;
  n: number;
  confidenceInterval?: [number, number];
  strengthKey: string;
  /** PRD 6.24: pembedaan korelasi vs kausalitas, eksplisit di setiap output. */
  causalityNoteKey: string;
}

function strengthKey(r: number): string {
  const abs = Math.abs(r);
  if (abs < 0.2) return 'strength.very_weak';
  if (abs < 0.4) return 'strength.weak';
  if (abs < 0.6) return 'strength.moderate';
  if (abs < 0.8) return 'strength.strong';
  return 'strength.very_strong';
}

const CORRELATION_NOTE = 'note.correlation_not_causation';

export function pearson(x: number[], y: number[]): CorrelationResult {
  const n = x.length;
  const mx = mean(x);
  const my = mean(y);
  let numerator = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    numerator += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const r = sxx === 0 || syy === 0 ? 0 : numerator / Math.sqrt(sxx * syy);

  const df = n - 2;
  const t = df > 0 && Math.abs(r) < 1 ? (r * Math.sqrt(df)) / Math.sqrt(1 - r * r) : 0;
  const p = df > 0 ? tTestPValue(t, df, 2) : NaN;

  // Selang kepercayaan lewat transformasi z Fisher
  let ci: [number, number] | undefined;
  if (n > 3 && Math.abs(r) < 1) {
    const z = 0.5 * Math.log((1 + r) / (1 - r));
    const se = 1 / Math.sqrt(n - 3);
    const lo = Math.tanh(z - 1.96 * se);
    const hi = Math.tanh(z + 1.96 * se);
    ci = [Number(lo.toFixed(4)), Number(hi.toFixed(4))];
  }

  return {
    methodKey: 'correlation.pearson',
    coefficient: Number(r.toFixed(6)),
    pValue: Number(p.toFixed(6)),
    n,
    confidenceInterval: ci,
    strengthKey: strengthKey(r),
    causalityNoteKey: CORRELATION_NOTE,
  };
}

export function spearman(x: number[], y: number[]): CorrelationResult {
  const result = pearson(rank(x), rank(y));
  return { ...result, methodKey: 'correlation.spearman', causalityNoteKey: CORRELATION_NOTE };
}

export function kendall(x: number[], y: number[]): CorrelationResult {
  const n = x.length;
  let concordant = 0;
  let discordant = 0;
  let tiesX = 0;
  let tiesY = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = x[i]! - x[j]!;
      const dy = y[i]! - y[j]!;
      const product = dx * dy;
      if (product > 0) concordant++;
      else if (product < 0) discordant++;
      else {
        if (dx === 0) tiesX++;
        if (dy === 0) tiesY++;
      }
    }
  }

  // Tau-b memperhitungkan seri
  const denominator = Math.sqrt(
    (concordant + discordant + tiesX) * (concordant + discordant + tiesY),
  );
  const tau = denominator === 0 ? 0 : (concordant - discordant) / denominator;

  const z = n > 2 ? (3 * tau * Math.sqrt(n * (n - 1))) / Math.sqrt(2 * (2 * n + 5)) : 0;
  const p = 2 * (1 - normalCdf(Math.abs(z)));

  return {
    methodKey: 'correlation.kendall',
    coefficient: Number(tau.toFixed(6)),
    pValue: Number(Math.min(1, p).toFixed(6)),
    n,
    strengthKey: strengthKey(tau),
    causalityNoteKey: CORRELATION_NOTE,
  };
}

export interface CorrelationMatrix {
  variables: string[];
  /** matrix[i][j] = koefisien; nilai-p pada pValues[i][j]. */
  matrix: number[][];
  pValues: number[][];
  methodKey: CorrelationResult['methodKey'];
  causalityNoteKey: string;
}

/** Matriks korelasi untuk ditampilkan sebagai heatmap (PRD 6.24). */
export function correlationMatrix(
  data: Record<string, number[]>,
  method: 'pearson' | 'spearman' | 'kendall' = 'pearson',
): CorrelationMatrix {
  const variables = Object.keys(data);
  const fn = method === 'pearson' ? pearson : method === 'spearman' ? spearman : kendall;

  const matrix: number[][] = [];
  const pValues: number[][] = [];
  for (const a of variables) {
    const row: number[] = [];
    const pRow: number[] = [];
    for (const b of variables) {
      if (a === b) {
        row.push(1);
        pRow.push(0);
        continue;
      }
      const result = fn(data[a]!, data[b]!);
      row.push(result.coefficient);
      pRow.push(result.pValue);
    }
    matrix.push(row);
    pValues.push(pRow);
  }

  return {
    variables,
    matrix,
    pValues,
    methodKey: `correlation.${method}` as CorrelationResult['methodKey'],
    causalityNoteKey: CORRELATION_NOTE,
  };
}

/* ------------------------------------------------------------------ */
/* Regresi linear (sederhana & berganda)                               */
/* ------------------------------------------------------------------ */

export interface Coefficient {
  name: string;
  estimate: number;
  standardError: number;
  tValue: number;
  pValue: number;
  confidenceInterval: [number, number];
  /** Variance Inflation Factor; hanya untuk prediktor (bukan intersep). */
  vif?: number;
}

export interface InfluentialPoint {
  index: number;
  standardisedResidual: number;
  leverage: number;
  cooksDistance: number;
}

export interface RegressionDiagnostics {
  /** Durbin-Watson: ~2 = tidak ada autokorelasi; <1 atau >3 mengkhawatirkan. */
  durbinWatson: number;
  durbinWatsonVerdictKey: string;
  maxVif: number;
  multicollinearityVerdictKey: string;
  influentialPoints: InfluentialPoint[];
  /** Titik untuk residual plot (fitted vs residual). */
  residualPlot: Array<{ fitted: number; residual: number }>;
  normalityOfResidualsPValue: number;
}

export interface LinearRegressionResult {
  modelKey: 'model.linear_regression';
  coefficients: Coefficient[];
  rSquared: number;
  adjustedRSquared: number;
  standardError: number;
  fStatistic: number;
  fPValue: number;
  df: [number, number];
  n: number;
  /** Persamaan dalam bentuk yang dapat dibaca (PRD 6.24). */
  equation: string;
  diagnostics: RegressionDiagnostics;
  warnings: string[];
  causalityNoteKey: string;
}

/**
 * OLS regresi linear berganda.
 * `predictors` adalah peta nama → nilai; regresi sederhana adalah kasus satu prediktor.
 */
export function linearRegression(
  predictors: Record<string, number[]>,
  response: number[],
  options: { responseName?: string; alpha?: number } = {},
): LinearRegressionResult {
  const names = Object.keys(predictors);
  const n = response.length;
  const k = names.length;
  const alpha = options.alpha ?? 0.05;

  // Matriks desain dengan kolom intersep
  const X: Matrix = Array.from({ length: n }, (_, i) => [1, ...names.map((name) => predictors[name]![i]!)]);
  const y: Matrix = response.map((v) => [v]);

  const Xt = transpose(X);
  const XtX = multiply(Xt, X);
  const XtXInv = invert(XtX);

  if (!XtXInv) {
    throw new Error('Design matrix is singular — perfect multicollinearity among predictors');
  }

  const beta = multiply(multiply(XtXInv, Xt), y).map((row) => row[0]!);

  const fitted = X.map((row) => row.reduce((acc, v, j) => acc + v * beta[j]!, 0));
  const residuals = response.map((v, i) => v - fitted[i]!);

  const meanY = mean(response);
  const ssTotal = response.reduce((acc, v) => acc + (v - meanY) ** 2, 0);
  const ssResidual = residuals.reduce((acc, r) => acc + r * r, 0);
  const ssRegression = ssTotal - ssResidual;

  const dfResidual = n - k - 1;
  const mse = ssResidual / dfResidual;
  const standardError = Math.sqrt(mse);

  const rSquared = ssTotal === 0 ? 0 : ssRegression / ssTotal;
  const adjustedRSquared = 1 - ((1 - rSquared) * (n - 1)) / dfResidual;

  const fStatistic = k === 0 ? 0 : ssRegression / k / mse;
  const fPValue = fTestPValue(fStatistic, k, dfResidual);

  const tCritical = studentTQuantile(1 - alpha / 2, dfResidual);
  const coefficientNames = ['(Intercept)', ...names];

  const coefficients: Coefficient[] = beta.map((estimate, j) => {
    const se = Math.sqrt(mse * XtXInv[j]![j]!);
    const t = se === 0 ? 0 : estimate / se;
    return {
      name: coefficientNames[j]!,
      estimate: Number(estimate.toFixed(6)),
      standardError: Number(se.toFixed(6)),
      tValue: Number(t.toFixed(6)),
      pValue: Number(tTestPValue(t, dfResidual, 2).toFixed(6)),
      confidenceInterval: [
        Number((estimate - tCritical * se).toFixed(6)),
        Number((estimate + tCritical * se).toFixed(6)),
      ],
    };
  });

  // --- Diagnostik otomatis (PRD 6.24) ---------------------------------
  const vifs = computeVif(predictors);
  for (let j = 1; j < coefficients.length; j++) {
    coefficients[j]!.vif = vifs[coefficientNames[j]!];
  }
  const maxVif = Math.max(0, ...Object.values(vifs));

  const dw = durbinWatson(residuals);
  const hat = X.map((row) => {
    const rowMatrix = [row];
    const product = multiply(multiply(rowMatrix, XtXInv), transpose(rowMatrix));
    return product[0]![0]!;
  });

  const influentialPoints: InfluentialPoint[] = [];
  residuals.forEach((r, i) => {
    const h = hat[i]!;
    const studentised = r / (standardError * Math.sqrt(Math.max(1e-12, 1 - h)));
    const cooks = (studentised ** 2 / (k + 1)) * (h / Math.max(1e-12, 1 - h));
    // Ambang lazim: |residual terstandardisasi| > 3 atau Cook's D > 4/n
    if (Math.abs(studentised) > 3 || cooks > 4 / n) {
      influentialPoints.push({
        index: i,
        standardisedResidual: Number(studentised.toFixed(4)),
        leverage: Number(h.toFixed(4)),
        cooksDistance: Number(cooks.toFixed(4)),
      });
    }
  });

  const residualSd = stdDev(residuals);
  const standardisedResiduals = residuals.map((r) => (residualSd === 0 ? 0 : r / residualSd));
  const normalityP = jarqueBeraPValue(standardisedResiduals);

  const warnings: string[] = [];
  if (maxVif > 10) warnings.push('warning.severe_multicollinearity');
  else if (maxVif > 5) warnings.push('warning.moderate_multicollinearity');
  if (dw < 1.5 || dw > 2.5) warnings.push('warning.autocorrelation_detected');
  if (influentialPoints.length > 0) warnings.push('warning.influential_points_detected');
  if (normalityP < 0.05) warnings.push('warning.residuals_not_normal');
  if (dfResidual < 10) warnings.push('warning.small_sample');

  const equation = buildEquation(options.responseName ?? 'y', coefficientNames, beta);

  return {
    modelKey: 'model.linear_regression',
    coefficients,
    rSquared: Number(rSquared.toFixed(6)),
    adjustedRSquared: Number(adjustedRSquared.toFixed(6)),
    standardError: Number(standardError.toFixed(6)),
    fStatistic: Number(fStatistic.toFixed(6)),
    fPValue: Number(fPValue.toFixed(6)),
    df: [k, dfResidual],
    n,
    equation,
    diagnostics: {
      durbinWatson: Number(dw.toFixed(4)),
      durbinWatsonVerdictKey:
        dw < 1.5 ? 'dw.positive_autocorrelation' : dw > 2.5 ? 'dw.negative_autocorrelation' : 'dw.no_autocorrelation',
      maxVif: Number(maxVif.toFixed(4)),
      multicollinearityVerdictKey:
        maxVif > 10 ? 'vif.severe' : maxVif > 5 ? 'vif.moderate' : 'vif.acceptable',
      influentialPoints,
      residualPlot: fitted.map((f, i) => ({
        fitted: Number(f.toFixed(6)),
        residual: Number(residuals[i]!.toFixed(6)),
      })),
      normalityOfResidualsPValue: Number(normalityP.toFixed(6)),
    },
    warnings,
    // Regresi observasional TIDAK membuktikan sebab-akibat (PRD 6.24).
    causalityNoteKey: 'note.regression_not_causation',
  };
}

function buildEquation(responseName: string, names: string[], beta: number[]): string {
  const parts = [beta[0]!.toFixed(4)];
  for (let j = 1; j < beta.length; j++) {
    const value = beta[j]!;
    parts.push(`${value >= 0 ? '+' : '−'} ${Math.abs(value).toFixed(4)} × ${names[j]}`);
  }
  return `${responseName} = ${parts.join(' ')}`;
}

/** Variance Inflation Factor per prediktor (PRD 6.24 — pemeriksaan multikolinearitas). */
export function computeVif(predictors: Record<string, number[]>): Record<string, number> {
  const names = Object.keys(predictors);
  const out: Record<string, number> = {};
  if (names.length < 2) {
    for (const name of names) out[name] = 1;
    return out;
  }

  for (const target of names) {
    const others = names.filter((n) => n !== target);
    const y = predictors[target]!;
    const n = y.length;
    const X: Matrix = Array.from({ length: n }, (_, i) => [1, ...others.map((o) => predictors[o]![i]!)]);
    const Xt = transpose(X);
    const XtXInv = invert(multiply(Xt, X));
    if (!XtXInv) {
      out[target] = Infinity;
      continue;
    }
    const beta = multiply(multiply(XtXInv, Xt), y.map((v) => [v])).map((r) => r[0]!);
    const fitted = X.map((row) => row.reduce((acc, v, j) => acc + v * beta[j]!, 0));
    const meanY = mean(y);
    const ssTotal = y.reduce((acc, v) => acc + (v - meanY) ** 2, 0);
    const ssResidual = y.reduce((acc, v, i) => acc + (v - fitted[i]!) ** 2, 0);
    const r2 = ssTotal === 0 ? 0 : 1 - ssResidual / ssTotal;
    out[target] = r2 >= 1 ? Infinity : Number((1 / (1 - r2)).toFixed(6));
  }
  return out;
}

/** Statistik Durbin-Watson untuk uji autokorelasi residual (PRD 6.24). */
export function durbinWatson(residuals: number[]): number {
  if (residuals.length < 2) return NaN;
  let numerator = 0;
  for (let i = 1; i < residuals.length; i++) {
    numerator += (residuals[i]! - residuals[i - 1]!) ** 2;
  }
  const denominator = residuals.reduce((acc, r) => acc + r * r, 0);
  return denominator === 0 ? NaN : numerator / denominator;
}

/** Uji Jarque-Bera untuk normalitas residual. */
export function jarqueBeraPValue(values: number[]): number {
  const n = values.length;
  if (n < 4) return 1;
  const m = mean(values);
  const s = stdDev(values);
  if (s === 0) return 1;
  const skew = values.reduce((acc, v) => acc + ((v - m) / s) ** 3, 0) / n;
  const kurt = values.reduce((acc, v) => acc + ((v - m) / s) ** 4, 0) / n;
  const jb = (n / 6) * (skew ** 2 + (kurt - 3) ** 2 / 4);
  // JB ~ chi-square dengan df=2 → p = exp(-JB/2)
  return Math.exp(-jb / 2);
}

/* ------------------------------------------------------------------ */
/* Regresi logistik                                                    */
/* ------------------------------------------------------------------ */

export interface LogisticCoefficient extends Coefficient {
  oddsRatio: number;
  oddsRatioCI: [number, number];
}

export interface LogisticRegressionResult {
  modelKey: 'model.logistic_regression';
  coefficients: LogisticCoefficient[];
  logLikelihood: number;
  nullLogLikelihood: number;
  /** Pseudo-R² McFadden. */
  mcFaddenR2: number;
  likelihoodRatioChiSquare: number;
  likelihoodRatioPValue: number;
  n: number;
  converged: boolean;
  iterations: number;
  accuracy: number;
  confusionMatrix: { truePositive: number; falsePositive: number; trueNegative: number; falseNegative: number };
  equation: string;
  warnings: string[];
  causalityNoteKey: string;
}

function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/**
 * Regresi logistik untuk variabel terikat biner (PRD 6.24).
 * Estimasi via Newton-Raphson (IRLS).
 */
export function logisticRegression(
  predictors: Record<string, number[]>,
  outcome: number[],
  options: { responseName?: string; maxIterations?: number; alpha?: number } = {},
): LogisticRegressionResult {
  const names = Object.keys(predictors);
  const n = outcome.length;
  const k = names.length;
  const alpha = options.alpha ?? 0.05;
  const maxIterations = options.maxIterations ?? 50;

  if (!outcome.every((v) => v === 0 || v === 1)) {
    throw new Error('logistic regression requires a binary (0/1) outcome');
  }

  const X: Matrix = Array.from({ length: n }, (_, i) => [1, ...names.map((name) => predictors[name]![i]!)]);
  let beta = new Array<number>(k + 1).fill(0);
  let converged = false;
  let iterations = 0;
  let covariance: Matrix | null = null;

  for (; iterations < maxIterations; iterations++) {
    const eta = X.map((row) => row.reduce((acc, v, j) => acc + v * beta[j]!, 0));
    const p = eta.map(sigmoid);

    // Gradien: Xᵀ(y − p)
    const gradient = new Array<number>(k + 1).fill(0);
    for (let j = 0; j <= k; j++) {
      for (let i = 0; i < n; i++) gradient[j]! += X[i]![j]! * (outcome[i]! - p[i]!);
    }

    // Hessian: −XᵀWX dengan W = diag(p(1−p))
    const hessian: Matrix = Array.from({ length: k + 1 }, () => new Array<number>(k + 1).fill(0));
    for (let i = 0; i < n; i++) {
      const w = Math.max(1e-10, p[i]! * (1 - p[i]!));
      for (let a = 0; a <= k; a++) {
        for (let b = 0; b <= k; b++) hessian[a]![b]! += X[i]![a]! * X[i]![b]! * w;
      }
    }

    const inverse = invert(hessian);
    if (!inverse) break;
    covariance = inverse;

    const step = inverse.map((row) => row.reduce((acc, v, j) => acc + v * gradient[j]!, 0));
    beta = beta.map((b, j) => b + step[j]!);

    if (Math.max(...step.map(Math.abs)) < 1e-8) {
      converged = true;
      iterations++;
      break;
    }
  }

  const eta = X.map((row) => row.reduce((acc, v, j) => acc + v * beta[j]!, 0));
  const probabilities = eta.map(sigmoid);

  const logLikelihood = outcome.reduce<number>((acc, y, i) => {
    const p = Math.min(1 - 1e-12, Math.max(1e-12, probabilities[i]!));
    return acc + y * Math.log(p) + (1 - y) * Math.log(1 - p);
  }, 0);

  const baseRate = mean(outcome);
  const nullLogLikelihood = outcome.reduce<number>((acc, y) => {
    const p = Math.min(1 - 1e-12, Math.max(1e-12, baseRate));
    return acc + y * Math.log(p) + (1 - y) * Math.log(1 - p);
  }, 0);

  const lrChiSquare = 2 * (logLikelihood - nullLogLikelihood);
  const mcFaddenR2 = nullLogLikelihood === 0 ? 0 : 1 - logLikelihood / nullLogLikelihood;

  const zCritical = 1.959963984540054; // z untuk 95%
  const coefficientNames = ['(Intercept)', ...names];
  const coefficients: LogisticCoefficient[] = beta.map((estimate, j) => {
    const se = covariance ? Math.sqrt(Math.max(0, covariance[j]![j]!)) : NaN;
    const z = se === 0 || Number.isNaN(se) ? 0 : estimate / se;
    const p = 2 * (1 - normalCdf(Math.abs(z)));
    const critical = alpha === 0.05 ? zCritical : Math.abs(studentTQuantile(1 - alpha / 2, 1e6));
    return {
      name: coefficientNames[j]!,
      estimate: Number(estimate.toFixed(6)),
      standardError: Number(se.toFixed(6)),
      tValue: Number(z.toFixed(6)),
      pValue: Number(Math.min(1, p).toFixed(6)),
      confidenceInterval: [
        Number((estimate - critical * se).toFixed(6)),
        Number((estimate + critical * se).toFixed(6)),
      ],
      oddsRatio: Number(Math.exp(estimate).toFixed(6)),
      oddsRatioCI: [
        Number(Math.exp(estimate - critical * se).toFixed(6)),
        Number(Math.exp(estimate + critical * se).toFixed(6)),
      ],
    };
  });

  let truePositive = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  let falseNegative = 0;
  probabilities.forEach((p, i) => {
    const predicted = p >= 0.5 ? 1 : 0;
    if (predicted === 1 && outcome[i] === 1) truePositive++;
    else if (predicted === 1) falsePositive++;
    else if (outcome[i] === 0) trueNegative++;
    else falseNegative++;
  });

  const warnings: string[] = [];
  if (!converged) warnings.push('warning.model_did_not_converge');
  const minorityClass = Math.min(baseRate, 1 - baseRate) * n;
  // Aturan praktis: minimal ~10 peristiwa per prediktor.
  if (minorityClass < 10 * Math.max(1, k)) warnings.push('warning.few_events_per_predictor');
  const maxVif = Math.max(0, ...Object.values(computeVif(predictors)));
  if (maxVif > 10) warnings.push('warning.severe_multicollinearity');

  const equationParts = [beta[0]!.toFixed(4)];
  for (let j = 1; j < beta.length; j++) {
    equationParts.push(`${beta[j]! >= 0 ? '+' : '−'} ${Math.abs(beta[j]!).toFixed(4)} × ${names[j - 1]}`);
  }

  return {
    modelKey: 'model.logistic_regression',
    coefficients,
    logLikelihood: Number(logLikelihood.toFixed(6)),
    nullLogLikelihood: Number(nullLogLikelihood.toFixed(6)),
    mcFaddenR2: Number(mcFaddenR2.toFixed(6)),
    likelihoodRatioChiSquare: Number(lrChiSquare.toFixed(6)),
    likelihoodRatioPValue: Number(
      Math.min(1, Math.max(0, 1 - chiSquareCdfLocal(lrChiSquare, Math.max(1, k)))).toFixed(6),
    ),
    n,
    converged,
    iterations,
    accuracy: Number(((truePositive + trueNegative) / n).toFixed(4)),
    confusionMatrix: { truePositive, falsePositive, trueNegative, falseNegative },
    equation: `logit(P(${options.responseName ?? 'y'}=1)) = ${equationParts.join(' ')}`,
    warnings,
    causalityNoteKey: 'note.regression_not_causation',
  };
}

/** Wrapper lokal agar berkas ini tidak mengimpor siklik dari distributions saat build. */
function chiSquareCdfLocal(x: number, df: number): number {
  if (x <= 0) return 0;
  // Deret gamma tak lengkap bawah (sama seperti distributions.lowerIncompleteGamma)
  const a = df / 2;
  const z = x / 2;
  if (z < a + 1) {
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 500; n++) {
      term *= z / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
    }
    return sum * Math.exp(-z + a * Math.log(z) - logGammaLocal(a));
  }
  const TINY = 1e-300;
  let b = z + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return 1 - Math.exp(-z + a * Math.log(z) - logGammaLocal(a)) * h;
}

function logGammaLocal(x: number): number {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGammaLocal(1 - x);
  const z = x - 1;
  let a = 0.99999999999980993;
  const t = z + 7.5;
  for (let i = 0; i < coefficients.length; i++) a += coefficients[i]! / (z + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}
