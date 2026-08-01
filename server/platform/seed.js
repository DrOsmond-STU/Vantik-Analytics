"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.seed = seed;
/**
 * Data contoh untuk pengembangan & demo.
 *
 * DESIGN.md Bagian 1 & PRD Bagian 3.1: contoh data WAJIB mewakili beragam sektor
 * (riset, penjualan, layanan pelanggan, keuangan, publik, pendidikan, kesehatan,
 * logistik, operasional) — bukan didominasi satu industri. Seluruh data di sini
 * sintetis (TESTING.md Bagian 11: data produksi tidak pernah dipakai).
 */
const node_crypto_1 = require("node:crypto");
const app_ts_1 = require("../app.js");
const index_ts_1 = require("../alerting-service/index.js");
const index_ts_2 = require("../data-platform-service/index.js");
const index_ts_3 = require("../designer-service/index.js");
const index_ts_4 = require("../iot-gateway-service/index.js");
const index_ts_5 = require("../presentation-service/index.js");
const index_ts_6 = require("../identity-service/index.js");
const index_ts_7 = require("../ai-engine-service/index.js");
const index_ts_8 = require("../billing-service/index.js");
const index_ts_9 = require("../metering-service/index.js");
const outbox_ts_1 = require("./outbox.js");
const context_ts_1 = require("./context.js");
const rbac_ts_1 = require("./rbac.js");
/**
 * Rahasia MFA akun uji coba — TETAP dan sengaja dicetak.
 *
 * Akun uji coba ada supaya seseorang dapat membuka aplikasi dan melihatnya bekerja.
 * Perannya `super_admin` agar seluruh modul terlihat, dan peran itu MEWAJIBKAN
 * verifikasi dua langkah (SECURITY.md Bagian 4) — jadi tanpa MFA yang sudah terpasang,
 * "akun uji coba" berarti layar pendaftaran authenticator, bukan aplikasinya.
 *
 * Rahasia tetap ini aman HANYA karena akun ini data contoh: `seed` tidak dijalankan di
 * production (panduan pemasangan menyatakannya, dan daftar periksa pasca-pasang
 * memintanya diverifikasi). Kalau seseorang menjalankannya di production, akun inilah
 * yang pertama harus dihapus.
 */
const TRIAL_MFA_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
/** Membangun konteks super-admin untuk proses penanaman data (bukan jalur HTTP). */
function seedContext(db, audit, tenantId, userId) {
    const tenantRow = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
    const user = db.prepare('SELECT * FROM system_user WHERE id = ?').get(userId);
    const superAdmin = rbac_ts_1.STANDARD_ROLES.find((r) => r.code === 'super_admin');
    const tenant = (0, context_ts_1.toTenantInfo)(tenantRow);
    return new context_ts_1.RequestContext(db, tenant, {
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
    }, [{ permissions: superAdmin.permissions, denials: superAdmin.denials }], (0, context_ts_1.loadFeatureFlags)(db, tenant.id, tenant.status), audit, null);
}
function csv(header, rows) {
    return Buffer.from([header.join(','), ...rows.map((r) => r.join(','))].join('\n'), 'utf8');
}
/** Deret angka deterministik (tanpa Math.random) agar seed dapat direproduksi. */
function pseudo(seed, index) {
    const x = Math.sin(seed * 97.13 + index * 31.7) * 10_000;
    return x - Math.floor(x);
}
/**
 * `seed()` bersifat async karena sebagian layanan memang async (ingest sensor,
 * evaluasi alert, tanya-jawab AI).
 *
 * Sebelumnya bagian async dijalankan sebagai `void (async () => { … })()`, sehingga
 * kegagalan di dalamnya menjadi unhandled rejection: `npm run seed` dapat keluar dengan
 * kode 0 sambil meninggalkan basis data separuh terisi, dan tidak ada yang tahu. Sekarang
 * kegagalan merambat ke pemanggil dan prosesnya keluar dengan kode bukan-nol.
 */
async function seed() {
    const { db, audit, tenants, keyring } = (0, app_ts_1.createApp)();
    const existing = db.prepare("SELECT id FROM tenants WHERE slug = 'demo'").get();
    if (existing) {
        console.log('[seed] tenant "demo" already exists — nothing to do');
        return;
    }
    const { tenantId, adminUserId } = tenants.provision({
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
    }, 'seed');
    const ctx = seedContext(db, audit, tenantId, adminUserId);
    const employees = new index_ts_6.EmployeeService(ctx);
    const authorization = new index_ts_6.AuthorizationService(ctx);
    const datasets = new index_ts_2.DatasetService(ctx);
    const kpis = new index_ts_2.KpiService(ctx);
    const alerts = new index_ts_1.AlertService(ctx, undefined, new outbox_ts_1.NotificationOutbox(db));
    const dashboards = new index_ts_3.DashboardService(ctx);
    const twin = new index_ts_4.DigitalTwinService(ctx);
    const bsc = new index_ts_5.BalancedScorecardService(ctx);
    const metering = new index_ts_9.MeteringService(ctx);
    const modeling = new index_ts_2.DataModelingService(ctx);
    const connections = new index_ts_2.ConnectionService(ctx, keyring, undefined, metering);
    const reports = new index_ts_3.ReportService(ctx);
    const embed = new index_ts_3.EmbedService(ctx, metering);
    const ai = new index_ts_7.AiAnalyticsService(ctx, undefined, metering);
    const forecast = new index_ts_7.ForecastService(ctx);
    const rca = new index_ts_7.RcaService(ctx);
    const narrative = new index_ts_7.NarrativeService(ctx);
    const billing = new index_ts_8.BillingService(ctx, metering);
    /* ---------------- Master Pegawai lintas divisi ---------------- */
    const staff = [
        ['Rizky Pratama', '3273010101910002', 'Layanan Pelanggan', 'Supervisor', 'rizky@demo.vantik.id'],
        ['Sari Wulandari', '3273010101920003', 'Keuangan', 'Manajer', 'sari@demo.vantik.id'],
        ['Bagas Nugroho', '3273010101930004', 'Data & Analitik', 'Data Engineer', 'bagas@demo.vantik.id'],
        ['Maya Kusuma', '3273010101940005', 'Data & Analitik', 'Data Steward', 'maya@demo.vantik.id'],
        ['Andi Setiawan', '3273010101950006', 'Riset', 'Peneliti', 'andi@demo.vantik.id'],
        ['Putri Lestari', '3273010101960007', 'Kepatuhan', 'Auditor', 'putri@demo.vantik.id'],
        // Platform Operator: peran lintas-tenant yang memutuskan pendaftaran mandiri.
        // Tanpa satu pun akun berperan ini, antrean persetujuan tidak punya pemilik dan
        // kabar "ada pendaftaran baru" tidak punya alamat tujuan.
        ['Gilang Prakoso', '3273010101970008', 'Operasional Platform', 'Platform Operator', 'operator@vantik.id'],
    ];
    for (const [fullName, nik, division, position, email] of staff) {
        employees.create({ fullName, nik, division, position, email });
    }
    const roleForEmail = {
        'rizky@demo.vantik.id': ['supervisor'],
        'sari@demo.vantik.id': ['manager'],
        'bagas@demo.vantik.id': ['data_engineer'],
        'maya@demo.vantik.id': ['data_steward'],
        'andi@demo.vantik.id': ['business_analyst', 'ai_analyst'],
        'putri@demo.vantik.id': ['auditor'],
        'operator@vantik.id': ['platform_operator'],
    };
    for (const [fullName, , , , email] of staff) {
        const employee = ctx.db.get('employee_master', { email });
        authorization.createUser({
            employeeId: employee.id,
            email,
            password: 'VantikDemo#2026',
            roleCodes: roleForEmail[email] ?? ['business_analyst'],
        });
        void fullName;
    }
    // RLS contoh: Supervisor dibatasi ke satu wilayah — dipakai uji negatif TESTING.md 4.
    const supervisor = ctx.db.get('system_user', { email: 'rizky@demo.vantik.id' });
    authorization.setRls({ type: 'user', id: supervisor.id }, [{ dimension: 'wilayah', operator: 'in', values: ['Wilayah Timur'] }]);
    /* ---------------- Dataset lintas sektor ---------------- */
    const wilayah = ['Wilayah Timur', 'Wilayah Barat', 'Wilayah Tengah', 'Wilayah Utara'];
    const kanal = ['Chat', 'Telepon', 'Email', 'Tatap Muka'];
    // 1) Layanan pelanggan
    const ticketRows = [];
    for (let i = 0; i < 480; i++) {
        const month = 1 + (i % 12);
        ticketRows.push([
            `2026-${String(month).padStart(2, '0')}-15`,
            wilayah[i % wilayah.length],
            kanal[i % kanal.length],
            Math.round(40 + pseudo(1, i) * 120),
            Number((2 + pseudo(2, i) * 20).toFixed(1)),
            Number((3.2 + pseudo(3, i) * 1.7).toFixed(2)),
        ]);
    }
    const tickets = datasets.upload({
        filename: 'layanan-pelanggan.csv',
        name: 'Layanan Pelanggan — Tiket & CSAT',
        content: csv(['tanggal', 'wilayah', 'kanal', 'jumlah_tiket', 'waktu_respons_menit', 'skor_csat'], ticketRows),
    });
    // 2) Riset & survei (untuk modul Analisis Statistik)
    const surveyRows = [];
    for (let i = 0; i < 300; i++) {
        const group = i % 3 === 0 ? 'Kontrol' : i % 3 === 1 ? 'Perlakuan A' : 'Perlakuan B';
        const base = group === 'Kontrol' ? 62 : group === 'Perlakuan A' ? 68 : 74;
        surveyRows.push([
            `R-${1000 + i}`,
            group,
            wilayah[i % wilayah.length],
            Math.round(base + (pseudo(4, i) - 0.5) * 22),
            Math.round(20 + pseudo(5, i) * 40),
            Number((1 + pseudo(6, i) * 9).toFixed(2)),
        ]);
    }
    const survey = datasets.upload({
        filename: 'riset-kepuasan.csv',
        name: 'Riset — Uji Coba Terkontrol',
        content: csv(['responden_id', 'kelompok', 'wilayah', 'skor_hasil', 'usia', 'jam_paparan'], surveyRows),
    });
    // 3) Keuangan
    const financeRows = [];
    for (let i = 0; i < 240; i++) {
        const month = 1 + (i % 12);
        financeRows.push([
            `2026-${String(month).padStart(2, '0')}-01`,
            wilayah[i % wilayah.length],
            ['Operasional', 'Pemasaran', 'SDM', 'Teknologi'][i % 4],
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
            const scale = (value, by) => typeof value === 'number' ? value * by : null;
            const scaled = rows.map((r) => ({
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
        // Sebuah aturan mengirim ke SETIAP kanal × SETIAP penerima. Menyertakan nama kanal
        // Slack di sini akan menghasilkan kombinasi "email ke #layanan-pelanggan" yang mustahil
        // terkirim, lalu mengendap sebagai baris merah di antrean data contoh — operator yang
        // baru memasang SMTP akan menyimpulkan konfigurasinya gagal, padahal data contohnya
        // yang tidak masuk akal.
        recipients: ['sari@demo.vantik.id'],
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
    const perspectives = ctx.db.all('bsc_perspectives');
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
    const hvacId = ctx.db.get('assets', { code: 'HVAC-01' }).id;
    twin.predictFailure(hvacId);
    /* ---------------- Tiket pemeliharaan (PRD 6.17) ---------------- */
    // Prediksi kegagalan tanpa tindak lanjut hanya menjadi angka di layar. Satu tiket
    // terbuka memperlihatkan alurnya sampai selesai.
    twin.createTicket(hvacId, {
        title: 'Getaran HVAC-01 naik terus selama 60 jam — jadwalkan inspeksi bearing',
        priority: 'high',
        externalRef: 'WO-2026-0417',
    });
    twin.createTicket(ctx.db.get('assets', { code: 'FLEET-07' }).id, {
        title: 'Kendaraan Dinas 07: isi bahan bakar sebelum jadwal operasional berikutnya',
        priority: 'low',
    });
    /* ---------------- Koneksi Eksternal (PRD 6.12) ---------------- */
    // Kredensial di sini sintetis. Yang ditanam sengaja BUKAN kredensial yang bekerja:
    // seed yang berisi kata sandi nyata akan berakhir di riwayat commit selamanya.
    const crm = connections.create({
        name: 'CRM Produksi (PostgreSQL)',
        kind: 'postgresql',
        host: 'db-crm.internal.demo.id',
        port: 5432,
        databaseName: 'crm',
        username: 'vantik_reader',
        secrets: { password: 'sandi-contoh-tidak-berlaku' },
        schedule: 'hourly',
        readOnly: true,
    });
    connections.create({
        name: 'API Gudang (REST)',
        kind: 'rest_api',
        host: 'api.gudang.demo.id',
        options: { basePath: '/v2/stok', authHeader: 'X-Api-Key' },
        secrets: { apiKey: 'kunci-contoh-tidak-berlaku' },
        schedule: 'daily',
        readOnly: true,
    });
    const legacy = connections.create({
        name: 'Basis Data Warisan (MySQL)',
        kind: 'mysql',
        host: 'legacy.demo.id',
        port: 3306,
        databaseName: 'helpdesk_lama',
        username: 'migrasi',
        secrets: { password: 'sandi-contoh-tidak-berlaku' },
        schedule: 'manual',
        readOnly: true,
    });
    // Riwayat sinkronisasi memuat KEDUA hasil. Riwayat yang hanya berisi keberhasilan
    // membuat operator tidak pernah melihat bentuk kegagalan sampai kegagalan pertama terjadi.
    await connections.sync(crm.id, async () => ({
        rows: Array.from({ length: 240 }, (_, i) => ({
            id_pelanggan: `CUST-${1000 + i}`,
            segmen: ['Korporat', 'UMKM', 'Ritel'][i % 3],
            nilai_kontrak: Math.round(5_000_000 + pseudo(21, i) * 45_000_000),
        })),
    }));
    await connections.sync(legacy.id, async () => {
        throw new Error('host tidak dapat dijangkau dari jaringan aplikasi');
    });
    /* ---------------- Data Modeling & kamus bisnis (PRD 6.13) ---------------- */
    modeling.createTable({
        name: 'fakta_tiket',
        kind: 'fact',
        grain: 'Satu baris per tiket layanan',
        description: 'Tabel fakta utama untuk analisis beban dan mutu layanan',
    });
    modeling.createTable({ name: 'dim_wilayah', kind: 'dimension', scdType: 2, description: 'Hierarki wilayah operasional' });
    modeling.createTable({ name: 'dim_kanal', kind: 'dimension', scdType: 1, description: 'Kanal masuknya tiket' });
    modeling.createTable({ name: 'dim_waktu', kind: 'dimension', description: 'Kalender bulanan' });
    modeling.addField({ tableName: 'fakta_tiket', name: 'jumlah_tiket', dataType: 'integer', role: 'measure' });
    modeling.addField({ tableName: 'fakta_tiket', name: 'waktu_respons_menit', dataType: 'number', role: 'measure' });
    modeling.addField({ tableName: 'fakta_tiket', name: 'skor_csat', dataType: 'number', role: 'measure' });
    modeling.addField({
        tableName: 'fakta_tiket',
        name: 'tiket_per_menit_respons',
        dataType: 'number',
        role: 'measure',
        formula: 'SUM(jumlah_tiket) / AVG(waktu_respons_menit)',
        description: 'Ukuran turunan: beban relatif terhadap kecepatan respons',
    });
    modeling.addField({ tableName: 'fakta_tiket', name: 'wilayah', dataType: 'text', role: 'dimension' });
    modeling.addField({ tableName: 'fakta_tiket', name: 'kanal', dataType: 'text', role: 'dimension' });
    modeling.addField({ tableName: 'fakta_tiket', name: 'periode', dataType: 'text', role: 'time' });
    modeling.addField({ tableName: 'dim_wilayah', name: 'nama_wilayah', dataType: 'text', role: 'key' });
    modeling.addField({ tableName: 'dim_kanal', name: 'nama_kanal', dataType: 'text', role: 'key' });
    modeling.addField({ tableName: 'dim_waktu', name: 'bulan', dataType: 'text', role: 'time' });
    const dictionary = [
        ['CSAT', 'Customer Satisfaction Score — rata-rata skor kepuasan pelanggan pada skala 1–5, diukur dari survei pasca-interaksi.', 'Average post-interaction customer satisfaction score on a 1–5 scale.'],
        ['SLA', 'Service Level Agreement — batas waktu respons yang dijanjikan kepada pelanggan, dihitung sejak tiket masuk.', 'Promised response time limit, measured from ticket creation.'],
        ['FCR', 'First Contact Resolution — proporsi tiket yang selesai pada kontak pertama tanpa eskalasi.', 'Share of tickets resolved on first contact without escalation.'],
        ['Tiket Eskalasi', 'Tiket yang dipindahkan ke jenjang penanganan lebih tinggi karena melebihi SLA atau butuh kewenangan khusus.', 'A ticket moved to a higher support tier after breaching SLA or needing special authority.'],
        ['Wilayah', 'Unit geografis operasional. Dipakai sebagai dimensi pembatas Row-Level Security bagi peran berbasis wilayah.', 'Operational geographic unit, also used as the Row-Level Security dimension for region-scoped roles.'],
    ];
    const rizkyEmployee = ctx.db.get('employee_master', { email: 'rizky@demo.vantik.id' });
    for (const [term, id_, en] of dictionary) {
        modeling.upsertTerm({ term, definitionId: id_, definitionEn: en, ownerEmployeeId: rizkyEmployee?.id });
    }
    /* ---------------- Report Designer (PRD 6.5) ---------------- */
    const monthly = reports.create({
        name: 'Laporan Kinerja Layanan Bulanan',
        pageSize: 'A4',
        orientation: 'portrait',
        watermark: 'none',
        classification: 'internal',
    });
    reports.saveBlocks(monthly.id, [
        { id: 'b1', type: 'heading', content: 'Kinerja Layanan Pelanggan' },
        { id: 'b2', type: 'text', content: 'Ringkasan bulanan volume tiket, kecepatan respons, dan kepuasan pelanggan per wilayah. Seluruh angka berasal dari KPI Center; tidak ada angka yang dihitung ulang di dalam laporan ini.' },
        { id: 'b3', type: 'chart', datasetId: tickets.dataset.id, config: { kind: 'line', measure: 'skor_csat', dimension: 'periode' } },
        { id: 'b4', type: 'table', datasetId: tickets.dataset.id, config: { groupBy: 'wilayah', measures: ['jumlah_tiket', 'skor_csat'] } },
        { id: 'b5', type: 'pagebreak' },
        { id: 'b6', type: 'heading', content: 'Catatan Metodologi' },
        { id: 'b7', type: 'text', content: 'Baris dengan nilai kosong dikeluarkan dari perhitungan rata-rata (listwise deletion) dan jumlahnya dilaporkan di Data Quality Center.' },
        { id: 'b8', type: 'signature' },
    ]);
    reports.setSignature(monthly.id, {
        signerName: 'Rizky Pratama',
        position: 'Supervisor Layanan Pelanggan',
        place: 'Jakarta',
    });
    reports.schedule(monthly.id, '0 7 1 * *', ['sari@demo.vantik.id', 'rizky@demo.vantik.id']);
    const quarterly = reports.create({
        name: 'Ringkasan Eksekutif Kuartalan',
        pageSize: 'A4',
        orientation: 'landscape',
        // Dokumen yang belum disetujui diberi watermark supaya salinan cetaknya tidak
        // beredar sebagai angka final.
        watermark: 'draft',
        classification: 'confidential',
    });
    reports.saveBlocks(quarterly.id, [
        { id: 'q1', type: 'heading', content: 'Ringkasan Eksekutif — Kuartal Berjalan' },
        { id: 'q2', type: 'text', content: 'Disusun untuk rapat direksi. Berisi skor Balanced Scorecard, KPI di luar ambang batas, dan tindakan yang sedang berjalan.' },
        { id: 'q3', type: 'chart', config: { kind: 'threshold_ring', kpiId: kpiCsat.id } },
        { id: 'q4', type: 'signature' },
    ]);
    /* ---------------- Embed Dashboard (PRD 6.9) ---------------- */
    // Dua token dengan cakupan berbeda: satu penuh untuk portal internal, satu dibatasi
    // RLS untuk mitra yang hanya boleh melihat wilayahnya sendiri.
    embed.issue({
        dashboardId: dashboard.id,
        label: 'Portal Intranet — layar lobi',
        domainWhitelist: ['https://intranet.demo.id'],
        mode: 'static',
        expiresInDays: 90,
        showAttribution: true,
    });
    embed.issue({
        dashboardId: dashboard.id,
        label: 'Mitra Wilayah Timur',
        domainWhitelist: ['https://mitra-timur.demo.id'],
        mode: 'interactive',
        expiresInDays: 30,
        rlsScope: [{ dimension: 'wilayah', operator: 'in', values: ['Wilayah Timur'] }],
    });
    /* ---------------- Alert Center: kejadian nyata (PRD 6.16) ---------------- */
    // Aturan tanpa kejadian membuat Alert Center tampak belum pernah dipakai. Nilai di
    // bawah sengaja melewati ambang batas supaya aturannya benar-benar memicu, termasuk
    // mengisi antrean notifikasi yang statusnya `queued` — bukan `delivered`.
    const csatBreach = await alerts.evaluate({
        kpiId: kpiCsat.id,
        value: 3.6,
        label: 'CSAT bulan berjalan',
        context: { wilayah: 'Wilayah Barat', periode: 'bulan berjalan' },
    });
    await alerts.evaluate({
        kpiId: kpiResponse.id,
        value: 14.2,
        label: 'Waktu respons rata-rata',
        context: { wilayah: 'Wilayah Utara', kanal: 'Telepon' },
    });
    // Satu kejadian ditindaklanjuti dan satu dibiarkan terbuka, supaya kedua keadaan
    // terlihat di antrean.
    if (csatBreach[0]) {
        alerts.acknowledge(csatBreach[0].eventId, 'Sudah ditinjau bersama supervisor wilayah; pelatihan agen kanal chat dijadwalkan pekan depan.');
    }
    /* ---------------- Analitik AI: pertanyaan yang pernah diajukan (PRD 6.6) ---------------- */
    // Pertanyaan sengaja memuat NAMA KOLOM apa adanya (`skor_csat`, `waktu_respons_menit`).
    // Pengurai maksud mencocokkan nama medan, bukan sinonim, jadi riwayat ini sekaligus
    // memperlihatkan kepada pengguna bentuk pertanyaan yang memang dikenali — daripada
    // meninggalkan contoh berbunyi bagus yang justru dijawab `error.metric_not_recognised`.
    for (const question of [
        'Berapa rata-rata skor_csat per wilayah?',
        'Bagaimana rata-rata waktu_respons_menit di setiap kanal?',
        'Berapa total jumlah_tiket per kanal?',
        'Wilayah mana yang skor_csat-nya paling rendah?',
        'What is the average skor_csat by wilayah?',
    ]) {
        await ai.ask(question, {
            datasetId: tickets.dataset.id,
            locale: question.startsWith('What') ? 'en' : 'id',
        });
    }
    /* ---------------- Forecast Analytics (PRD 6.7) ---------------- */
    const csatSeries = ctx.db
        .all('kpi_score_history', { kpi_id: kpiCsat.id, dimension_key: null }, { orderBy: 'period' })
        .map((r) => r.value);
    if (csatSeries.length >= 6) {
        forecast.run({ series: csatSeries, horizon: 6, method: 'arima', kpiId: kpiCsat.id });
        forecast.run({ series: csatSeries, horizon: 3, method: 'linear_regression', kpiId: kpiCsat.id });
    }
    /* ---------------- Root Cause Analysis (PRD 6.8) ---------------- */
    const ticketRowsAll = datasets.allRows(tickets.dataset.id);
    const rcaDraft = rca.generate({
        title: 'Penurunan CSAT di Wilayah Barat',
        rows: ticketRowsAll,
        metricField: 'skor_csat',
        dimensionFields: ['wilayah', 'kanal'],
        kpiId: kpiCsat.id,
    });
    // Draf yang divalidasi manusia memperlihatkan bahwa keluaran AI adalah usulan, bukan
    // kesimpulan yang langsung berlaku (PRD 6.8).
    rca.validate(rcaDraft.id, {
        fiveWhy: rcaDraft.fiveWhy,
        evidence: { catatan: 'Diverifikasi dengan rekaman panggilan kanal Telepon periode yang sama.' },
    });
    rca.generate({
        title: 'Lonjakan waktu respons kanal Telepon',
        rows: ticketRowsAll,
        metricField: 'waktu_respons_menit',
        dimensionFields: ['kanal', 'wilayah'],
        kpiId: kpiResponse.id,
    });
    /* ---------------- AI Narrative Report (PRD 6.10) ---------------- */
    const periods = ctx.db
        .all('kpi_score_history', { kpi_id: kpiCsat.id, dimension_key: null }, { orderBy: 'period DESC' })
        .map((r) => r.period);
    if (periods.length >= 2) {
        narrative.generate({ period: periods[0], comparePeriod: periods[1], locale: 'id' });
        if (periods.length >= 4) {
            narrative.generate({ period: periods[0], comparePeriod: periods[3], locale: 'en' });
        }
    }
    /* ---------------- KPI Center: alur persetujuan (PRD 6.15) ---------------- */
    // Perubahan definisi KPI menuntut empat mata: pengaju tidak boleh menyetujui usulannya
    // sendiri. Karena itu persetujuan dijalankan sebagai pengguna LAIN.
    const bagas = ctx.db.get('system_user', { email: 'bagas@demo.vantik.id' });
    const approvedProposal = kpis.proposeChange(kpiResponse.id, { target: 9, name: 'Waktu Respons Pertama (menit)' });
    if (bagas) {
        const reviewerCtx = seedContext(db, audit, tenantId, bagas.id);
        new index_ts_2.KpiService(reviewerCtx).decideChange(approvedProposal, 'approved', 'Target 9 menit sejalan dengan SLA baru yang berlaku kuartal ini.');
    }
    // Satu usulan dibiarkan menunggu, supaya kotak persetujuan tidak kosong.
    kpis.proposeChange(kpiTickets.id, { weight: 1.5 });
    /* ---------------- Billing & Faktur (PRD 6.28) ---------------- */
    const startOfMonth = (offset) => {
        const now = new Date();
        return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    };
    const iso = (d) => d.toISOString().slice(0, 10);
    // Dua faktur periode lalu: satu sudah dibayar, satu masih terbuka — supaya status
    // pembayaran, penomoran berurutan, dan perhitungan pajak semuanya terlihat.
    const paid = billing.issueInvoice({
        lines: [{ description: 'Langganan Enterprise — tahunan (dicicil bulanan)', amount: 12_000_000 }],
        periodStart: iso(startOfMonth(2)),
        periodEnd: iso(new Date(startOfMonth(1).getTime() - 86_400_000)),
        gatewayRef: 'demo-gw-0001',
        paymentMethodLabel: 'Transfer Bank — BCA',
    });
    // Faktur ditandai lunas lewat jalur yang sama dengan payment gateway sungguhan —
    // termasuk verifikasi tanda tangan HMAC — bukan dengan menulis status langsung ke tabel.
    // Dengan begitu keadaan demo tidak pernah menjadi keadaan yang tidak mungkin dicapai
    // aplikasi sendiri.
    const webhookSecret = process.env.VANTIK_PAYMENT_WEBHOOK_SECRET ?? 'rahasia-webhook-demo';
    const webhookBody = JSON.stringify({
        event: 'payment.succeeded',
        invoiceId: paid.id,
        gatewayRef: 'demo-gw-0001',
    });
    billing.handleGatewayWebhook(webhookBody, (0, node_crypto_1.createHmac)('sha256', webhookSecret).update(webhookBody).digest('hex'), webhookSecret);
    billing.issueInvoice({
        lines: [
            { description: 'Langganan Enterprise — tahunan (dicicil bulanan)', amount: 12_000_000 },
            { description: 'Tambahan penyimpanan 50 GB', amount: 750_000 },
        ],
        periodStart: iso(startOfMonth(1)),
        periodEnd: iso(new Date(startOfMonth(0).getTime() - 86_400_000)),
    });
    /* ---------------- Usage Metering (PRD 6.29) ---------------- */
    // Pemanggilan AI di atas sudah tercatat sendiri. Yang ditambahkan di sini adalah
    // metrik yang tidak punya pemicu alami saat seeding.
    metering.record('datasets', 3, 'seed:dataset_upload');
    metering.record('users', 7, 'seed:user_provisioning');
    metering.record('connections', 3, 'seed:connection_setup');
    metering.record('embed_tokens', 2, 'seed:embed_issue');
    for (let day = 29; day >= 0; day--) {
        metering.record('storage_mb', Math.round(180 + pseudo(31, day) * 60), 'seed:harian');
    }
    const counts = db
        .prepare(`SELECT (SELECT COUNT(*) FROM dataset_rows) AS baris,
              (SELECT COUNT(*) FROM kpi_score_history) AS skor,
              (SELECT COUNT(*) FROM alert_events) AS alert,
              (SELECT COUNT(*) FROM ai_queries) AS ai,
              (SELECT COUNT(*) FROM invoices) AS faktur`)
        .get();
    console.log('[seed] done');
    console.log('[seed] tenant slug : demo');
    console.log('[seed] admin login : admin@demo.vantik.id / VantikDemo#2026');
    console.log('[seed] other users : rizky|sari|bagas|maya|andi|putri @demo.vantik.id (same password)');
    console.log('[seed] operator     : operator@vantik.id (Platform Operator — menyetujui pendaftaran)');
    console.log(`[seed] isi        : ${counts.baris} baris dataset · ${counts.skor} skor KPI · ` +
        `${counts.alert} kejadian alert · ${counts.ai} pertanyaan AI · ${counts.faktur} faktur`);
    // Peta akun → modul.
    //
    // Dicetak karena tidak ada satu peran non-MFA yang dapat melihat seluruh modul: itu
    // konsekuensi langsung dari hak akses paling sempit (SECURITY.md Bagian 5). Tanpa peta
    // ini, orang yang menjelajah demo akan menyimpulkan modulnya kosong padahal yang terjadi
    // adalah penolakan wewenang yang memang disengaja.
    console.log('');
    console.log('[seed] Akun mana untuk melihat apa (semua kata sandi sama):');
    console.log('[seed]   andi   → Dataset, Statistik, Regresi, AI Analytics, RCA, Narrative, Report, Data Modeling');
    console.log('[seed]   rizky  → Digital Twin, Operational Cockpit — DIBATASI RLS ke Wilayah Timur saja');
    console.log('[seed]   sari   → Executive Cockpit, Balanced Scorecard, Report');
    console.log('[seed]   putri  → Log Aktivitas, Perangkat & Sesi, antrean notifikasi');
    console.log('[seed]   maya   → Data Quality Center, sertifikasi dataset (wajib MFA)');
    console.log('[seed]   bagas  → Koneksi Eksternal, Data Modeling (wajib MFA)');
    console.log('[seed]   admin  → SELURUH modul, tetapi wajib mengaktifkan MFA lebih dulu');
    console.log('[seed]   operator → Manajemen Tenant: antrean pendaftaran menunggu persetujuan (wajib MFA)');
    console.log('[seed]');
    console.log('[seed] Untuk melihat seluruh aplikasi dalam satu sesi: masuk sebagai admin,');
    console.log('[seed] lalu aktifkan Verifikasi Dua Langkah di menu "Perangkat & Sesi".');
    seedTrialAccount(db, audit, tenants, keyring);
    db.close();
}
/**
 * SATU akun uji coba yang benar-benar siap dipakai.
 *
 * Berbeda dari tenant `demo` yang punya tujuh pengguna berperan sempit untuk
 * memperagakan RBAC, akun ini dibuat untuk satu hal: dibuka, dilihat, dan dinilai.
 * Karena itu ia sengaja:
 *
 *  - **sudah disetujui**, sehingga tidak tersangkut antrean persetujuan pendaftaran;
 *  - **sudah terpasang MFA** dengan rahasia yang dicetak, karena `super_admin`
 *    mewajibkannya dan akun uji coba yang berhenti di layar pendaftaran authenticator
 *    tidak menguji apa pun;
 *  - **berstatus uji coba yang akan berakhir dalam 7 hari**, supaya peringatan masa
 *    berlaku dan tombol perpanjang benar-benar terlihat alih-alih hanya ada di kode.
 */
function seedTrialAccount(db, audit, tenants, keyring) {
    if (db.prepare("SELECT id FROM tenants WHERE slug = 'ujicoba'").get())
        return;
    const { tenantId, adminUserId } = tenants.provision({
        name: 'PT Coba Analitik',
        slug: 'ujicoba',
        planCode: 'professional',
        billingCycle: 'quarterly',
        // Tujuh hari: cukup untuk dipakai, cukup dekat untuk memperlihatkan peringatan
        // masa berlaku yang muncul pada H-7.
        trialDays: 7,
        admin: {
            fullName: 'Pengguna Uji Coba',
            nik: '3273010101950002',
            email: 'uji@vantik.id',
            password: 'VantikUji#2026',
            division: 'Operasional',
            position: 'Super Admin',
        },
        defaultLocale: 'id',
    }, 'seed');
    // MFA dipasang langsung: rahasianya dicetak supaya dapat dimasukkan ke aplikasi
    // authenticator, dan kode pemulihan TIDAK dibuat di sini — jalur normalnya lewat
    // "Perangkat & Sesi", dan menaruh kode pemulihan di log akan menjadikannya rahasia
    // yang tersimpan di dua tempat sekaligus.
    db.prepare(`UPDATE system_user
        SET mfa_secret = ?, mfa_enrolled = 1, mfa_activated_at = ?, updated_at = ?
      WHERE id = ?`).run(TRIAL_MFA_SECRET, new Date().toISOString(), new Date().toISOString(), adminUserId);
    const ctx = seedContext(db, audit, tenantId, adminUserId);
    /* --- Data secukupnya untuk melihat aplikasi berisi, bukan kosong --- */
    const dataset = new index_ts_2.DatasetService(ctx, new index_ts_9.MeteringService(ctx)).upload({
        filename: 'penjualan_cabang.csv',
        content: csv(['cabang', 'kanal', 'unit_terjual', 'nilai_transaksi', 'skor_kepuasan'], Array.from({ length: 90 }, (_, i) => [
            ['Cabang Jakarta', 'Cabang Surabaya', 'Cabang Medan'][i % 3],
            ['Toko', 'Daring', 'Mitra'][i % 3],
            40 + Math.round(pseudo(31, i) * 60),
            4_500_000 + Math.round(pseudo(37, i) * 5_500_000),
            (3.4 + pseudo(41, i) * 1.5).toFixed(2),
        ])),
    });
    const kpis = new index_ts_2.KpiService(ctx);
    const kpi = kpis.create({
        code: 'KPI-KEPUASAN',
        name: 'Skor Kepuasan Pelanggan',
        formula: 'AVG(skor_kepuasan)',
        datasetId: dataset.dataset.id,
        measureField: 'skor_kepuasan',
        dimensionField: 'cabang',
        unit: 'skor',
        direction: 'higher_better',
        weight: 1,
        target: 4.5,
        thresholds: [
            { level: 'at_risk', comparator: 'lte', value: 4.2 },
            { level: 'critical', comparator: 'lte', value: 3.8 },
        ],
    });
    // Enam bulan riwayat supaya grafik tren punya bentuk, bukan satu titik.
    const barisDataset = new index_ts_2.DatasetService(ctx).allRows(dataset.dataset.id);
    for (let back = 5; back >= 0; back--) {
        const bulan = new Date();
        bulan.setUTCMonth(bulan.getUTCMonth() - back);
        const period = bulan.toISOString().slice(0, 7);
        const faktor = 0.9 + pseudo(53, back) * 0.22;
        kpis.captureScores(kpi.id, period, barisDataset.map((r) => ({
            ...r,
            skor_kepuasan: typeof r.skor_kepuasan === 'number' ? r.skor_kepuasan * faktor : null,
        })));
    }
    new index_ts_3.DashboardService(ctx).create({
        name: 'Ringkasan Penjualan',
        description: 'Contoh dasbor siap pakai untuk akun uji coba',
    });
    console.log('');
    console.log('[seed] ─────────── AKUN UJI COBA (satu akun, siap pakai) ───────────');
    console.log('[seed] kode organisasi : ujicoba');
    console.log('[seed] email           : uji@vantik.id');
    console.log('[seed] kata sandi      : VantikUji#2026');
    console.log(`[seed] kode MFA        : ${TRIAL_MFA_SECRET}`);
    console.log('[seed]                   (masukkan sebagai "kunci yang dimasukkan manual"');
    console.log('[seed]                    di Google Authenticator / Authy, lalu pakai kodenya)');
    console.log('[seed] paket           : Professional · uji coba 7 hari · siklus 3 bulan');
    console.log('[seed] isi             : 90 baris penjualan, 1 KPI dengan 6 bulan riwayat, 1 dasbor');
    console.log('[seed] Akun ini super_admin: SELURUH modul terbuka, termasuk Langganan & Paket');
    console.log('[seed] tempat peringatan masa berlaku dan tombol perpanjang dapat dilihat.');
    console.log('[seed] ──────────────────────────────────────────────────────────────');
    void keyring;
}
const invokedDirectly = process.argv[1]?.includes('seed');
if (invokedDirectly) {
    // Kegagalan harus terlihat DAN mengembalikan kode keluar bukan-nol: basis data yang
    // separuh terisi lebih buruk daripada seeding yang jelas-jelas gagal.
    seed().catch((error) => {
        console.error('[seed] GAGAL:', error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=seed.js.map