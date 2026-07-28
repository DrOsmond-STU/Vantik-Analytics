/**
 * Test case yang diterjemahkan langsung dari checklist kriteria penerimaan PRD
 * Bagian 6 — TESTING.md Bagian 1 & 3 ("setiap `- [ ]` PRD ADALAH kandidat test case").
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  contextFor, createHarness, createUser, fingerprint, provisionTenant, syntheticCsv, TEST_PASSWORD, type Harness,
} from './helpers.ts';
import { DatasetService } from '../src/data-platform-service/datasets.ts';
import { ConnectionService } from '../src/data-platform-service/connections.ts';
import { KpiService, evaluateStatus, scoreAgainstTarget } from '../src/data-platform-service/kpi.ts';
import { evaluateFormula, tokenizeFormula } from '../src/data-platform-service/modeling.ts';
import { assessQuality, CERTIFICATION_THRESHOLD, countDuplicateRows } from '../src/data-platform-service/dataQuality.ts';
import { detectColumnType, parseCsv, scanForMalware, validateFilename, MAX_UPLOAD_BYTES } from '../src/data-platform-service/csv.ts';
import { AlertService, QueueOnlyTransport } from '../src/alerting-service/index.ts';
import { NotificationOutbox } from '../src/platform/outbox.ts';
import { DashboardService, EmbedRenderer, EmbedService } from '../src/designer-service/index.ts';
import { VISUALIZATION_CATALOG } from '../src/designer-service/visualizations.ts';
import { computeHealthScore, classifyReading, DigitalTwinService } from '../src/iot-gateway-service/index.ts';
import { MeteringService } from '../src/metering-service/index.ts';
import { assessTravel, matchDevice, fingerprintHash, hashComponents } from '../src/identity-service/deviceFingerprint.ts';
import { ConflictError, ValidationError } from '../src/platform/errors.ts';
import { open, seal } from '../src/platform/crypto.ts';

let harness: Harness;
beforeEach(() => {
  harness = createHarness();
});
afterEach(() => harness.cleanup());

/* ================= PRD 6.11 Dataset — TESTING.md Bagian 3 ================= */

describe('Dataset (Upload CSV) — PRD 6.11', () => {
  it('TC-DS-01 — unggah CSV valid menghasilkan dataset berstatus siap', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const result = new DatasetService(ctx).upload({
      filename: 'penelitian_kepuasan.csv',
      content: Buffer.from(syntheticCsv({ rows: 20 })),
    });

    expect(result.dataset.status).toBe('ready');
    expect(result.dataset.row_count).toBe(20);
    expect(result.dataset.certification).toBe('draft');
  });

  it('TC-DS-02 — unggah melebihi batas ukuran ditolak dengan kunci error.upload_failed', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    // Buffer besar tanpa mengalokasikan 200MB nyata: gunakan objek dengan length palsu
    // tidak mungkin, jadi verifikasi ambangnya langsung.
    expect(MAX_UPLOAD_BYTES).toBe(200 * 1024 * 1024);

    const oversize = Buffer.alloc(1024);
    Object.defineProperty(oversize, 'length', { value: MAX_UPLOAD_BYTES + 1 });
    expect(() => new DatasetService(ctx).upload({ filename: 'besar.csv', content: oversize })).toThrow(
      /upload_failed/,
    );
  });

  it('TC-DS-03 — ekstensi tersamar (data.csv.exe) ditolak pada validasi tipe berkas', () => {
    expect(validateFilename('data.csv.exe').ok).toBe(false);
    expect(validateFilename('data.exe.csv').ok).toBe(false);
    expect(validateFilename('laporan.csv').ok).toBe(true);
    expect(validateFilename('laporan.xlsx').ok).toBe(true);
    expect(validateFilename('skrip.sh').ok).toBe(false);
  });

  it('TC-DS-04 — deteksi tipe kolom otomatis mengenali tanggal, bukan teks', () => {
    expect(detectColumnType(['2026-07-24', '2026-07-25', '2026-07-26'])).toBe('date');
    expect(detectColumnType(['24/07/2026', '25/07/2026'])).toBe('date');
    expect(detectColumnType(['12.480', '9.870', '1.200'])).toBe('number');
    expect(detectColumnType(['Chat', 'Email', 'Telepon'])).toBe('text');
    expect(detectColumnType(['ya', 'tidak', 'ya'])).toBe('boolean');
    // Satu sel kosong tidak boleh menjatuhkan kolom tanggal ke text.
    expect(detectColumnType(['2026-07-24', '', '2026-07-26'])).toBe('date');
  });

  it('TC-DS-05 — jejak audit muncul setelah unggah berhasil', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    new DatasetService(ctx).upload({ filename: 'audit.csv', content: Buffer.from(syntheticCsv({ rows: 5 })) });

    const { rows } = harness.audit.query(tenant.tenantId, { action: 'dataset.upload' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_user_id).toBe(ctx.actor.userId);
    expect(rows[0]!.module).toBe('Dataset');
  });

  it('TC-DS-06 — berkas dengan tanda tangan eksekusi ditolak pemindaian malware', () => {
    expect(scanForMalware(Buffer.from([0x4d, 0x5a, 0x90, 0x00])).clean).toBe(false);
    expect(scanForMalware(Buffer.from([0x7f, 0x45, 0x4c, 0x46])).clean).toBe(false);
    expect(scanForMalware(Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')).clean).toBe(false);
    expect(scanForMalware(Buffer.from('wilayah,nilai\nTimur,10')).clean).toBe(true);
  });

  it('TC-DS-07 — kegagalan validasi tercatat dengan alasan yang dapat ditelusuri', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    expect(() => new DatasetService(ctx).upload({ filename: 'jahat.csv.exe', content: Buffer.from('a,b\n1,2') })).toThrow();

    const failed = new DatasetService(ctx).list({ status: 'failed' });
    expect(failed).toHaveLength(1);
    expect(failed[0]!.failure_reason_key).toBe('error.upload_disguised_extension');
  });

  it('TC-DS-08 — CSV dengan header duplikat ditolak', () => {
    expect(() => parseCsv('a,a\n1,2')).toThrow(/duplicate_headers/);
  });
});

/* ================= PRD 6.14 Data Quality Center ================= */

describe('Data Quality Center — PRD 6.14 & TESTING.md Bagian 5', () => {
  it('TC-DQ-01 — mendeteksi PERSIS proporsi kesalahan yang disengaja', () => {
    const csv = syntheticCsv({ rows: 100, duplicateRows: 7, missingCells: 5, invalidCells: 3 });
    const parsed = parseCsv(csv);
    const report = assessQuality(parsed.rows, parsed.columns);

    // 7 duplikat disisipkan; tidak under-detect maupun over-detect.
    expect(report.duplicateRows).toBe(7);
    expect(report.missingCells).toBe(5);
    expect(report.invalidCells).toBe(3);
    expect(report.rowsChecked).toBe(115);
  });

  it('TC-DQ-02 — skor stabil untuk input yang sama (uji regresi aturan deteksi)', () => {
    const csv = syntheticCsv({ rows: 50, duplicateRows: 5 });
    const first = assessQuality(parseCsv(csv).rows, parseCsv(csv).columns);
    const second = assessQuality(parseCsv(csv).rows, parseCsv(csv).columns);
    expect(first.score).toBe(second.score);
  });

  it('TC-DQ-03 — dataset di bawah ambang batas tidak dapat disertifikasi', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);

    // Dataset yang sebagian besar SELNYA bermasalah — bukan sekadar beberapa baris
    // buruk di tabel lebar, karena skor dihitung terhadap proporsi sel.
    const lines = ['wilayah,kanal,jumlah_tiket,skor_csat'];
    for (let i = 0; i < 60; i++) lines.push(`,,,`); // seluruh sel kosong
    for (let i = 0; i < 20; i++) lines.push(`Timur,Chat,bukan-angka,juga-bukan-angka`);
    for (let i = 0; i < 20; i++) lines.push('Timur,Chat,10,4.5'); // baris identik → duplikat

    const uploaded = new DatasetService(ctx).upload({
      filename: 'buruk.csv',
      content: Buffer.from(lines.join('\n')),
    });

    expect(uploaded.quality.score).toBeLessThan(CERTIFICATION_THRESHOLD);
    expect(uploaded.quality.certifiable).toBe(false);
    expect(() => new DatasetService(ctx).certify(uploaded.dataset.id, 'certified')).toThrow(ConflictError);
  });

  it('TC-DQ-04 — dataset bersih dapat disertifikasi Data Steward', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const uploaded = new DatasetService(ctx).upload({
      filename: 'bersih.csv',
      content: Buffer.from(syntheticCsv({ rows: 40 })),
    });
    const certified = new DatasetService(ctx).certify(uploaded.dataset.id, 'certified');
    expect(certified.certification).toBe('certified');
  });

  it('TC-DQ-05 — penghitung duplikat menghitung kemunculan setelah yang pertama', () => {
    const rows = [{ a: '1' }, { a: '1' }, { a: '1' }, { a: '2' }];
    expect(countDuplicateRows(rows, ['a'])).toBe(2);
  });
});

/* ================= PRD 6.12 Koneksi Eksternal ================= */

describe('Koneksi Eksternal — PRD 6.12 & SECURITY.md Bagian 8', () => {
  it('TC-CN-01 — kredensial tersimpan terenkripsi dan tidak pernah dikembalikan sebagai teks biasa', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const service = new ConnectionService(ctx, harness.keyring);

    const created = service.create({
      name: 'DWH Produksi',
      kind: 'postgresql',
      host: 'db.internal',
      databaseName: 'analytics',
      username: 'readonly',
      secrets: { password: 'SangatRahasia123!' },
    });

    // Hanya NAMA field yang dikembalikan, bukan nilainya.
    expect(created.secret_fields).toEqual(['password']);
    expect(JSON.stringify(created)).not.toContain('SangatRahasia123!');

    // Ciphertext tersimpan di vault, bukan plaintext.
    const stored = harness.db
      .prepare('SELECT ciphertext FROM vault.connection_secrets WHERE connection_id = ?')
      .get(created.id) as { ciphertext: string };
    expect(stored.ciphertext).not.toContain('SangatRahasia123!');
  });

  it('TC-CN-02 — vault berada di berkas basis data terpisah', () => {
    const databases = harness.db.pragma('database_list') as Array<{ name: string; file: string }>;
    const main = databases.find((d) => d.name === 'main')!;
    const vault = databases.find((d) => d.name === 'vault')!;
    expect(vault.file).not.toBe(main.file);
  });

  it('TC-CN-03 — enkripsi bolak-balik menghasilkan nilai asli', () => {
    const sealed = seal(harness.keyring, 'api-key-rahasia');
    expect(sealed.ciphertext).not.toContain('api-key-rahasia');
    expect(open(harness.keyring, sealed)).toBe('api-key-rahasia');
  });

  it('TC-CN-04 — kegagalan berulang mengunci koneksi sementara', async () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const service = new ConnectionService(ctx, harness.keyring);

    // Kredensial sengaja tidak lengkap → uji koneksi gagal.
    const created = service.create({ name: 'Gagal', kind: 'postgresql', host: 'x', databaseName: 'y', username: 'z' });
    for (let i = 0; i < 3; i++) await service.testConnection(created.id);

    expect(service.get(created.id).status).toBe('locked');
    await expect(service.testConnection(created.id)).rejects.toThrow(/connection_locked/);
  });

  it('TC-CN-05 — jenis koneksi wajib termasuk lima yang disyaratkan PRD', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const service = new ConnectionService(ctx, harness.keyring);
    for (const kind of ['rest_api', 'postgresql', 'mysql', 'oracle', 'google_sheets'] as const) {
      expect(() => service.create({ name: `k-${kind}`, kind, host: 'h', databaseName: 'd', username: 'u' })).not.toThrow();
    }
  });
});

/* ================= PRD 6.13 Data Modeling — Formula Builder ================= */

describe('Data Modeling — PRD 6.13', () => {
  it('TC-DM-01 — Formula Builder menghitung metrik turunan tanpa SQL', () => {
    const rows = [
      { pendapatan: 100, biaya: 40 },
      { pendapatan: 200, biaya: 60 },
    ];
    expect(evaluateFormula('SUM(pendapatan) - SUM(biaya)', rows)).toBe(200);
    expect(evaluateFormula('AVG(pendapatan)', rows)).toBe(150);
    expect(evaluateFormula('MAX(pendapatan)', rows)).toBe(200);
    expect(evaluateFormula('COUNT(pendapatan)', rows)).toBe(2);
  });

  it('TC-DM-02 — formula tidak dievaluasi sebagai kode (mitigasi injeksi)', () => {
    expect(() => tokenizeFormula('process.exit(1)')).toThrow(/unknown_function/);
    expect(() => evaluateFormula('SUM(a) + )', [{ a: 1 }])).toThrow();
  });

  it('TC-DM-03 — pembagian nol menghasilkan 0, bukan Infinity', () => {
    expect(evaluateFormula('SUM(a) / SUM(b)', [{ a: 10, b: 0 }])).toBe(0);
  });
});

/* ================= PRD 6.15 KPI Center ================= */

describe('KPI Center — PRD 6.15', () => {
  it('TC-KPI-01 — status dihitung dari ambang batas, critical menang atas at_risk', () => {
    const thresholds = [
      { id: '1', kpi_id: 'k', level: 'critical' as const, comparator: 'lte' as const, value: 3.5 },
      { id: '2', kpi_id: 'k', level: 'at_risk' as const, comparator: 'lte' as const, value: 4.0 },
    ];
    expect(evaluateStatus(3.2, thresholds)).toBe('critical');
    expect(evaluateStatus(3.8, thresholds)).toBe('at_risk');
    expect(evaluateStatus(4.6, thresholds)).toBe('on_track');
  });

  it('TC-KPI-02 — arah lower_better dibalik agar 100 selalu berarti terbaik', () => {
    // Waktu respons 8 menit dengan target 8 → skor penuh.
    expect(scoreAgainstTarget(8, 8, 'lower_better')).toBe(100);
    // Waktu respons 16 menit (dua kali target) → skor separuh.
    expect(scoreAgainstTarget(16, 8, 'lower_better')).toBe(50);
    expect(scoreAgainstTarget(4, 8, 'higher_better')).toBe(50);
  });

  it('TC-KPI-03 — perubahan definisi melalui alur persetujuan, tidak langsung berlaku', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const service = new KpiService(ctx);
    const kpi = service.create({ code: 'K1', name: 'KPI Uji', formula: 'SUM(x)', target: 100 });

    service.proposeChange(kpi.id, { target: 200 });
    const pending = ctx.db.get<{ state: string; target: number }>('kpi_definition', { id: kpi.id })!;
    expect(pending.state).toBe('pending_approval');
    expect(pending.target).toBe(100); // definisi lama masih berlaku
  });

  it('TC-KPI-04 — pengaju tidak dapat menyetujui perubahannya sendiri', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const service = new KpiService(ctx);
    const kpi = service.create({ code: 'K2', name: 'KPI Uji 2', formula: 'SUM(x)' });
    const approvalId = service.proposeChange(kpi.id, { target: 50 });

    expect(() => service.decideChange(approvalId, 'approved')).toThrow(/cannot_approve_own_change/);
  });
});

/* ================= PRD 6.16 Alert Center ================= */

describe('Alert Center — PRD 6.16', () => {
  it('TC-AL-01 — mendukung enam kanal notifikasi yang disyaratkan', async () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const transport = new QueueOnlyTransport();
    const service = new AlertService(ctx, transport);
    const kpi = new KpiService(ctx).create({ code: 'A1', name: 'Alert KPI', formula: 'SUM(x)' });

    service.createRule({
      name: 'Semua kanal',
      kpiId: kpi.id,
      comparator: 'gte',
      threshold: 10,
      channels: ['email', 'whatsapp', 'telegram', 'sms', 'teams', 'slack'],
      recipients: ['ops@test.id'],
    });

    await service.evaluate({ kpiId: kpi.id, value: 20, label: 'Alert KPI' });
    expect(transport.sent.map((s) => s.channel).sort()).toEqual(
      ['email', 'slack', 'sms', 'teams', 'telegram', 'whatsapp'],
    );
  });

  it('TC-AL-02 — cooldown mencegah notifikasi ganda untuk penyimpangan yang sama', async () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const transport = new QueueOnlyTransport();
    const service = new AlertService(ctx, transport);
    const kpi = new KpiService(ctx).create({ code: 'A2', name: 'Alert KPI 2', formula: 'SUM(x)' });

    service.createRule({
      name: 'Cooldown',
      kpiId: kpi.id,
      comparator: 'gte',
      threshold: 10,
      channels: ['email'],
      recipients: ['ops@test.id'],
      cooldownMinutes: 60,
    });

    await service.evaluate({ kpiId: kpi.id, value: 20, label: 'x' });
    await service.evaluate({ kpiId: kpi.id, value: 21, label: 'x' });
    expect(transport.sent).toHaveLength(1);
  });

  it('TC-AL-03 — nilai di bawah ambang tidak memicu notifikasi', async () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const transport = new QueueOnlyTransport();
    const service = new AlertService(ctx, transport);
    const kpi = new KpiService(ctx).create({ code: 'A3', name: 'Alert KPI 3', formula: 'SUM(x)' });

    service.createRule({ name: 'Tidak terpicu', kpiId: kpi.id, comparator: 'gte', threshold: 100, channels: ['email'], recipients: ['a@b.c'] });
    const triggered = await service.evaluate({ kpiId: kpi.id, value: 5, label: 'x' });
    expect(triggered).toHaveLength(0);
    expect(transport.sent).toHaveLength(0);
  });

  it('TC-AL-04 — notifikasi yang tidak terkirim menunggu di outbox LENGKAP DENGAN ISINYA', async () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const outbox = new NotificationOutbox(harness.db);
    const service = new AlertService(ctx, new QueueOnlyTransport(), outbox);
    const kpi = new KpiService(ctx).create({ code: 'A4', name: 'CSAT', formula: 'AVG(x)', target: 4.5 });

    service.createRule({
      name: 'CSAT di bawah ambang',
      kpiId: kpi.id,
      comparator: 'lte',
      threshold: 4,
      channels: ['email'],
      recipients: ['ops@test.id'],
    });
    await service.evaluate({ kpiId: kpi.id, value: 3.6, label: 'CSAT bulan berjalan' });

    // `alert_deliveries` mencatat PERCOBAAN pengiriman tetapi tidak menyimpan badan pesan.
    // Panduan pemasangan menjanjikan operator dapat membaca pesan tertunda dan
    // menyampaikannya lewat kanal terpercaya selama belum ada transport nyata — janji itu
    // hanya benar bila isinya benar-benar ada di suatu tempat yang dapat dibaca.
    const pending = outbox.pending(tenant.tenantId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.purpose).toBe('alert_notification');
    expect(pending[0]!.recipient).toBe('ops@test.id');
    expect(pending[0]!.body).toContain('3.6');
    expect(pending[0]!.body).toContain('4');

    // Statusnya `queued`, bukan `sent`: tidak ada yang terkirim.
    expect(outbox.counts(tenant.tenantId).queued).toBe(1);
    expect(outbox.counts(tenant.tenantId).sent).toBe(0);
  });
});

/* ================= PRD 6.5 & 6.21 Visualisasi & Embed ================= */

describe('Interactive Visualization & Embed Dashboard', () => {
  it('TC-VIZ-01 — katalog visual memenuhi minimal 80 jenis (PRD 6.5)', () => {
    expect(VISUALIZATION_CATALOG.length).toBeGreaterThanOrEqual(80);
  });

  it('TC-VIZ-02 — katalog mencakup visual geospasial titik, choropleth, dan density', () => {
    const codes = VISUALIZATION_CATALOG.map((v) => v.code);
    expect(codes).toContain('geo_point');
    expect(codes).toContain('choropleth');
    expect(codes).toContain('density_map');
  });

  it('TC-EMB-01 — dashboard Restricted tidak dapat disematkan sama sekali', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const dashboards = new DashboardService(ctx);
    const dashboard = dashboards.create({ name: 'Rahasia', classification: 'restricted' });
    dashboards.saveDraft(dashboard.id, []);
    dashboards.publish(dashboard.id);

    expect(() =>
      new EmbedService(ctx).issue({ dashboardId: dashboard.id, domainWhitelist: ['https://example.org'] }),
    ).toThrow(/restricted_cannot_embed/);
  });

  it('TC-EMB-02 — permintaan dari domain di luar whitelist ditolak dan tercatat', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const dashboards = new DashboardService(ctx);
    const dashboard = dashboards.create({ name: 'Publik' });
    dashboards.saveDraft(dashboard.id, []);
    dashboards.publish(dashboard.id);

    const issued = new EmbedService(ctx).issue({
      dashboardId: dashboard.id,
      domainWhitelist: ['https://mitra.example.org'],
    });

    const renderer = new EmbedRenderer(harness.db, harness.audit);
    const denied = renderer.render({ token: issued.token, origin: 'https://penyusup.example.net', ip: '198.51.100.4' });
    expect(denied.ok).toBe(false);

    const allowed = renderer.render({ token: issued.token, origin: 'https://mitra.example.org', ip: '198.51.100.4' });
    expect(allowed.ok).toBe(true);

    const { rows } = harness.audit.query(tenant.tenantId, { module: 'Embed Dashboard', outcome: 'denied' });
    expect(rows.length).toBeGreaterThan(0);
  });

  it('TC-EMB-03 — pencabutan berlaku pada permintaan berikutnya', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const dashboards = new DashboardService(ctx);
    const dashboard = dashboards.create({ name: 'Cabut' });
    dashboards.saveDraft(dashboard.id, []);
    dashboards.publish(dashboard.id);

    const embed = new EmbedService(ctx);
    const issued = embed.issue({ dashboardId: dashboard.id, domainWhitelist: ['https://mitra.example.org'] });
    const renderer = new EmbedRenderer(harness.db, harness.audit);

    expect(renderer.render({ token: issued.token, origin: 'https://mitra.example.org', ip: null }).ok).toBe(true);
    embed.revoke(issued.tokenId);
    expect(renderer.render({ token: issued.token, origin: 'https://mitra.example.org', ip: null }).ok).toBe(false);
  });

  it('TC-EMB-04 — tampilan sematan tidak pernah mengizinkan ekspor & memasang frame-ancestors', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const dashboards = new DashboardService(ctx);
    const dashboard = dashboards.create({ name: 'Sematan' });
    dashboards.saveDraft(dashboard.id, []);
    dashboards.publish(dashboard.id);

    const issued = new EmbedService(ctx).issue({
      dashboardId: dashboard.id,
      domainWhitelist: ['https://mitra.example.org'],
      rlsScope: [{ dimension: 'wilayah', operator: 'in', values: ['Wilayah Timur'] }],
    });

    const result = new EmbedRenderer(harness.db, harness.audit).render({
      token: issued.token,
      origin: 'https://mitra.example.org',
      ip: null,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canExport).toBe(false);
      expect(result.frameAncestors).toContain('https://mitra.example.org');
      // RLS diwariskan dan dievaluasi ulang di server dari token.
      expect(result.rlsScope[0]!.values).toEqual(['Wilayah Timur']);
    }
  });

  it('TC-EMB-05 — dashboard yang belum dipublikasikan tidak dapat disematkan', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const dashboard = new DashboardService(ctx).create({ name: 'Draf' });
    expect(() =>
      new EmbedService(ctx).issue({ dashboardId: dashboard.id, domainWhitelist: ['https://a.example.org'] }),
    ).toThrow(/dashboard_not_published/);
  });
});

/* ================= PRD 6.30 Device Binding ================= */

describe('Manajemen Perangkat & Sesi — PRD 6.30, SECURITY.md 17', () => {
  it('TC-DEV-01 — perangkat pertama yang login otomatis didaftarkan', () => {
    const tenant = provisionTenant(harness, { slug: 'devbind1' });
    const result = harness.auth.login({
      email: `admin@${tenant.slug}.test`,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: fingerprint(),
    });

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.deviceRegistered).toBe(true);
  });

  it('TC-DEV-02 — login dari perangkat berbeda ditolak dengan langkah pemulihan yang jelas', () => {
    const tenant = provisionTenant(harness, { slug: 'devbind2' });
    harness.auth.login({
      email: `admin@${tenant.slug}.test`,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: fingerprint(),
    });

    const second = harness.auth.login({
      email: `admin@${tenant.slug}.test`,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: fingerprint({
        canvasHash: 'perangkat-lain',
        webglHash: 'NVIDIA|GeForce RTX|WebGL 2',
        screenResolution: '2560x1440',
        timezone: 'Asia/Makassar',
        fonts: ['Times New Roman'],
        platform: 'Win32',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0) Firefox/121.0',
      }),
    });

    expect(second.kind).toBe('rejected');
    if (second.kind === 'rejected') {
      expect(second.reasonKey).toBe('error.device_not_bound');
      // SECURITY.md 17.4 — penolakan harus menyebutkan langkah pemulihan.
      expect(second.recoveryKey).toBe('recovery.request_device_transfer');
    }
  });

  it('TC-DEV-03 — pembaruan browser (perubahan wajar) tidak mengunci pengguna sah', () => {
    const stored = fingerprint();
    const updatedBrowser = fingerprint({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/121.0.6167.85 Safari/537.36',
    });

    // Pembaruan versi minor browser TIDAK boleh menolak pengguna sah (SECURITY.md 17.2).
    // userAgent dinormalisasi tanpa nomor versi, sehingga ini tetap perangkat yang sama.
    const match = matchDevice(fingerprintHash(stored), hashComponents(stored), updatedBrowser);
    expect(match.matched).toBe(true);

    // Perangkat yang benar-benar berbeda tetap harus ditolak — toleransi tidak boleh
    // longgar sampai kehilangan gunanya sebagai pengendali berbagi akun.
    const otherDevice = fingerprint({
      canvasHash: 'perangkat-lain',
      webglHash: 'NVIDIA|GeForce RTX|WebGL 2',
      screenResolution: '2560x1440',
      timezone: 'Asia/Makassar',
      fonts: ['Times New Roman'],
      platform: 'Win32',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Firefox/121.0',
    });
    expect(matchDevice(fingerprintHash(stored), hashComponents(stored), otherDevice).matched).toBe(false);
  });

  it('TC-DEV-04 — single active session: login baru mengakhiri sesi sebelumnya', () => {
    const tenant = provisionTenant(harness, { slug: 'devbind4' });
    const first = harness.auth.login({
      email: `admin@${tenant.slug}.test`,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: fingerprint(),
    });
    expect(first.kind).toBe('ok');
    const firstToken = first.kind === 'ok' ? first.token : '';

    harness.auth.login({
      email: `admin@${tenant.slug}.test`,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: fingerprint(),
    });

    expect(() => harness.auth.resolveSession(firstToken)).toThrow(/session_revoked/);
  });

  it('TC-DEV-05 — deteksi impossible travel memperhitungkan toleransi VPN', () => {
    const jakarta = { lat: -6.2, lon: 106.8 };
    const medan = { lat: 3.6, lon: 98.7 };
    const now = new Date();

    const tenMinutesLater = new Date(now.getTime() + 10 * 60_000).toISOString();
    expect(assessTravel({ ...jakarta, at: now.toISOString() }, { ...medan, at: tenMinutesLater }).impossible).toBe(true);

    const sixHoursLater = new Date(now.getTime() + 6 * 3_600_000).toISOString();
    expect(assessTravel({ ...jakarta, at: now.toISOString() }, { ...medan, at: sixHoursLater }).impossible).toBe(false);

    // Perpindahan kecil (dalam toleransi geolokasi IP / VPN korporat) tidak memicu.
    const nearby = { lat: -6.3, lon: 106.9 };
    expect(
      assessTravel({ ...jakarta, at: now.toISOString() }, { ...nearby, at: new Date(now.getTime() + 60_000).toISOString() })
        .impossible,
    ).toBe(false);
  });

  it('TC-DEV-06 — percobaan login gagal berulang mengunci akun sementara', () => {
    const tenant = provisionTenant(harness, { slug: 'devbind6' });
    for (let i = 0; i < 5; i++) {
      harness.auth.login({
        email: `admin@${tenant.slug}.test`,
        password: 'SalahSekali#2026',
        tenantSlug: tenant.slug,
        fingerprint: fingerprint(),
      });
    }

    const result = harness.auth.login({
      email: `admin@${tenant.slug}.test`,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: fingerprint(),
    });
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.reasonKey).toBe('error.account_locked');
  });

  it('TC-DEV-07 — fingerprint disimpan sebagai hash, bukan atribut mentah', () => {
    const tenant = provisionTenant(harness, { slug: 'devbind7' });
    harness.auth.login({
      email: `admin@${tenant.slug}.test`,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: fingerprint(),
    });

    const device = harness.db.prepare('SELECT * FROM device_bindings LIMIT 1').get() as {
      fingerprint_hash: string;
      component_hashes_json: string;
    };
    expect(device.fingerprint_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(device.component_hashes_json).not.toContain('Asia/Jakarta');
    expect(device.component_hashes_json).not.toContain('1920x1080');
  });
});

/* ================= PRD 6.17 Digital Twin ================= */

describe('Digital Twin — PRD 6.17', () => {
  it('TC-TW-01 — pembacaan diklasifikasi terhadap ambang yang dikonfigurasi pengguna', () => {
    const sensor = {
      id: 's', asset_id: 'a', code: 'temperature', label: 'Suhu', unit: '°C',
      warn_min: 18, warn_max: 26, crit_min: 15, crit_max: 30, weight: 1,
    };
    expect(classifyReading(22, sensor)).toBe('normal');
    expect(classifyReading(28, sensor)).toBe('warning');
    expect(classifyReading(32, sensor)).toBe('critical');
    expect(classifyReading(14, sensor)).toBe('critical');
  });

  it('TC-TW-02 — skor kesehatan turun saat sensor melewati ambang', () => {
    const sensor = {
      id: 's', asset_id: 'a', code: 'vibration', label: 'Getaran', unit: 'mm/s',
      warn_min: null, warn_max: 4.5, crit_min: null, crit_max: 7, weight: 1,
    };
    const healthy = computeHealthScore([{ sensor, value: 2 }], 0);
    const warning = computeHealthScore([{ sensor, value: 5 }], 0);
    const critical = computeHealthScore([{ sensor, value: 9 }], 0);

    expect(healthy).toBeGreaterThan(warning);
    expect(warning).toBeGreaterThan(critical);
    expect(critical).toBeLessThan(50);
  });

  it('TC-TW-03 — prediksi kegagalan selalu berupa RENTANG dengan tingkat keyakinan', async () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin', 'supervisor']);
    const twin = new DigitalTwinService(ctx);

    twin.createAsset({
      code: 'PUMP-1',
      name: 'Pompa 1',
      category: 'pump',
      sensors: [{ code: 'vibration', label: 'Getaran', unit: 'mm/s', warnMax: 4.5, critMax: 7 }],
    });

    // Tren naik yang konsisten menuju ambang kritis.
    for (let i = 0; i < 30; i++) {
      await twin.ingestReading({
        assetCode: 'PUMP-1',
        sensorCode: 'vibration',
        value: 2 + i * 0.1,
        observedAt: new Date(Date.now() - (30 - i) * 3_600_000).toISOString(),
      });
    }

    const asset = ctx.db.get<{ id: string }>('assets', { code: 'PUMP-1' })!;
    const prediction = twin.predictFailure(asset.id);

    expect(prediction).not.toBeNull();
    expect(Date.parse(prediction!.windowEnd)).toBeGreaterThan(Date.parse(prediction!.windowStart));
    expect(prediction!.confidence).toBeGreaterThan(0);
    expect(prediction!.confidence).toBeLessThanOrEqual(1);
    expect(typeof prediction!.lowConfidence).toBe('boolean');
  });

  it('TC-TW-04 — simulasi mengembalikan proyeksi tanpa mengubah aset', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const twin = new DigitalTwinService(ctx);
    twin.createAsset({
      code: 'HVAC-9',
      name: 'HVAC 9',
      category: 'hvac',
      sensors: [{ code: 'power', label: 'Daya', unit: 'kWh', warnMax: 90 }],
    });
    const asset = ctx.db.get<{ id: string; status: string; health_score: number }>('assets', { code: 'HVAC-9' })!;

    const simulation = twin.simulate({ name: 'Matikan untuk pemeliharaan', actions: [{ assetId: asset.id, action: 'shutdown' }] });
    expect(simulation.disclaimerKey).toBe('twin.simulation_is_projection_only');

    const after = ctx.db.get<{ status: string; health_score: number }>('assets', { code: 'HVAC-9' })!;
    expect(after.status).toBe(asset.status);
    expect(after.health_score).toBe(asset.health_score);
  });
});

/* ================= PRD 6.29 Usage Metering & Kuota ================= */

describe('Usage Metering & Kuota — PRD 6.29', () => {
  it('TC-USG-01 — kuota berperilaku "block" menolak aksi tambahan', () => {
    // Paket Starter: koneksi eksternal = 0 dengan perilaku block.
    const tenant = provisionTenant(harness, { planCode: 'starter', slug: 'starterq' });
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const metering = new MeteringService(ctx);

    expect(() => metering.assertWithinQuota('connections', 1)).toThrow(/quota_exceeded/);
  });

  it('TC-USG-02 — feature flag mematikan modul di luar paket', () => {
    const tenant = provisionTenant(harness, { planCode: 'starter', slug: 'starterf' });
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);

    expect(ctx.flags.isEnabled('dataset')).toBe(true);
    expect(ctx.flags.isEnabled('digital_twin')).toBe(false);
    expect(() => ctx.requireModule('digital_twin')).toThrow(/module_not_in_plan/);
  });

  it('TC-USG-03 — Enterprise mengaktifkan seluruh modul', () => {
    const tenant = provisionTenant(harness, { planCode: 'enterprise', slug: 'entflag' });
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    expect(ctx.flags.isEnabled('digital_twin')).toBe(true);
    expect(ctx.flags.isEnabled('balanced_scorecard')).toBe(true);
    expect(ctx.flags.isEnabled('hypothesis_testing')).toBe(true);
  });
});
