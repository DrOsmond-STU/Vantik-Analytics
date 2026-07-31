/**
 * Alur masuk lewat SSO, dari pengalihan sampai sesi terbit.
 *
 * Dipisahkan dari `oidc.ts` (yang murni protokol, tanpa basis data) dan dari `auth.ts`
 * (yang tidak boleh tahu apa-apa tentang HTTP). Yang tersisa di sini hanya satu hal:
 * menjaga agar percobaan masuk yang dimulai di satu tab benar-benar percobaan yang sama
 * saat pengguna kembali.
 *
 * Keadaan antar-langkah disimpan di TABEL, bukan memori. Passenger menjalankan beberapa
 * proses; keadaan di memori berarti pengguna yang dialihkan oleh proses A lalu kembali ke
 * proses B ditolak dengan "state tidak dikenal" — kegagalan yang muncul sesekali,
 * tampak seperti gangguan jaringan, dan mustahil ditelusuri.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Db } from '../platform/db.ts';
import { ValidationError } from '../platform/errors.ts';
import type { FingerprintComponents } from './deviceFingerprint.ts';
import type { AuthService, LoginResult } from './auth.ts';
import {
  beginLogin,
  exchangeCode,
  fetchJwks,
  discover,
  trustedEmail,
  verifyIdToken,
  type AuthRequest,
  type Jwk,
  type OidcConfig,
  type ProviderMetadata,
  type TokenResponse,
} from './oidc.ts';

/**
 * Bagian yang berbicara ke jaringan, dipisahkan agar dapat diganti saat pengujian.
 *
 * Yang TIDAK ada di sini disengaja: `verifyIdToken` dan `trustedEmail` tidak dapat
 * diganti. Keduanya adalah pemeriksaan keamanannya sendiri; membuatnya dapat ditukar
 * berarti sebuah uji dapat melewatinya, dan uji yang melewati pemeriksaan hanya
 * membuktikan bahwa ia sepakat dengan dirinya sendiri.
 */
export interface OidcProtocol {
  beginLogin(config: OidcConfig): Promise<AuthRequest>;
  exchangeCode(config: OidcConfig, code: string, codeVerifier: string): Promise<TokenResponse>;
  discover(config: OidcConfig): Promise<ProviderMetadata>;
  fetchJwks(metadata: ProviderMetadata): Promise<Jwk[]>;
}

const LIVE_PROTOCOL: OidcProtocol = { beginLogin, exchangeCode, discover, fetchJwks };

/**
 * Umur satu percobaan masuk.
 *
 * Cukup panjang untuk memasukkan kata sandi dan kode MFA di sisi penyedia, cukup pendek
 * untuk membuat baris yang berisi `code_verifier` tidak menganggur berhari-hari.
 */
export const OIDC_STATE_TTL_MS = 10 * 60_000;

interface StateRow {
  state: string;
  nonce: string;
  code_verifier: string;
  tenant_slug: string;
  redirect_to: string | null;
  expires_at: string;
}

export class OidcLoginFlow {
  constructor(
    private readonly db: Db,
    private readonly auth: AuthService,
    private readonly config: OidcConfig | null,
    private readonly protocol: OidcProtocol = LIVE_PROTOCOL,
  ) {}

  /** SSO menyala hanya bila seluruh variabel lingkungannya terisi — lihat `resolveOidcFromEnv`. */
  enabled(): boolean {
    return this.config !== null;
  }

  /**
   * Nama penyedia untuk ditampilkan di tombol masuk.
   *
   * Diambil dari host issuer, bukan dari nilai yang dapat diisi bebas: teks tombol yang
   * dapat ditulis operator adalah tempat yang nyaman untuk menaruh sesuatu yang menyesatkan.
   */
  providerLabel(): string | null {
    if (!this.config) return null;
    try {
      return new URL(this.config.issuer).host;
    } catch {
      return this.config.issuer;
    }
  }

  private requireConfig(): OidcConfig {
    if (!this.config) throw new ValidationError('error.sso_not_configured');
    return this.config;
  }

  /**
   * Langkah 1: menyusun URL penyedia dan menyimpan state/nonce/verifier.
   *
   * `redirectTo` hanya diterima sebagai lintasan relatif. URL absolut di sini berarti
   * open redirect: penyerang mengirim tautan "masuk" yang sah ke penyedia yang sah, lalu
   * memantulkan pengguna yang sudah masuk ke situsnya sendiri.
   */
  async start(input: { tenantSlug: string; redirectTo?: string | null }): Promise<{ url: string; state: string }> {
    const config = this.requireConfig();
    const slug = input.tenantSlug.trim().toLowerCase();
    if (!slug) throw new ValidationError('error.tenant_slug_required');

    this.sweepExpired();

    const request = await this.protocol.beginLogin(config);
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO oidc_login_state (state, nonce, code_verifier, tenant_slug, redirect_to, created_at, expires_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        request.state,
        request.nonce,
        request.codeVerifier,
        slug,
        safeRedirect(input.redirectTo),
        new Date(now).toISOString(),
        new Date(now + OIDC_STATE_TTL_MS).toISOString(),
      );

    return { url: request.url, state: request.state };
  }

  /**
   * Langkah 2: pengguna kembali dari penyedia dengan `code` dan `state`.
   *
   * Urutannya disengaja: baris state diambil dan DIHAPUS lebih dulu, sebelum satu pun
   * percakapan jaringan dimulai. Kode otorisasi hanya boleh ditukar sekali; menghapus
   * setelah penukaran berarti dua permintaan bersamaan dengan `state` yang sama
   * dua-duanya lolos.
   */
  async complete(input: {
    state: string;
    code: string;
    fingerprint: FingerprintComponents;
    ip?: string | null;
    geo?: { lat: number; lon: number; label?: string } | null;
  }): Promise<{ result: LoginResult; redirectTo: string | null }> {
    const config = this.requireConfig();
    if (!input.state || !input.code) throw new ValidationError('error.sso_state_invalid');

    const row = this.consumeState(input.state);
    if (!row) throw new ValidationError('error.sso_state_invalid');
    if (Date.parse(row.expires_at) <= Date.now()) throw new ValidationError('error.sso_state_expired');

    /**
     * Alasan teknis dipetakan menjadi SATU kunci pesan.
     *
     * `verifyIdToken` melempar nama pendek yang berguna bagi operator (`nonce_mismatch`,
     * `audience_mismatch`, …) dan berguna juga bagi penyerang: ia memberi tahu persis
     * bagian mana dari token palsunya yang perlu diperbaiki. Alasan aslinya masuk ke Log
     * Aktivitas lewat pemanggil; yang dikembalikan ke peramban hanya "tidak dapat
     * diterima".
     */
    let tokens: TokenResponse;
    try {
      tokens = await this.protocol.exchangeCode(config, input.code, row.code_verifier);
    } catch {
      throw new ValidationError('error.sso_exchange_failed');
    }

    let email: string;
    try {
      const metadata = await this.protocol.discover(config);
      const keys = await this.protocol.fetchJwks(metadata);
      const claims = verifyIdToken(tokens.id_token as string, keys, config, row.nonce);
      email = trustedEmail(claims, config);
    } catch {
      throw new ValidationError('error.sso_token_invalid');
    }

    const result = this.auth.loginFederated({
      tenantSlug: row.tenant_slug,
      email,
      provider: this.providerLabel() ?? 'sso',
      fingerprint: input.fingerprint,
      ip: input.ip ?? null,
      geo: input.geo ?? null,
    });

    return { result, redirectTo: row.redirect_to };
  }

  /**
   * Mengambil sekaligus menghapus baris state — sekali pakai.
   *
   * Yang menjadikannya sekali pakai bukan pembacaannya, melainkan `changes` dari DELETE:
   * dua permintaan bersamaan dengan `state` yang sama dapat sama-sama MEMBACA baris itu,
   * tetapi hanya satu yang benar-benar menghapusnya. Yang lain melihat `changes === 0`
   * dan diperlakukan seolah barisnya tidak pernah ada.
   */
  private consumeState(state: string): StateRow | null {
    const candidate = this.db
      .prepare('SELECT * FROM oidc_login_state WHERE state = ?')
      .get(state) as StateRow | undefined;
    if (!candidate) return null;

    // Perbandingan waktu-tetap: `state` adalah rahasia jangka pendek, dan pencocokan
    // yang bocor lewat waktu memberi penyerang cara menebaknya sepotong demi sepotong.
    if (!sameString(candidate.state, state)) return null;

    const removed = this.db.prepare('DELETE FROM oidc_login_state WHERE state = ?').run(state);
    // Sudah dipakai permintaan lain yang berjalan bersamaan: perlakukan sebagai tidak ada.
    if (removed.changes === 0) return null;

    return candidate;
  }

  /** Menyapu percobaan yang tidak pernah diselesaikan; tabelnya tidak boleh tumbuh selamanya. */
  private sweepExpired(): void {
    this.db.prepare('DELETE FROM oidc_login_state WHERE expires_at <= ?').run(new Date().toISOString());
  }
}

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * Menyaring tujuan setelah masuk.
 *
 * Hanya lintasan relatif satu garis miring. `//contoh.id` ditolak juga: peramban
 * memperlakukannya sebagai URL absolut berskema-sama, sehingga ia adalah open redirect
 * yang tampak seperti lintasan lokal.
 */
export function safeRedirect(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null;
  if (trimmed.includes('\\') || /[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

/** Sidik ringkas konfigurasi, untuk log tanpa membocorkan rahasia klien. */
export function configFingerprint(config: OidcConfig): string {
  return createHash('sha256').update(`${config.issuer}|${config.clientId}`).digest('hex').slice(0, 12);
}
