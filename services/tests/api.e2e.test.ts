/**
 * Pengujian E2E lintas modul — TESTING.md Bagian 1 (piramida: E2E 10%) & Bagian 15
 * ("Wajib E2E?" = Ya untuk Manajemen Data, Administrasi Sistem, Monitoring,
 * Analitik Cerdas, dan Kepemimpinan).
 *
 * Alur yang diuji mengikuti ARCHITECTURE.md 4.1:
 *   unggah CSV → validasi & scan → Data Quality Center → pemetaan → KPI → cockpit
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.ts';
import { mountWebApp } from '../src/server.ts';
import { fingerprint, syntheticCsv, TEST_PASSWORD } from './helpers.ts';
import { totpCode, totpCounter } from '../src/platform/totp.ts';
import type { AuthService } from '../src/identity-service/auth.ts';
import type { Db } from '../src/platform/db.ts';

let app: Express;
let db: Db;
let dir: string;
let token: string;
let secondTenantToken: string;
let authService: AuthService;
/** Rahasia MFA admin kedua, dipakai uji yang login ulang sebagai pengguna itu. */
let secondAdminSecret: string;
let datasetId: string;
let kpiId: string;

const currentPeriod = new Date().toISOString().slice(0, 7);

/**
 * Login lewat HTTP, menyelesaikan langkah MFA bila diminta.
 *
 * Admin tenant memegang peran `super_admin`, yang menandai `mfaRequired` — jadi alur
 * dua langkah adalah jalur NORMAL bagi pengguna ini, bukan kasus tepi. Helper ini
 * dengan sengaja melewati keduanya lewat HTTP, sehingga setiap uji E2E lain berjalan di
 * atas sesi yang benar-benar terbit setelah faktor kedua lolos.
 */
async function login(email: string, slug: string, secret?: string): Promise<string> {
  const response = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password: TEST_PASSWORD, tenantSlug: slug, fingerprint: fingerprint() });
  expect(response.status).toBe(200);

  if (!response.body.mfaRequired) return response.body.token as string;

  expect(secret, `login ${email} menuntut MFA tetapi rahasianya tidak diberikan`).toBeTruthy();
  // Langkah waktu berikutnya: langkah saat ini sudah terpakai saat aktivasi, dan
  // anti-replay menolaknya dipakai dua kali.
  const verified = await request(app)
    .post('/api/v1/auth/mfa/verify')
    .send({
      challengeToken: response.body.challengeToken,
      code: totpCode(secret!, totpCounter() + 1),
      fingerprint: fingerprint(),
    });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  return verified.body.token as string;
}

/** Mengaktifkan MFA untuk sebuah pengguna, seperti yang wajib dilakukan admin sungguhan. */
function enrolMfa(tenantId: string, userId: string): string {
  const { secret } = authService.beginMfaEnrolment({ tenantId, userId });
  expect(authService.activateMfa({ tenantId, userId, code: totpCode(secret) }).activated).toBe(true);
  return secret;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vantik-e2e-'));
  const created = createApp({
    paths: { main: join(dir, 'main.db'), audit: join(dir, 'audit.db'), vault: join(dir, 'vault.db') },
  });
  app = created.app;
  db = created.db;
  authService = created.auth;

  created.tenants.provision(
    {
      name: 'Organisasi E2E',
      slug: 'e2edemo',
      planCode: 'enterprise',
      billingCycle: 'monthly',
      admin: { fullName: 'Admin E2E', nik: 'NIK-E2E-1', email: 'admin@e2e.test', password: TEST_PASSWORD },
    },
    'test',
  );
  created.tenants.provision(
    {
      name: 'Organisasi Lain',
      slug: 'e2eother',
      planCode: 'enterprise',
      billingCycle: 'monthly',
      admin: { fullName: 'Admin Lain', nik: 'NIK-E2E-2', email: 'admin@other.test', password: TEST_PASSWORD },
    },
    'test',
  );

  // Admin tenant adalah `super_admin`, yang mewajibkan MFA. Mendaftarkannya di sini
  // meniru langkah pertama yang WAJIB dilakukan administrator sungguhan setelah
  // pemasangan; tanpa itu, perannya benar tetapi tidak berwenang apa pun.
  const first = created.db.prepare("SELECT id, tenant_id FROM system_user WHERE email = 'admin@e2e.test'").get() as {
    id: string;
    tenant_id: string;
  };
  const second = created.db.prepare("SELECT id, tenant_id FROM system_user WHERE email = 'admin@other.test'").get() as {
    id: string;
    tenant_id: string;
  };
  const firstSecret = enrolMfa(first.tenant_id, first.id);
  secondAdminSecret = enrolMfa(second.tenant_id, second.id);

  token = await login('admin@e2e.test', 'e2edemo', firstSecret);
  secondTenantToken = await login('admin@other.test', 'e2eother', secondAdminSecret);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const auth = (): [string, string] => ['Authorization', `Bearer ${token}`];

describe('Autentikasi & sesi lewat HTTP', () => {
  it('TC-E2E-01 — /health tersedia tanpa autentikasi', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('TC-E2E-02 — endpoint terlindungi menolak permintaan tanpa token', async () => {
    const response = await request(app).get('/api/v1/datasets');
    expect(response.status).toBe(401);
    expect(response.body.error.key).toBe('error.unauthenticated');
  });

  it('TC-E2E-03 — /me mengembalikan identitas, tenant, feature flag & RLS', async () => {
    const response = await request(app).get('/api/v1/me').set(...auth());
    expect(response.status).toBe(200);
    expect(response.body.user.email).toBe('admin@e2e.test');
    expect(response.body.tenant.slug).toBe('e2edemo');
    expect(response.body.flags.plan).toBe('enterprise');
    expect(response.body.rls.restricted).toBe(false);
  });

  it('TC-E2E-04 — kredensial salah tidak membocorkan apakah email terdaftar', async () => {
    const wrongPassword = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@e2e.test', password: 'Salah#123456', tenantSlug: 'e2edemo', fingerprint: fingerprint() });
    const unknownEmail = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'tidakada@e2e.test', password: 'Salah#123456', tenantSlug: 'e2edemo', fingerprint: fingerprint() });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body.error.key).toBe(unknownEmail.body.error.key);
  });

  it('TC-E2E-05 — header keamanan dipasang pada respons aplikasi', async () => {
    const response = await request(app).get('/health');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['x-frame-options']).toBe('DENY');
  });

  it('TC-E2E-06 — preferensi tema & bahasa tersimpan di profil (server-side)', async () => {
    await request(app).patch('/api/v1/me/preferences').set(...auth()).send({ locale: 'en', theme: 'dark' });
    const response = await request(app).get('/api/v1/me').set(...auth());
    expect(response.body.user.locale).toBe('en');
    expect(response.body.user.theme).toBe('dark');
    await request(app).patch('/api/v1/me/preferences').set(...auth()).send({ locale: 'id', theme: 'light' });
  });
});

describe('Alur data end-to-end (ARCHITECTURE.md 4.1)', () => {
  it('TC-E2E-07 — unggah CSV → dataset siap dengan skor kualitas', async () => {
    const response = await request(app)
      .post('/api/v1/datasets/upload')
      .set(...auth())
      .send({
        filename: 'layanan.csv',
        contentBase64: Buffer.from(syntheticCsv({ rows: 60 })).toString('base64'),
        name: 'Layanan Pelanggan E2E',
      });

    expect(response.status).toBe(201);
    expect(response.body.dataset.status).toBe('ready');
    expect(response.body.quality.score).toBeGreaterThan(0);
    datasetId = response.body.dataset.id;
  });

  it('TC-E2E-08 — unggah berkas dengan ekstensi tersamar ditolak lewat HTTP', async () => {
    const response = await request(app)
      .post('/api/v1/datasets/upload')
      .set(...auth())
      .send({ filename: 'jahat.csv.exe', contentBase64: Buffer.from('a,b\n1,2').toString('base64') });

    expect(response.status).toBe(400);
    expect(response.body.error.key).toBe('error.upload_disguised_extension');
  });

  it('TC-E2E-09 — pemeriksaan kualitas & sertifikasi lewat HTTP', async () => {
    const check = await request(app).post(`/api/v1/datasets/${datasetId}/quality-check`).set(...auth());
    expect(check.status).toBe(200);
    expect(check.body.certifiable).toBe(true);

    const certify = await request(app)
      .post(`/api/v1/datasets/${datasetId}/certify`)
      .set(...auth())
      .send({ decision: 'certified', note: 'E2E' });
    expect(certify.status).toBe(200);
    expect(certify.body.certification).toBe('certified');

    const history = await request(app).get(`/api/v1/datasets/${datasetId}/quality-history`).set(...auth());
    expect(history.body.history.length).toBeGreaterThan(0);
  });

  it('TC-E2E-10 — baris dataset dapat dibaca dan diekspor', async () => {
    const rows = await request(app).get(`/api/v1/datasets/${datasetId}/rows?limit=10`).set(...auth());
    expect(rows.status).toBe(200);
    expect(rows.body.rows).toHaveLength(10);
    expect(rows.body.total).toBe(60);

    const csv = await request(app).get(`/api/v1/datasets/${datasetId}/export`).set(...auth());
    expect(csv.status).toBe(200);
    expect(csv.text.split('\n')[0]).toContain('wilayah');
  });

  it('TC-E2E-11 — Data Modeling: tabel, field, dan kamus istilah', async () => {
    const table = await request(app)
      .post('/api/v1/model/tables')
      .set(...auth())
      .send({ name: 'fact_tiket', kind: 'fact', grain: '1 baris = 1 tiket' });
    expect(table.status).toBe(201);

    const field = await request(app)
      .post('/api/v1/model/fields')
      .set(...auth())
      .send({ tableName: 'fact_tiket', name: 'total_tiket', dataType: 'number', role: 'measure', formula: 'SUM(jumlah_tiket)' });
    expect(field.status).toBe(201);

    // Tabel fact WAJIB mendeklarasikan grain (ARCHITECTURE.md Bagian 5).
    const missingGrain = await request(app)
      .post('/api/v1/model/tables')
      .set(...auth())
      .send({ name: 'fact_tanpa_grain', kind: 'fact' });
    expect(missingGrain.status).toBe(400);

    await request(app)
      .post('/api/v1/model/dictionary')
      .set(...auth())
      .send({ term: 'CSAT', definitionId: 'Skor kepuasan pelanggan', definitionEn: 'Customer satisfaction score' });
    const dictionary = await request(app).get('/api/v1/model/dictionary?q=CSAT').set(...auth());
    expect(dictionary.body.terms).toHaveLength(1);

    const tables = await request(app).get('/api/v1/model/tables').set(...auth());
    expect(tables.body.tables.some((t: { name: string }) => t.name === 'fact_tiket')).toBe(true);
  });

  it('TC-E2E-12 — pemetaan kolom mencatat lineage otomatis', async () => {
    const map = await request(app)
      .post(`/api/v1/datasets/${datasetId}/map`)
      .set(...auth())
      .send({ mappings: [{ column: 'jumlah_tiket', table: 'fact_tiket', field: 'total_tiket', role: 'measure' }] });
    expect(map.status).toBe(200);

    const lineage = await request(app).get(`/api/v1/model/lineage/dataset/${datasetId}`).set(...auth());
    expect(lineage.body.edges.length).toBeGreaterThan(0);
  });
});

describe('KPI Center → Alert Center → Cockpit', () => {
  it('TC-E2E-13 — membuat KPI dan menangkap skor per periode', async () => {
    const created = await request(app)
      .post('/api/v1/kpis')
      .set(...auth())
      .send({
        code: 'CSAT_E2E',
        name: 'Skor Kepuasan E2E',
        formula: 'AVG(skor_csat)',
        datasetId,
        measureField: 'skor_csat',
        dimensionField: 'wilayah',
        target: 4.5,
        direction: 'higher_better',
        thresholds: [
          { level: 'critical', comparator: 'lte', value: 3.5 },
          { level: 'at_risk', comparator: 'lte', value: 4.0 },
        ],
      });
    expect(created.status).toBe(201);
    kpiId = created.body.id;

    const capture = await request(app)
      .post(`/api/v1/kpis/${kpiId}/capture`)
      .set(...auth())
      .send({ period: currentPeriod, datasetId });
    expect(capture.status).toBe(200);
    expect(capture.body.captured.length).toBeGreaterThan(0);

    const history = await request(app).get(`/api/v1/kpis/${kpiId}/history`).set(...auth());
    expect(history.body.history.length).toBeGreaterThan(0);
  });

  it('TC-E2E-14 — alur persetujuan perubahan definisi KPI', async () => {
    const proposal = await request(app)
      .post(`/api/v1/kpis/${kpiId}/propose`)
      .set(...auth())
      .send({ target: 4.8 });
    expect(proposal.status).toBe(200);

    // Pengaju tidak boleh menyetujui perubahannya sendiri.
    const selfApprove = await request(app)
      .post(`/api/v1/kpis/approvals/${proposal.body.approvalId}/decide`)
      .set(...auth())
      .send({ decision: 'approved' });
    expect(selfApprove.status).toBe(409);
  });

  it('TC-E2E-15 — aturan notifikasi dibuat dan dievaluasi', async () => {
    const rule = await request(app)
      .post('/api/v1/alerts/rules')
      .set(...auth())
      .send({
        name: 'CSAT rendah E2E',
        kpiId,
        comparator: 'lte',
        threshold: 10,
        channels: ['email', 'slack'],
        recipients: ['ops@e2e.test'],
      });
    expect(rule.status).toBe(201);

    const evaluated = await request(app)
      .post('/api/v1/alerts/evaluate')
      .set(...auth())
      .send({ kpiId, value: 2, label: 'CSAT E2E' });
    expect(evaluated.status).toBe(200);
    expect(evaluated.body.triggered.length).toBeGreaterThan(0);

    const history = await request(app).get('/api/v1/alerts/history').set(...auth());
    expect(history.body.events.length).toBeGreaterThan(0);

    const acknowledged = await request(app)
      .post(`/api/v1/alerts/events/${history.body.events[0].event.id}/acknowledge`)
      .set(...auth())
      .send({ note: 'ditindaklanjuti' });
    expect(acknowledged.status).toBe(200);

    const latency = await request(app).get('/api/v1/alerts/latency').set(...auth());
    expect(latency.status).toBe(200);
  });

  it('TC-E2E-16 — Executive Cockpit hanya memakai dataset Certified', async () => {
    const response = await request(app).get(`/api/v1/cockpit/executive?period=${currentPeriod}`).set(...auth());
    expect(response.status).toBe(200);
    expect(response.body.certifiedOnly).toBe(true);
    expect(response.body.kpis.length).toBeGreaterThan(0);
    expect(typeof response.body.overallScore).toBe('number');
  });

  it('TC-E2E-17 — Operational Cockpit melaporkan status RLS', async () => {
    const response = await request(app).get(`/api/v1/cockpit/operational?period=${currentPeriod}`).set(...auth());
    expect(response.status).toBe(200);
    expect(response.body.rlsApplied).toBe(false);
    expect(Array.isArray(response.body.openAlerts)).toBe(true);
  });

  it('TC-E2E-18 — Balanced Scorecard menarik KPI dari KPI Center', async () => {
    await request(app).post('/api/v1/scorecard/seed').set(...auth());
    const perspectives = await request(app).get(`/api/v1/scorecard?period=${currentPeriod}`).set(...auth());
    expect(perspectives.status).toBe(200);
    expect(perspectives.body.perspectives).toHaveLength(4);

    const customer = perspectives.body.perspectives.find((p: { code: string }) => p.code === 'customer');
    const objective = await request(app)
      .post('/api/v1/scorecard/objectives')
      .set(...auth())
      .send({ perspectiveId: customer.id, name: 'Naikkan kepuasan pelanggan', kpiId, target: 4.5 });
    expect(objective.status).toBe(201);

    const withObjective = await request(app).get(`/api/v1/scorecard?period=${currentPeriod}`).set(...auth());
    const updated = withObjective.body.perspectives.find((p: { code: string }) => p.code === 'customer');
    expect(updated.objectives).toHaveLength(1);
    // KPI berasal dari KPI Center — tidak ada definisi ganda (PRD 6.25).
    expect(updated.objectives[0].kpiId).toBe(kpiId);

    const map = await request(app).get('/api/v1/scorecard/strategy-map').set(...auth());
    expect(map.status).toBe(200);
  });
});

describe('Analisis statistik lewat HTTP', () => {
  it('TC-E2E-19 — statistik deskriptif mengembalikan visual pendukung & sumber data', async () => {
    const response = await request(app)
      .post('/api/v1/stats/descriptive')
      .set(...auth())
      .send({ datasetId, fields: ['skor_csat'], groupBy: 'wilayah' });

    expect(response.status).toBe(200);
    expect(response.body.perField[0].stats.n).toBeGreaterThan(0);
    expect(response.body.perField[0].histogram.length).toBeGreaterThan(0);
    expect(response.body.perField[0].boxPlot).toBeDefined();
    expect(response.body.perField[0].qqPlot.length).toBeGreaterThan(0);
    expect(response.body.byGroup[0].groups.length).toBeGreaterThan(1);
    // Sumber data & periode wajib tercantum.
    expect(response.body.source.datasetId).toBe(datasetId);
  });

  it('TC-E2E-20 — uji hipotesis melaporkan asumsi & catatan kausalitas', async () => {
    const response = await request(app)
      .post('/api/v1/stats/hypothesis')
      .set(...auth())
      .send({ datasetId, test: 'kruskal_wallis', valueField: 'skor_csat', groupField: 'wilayah', alpha: 0.05 });

    expect(response.status).toBe(200);
    expect(response.body.testKey).toBe('test.kruskal_wallis');
    expect(response.body.assumptions.length).toBeGreaterThan(0);
    expect(response.body.causalityNoteKey).toBe('note.difference_not_causation');
  });

  it('TC-E2E-21 — korelasi & regresi mengembalikan diagnostik', async () => {
    const correlation = await request(app)
      .post('/api/v1/stats/correlation')
      .set(...auth())
      .send({ datasetId, fields: ['jumlah_tiket', 'skor_csat'], method: 'pearson' });
    expect(correlation.status).toBe(200);
    expect(correlation.body.causalityNoteKey).toBe('note.correlation_not_causation');

    const regression = await request(app)
      .post('/api/v1/stats/regression')
      .set(...auth())
      .send({ datasetId, kind: 'linear', responseField: 'skor_csat', predictorFields: ['jumlah_tiket'] });
    expect(regression.status).toBe(200);
    expect(regression.body.diagnostics.durbinWatson).toBeDefined();
    expect(regression.body.equation).toContain('skor_csat');
    expect(regression.body.causalityNoteKey).toBe('note.regression_not_causation');
  });

  it('TC-E2E-22 — hasil statistik deterministik: panggilan ulang identik', async () => {
    const payload = { datasetId, fields: ['skor_csat'] };
    const first = await request(app).post('/api/v1/stats/descriptive').set(...auth()).send(payload);
    const second = await request(app).post('/api/v1/stats/descriptive').set(...auth()).send(payload);
    expect(first.body.perField[0].stats).toEqual(second.body.perField[0].stats);
  });
});

describe('Analitik cerdas lewat HTTP', () => {
  it('TC-E2E-23 — AI Analytics menjawab dan MENCANTUMKAN sumber data', async () => {
    const response = await request(app)
      .post('/api/v1/ai/ask')
      .set(...auth())
      .send({ question: 'Berapa total jumlah_tiket per wilayah?', locale: 'id' });

    expect(response.status).toBe(200);
    expect(response.body.sources.length).toBeGreaterThan(0);
    expect(response.body.sources[0].datasetName).toBeDefined();
    expect(response.body.breakdown.length).toBeGreaterThan(0);
    // Tanpa penyedia LLM eksternal, platform tetap berfungsi penuh.
    expect(response.body.provider).toBe('deterministic');
  });

  it('TC-E2E-24 — Forecast mengembalikan interval kepercayaan & MAPE', async () => {
    const series = Array.from({ length: 24 }, (_, i) => 100 + i * 2 + (i % 3));
    const response = await request(app)
      .post('/api/v1/forecast')
      .set(...auth())
      .send({ series, horizon: 6, method: 'linear_regression' });

    expect(response.status).toBe(200);
    expect(response.body.points).toHaveLength(6);
    expect(response.body.points[0].lower).toBeLessThan(response.body.points[0].value);
    expect(response.body.points[0].upper).toBeGreaterThan(response.body.points[0].value);
    expect(typeof response.body.mape).toBe('number');
  });

  it('TC-E2E-25 — RCA selalu menghasilkan draf yang menuntut validasi manusia', async () => {
    const response = await request(app)
      .post('/api/v1/rca/generate')
      .set(...auth())
      .send({ title: 'Kenaikan tiket', datasetId, metricField: 'jumlah_tiket', dimensionFields: ['wilayah', 'kanal'] });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('draft');
    expect(response.body.disclaimerKey).toBe('rca.draft_requires_human_validation');
    expect(response.body.pareto.length).toBeGreaterThan(0);
    expect(response.body.fiveWhy).toHaveLength(5);

    const validated = await request(app).post(`/api/v1/rca/${response.body.id}/validate`).set(...auth()).send({});
    expect(validated.status).toBe(200);
  });

  it('TC-E2E-26 — Data Discovery menemukan korelasi & klaster', async () => {
    const response = await request(app).get(`/api/v1/discovery/${datasetId}`).set(...auth());
    expect(response.status).toBe(200);
    expect(response.body.source.datasetId).toBe(datasetId);
    expect(Array.isArray(response.body.outliers)).toBe(true);
    expect(Array.isArray(response.body.clusters)).toBe(true);
  });

  it('TC-E2E-27 — AI Narrative Report membandingkan dua periode', async () => {
    const response = await request(app)
      .post('/api/v1/narrative/generate')
      .set(...auth())
      .send({ period: currentPeriod, comparePeriod: currentPeriod, locale: 'id' });

    expect(response.status).toBe(200);
    expect(response.body.sections.length).toBeGreaterThan(0);
    const listed = await request(app).get('/api/v1/narrative').set(...auth());
    expect(listed.body.reports.length).toBeGreaterThan(0);
  });
});

describe('Digital Twin lewat HTTP', () => {
  it('TC-E2E-28 — aset dikonfigurasi pengguna, bukan ditanam di kode', async () => {
    const zone = await request(app).post('/api/v1/twin/zones').set(...auth()).send({ name: 'Zona E2E' });
    expect(zone.status).toBe(201);

    // Kategori & sensor sepenuhnya bebas — lintas sektor (PRD 6.17).
    const asset = await request(app)
      .post('/api/v1/twin/assets')
      .set(...auth())
      .send({
        code: 'INKUBATOR-1',
        name: 'Inkubator Laboratorium',
        category: 'laboratory',
        zoneId: zone.body.id,
        sensors: [{ code: 'temperature', label: 'Suhu', unit: '°C', warnMin: 35, warnMax: 38, critMin: 33, critMax: 40 }],
      });
    expect(asset.status).toBe(201);

    for (let i = 0; i < 12; i++) {
      const reading = await request(app)
        .post('/api/v1/twin/readings')
        .set(...auth())
        .send({
          assetCode: 'INKUBATOR-1',
          sensorCode: 'temperature',
          value: 36 + i * 0.25,
          observedAt: new Date(Date.now() - (12 - i) * 3_600_000).toISOString(),
        });
      expect(reading.status).toBe(200);
    }

    const plan = await request(app).get('/api/v1/twin/floor-plan').set(...auth());
    expect(plan.status).toBe(200);
    expect(plan.body.zones.length).toBeGreaterThan(0);

    const detail = await request(app).get(`/api/v1/twin/assets/${asset.body.id}`).set(...auth());
    expect(detail.status).toBe(200);
    expect(detail.body.readings.length).toBeGreaterThan(0);

    const queue = await request(app).get('/api/v1/twin/maintenance-queue').set(...auth());
    expect(queue.status).toBe(200);

    const ticket = await request(app)
      .post(`/api/v1/twin/assets/${asset.body.id}/tickets`)
      .set(...auth())
      .send({ title: 'Kalibrasi inkubator', priority: 'high' });
    expect(ticket.status).toBe(201);

    const simulation = await request(app)
      .post('/api/v1/twin/simulate')
      .set(...auth())
      .send({ name: 'Uji skenario', actions: [{ assetId: asset.body.id, action: 'shutdown' }] });
    expect(simulation.status).toBe(200);
    expect(simulation.body.disclaimerKey).toBe('twin.simulation_is_projection_only');

    const energy = await request(app).get('/api/v1/twin/energy?sensor=temperature').set(...auth());
    expect(energy.status).toBe(200);
  });
});

describe('Administrasi sistem lewat HTTP', () => {
  it('TC-E2E-29 — Master Pegawai: buat, impor CSV, ubah status', async () => {
    const created = await request(app)
      .post('/api/v1/employees')
      .set(...auth())
      .send({ fullName: 'Budi Santoso', nik: 'NIK-E2E-100', division: 'Operasional', position: 'Analis', email: 'budi@e2e.test' });
    expect(created.status).toBe(201);

    const imported = await request(app)
      .post('/api/v1/employees/import')
      .set(...auth())
      .send({
        csv: 'full_name,nik,division,position,email\nSiti Aminah,NIK-E2E-101,Keuangan,Staf,siti@e2e.test\nBudi Santoso,NIK-E2E-100,Operasional,Analis,budi@e2e.test',
      });
    expect(imported.status).toBe(200);
    expect(imported.body.imported).toBe(1);
    // Baris duplikat dilaporkan, tidak membatalkan seluruh impor.
    expect(imported.body.skipped).toHaveLength(1);

    // Perubahan status memicu peninjauan akses dalam SLA (SECURITY.md Bagian 5).
    const status = await request(app)
      .post(`/api/v1/employees/${created.body.id}/status`)
      .set(...auth())
      .send({ status: 'resigned' });
    expect(status.status).toBe(200);
    expect(status.body.reviewDueAt).not.toBeNull();

    const list = await request(app).get('/api/v1/employees').set(...auth());
    expect(list.body.employees.length).toBeGreaterThanOrEqual(3);

    const reviews = await request(app).get('/api/v1/employees/access-reviews').set(...auth());
    expect(reviews.status).toBe(200);
  });

  it('TC-E2E-30 — Otorisasi User: buat akun, tetapkan peran & RLS', async () => {
    const employees = await request(app).get('/api/v1/employees').set(...auth());
    const target = employees.body.employees.find((e: { email: string }) => e.email === 'siti@e2e.test');

    const created = await request(app)
      .post('/api/v1/authorization/users')
      .set(...auth())
      .send({ employeeId: target.id, email: 'siti@e2e.test', password: TEST_PASSWORD, roleCodes: ['business_analyst'] });
    expect(created.status).toBe(201);

    const roles = await request(app)
      .put(`/api/v1/authorization/users/${created.body.id}/roles`)
      .set(...auth())
      .send({ roles: ['supervisor'] });
    expect(roles.status).toBe(200);

    const rls = await request(app)
      .put('/api/v1/authorization/rls')
      .set(...auth())
      .send({
        subject: { type: 'user', id: created.body.id },
        rules: [{ dimension: 'wilayah', operator: 'in', values: ['Wilayah Timur'] }],
      });
    expect(rls.status).toBe(200);

    // Akun tanpa identitas Master Pegawai ditolak.
    const floating = await request(app)
      .post('/api/v1/authorization/users')
      .set(...auth())
      .send({ employeeId: 'emp_tidak_ada', email: 'hantu@e2e.test', password: TEST_PASSWORD, roleCodes: ['auditor'] });
    expect(floating.status).toBe(400);

    const review = await request(app).get('/api/v1/authorization/access-review').set(...auth());
    expect(review.body.users.length).toBeGreaterThan(0);

    const disabled = await request(app).post(`/api/v1/authorization/users/${created.body.id}/disable`).set(...auth());
    expect(disabled.status).toBe(200);
  });

  it('TC-E2E-31 — pengguna dengan RLS hanya menerima data dalam cakupannya lewat API', async () => {
    // Buat pengguna baru bersih dengan RLS Wilayah Timur.
    const employees = await request(app).get('/api/v1/employees').set(...auth());
    const target = employees.body.employees.find((e: { email: string }) => e.email === 'budi@e2e.test');

    const created = await request(app)
      .post('/api/v1/authorization/users')
      .set(...auth())
      .send({ employeeId: target.id, email: 'budi.rls@e2e.test', password: TEST_PASSWORD, roleCodes: ['business_analyst'] });

    await request(app)
      .put('/api/v1/authorization/rls')
      .set(...auth())
      .send({
        subject: { type: 'user', id: created.body.id },
        rules: [{ dimension: 'wilayah', operator: 'in', values: ['Wilayah Timur'] }],
      });

    const restrictedToken = await login('budi.rls@e2e.test', 'e2edemo');
    const rows = await request(app)
      .get(`/api/v1/datasets/${datasetId}/rows?limit=1000`)
      .set('Authorization', `Bearer ${restrictedToken}`);

    expect(rows.status).toBe(200);
    // Data di luar cakupan TIDAK PERNAH keluar dari respons API.
    expect(rows.body.rows.every((r: { wilayah: string }) => r.wilayah === 'Wilayah Timur')).toBe(true);
    expect(rows.body.rlsFiltered).toBeGreaterThan(0);

    const me = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${restrictedToken}`);
    expect(me.body.rls.restricted).toBe(true);
    expect(me.body.rls.dimensions).toContain('wilayah');
  });

  it('TC-E2E-32 — Log Aktivitas dapat dicari, diringkas, dan diekspor', async () => {
    const log = await request(app).get('/api/v1/audit?limit=50').set(...auth());
    expect(log.status).toBe(200);
    expect(log.body.rows.length).toBeGreaterThan(0);
    expect(log.body.total).toBeGreaterThan(0);

    const summary = await request(app).get('/api/v1/audit/summary').set(...auth());
    expect(summary.status).toBe(200);
    expect(summary.body.byModule.length).toBeGreaterThan(0);

    const csv = await request(app).get('/api/v1/audit/export').set(...auth());
    expect(csv.status).toBe(200);
    // Format waktu ISO 8601 tidak ambigu (DESIGN.md 8.3).
    expect(csv.text.split('\n')[0]).toContain('timestamp_iso8601');
  });

  it('TC-E2E-33 — perangkat & sesi terlihat oleh pengguna dan admin', async () => {
    const mine = await request(app).get('/api/v1/devices/mine').set(...auth());
    expect(mine.status).toBe(200);
    expect(mine.body.devices.length).toBeGreaterThan(0);
    expect(mine.body.devices.some((d: { current: boolean }) => d.current)).toBe(true);

    const all = await request(app).get('/api/v1/devices').set(...auth());
    expect(all.status).toBe(200);

    const sessions = await request(app).get('/api/v1/sessions').set(...auth());
    expect(sessions.status).toBe(200);

    const transfers = await request(app).get('/api/v1/devices/transfers').set(...auth());
    expect(transfers.status).toBe(200);
  });
});

describe('Visualisasi, langganan, dan kuota lewat HTTP', () => {
  it('TC-E2E-34 — dashboard: buat, simpan draf, publikasikan, versi', async () => {
    const created = await request(app)
      .post('/api/v1/dashboards')
      .set(...auth())
      .send({ name: 'Dashboard E2E', templateCode: 'customer_service' });
    expect(created.status).toBe(201);

    const draft = await request(app)
      .put(`/api/v1/dashboards/${created.body.id}/draft`)
      .set(...auth())
      .send({ widgets: [{ id: 'w1', type: 'threshold_ring', title: 'CSAT', x: 0, y: 0, w: 3, h: 2, kpiId }] });
    expect(draft.status).toBe(200);

    // Jenis visual tidak dikenal ditolak sebelum dipublikasikan.
    const invalid = await request(app)
      .put(`/api/v1/dashboards/${created.body.id}/draft`)
      .set(...auth())
      .send({ widgets: [{ id: 'w2', type: 'tidak_ada', title: 'X', x: 0, y: 0, w: 1, h: 1 }] });
    expect(invalid.status).toBe(400);

    const published = await request(app).post(`/api/v1/dashboards/${created.body.id}/publish`).set(...auth());
    expect(published.status).toBe(200);
    expect(published.body.version).toBe(2);

    const versions = await request(app).get(`/api/v1/dashboards/${created.body.id}/versions`).set(...auth());
    expect(versions.body.versions.length).toBe(1);

    const catalog = await request(app).get('/api/v1/visualizations').set(...auth());
    expect(catalog.body.catalog.length).toBeGreaterThanOrEqual(80);
  });

  it('TC-E2E-35 — embed token diterbitkan lalu dipakai lewat endpoint publik terisolasi', async () => {
    const dashboards = await request(app).get('/api/v1/dashboards').set(...auth());
    const target = dashboards.body.dashboards.find((d: { published_at: string | null }) => d.published_at);

    const issued = await request(app)
      .post(`/api/v1/dashboards/${target.id}/embed-tokens`)
      .set(...auth())
      .send({ domainWhitelist: ['https://mitra.example.org'], mode: 'interactive', expiresInDays: 7 });
    expect(issued.status).toBe(201);
    expect(issued.body.iframeSnippet).toContain('<iframe');

    const denied = await request(app)
      .get(`/embed/v1/dashboard?token=${issued.body.token}`)
      .set('Origin', 'https://penyusup.example.net');
    expect(denied.status).toBe(403);

    const allowed = await request(app)
      .get(`/embed/v1/dashboard?token=${issued.body.token}`)
      .set('Origin', 'https://mitra.example.org');
    expect(allowed.status).toBe(200);
    expect(allowed.body.canExport).toBe(false);
    // CSP frame-ancestors mengikuti domain whitelist per token (SECURITY.md 15).
    expect(allowed.headers['content-security-policy']).toContain('https://mitra.example.org');

    const tokens = await request(app).get(`/api/v1/dashboards/${target.id}/embed-tokens`).set(...auth());
    expect(tokens.body.usage.totalViews).toBeGreaterThan(0);
    expect(tokens.body.usage.denials).toBeGreaterThan(0);

    const revoked = await request(app).delete(`/api/v1/embed-tokens/${issued.body.tokenId}`).set(...auth());
    expect(revoked.status).toBe(200);

    const afterRevoke = await request(app)
      .get(`/embed/v1/dashboard?token=${issued.body.token}`)
      .set('Origin', 'https://mitra.example.org');
    expect(afterRevoke.status).toBe(403);
  });

  it('TC-E2E-36 — Report Designer: buat, blok, tanda tangan, jadwal, render', async () => {
    const created = await request(app)
      .post('/api/v1/reports')
      .set(...auth())
      .send({ name: 'Laporan Bulanan E2E', watermark: 'confidential' });
    expect(created.status).toBe(201);

    await request(app)
      .put(`/api/v1/reports/${created.body.id}/blocks`)
      .set(...auth())
      .send({ blocks: [{ id: 'b1', type: 'heading', content: 'Ringkasan' }] });

    await request(app)
      .post(`/api/v1/reports/${created.body.id}/signature`)
      .set(...auth())
      .send({ signerName: 'Dian Anjani', position: 'Super Admin' });

    const scheduled = await request(app)
      .post(`/api/v1/reports/${created.body.id}/schedule`)
      .set(...auth())
      .send({ cron: '0 8 1 * *', recipients: ['direksi@e2e.test'] });
    expect(scheduled.status).toBe(200);

    const rendered = await request(app).get(`/api/v1/reports/${created.body.id}/render`).set(...auth());
    expect(rendered.status).toBe(200);
    expect(rendered.body.signature.signerName).toBe('Dian Anjani');
    // BRAND.md Bagian 8 — atribusi ditampilkan kecuali white-label.
    expect(rendered.body.attribution).toBeDefined();
  });

  it('TC-E2E-37 — langganan, faktur, dan kuota terlihat', async () => {
    const subscription = await request(app).get('/api/v1/subscription').set(...auth());
    expect(subscription.status).toBe(200);
    expect(subscription.body.subscription.plan_code).toBe('enterprise');
    expect(subscription.body.plans).toHaveLength(3);

    const preview = await request(app).post('/api/v1/subscription/preview').set(...auth()).send({ plan: 'starter' });
    expect(preview.status).toBe(200);
    // Downgrade berlaku pada siklus berikutnya (PRD 6.27).
    expect(preview.body.effective).toBe('next_cycle');

    const invoices = await request(app).get('/api/v1/invoices').set(...auth());
    expect(invoices.status).toBe(200);

    const usage = await request(app).get('/api/v1/usage').set(...auth());
    expect(usage.status).toBe(200);
    expect(usage.body.snapshot.length).toBeGreaterThan(0);
    // Metering AI dilaporkan terpisah (PRD 6.29).
    expect(usage.body.ai).toBeDefined();

    const modules = await request(app).get('/api/v1/modules').set(...auth());
    expect(modules.body.modules).toHaveLength(30);
  });

  it('TC-E2E-38 — manajemen tenant & ekspor data (portabilitas)', async () => {
    const tenants = await request(app).get('/api/v1/tenants').set(...auth());
    expect(tenants.status).toBe(200);

    const branding = await request(app)
      .patch('/api/v1/tenant/branding')
      .set(...auth())
      .send({ accentColor: '#0EA5A5', defaultLocale: 'id' });
    expect(branding.status).toBe(200);

    const invalidColour = await request(app).patch('/api/v1/tenant/branding').set(...auth()).send({ accentColor: 'merah' });
    expect(invalidColour.status).toBe(400);

    const exported = await request(app).get('/api/v1/tenant/export').set(...auth());
    expect(exported.status).toBe(200);
    expect(exported.body.dataset_catalog.length).toBeGreaterThan(0);
    // Kredensial TIDAK ikut diekspor — vault tetap tertutup.
    expect(exported.body.connection_secrets).toBeUndefined();

    const trail = await request(app).get('/api/v1/tenant/operator-access').set(...auth());
    expect(trail.status).toBe(200);
  });
});

describe('Isolasi tenant lewat HTTP (memblokir rilis)', () => {
  it('TC-E2E-39 — token tenant lain tidak dapat membaca dataset tenant ini', async () => {
    const response = await request(app)
      .get(`/api/v1/datasets/${datasetId}`)
      .set('Authorization', `Bearer ${secondTenantToken}`);
    // Dilaporkan 404, bukan 403 — agar keberadaan objek tidak bocor.
    expect(response.status).toBe(404);
  });

  it('TC-E2E-40 — daftar dataset tenant lain kosong dari data tenant ini', async () => {
    const response = await request(app).get('/api/v1/datasets').set('Authorization', `Bearer ${secondTenantToken}`);
    expect(response.status).toBe(200);
    expect(response.body.datasets).toHaveLength(0);
  });

  it('TC-E2E-41 — header X-Tenant-Id dari klien tidak mengubah cakupan data', async () => {
    const response = await request(app)
      .get('/api/v1/datasets')
      .set('Authorization', `Bearer ${secondTenantToken}`)
      .set('X-Tenant-Id', 'e2edemo');
    expect(response.body.datasets).toHaveLength(0);
  });

  it('TC-E2E-42 — Log Aktivitas tenant lain tidak memuat aktivitas tenant ini', async () => {
    const response = await request(app).get('/api/v1/audit?limit=200').set('Authorization', `Bearer ${secondTenantToken}`);
    expect(response.status).toBe(200);
    const foreign = response.body.rows.filter((r: { action: string }) => r.action === 'dataset.upload');
    expect(foreign).toHaveLength(0);
  });

  /**
   * Memakai sesi tenant kedua yang SUDAH ADA, bukan login ulang.
   *
   * Login ulang di uji ini dulu gagal, dan kegagalannya benar: satu pengguna hanya dapat
   * menyelesaikan MFA sekali per langkah waktu 30 detik — anti-replay menolak kode yang
   * langkah waktunya sudah terpakai. Uji ini adalah yang terakhir memakai token itu,
   * jadi mencabutnya di sini tidak mengganggu uji lain.
   */
  it('TC-E2E-43 — logout mencabut sesi; permintaan berikutnya ditolak', async () => {
    const before = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${secondTenantToken}`);
    expect(before.status).toBe(200);

    await request(app).post('/api/v1/auth/logout').set('Authorization', `Bearer ${secondTenantToken}`);
    const after = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${secondTenantToken}`);
    expect(after.status).toBe(401);
  });

  /**
   * Badan permintaan statistik yang salah bentuk adalah kesalahan KLIEN (400),
   * bukan kesalahan server (500). Sebelumnya nama medan yang salah menembus sampai
   * ke kode numerik dan meledak sebagai TypeError — operator melihat 500 seolah
   * server rusak, dan klien tidak mendapat petunjuk apa pun untuk memperbaikinya.
   */
  it('TC-E2E-44 — badan permintaan statistik salah bentuk ditolak 400, bukan 500', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      // `predictors` bukan nama medan yang benar (`predictorFields`).
      ['/api/v1/stats/regression', { datasetId, kind: 'linear', responseField: 'skor_csat', predictors: ['jumlah_tiket'] }],
      ['/api/v1/stats/regression', { datasetId, kind: 'linear', responseField: 'skor_csat', predictorFields: [] }],
      ['/api/v1/stats/regression', { datasetId, kind: 'linear', predictorFields: ['jumlah_tiket'] }],
      ['/api/v1/stats/descriptive', { datasetId }],
      ['/api/v1/stats/descriptive', { datasetId, fields: 'skor_csat' }],
      ['/api/v1/stats/correlation', { datasetId, fields: [] }],
      ['/api/v1/stats/correlation', { fields: ['skor_csat', 'jumlah_tiket'] }],
      ['/api/v1/stats/hypothesis', { datasetId }],
      ['/api/v1/stats/hypothesis', {}],
    ];

    for (const [path, body] of cases) {
      const response = await request(app).post(path).set(...auth()).send(body);
      expect(response.status, `${path} ${JSON.stringify(body)}`).toBe(400);
      expect(response.body.error.key).toBe('error.validation_failed');
    }
  });

  it('TC-E2E-45 — permintaan statistik yang benar tetap dilayani', async () => {
    const response = await request(app)
      .post('/api/v1/stats/regression')
      .set(...auth())
      .send({ datasetId, kind: 'linear', responseField: 'skor_csat', predictorFields: ['jumlah_tiket'] });
    expect(response.status).toBe(200);
    expect(response.body.diagnostics.durbinWatson).toBeDefined();
  });
});

/**
 * Penyajian frontend (SECURITY.md Bagian 7 — hanya aset publik yang boleh tersaji).
 *
 * Pada shared hosting, berkas startup (`app.js`, `load-env.js`, `package.json`) berada
 * di direktori aplikasi yang sama dengan `public/`. `.htaccess` menolaknya di lapis
 * Apache, tetapi aplikasi harus menolaknya sendiri juga: pemasangan di VPS tanpa Apache
 * tidak punya lapis itu, dan pertahanan berlapis tidak boleh bergantung pada konfigurasi
 * server web.
 */
describe('Penyajian frontend & proteksi lintasan berkas', () => {
  let webApp: Express;
  let webDir: string;
  let webDb: Db;
  let webAppDir: string;

  beforeAll(() => {
    webDir = mkdtempSync(join(tmpdir(), 'vantik-web-'));
    webAppDir = join(webDir, 'app');
    const publicDir = join(webAppDir, 'public');
    mkdirSync(publicDir, { recursive: true });
    writeFileSync(join(publicDir, 'index.html'), '<!doctype html><title>Vantik</title>');
    writeFileSync(join(publicDir, 'assets.a1b2c3d4.js'), 'console.log(1)');
    // Berkas internal aplikasi — sejajar dengan public/, seperti tata letak deploy asli.
    writeFileSync(join(webAppDir, 'package.json'), '{"name":"rahasia"}');
    writeFileSync(join(webAppDir, 'load-env.js'), '// rahasia');

    const created = createApp({
      paths: { main: join(webDir, 'main.db'), audit: join(webDir, 'audit.db'), vault: join(webDir, 'vault.db') },
    });
    webApp = created.app;
    webDb = created.db;
    mountWebApp(webApp, publicDir);
  });

  afterAll(() => {
    webDb.close();
    rmSync(webDir, { recursive: true, force: true });
  });

  it('TC-E2E-46 — rute SPA tanpa ekstensi dilayani index.html', async () => {
    for (const path of ['/', '/dasbor', '/analitik/uji-hipotesis', '/pengaturan/peran']) {
      const response = await request(webApp).get(path);
      expect(response.status, path).toBe(200);
      expect(response.text, path).toContain('<title>Vantik</title>');
    }
  });

  it('TC-E2E-47 — aset publik tersaji dengan cache immutable', async () => {
    const response = await request(webApp).get('/assets.a1b2c3d4.js');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('immutable');
  });

  it('TC-E2E-48 — index.html tidak boleh di-cache agar rilis baru langsung terlihat', async () => {
    const response = await request(webApp).get('/index.html');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-cache');
  });

  it('TC-E2E-49 — berkas internal aplikasi tidak tersaji, dan TIDAK dijawab index.html', async () => {
    for (const path of [
      '/package.json',
      '/load-env.js',
      '/app.js',
      '/.env',
      '/vantik.db',
      '/vantik.db-wal',
      '/server/server.js',
      '/node_modules/express/package.json',
      '/../app/package.json',
    ]) {
      const response = await request(webApp).get(path);
      expect(response.status, path).toBe(404);
      // Menjawab index.html di sini akan menutupi kebocoran nyata dari mata penguji.
      expect(response.text, path).not.toContain('<title>Vantik</title>');
    }
  });

  /**
   * Lintasan API tidak pernah jatuh ke index.html.
   *
   * Tanpa autentikasi, jawabannya 401 — BUKAN 404 — karena middleware autentikasi
   * berjalan sebelum pencocokan rute. Itu memang yang diinginkan: 404 untuk rute tak
   * dikenal dan 401 untuk rute dikenal akan memberi pemanggil anonim cara memetakan
   * permukaan API (SECURITY.md 16.1, alasan yang sama seperti lintas-tenant → 404).
   */
  it('TC-E2E-50 — lintasan API menjawab JSON, bukan index.html', async () => {
    for (const path of ['/api/v1/tidak-ada', '/api/v1/me']) {
      const response = await request(webApp).get(path);
      expect(response.status, path).toBe(401);
      expect(response.body.error.key, path).toBeDefined();
      expect(response.text, path).not.toContain('<title>Vantik</title>');
    }
  });
});
