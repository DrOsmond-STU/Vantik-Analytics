/**
 * Feature flag & kuota per tenant.
 *
 * ARCHITECTURE.md Bagian 11 / PRD 2.1 & 6.27:
 *   "Feature flag per tenant, bukan basis kode per paket — satu basis kode melayani
 *    seluruh paket langganan."
 */

/** Kunci modul mengikuti penamaan modul PRD Bagian 6 (BRAND.md Bagian 7: tidak diterjemahkan). */
export const MODULE_KEYS = [
  'executive_cockpit',
  'operational_cockpit',
  'balanced_scorecard',
  'dashboard_designer',
  'report_designer',
  'interactive_visualization',
  'embed_dashboard',
  'ai_analytics',
  'forecast_analytics',
  'root_cause_analysis',
  'data_discovery',
  'ai_narrative_report',
  'descriptive_statistics',
  'hypothesis_testing',
  'regression_correlation',
  'dataset',
  'external_connection',
  'data_modeling',
  'data_quality_center',
  'kpi_center',
  'alert_center',
  'digital_twin',
  'employee_master',
  'user_authorization',
  'activity_log',
  'device_management',
  'tenant_management',
  'subscription_management',
  'billing_invoice',
  'usage_metering',
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

export type QuotaKey =
  | 'users'
  | 'datasets'
  | 'storage_mb'
  | 'connections'
  | 'embed_tokens'
  | 'ai_calls_monthly';

/**
 * Siklus berlangganan yang ditawarkan (PRD 6.27).
 *
 * Dimodelkan sebagai KATALOG, bukan sepasang harga `monthlyPrice`/`annualPrice`, karena
 * setiap siklus baru yang ditambahkan sebagai pasangan harga menuntut perubahan di
 * setiap tempat yang menghitung harga — dan tempat yang terlewat diam-diam menagih
 * angka yang salah. Dengan katalog, satu baris di sini menambah pilihan di seluruh
 * sistem: halaman depan, pendaftaran, pratinjau perubahan paket, dan faktur.
 *
 * `discount` adalah potongan dibanding membayar bulanan selama jumlah bulan yang sama.
 * Angkanya indikatif — PRD Bagian 12 menyatakan harga & diskon final ditetapkan tim
 * bisnis. Diskon tahunan 1/6 dipilih agar `planPrice(plan, 'annual')` menghasilkan
 * PERSIS `plan.annualPrice` yang sudah tercantum di katalog paket (dua bulan gratis);
 * invarian itu diuji, sehingga katalog dan kalkulator tidak dapat menyimpang diam-diam.
 */
export type BillingCycle = 'monthly' | 'quarterly' | 'semiannual' | 'annual';

export interface BillingCycleDefinition {
  code: BillingCycle;
  months: number;
  discount: number;
  sortOrder: number;
}

export const BILLING_CYCLES: readonly BillingCycleDefinition[] = [
  { code: 'monthly', months: 1, discount: 0, sortOrder: 1 },
  { code: 'quarterly', months: 3, discount: 0.05, sortOrder: 2 },
  { code: 'semiannual', months: 6, discount: 0.1, sortOrder: 3 },
  { code: 'annual', months: 12, discount: 1 / 6, sortOrder: 4 },
];

export const BILLING_CYCLE_BY_CODE = new Map(BILLING_CYCLES.map((c) => [c.code, c]));

/**
 * Penjaga tipe untuk masukan dari luar.
 *
 * Rute publik menerima siklus dari pengunjung yang belum masuk; nilai yang tidak dikenal
 * DITOLAK alih-alih diam-diam dijadikan `monthly`, karena "diam-diam dijadikan bulanan"
 * berarti pengunjung yang mengira membeli setahun mendapat sebulan.
 */
export function isBillingCycle(value: unknown): value is BillingCycle {
  return typeof value === 'string' && BILLING_CYCLE_BY_CODE.has(value as BillingCycle);
}

export function cycleMonths(cycle: string): number {
  return BILLING_CYCLE_BY_CODE.get(cycle as BillingCycle)?.months ?? 1;
}

export interface PlanDefinition {
  code: string;
  name: string;
  monthlyPrice: number;
  annualPrice: number;
  features: Record<ModuleKey, boolean>;
  quotas: Record<QuotaKey, number>;
  /** Perilaku saat kuota terlampaui — dikonfigurasi eksplisit & diberitahukan di muka (PRD 6.29). */
  overBehaviour: Record<QuotaKey, 'block' | 'overage'>;
  sortOrder: number;
}

function featureSet(enabled: ModuleKey[]): Record<ModuleKey, boolean> {
  const out = {} as Record<ModuleKey, boolean>;
  for (const key of MODULE_KEYS) out[key] = false;
  for (const key of enabled) out[key] = true;
  return out;
}

/** Modul dasar: selalu tersedia di semua paket — tanpa ini platform tidak berfungsi. */
const CORE_MODULES: ModuleKey[] = [
  'dataset',
  'data_modeling',
  'data_quality_center',
  'dashboard_designer',
  'report_designer',
  'interactive_visualization',
  'employee_master',
  'user_authorization',
  'activity_log',
  'device_management',
  'tenant_management',
  'subscription_management',
  'billing_invoice',
  'usage_metering',
  'kpi_center',
  'alert_center',
  'operational_cockpit',
];

const PROFESSIONAL_EXTRA: ModuleKey[] = [
  'external_connection',
  'ai_analytics',
  'forecast_analytics',
  'data_discovery',
  'descriptive_statistics',
  'hypothesis_testing',
  'regression_correlation',
  'executive_cockpit',
  'embed_dashboard',
];

const ENTERPRISE_EXTRA: ModuleKey[] = [
  'balanced_scorecard',
  'root_cause_analysis',
  'ai_narrative_report',
  'digital_twin',
];

/**
 * Struktur paket indikatif — PRD 2.1. Angka final ditetapkan tim bisnis
 * (PRD Bagian 12 Pertanyaan Terbuka: harga & diskon tahunan belum ditetapkan).
 */
export const PLAN_CATALOG: readonly PlanDefinition[] = [
  {
    code: 'starter',
    name: 'Starter',
    monthlyPrice: 0,
    annualPrice: 0,
    features: featureSet(CORE_MODULES),
    quotas: {
      users: 10,
      datasets: 25,
      storage_mb: 2_048,
      connections: 0,
      embed_tokens: 0,
      ai_calls_monthly: 0,
    },
    overBehaviour: {
      users: 'block',
      datasets: 'block',
      storage_mb: 'block',
      connections: 'block',
      embed_tokens: 'block',
      ai_calls_monthly: 'block',
    },
    sortOrder: 1,
  },
  {
    code: 'professional',
    name: 'Professional',
    monthlyPrice: 4_500_000,
    annualPrice: 45_000_000,
    features: featureSet([...CORE_MODULES, ...PROFESSIONAL_EXTRA]),
    quotas: {
      users: 100,
      datasets: 300,
      storage_mb: 51_200,
      connections: 15,
      embed_tokens: 10,
      ai_calls_monthly: 5_000,
    },
    overBehaviour: {
      users: 'block',
      datasets: 'overage',
      storage_mb: 'overage',
      connections: 'block',
      embed_tokens: 'block',
      // Metering AI dihitung & ditagih terpisah karena biayanya bergantung
      // penyedia LLM eksternal (PRD 6.29).
      ai_calls_monthly: 'overage',
    },
    sortOrder: 2,
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    monthlyPrice: 18_000_000,
    annualPrice: 180_000_000,
    features: featureSet([...CORE_MODULES, ...PROFESSIONAL_EXTRA, ...ENTERPRISE_EXTRA]),
    quotas: {
      users: -1, // -1 = tidak dibatasi / sesuai kontrak
      datasets: -1,
      storage_mb: -1,
      connections: -1,
      embed_tokens: -1,
      ai_calls_monthly: 100_000,
    },
    overBehaviour: {
      users: 'overage',
      datasets: 'overage',
      storage_mb: 'overage',
      connections: 'overage',
      embed_tokens: 'overage',
      ai_calls_monthly: 'overage',
    },
    sortOrder: 3,
  },
];

export const PLAN_BY_CODE = new Map(PLAN_CATALOG.map((p) => [p.code, p]));

/**
 * Harga satu paket untuk satu siklus, dalam rupiah penuh.
 *
 * SATU-SATUNYA tempat harga siklus dihitung. Pratinjau perubahan paket, faktur
 * konversi uji coba, faktur perpanjangan, dan katalog publik semuanya memanggil fungsi
 * ini — sehingga angka yang dilihat pengunjung di halaman depan dan angka yang tercetak
 * di faktur berasal dari perhitungan yang sama, bukan dari dua rumus yang kebetulan
 * mirip.
 */
export function planPrice(plan: PlanDefinition, cycle: string): number {
  const definition = BILLING_CYCLE_BY_CODE.get(cycle as BillingCycle) ?? BILLING_CYCLE_BY_CODE.get('monthly')!;
  return Math.round(plan.monthlyPrice * definition.months * (1 - definition.discount));
}

/** Harga seluruh siklus untuk satu paket — bentuk yang dipakai katalog publik. */
export function planPrices(plan: PlanDefinition): Record<BillingCycle, number> {
  const out = {} as Record<BillingCycle, number>;
  for (const cycle of BILLING_CYCLES) out[cycle.code] = planPrice(plan, cycle.code);
  return out;
}

/**
 * Mengapa tenant tidak boleh menulis.
 *
 * Dibedakan karena LANGKAH PEMULIHANNYA berbeda: masa berlaku habis diselesaikan
 * pelanggan sendiri dengan memperpanjang, sedangkan suspensi oleh operator tidak.
 * Pesan "akses ditolak" yang sama untuk keduanya membuat pelanggan menunggu bantuan
 * padahal tombol perpanjang ada di layarnya (SECURITY.md 17.4).
 */
export type ReadOnlyReason = 'subscription_unpaid' | 'subscription_expired' | 'tenant_status' | null;

/**
 * Lama uji coba gratis untuk tenant baru, dalam HARI. `0` mematikannya.
 *
 * Bawaannya NOL — tidak ada uji coba gratis. Itu keputusan komersial, dan disebutkan di
 * sini karena kebalikannya mudah menjadi kerugian yang tidak terlihat: pendaftaran mandiri
 * yang menghadiahkan masa pakai penuh membuat satu orang dapat memakai platform tanpa
 * batas hanya dengan mendaftar ulang memakai alamat email baru. Persetujuan admin memang
 * menahannya, tetapi itu memindahkan beban ke manusia yang harus menebak mana pendaftar
 * sungguhan — dan menebak setiap hari.
 *
 * Operator yang MEMANG ingin menawarkan uji coba mengisi `VANTIK_TRIAL_DAYS`. Pemanggil
 * yang menyebut `trialDays` secara eksplisit (seed data contoh, alat operator) tidak
 * terpengaruh nilai ini.
 */
export const DEFAULT_TRIAL_DAYS = 0;

export function resolveTrialDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.VANTIK_TRIAL_DAYS ?? '').trim();
  if (raw === '') return DEFAULT_TRIAL_DAYS;
  const parsed = Number(raw);
  // Nilai yang tidak dapat dibaca sebagai angka non-negatif DIABAIKAN, bukan menjadi NaN
  // hari: salah ketik di `.env` tidak boleh berarti "uji coba selama NaN".
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_TRIAL_DAYS;
  return Math.floor(parsed);
}

/** Feature flag efektif satu tenant. */
export class FeatureFlags {
  constructor(
    private readonly plan: PlanDefinition,
    /** Override per tenant (mis. Digital Twin dimatikan untuk organisasi tanpa aset fisik — PRD 6.17). */
    private readonly overrides: Partial<Record<ModuleKey, boolean>> = {},
    /** Tenant read-only saat tunggakan — SECURITY.md 16.4 */
    readonly readOnly = false,
    readonly readOnlyReason: ReadOnlyReason = null,
    /** Batas masa berlaku langganan berjalan, bila ada. */
    readonly expiresAt: string | null = null,
  ) {}

  isEnabled(module: ModuleKey): boolean {
    return this.overrides[module] ?? this.plan.features[module] ?? false;
  }

  enabledModules(): ModuleKey[] {
    return MODULE_KEYS.filter((m) => this.isEnabled(m));
  }

  quota(key: QuotaKey): number {
    return this.plan.quotas[key];
  }

  overBehaviour(key: QuotaKey): 'block' | 'overage' {
    return this.plan.overBehaviour[key];
  }

  get planCode(): string {
    return this.plan.code;
  }

  toJSON(): {
    plan: string;
    readOnly: boolean;
    readOnlyReason: ReadOnlyReason;
    expiresAt: string | null;
    modules: Record<string, boolean>;
    quotas: Record<string, number>;
  } {
    const modules: Record<string, boolean> = {};
    for (const m of MODULE_KEYS) modules[m] = this.isEnabled(m);
    return {
      plan: this.plan.code,
      readOnly: this.readOnly,
      readOnlyReason: this.readOnlyReason,
      expiresAt: this.expiresAt,
      modules,
      quotas: { ...this.plan.quotas },
    };
  }
}
