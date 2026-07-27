/**
 * MFA berbasis TOTP — SECURITY.md Bagian 4, `mfaRequired` di rbac.ts.
 *
 * Bagian pertama menguji TOTP terhadap **vektor uji resmi RFC 6238 Lampiran B**. Itu
 * bukan seremoni: implementasi TOTP yang salah 30 detik atau salah endianness tetap
 * "menghasilkan enam digit" dan lolos uji buatan sendiri, lalu gagal terhadap Google
 * Authenticator di tangan pengguna. Vektor resmi adalah satu-satunya bukti yang bermakna.
 *
 * Sisanya menguji properti yang menentukan apakah MFA benar-benar melindungi: sesi tidak
 * pernah terbit sebelum faktor kedua lolos, kode tidak dapat dipakai ulang, kode
 * pemulihan sekali pakai, dan peran yang mewajibkan MFA tidak dapat bekerja maupun
 * melepas MFA-nya.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, createUser, fingerprint, provisionTenant, TEST_PASSWORD, type Harness } from './helpers.ts';
import {
  base32Decode,
  base32Encode,
  generateMfaSecret,
  generateRecoveryCodes,
  normaliseRecoveryCode,
  otpauthUri,
  totpCode,
  totpCounter,
  verifyTotp,
  RECOVERY_CODE_COUNT,
  TOTP_STEP_SECONDS,
} from '../src/platform/totp.ts';
import { MFA_MAX_CHALLENGE_ATTEMPTS } from '../src/identity-service/auth.ts';
import { contextFor } from './helpers.ts';
import { requiresMfa } from '../src/platform/rbac.ts';
import { ForbiddenError } from '../src/platform/errors.ts';
import { DatasetService } from '../src/data-platform-service/datasets.ts';

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

afterEach(() => {
  harness.cleanup();
});

/**
 * Kode untuk langkah waktu BERIKUTNYA.
 *
 * Aktivasi memakai kode langkah saat ini, dan anti-replay menolak langkah yang sama
 * dipakai dua kali. Pengguna nyata menunggu 30 detik; uji tidak boleh menunggu, jadi
 * ia memakai langkah berikutnya — masih di dalam jendela toleransi ±1.
 */
const nextCode = (secret: string): string => totpCode(secret, totpCounter() + 1);

describe('TOTP terhadap vektor uji RFC 6238 Lampiran B', () => {
  // RFC 6238 memakai rahasia ASCII "12345678901234567890" untuk HMAC-SHA1.
  const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

  /** Vektor resmi: [waktu unix detik, kode 8 digit]. Kami memakai 6 digit → 6 digit terakhir. */
  const VECTORS: Array<[number, string]> = [
    [59, '94287082'],
    [1_111_111_109, '07081804'],
    [1_111_111_111, '14050471'],
    [1_234_567_890, '89005924'],
    [2_000_000_000, '69279037'],
    [20_000_000_000, '65353130'],
  ];

  it('TC-MFA-01 — setiap vektor RFC 6238 menghasilkan kode yang sama persis', () => {
    for (const [seconds, expected8] of VECTORS) {
      const counter = Math.floor(seconds / TOTP_STEP_SECONDS);
      // Kode 6 digit adalah enam digit terakhir dari nilai 8 digit yang sama
      // (truncation dinamis identik, hanya modulusnya berbeda).
      const expected6 = expected8.slice(-6);
      expect(totpCode(RFC_SECRET, counter), `t=${seconds}`).toBe(expected6);
    }
  });

  it('TC-MFA-02 — verifikasi menerima kode pada waktu yang tepat', () => {
    for (const [seconds] of VECTORS) {
      const atMs = seconds * 1000;
      const code = totpCode(RFC_SECRET, totpCounter(atMs));
      expect(verifyTotp(RFC_SECRET, code, { atMs }).valid, `t=${seconds}`).toBe(true);
    }
  });

  it('TC-MFA-03 — base32 bolak-balik utuh, dan masukan tidak sah ditolak', () => {
    const original = Buffer.from('12345678901234567890', 'ascii');
    expect(base32Decode(base32Encode(original)).equals(original)).toBe(true);
    // Spasi & huruf kecil ditoleransi karena pengguna menyalin rahasia apa adanya.
    expect(base32Decode(base32Encode(original).toLowerCase().replace(/(.{4})/g, '$1 ')).equals(original)).toBe(true);
    // Karakter di luar alfabet DITOLAK, bukan diabaikan: rahasia yang salah baca akan
    // menghasilkan kode yang selalu gagal dan sangat sulit didiagnosis.
    expect(() => base32Decode('ABC!DEF')).toThrow(/tidak sah/i);
    expect(() => base32Decode('   ')).toThrow(/kosong/i);
  });
});

describe('Toleransi jam & anti-replay TOTP', () => {
  const secret = generateMfaSecret();
  const now = 1_700_000_000_000;

  it('TC-MFA-04 — kode dari satu langkah sebelum/sesudah masih diterima', () => {
    const before = totpCode(secret, totpCounter(now) - 1);
    const after = totpCode(secret, totpCounter(now) + 1);
    expect(verifyTotp(secret, before, { atMs: now }).valid).toBe(true);
    expect(verifyTotp(secret, after, { atMs: now }).valid).toBe(true);
  });

  it('TC-MFA-05 — kode di luar jendela toleransi ditolak', () => {
    const tooOld = totpCode(secret, totpCounter(now) - 5);
    expect(verifyTotp(secret, tooOld, { atMs: now }).valid).toBe(false);
  });

  it('TC-MFA-06 — kode yang sudah dipakai tidak dapat dipakai ulang dalam jendelanya', () => {
    const counter = totpCounter(now);
    const code = totpCode(secret, counter);

    const first = verifyTotp(secret, code, { atMs: now });
    expect(first.valid).toBe(true);
    expect(first.counter).toBe(counter);

    // Pemanggil menyimpan counter lalu meneruskannya sebagai minCounter — tanpa ini,
    // kode yang tertangkap masih sah selama 30 detiknya belum lewat.
    expect(verifyTotp(secret, code, { atMs: now, minCounter: first.counter! }).valid).toBe(false);
  });

  it('TC-MFA-07 — bentuk kode yang salah ditolak tanpa melempar', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56', '000000']) {
      expect(() => verifyTotp(secret, bad, { atMs: now })).not.toThrow();
    }
    expect(verifyTotp(secret, '12345', { atMs: now }).valid).toBe(false);
  });

  it('TC-MFA-08 — otpauth URI memuat parameter yang dibaca aplikasi autentikator', () => {
    const uri = otpauthUri({ secret, accountLabel: 'budi@vantik.id', issuer: 'Vantik Analytics' });
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
    expect(uri).toContain('algorithm=SHA1');
    // Penerbit muncul di label DAN parameter: autentikator lama hanya membaca salah satu.
    expect(decodeURIComponent(uri.split('?')[0]!)).toContain('Vantik Analytics:budi@vantik.id');
  });
});

describe('Kode pemulihan', () => {
  it('TC-MFA-09 — sepuluh kode, unik, tanpa karakter yang mudah tertukar', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    // I, O, 0, dan 1 dibuang karena kode ini dibaca manusia dari kertas.
    expect(codes.join('')).not.toMatch(/[IO01]/);
    expect(codes.every((c) => /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(c))).toBe(true);
  });

  it('TC-MFA-10 — normalisasi mengabaikan tanda hubung, spasi, dan besar-kecil huruf', () => {
    expect(normaliseRecoveryCode('abcde-fghjk')).toBe('ABCDEFGHJK');
    expect(normaliseRecoveryCode(' ABCDE FGHJK ')).toBe('ABCDEFGHJK');
  });
});

describe('Alur login dua langkah', () => {
  /** Mendaftarkan & mengaktifkan MFA, mengembalikan rahasianya. */
  function enrol(tenantId: string, userId: string): string {
    const { secret } = harness.auth.beginMfaEnrolment({ tenantId, userId });
    const result = harness.auth.activateMfa({ tenantId, userId, code: totpCode(secret) });
    expect(result.activated).toBe(true);
    return secret;
  }

  it('TC-MFA-11 — tanpa MFA, login langsung menerbitkan sesi', () => {
    const tenant = provisionTenant(harness);
    const result = harness.auth.login({
      email: `admin@${tenant.slug}.test`,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: fingerprint(),
    });
    expect(result.kind).toBe('ok');
  });

  it('TC-MFA-12 — dengan MFA aktif, login TIDAK menerbitkan sesi — hanya tantangan', () => {
    const tenant = provisionTenant(harness);
    enrol(tenant.tenantId, tenant.adminUserId);

    const result = harness.auth.login({
      email: `admin@${tenant.slug}.test`,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: fingerprint(),
    });

    expect(result.kind).toBe('mfa_required');
    // Yang paling penting: tidak ada token sesi apa pun di respons langkah pertama.
    expect(result).not.toHaveProperty('token');
    expect(result).not.toHaveProperty('sessionId');
    // Dan tidak ada sesi yang tercatat di basis data.
    const sessions = harness.db
      .prepare('SELECT COUNT(*) AS n FROM active_sessions WHERE user_id = ?')
      .get(tenant.adminUserId) as { n: number };
    expect(sessions.n).toBe(0);
  });

  it('TC-MFA-13 — kode yang benar menyelesaikan langkah kedua dan menerbitkan sesi', () => {
    const tenant = provisionTenant(harness);
    const secret = enrol(tenant.tenantId, tenant.adminUserId);

    const step1 = harness.auth.login({
      email: `admin@${tenant.slug}.test`,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: fingerprint(),
    });
    expect(step1.kind).toBe('mfa_required');
    const challengeToken = (step1 as { challengeToken: string }).challengeToken;

    const step2 = harness.auth.verifyMfaChallenge({
      challengeToken,
      code: nextCode(secret),
      fingerprint: fingerprint(),
    });

    expect(step2.kind).toBe('ok');
    expect((step2 as { token: string }).token).toBeTruthy();
    expect(harness.auth.resolveSession((step2 as { token: string }).token).userId).toBe(tenant.adminUserId);
  });

  it('TC-MFA-14 — kode salah tidak menerbitkan sesi, dan tercatat sebagai insiden', () => {
    const tenant = provisionTenant(harness);
    enrol(tenant.tenantId, tenant.adminUserId);

    const step1 = harness.auth.login({
      email: `admin@${tenant.slug}.test`,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: fingerprint(),
    });
    const challengeToken = (step1 as { challengeToken: string }).challengeToken;

    const step2 = harness.auth.verifyMfaChallenge({ challengeToken, code: '000000', fingerprint: fingerprint() });
    expect(step2.kind).toBe('rejected');

    const denied = harness.db
      .prepare("SELECT action FROM auditdb.audit_log WHERE tenant_id = ? AND action = 'auth.mfa_failed'")
      .all(tenant.tenantId);
    expect(denied.length).toBeGreaterThan(0);
  });

  it('TC-MFA-15 — tantangan mati setelah batas percobaan; harus login ulang', () => {
    const tenant = provisionTenant(harness);
    const secret = enrol(tenant.tenantId, tenant.adminUserId);

    const step1 = harness.auth.login({
      email: `admin@${tenant.slug}.test`,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: fingerprint(),
    });
    const challengeToken = (step1 as { challengeToken: string }).challengeToken;

    for (let i = 0; i < MFA_MAX_CHALLENGE_ATTEMPTS; i++) {
      expect(
        harness.auth.verifyMfaChallenge({ challengeToken, code: '000000', fingerprint: fingerprint() }).kind,
      ).toBe('rejected');
    }

    // Kode BENAR pun tidak lagi diterima: tantangannya sudah mati.
    const after = harness.auth.verifyMfaChallenge({
      challengeToken,
      code: nextCode(secret),
      fingerprint: fingerprint(),
    });
    expect(after.kind).toBe('rejected');
    expect((after as { reasonKey: string }).reasonKey).toMatch(/mfa_challenge_invalid|mfa_too_many_attempts/);
  });

  it('TC-MFA-16 — tantangan terikat perangkat: diselesaikan dari perangkat lain ditolak', () => {
    const tenant = provisionTenant(harness);
    const secret = enrol(tenant.tenantId, tenant.adminUserId);

    const step1 = harness.auth.login({
      email: `admin@${tenant.slug}.test`,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: fingerprint(),
    });
    const challengeToken = (step1 as { challengeToken: string }).challengeToken;

    // Token tantangan yang tercuri tidak boleh dapat dipakai di perangkat penyerang —
    // kalau bisa, langkah kedua justru MELEMAHKAN device binding.
    const other = harness.auth.verifyMfaChallenge({
      challengeToken,
      code: nextCode(secret),
      fingerprint: fingerprint({ canvasHash: 'perangkat-penyerang' }),
    });
    expect(other.kind).toBe('rejected');
  });

  it('TC-MFA-17 — tantangan hanya sekali pakai', () => {
    const tenant = provisionTenant(harness);
    const secret = enrol(tenant.tenantId, tenant.adminUserId);

    const step1 = harness.auth.login({
      email: `admin@${tenant.slug}.test`,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: fingerprint(),
    });
    const challengeToken = (step1 as { challengeToken: string }).challengeToken;

    const code = nextCode(secret);
    expect(harness.auth.verifyMfaChallenge({ challengeToken, code, fingerprint: fingerprint() }).kind).toBe('ok');
    // Pemakaian kedua ditolak. Dua penjaga menutupnya sekaligus — tantangan sudah
    // dikonsumsi DAN langkah waktunya sudah terpakai — dan itulah gunanya berlapis:
    // salah satu saja sudah cukup, jadi kelalaian pada satu tidak membuka celah.
    expect(harness.auth.verifyMfaChallenge({ challengeToken, code, fingerprint: fingerprint() }).kind).toBe('rejected');
  });

  it('TC-MFA-18 — kode pemulihan dapat menggantikan TOTP, dan hanya sekali', () => {
    const tenant = provisionTenant(harness);
    const { secret } = harness.auth.beginMfaEnrolment({
      tenantId: tenant.tenantId,
      userId: tenant.adminUserId,
    });
    const activation = harness.auth.activateMfa({
      tenantId: tenant.tenantId,
      userId: tenant.adminUserId,
      code: totpCode(secret),
    });
    const recovery = activation.recoveryCodes[0]!;

    const login1 = harness.auth.login({
      email: `admin@${tenant.slug}.test`,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: fingerprint(),
    });
    const ok = harness.auth.verifyMfaChallenge({
      challengeToken: (login1 as { challengeToken: string }).challengeToken,
      code: recovery,
      fingerprint: fingerprint(),
    });
    expect(ok.kind).toBe('ok');

    // Kode pemulihan yang sama tidak boleh berlaku kedua kali.
    const login2 = harness.auth.login({
      email: `admin@${tenant.slug}.test`,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: fingerprint(),
    });
    const reused = harness.auth.verifyMfaChallenge({
      challengeToken: (login2 as { challengeToken: string }).challengeToken,
      code: recovery,
      fingerprint: fingerprint(),
    });
    expect(reused.kind).toBe('rejected');
  });

  it('TC-MFA-19 — pemakaian kode pemulihan tercatat sebagai peristiwa yang layak ditinjau', () => {
    const tenant = provisionTenant(harness);
    const { secret } = harness.auth.beginMfaEnrolment({ tenantId: tenant.tenantId, userId: tenant.adminUserId });
    const activation = harness.auth.activateMfa({
      tenantId: tenant.tenantId,
      userId: tenant.adminUserId,
      code: totpCode(secret),
    });

    const login = harness.auth.login({
      email: `admin@${tenant.slug}.test`,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: fingerprint(),
    });
    harness.auth.verifyMfaChallenge({
      challengeToken: (login as { challengeToken: string }).challengeToken,
      code: activation.recoveryCodes[1]!,
      fingerprint: fingerprint(),
    });

    const rows = harness.db
      .prepare(
        "SELECT severity, detail_json FROM auditdb.audit_log WHERE tenant_id = ? AND action = 'auth.mfa_recovery_code_used'",
      )
      .all(tenant.tenantId) as Array<{ severity: string; detail_json: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.severity).toBe('warning');
    // Sisa kode disertakan supaya habisnya tidak mengejutkan pengguna.
    expect(JSON.parse(rows[0]!.detail_json).remainingRecoveryCodes).toBe(RECOVERY_CODE_COUNT - 1);
  });
});

describe('Pendaftaran & pengelolaan MFA', () => {
  it('TC-MFA-20 — rahasia yang dibuat tetapi belum diaktifkan TIDAK membuat akun menuntut kode', () => {
    const tenant = provisionTenant(harness);
    harness.auth.beginMfaEnrolment({ tenantId: tenant.tenantId, userId: tenant.adminUserId });

    const status = harness.auth.mfaStatus(tenant.tenantId, tenant.adminUserId);
    expect(status.secretPending).toBe(true);
    expect(status.enrolled).toBe(false);

    // Membuka halaman pengaturan lalu menutupnya tidak boleh mengunci pengguna.
    const login = harness.auth.login({
      email: `admin@${tenant.slug}.test`,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: fingerprint(),
    });
    expect(login.kind).toBe('ok');
  });

  it('TC-MFA-21 — aktivasi menolak kode salah dan tidak mengaktifkan apa pun', () => {
    const tenant = provisionTenant(harness);
    harness.auth.beginMfaEnrolment({ tenantId: tenant.tenantId, userId: tenant.adminUserId });

    const result = harness.auth.activateMfa({
      tenantId: tenant.tenantId,
      userId: tenant.adminUserId,
      code: '000000',
    });
    expect(result.activated).toBe(false);
    expect(result.reasonKey).toBe('error.mfa_code_invalid');
    expect(harness.auth.mfaStatus(tenant.tenantId, tenant.adminUserId).enrolled).toBe(false);
  });

  it('TC-MFA-22 — aktivasi tanpa memulai pendaftaran ditolak', () => {
    const tenant = provisionTenant(harness);
    const result = harness.auth.activateMfa({
      tenantId: tenant.tenantId,
      userId: tenant.adminUserId,
      code: '123456',
    });
    expect(result.reasonKey).toBe('error.mfa_not_started');
  });

  it('TC-MFA-23 — rahasia yang sudah aktif tidak pernah dikembalikan lagi', () => {
    const tenant = provisionTenant(harness);
    const { secret } = harness.auth.beginMfaEnrolment({ tenantId: tenant.tenantId, userId: tenant.adminUserId });
    harness.auth.activateMfa({ tenantId: tenant.tenantId, userId: tenant.adminUserId, code: totpCode(secret) });

    // Sesi yang dibajak tidak boleh dapat menyalin faktor kedua korban.
    const again = harness.auth.beginMfaEnrolment({ tenantId: tenant.tenantId, userId: tenant.adminUserId });
    expect(again.alreadyActive).toBe(true);
    expect(again.secret).toBe('');
    expect(again.otpauthUri).toBe('');
  });

  it('TC-MFA-24 — mematikan MFA menuntut kode yang sah, lalu menghapus kode pemulihan', () => {
    const tenant = provisionTenant(harness);
    const userId = createUser(harness, tenant.tenantId, 'analis@mfa.test', 'business_analyst');
    const { secret } = harness.auth.beginMfaEnrolment({ tenantId: tenant.tenantId, userId });
    harness.auth.activateMfa({ tenantId: tenant.tenantId, userId, code: totpCode(secret) });

    // Sesi yang dibajak tanpa kode tidak boleh dapat melepas faktor kedua.
    expect(harness.auth.disableMfa({ tenantId: tenant.tenantId, userId, code: '000000' }).disabled).toBe(false);
    expect(harness.auth.mfaStatus(tenant.tenantId, userId).enrolled).toBe(true);

    expect(harness.auth.disableMfa({ tenantId: tenant.tenantId, userId, code: nextCode(secret) }).disabled).toBe(true);
    const status = harness.auth.mfaStatus(tenant.tenantId, userId);
    expect(status.enrolled).toBe(false);
    expect(status.remainingRecoveryCodes).toBe(0);
  });

  it('TC-MFA-25 — penerbitan ulang kode pemulihan membatalkan yang lama', () => {
    const tenant = provisionTenant(harness);
    const { secret } = harness.auth.beginMfaEnrolment({ tenantId: tenant.tenantId, userId: tenant.adminUserId });
    const first = harness.auth.activateMfa({
      tenantId: tenant.tenantId,
      userId: tenant.adminUserId,
      code: totpCode(secret),
    }).recoveryCodes;

    // Langkah waktu berikutnya: TOTP tidak boleh dipakai ulang setelah aktivasi.
    const nextCode = totpCode(secret, totpCounter() + 1);
    const second = harness.auth.regenerateRecoveryCodes({
      tenantId: tenant.tenantId,
      userId: tenant.adminUserId,
      code: nextCode,
    }).codes;

    expect(second).toHaveLength(RECOVERY_CODE_COUNT);
    expect(second.some((c) => first.includes(c))).toBe(false);
    expect(harness.auth.mfaStatus(tenant.tenantId, tenant.adminUserId).remainingRecoveryCodes).toBe(
      RECOVERY_CODE_COUNT,
    );

    // Kode lama sudah tidak berlaku.
    const login = harness.auth.login({
      email: `admin@${tenant.slug}.test`,
      password: TEST_PASSWORD,
      tenantSlug: tenant.slug,
      fingerprint: fingerprint(),
    });
    const reused = harness.auth.verifyMfaChallenge({
      challengeToken: (login as { challengeToken: string }).challengeToken,
      code: first[0]!,
      fingerprint: fingerprint(),
    });
    expect(reused.kind).toBe('rejected');
  });

  it('TC-MFA-26 — kode PEMULIHAN tidak dapat dipakai untuk mencetak kode pemulihan baru', () => {
    const tenant = provisionTenant(harness);
    const { secret } = harness.auth.beginMfaEnrolment({ tenantId: tenant.tenantId, userId: tenant.adminUserId });
    const codes = harness.auth.activateMfa({
      tenantId: tenant.tenantId,
      userId: tenant.adminUserId,
      code: totpCode(secret),
    }).recoveryCodes;

    // Bila diizinkan, satu kode pemulihan yang bocor dapat dipakai mencetak sepuluh yang
    // baru dan mempertahankan akses selamanya.
    const result = harness.auth.regenerateRecoveryCodes({
      tenantId: tenant.tenantId,
      userId: tenant.adminUserId,
      code: codes[0]!,
    });
    expect(result.codes).toHaveLength(0);
    expect(result.reasonKey).toBe('error.mfa_code_invalid');
  });
});

describe('Penegakan mfaRequired per peran', () => {
  it('TC-MFA-27 — lima peran menandai mfaRequired, dan flag itu benar-benar dibaca', () => {
    // Sebelum ini, `mfaRequired` adalah data mati: 15 kemunculan, nol pembacaan.
    expect(requiresMfa(['super_admin'])).toBe(true);
    expect(requiresMfa(['platform_operator'])).toBe(true);
    expect(requiresMfa(['system_admin'])).toBe(true);
    expect(requiresMfa(['data_engineer'])).toBe(true);
    expect(requiresMfa(['data_steward'])).toBe(true);
    expect(requiresMfa(['executive'])).toBe(false);
    expect(requiresMfa(['business_analyst', 'auditor'])).toBe(false);
    // Satu peran yang mewajibkan sudah cukup untuk mewajibkan keseluruhan.
    expect(requiresMfa(['executive', 'super_admin'])).toBe(true);
  });

  it('TC-MFA-28 — peran yang mewajibkan MFA tidak dapat memakai izin sebelum MFA aktif', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin'], { mfaEnrolled: false });
    expect(ctx.mfaEnrolmentPending).toBe(true);

    // Ditolak di lapis konteks, jadi berlaku untuk SETIAP modul tanpa perlu tiap rute
    // mengingat memeriksanya.
    expect(() => new DatasetService(ctx).list()).toThrow(ForbiddenError);
  });

  it('TC-MFA-29 — penolakan menyebut langkah pemulihan, bukan sekadar "ditolak"', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin'], { mfaEnrolled: false });

    try {
      new DatasetService(ctx).list();
      expect.unreachable('seharusnya ditolak');
    } catch (error) {
      const err = error as ForbiddenError & { detail?: Record<string, unknown> };
      expect(err.messageKey).toBe('error.mfa_enrolment_required');
      expect(err.detail?.recoveryKey).toBe('recovery.enrol_mfa');
    }

    const denied = harness.db
      .prepare("SELECT action FROM auditdb.audit_log WHERE tenant_id = ? AND action = 'access.mfa_enrolment_required'")
      .all(tenant.tenantId);
    expect(denied.length).toBeGreaterThan(0);
  });

  it('TC-MFA-30 — setelah MFA aktif, peran yang sama bekerja normal', () => {
    const tenant = provisionTenant(harness);
    const { secret } = harness.auth.beginMfaEnrolment({ tenantId: tenant.tenantId, userId: tenant.adminUserId });
    harness.auth.activateMfa({ tenantId: tenant.tenantId, userId: tenant.adminUserId, code: totpCode(secret) });

    const ctx = contextFor(harness, tenant.tenantId, ['super_admin'], { mfaEnrolled: true });
    expect(ctx.mfaEnrolmentPending).toBe(false);
    expect(() => new DatasetService(ctx).list()).not.toThrow();
  });

  it('TC-MFA-31 — peran yang TIDAK mewajibkan MFA tidak terhalang sama sekali', () => {
    const tenant = provisionTenant(harness);
    const userId = createUser(harness, tenant.tenantId, 'exec@mfa.test', 'executive');
    const ctx = contextFor(harness, tenant.tenantId, ['executive'], { userId });
    expect(ctx.mfaEnrolmentPending).toBe(false);
  });
});
