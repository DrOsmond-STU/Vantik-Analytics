/**
 * SSO OpenID Connect.
 *
 * Uji ini membangun ID token **sungguhan** — ditandatangani RSA dengan kunci yang dibuat di
 * tempat — lalu memverifikasinya lewat JWKS. Bukan mock: seluruh nilai berkas ini terletak
 * pada apakah tanda tangan dan klaimnya benar-benar diperiksa, dan mock hanya akan
 * membuktikan bahwa uji ini sepakat dengan dirinya sendiri.
 *
 * Setiap kasus di bawah adalah kerentanan yang pernah menembus pemasangan sungguhan:
 *
 *  1. **`alg: none`** (TC-OID-05) — token tanpa tanda tangan diterima karena headernya
 *     dipercaya.
 *  2. **Penurunan ke HMAC** (TC-OID-06) — kunci publik dipakai sebagai rahasia HMAC.
 *  3. **Token milik aplikasi lain** (TC-OID-08) di penyedia yang sama.
 *  4. **Pemutaran ulang** (TC-OID-09) token dari sesi orang lain.
 *  5. **Email belum terverifikasi** (TC-OID-12) — cara mengambil alih akun orang lain
 *     dengan mengaku beralamat sama.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createSign, generateKeyPairSync, createHmac } from 'node:crypto';
import {
  CLOCK_SKEW_SECONDS,
  clearOidcCache,
  resolveOidcFromEnv,
  trustedEmail,
  verifyIdToken,
  type OidcConfig,
} from '../src/identity-service/oidc.ts';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'kunci-1', alg: 'RS256', use: 'sig' } as Record<
  string,
  unknown
> as never;

const CONFIG: OidcConfig = {
  issuer: 'https://sso.contoh.id',
  clientId: 'vantik-analytics',
  clientSecret: 'rahasia-klien',
  redirectUri: 'https://analitik.contoh.id/auth/oidc/callback',
  allowedDomains: [],
};

const NONCE = 'nonce-sesi-ini';

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** Membuat ID token yang benar-benar ditandatangani. */
function token(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'kunci-1', ...header });
  const body = b64({
    iss: CONFIG.issuer,
    aud: CONFIG.clientId,
    sub: 'pengguna-123',
    email: 'budi@contoh.id',
    email_verified: true,
    name: 'Budi',
    nonce: NONCE,
    iat: now,
    exp: now + 300,
    ...claims,
  });
  const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}

beforeEach(() => clearOidcCache());

/* ================= Konfigurasi ================= */

describe('Konfigurasi OIDC', () => {
  it('TC-OID-01 — kosong secara bawaan; setengah terisi tidak diaktifkan', () => {
    expect(resolveOidcFromEnv({})).toBeNull();
    // Tombol "Masuk dengan SSO" yang pasti gagal hanya membingungkan.
    expect(
      resolveOidcFromEnv({ VANTIK_OIDC_ISSUER: 'https://sso.contoh.id', VANTIK_OIDC_CLIENT_ID: 'x' }),
    ).toBeNull();
  });

  it('TC-OID-02 — terisi lengkap, dan daftar domain diurai', () => {
    const config = resolveOidcFromEnv({
      VANTIK_OIDC_ISSUER: 'https://sso.contoh.id/',
      VANTIK_OIDC_CLIENT_ID: 'vantik',
      VANTIK_OIDC_CLIENT_SECRET: 'rahasia',
      VANTIK_OIDC_REDIRECT_URI: 'https://analitik.contoh.id/cb',
      VANTIK_OIDC_ALLOWED_DOMAINS: 'Contoh.id, mitra.co.id ',
    });

    // Garis miring di ujung dibuang supaya pencocokan `iss` tidak gagal karena hal sepele.
    expect(config?.issuer).toBe('https://sso.contoh.id');
    expect(config?.allowedDomains).toEqual(['contoh.id', 'mitra.co.id']);
  });
});

/* ================= Verifikasi tanda tangan ================= */

describe('Verifikasi tanda tangan', () => {
  it('TC-OID-03 — token yang sah diterima dan klaimnya dikembalikan', () => {
    const claims = verifyIdToken(token(), [jwk], CONFIG, NONCE);

    expect(claims.sub).toBe('pengguna-123');
    expect(claims.email).toBe('budi@contoh.id');
  });

  it('TC-OID-04 — tanda tangan yang diubah ditolak', () => {
    const [h, p] = token().split('.');
    const palsu = `${h}.${p}.${Buffer.from('tanda-tangan-palsu').toString('base64url')}`;

    expect(() => verifyIdToken(palsu, [jwk], CONFIG, NONCE)).toThrow(/signature_invalid/);
  });

  it('TC-OID-05 — `alg: none` DITOLAK', () => {
    const now = Math.floor(Date.now() / 1000);
    const head = b64({ alg: 'none', typ: 'JWT' });
    const body = b64({ iss: CONFIG.issuer, aud: CONFIG.clientId, sub: 'x', nonce: NONCE, iat: now, exp: now + 300 });

    // Klasik: header token dipercaya, sehingga token tanpa tanda tangan diterima.
    expect(() => verifyIdToken(`${head}.${body}.`, [jwk], CONFIG, NONCE)).toThrow(/signature_invalid|malformed/);
  });

  it('TC-OID-06 — penurunan ke HMAC dengan kunci publik sebagai rahasia DITOLAK', () => {
    const now = Math.floor(Date.now() / 1000);
    const head = b64({ alg: 'HS256', typ: 'JWT', kid: 'kunci-1' });
    const body = b64({ iss: CONFIG.issuer, aud: CONFIG.clientId, sub: 'x', nonce: NONCE, iat: now, exp: now + 300 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const signature = createHmac('sha256', pem).update(`${head}.${body}`).digest('base64url');

    // Algoritme ditentukan KUNCI dari JWKS, bukan header token — itulah yang menutup ini.
    expect(() => verifyIdToken(`${head}.${body}.${signature}`, [jwk], CONFIG, NONCE)).toThrow(/signature_invalid/);
  });

  it('TC-OID-07 — kunci dengan kid yang tidak dikenal ditolak', () => {
    const asing = { ...(jwk as unknown as Record<string, unknown>), kid: 'kunci-lain' } as never;
    expect(() => verifyIdToken(token({}, { kid: 'kunci-1' }), [asing], CONFIG, NONCE)).toThrow(/key_not_found/);
  });
});

/* ================= Klaim ================= */

describe('Pemeriksaan klaim', () => {
  it('TC-OID-08 — token milik aplikasi lain di penyedia yang sama ditolak', () => {
    // Sah, ditandatangani penyedia yang sama — tetapi untuk `aud` yang berbeda.
    expect(() => verifyIdToken(token({ aud: 'aplikasi-lain' }), [jwk], CONFIG, NONCE)).toThrow(/audience_mismatch/);
  });

  it('TC-OID-09 — nonce yang tidak cocok ditolak', () => {
    // Menutup pemutaran ulang token yang dicuri dari sesi orang lain.
    expect(() => verifyIdToken(token({ nonce: 'nonce-sesi-lain' }), [jwk], CONFIG, NONCE)).toThrow(/nonce_mismatch/);
    expect(() => verifyIdToken(token({ nonce: undefined }), [jwk], CONFIG, NONCE)).toThrow(/nonce_mismatch/);
  });

  it('TC-OID-10 — issuer yang berbeda ditolak', () => {
    expect(() => verifyIdToken(token({ iss: 'https://sso-palsu.id' }), [jwk], CONFIG, NONCE)).toThrow(
      /issuer_mismatch/,
    );
  });

  it('TC-OID-11 — token kedaluwarsa ditolak, tetapi toleransi jam yang wajar diterima', () => {
    const now = Math.floor(Date.now() / 1000);

    // Lewat jauh: ditolak.
    expect(() => verifyIdToken(token({ exp: now - 3600 }), [jwk], CONFIG, NONCE)).toThrow(/expired/);
    // Baru lewat beberapa detik: diterima, karena jam server tidak pernah persis sama.
    expect(verifyIdToken(token({ exp: now - 30 }), [jwk], CONFIG, NONCE).sub).toBe('pengguna-123');
    // Toleransinya terbatas, bukan tak terhingga.
    expect(CLOCK_SKEW_SECONDS).toBeLessThanOrEqual(300);
    // Token dari masa depan yang jauh juga ditolak.
    expect(() => verifyIdToken(token({ iat: now + 3600, exp: now + 7200 }), [jwk], CONFIG, NONCE)).toThrow(
      /not_yet_valid/,
    );
  });
});

/* ================= Alamat email ================= */

describe('Alamat yang dipercaya', () => {
  const claims = (over: Record<string, unknown> = {}) =>
    ({ iss: CONFIG.issuer, aud: CONFIG.clientId, sub: 'x', exp: 0, iat: 0, email: 'budi@contoh.id', email_verified: true, ...over }) as never;

  it('TC-OID-12 — email yang BELUM terverifikasi ditolak', () => {
    // Penyedia yang mengizinkan pengguna menuliskan alamat apa pun di profilnya menjadi cara
    // mengambil alih akun orang lain di sini — cukup dengan mengaku beralamat sama.
    expect(() => trustedEmail(claims({ email_verified: false }), CONFIG)).toThrow(/email_unverified/);
  });

  it('TC-OID-13 — token tanpa email ditolak', () => {
    expect(() => trustedEmail(claims({ email: undefined }), CONFIG)).toThrow(/email_missing/);
  });

  it('TC-OID-14 — domain di luar daftar ditolak bila daftarnya diisi', () => {
    const dibatasi = { ...CONFIG, allowedDomains: ['contoh.id'] };

    expect(trustedEmail(claims(), dibatasi)).toBe('budi@contoh.id');
    expect(() => trustedEmail(claims({ email: 'orang@luar.id' }), dibatasi)).toThrow(/domain_not_allowed/);
    // Tanpa daftar, domain mana pun diterima — pembatasan adalah pilihan operator.
    expect(trustedEmail(claims({ email: 'orang@luar.id' }), CONFIG)).toBe('orang@luar.id');
  });

  it('TC-OID-15 — alamat dinormalkan menjadi huruf kecil', () => {
    // Tanpa ini, "Budi@Contoh.id" dan "budi@contoh.id" menjadi dua akun berbeda.
    expect(trustedEmail(claims({ email: '  Budi@Contoh.ID ' }), CONFIG)).toBe('budi@contoh.id');
  });
});
