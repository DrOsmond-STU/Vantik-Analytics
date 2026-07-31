/**
 * SSO OpenID Connect (Authorization Code + PKCE), tanpa dependensi.
 *
 * Kolom `auth_provider` sudah ada sejak awal tetapi tidak ada alur federasinya, sehingga
 * pelanggan yang punya Google Workspace atau Microsoft Entra tetap harus membuat kata sandi
 * kedua di sini — persis yang hendak dihindari SSO.
 *
 * **SAML tidak didukung, dan itu keputusan.** SAML menuntut verifikasi tanda tangan XML
 * (XML-DSig) beserta kanonikalisasinya — bagian paling rapuh di seluruh dunia autentikasi,
 * dan tempat lahirnya kelas kerentanan "signature wrapping" yang berulang kali menembus
 * pustaka matang. Menulisnya sendiri di sini akan menjadi bagian paling berbahaya dari
 * seluruh sistem. OIDC menandatangani JWT dengan JWS — bentuk yang dapat diverifikasi
 * `node:crypto` secara langsung dan tidak punya ruang tafsir.
 *
 * Yang ditegakkan pada setiap token, dan masing-masing pernah menjadi kerentanan nyata di
 * pemasangan orang lain:
 *
 *  - `alg` diambil dari JWKS, BUKAN dari header token. Menerima `alg` dari token berarti
 *    penyerang dapat menyetel `none` atau menurunkannya ke HMAC dengan kunci publik sebagai
 *    rahasia.
 *  - `iss` dan `aud` dicocokkan. Tanpa itu, token sah milik aplikasi lain di penyedia yang
 *    sama dapat dipakai masuk ke sini.
 *  - `nonce` dicocokkan dengan yang dikirim saat memulai. Tanpa itu, token yang dicuri dari
 *    sesi lain dapat diputar ulang.
 *  - Kedaluwarsa diperiksa dengan toleransi jam yang kecil dan TERBATAS.
 */
import { createHash, createPublicKey, createVerify, randomBytes, timingSafeEqual } from 'node:crypto';

/** Batas waktu panggilan ke penyedia identitas. */
export const OIDC_TIMEOUT_MS = 10_000;

/** Toleransi selisih jam antara server ini dan penyedia. */
export const CLOCK_SKEW_SECONDS = 120;

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Domain email yang boleh masuk lewat jalur ini; kosong berarti tidak dibatasi. */
  allowedDomains: string[];
}

function trimmed(value: string | undefined): string {
  return (value ?? '').trim();
}

/**
 * Merakit konfigurasi dari variabel lingkungan; `null` bila belum diisi.
 *
 * Setengah terkonfigurasi TIDAK diaktifkan: tombol "Masuk dengan SSO" yang pasti gagal hanya
 * membingungkan, sementara tidak adanya tombol menyatakan keadaan yang sebenarnya.
 */
export function resolveOidcFromEnv(env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
  const issuer = trimmed(env.VANTIK_OIDC_ISSUER).replace(/\/+$/, '');
  const clientId = trimmed(env.VANTIK_OIDC_CLIENT_ID);
  const clientSecret = trimmed(env.VANTIK_OIDC_CLIENT_SECRET);
  const redirectUri = trimmed(env.VANTIK_OIDC_REDIRECT_URI);
  if (!issuer || !clientId || !clientSecret || !redirectUri) return null;

  return {
    issuer,
    clientId,
    clientSecret,
    redirectUri,
    allowedDomains: trimmed(env.VANTIK_OIDC_ALLOWED_DOMAINS)
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  };
}

/* ================= Penemuan & kunci ================= */

export interface ProviderMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

export interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  n?: string;
  e?: string;
  use?: string;
}

/** Cache dokumen penemuan & kunci; keduanya jarang berubah dan mahal diambil per login. */
const metadataCache = new Map<string, { at: number; value: ProviderMetadata }>();
const jwksCache = new Map<string, { at: number; value: Jwk[] }>();
const CACHE_TTL_MS = 60 * 60_000;

export async function discover(config: OidcConfig, now = Date.now()): Promise<ProviderMetadata> {
  const cached = metadataCache.get(config.issuer);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;

  const response = await fetch(`${config.issuer}/.well-known/openid-configuration`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(OIDC_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('oidc_discovery_failed');
  const value = (await response.json()) as ProviderMetadata;

  // Penyedia yang menyatakan issuer berbeda dari yang kita minta adalah tanda konfigurasi
  // yang keliru — atau pengalihan. Keduanya alasan untuk berhenti.
  if (value.issuer.replace(/\/+$/, '') !== config.issuer) throw new Error('oidc_issuer_mismatch');

  metadataCache.set(config.issuer, { at: now, value });
  return value;
}

export async function fetchJwks(metadata: ProviderMetadata, now = Date.now()): Promise<Jwk[]> {
  const cached = jwksCache.get(metadata.jwks_uri);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;

  const response = await fetch(metadata.jwks_uri, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(OIDC_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('oidc_jwks_failed');
  const body = (await response.json()) as { keys?: Jwk[] };
  const value = body.keys ?? [];
  jwksCache.set(metadata.jwks_uri, { at: now, value });
  return value;
}

/** Membuang cache; dipakai pengujian dan saat kunci penyedia dirotasi. */
export function clearOidcCache(): void {
  metadataCache.clear();
  jwksCache.clear();
}

/* ================= Memulai ================= */

export interface AuthRequest {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

/**
 * Menyusun URL untuk mengalihkan pengguna ke penyedia.
 *
 * PKCE dipakai meski ini klien rahasia: tanpa `code_verifier`, kode otorisasi yang bocor
 * lewat riwayat peramban atau log proxy cukup untuk menukarnya menjadi token.
 */
export async function beginLogin(config: OidcConfig): Promise<AuthRequest> {
  const metadata = await discover(config);
  const state = randomBytes(24).toString('base64url');
  const nonce = randomBytes(24).toString('base64url');
  const codeVerifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(codeVerifier).digest('base64url');

  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  return { url: url.toString(), state, nonce, codeVerifier };
}

/* ================= Verifikasi token ================= */

export interface IdTokenClaims {
  iss: string;
  aud: string | string[];
  sub: string;
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

function jwkToPem(jwk: Jwk): ReturnType<typeof createPublicKey> {
  return createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e } as never, format: 'jwk' });
}

/** Perbandingan waktu-tetap untuk nilai yang sensitif terhadap pembocoran lewat waktu. */
function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * Memverifikasi ID token dan mengembalikan klaimnya.
 *
 * Melempar `Error` bernama pendek — pemanggil memetakannya ke kunci pesan. Alasannya tidak
 * pernah memuat isi token: token itu sendiri adalah kredensial.
 */
export function verifyIdToken(
  token: string,
  keys: Jwk[],
  config: OidcConfig,
  expectedNonce: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): IdTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('oidc_token_malformed');
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let claims: IdTokenClaims;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as typeof header;
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as IdTokenClaims;
  } catch {
    throw new Error('oidc_token_malformed');
  }

  // `alg` dari token TIDAK dipercaya. Kunci dipilih dari JWKS, dan algoritmenya ditentukan
  // kunci itu — inilah penjagaan yang menutup serangan `alg: none` dan penurunan ke HMAC.
  const candidates = keys.filter((k) => k.kty === 'RSA' && (!header.kid || !k.kid || k.kid === header.kid));
  if (candidates.length === 0) throw new Error('oidc_key_not_found');

  const signature = Buffer.from(signatureB64, 'base64url');
  const signed = `${headerB64}.${payloadB64}`;
  const verified = candidates.some((jwk) => {
    try {
      return createVerify('RSA-SHA256').update(signed).verify(jwkToPem(jwk), signature);
    } catch {
      return false;
    }
  });
  if (!verified) throw new Error('oidc_signature_invalid');

  if (claims.iss?.replace(/\/+$/, '') !== config.issuer) throw new Error('oidc_issuer_mismatch');

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.some((a) => sameString(String(a), config.clientId))) throw new Error('oidc_audience_mismatch');

  if (!claims.nonce || !sameString(claims.nonce, expectedNonce)) throw new Error('oidc_nonce_mismatch');

  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < nowSeconds) {
    throw new Error('oidc_token_expired');
  }
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_SECONDS > nowSeconds) {
    // Token dari masa depan menandakan jam yang jauh melenceng atau token yang dibuat-buat.
    throw new Error('oidc_token_not_yet_valid');
  }

  return claims;
}

/**
 * Alamat email yang boleh dipercaya dari klaim.
 *
 * `email_verified` WAJIB benar. Tanpa itu, penyedia yang mengizinkan pengguna menuliskan
 * alamat apa pun di profilnya menjadi cara mengambil alih akun orang lain di sini — cukup
 * dengan mengaku beralamat sama.
 */
export function trustedEmail(claims: IdTokenClaims, config: OidcConfig): string {
  const email = (claims.email ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) throw new Error('oidc_email_missing');
  if (claims.email_verified === false) throw new Error('oidc_email_unverified');

  if (config.allowedDomains.length > 0) {
    const domain = email.split('@')[1] ?? '';
    if (!config.allowedDomains.includes(domain)) throw new Error('oidc_domain_not_allowed');
  }
  return email;
}

/* ================= Penukaran kode ================= */

export interface TokenResponse {
  id_token?: string;
  access_token?: string;
  error?: string;
}

export async function exchangeCode(
  config: OidcConfig,
  code: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  const metadata = await discover(config);
  const response = await fetch(metadata.token_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // Klien rahasia memakai Basic auth; rahasianya tidak pernah masuk badan permintaan
      // yang lebih sering tercatat di log proxy.
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      code_verifier: codeVerifier,
    }).toString(),
    signal: AbortSignal.timeout(OIDC_TIMEOUT_MS),
  });

  const body = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || !body.id_token) throw new Error('oidc_exchange_failed');
  return body;
}
