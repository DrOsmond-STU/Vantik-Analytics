/**
 * Penjadwal pekerjaan berkala — PRD 6.4 (laporan terjadwal) & 6.16 (Alert Center).
 *
 * Sebelum ini, `schedule_cron` tersimpan dan aturan alert ada, tetapi tidak ada yang
 * menjalankannya: evaluasi hanya terjadi bila sebuah panggilan API kebetulan memicunya.
 * Ambang batas yang terlampaui tengah malam tidak diketahui siapa pun sampai ada orang
 * membuka aplikasi.
 *
 * Yang diuji di sini adalah sifat-sifat yang menentukan apakah penjadwal aman dipakai di
 * shared hosting: pekerjaan tidak berjalan dua kali, satu tenant yang gagal tidak
 * menghentikan tenant lain, dan aktor sistem tidak punya kewenangan lebih dari yang
 * dibutuhkannya.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, provisionTenant, type Harness } from './helpers.ts';
import { Scheduler, systemContext, SCHEDULER_FRESHNESS_MS } from '../src/platform/scheduler.ts';
import { ForbiddenError } from '../src/platform/errors.ts';
import { AuthorizationService } from '../src/identity-service/index.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.ts';
import type { Db } from '../src/platform/db.ts';

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

afterEach(() => {
  harness.cleanup();
});

describe('Klaim pekerjaan: tidak berjalan dua kali', () => {
  it('TC-SCH-01 — proses kedua melewatkan pekerjaan yang baru saja dijalankan', async () => {
    provisionTenant(harness);
    let jalan = 0;
    const jobs = { 'uji.hitung': () => { jalan++; return 1; } };

    // Dua instance mewakili dua proses Passenger yang memulai putaran nyaris bersamaan.
    const prosesA = new Scheduler(harness.db, harness.audit, jobs);
    const prosesB = new Scheduler(harness.db, harness.audit, jobs);

    await prosesA.runDueJobs();
    const hasilB = await prosesB.runDueJobs();

    // Tanpa klaim, notifikasi yang sama akan terkirim dua kali.
    expect(jalan).toBe(1);
    expect(hasilB[0]!.skipped).toBe('ran_recently');
  });

  it('TC-SCH-02 — setelah jendela kesegaran lewat, pekerjaan berjalan lagi', async () => {
    provisionTenant(harness);
    let jalan = 0;
    const scheduler = new Scheduler(harness.db, harness.audit, { 'uji.hitung': () => { jalan++; return 0; } });

    await scheduler.runDueJobs();
    // Menua-kan catatan sama artinya dengan menunggu jendelanya lewat.
    harness.db
      .prepare('UPDATE scheduler_runs SET started_at = ? WHERE job = ?')
      .run(new Date(Date.now() - SCHEDULER_FRESHNESS_MS - 1000).toISOString(), 'uji.hitung');

    await scheduler.runDueJobs();
    expect(jalan).toBe(2);
  });

  it('TC-SCH-03 — force menjalankan meski baru saja berjalan (dipakai cron eksternal)', async () => {
    provisionTenant(harness);
    let jalan = 0;
    const scheduler = new Scheduler(harness.db, harness.audit, { 'uji.hitung': () => { jalan++; return 0; } });

    await scheduler.runDueJobs();
    await scheduler.runDueJobs({ force: true });
    expect(jalan).toBe(2);
  });
});

describe('Ketahanan terhadap kegagalan satu tenant', () => {
  it('TC-SCH-04 — tenant yang gagal tidak menghentikan tenant lain', async () => {
    const a = provisionTenant(harness, { slug: 'schedaa' });
    const b = provisionTenant(harness, { slug: 'schedb' });
    const diproses: string[] = [];

    const scheduler = new Scheduler(harness.db, harness.audit, {
      'uji.gagal-sebagian': (ctx) => {
        if (ctx.tenant.id === a.tenantId) throw new Error('data tenant ini rusak');
        diproses.push(ctx.tenant.id);
        return 1;
      },
    });

    const hasil = await scheduler.runDueJobs();

    // Pada platform multi-tenant, satu pelanggan dengan data rusak tidak boleh
    // membekukan penjadwalan seluruh pelanggan lain.
    expect(diproses).toEqual([b.tenantId]);
    expect(hasil[0]!.tenantsProcessed).toBe(1);

    const status = scheduler.status().find((s) => s.job === 'uji.gagal-sebagian')!;
    expect(status.outcome).toBe('partial');
    // Kegagalannya tercatat, bukan ditelan diam-diam.
    expect((status.detail as { failures: string[] }).failures[0]).toContain('rusak');
  });

  it('TC-SCH-05 — tenant disuspensi tidak dijadwalkan apa pun', async () => {
    const aktif = provisionTenant(harness, { slug: 'schedaktif' });
    const suspensi = provisionTenant(harness, { slug: 'schedsusp' });
    harness.db.prepare("UPDATE tenants SET status = 'suspended' WHERE id = ?").run(suspensi.tenantId);

    const diproses: string[] = [];
    const scheduler = new Scheduler(harness.db, harness.audit, {
      'uji.aktif-saja': (ctx) => {
        diproses.push(ctx.tenant.id);
        return 0;
      },
    });

    await scheduler.runDueJobs();
    expect(diproses).toEqual([aktif.tenantId]);
  });

  it('TC-SCH-06 — status pekerjaan dapat dibaca operator', async () => {
    provisionTenant(harness);
    const scheduler = new Scheduler(harness.db, harness.audit, { 'uji.status': () => 3 });
    await scheduler.runDueJobs();

    const status = scheduler.status();
    expect(status).toHaveLength(1);
    expect(status[0]!.job).toBe('uji.status');
    expect(status[0]!.outcome).toBe('ok');
    expect(status[0]!.finishedAt).not.toBeNull();
    expect((status[0]!.detail as { actions: number }).actions).toBe(3);
  });
});

describe('Aktor sistem: kewenangan sesempit mungkin', () => {
  it('TC-SCH-07 — aktor sistem dapat membaca KPI tetapi TIDAK mengelola pengguna', () => {
    const tenant = provisionTenant(harness);
    const ctx = systemContext(harness.db, harness.audit, tenant.tenantId);

    expect(ctx.can('kpi:read')).toBe(true);
    expect(ctx.can('alert:write')).toBe(true);

    // Pekerjaan berkala berjalan tanpa manusia yang mengawasi, jadi cacat di dalamnya
    // tidak boleh dapat mengubah peran atau menghapus dataset.
    expect(ctx.can('authorization:write')).toBe(false);
    expect(ctx.can('dataset:write')).toBe(false);
    expect(ctx.can('tenant:suspend')).toBe(false);
    expect(() => new AuthorizationService(ctx).listUsers()).toThrow(ForbiddenError);
  });

  it('TC-SCH-08 — aktor sistem tidak terhalang penegakan MFA', () => {
    const tenant = provisionTenant(harness);
    const ctx = systemContext(harness.db, harness.audit, tenant.tenantId);
    // Kode peran `system` sengaja bukan salah satu dari 13 peran standar, sehingga
    // `requiresMfa()` false tanpa perlu pengecualian khusus — MFA adalah kontrol untuk
    // manusia, dan proses latar bukan manusia.
    expect(ctx.mfaEnrolmentPending).toBe(false);
  });

  it('TC-SCH-09 — aktor sistem tercatat sebagai `system` di Log Aktivitas, bukan sebagai orang', () => {
    const tenant = provisionTenant(harness);
    const ctx = systemContext(harness.db, harness.audit, tenant.tenantId);
    ctx.log({ action: 'scheduler.test', module: 'Alert Center', objectType: 'job', objectId: 'uji' });

    const row = harness.db
      .prepare("SELECT actor_user_id, actor_label FROM auditdb.audit_log WHERE action = 'scheduler.test'")
      .get() as { actor_user_id: string; actor_label: string };
    // Auditor harus dapat membedakan aksi otomatis dari aksi orang.
    expect(row.actor_user_id).toBe('system');
    expect(row.actor_label).toContain('Penjadwal');
  });

  it('TC-SCH-10 — aktor sistem tidak dibatasi RLS', () => {
    const tenant = provisionTenant(harness);
    const ctx = systemContext(harness.db, harness.audit, tenant.tenantId);
    // Ia mengevaluasi ambang batas untuk seluruh organisasi, bukan mewakili satu
    // pengguna — dan tidak pernah mengembalikan baris ke siapa pun.
    expect(ctx.rls.isUnrestricted).toBe(true);
  });
});

/**
 * Endpoint pemicu untuk cron eksternal.
 *
 * Uji ini ada karena rutenya sempat SALAH TEMPAT: terdaftar setelah router `/api/v1`,
 * sehingga `authenticate()` menolaknya dengan 401 sebelum token bersama sempat diperiksa.
 * Gejalanya tampak seperti "token salah" padahal token sudah benar — urutan pendaftaran
 * rute adalah bagian dari perilaku, bukan detail kosmetik, jadi ia perlu dijaga uji.
 */
describe('Pemicu penjadwal untuk cron eksternal', () => {
  const TOKEN = 'token-uji-penjadwal-0123456789ab';
  let app: Express;
  let dir: string;
  let db: Db;
  let sebelumnya: string | undefined;

  beforeEach(() => {
    sebelumnya = process.env.VANTIK_SCHEDULER_TOKEN;
    process.env.VANTIK_SCHEDULER_TOKEN = TOKEN;
    dir = mkdtempSync(join(tmpdir(), 'vantik-sched-'));
    const created = createApp({
      paths: { main: join(dir, 'm.db'), audit: join(dir, 'a.db'), vault: join(dir, 'v.db') },
    });
    app = created.app;
    db = created.db;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    if (sebelumnya === undefined) delete process.env.VANTIK_SCHEDULER_TOKEN;
    else process.env.VANTIK_SCHEDULER_TOKEN = sebelumnya;
  });

  it('TC-SCH-11 — token yang benar menjalankan pekerjaan, TANPA sesi apa pun', async () => {
    const response = await request(app)
      .post('/api/v1/system/scheduler/run')
      .set('X-Vantik-Scheduler-Token', TOKEN);

    // Cron tidak punya sesi; memaksa satu akun manusia menyimpan kata sandi di crontab
    // jauh lebih buruk daripada token bersama.
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(Array.isArray(response.body.ran)).toBe(true);
  });

  it('TC-SCH-12 — tanpa token, permintaan ditolak', async () => {
    const response = await request(app).post('/api/v1/system/scheduler/run');
    expect(response.status).toBe(401);
  });

  it('TC-SCH-13 — token salah dengan panjang sama ditolak', async () => {
    const salah = 'X'.repeat(TOKEN.length);
    const response = await request(app).post('/api/v1/system/scheduler/run').set('X-Vantik-Scheduler-Token', salah);
    expect(response.status).toBe(401);
  });

  it('TC-SCH-14 — bila token belum diset, endpoint menolak SEMUA permintaan (fail secure)', async () => {
    delete process.env.VANTIK_SCHEDULER_TOKEN;
    // Terbuka tanpa sengaja bukan pilihan: instalasi yang lupa menyetel token tidak boleh
    // berakhir dengan endpoint yang dapat dipicu siapa pun.
    const kosong = await request(app).post('/api/v1/system/scheduler/run');
    const berisi = await request(app).post('/api/v1/system/scheduler/run').set('X-Vantik-Scheduler-Token', 'apa saja');
    expect(kosong.status).toBe(401);
    expect(berisi.status).toBe(401);
  });
});
