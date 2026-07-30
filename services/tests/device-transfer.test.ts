/**
 * Pemulihan perangkat — PRD 6.30, SECURITY.md 17.4.
 *
 * Yang sebenarnya diuji di sini: **pengguna sah yang berganti perangkat bisa kembali
 * masuk**. Sebelum perbaikan ini tidak bisa: `requestDeviceTransfer()` ada di
 * AuthService tetapi tidak dipanggil rute mana pun, dan `approveTransfer()` menuntut
 * `otp_verified === 1` yang tidak ada kode penyetelnya. Jadi penolakan
 * `error.device_not_bound` mengarahkan pengguna ke `recovery.request_device_transfer`
 * — jalur yang tidak ada. Laptop baru = terkunci permanen.
 *
 * Uji terpenting di berkas ini adalah TC-DTR-01: ia menjalankan seluruh perjalanan dari
 * terkunci sampai masuk kembali. Sisanya menjaga agar jalur pemulihan itu tidak menjadi
 * jalan pintas melewati device binding.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contextFor, createHarness, fingerprint, provisionTenant, TEST_PASSWORD, type Harness } from './helpers.ts';
import { DeviceService } from '../src/identity-service/index.ts';
import { NotificationOutbox } from '../src/platform/outbox.ts';
import { AuthService } from '../src/identity-service/auth.ts';

let harness: Harness;
let outbox: NotificationOutbox;
let auth: AuthService;

beforeEach(() => {
  harness = createHarness();
  outbox = new NotificationOutbox(harness.db);
  // AuthService dengan outbox: itulah rangkaian yang dipakai `createApp()`.
  auth = new AuthService(harness.db, harness.audit, outbox);
});

afterEach(() => {
  harness.cleanup();
});

/** Perangkat lama & baru: kedua fingerprint sengaja jauh berbeda. */
const oldDevice = fingerprint();
const newDevice = fingerprint({
  canvasHash: 'canvas-laptop-baru',
  webglHash: 'Apple|M3|WebGL',
  screenResolution: '2560x1600',
  platform: 'MacIntel',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/17.0',
});

/** OTP dibaca dari outbox — satu-satunya tempat ia ada dalam bentuk terbaca. */
function otpFromOutbox(tenantId: string): string {
  const pending = outbox.pending(tenantId);
  const entry = pending.find((e) => e.purpose === 'device_transfer_otp');
  expect(entry, 'OTP tidak masuk outbox').toBeTruthy();
  const match = /(\d{6})/.exec(entry!.body);
  expect(match, 'body outbox tidak memuat OTP 6 digit').toBeTruthy();
  return match![1]!;
}

describe('Perjalanan lengkap: terkunci → pulih → masuk kembali', () => {
  it('TC-DTR-01 — pengguna dengan perangkat baru dapat kembali masuk lewat jalur pemulihan', () => {
    const tenant = provisionTenant(harness);
    const email = `admin@${tenant.slug}.test`;

    // 1. Login pertama mengikat perangkat lama.
    const first = auth.login({ email, password: TEST_PASSWORD, tenantSlug: tenant.slug, fingerprint: oldDevice });
    expect(first.kind).toBe('ok');

    // 2. Perangkat baru DITOLAK — batas perangkat tenant demo adalah 1.
    const blocked = auth.login({ email, password: TEST_PASSWORD, tenantSlug: tenant.slug, fingerprint: newDevice });
    expect(blocked.kind).toBe('rejected');
    expect((blocked as { reasonKey: string }).reasonKey).toBe('error.device_not_bound');
    // Penolakan menjanjikan jalur pemulihan; sisa uji ini membuktikan janji itu nyata.
    expect((blocked as { recoveryKey?: string }).recoveryKey).toBe('recovery.request_device_transfer');

    // 3. Ajukan pemindahan dari perangkat baru. Kata sandi tetap diverifikasi.
    const request = auth.beginDeviceTransfer({
      email,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: newDevice,
      reason: 'Laptop lama rusak',
    });
    expect(request.accepted).toBe(true);
    const requestId = (request as { requestId: string }).requestId;

    // 4. OTP dikirim ke alamat TERDAFTAR, bukan dikembalikan ke peminta.
    expect(request).not.toHaveProperty('otp');
    const otp = otpFromOutbox(tenant.tenantId);

    // 5. Verifikasi OTP. Ini BUKAN persetujuan.
    expect(auth.verifyDeviceTransferOtp({ requestId, otp }).verified).toBe(true);
    const stillBlocked = auth.login({
      email,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: newDevice,
    });
    expect(stillBlocked.kind, 'OTP saja tidak boleh cukup').toBe('rejected');

    // 6. Admin menyetujui — gerbang kedua yang independen.
    const adminCtx = contextFor(harness, tenant.tenantId, ['super_admin'], { mfaEnrolled: true });
    new DeviceService(adminCtx).approveTransfer(requestId, auth);

    // 7. Perangkat baru sekarang diterima. Inilah yang dulu mustahil.
    const recovered = auth.login({
      email,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: newDevice,
    });
    expect(recovered.kind).toBe('ok');

    // 8. Perangkat lama sudah dilepas — pemindahan berarti berpindah, bukan menambah.
    const oldAgain = auth.login({
      email,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: oldDevice,
    });
    expect(oldAgain.kind).toBe('rejected');
  });
});

describe('Jalur pemulihan bukan jalan pintas', () => {
  it('TC-DTR-02 — kata sandi salah tidak menghasilkan permintaan maupun OTP', () => {
    const tenant = provisionTenant(harness);
    const result = auth.beginDeviceTransfer({
      email: `admin@${tenant.slug}.test`,
      password: 'Salah#123456',
      tenantSlug: tenant.slug,
      fingerprint: newDevice,
    });
    expect(result.accepted).toBe(false);
    expect(outbox.pending(tenant.tenantId)).toHaveLength(0);
    expect(
      harness.db.prepare('SELECT COUNT(*) AS n FROM device_transfer_requests').get(),
    ).toMatchObject({ n: 0 });
  });

  it('TC-DTR-03 — email tak dikenal dibalas sama dengan kata sandi salah', () => {
    const tenant = provisionTenant(harness);
    const unknown = auth.beginDeviceTransfer({
      email: 'tidakada@nowhere.test',
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: newDevice,
    });
    const wrongPassword = auth.beginDeviceTransfer({
      email: `admin@${tenant.slug}.test`,
      password: 'Salah#123456',
      tenantSlug: tenant.slug,
      fingerprint: newDevice,
    });
    // Endpoint publik ini tidak boleh dapat dipakai memetakan siapa saja yang terdaftar.
    expect((unknown as { reasonKey: string }).reasonKey).toBe((wrongPassword as { reasonKey: string }).reasonKey);
  });

  it('TC-DTR-04 — OTP salah ditolak dan tercatat sebagai penolakan', () => {
    const tenant = provisionTenant(harness);
    const request = auth.beginDeviceTransfer({
      email: `admin@${tenant.slug}.test`,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: newDevice,
    });
    const requestId = (request as { requestId: string }).requestId;

    const bad = auth.verifyDeviceTransferOtp({ requestId, otp: '000000' });
    expect(bad.verified).toBe(false);
    expect(bad.reasonKey).toBe('error.transfer_otp_invalid');

    const denials = harness.db
      .prepare("SELECT COUNT(*) AS n FROM auditdb.audit_log WHERE action = 'device.transfer_otp_failed'")
      .get() as { n: number };
    expect(denials.n).toBe(1);
  });

  it('TC-DTR-05 — persetujuan tanpa OTP terverifikasi ditolak', () => {
    const tenant = provisionTenant(harness);
    const request = auth.beginDeviceTransfer({
      email: `admin@${tenant.slug}.test`,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: newDevice,
    });
    const requestId = (request as { requestId: string }).requestId;

    // Admin tidak boleh dapat melewati faktor "menguasai kontak terdaftar".
    const adminCtx = contextFor(harness, tenant.tenantId, ['super_admin'], { mfaEnrolled: true });
    expect(() => new DeviceService(adminCtx).approveTransfer(requestId, auth)).toThrow(/otp/i);
  });

  it('TC-DTR-06 — permintaan baru mematikan permintaan lama', () => {
    const tenant = provisionTenant(harness);
    const email = `admin@${tenant.slug}.test`;
    const first = auth.beginDeviceTransfer({ email, password: TEST_PASSWORD, tenantSlug: tenant.slug, fingerprint: newDevice });
    const second = auth.beginDeviceTransfer({ email, password: TEST_PASSWORD, tenantSlug: tenant.slug, fingerprint: newDevice });

    // Beberapa permintaan hidup bersamaan akan mengalikan jumlah tebakan OTP.
    const firstId = (first as { requestId: string }).requestId;
    expect(auth.verifyDeviceTransferOtp({ requestId: firstId, otp: '123456' }).reasonKey).toBe(
      'error.transfer_not_pending',
    );
    expect((second as { accepted: boolean }).accepted).toBe(true);
  });

  it('TC-DTR-07 — permintaan kedaluwarsa tidak dapat diverifikasi', () => {
    const tenant = provisionTenant(harness);
    const request = auth.beginDeviceTransfer({
      email: `admin@${tenant.slug}.test`,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: newDevice,
    });
    const requestId = (request as { requestId: string }).requestId;
    const otp = otpFromOutbox(tenant.tenantId);

    harness.db
      .prepare('UPDATE device_transfer_requests SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), requestId);

    expect(auth.verifyDeviceTransferOtp({ requestId, otp }).reasonKey).toBe('error.transfer_not_pending');
  });
});

describe('Outbox: pesan tertunda terlihat, rahasia tidak terbaca', () => {
  it('TC-DTR-08 — OTP masuk outbox berstatus queued, bukan dicatat terkirim', () => {
    const tenant = provisionTenant(harness);
    auth.beginDeviceTransfer({
      email: `admin@${tenant.slug}.test`,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: newDevice,
    });

    const counts = outbox.counts(tenant.tenantId);
    // Belum ada transport, jadi statusnya `queued` — bukan `sent` (bohong) dan bukan
    // `failed` (juga bohong: tidak ada yang mencoba).
    expect(counts.queued).toBe(1);
    expect(counts.sent).toBe(0);
    expect(counts.failed).toBe(0);
  });

  it('TC-DTR-09 — daftar outbox untuk operator TIDAK memuat isi pesan sensitif', () => {
    const tenant = provisionTenant(harness);
    auth.beginDeviceTransfer({
      email: `admin@${tenant.slug}.test`,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: newDevice,
    });

    const listed = outbox.list(tenant.tenantId);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.sensitive).toBe(1);
    // Membiarkan OTP terbaca dari daftar outbox akan meniadakan gunanya faktor itu:
    // siapa pun dengan izin membaca outbox dapat menyelesaikan pemindahan orang lain.
    expect(listed[0]).not.toHaveProperty('body');
  });

  it('TC-DTR-10 — outbox terisolasi per tenant', () => {
    const a = provisionTenant(harness, { slug: 'outboxa' });
    const b = provisionTenant(harness, { slug: 'outboxb' });
    auth.beginDeviceTransfer({
      email: `admin@${a.slug}.test`,
      password: TEST_PASSWORD,
      tenantSlug: a.slug,
      fingerprint: newDevice,
    });

    expect(outbox.counts(a.tenantId).queued).toBe(1);
    expect(outbox.counts(b.tenantId).queued).toBe(0);
    expect(outbox.list(b.tenantId)).toHaveLength(0);
  });

  it('TC-DTR-11 — tanpa outbox, permintaan tetap jalan tetapi menyatakan kurir tidak ada', () => {
    const tenant = provisionTenant(harness);
    // Rangkaian tanpa outbox: OTP tetap dibuat & di-hash, tetapi tidak ada yang
    // mengirimkannya. Pemanggil harus dapat mengetahui itu.
    const bare = new AuthService(harness.db, harness.audit);
    const result = bare.beginDeviceTransfer({
      email: `admin@${tenant.slug}.test`,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: newDevice,
    });
    expect((result as { accepted: boolean }).accepted).toBe(true);
    expect((result as { courierAvailable: boolean }).courierAvailable).toBe(false);
  });
});
