/**
 * Lapisan layanan stats-service — PRD 6.22–6.24.
 *
 * `stats.test.ts` menguji matematikanya (deskriptif, uji hipotesis, regresi) terhadap
 * nilai rujukan. Berkas ini menguji lapisan yang MEMBUNGKUS matematika itu: pemuatan
 * data ber-RLS, cache hasil, penolakan spesifikasi salah bentuk, dan penegakan
 * wewenang serta paket.
 *
 * Alasannya: `StatsService` sebelumnya tidak pernah diinstansiasi satu uji pun —
 * cakupan branch-nya 33,7% dan seluruhnya kebetulan tersentuh lewat HTTP. Di lapisan
 * inilah bug 500-bukan-400 pernah ditemukan, dan di lapisan ini pula cache bertemu
 * RLS. Keduanya tidak terlihat dari uji matematika.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contextFor, createHarness, createUser, provisionTenant, syntheticCsv, type Harness } from './helpers.ts';
import { StatsService, crossTabulate } from '../src/stats-service/service.ts';
import { DatasetService } from '../src/data-platform-service/datasets.ts';
import { ForbiddenError, NotFoundError } from '../src/platform/errors.ts';
import type { TestResult } from '../src/stats-service/hypothesis.ts';
import type { RequestContext } from '../src/platform/context.ts';

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

afterEach(() => {
  harness.cleanup();
});

/** Mengunggah CSV dan mengembalikan id dataset. */
function uploadCsv(ctx: RequestContext, csv: string, filename = 'uji.csv'): string {
  return new DatasetService(ctx).upload({ filename, content: Buffer.from(csv) }).dataset.id;
}

/** Jumlah baris cache — satu-satunya cara mengamati apakah perhitungan diulang. */
function cacheRows(): number {
  return (harness.db.prepare('SELECT COUNT(*) AS n FROM stat_analyses').get() as { n: number }).n;
}

const TIMUR = [{ dimension: 'wilayah', operator: 'in' as const, values: ['Wilayah Timur'] }];

/**
 * Cache hasil analisis versus RLS.
 *
 * Cache di sini sah secara prinsip: hasilnya deterministik (ARCHITECTURE.md Bagian 3),
 * sehingga spesifikasi yang sama harus memberi hasil yang sama dan dapat diverifikasi
 * ulang auditor. Yang menentukan aman atau tidak adalah APA yang masuk kunci cache.
 *
 * Kunci yang hanya memuat spesifikasi analisis mengabaikan fakta bahwa dua pengguna
 * dengan spesifikasi identik boleh melihat HIMPUNAN BARIS yang berbeda. Hasil agregat
 * juga data: rata-rata seluruh wilayah membocorkan wilayah yang tidak boleh dilihat,
 * meski tak satu baris pun dikembalikan.
 */
describe('Cache hasil analisis: kunci wajib memuat cakupan RLS', () => {
  it('TC-STS-01 — hasil untuk pengguna tanpa batas TIDAK disajikan ke pengguna ber-RLS', () => {
    const tenant = provisionTenant(harness);
    const admin = contextFor(harness, tenant.tenantId, ['super_admin']);
    const datasetId = uploadCsv(admin, syntheticCsv({ rows: 30 }));
    const spec = { datasetId, fields: ['skor_csat'] };

    // Pengguna tanpa batas lebih dulu — inilah urutan yang wajar di lapangan: seorang
    // administrator membuka analisis, lalu analis berwilayah membuka analisis yang sama.
    const semua = new StatsService(admin).descriptive(spec);
    expect(semua.source.rowsAnalysed).toBe(30);

    const analis = contextFor(harness, tenant.tenantId, ['business_analyst'], { rls: TIMUR });
    const terbatas = new StatsService(analis).descriptive(spec);

    // 30 baris menjadi 10 karena hanya sepertiga baris ber-wilayah Timur.
    expect(terbatas.source.rowsAnalysed).toBe(10);
    // Dan statistiknya harus benar-benar dihitung ulang, bukan disalin.
    expect(terbatas.perField[0]!.stats.n).toBe(10);
    expect(terbatas.perField[0]!.stats.mean).not.toBe(semua.perField[0]!.stats.mean);

    // Kedua baris cache dapat dijelaskan sendiri: spesifikasi identik, cakupan berbeda.
    const tersimpan = harness.db
      .prepare('SELECT spec_json, rls_scope_json FROM stat_analyses ORDER BY created_at')
      .all() as Array<{ spec_json: string; rls_scope_json: string }>;
    expect(tersimpan).toHaveLength(2);
    expect(tersimpan[0]!.spec_json).toBe(tersimpan[1]!.spec_json);
    expect(tersimpan[0]!.rls_scope_json).not.toBe(tersimpan[1]!.rls_scope_json);
  });

  it('TC-STS-02 — dua pengguna dengan cakupan RLS sama tetap berbagi cache', () => {
    const tenant = provisionTenant(harness);
    const admin = contextFor(harness, tenant.tenantId, ['super_admin']);
    const datasetId = uploadCsv(admin, syntheticCsv({ rows: 30 }));
    const spec = { datasetId, fields: ['skor_csat'] };

    const analisA = contextFor(harness, tenant.tenantId, ['business_analyst'], { rls: TIMUR });
    const userB = createUser(harness, tenant.tenantId, 'analis.b@uji.test', 'business_analyst');
    const analisB = contextFor(harness, tenant.tenantId, ['business_analyst'], { userId: userB, rls: TIMUR });

    const pertama = new StatsService(analisA).descriptive(spec);
    const sesudah = cacheRows();
    const kedua = new StatsService(analisB).descriptive(spec);

    // Memisahkan cache per RLS tidak boleh berarti memisahkan cache per PENGGUNA:
    // cakupan yang sama harus berbagi, kalau tidak cache-nya kehilangan gunanya.
    expect(cacheRows()).toBe(sesudah);
    expect(kedua.source.generatedAt).toBe(pertama.source.generatedAt);
  });

  it('TC-STS-03 — spesifikasi sama dari konteks sama: hasil identik, hitung sekali', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const datasetId = uploadCsv(ctx, syntheticCsv({ rows: 12 }));
    const spec = { datasetId, fields: ['jumlah_tiket'] };

    const a = new StatsService(ctx).descriptive(spec);
    const b = new StatsService(ctx).descriptive(spec);

    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(cacheRows()).toBe(1);
  });

  it('TC-STS-04 — cache tidak menyeberangi tenant meski spesifikasinya serupa', () => {
    const a = provisionTenant(harness, { slug: 'statsaa' });
    const b = provisionTenant(harness, { slug: 'statsbb' });
    const ctxA = contextFor(harness, a.tenantId, ['super_admin']);
    const ctxB = contextFor(harness, b.tenantId, ['super_admin']);

    // Dataset berbeda isinya, sehingga hasil yang benar HARUS berbeda.
    const idA = uploadCsv(ctxA, syntheticCsv({ rows: 30 }));
    const idB = uploadCsv(ctxB, syntheticCsv({ rows: 9 }));

    const hasilA = new StatsService(ctxA).descriptive({ datasetId: idA, fields: ['skor_csat'] });
    const hasilB = new StatsService(ctxB).descriptive({ datasetId: idB, fields: ['skor_csat'] });

    expect(hasilA.source.rowsAnalysed).toBe(30);
    expect(hasilB.source.rowsAnalysed).toBe(9);

    const perTenant = harness.db
      .prepare('SELECT tenant_id, COUNT(*) AS n FROM stat_analyses GROUP BY tenant_id')
      .all() as Array<{ tenant_id: string; n: number }>;
    expect(perTenant).toHaveLength(2);
  });
});

/**
 * RLS diterapkan sebelum angka apa pun dihitung — bukan setelahnya.
 */
describe('RLS mendahului perhitungan', () => {
  it('TC-STS-05 — korelasi hanya memakai baris yang boleh dilihat', () => {
    const tenant = provisionTenant(harness);
    const admin = contextFor(harness, tenant.tenantId, ['super_admin']);
    const datasetId = uploadCsv(admin, syntheticCsv({ rows: 30 }));

    const analis = contextFor(harness, tenant.tenantId, ['business_analyst'], { rls: TIMUR });
    const hasil = new StatsService(analis).correlation({
      datasetId,
      fields: ['jumlah_tiket', 'skor_csat'],
    });

    expect(hasil.source.n).toBe(10);
  });

  it('TC-STS-06 — baris tanpa kolom dimensi pembatas tidak lolos (fail secure)', () => {
    const tenant = provisionTenant(harness);
    const admin = contextFor(harness, tenant.tenantId, ['super_admin']);
    const datasetId = uploadCsv(admin, syntheticCsv({ rows: 30 }));

    // Dataset ini tidak punya kolom `departemen` sama sekali. Default yang aman adalah
    // MENOLAK baris seperti itu; default yang meloloskannya akan membuat setiap dataset
    // yang lupa satu kolom terbuka penuh.
    const analis = contextFor(harness, tenant.tenantId, ['business_analyst'], {
      rls: [{ dimension: 'departemen', operator: 'in', values: ['Keuangan'] }],
    });
    const hasil = new StatsService(analis).correlation({
      datasetId,
      fields: ['jumlah_tiket', 'skor_csat'],
    });

    expect(hasil.source.n).toBe(0);
  });
});

/**
 * Spesifikasi salah bentuk adalah kesalahan KLIEN (400), bukan kegagalan server (500).
 *
 * Perbedaannya bukan kosmetik: 500 memicu penyelidikan insiden dan menyembunyikan
 * penyebab dari pengguna, sedangkan 400 dengan kunci i18n dapat langsung diperbaiki
 * pengguna sendiri.
 */
describe('Penolakan spesifikasi salah bentuk', () => {
  function siapkan(csv: string): { ctx: RequestContext; datasetId: string } {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    return { ctx, datasetId: uploadCsv(ctx, csv) };
  }

  it('TC-STS-07 — field non-numerik ditolak, bukan menghasilkan NaN', () => {
    const { ctx, datasetId } = siapkan(syntheticCsv({ rows: 8 }));
    expect(() => new StatsService(ctx).descriptive({ datasetId, fields: ['kanal'] })).toThrow(
      expect.objectContaining({ status: 400, messageKey: 'error.field_not_numeric' }),
    );
  });

  it('TC-STS-08 — uji satu sampel tanpa valueField', () => {
    const { ctx, datasetId } = siapkan(syntheticCsv({ rows: 8 }));
    expect(() => new StatsService(ctx).hypothesis({ datasetId, test: 'one_sample_t', mu: 3 })).toThrow(
      expect.objectContaining({ messageKey: 'error.field_required' }),
    );
  });

  it('TC-STS-09 — uji satu sampel tanpa nilai mu pembanding', () => {
    const { ctx, datasetId } = siapkan(syntheticCsv({ rows: 8 }));
    // Tanpa mu, tidak ada hipotesis nol yang dapat diuji — menebak 0 akan menghasilkan
    // nilai-p yang tampak sah untuk pertanyaan yang tidak pernah diajukan.
    expect(() =>
      new StatsService(ctx).hypothesis({ datasetId, test: 'one_sample_t', valueField: 'skor_csat' }),
    ).toThrow(expect.objectContaining({ messageKey: 'error.mu_required' }));
  });

  it('TC-STS-10 — uji dua kelompok pada data berkelompok tiga', () => {
    const { ctx, datasetId } = siapkan(syntheticCsv({ rows: 30 }));
    expect(() =>
      new StatsService(ctx).hypothesis({
        datasetId,
        test: 'independent_t',
        valueField: 'skor_csat',
        groupField: 'wilayah',
      }),
    ).toThrow(expect.objectContaining({ messageKey: 'error.two_groups_required', detail: { found: 3 } }));
  });

  it('TC-STS-11 — uji berpasangan dengan jumlah pasangan tidak sama', () => {
    // 10 baris utuh + 3 baris yang jumlah_tiket-nya kosong: skor_csat punya 13 nilai,
    // jumlah_tiket hanya 10. Memasangkannya berarti membandingkan pasangan yang tidak ada.
    const { ctx, datasetId } = siapkan(syntheticCsv({ rows: 10, missingCells: 3 }));
    expect(() =>
      new StatsService(ctx).hypothesis({
        datasetId,
        test: 'paired_t',
        valueField: 'jumlah_tiket',
        pairedWithField: 'skor_csat',
      }),
    ).toThrow(expect.objectContaining({ messageKey: 'error.paired_length_mismatch' }));
  });

  it('TC-STS-12 — ANOVA menolak dua kelompok, Kruskal-Wallis menerimanya', () => {
    const csv = ['wilayah,skor', 'A,4', 'A,5', 'A,6', 'B,7', 'B,8', 'B,9'].join('\n');
    const { ctx, datasetId } = siapkan(csv);
    const stats = new StatsService(ctx);
    const spec = { datasetId, valueField: 'skor', groupField: 'wilayah' } as const;

    // Asimetri ini disengaja: dua kelompok adalah t-test, dan ANOVA yang diam-diam
    // menerimanya akan melaporkan F padahal pengguna keliru memilih uji.
    expect(() => stats.hypothesis({ ...spec, test: 'one_way_anova' })).toThrow(
      expect.objectContaining({ messageKey: 'error.anova_needs_three_groups', detail: { groups: 2 } }),
    );

    // Kruskal-Wallis dengan dua kelompok setara Mann-Whitney dan tetap sah, jadi ia
    // memang harus jalan — bukan ditolak demi keseragaman.
    const kw = stats.hypothesis({ ...spec, test: 'kruskal_wallis' }) as TestResult;
    expect(kw.testKey).toContain('kruskal');
    expect(kw.pValue).toBeGreaterThan(0);
  });

  it('TC-STS-13 — proporsi harapan yang jumlahnya tidak sepadan dengan kategori', () => {
    const { ctx, datasetId } = siapkan(syntheticCsv({ rows: 9 }));
    expect(() =>
      new StatsService(ctx).hypothesis({
        datasetId,
        test: 'chi_square_goodness_of_fit',
        categoryFieldA: 'wilayah',
        expectedProportions: [0.5, 0.5], // datanya tiga wilayah
      }),
    ).toThrow(expect.objectContaining({ messageKey: 'error.expected_proportions_mismatch' }));
  });

  it('TC-STS-14 — ANOVA dua arah tanpa faktor kedua', () => {
    const { ctx, datasetId } = siapkan(syntheticCsv({ rows: 12 }));
    expect(() =>
      new StatsService(ctx).hypothesis({
        datasetId,
        test: 'two_way_anova',
        valueField: 'skor_csat',
        groupField: 'wilayah',
      }),
    ).toThrow(expect.objectContaining({ messageKey: 'error.field_required' }));
  });

  it('TC-STS-15 — nama uji yang tidak dikenal ditolak, tidak diabaikan', () => {
    const { ctx, datasetId } = siapkan(syntheticCsv({ rows: 8 }));
    expect(() =>
      // Nama uji datang dari klien; salah ketik tidak boleh berujung pada uji lain
      // yang kebetulan jadi cabang default.
      new StatsService(ctx).hypothesis({ datasetId, test: 'anova_tiga_arah' as never, valueField: 'skor_csat' }),
    ).toThrow(expect.objectContaining({ messageKey: 'error.unknown_test' }));
  });

  it('TC-STS-16 — regresi dengan observasi lebih sedikit daripada parameter', () => {
    const csv = ['y,x1,x2', '1,2,3', '2,3,4', '3,4,5'].join('\n');
    const { ctx, datasetId } = siapkan(csv);
    // 3 observasi untuk 2 prediktor + intersep: modelnya akan pas sempurna tanpa sisa
    // derajat kebebasan, sehingga R² = 1 dan nilai-p tidak punya arti.
    expect(() =>
      new StatsService(ctx).regression({
        datasetId,
        kind: 'linear',
        responseField: 'y',
        predictorFields: ['x1', 'x2'],
      }),
    ).toThrow(expect.objectContaining({ messageKey: 'error.insufficient_observations' }));
  });

  it('TC-STS-17 — dataset yang tidak ada dijawab 404', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    expect(() => new StatsService(ctx).descriptive({ datasetId: 'ds_tidak_ada', fields: ['a'] })).toThrow(
      NotFoundError,
    );
  });

  it('TC-STS-18 — dataset tenant lain dijawab 404, bukan 403', () => {
    const a = provisionTenant(harness, { slug: 'statsxx' });
    const b = provisionTenant(harness, { slug: 'statsyy' });
    const datasetId = uploadCsv(contextFor(harness, a.tenantId, ['super_admin']), syntheticCsv({ rows: 6 }));

    // 403 akan mengonfirmasi bahwa id itu ADA di tenant lain — pembeda yang cukup untuk
    // memetakan objek milik pelanggan lain (SECURITY.md Bagian 2).
    const ctxB = contextFor(harness, b.tenantId, ['super_admin']);
    expect(() => new StatsService(ctxB).descriptive({ datasetId, fields: ['skor_csat'] })).toThrow(NotFoundError);
  });
});

describe('Wewenang dan batas paket', () => {
  it('TC-STS-19 — peran tanpa stats:run ditolak sebelum data dimuat', () => {
    const tenant = provisionTenant(harness);
    const admin = contextFor(harness, tenant.tenantId, ['super_admin']);
    const datasetId = uploadCsv(admin, syntheticCsv({ rows: 6 }));

    const eksekutif = contextFor(harness, tenant.tenantId, ['executive']);
    expect(() => new StatsService(eksekutif).descriptive({ datasetId, fields: ['skor_csat'] })).toThrow(
      ForbiddenError,
    );
  });

  it('TC-STS-20 — paket starter: modul statistik berperilaku seolah tidak ada', () => {
    const tenant = provisionTenant(harness, { planCode: 'starter', slug: 'statsstart' });
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const datasetId = uploadCsv(ctx, syntheticCsv({ rows: 6 }));

    expect(() => new StatsService(ctx).descriptive({ datasetId, fields: ['skor_csat'] })).toThrow(
      expect.objectContaining({ status: 403, messageKey: 'error.module_not_in_plan' }),
    );
  });
});

/**
 * Metode penanganan data yang tidak lengkap dinyatakan, bukan disembunyikan.
 *
 * SECURITY.md 11 menuntut sumber dan periode data ikut dilaporkan. Jumlah observasi
 * yang benar-benar terpakai termasuk di dalamnya: R² dari 8 baris dan R² dari 200 baris
 * dibaca sangat berbeda oleh pengambil keputusan.
 */
describe('Transparansi metode', () => {
  it('TC-STS-21 — korelasi melaporkan n setelah listwise deletion', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    // 10 baris utuh + 2 baris yang jumlah_tiket-nya bukan angka ('dua-puluh').
    const datasetId = uploadCsv(ctx, syntheticCsv({ rows: 10, invalidCells: 2 }));

    const hasil = new StatsService(ctx).correlation({ datasetId, fields: ['jumlah_tiket', 'skor_csat'] });

    expect(hasil.source.n).toBe(10);
    // Dataset-nya sendiri memang 12 baris — selisihnya harus terbaca, bukan tersamar.
    const jumlah = harness.db.prepare('SELECT row_count FROM dataset_catalog WHERE id = ?').get(datasetId) as {
      row_count: number;
    };
    expect(jumlah.row_count).toBe(12);
  });

  it('TC-STS-22 — kelompok berisi satu observasi dibuang dari analisis kelompok', () => {
    const csv = ['wilayah,skor', 'A,4', 'A,5', 'A,6', 'B,7'].join('\n');
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const datasetId = uploadCsv(ctx, csv);

    // Satu observasi tidak punya varians, sehingga tidak dapat masuk uji apa pun yang
    // membandingkan sebaran. Konsekuensinya terlihat: yang tersisa hanya SATU kelompok.
    expect(() =>
      new StatsService(ctx).hypothesis({
        datasetId,
        test: 'independent_t',
        valueField: 'skor',
        groupField: 'wilayah',
      }),
    ).toThrow(expect.objectContaining({ messageKey: 'error.two_groups_required', detail: { found: 1 } }));
  });

  it('TC-STS-23 — tabulasi silang menempatkan nilai kosong pada kategori tersendiri', () => {
    const rows = [
      { a: 'X', b: 'P' },
      { a: 'X', b: null },
      { a: 'Y', b: 'P' },
      { a: null, b: 'Q' },
    ];

    const { table, rowLabels, columnLabels } = crossTabulate(rows, 'a', 'b');

    // Nilai kosong menjadi kategori '—' alih-alih dibuang: membuangnya akan mengubah
    // frekuensi harapan Chi-Square tanpa pengguna tahu jumlah barisnya menyusut.
    expect(rowLabels).toEqual(['X', 'Y', '—']);
    expect(columnLabels).toEqual(['P', 'Q', '—']);
    const total = table.flat().reduce((s, v) => s + v, 0);
    expect(total).toBe(rows.length);
  });
});
