/**
 * presentation-service — Executive Cockpit (6.1), Operational Cockpit (6.2),
 * Balanced Scorecard (6.25).
 *
 * Lapisan ini hanya tersentuh lewat empat uji HTTP sebelumnya, sehingga cabang yang
 * menentukan ANGKA MANA yang tampil tidak pernah diperiksa. Dua di antaranya salah:
 * angka korporat diambil dari dimensi pertama alih-alih agregat, dan tren mencampur
 * beberapa dimensi menjadi satu deret waktu.
 *
 * Modul-modul ini adalah tampilan tingkat direksi. Salah angka di sini tidak melempar
 * kesalahan apa pun — ia hanya tampak wajar dan salah, yang jauh lebih sulit disadari.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contextFor, createHarness, provisionTenant, syntheticCsv, type Harness } from './helpers.ts';
import { BalancedScorecardService, CockpitService } from '../src/presentation-service/index.ts';
import { KpiService } from '../src/data-platform-service/kpi.ts';
import { DatasetService } from '../src/data-platform-service/datasets.ts';
import { NotFoundError } from '../src/platform/errors.ts';
import type { RequestContext } from '../src/platform/context.ts';
import type { DatasetRow } from '../src/data-platform-service/dataQuality.ts';

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

afterEach(() => {
  harness.cleanup();
});

const PERIODE = '2026-06';
const SEBELUMNYA = '2026-05';

/** KPI berdimensi wilayah dengan skor yang berbeda tajam antar-wilayah. */
function kpiBerdimensi(ctx: RequestContext, options: { code?: string; target?: number } = {}): string {
  const kpi = new KpiService(ctx).create({
    code: options.code ?? 'CSAT',
    name: 'Skor Kepuasan',
    formula: 'AVG(skor_csat)',
    measureField: 'skor_csat',
    dimensionField: 'wilayah',
    target: options.target ?? 4.5,
    direction: 'higher_better',
  });
  return kpi.id;
}

const BARIS_WILAYAH: DatasetRow[] = [
  { wilayah: 'Wilayah Timur', skor_csat: 4.8 },
  { wilayah: 'Wilayah Timur', skor_csat: 4.6 },
  { wilayah: 'Wilayah Barat', skor_csat: 3.0 },
  { wilayah: 'Wilayah Barat', skor_csat: 3.2 },
];

const TIMUR = [{ dimension: 'wilayah', operator: 'in' as const, values: ['Wilayah Timur'] }];

/** KPI tanpa dimensi — hanya menghasilkan satu baris agregat per periode. */
function kpiTanpaDimensi(
  ctx: RequestContext,
  options: { code: string; target: number; weight?: number; datasetId?: string; kritisDiBawah?: number },
): string {
  const kpi = new KpiService(ctx).create({
    code: options.code,
    name: `KPI ${options.code}`,
    formula: 'AVG(nilai)',
    measureField: 'nilai',
    target: options.target,
    direction: 'higher_better',
    weight: options.weight,
    datasetId: options.datasetId,
    thresholds:
      options.kritisDiBawah === undefined
        ? undefined
        : [{ level: 'critical', comparator: 'lte', value: options.kritisDiBawah }],
  });
  return kpi.id;
}

describe('Executive Cockpit — angka korporat', () => {
  it('TC-PRS-01 — memakai agregat lintas dimensi, bukan dimensi yang lebih dulu tersimpan', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const kpiId = kpiBerdimensi(ctx);
    new KpiService(ctx).captureScores(kpiId, PERIODE, BARIS_WILAYAH);

    const cockpit = new CockpitService(ctx).executive(PERIODE);

    // Timur 4,70 (skor 100) · Barat 3,10 (skor 68,89) · agregat 3,90 (skor 86,67).
    // Yang benar untuk tampilan korporat adalah agregatnya.
    expect(cockpit.kpis).toHaveLength(1);
    expect(cockpit.kpis[0]!.value).toBeCloseTo(3.9, 5);
    expect(cockpit.kpis[0]!.score).toBeCloseTo(86.67, 2);
    // Dan angkanya menyatakan cakupannya sendiri.
    expect(cockpit.kpis[0]!.dimensionScope).toBeNull();
  });

  it('TC-PRS-02 — tren berisi satu titik per periode, bukan satu titik per dimensi', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const kpiId = kpiBerdimensi(ctx);
    new KpiService(ctx).captureScores(kpiId, SEBELUMNYA, BARIS_WILAYAH);
    new KpiService(ctx).captureScores(kpiId, PERIODE, BARIS_WILAYAH);

    const tren = new CockpitService(ctx).executive(PERIODE).kpis[0]!.trend;

    // Dua periode × tiga baris (dua wilayah + agregat) = 6 baris tersimpan. Sparkline
    // di Executive Cockpit menggambar `trend` apa adanya, jadi enam titik akan terbaca
    // sebagai enam periode.
    expect(tren).toHaveLength(2);
    expect(tren.map((t) => t.period)).toEqual([SEBELUMNYA, PERIODE]);
  });

  it('TC-PRS-03 — periode salah bentuk ditolak 400', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    expect(() => new CockpitService(ctx).executive('Juni 2026')).toThrow(
      expect.objectContaining({ status: 400, messageKey: 'error.invalid_period' }),
    );
  });

  it('TC-PRS-04 — KPI dari dataset belum tersertifikasi dikecualikan dan jumlahnya dilaporkan', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const datasets = new DatasetService(ctx);

    const draft = datasets.upload({ filename: 'draft.csv', content: Buffer.from(syntheticCsv({ rows: 40 })) });
    const tersertifikasi = datasets.upload({
      filename: 'resmi.csv',
      content: Buffer.from(syntheticCsv({ rows: 40 })),
    });
    datasets.certify(tersertifikasi.dataset.id, 'certified');

    const kpis = new KpiService(ctx);
    const dariDraft = kpiTanpaDimensi(ctx, { code: 'DRAFT', target: 4, datasetId: draft.dataset.id });
    const dariResmi = kpiTanpaDimensi(ctx, { code: 'RESMI', target: 4, datasetId: tersertifikasi.dataset.id });
    kpis.captureScores(dariDraft, PERIODE, [{ nilai: 4 }]);
    kpis.captureScores(dariResmi, PERIODE, [{ nilai: 4 }]);

    const cockpit = new CockpitService(ctx).executive(PERIODE);

    // PRD 6.1: Executive Cockpit HANYA dari dataset Certified. Yang dikecualikan tetap
    // dihitung supaya pembaca tahu gambarannya belum lengkap, bukan sekadar hilang.
    expect(cockpit.kpis.map((k) => k.id)).toEqual([dariResmi]);
    expect(cockpit.excludedUncertifiedCount).toBe(1);
    expect(cockpit.certifiedOnly).toBe(true);
  });

  it('TC-PRS-05 — skor keseluruhan ditimbang menurut weight tiap KPI', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const kpis = new KpiService(ctx);

    const berat = kpiTanpaDimensi(ctx, { code: 'BERAT', target: 4, weight: 3 });
    const ringan = kpiTanpaDimensi(ctx, { code: 'RINGAN', target: 10, weight: 1 });
    kpis.captureScores(berat, PERIODE, [{ nilai: 4 }]); // skor 100
    kpis.captureScores(ringan, PERIODE, [{ nilai: 2 }]); // skor 20

    // (100×3 + 20×1) / 4 = 80. Rata-rata sederhana akan memberi 60.
    expect(new CockpitService(ctx).executive(PERIODE).overallScore).toBeCloseTo(80, 2);
  });

  it('TC-PRS-06 — topRisks memuat hanya KPI di luar on_track, terburuk lebih dulu', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const kpis = new KpiService(ctx);

    const aman = kpiTanpaDimensi(ctx, { code: 'AMAN', target: 10, kritisDiBawah: 3 });
    const buruk = kpiTanpaDimensi(ctx, { code: 'BURUK', target: 10, kritisDiBawah: 6 });
    const terburuk = kpiTanpaDimensi(ctx, { code: 'TERBURUK', target: 10, kritisDiBawah: 6 });
    kpis.captureScores(aman, PERIODE, [{ nilai: 9 }]); // 90, on_track
    kpis.captureScores(buruk, PERIODE, [{ nilai: 5 }]); // 50, critical
    kpis.captureScores(terburuk, PERIODE, [{ nilai: 2 }]); // 20, critical

    const risks = new CockpitService(ctx).executive(PERIODE).topRisks;

    expect(risks.map((r) => r.score)).toEqual([20, 50]);
  });

  it('TC-PRS-07 — arah risiko dibaca dari dua periode terakhir, bukan dari nilai tunggal', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const kpis = new KpiService(ctx);

    const membaik = kpiTanpaDimensi(ctx, { code: 'MEMBAIK', target: 10, kritisDiBawah: 6 });
    const memburuk = kpiTanpaDimensi(ctx, { code: 'MEMBURUK', target: 10, kritisDiBawah: 6 });
    kpis.captureScores(membaik, SEBELUMNYA, [{ nilai: 2 }]); // 20
    kpis.captureScores(membaik, PERIODE, [{ nilai: 5 }]); // 50 → skor naik, risiko turun
    kpis.captureScores(memburuk, SEBELUMNYA, [{ nilai: 5 }]); // 50
    kpis.captureScores(memburuk, PERIODE, [{ nilai: 2 }]); // 20 → skor turun, risiko naik

    const risks = new CockpitService(ctx).executive(PERIODE).topRisks;
    const arah = new Map(risks.map((r) => [r.label, r.trendKey]));

    expect(arah.get('KPI MEMBAIK')).toBe('falling');
    expect(arah.get('KPI MEMBURUK')).toBe('rising');
  });

  it('TC-PRS-08 — modul di luar paket berperilaku seolah tidak ada', () => {
    const tenant = provisionTenant(harness, { planCode: 'starter', slug: 'prsstarter' });
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    expect(() => new CockpitService(ctx).executive(PERIODE)).toThrow(
      expect.objectContaining({ status: 403, messageKey: 'error.module_not_in_plan' }),
    );
  });
});

describe('Operational Cockpit — cakupan per divisi & RLS', () => {
  function siapkan(): { admin: RequestContext; tenantId: string; kpiId: string } {
    const tenant = provisionTenant(harness);
    const admin = contextFor(harness, tenant.tenantId, ['super_admin']);
    const kpiId = kpiBerdimensi(admin);
    new KpiService(admin).captureScores(kpiId, PERIODE, BARIS_WILAYAH);
    return { admin, tenantId: tenant.tenantId, kpiId };
  }

  it('TC-PRS-09 — permintaan per divisi memakai baris divisi itu saja', () => {
    const { admin } = siapkan();
    const hasil = new CockpitService(admin).operational(PERIODE, 'Wilayah Barat');

    expect(hasil.kpis).toHaveLength(1);
    expect(hasil.kpis[0]!.value).toBeCloseTo(3.1, 5);
    expect(hasil.kpis[0]!.dimensionScope).toBe('Wilayah Barat');
  });

  it('TC-PRS-10 — pengguna ber-RLS tidak menerima agregat lintas dimensi', () => {
    const { tenantId } = siapkan();
    const analis = contextFor(harness, tenantId, ['business_analyst'], { rls: TIMUR });

    const hasil = new CockpitService(analis).operational(PERIODE);

    // Agregat 3,90 mencakup Barat. Pengguna yang hanya berhak atas Timur harus menerima
    // angka Timur (4,70) — dan penandanya, supaya tidak terbaca sebagai angka organisasi.
    expect(hasil.kpis[0]!.value).toBeCloseTo(4.7, 5);
    expect(hasil.kpis[0]!.dimensionScope).toBe('Wilayah Timur');
    expect(hasil.rlsApplied).toBe(true);
    expect(hasil.rlsDimensions).toEqual(['wilayah']);
  });

  it('TC-PRS-11 — pengguna ber-RLS tidak dapat meminta divisi di luar cakupannya', () => {
    const { tenantId } = siapkan();
    const analis = contextFor(harness, tenantId, ['business_analyst'], { rls: TIMUR });

    // Parameter query adalah masukan pengguna; menukarnya tidak boleh memberi data
    // wilayah lain (TESTING.md Bagian 4).
    const hasil = new CockpitService(analis).operational(PERIODE, 'Wilayah Barat');
    expect(hasil.kpis).toHaveLength(0);
  });

  it('TC-PRS-12 — RLS pada dua dimensi tidak meloloskan baris apa pun (fail secure)', () => {
    const { tenantId } = siapkan();
    // `kpi_score_history` menyimpan satu kolom dimensi per baris, sehingga cakupan pada
    // dua dimensi tidak dapat dipenuhi baris mana pun. Yang benar adalah menolak, bukan
    // mengabaikan aturan kedua dan meloloskan berdasarkan yang pertama saja.
    const analis = contextFor(harness, tenantId, ['business_analyst'], {
      rls: [
        { dimension: 'wilayah', operator: 'in', values: ['Wilayah Timur'] },
        { dimension: 'divisi', operator: 'in', values: ['Operasional'] },
      ],
    });

    expect(new CockpitService(analis).operational(PERIODE).kpis).toHaveLength(0);
  });

  it('TC-PRS-13 — status RLS dilaporkan apa adanya untuk pengguna tanpa batas', () => {
    const { admin } = siapkan();
    const hasil = new CockpitService(admin).operational(PERIODE);
    expect(hasil.rlsApplied).toBe(false);
    expect(hasil.rlsDimensions).toEqual([]);
    expect(hasil.division).toBeNull();
  });

  it('TC-PRS-14 — hanya alert yang belum ditindaklanjuti yang muncul', () => {
    const { admin, tenantId, kpiId } = siapkan();
    const at = new Date().toISOString();
    harness.db
      .prepare(
        `INSERT INTO alert_rules (id, tenant_id, name, kpi_id, asset_id, sensor_code, comparator, threshold,
                                  channels_json, recipients_json, enabled, cooldown_minutes, created_at)
         VALUES (?,?,?,?,NULL,NULL,'lt',4.0,'["email"]','["ops@uji.test"]',1,60,?)`,
      )
      .run('ar_uji', tenantId, 'CSAT di bawah target', kpiId, at);

    const event = (id: string, ack: string | null): void => {
      harness.db
        .prepare(
          `INSERT INTO alert_events (id, tenant_id, rule_id, detected_at, observed_value, severity,
                                     message_key, context_json, acknowledged_by, acknowledged_at, follow_up_note)
           VALUES (?,?,?,?,3.1,'critical','alert.kpi_breach',NULL,?,?,NULL)`,
        )
        .run(id, tenantId, 'ar_uji', at, ack ? 'usr' : null, ack);
    };
    event('ae_terbuka', null);
    event('ae_selesai', at);

    const hasil = new CockpitService(admin).operational(PERIODE);

    expect(hasil.openAlerts.map((a) => a.id)).toEqual(['ae_terbuka']);
    expect(hasil.openAlerts[0]!.label).toBe('CSAT di bawah target');
  });
});

describe('Balanced Scorecard — PRD 6.25', () => {
  function siapkan(): { ctx: RequestContext; tenantId: string } {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    new BalancedScorecardService(ctx).seedStandardPerspectives();
    return { ctx, tenantId: tenant.tenantId };
  }

  function perspektif(ctx: RequestContext, code: string): string {
    return (
      harness.db.prepare('SELECT id FROM bsc_perspectives WHERE code = ?').get(code) as { id: string }
    ).id;
  }

  it('TC-PRS-15 — menyiapkan empat perspektif standar bersifat idempoten', () => {
    const { ctx } = siapkan();
    new BalancedScorecardService(ctx).seedStandardPerspectives();
    new BalancedScorecardService(ctx).seedStandardPerspectives();

    const jumlah = harness.db.prepare('SELECT COUNT(*) AS n FROM bsc_perspectives').get() as { n: number };
    expect(jumlah.n).toBe(4);
  });

  it('TC-PRS-16 — sasaran wajib merujuk KPI yang benar-benar ada di KPI Center', () => {
    const { ctx } = siapkan();
    // PRD 6.25: tidak ada definisi KPI terpisah untuk BSC. Sasaran yang menunjuk KPI
    // fiktif akan memberi scorecard yang skornya tidak dapat dilacak ke mana pun.
    expect(() =>
      new BalancedScorecardService(ctx).addObjective({
        perspectiveId: perspektif(ctx, 'financial'),
        name: 'Pendapatan tumbuh',
        kpiId: 'kpi_tidak_ada',
      }),
    ).toThrow(expect.objectContaining({ messageKey: 'error.kpi_unknown' }));
  });

  it('TC-PRS-17 — sasaran pada perspektif tak dikenal ditolak 404', () => {
    const { ctx } = siapkan();
    expect(() =>
      new BalancedScorecardService(ctx).addObjective({ perspectiveId: 'bsp_hantu', name: 'Sasaran' }),
    ).toThrow(NotFoundError);
  });

  it('TC-PRS-18 — skor komposit ditimbang antar-perspektif', () => {
    const { ctx } = siapkan();
    const bsc = new BalancedScorecardService(ctx);
    const kpis = new KpiService(ctx);

    const finansial = kpiTanpaDimensi(ctx, { code: 'FIN', target: 10 });
    const pelanggan = kpiTanpaDimensi(ctx, { code: 'CUS', target: 10 });
    kpis.captureScores(finansial, PERIODE, [{ nilai: 10 }]); // 100
    kpis.captureScores(pelanggan, PERIODE, [{ nilai: 5 }]); // 50

    bsc.addObjective({ perspectiveId: perspektif(ctx, 'financial'), name: 'Laba', kpiId: finansial });
    bsc.addObjective({ perspectiveId: perspektif(ctx, 'customer'), name: 'Retensi', kpiId: pelanggan });

    const card = bsc.scorecard(PERIODE);

    // Bobot standar: financial 0,30 · customer 0,25 · dua perspektif lain 0,45 tanpa skor.
    // Perspektif tanpa sasaran berskor 0 dan tetap ikut membagi — inilah yang membedakan
    // "belum diisi" dari "tidak dihitung".
    expect(card.compositeScore).toBeCloseTo((100 * 0.3 + 50 * 0.25) / 1, 2);
    expect(card.certifiedOnly).toBe(true);
  });

  it('TC-PRS-19 — sasaran dari dataset belum tersertifikasi tidak diberi skor', () => {
    const { ctx } = siapkan();
    const bsc = new BalancedScorecardService(ctx);
    const draft = new DatasetService(ctx).upload({
      filename: 'draft.csv',
      content: Buffer.from(syntheticCsv({ rows: 40 })),
    });
    const kpiId = kpiTanpaDimensi(ctx, { code: 'DRF', target: 10, datasetId: draft.dataset.id });
    new KpiService(ctx).captureScores(kpiId, PERIODE, [{ nilai: 10 }]);

    bsc.addObjective({ perspectiveId: perspektif(ctx, 'financial'), name: 'Laba', kpiId });
    const card = bsc.scorecard(PERIODE);
    const sasaran = card.perspectives.find((p) => p.code === 'financial')!.objectives[0]!;

    // Skornya ADA di KPI Center, tetapi tidak layak tampil di scorecard resmi. Yang benar
    // adalah kosong dengan KPI tetap tertera, bukan angka tanpa keterangan asal.
    expect(sasaran.kpiId).toBe(kpiId);
    expect(sasaran.achievement).toBeNull();
    expect(sasaran.status).toBeNull();
  });

  it('TC-PRS-20 — perbandingan periode lain disertakan bila diminta', () => {
    const { ctx } = siapkan();
    const bsc = new BalancedScorecardService(ctx);
    const kpiId = kpiTanpaDimensi(ctx, { code: 'CMP', target: 10 });
    new KpiService(ctx).captureScores(kpiId, SEBELUMNYA, [{ nilai: 4 }]); // 40
    new KpiService(ctx).captureScores(kpiId, PERIODE, [{ nilai: 8 }]); // 80
    bsc.addObjective({ perspectiveId: perspektif(ctx, 'financial'), name: 'Laba', kpiId });

    const card = bsc.scorecard(PERIODE, { comparePeriod: SEBELUMNYA });

    expect(card.comparison).not.toBeNull();
    expect(card.comparison!.period).toBe(SEBELUMNYA);
    // Pembanding hanya menghitung perspektif yang punya skor, jadi angkanya 40 utuh.
    expect(card.comparison!.compositeScore).toBeCloseTo(40, 2);
    expect(bsc.scorecard(PERIODE).comparison).toBeNull();
  });

  it('TC-PRS-21 — strategy map memuat simpul sasaran dan sisi sebab-akibat', () => {
    const { ctx } = siapkan();
    const bsc = new BalancedScorecardService(ctx);
    const pertumbuhan = bsc.addObjective({
      perspectiveId: perspektif(ctx, 'learning_growth'),
      name: 'Kompetensi tim naik',
    });
    bsc.addObjective({
      perspectiveId: perspektif(ctx, 'financial'),
      name: 'Laba tumbuh',
      causes: [pertumbuhan.id],
    });

    const map = bsc.strategyMap();

    expect(map.nodes).toHaveLength(2);
    expect(map.nodes.map((n) => n.perspective).sort()).toEqual(['financial', 'learning_growth']);
    expect(map.edges).toEqual([{ from: expect.any(String), to: pertumbuhan.id }]);
  });

  it('TC-PRS-22 — cascade menurunkan perspektif ke level divisi dengan tautan ke induk', () => {
    const { ctx } = siapkan();
    const induk = perspektif(ctx, 'financial');
    const hasil = new BalancedScorecardService(ctx).cascade(induk, 'Divisi Operasional');

    expect(hasil.created).toBe(1);
    const turunan = harness.db
      .prepare("SELECT code, name, weight, scorecard_level, parent_scorecard FROM bsc_perspectives WHERE scorecard_level = 'division'")
      .get() as { code: string; name: string; weight: number; scorecard_level: string; parent_scorecard: string };

    // Keterkaitan harus TERLIHAT: scorecard divisi yang tidak dapat dilacak ke perspektif
    // korporat menghilangkan seluruh gunanya cascading (PRD 6.25).
    expect(turunan.parent_scorecard).toBe(induk);
    expect(turunan.code).toBe('financial_divisi_operasional');
    expect(turunan.name).toContain('Divisi Operasional');

    // Level korporat tidak boleh ikut berubah.
    expect(new BalancedScorecardService(ctx).scorecard(PERIODE).perspectives).toHaveLength(4);
  });

  it('TC-PRS-23 — cascade dari perspektif tak dikenal ditolak 404', () => {
    const { ctx } = siapkan();
    expect(() => new BalancedScorecardService(ctx).cascade('bsp_hantu', 'Divisi')).toThrow(NotFoundError);
  });

  it('TC-PRS-24 — tenant baca-saja tidak dapat mengubah scorecard, tetapi tetap dapat membacanya', () => {
    const tenant = provisionTenant(harness, { slug: 'prsbacasaja' });
    const awal = contextFor(harness, tenant.tenantId, ['super_admin']);
    new BalancedScorecardService(awal).seedStandardPerspectives();
    const induk = perspektif(awal, 'financial');

    harness.db.prepare("UPDATE tenants SET status = 'read_only' WHERE id = ?").run(tenant.tenantId);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const bsc = new BalancedScorecardService(ctx);

    // Tunggakan menghentikan penulisan, bukan akses ke data yang sudah ada (SECURITY.md 16.4)
    // — mengunci laporan yang sudah dibayar akan menghukum hal yang salah.
    expect(() => bsc.addPerspective({ code: 'x', name: 'X', weight: 0.1 })).toThrow(
      expect.objectContaining({ status: 403, messageKey: 'error.tenant_read_only' }),
    );
    expect(() => bsc.addObjective({ perspectiveId: induk, name: 'Sasaran' })).toThrow(
      expect.objectContaining({ messageKey: 'error.tenant_read_only' }),
    );
    expect(() => bsc.cascade(induk, 'Divisi')).toThrow(
      expect.objectContaining({ messageKey: 'error.tenant_read_only' }),
    );
    expect(bsc.scorecard(PERIODE).perspectives).toHaveLength(4);
  });
});
