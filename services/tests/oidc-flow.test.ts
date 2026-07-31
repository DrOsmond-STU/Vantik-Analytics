/**
 * Alur masuk lewat SSO, dari pengalihan sampai sesi terbit.
 *
 * `oidc.test.ts` sudah membuktikan bahwa TOKEN diperiksa dengan benar. Yang diuji di sini
 * adalah hal-hal yang hanya muncul ketika protokol itu dipasang ke aplikasi sungguhan —
 * dan justru di situlah pemasangan SSO paling sering bocor:
 *
 *  1. **Keadaan sekali pakai** (TC-SSO-04). `state` yang dapat dipakai dua kali berarti
 *     kode otorisasi yang tercatat di log proxy dapat ditukar ulang oleh siapa pun.
 *  2. **Open redirect** (TC-SSO-03). Parameter "kembali ke halaman ini" adalah cara
 *     klasik memantulkan pengguna yang baru saja masuk ke situs penyerang.
 *  3. **Gerbang yang sama dengan kata sandi** (TC-SSO-08..10). SSO tidak boleh menjadi
 *     pintu samping yang melewati akun nonaktif, tenant belum disetujui, atau device
 *     binding.
 *  4. **Tidak membuat akun** (TC-SSO-08). Penyedia identitas publik membuat "domain yang
 *     diizinkan" mudah keliru diisi; pembuatan otomatis mengubah kekeliruan itu menjadi
 *     akun di ruang kerja orang lain.
 *
 * Yang DIGANTI saat pengujian hanya bagian yang berbicara ke jaringan. Tanda tangan token
 * tetap asli — ditandatangani kunci RSA yang dibuat di tempat — dan `verifyIdToken`
 * berjalan sungguhan. Mengganti pemeriksaannya hanya akan membuktikan bahwa uji ini
 * sepakat dengan dirinya sendiri.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createHarness, fingerprint, provisionTenant, type Harness, type TenantFixture } from './helpers.ts';
import { OidcLoginFlow, OIDC_STATE_TTL_MS, safeRedirect, type OidcProtocol } from '../src/identity-service/oidcFlow.ts';
import type { OidcConfig } from '../src/identity-service/oidc.ts';
import { AppError } from '../src/platform/errors.ts';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'kunci-1', alg: 'RS256', use: 'sig' } as never;

const CONFIG: OidcConfig = {
  issuer: 'https://sso.contoh.id',
  clientId: 'vantik-analytics',
  clientSecret: 'rahasia-klien',
  redirectUri: 'https://analitik.contoh.id/auth/sso/callback',
  allowedDomains: [],
};

const METADATA = {
  issuer: CONFIG.issuer,
  authorization_endpoint: `${CONFIG.issuer}/authorize`,
  token_endpoint: `${CONFIG.issuer}/token`,
  jwks_uri: `${CONFIG.issuer}/jwks`,
};

let harness: Harness;
let tenant: TenantFixture;

/** Nonce yang dipakai penyedia palsu; disimpan agar token dapat ditandatangani dengannya. */
let issuedNonce = '';
/** Klaim tambahan/pengganti untuk token berikutnya, disetel per kasus uji. */
let claimOverrides: Record<string, unknown> = {};
/** Bila diisi, penukaran kode gagal dengan alasan ini. */
let exchangeFailure: string | null = null;

function signToken(nonce: string): string {
  const now = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'kunci-1' })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({
      iss: CONFIG.issuer,
      aud: CONFIG.clientId,
      sub: 'pengguna-sso',
      email: `admin@${tenant.slug}.test`,
      email_verified: true,
      nonce,
      iat: now,
      exp: now + 300,
      ...claimOverrides,
    }),
  ).toString('base64url');
  const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}

/** Penyedia palsu: hanya menggantikan percakapan jaringan, bukan pemeriksaannya. */
const PROTOCOL: OidcProtocol = {
  beginLogin: async (config) => {
    issuedNonce = `nonce-${Math.random().toString(36).slice(2)}`;
    const state = `state-${Math.random().toString(36).slice(2)}`;
    return {
      url: `${METADATA.authorization_endpoint}?state=${state}`,
      state,
      nonce: issuedNonce,
      codeVerifier: `verifier-${state}`,
    };
  },
  exchangeCode: async (_config, code, codeVerifier) => {
    if (exchangeFailure) throw new Error(exchangeFailure);
    // Penyedia sungguhan menolak `code_verifier` yang tidak cocok; ditiru supaya uji PKCE
    // di bawah benar-benar menguji sesuatu.
    if (!codeVerifier.startsWith('verifier-')) throw new Error('oidc_exchange_failed');
    return { id_token: code === 'kode-basi' ? signToken('nonce-lain') : signToken(issuedNonce) };
  },
  discover: async () => METADATA,
  fetchJwks: async () => [JWK],
};

function flow(config: OidcConfig | null = CONFIG): OidcLoginFlow {
  return new OidcLoginFlow(harness.db, harness.auth, config, PROTOCOL);
}

/** Menjalankan satu putaran penuh: minta URL, lalu kembali membawa kode. */
async function roundTrip(
  service: OidcLoginFlow,
  options: { slug?: string; code?: string; redirectTo?: string | null } = {},
) {
  const started = await service.start({ tenantSlug: options.slug ?? tenant.slug, redirectTo: options.redirectTo ?? null });
  return service.complete({
    state: started.state,
    code: options.code ?? 'kode-otorisasi',
    fingerprint: fingerprint(),
    ip: '203.0.113.9',
  });
}

beforeEach(() => {
  harness = createHarness();
  tenant = provisionTenant(harness, { trialDays: 30 });
  claimOverrides = {};
  exchangeFailure = null;
});

afterEach(() => harness.cleanup());

/* ================= Konfigurasi ================= */

describe('SSO mati secara bawaan', () => {
  it('TC-SSO-01 — tanpa konfigurasi, SSO dinyatakan mati dan tidak dapat dimulai', async () => {
    const mati = flow(null);

    expect(mati.enabled()).toBe(false);
    expect(mati.providerLabel()).toBeNull();
    // Bukan 500: ini keadaan yang wajar, bukan kerusakan.
    await expect(mati.start({ tenantSlug: tenant.slug })).rejects.toMatchObject({
      messageKey: 'error.sso_not_configured',
    });
  });

  it('TC-SSO-02 — nama penyedia diambil dari host issuer, bukan teks bebas', () => {
    expect(flow().providerLabel()).toBe('sso.contoh.id');
  });
});

/* ================= Keadaan antar-langkah ================= */

describe('Keadaan percobaan masuk', () => {
  it('TC-SSO-03 — tujuan setelah masuk hanya boleh lintasan relatif', async () => {
    // Open redirect: tautan "masuk" yang sah, memantulkan pengguna ke situs penyerang.
    expect(safeRedirect('https://penyerang.id/ambil')).toBeNull();
    // Peramban memperlakukan `//host` sebagai URL absolut berskema-sama.
    expect(safeRedirect('//penyerang.id')).toBeNull();
    expect(safeRedirect('/\\penyerang.id')).toBeNull();
    expect(safeRedirect('/dasbor\r\nSet-Cookie: x=1')).toBeNull();
    expect(safeRedirect('/#/langganan')).toBe('/#/langganan');

    // Dan yang tersimpan di basis data memang sudah tersaring.
    await flow().start({ tenantSlug: tenant.slug, redirectTo: 'https://penyerang.id' });
    const row = harness.db.prepare('SELECT redirect_to FROM oidc_login_state').get() as { redirect_to: string | null };
    expect(row.redirect_to).toBeNull();
  });

  it('TC-SSO-04 — `state` hanya berlaku SEKALI', async () => {
    const service = flow();
    const started = await service.start({ tenantSlug: tenant.slug });
    const args = { state: started.state, code: 'kode-otorisasi', fingerprint: fingerprint() };

    const pertama = await service.complete(args);
    expect(pertama.result.kind).toBe('ok');

    // Pemutaran ulang: kode yang sama tidak boleh dapat ditukar dua kali.
    await expect(service.complete(args)).rejects.toMatchObject({ messageKey: 'error.sso_state_invalid' });
  });

  it('TC-SSO-05 — `state` yang tidak dikenal ditolak', async () => {
    await expect(
      flow().complete({ state: 'state-karangan', code: 'kode', fingerprint: fingerprint() }),
    ).rejects.toMatchObject({ messageKey: 'error.sso_state_invalid' });
  });

  it('TC-SSO-06 — `state` kedaluwarsa ditolak dan baris lama disapu', async () => {
    const service = flow();
    const started = await service.start({ tenantSlug: tenant.slug });

    // Dituakan langsung di basis data; menunggu sepuluh menit bukan pilihan.
    harness.db
      .prepare('UPDATE oidc_login_state SET expires_at = ? WHERE state = ?')
      .run(new Date(Date.now() - 1000).toISOString(), started.state);

    await expect(
      service.complete({ state: started.state, code: 'kode', fingerprint: fingerprint() }),
    ).rejects.toMatchObject({ messageKey: 'error.sso_state_expired' });

    // Percobaan berikutnya menyapu sisa baris mati; tabelnya tidak boleh tumbuh selamanya.
    harness.db
      .prepare(
        `INSERT INTO oidc_login_state (state, nonce, code_verifier, tenant_slug, redirect_to, created_at, expires_at)
         VALUES ('basi','n','v',?,NULL,?,?)`,
      )
      .run(tenant.slug, new Date(Date.now() - 3_600_000).toISOString(), new Date(Date.now() - 1000).toISOString());
    await service.start({ tenantSlug: tenant.slug });

    const sisa = harness.db.prepare("SELECT COUNT(*) AS n FROM oidc_login_state WHERE state = 'basi'").get() as {
      n: number;
    };
    expect(sisa.n).toBe(0);
    // Umurnya terbatas dan wajar.
    expect(OIDC_STATE_TTL_MS).toBeLessThanOrEqual(30 * 60_000);
  });

  it('TC-SSO-07 — alasan teknis penolakan token TIDAK dikembalikan ke pemanggil', async () => {
    // Token yang nonce-nya milik sesi lain: sah dan bertanda tangan benar, tetapi bukan
    // milik percobaan masuk ini.
    const service = flow();
    const started = await service.start({ tenantSlug: tenant.slug });

    const error = await service
      .complete({ state: started.state, code: 'kode-basi', fingerprint: fingerprint() })
      .then(() => null)
      .catch((e: unknown) => e as AppError);

    // Satu kunci pesan, bukan "nonce_mismatch": memberi tahu penyerang bagian mana dari
    // token palsunya yang perlu diperbaiki adalah memberinya petunjuk gratis.
    expect(error?.messageKey).toBe('error.sso_token_invalid');
    expect(String(error?.message)).not.toContain('nonce');

    // Penyedia yang menolak menukar kode dilaporkan berbeda — ini bukan salah pengguna.
    exchangeFailure = 'oidc_exchange_failed';
    const kedua = await service.start({ tenantSlug: tenant.slug });
    await expect(
      service.complete({ state: kedua.state, code: 'kode', fingerprint: fingerprint() }),
    ).rejects.toMatchObject({ messageKey: 'error.sso_exchange_failed' });
  });
});

/* ================= Gerbang ================= */

describe('Gerbang yang sama dengan masuk biasa', () => {
  it('TC-SSO-08 — akun yang belum ada TIDAK dibuat otomatis', async () => {
    claimOverrides = { email: 'orang.asing@contoh.id', email_verified: true };

    const { result } = await roundTrip(flow());

    expect(result.kind).toBe('rejected');
    expect(result).toMatchObject({ reasonKey: 'error.invalid_credentials' });
    const dibuat = harness.db
      .prepare('SELECT COUNT(*) AS n FROM system_user WHERE email = ?')
      .get('orang.asing@contoh.id') as { n: number };
    expect(dibuat.n).toBe(0);
  });

  it('TC-SSO-09 — akun yang dinonaktifkan tetap tertolak lewat SSO', async () => {
    harness.db.prepare("UPDATE system_user SET status = 'disabled' WHERE id = ?").run(tenant.adminUserId);

    const { result } = await roundTrip(flow());

    // Jawaban seragam: membedakan "dinonaktifkan" dari "tidak ada" di jalur tanpa kata
    // sandi menjadikan endpoint ini alat memetakan siapa saja yang terdaftar.
    expect(result).toMatchObject({ kind: 'rejected', reasonKey: 'error.invalid_credentials' });
  });

  it('TC-SSO-10 — ruang kerja yang belum disetujui tetap tertahan', async () => {
    harness.db.prepare("UPDATE tenants SET approval_status = 'pending' WHERE id = ?").run(tenant.tenantId);

    const { result } = await roundTrip(flow());

    expect(result).toMatchObject({
      kind: 'rejected',
      reasonKey: 'error.registration_pending_approval',
      recoveryKey: 'recovery.wait_for_approval',
    });
  });

  it('TC-SSO-11 — ruang kerja yang tidak ada dijawab sama dengan kredensial salah', async () => {
    const { result } = await roundTrip(flow(), { slug: 'ruang-kerja-karangan' });

    expect(result).toMatchObject({ kind: 'rejected', reasonKey: 'error.invalid_credentials' });
  });

  it('TC-SSO-12 — email yang belum terverifikasi di sisi penyedia ditolak', async () => {
    // Penyedia yang membiarkan pengguna menuliskan alamat apa pun di profilnya akan
    // menjadi cara mengambil alih akun orang lain di sini.
    claimOverrides = { email_verified: false };

    await expect(roundTrip(flow())).rejects.toMatchObject({ messageKey: 'error.sso_token_invalid' });
  });
});

/* ================= Jalur berhasil ================= */

describe('Masuk yang berhasil', () => {
  it('TC-SSO-13 — sesi terbit, perangkat terikat, dan sesi lama dicabut', async () => {
    const service = flow();

    const pertama = await roundTrip(service);
    expect(pertama.result.kind).toBe('ok');
    const token = (pertama.result as { token: string }).token;
    // Sesi benar-benar dapat dipakai, bukan sekadar string.
    expect(harness.auth.resolveSession(token).tenantId).toBe(tenant.tenantId);

    // Sesi tunggal: masuk lagi mencabut yang sebelumnya.
    const kedua = await roundTrip(service);
    expect(kedua.result.kind).toBe('ok');
    expect(() => harness.auth.resolveSession(token)).toThrow();

    // Perangkat terdaftar lewat jalur yang sama dengan masuk biasa.
    const perangkat = harness.db
      .prepare('SELECT COUNT(*) AS n FROM device_bindings WHERE user_id = ?')
      .get(tenant.adminUserId) as { n: number };
    expect(perangkat.n).toBeGreaterThan(0);
  });

  it('TC-SSO-14 — tercatat di Log Aktivitas sebagai masuk terfederasi', async () => {
    await roundTrip(flow());

    const entri = harness.db
      .prepare(
        `SELECT detail_json FROM auditdb.audit_log
          WHERE tenant_id = ? AND action = 'auth.login_federated'`,
      )
      .get(tenant.tenantId) as { detail_json: string } | undefined;

    // Dibedakan dari `auth.login`: peninjau harus dapat melihat siapa yang masuk tanpa
    // kata sandi, dan lewat penyedia mana.
    expect(entri).toBeDefined();
    expect(String(entri?.detail_json)).toContain('sso.contoh.id');
  });

  it('TC-SSO-15 — tujuan yang tersimpan dikembalikan ke pemanggil', async () => {
    const { redirectTo } = await roundTrip(flow(), { redirectTo: '/#/langganan' });

    expect(redirectTo).toBe('/#/langganan');
  });

  it('TC-SSO-16 — kata sandi lokal TIDAK ikut berubah atau terhapus', async () => {
    const sebelum = harness.db
      .prepare('SELECT password_hash FROM system_user WHERE id = ?')
      .get(tenant.adminUserId) as { password_hash: string };

    await roundTrip(flow());

    const sesudah = harness.db
      .prepare('SELECT password_hash FROM system_user WHERE id = ?')
      .get(tenant.adminUserId) as { password_hash: string };
    // Masuk lewat SSO adalah cara TAMBAHAN, bukan pengganti. Menghapus kata sandi berarti
    // penyedia yang sedang mati mengunci seluruh organisasi di luar aplikasinya.
    expect(sesudah.password_hash).toBe(sebelum.password_hash);
  });
});
