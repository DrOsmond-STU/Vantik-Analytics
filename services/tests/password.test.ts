/**
 * Penggantian & penetapan ulang kata sandi — SECURITY.md Bagian 4.
 *
 * Yang sebenarnya diuji di sini: **kata sandi dapat diganti sama sekali**. Sebelum
 * perbaikan ini tidak bisa. `AuthService.changePassword()` sudah lengkap — kebijakan
 * panjang, penolakan pemakaian ulang, riwayat hash — tetapi TIDAK ADA satu rute pun yang
 * memanggilnya, dan `AuthorizationService` tidak punya metode setara. Akibatnya kata
 * sandi yang ditetapkan saat akun dibuat berlaku selamanya: pengguna yang lupa terkunci
 * permanen, dan admin pun tak dapat menolong selain menyunting basis data langsung.
 *
 * Daftar periksa pasca-pasang di panduan pemasangan bahkan meminta "kata sandi admin
 * default sudah diganti" — instruksi yang tidak mungkin dijalankan.
 *
 * Sisa berkas ini menjaga agar jalur baru itu tidak menjadi pintu belakang: kata sandi
 * lama tetap wajib untuk akun sendiri, kebijakan tetap berlaku pada reset oleh admin,
 * sesi target ikut dicabut, dan batas tenant tidak dapat dilangkahi.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import type { Db } from '../src/platform/db.ts';
import { contextFor, createHarness, createUser, provisionTenant, TEST_PASSWORD, type Harness } from './helpers.ts';
import { AuthorizationService } from '../src/identity-service/index.ts';
import { AuthService } from '../src/identity-service/auth.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../src/platform/errors.ts';
import { hashPassword, verifyPassword } from '../src/platform/crypto.ts';

/**
 * `createUser()` di helpers menyimpan `password_hash: NULL`. Uji reset harus dimulai
 * dari akun yang BENAR-BENAR punya kata sandi — kalau tidak, "kata sandi lama tidak
 * berlaku lagi" akan lulus dengan sendirinya dan tidak membuktikan apa pun.
 */
function berikanSandi(harness: Harness, userId: string, password: string): void {
  harness.db
    .prepare('UPDATE system_user SET password_hash = ? WHERE id = ?')
    .run(hashPassword(password), userId);
}

function hashTersimpan(harness: Harness, userId: string): string | null {
  return (
    harness.db.prepare('SELECT password_hash FROM system_user WHERE id = ?').get(userId) as {
      password_hash: string | null;
    }
  ).password_hash;
}

const SANDI_BARU = 'SandiBaruYangKuat#2026';

/* ================= Lapisan layanan: reset oleh admin ================= */

describe('Reset kata sandi oleh admin', () => {
  let harness: Harness;
  let auth: AuthService;

  beforeEach(() => {
    harness = createHarness();
    auth = new AuthService(harness.db, harness.audit);
  });
  afterEach(() => harness.cleanup());

  it('TC-PWD-01 — admin dapat menetapkan ulang kata sandi pengguna yang lupa', () => {
    const tenant = provisionTenant(harness);
    const target = createUser(harness, tenant.tenantId, 'lupa@uji.test', 'business_analyst');
    berikanSandi(harness, target, TEST_PASSWORD);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);

    new AuthorizationService(ctx).resetPassword(target, SANDI_BARU, auth);

    // Kata sandi lama mati, yang baru hidup — inilah jalur yang sebelumnya tidak ada.
    const hash = hashTersimpan(harness, target)!;
    expect(verifyPassword(SANDI_BARU, hash)).toBe(true);
    expect(verifyPassword(TEST_PASSWORD, hash)).toBe(false);
  });

  it('TC-PWD-02 — reset mencabut sesi target yang sedang berjalan', () => {
    const tenant = provisionTenant(harness);
    const target = createUser(harness, tenant.tenantId, 'sesi@uji.test', 'business_analyst');
    harness.db
      .prepare(
        `INSERT INTO active_sessions (id, tenant_id, user_id, token_hash, device_id, issued_at, expires_at, last_seen_at)
         VALUES (?,?,?,?,NULL,?,?,?)`,
      )
      .run('ses_uji', tenant.tenantId, target, 'hash-uji', new Date().toISOString(),
        new Date(Date.now() + 3_600_000).toISOString(), new Date().toISOString());

    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    new AuthorizationService(ctx).resetPassword(target, SANDI_BARU, auth);

    // Reset dipakai justru ketika kata sandi lama diduga bocor. Membiarkan sesi lama
    // hidup berarti penyusup tetap masuk dan hanya pemilik sah yang tersulitkan.
    const sesi = harness.db
      .prepare('SELECT revoked_at, revoked_reason FROM active_sessions WHERE id = ?')
      .get('ses_uji') as { revoked_at: string | null; revoked_reason: string | null };
    expect(sesi.revoked_at).not.toBeNull();
    expect(sesi.revoked_reason).toBe('password_reset_by_admin');
  });

  it('TC-PWD-03 — kebijakan kata sandi tetap berlaku pada reset oleh admin', () => {
    const tenant = provisionTenant(harness);
    const target = createUser(harness, tenant.tenantId, 'lemah@uji.test', 'business_analyst');
    berikanSandi(harness, target, TEST_PASSWORD);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);

    // Reset oleh admin bukan pintu belakang untuk memasang kata sandi lemah.
    expect(() => new AuthorizationService(ctx).resetPassword(target, 'pendek', auth)).toThrow(
      expect.objectContaining({ messageKey: 'error.password_too_short' }),
    );
    expect(() => new AuthorizationService(ctx).resetPassword(target, 'tanpaangkadansimbol', auth)).toThrow(
      ValidationError,
    );
  });

  it('TC-PWD-04 — admin tidak mereset kata sandinya sendiri lewat jalur ini', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);

    // Reset mencabut seluruh sesi target; dipakai pada diri sendiri, admin akan
    // mengeluarkan dirinya di tengah pekerjaan tanpa sebab yang jelas baginya.
    expect(() => new AuthorizationService(ctx).resetPassword(ctx.actor.userId, SANDI_BARU, auth)).toThrow(
      expect.objectContaining({ messageKey: 'error.use_self_password_change' }),
    );
  });

  it('TC-PWD-05 — pengguna tenant lain dijawab 404, bukan direset', () => {
    const a = provisionTenant(harness, { slug: 'pwda' });
    const b = provisionTenant(harness, { slug: 'pwdb' });
    const korban = createUser(harness, b.tenantId, 'korban@uji.test', 'business_analyst');
    berikanSandi(harness, korban, TEST_PASSWORD);
    const sebelum = hashTersimpan(harness, korban);
    const ctxA = contextFor(harness, a.tenantId, ['super_admin']);

    // Pencarian ber-scope tenant harus mendahului AuthService yang mencari lintas tenant.
    // Tanpa urutan itu, admin satu tenant dapat merebut akun tenant lain dengan menebak id.
    expect(() => new AuthorizationService(ctxA).resetPassword(korban, SANDI_BARU, auth)).toThrow(NotFoundError);

    // Yang menentukan bukan jenis kesalahannya, melainkan bahwa kata sandinya UTUH.
    expect(hashTersimpan(harness, korban)).toBe(sebelum);
    expect(verifyPassword(TEST_PASSWORD, sebelum!)).toBe(true);
  });

  it('TC-PWD-06 — peran tanpa authorization:write tidak dapat mereset siapa pun', () => {
    const tenant = provisionTenant(harness);
    const target = createUser(harness, tenant.tenantId, 'target@uji.test', 'business_analyst');
    const analis = contextFor(harness, tenant.tenantId, ['business_analyst']);

    expect(() => new AuthorizationService(analis).resetPassword(target, SANDI_BARU, auth)).toThrow(ForbiddenError);
  });
});

/* ================= Lapisan HTTP: penggantian mandiri ================= */

describe('Pengguna mengganti kata sandinya sendiri lewat HTTP', () => {
  let app: Express;
  let db: Db;
  let dir: string;
  let token: string;
  let email: string;

  const fp = {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) UjiSandi/1.0',
    screenResolution: '1920x1080',
    colorDepth: 24,
    timezone: 'Asia/Jakarta',
    language: 'id',
    fonts: ['Inter'],
    canvasHash: 'canvas-sandi',
    webglHash: 'webgl-sandi',
    platform: 'Linux x86_64',
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vantik-pwd-'));
    const created = createApp({
      paths: { main: join(dir, 'm.db'), audit: join(dir, 'a.db'), vault: join(dir, 'v.db') },
    });
    app = created.app;
    db = created.db;

    // Peran business_analyst dipilih karena TIDAK mewajibkan MFA: yang diuji di sini
    // adalah kata sandi, bukan verifikasi dua langkah.
    const provisioned = created.tenants.provision(
      {
        name: 'Uji Sandi',
        slug: 'ujisandi',
        planCode: 'enterprise',
        billingCycle: 'monthly',
        trialDays: 30,
        admin: {
          fullName: 'Pengguna Uji',
          nik: 'NIK-PWD-001',
          email: 'pengguna@ujisandi.test',
          password: TEST_PASSWORD,
        },
      },
      'uji',
    );
    email = 'pengguna@ujisandi.test';
    db.prepare("UPDATE system_user SET mfa_enrolled = 0 WHERE id = ?").run(provisioned.adminUserId);
    db.prepare("UPDATE role_assignment SET role_id = (SELECT id FROM roles WHERE code = 'business_analyst') WHERE user_id = ?")
      .run(provisioned.adminUserId);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: TEST_PASSWORD, tenantSlug: 'ujisandi', fingerprint: fp });
    token = login.body.token;
    expect(token, JSON.stringify(login.body)).toBeTruthy();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('TC-PWD-07 — kata sandi lama WAJIB; sesi yang sah saja tidak cukup', async () => {
    const response = await request(app)
      .post('/api/v1/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'SalahSekali#2026', newPassword: SANDI_BARU });

    // Sesi yang dicuri tidak boleh dapat merebut akun secara permanen dengan mengganti
    // kata sandi; ia hanya boleh memakai akses yang sudah terlanjur dimilikinya.
    expect(response.status).toBe(401);
    expect(response.body.error.key).toBe('error.invalid_credentials');

    const tetapBisa = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: TEST_PASSWORD, tenantSlug: 'ujisandi', fingerprint: fp });
    expect(tetapBisa.body.token).toBeTruthy();
  });

  it('TC-PWD-08 — dengan kata sandi lama yang benar, penggantian berhasil dan yang lama mati', async () => {
    const response = await request(app)
      .post('/api/v1/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: SANDI_BARU });
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const lama = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: TEST_PASSWORD, tenantSlug: 'ujisandi', fingerprint: fp });
    expect(lama.status).toBe(401);

    const baru = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: SANDI_BARU, tenantSlug: 'ujisandi', fingerprint: fp });
    expect(baru.body.token).toBeTruthy();
  });

  it('TC-PWD-09 — kata sandi baru yang melanggar kebijakan ditolak 400', async () => {
    const response = await request(app)
      .post('/api/v1/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'pendek' });

    expect(response.status).toBe(400);
    expect(response.body.error.key).toBe('error.password_too_short');
  });

  it('TC-PWD-10 — kata sandi yang sama dengan yang sedang dipakai ditolak', async () => {
    const response = await request(app)
      .post('/api/v1/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD });

    // Riwayat hash mencegah "ganti" yang sebenarnya tidak mengganti apa pun — penting
    // ketika penggantian dipicu oleh dugaan kebocoran.
    expect(response.status).toBe(400);
    expect(response.body.error.key).toBe('error.password_reused');
  });

  it('TC-PWD-11 — permintaan tanpa medan yang diperlukan ditolak 400, bukan 500', async () => {
    const kosong = await request(app)
      .post('/api/v1/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(kosong.status).toBe(400);
    expect(kosong.body.error.key).toBe('error.password_required');
  });

  it('TC-PWD-12 — tanpa sesi, penggantian ditolak 401', async () => {
    const response = await request(app)
      .post('/api/v1/me/password')
      .send({ currentPassword: TEST_PASSWORD, newPassword: SANDI_BARU });
    expect(response.status).toBe(401);
  });

  it('TC-PWD-13 — penggantian tercatat di Log Aktivitas', async () => {
    await request(app)
      .post('/api/v1/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: SANDI_BARU });

    const row = db
      .prepare("SELECT action, severity FROM auditdb.audit_log WHERE action = 'user.password_changed'")
      .get() as { action: string; severity: string } | undefined;
    // Perubahan kredensial adalah peristiwa keamanan; auditor harus dapat melihatnya.
    expect(row).toBeTruthy();
  });

  it('TC-PWD-14 — sesi berjalan TETAP hidup setelah pengguna mengganti sandinya sendiri', async () => {
    await request(app)
      .post('/api/v1/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: SANDI_BARU });

    // Pengguna baru saja membuktikan kepemilikan akun dengan kata sandi lamanya;
    // mengeluarkannya hanya menghukum orang yang benar.
    const masihJalan = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`);
    expect(masihJalan.status).toBe(200);
  });
});
