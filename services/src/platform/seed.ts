/**
 * Data contoh untuk pengembangan & demo.
 *
 * DESIGN.md Bagian 1 & PRD Bagian 3.1: contoh data WAJIB mewakili beragam sektor
 * (riset, penjualan, layanan pelanggan, keuangan, publik, pendidikan, kesehatan,
 * logistik, operasional) — bukan didominasi satu industri. Seluruh data di sini
 * sintetis (TESTING.md Bagian 11: data produksi tidak pernah dipakai).
 */
import { createApp } from '../app.ts';
import { AlertService } from '../alerting-service/index.ts';
import { DatasetService, KpiService } from '../data-platform-service/index.ts';
import { DashboardService } from '../designer-service/index.ts';
import { DigitalTwinService } from '../iot-gateway-service/index.ts';
import { BalancedScorecardService } from '../presentation-service/index.ts';
import { AuthorizationService, EmployeeService } from '../identity-service/index.ts';
import { RequestContext, loadFeatureFlags, toTenantInfo } from './context.ts';
import type { Db } from './db.ts';
import type { AuditService } from '../audit-service/index.ts';
import type { DatasetRow } from '../data-platform-service/dataQuality.ts';
import { STANDARD_ROLES } from './rbac.ts';

/** Membangun konteks super-admin untuk proses penanaman data (bukan jalur HTTP). */
function seedContext(db: Db, audit: AuditService, tenantId: string, userId: string): RequestContext {
  const tenantRow = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId) as Parameters<typeof toTenantInfo>[0];
  const user = db.prepare('SELECT * FROM system_user WHERE id = ?').get(userId) as {
    id: string;
    employee_id: string;
    email: string;
  };
  const superAdmin = STANDARD_ROLES.find((r) => r.code === 'super_admin')!;
  const tenant = toTenantInfo(tenantRow);

  return new RequestContext(
    db,
    tenant,
    {
      userId: user.id,
      employeeId: user.employee_id,
      email: user.email,
      displayName: 'Seed Administrator',
      locale: 'id',
      theme: 'light',
      roleIds: ['role_super_admin'],
      roleCodes: ['super_admin'],
      sessionId: 'seed-session',
      // Penanaman data menjalankan aksi sensitif; ditandai sebagai baru terautentikasi.
      reauthAt: new Date().toISOString(),
      mfaEnrolled: true,
    },
    [{ permissions: superAdmin.permissions, denials: superAdmin.denials }],
    loadFeatureFlags(db, tenant.id, tenant.status),
    audit,
    null,
  );
}

function csv(header: string[], rows: Array<Array<string | number>>): Buffer {
  return Buffer.from([header.join(','), ...rows.map((r) => r.join(','))].join('\n'), 'utf8');
}

/** Deret angka deterministik (tanpa Math.random) agar seed dapat direproduksi. */
function pseudo(seed: number, index: number): number {
  const x = Math.sin(seed * 97.13 + index * 31.7) * 10_000;
  return x - Math.floor(x);
}

export function seed(): void {
  const { db, audit, tenants } = createApp();

  const existing = db.prepare("SELECT id FROM tenants WHERE slug = 'demo'").get() as { id: string } | undefined;
  if (existing) {
    console.log('[seed] tenant "demo" already exists — nothing to do');
    return;
  }

  const { tenantId, adminUserId } = tenants.provision(
    {
      name: 'Organisasi Demo Vantik',
      slug: 'demo',
      planCode: 'enterprise',
      billingCycle: 'annual',
      trialDays: 30,
      admin: {
        fullName: 'Dian Anjani',
        nik: '3273010101900001',
        email: 'admin@demo.vantik.id',
        password: 'VantikDemo#2026',
        division: 'Teknologi Informasi',
        position: 'Super Admin',
      },
      defaultLocale: 'id',
    },
    'seed',
  );

  const ctx = seedContext(db, audit, tenantId, adminUserId);
  const employees = new EmployeeService(ctx);
  const authorization = new AuthorizationService(ctx);
  const datasets = new DatasetService(ctx);
  const kpis = new KpiService(ctx);
  const alerts = new AlertService(ctx);
  const dashboards = new DashboardService(ctx);
  const twin = new DigitalTwinService(ctx);
  const bsc = new BalancedScorecardService(ctx);

  /* ---------------- Master Pegawai lintas divisi ---------------- */

  const staff = [
    ['Rizky Pratama', '3273010101910002', 'Layanan Pelanggan', 'Supervisor', 'rizky@demo.vantik.id'],
    ['Sari Wulandari', '3273010101920003', 'Keuangan', 'Manajer', 'sari@demo.vantik.id'],
    ['Bagas Nugroho', '3273010101930004', 'Data & Analitik', 'Data Engineer', 'bagas@demo.vantik.id'],
    ['Maya Kusuma', '3273010101940005', 'Data & Analitik', 'Data Steward', 'maya@demo.vantik.id'],
    ['Andi Setiawan', '3273010101950006', 'Riset', 'Peneliti', 'andi@demo.vantik.id'],
    ['Putri Lestari', '3273010101960007', 'Kepatuhan', 'Auditor', 'putri@demo.vantik.id'],
  ] as const;

  for (const [fullName, nik, division, position, email] of staff) {
    employees.create({ fullName, nik, division, position, email });
  }

  const roleForEmail: Record<string, string[]> = {
    'rizky@demo.vantik.id': ['supervisor'],
    'sari@demo.vantik.id': ['manager'],
    'bagas@demo.vantik.id': ['data_engineer'],
    'maya@demo.vantik.id': ['data_steward'],
    'andi@demo.vantik.id': ['business_analyst', 'ai_analyst'],
    'putri@demo.vantik.id': ['auditor'],
  };

  for (const [fullName, , , , email] of staff) {
    const employee = ctx.db.get<{ id: string }>('employee_master', { email })!;
    authorization.createUser({
      employeeId: employee.id,
      email,
      password: 'VantikDemo#2026',
      roleCodes: roleForEmail[email] ?? ['business_analyst'],
    });
    void fullName;
  }

  // RLS contoh: Supervisor dibatasi ke satu wilayah — dipakai uji negatif TESTING.md 4.
  const supervisor = ctx.db.get<{ id: string }>('system_user', { email: 'rizky@demo.vantik.id' })!;
  authorization.setRls(
    { type: 'user', id: supervisor.id },
    [{ dimension: 'wilayah', operator: 'in', values: ['Wilayah Timur'] }],
  );

  /* ---------------- Dataset lintas sektor ---------------- */

  const wilayah = ['Wilayah Timur', 'Wilayah Barat', 'Wilayah Tengah', 'Wilayah Utara'];
  const kanal = ['Chat', 'Telepon', 'Email', 'Tatap Muka'];

  // 1) Layanan pelanggan
  const ticketRows: Array<Array<string | number>> = [];
  for (let i = 0; i < 480; i++) {
    const month = 1 + (i % 12);
    ticketRows.push([
      `2026-${String(month).padStart(2, '0')}-15`,
      wilayah[i % wilayah.length]!,
      kanal[i % kanal.length]!,
      Math.round(40 + pseudo(1, i) * 120),
      Number((2 + pseudo(2, i) * 20).toFixed(1)),
      Number((3.2 + pseudo(3, i) * 1.7).toFixed(2)),
    ]);
  }
  const tickets = datasets.upload({
    filename: 'layanan-pelanggan.csv',
    name: 'Layanan Pelanggan — Tiket & CSAT',
    content: csv(
      ['tanggal', 'wilayah', 'kanal', 'jumlah_tiket', 'waktu_respons_menit', 'skor_csat'],
      ticketRows,
    ),
  });

  // 2) Riset & survei (untuk modul Analisis Statistik)
  const surveyRows: Array<Array<string | number>> = [];
  for (let i = 0; i < 300; i++) {
    const group = i % 3 === 0 ? 'Kontrol' : i % 3 === 1 ? 'Perlakuan A' : 'Perlakuan B';
    const base = group === 'Kontrol' ? 62 : group === 'Perlakuan A' ? 68 : 74;
    surveyRows.push([
      `R-${1000 + i}`,
      group,
      wilayah[i % wilayah.length]!,
      Math.round(base + (pseudo(4, i) - 0.5) * 22),
      Math.round(20 + pseudo(5, i) * 40),
      Number((1 + pseudo(6, i) * 9).toFixed(2)),
    ]);
  }
  const survey = datasets.upload({
    filename: 'riset-kepuasan.csv',
    name: 'Riset — Uji Coba Terkontrol',
    content: csv(
      ['responden_id', 'kelompok', 'wilayah', 'skor_hasil', 'usia', 'jam_paparan'],
      surveyRows,
    ),
  });

  // 3) Keuangan
  const financeRows: Array<Array<string | number>> = [];
  for (let i = 0; i < 240; i++) {
    const month = 1 + (i % 12);
    financeRows.push([
      `2026-${String(month).padStart(2, '0')}-01`,
      wilayah[i % wilayah.length]!,
      ['Operasional', 'Pemasaran', 'SDM', 'Teknologi'][i % 4]!,
      Math.round(50_000_000 + pseudo(7, i) * 250_000_000),
      Math.round(45_000_000 + pseudo(8, i) * 260_000_000),
    ]);
  }
  datasets.upload({
    filename: 'keuangan-anggaran.csv',
    name: 'Keuangan — Realisasi vs Anggaran',
    content: csv(['periode', 'wilayah', 'kategori', 'anggaran', 'realisasi'], financeRows),
  });

  // Sertifikasi oleh Data Steward — Executive Cockpit hanya memakai dataset Certified.
  datasets.certify(tickets.dataset.id, 'certified', 'Lolos tinjauan kualitas (seed)');
  datasets.certify(survey.dataset.id, 'certified', 'Lolos tinjauan kualitas (seed)');

  /* ---------------- KPI Center + histori 24 bulan ---------------- */

  const kpiCsat = kpis.create({
    code: 'CSAT',
    name: 'Skor Kepuasan Pelanggan',
    formula: 'AVG(skor_csat)',
    datasetId: tickets.dataset.id,
    measureField: 'skor_csat',
    dimensionField: 'wilayah',
    unit: 'skor',
    direction: 'higher_better',
    target: 4.5,
    weight: 1.5,
    thresholds: [
      { level: 'critical', comparator: 'lte', value: 3.5 },
      { level: 'at_risk', comparator: 'lte', value: 4.0 },
    ],
  });

  const kpiResponse = kpis.create({
    code: 'RESP_TIME',
    name: 'Waktu Respons Layanan',
    formula: 'AVG(waktu_respons_menit)',
    datasetId: tickets.dataset.id,
    measureField: 'waktu_respons_menit',
    dimensionField: 'wilayah',
    unit: 'menit',
    direction: 'lower_better',
    target: 8,
    weight: 1,
    thresholds: [
      { level: 'critical', comparator: 'gte', value: 18 },
      { level: 'at_risk', comparator: 'gte', value: 12 },
    ],
  });

  const kpiTickets = kpis.create({
    code: 'TICKET_VOL',
    name: 'Volume Tiket Masuk',
    formula: 'SUM(jumlah_tiket)',
    datasetId: tickets.dataset.id,
    measureField: 'jumlah_tiket',
    dimensionField: 'wilayah',
    unit: 'tiket',
    direction: 'lower_better',
    target: 12_000,
    weight: 0.8,
    thresholds: [{ level: 'at_risk', comparator: 'gte', value: 15_000 }],
  });

  const rows = datasets.allRows(tickets.dataset.id);
  const now = new Date();
  for (let back = 23; back >= 0; back--) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const period = date.toISOString().slice(0, 7);
    for (const kpi of [kpiCsat, kpiResponse, kpiTickets]) {
      // Variasi deterministik per periode agar tren terlihat wajar di demo.
      const factor = 0.85 + pseudo(kpi.code.length, back) * 0.3;
      const scale = (value: unknown, by: number): number | null =>
        typeof value === 'number' ? value * by : null;
      const scaled: DatasetRow[] = rows.map((r) => ({
        ...r,
        skor_csat: scale(r.skor_csat, factor),
        waktu_respons_menit: scale(r.waktu_respons_menit, 2 - factor),
        jumlah_tiket: scale(r.jumlah_tiket, factor),
      }));
      kpis.captureScores(kpi.id, period, scaled);
    }
  }

  /* ---------------- Alert Center ---------------- */

  alerts.createRule({
    name: 'CSAT di bawah ambang batas',
    kpiId: kpiCsat.id,
    comparator: 'lte',
    threshold: 4.0,
    channels: ['email', 'slack'],
    recipients: ['sari@demo.vantik.id', '#layanan-pelanggan'],
    cooldownMinutes: 120,
  });
  alerts.createRule({
    name: 'Waktu respons melebihi 12 menit',
    kpiId: kpiResponse.id,
    comparator: 'gte',
    threshold: 12,
    channels: ['email', 'whatsapp', 'teams'],
    recipients: ['rizky@demo.vantik.id'],
  });

  /* ---------------- Dashboard ---------------- */

  const dashboard = dashboards.create({
    name: 'Kinerja Layanan Pelanggan',
    templateCode: 'customer_service',
    description: 'Volume tiket, waktu respons, dan CSAT per wilayah',
  });
  dashboards.saveDraft(dashboard.id, [
    { id: 'w1', type: 'threshold_ring', title: 'CSAT', x: 0, y: 0, w: 3, h: 2, kpiId: kpiCsat.id },
    { id: 'w2', type: 'threshold_ring', title: 'Waktu Respons', x: 3, y: 0, w: 3, h: 2, kpiId: kpiResponse.id },
    { id: 'w3', type: 'line', title: 'Tren CSAT', x: 0, y: 2, w: 8, h: 4, kpiId: kpiCsat.id },
    { id: 'w4', type: 'bar', title: 'Tiket per Kanal', x: 8, y: 2, w: 4, h: 4, datasetId: tickets.dataset.id },
    { id: 'w5', type: 'table', title: 'Rincian Wilayah', x: 0, y: 6, w: 12, h: 4, datasetId: tickets.dataset.id },
  ]);
  dashboards.publish(dashboard.id);

  /* ---------------- Balanced Scorecard ---------------- */

  bsc.seedStandardPerspectives();
  const perspectives = ctx.db.all<{ id: string; code: string }>('bsc_perspectives');
  const customer = perspectives.find((p) => p.code === 'customer');
  const internal = perspectives.find((p) => p.code === 'internal_process');
  if (customer) {
    bsc.addObjective({
      perspectiveId: customer.id,
      name: 'Meningkatkan kepuasan pelanggan',
      kpiId: kpiCsat.id,
      target: 4.5,
      initiatives: ['Pelatihan agen kanal chat', 'Perbarui basis pengetahuan produk'],
    });
  }
  if (internal) {
    bsc.addObjective({
      perspectiveId: internal.id,
      name: 'Mempercepat waktu respons layanan',
      kpiId: kpiResponse.id,
      target: 8,
      initiatives: ['Otomasi triase tiket'],
    });
  }

  /* ---------------- Digital Twin lintas sektor ---------------- */

  const zone = twin.createZone({ name: 'Gedung Operasional A' });
  const assetConfigs = [
    { code: 'HVAC-01', name: 'Unit HVAC Lantai 1', category: 'hvac', sensors: [
      { code: 'temperature', label: 'Suhu', unit: '°C', warnMin: 18, warnMax: 26, critMin: 15, critMax: 30, weight: 1.5 },
      { code: 'vibration', label: 'Getaran', unit: 'mm/s', warnMax: 4.5, critMax: 7, weight: 1.2 },
      { code: 'power', label: 'Konsumsi Daya', unit: 'kWh', warnMax: 90, critMax: 120 },
    ] },
    { code: 'LAB-FRZ-02', name: 'Freezer Laboratorium', category: 'laboratory', sensors: [
      { code: 'temperature', label: 'Suhu', unit: '°C', warnMin: -82, warnMax: -74, critMin: -85, critMax: -70, weight: 2 },
      { code: 'power', label: 'Konsumsi Daya', unit: 'kWh', warnMax: 40, critMax: 55 },
    ] },
    { code: 'FLEET-07', name: 'Kendaraan Dinas 07', category: 'vehicle', sensors: [
      { code: 'fuel_level', label: 'Level Bahan Bakar', unit: '%', warnMin: 20, critMin: 8, weight: 1 },
      { code: 'engine_temp', label: 'Suhu Mesin', unit: '°C', warnMax: 100, critMax: 115, weight: 1.4 },
    ] },
  ];

  for (const config of assetConfigs) {
    twin.createAsset({ ...config, zoneId: zone.id, posX: 20, posY: 30 });
  }

  // Pembacaan historis dengan tren naik pada getaran HVAC agar prediksi kegagalan bermakna.
  const readingsPerSensor = 60;
  void (async () => {
    for (let i = 0; i < readingsPerSensor; i++) {
      const observedAt = new Date(Date.now() - (readingsPerSensor - i) * 3_600_000).toISOString();
      await twin.ingestReading({ assetCode: 'HVAC-01', sensorCode: 'temperature', value: 22 + pseudo(9, i) * 3, observedAt });
      await twin.ingestReading({ assetCode: 'HVAC-01', sensorCode: 'vibration', value: 2.4 + i * 0.045 + pseudo(10, i) * 0.3, observedAt });
      await twin.ingestReading({ assetCode: 'HVAC-01', sensorCode: 'power', value: 60 + pseudo(11, i) * 20, observedAt });
      await twin.ingestReading({ assetCode: 'LAB-FRZ-02', sensorCode: 'temperature', value: -78 + pseudo(12, i) * 3, observedAt });
      await twin.ingestReading({ assetCode: 'LAB-FRZ-02', sensorCode: 'power', value: 28 + pseudo(13, i) * 8, observedAt });
      await twin.ingestReading({ assetCode: 'FLEET-07', sensorCode: 'fuel_level', value: Math.max(5, 85 - i * 1.1), observedAt });
      await twin.ingestReading({ assetCode: 'FLEET-07', sensorCode: 'engine_temp', value: 88 + pseudo(14, i) * 12, observedAt });
    }
    twin.predictFailure(ctx.db.get<{ id: string }>('assets', { code: 'HVAC-01' })!.id);

    console.log('[seed] done');
    console.log('[seed] tenant slug : demo');
    console.log('[seed] admin login : admin@demo.vantik.id / VantikDemo#2026');
    console.log('[seed] other users : rizky|sari|bagas|maya|andi|putri @demo.vantik.id (same password)');
    db.close();
  })();
}

const invokedDirectly = process.argv[1]?.includes('seed');
if (invokedDirectly) seed();
