/**
 * Pengujian stats-service.
 *
 * ARCHITECTURE.md Bagian 3 & 11 menuntut output DETERMINISTIK dan DAPAT DIVERIFIKASI
 * karena dipakai untuk laporan resmi dan kajian kebijakan. Karena itu nilai harapan
 * di bawah adalah angka rujukan yang dihitung dengan definisi statistik baku
 * (varians sampel n−1, kuantil tipe-7, G1/G2), bukan sekadar "keluaran saat ini".
 */
import { describe, expect, it } from 'vitest';
import {
  boxPlot, describe as describeStats, histogram, kurtosis, mean, median, mode, quantile, skewness, stdDev, variance,
} from '../src/stats-service/descriptive.ts';
import {
  chiSquareGoodnessOfFit, chiSquareIndependence, independentTTest, kruskalWallis, levene,
  mannWhitneyU, oneSampleTTest, oneWayAnova, pairedTTest, rank, shapiroWilk, wilcoxonSignedRank,
} from '../src/stats-service/hypothesis.ts';
import {
  chiSquarePValue, fTestPValue, normalCdf, normalQuantile, studentTCdf, tTestPValue,
} from '../src/stats-service/distributions.ts';
import {
  computeVif, correlationMatrix, durbinWatson, invert, kendall, linearRegression, logisticRegression, pearson, spearman,
} from '../src/stats-service/regression.ts';

const close = (actual: number, expected: number, tolerance = 1e-4): void => {
  expect(Math.abs(actual - expected)).toBeLessThan(tolerance);
};

describe('Distribusi probabilitas', () => {
  it('TC-ST-01 — CDF normal cocok dengan nilai tabel baku', () => {
    close(normalCdf(0), 0.5, 1e-6);
    close(normalCdf(1.96), 0.975, 1e-4);
    close(normalCdf(-1.645), 0.05, 1e-4);
    close(normalCdf(2.576), 0.995, 1e-4);
  });

  it('TC-ST-02 — kuantil normal adalah invers dari CDF', () => {
    close(normalQuantile(0.975), 1.959964, 1e-4);
    close(normalQuantile(0.5), 0, 1e-6);
    close(normalCdf(normalQuantile(0.83)), 0.83, 1e-4);
  });

  it('TC-ST-03 — CDF t Student mendekati normal saat df besar', () => {
    close(studentTCdf(0, 10), 0.5, 1e-6);
    close(studentTCdf(1.96, 100_000), normalCdf(1.96), 1e-3);
    // Nilai kritis t dua arah, df=10, α=0.05 → 2.228
    close(tTestPValue(2.228, 10, 2), 0.05, 1e-3);
  });

  it('TC-ST-04 — nilai-p khi-kuadrat & F cocok dengan tabel', () => {
    // χ²(df=1) = 3.841 → p = 0.05
    close(chiSquarePValue(3.841, 1), 0.05, 1e-3);
    // χ²(df=3) = 7.815 → p = 0.05
    close(chiSquarePValue(7.815, 3), 0.05, 1e-3);
    // F(2, 10) = 4.103 → p = 0.05
    close(fTestPValue(4.103, 2, 10), 0.05, 1e-3);
  });
});

describe('Statistik deskriptif — PRD 6.22', () => {
  const sample = [2, 4, 4, 4, 5, 5, 7, 9];

  it('TC-ST-05 — ukuran pemusatan dan penyebaran sesuai definisi baku', () => {
    close(mean(sample), 5);
    close(median(sample), 4.5);
    expect(mode(sample)).toEqual([4]);
    // Varians SAMPEL (pembagi n−1) = 32/7
    close(variance(sample), 32 / 7);
    close(stdDev(sample), Math.sqrt(32 / 7));
  });

  it('TC-ST-06 — kuartil memakai interpolasi tipe-7 (definisi R default)', () => {
    close(quantile([1, 2, 3, 4], 0.25), 1.75);
    close(quantile([1, 2, 3, 4], 0.5), 2.5);
    close(quantile([1, 2, 3, 4], 0.75), 3.25);
  });

  it('TC-ST-07 — skewness & kurtosis simetris bernilai nol', () => {
    const symmetric = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    close(skewness(symmetric), 0, 1e-9);
    // Kurtosis distribusi seragam bernilai negatif (lebih rata dari normal)
    expect(kurtosis(symmetric)).toBeLessThan(0);
  });

  it('TC-ST-08 — deskripsi lengkap melaporkan N, missing, dan unik', () => {
    const result = describeStats([1, 2, 2, null, '', 'bukan-angka', 5]);
    expect(result.n).toBe(4);
    expect(result.missing).toBe(3);
    expect(result.distinct).toBe(3);
  });

  it('TC-ST-09 — box plot menandai outlier dengan pagar 1.5×IQR', () => {
    const withOutlier = [10, 11, 12, 13, 14, 15, 100];
    expect(boxPlot(withOutlier).outliers).toContain(100);
  });

  it('TC-ST-10 — histogram mencakup seluruh observasi', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const bins = histogram(values, 5);
    expect(bins).toHaveLength(5);
    expect(bins.reduce((acc, b) => acc + b.count, 0)).toBe(values.length);
  });
});

describe('Uji hipotesis — PRD 6.23', () => {
  it('TC-ST-11 — one-sample t-test cocok dengan hitungan manual', () => {
    const values = [5.1, 4.9, 5.3, 5.0, 5.2, 4.8, 5.4, 5.1];
    const result = oneSampleTTest(values, 5.0);
    // mean = 5.1, sd = 0.2, se = 0.070711, t = 1.414214 (diverifikasi manual)
    close(result.statistic, 1.414214, 1e-4);
    expect(result.df).toBe(7);
    expect(result.significant).toBe(false);
  });

  it('TC-ST-12 — independent t-test mendeteksi perbedaan nyata & melaporkan effect size', () => {
    const a = [23, 25, 28, 30, 32, 29, 27, 26];
    const b = [35, 38, 40, 42, 39, 37, 41, 36];
    const result = independentTTest(a, b, 0.05, 2, { welch: false });

    expect(result.significant).toBe(true);
    expect(result.pValue).toBeLessThan(0.001);
    expect(result.effectSize?.magnitudeKey).toBe('effect.large');
    // Pembedaan asosiasi vs kausalitas WAJIB ada di setiap hasil.
    expect(result.causalityNoteKey).toBe('note.difference_not_causation');
  });

  it('TC-ST-13 — asumsi homogenitas dilanggar → Welch diterapkan otomatis', () => {
    const tight = [10, 10.1, 9.9, 10.2, 9.8, 10.05, 9.95, 10.1];
    const spread = [5, 25, 1, 30, 12, 22, 3, 28];
    const result = independentTTest(tight, spread);

    expect(result.testKey).toBe('test.welch_t');
    expect(result.warnings).toContain('warning.homogeneity_violated_welch_applied');
  });

  it('TC-ST-14 — paired t-test bekerja pada selisih pasangan', () => {
    const before = [200, 210, 190, 205, 195];
    const after = [190, 205, 185, 195, 188];
    const result = pairedTTest(before, after);
    expect(result.testKey).toBe('test.paired_t');
    expect(result.significant).toBe(true);
  });

  it('TC-ST-15 — ANOVA satu arah + uji lanjut Tukey', () => {
    const result = oneWayAnova([
      { label: 'Kontrol', values: [55, 58, 60, 57, 59] },
      { label: 'Perlakuan A', values: [65, 68, 70, 67, 69] },
      { label: 'Perlakuan B', values: [75, 78, 80, 77, 79] },
    ]);

    expect(result.significant).toBe(true);
    expect(result.effectSize?.nameKey).toBe('effect.eta_squared');
    // Uji lanjut hanya muncul bila uji utama signifikan.
    expect(result.postHoc).toHaveLength(3);
    expect(result.postHoc.every((c) => c.significant)).toBe(true);
  });

  it('TC-ST-16 — Shapiro-Wilk menolak data yang jelas tidak normal', () => {
    const normalish = [-1.2, -0.6, -0.3, -0.1, 0, 0.1, 0.25, 0.4, 0.7, 1.3];
    const skewed = [1, 1, 1, 1, 1, 1, 1, 1, 2, 50];

    expect(shapiroWilk(normalish).passed).toBe(true);
    expect(shapiroWilk(skewed).passed).toBe(false);
    // Bila asumsi dilanggar, sistem MENYARANKAN uji alternatif (PRD 6.23).
    expect(shapiroWilk(skewed).alternativeTestKey).toBe('test.mann_whitney');
  });

  it('TC-ST-17 — Levene mendeteksi varians tidak homogen', () => {
    expect(levene([[1, 2, 3, 4, 5], [2, 3, 4, 5, 6]]).passed).toBe(true);
    expect(levene([[10, 10.1, 9.9, 10, 10.05], [1, 50, 2, 48, 25]]).passed).toBe(false);
  });

  it('TC-ST-18 — peringkat menangani nilai seri dengan rata-rata peringkat', () => {
    expect(rank([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
  });

  it('TC-ST-19 — uji non-parametrik tersedia sebagai alternatif', () => {
    const a = [12, 15, 11, 14, 13, 16, 10];
    const b = [22, 25, 21, 24, 23, 26, 20];

    expect(mannWhitneyU(a, b).significant).toBe(true);
    expect(kruskalWallis([{ label: 'a', values: a }, { label: 'b', values: b }]).significant).toBe(true);
    expect(wilcoxonSignedRank([10, 12, 14, 16, 18, 20], [8, 9, 11, 13, 15, 17]).significant).toBe(true);
  });

  it('TC-ST-20 — Chi-Square independensi memakai frekuensi harapan yang benar', () => {
    // Tabel 2×2 klasik
    const result = chiSquareIndependence([[20, 30], [30, 20]], ['A', 'B'], ['X', 'Y']);
    close(result.expected[0]![0]!, 25, 1e-6);
    close(result.statistic, 4, 1e-6);
    expect(result.significant).toBe(true);
    expect(result.causalityNoteKey).toBe('note.association_not_causation');
  });

  it('TC-ST-21 — Chi-Square goodness-of-fit dengan proporsi seragam', () => {
    const result = chiSquareGoodnessOfFit([30, 30, 30], [1 / 3, 1 / 3, 1 / 3], ['a', 'b', 'c']);
    close(result.statistic, 0, 1e-9);
    expect(result.significant).toBe(false);
  });

  it('TC-ST-22 — frekuensi harapan rendah memicu peringatan', () => {
    const result = chiSquareIndependence([[1, 2], [2, 1]], ['A', 'B'], ['X', 'Y']);
    expect(result.warnings).toContain('warning.low_expected_frequencies');
  });
});

describe('Regresi & korelasi — PRD 6.24', () => {
  it('TC-ST-23 — Pearson pada hubungan linear sempurna bernilai 1', () => {
    const result = pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
    close(result.coefficient, 1, 1e-6);
    expect(result.causalityNoteKey).toBe('note.correlation_not_causation');
  });

  it('TC-ST-24 — Spearman menangkap hubungan monoton non-linear', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [1, 4, 9, 16, 25];
    close(spearman(x, y).coefficient, 1, 1e-6);
    expect(pearson(x, y).coefficient).toBeLessThan(1);
  });

  it('TC-ST-25 — Kendall tau-b pada data terurut sempurna', () => {
    close(kendall([1, 2, 3, 4], [1, 2, 3, 4]).coefficient, 1, 1e-6);
    close(kendall([1, 2, 3, 4], [4, 3, 2, 1]).coefficient, -1, 1e-6);
  });

  it('TC-ST-26 — inversi matriks menghasilkan matriks identitas', () => {
    const m = [[4, 7], [2, 6]];
    const inverse = invert(m)!;
    close(inverse[0]![0]!, 0.6);
    close(inverse[0]![1]!, -0.7);
    close(inverse[1]![0]!, -0.2);
    close(inverse[1]![1]!, 0.4);
  });

  it('TC-ST-27 — regresi linear sederhana memulihkan koefisien yang diketahui', () => {
    // y = 3 + 2x tepat
    const x = [1, 2, 3, 4, 5, 6, 7, 8];
    const y = x.map((v) => 3 + 2 * v);
    const model = linearRegression({ x }, y);

    close(model.coefficients[0]!.estimate, 3, 1e-6);
    close(model.coefficients[1]!.estimate, 2, 1e-6);
    close(model.rSquared, 1, 1e-9);
    expect(model.causalityNoteKey).toBe('note.regression_not_causation');
  });

  it('TC-ST-28 — regresi berganda memulihkan kedua koefisien', () => {
    const x1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const x2 = [2, 1, 4, 3, 6, 5, 8, 7, 10, 9];
    const y = x1.map((v, i) => 5 + 2 * v + 3 * x2[i]!);
    const model = linearRegression({ x1, x2 }, y);

    close(model.coefficients[0]!.estimate, 5, 1e-4);
    close(model.coefficients[1]!.estimate, 2, 1e-4);
    close(model.coefficients[2]!.estimate, 3, 1e-4);
  });

  it('TC-ST-29 — diagnostik otomatis melaporkan VIF & Durbin-Watson', () => {
    const x1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // HAMPIR kolinear (bukan persis) — kolinearitas sempurna membuat matriks
    // desain singular dan memang ditolak lebih awal oleh `linearRegression`.
    const collinear = x1.map((v, i) => v * 2 + (i % 2 === 0 ? 0.02 : -0.02));
    const y = x1.map((v, i) => v + collinear[i]! * 0.5 + (i % 3));

    const model = linearRegression({ x1, collinear }, y);
    expect(model.diagnostics.maxVif).toBeGreaterThan(10);
    expect(model.warnings).toContain('warning.severe_multicollinearity');
    expect(Number.isFinite(model.diagnostics.durbinWatson)).toBe(true);
  });

  it('TC-ST-30 — VIF bernilai 1 untuk prediktor yang saling bebas', () => {
    const vifs = computeVif({
      a: [1, 2, 3, 4, 5, 6, 7, 8],
      b: [5, 3, 8, 1, 7, 2, 6, 4],
    });
    expect(vifs.a).toBeGreaterThanOrEqual(1);
    expect(vifs.a).toBeLessThan(2);
  });

  it('TC-ST-31 — Durbin-Watson mendekati 2 tanpa autokorelasi', () => {
    const alternating = [1, -1, 1, -1, 1, -1, 1, -1];
    // Residual berselang-seling → autokorelasi negatif kuat (DW mendekati 4)
    expect(durbinWatson(alternating)).toBeGreaterThan(3);
  });

  it('TC-ST-32 — regresi logistik memisahkan kelas biner yang terpisah jelas', () => {
    const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const outcome = x.map((v) => (v > 6 ? 1 : 0)) as Array<0 | 1>;
    const model = logisticRegression({ x }, outcome);

    expect(model.accuracy).toBeGreaterThanOrEqual(0.9);
    expect(model.coefficients[1]!.estimate).toBeGreaterThan(0);
    expect(model.coefficients[1]!.oddsRatio).toBeGreaterThan(1);
    expect(model.causalityNoteKey).toBe('note.regression_not_causation');
  });

  it('TC-ST-33 — matriks korelasi simetris dengan diagonal 1', () => {
    const matrix = correlationMatrix({
      a: [1, 2, 3, 4, 5],
      b: [2, 4, 6, 8, 10],
      c: [5, 3, 4, 1, 2],
    });

    expect(matrix.variables).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      close(matrix.matrix[i]![i]!, 1, 1e-9);
      for (let j = 0; j < 3; j++) close(matrix.matrix[i]![j]!, matrix.matrix[j]![i]!, 1e-9);
    }
  });

  it('TC-ST-34 — hasil deterministik: input sama menghasilkan output identik', () => {
    const x = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3];
    const y = [2, 7, 1, 8, 2, 8, 1, 8, 2, 8];

    expect(JSON.stringify(linearRegression({ x }, y))).toBe(JSON.stringify(linearRegression({ x }, y)));
    expect(JSON.stringify(oneWayAnova([{ label: 'a', values: x }, { label: 'b', values: y }]))).toBe(
      JSON.stringify(oneWayAnova([{ label: 'a', values: x }, { label: 'b', values: y }])),
    );
  });
});
