/**
 * Klien API. Seluruh permintaan menuju `/api/v1/...` (ARCHITECTURE.md Bagian 6).
 *
 * Kesalahan dari server hanya memuat KUNCI i18n; klien menerjemahkannya lewat kamus
 * (DESIGN.md 8.2) — tidak ada kalimat kesalahan yang dirakit di sini.
 */
import type { FingerprintComponents } from './fingerprint.ts';

const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly key: string,
    readonly detail: Record<string, unknown> | null,
    readonly recoveryKey: string | null = null,
  ) {
    super(key);
    this.name = 'ApiError';
  }
}

let sessionToken: string | null = null;

export function setToken(token: string | null): void {
  sessionToken = token;
  try {
    if (token) localStorage.setItem('vantik.token', token);
    else localStorage.removeItem('vantik.token');
  } catch {
    /* penyimpanan lokal tidak tersedia — sesi tetap berjalan lewat cookie */
  }
}

export function loadToken(): string | null {
  if (sessionToken) return sessionToken;
  try {
    sessionToken = localStorage.getItem('vantik.token');
  } catch {
    sessionToken = null;
  }
  return sessionToken;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const token = loadToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(`${BASE}${path}`, { ...init, headers, credentials: 'include' });
  const isJson = response.headers.get('content-type')?.includes('application/json');
  const payload = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const error = (payload as { error?: { key?: string; detail?: Record<string, unknown>; recoveryKey?: string } }).error;
    throw new ApiError(
      response.status,
      error?.key ?? 'error.internal',
      error?.detail ?? null,
      error?.recoveryKey ?? null,
    );
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>(path),
  post: <T>(path: string, body?: unknown, idempotencyKey?: string): Promise<T> =>
    request<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    }),
  put: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
  delete: <T>(path: string): Promise<T> => request<T>(path, { method: 'DELETE' }),

  /**
   * Login langkah pertama.
   *
   * Bila peran pengguna memakai verifikasi dua langkah, server menjawab
   * `mfaRequired` TANPA token sesi — jadi tidak ada token yang disimpan di sini.
   * Pemanggil wajib melanjutkan ke `verifyMfa()`.
   */
  async login(input: {
    email: string;
    password: string;
    tenantSlug?: string;
    fingerprint: FingerprintComponents;
  }): Promise<LoginOutcome> {
    const result = await request<LoginOutcome>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    if ('token' in result) setToken(result.token);
    return result;
  },

  /** Login langkah kedua: kode autentikator ATAU kode pemulihan. */
  async verifyMfa(input: {
    challengeToken: string;
    code: string;
    fingerprint: FingerprintComponents;
  }): Promise<{ token: string; expiresAt: string; deviceRegistered: boolean }> {
    const result = await request<{ token: string; expiresAt: string; deviceRegistered: boolean }>(
      '/auth/mfa/verify',
      { method: 'POST', body: JSON.stringify(input) },
    );
    setToken(result.token);
    return result;
  },

  /* ---------------- Permukaan publik (tanpa sesi) ---------------- */

  /** Katalog paket untuk halaman depan & halaman berlangganan. */
  plans: (): Promise<PublicPlans> => request<PublicPlans>('/public/plans'),

  /**
   * Teks halaman depan yang ditimpa operator lewat CMS.
   *
   * Kegagalannya SENGAJA tidak diperlakukan sebagai kegagalan halaman: yang kembali
   * adalah peta kosong, dan halaman depan jatuh ke kamus bawaan. Halaman pemasaran
   * yang gagal tampil karena satu permintaan tambahan adalah harga yang tidak sepadan.
   */
  content: (locale: string): Promise<{ locale: string; content: Record<string, string> }> =>
    request<{ locale: string; content: Record<string, string> }>(
      `/public/content?locale=${encodeURIComponent(locale)}`,
    ),

  /* ------------------------------ CMS ------------------------------ */
  cmsContent: (): Promise<CmsContent> => request<CmsContent>('/system/cms/content'),
  cmsSetContent: (key: string, locale: string, value: string): Promise<CmsContent> =>
    request<CmsContent>('/system/cms/content', {
      method: 'PUT',
      body: JSON.stringify({ key, locale, value }),
    }),
  cmsPlans: (): Promise<CmsPlans> => request<CmsPlans>('/system/cms/plans'),
  cmsSavePlan: (code: string, body: unknown): Promise<CmsPlans> =>
    request<CmsPlans>(`/system/cms/plans/${encodeURIComponent(code)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  cmsDeletePlan: (code: string): Promise<CmsPlans> =>
    request<CmsPlans>(`/system/cms/plans/${encodeURIComponent(code)}`, { method: 'DELETE' }),

  /** Berlangganan: membuat ruang kerja baru berstatus uji coba. */
  signup: (input: {
    organisationName: string;
    slug: string;
    planCode: string;
    billingCycle: BillingCycle;
    fullName: string;
    email: string;
    password: string;
    /**
     * Jawaban memuat `pendingApproval: true` selama pendaftaran menunggu keputusan
     * admin — yang kini SELALU terjadi pada pendaftaran mandiri. Antarmuka wajib
     * membacanya alih-alih mengasumsikan ruang kerja langsung hidup: layar sukses yang
     * menyuruh "silakan masuk" hanya akan mengantar ke penolakan.
     */
  }): Promise<{ slug: string; pendingApproval?: boolean }> =>
    request('/public/signup', { method: 'POST', body: JSON.stringify(input) }),

  /**
   * Lupa kata sandi, langkah pertama.
   *
   * Jawabannya sama untuk alamat terdaftar maupun tidak — server sengaja tidak
   * memberitahu yang mana, dan antarmuka tidak boleh menyiasatinya dengan menampilkan
   * pesan berbeda.
   */
  requestPasswordReset: (input: { email: string; tenantSlug?: string }): Promise<{ accepted: true; transportConfigured: boolean }> =>
    request('/auth/password-reset/request', { method: 'POST', body: JSON.stringify(input) }),

  /** Lupa kata sandi, langkah kedua: token dari pesan + kata sandi baru. */
  confirmPasswordReset: (input: { token: string; newPassword: string }): Promise<{ ok: true }> =>
    request('/auth/password-reset/confirm', { method: 'POST', body: JSON.stringify(input) }),

  async logout(): Promise<void> {
    try {
      await request('/auth/logout', { method: 'POST' });
    } finally {
      setToken(null);
    }
  },
};

/* ---------------- Bentuk data yang dipakai antarmuka ---------------- */

/**
 * Dua kemungkinan hasil login. Dibuat sebagai union, bukan satu objek dengan medan
 * opsional, supaya TypeScript memaksa antarmuka menangani kasus MFA — bukan
 * mengandalkan pengembang mengingatnya.
 */
export type LoginOutcome =
  | { token: string; expiresAt: string; deviceRegistered: boolean }
  | { mfaRequired: true; challengeToken: string; expiresAt: string; recoveryAccepted: boolean };

/** Siklus berlangganan yang ditawarkan: 1, 3, 6, atau 12 bulan. */
export type BillingCycle = 'monthly' | 'quarterly' | 'semiannual' | 'annual';

export interface BillingCycleOption {
  code: BillingCycle;
  months: number;
  /** Potongan dibanding membayar bulanan selama jumlah bulan yang sama. */
  discount: number;
  sortOrder: number;
}

export interface PublicPlan {
  code: string;
  name: string;
  monthlyPrice: number;
  annualPrice: number;
  /**
   * Harga per siklus, DIHITUNG SERVER.
   *
   * Antarmuka tidak menghitung diskonnya sendiri: kalau ia melakukannya, angka yang
   * dipajang di halaman depan dan angka yang tercetak di faktur berasal dari dua rumus
   * yang dapat menyimpang tanpa ada yang menyadarinya.
   */
  prices: Record<BillingCycle, number>;
  moduleCount: number;
  quotas: Record<string, number>;
  sortOrder: number;
}

export interface CmsContent {
  editableKeys: string[];
  overrides: { id: Record<string, string>; en: Record<string, string> };
}

export interface CmsPlan {
  code: string;
  name: string;
  monthlyPrice: number;
  annualPrice: number;
  features: Record<string, boolean>;
  quotas: Record<string, number>;
  sortOrder: number;
  published: boolean;
  description: string | null;
}

export interface CmsPlans {
  plans: CmsPlan[];
  moduleKeys?: string[];
  quotaKeys?: string[];
}

export interface PublicPlans {
  plans: PublicPlan[];
  cycles: BillingCycleOption[];
  /** False bila operator mematikan pendaftaran mandiri (`VANTIK_SELF_SIGNUP=off`). */
  signupEnabled: boolean;
  currency: string;
}

export interface MfaStatus {
  enrolled: boolean;
  activatedAt: string | null;
  secretPending: boolean;
  remainingRecoveryCodes: number;
  requiredByRole: boolean;
  enrolmentPending: boolean;
}

export interface Session {
  user: {
    id: string;
    email: string;
    displayName: string;
    locale: 'id' | 'en';
    theme: 'light' | 'dark';
    roles: string[];
    mfaEnrolled: boolean;
  };
  tenant: {
    id: string;
    name: string;
    slug: string;
    status: string;
    accentColor: string | null;
    logoText: string | null;
    whiteLabel: boolean;
    maxDevicesPerUser: number;
  };
  flags: {
    plan: string;
    readOnly: boolean;
    /** Mengapa baca-saja — menentukan langkah pemulihan yang ditawarkan antarmuka. */
    readOnlyReason: 'subscription_expired' | 'tenant_status' | null;
    expiresAt: string | null;
    modules: Record<string, boolean>;
    quotas: Record<string, number>;
  };
  rls: { restricted: boolean; dimensions: string[] };
  permissions: string[];
}

export interface Dataset {
  id: string;
  name: string;
  source_type: string;
  status: string;
  classification: string;
  certification: string;
  quality_score: number | null;
  row_count: number;
  size_bytes: number;
  original_filename: string | null;
  failure_reason_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface KpiSummary {
  id: string;
  code: string;
  name: string;
  unit: string | null;
  target: number | null;
  weight: number;
  direction: string;
  state: string;
  thresholds: Array<{ level: string; comparator: string; value: number }>;
  latest: { period: string; value: number; score: number; status: string } | null;
}

export interface AuditRow {
  id: string;
  occurred_at: string;
  actor_label: string;
  actor_ip: string | null;
  action: string;
  module: string;
  object_label: string | null;
  severity: string;
  outcome: string;
}
