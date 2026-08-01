"use strict";
/**
 * Feature flag & kuota per tenant.
 *
 * ARCHITECTURE.md Bagian 11 / PRD 2.1 & 6.27:
 *   "Feature flag per tenant, bukan basis kode per paket — satu basis kode melayani
 *    seluruh paket langganan."
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FeatureFlags = exports.PLAN_BY_CODE = exports.PLAN_CATALOG = exports.BILLING_CYCLE_BY_CODE = exports.BILLING_CYCLES = exports.MODULE_KEYS = void 0;
exports.isBillingCycle = isBillingCycle;
exports.cycleMonths = cycleMonths;
exports.planPrice = planPrice;
exports.planPrices = planPrices;
/** Kunci modul mengikuti penamaan modul PRD Bagian 6 (BRAND.md Bagian 7: tidak diterjemahkan). */
exports.MODULE_KEYS = [
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
];
exports.BILLING_CYCLES = [
    { code: 'monthly', months: 1, discount: 0, sortOrder: 1 },
    { code: 'quarterly', months: 3, discount: 0.05, sortOrder: 2 },
    { code: 'semiannual', months: 6, discount: 0.1, sortOrder: 3 },
    { code: 'annual', months: 12, discount: 1 / 6, sortOrder: 4 },
];
exports.BILLING_CYCLE_BY_CODE = new Map(exports.BILLING_CYCLES.map((c) => [c.code, c]));
/**
 * Penjaga tipe untuk masukan dari luar.
 *
 * Rute publik menerima siklus dari pengunjung yang belum masuk; nilai yang tidak dikenal
 * DITOLAK alih-alih diam-diam dijadikan `monthly`, karena "diam-diam dijadikan bulanan"
 * berarti pengunjung yang mengira membeli setahun mendapat sebulan.
 */
function isBillingCycle(value) {
    return typeof value === 'string' && exports.BILLING_CYCLE_BY_CODE.has(value);
}
function cycleMonths(cycle) {
    return exports.BILLING_CYCLE_BY_CODE.get(cycle)?.months ?? 1;
}
function featureSet(enabled) {
    const out = {};
    for (const key of exports.MODULE_KEYS)
        out[key] = false;
    for (const key of enabled)
        out[key] = true;
    return out;
}
/** Modul dasar: selalu tersedia di semua paket — tanpa ini platform tidak berfungsi. */
const CORE_MODULES = [
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
const PROFESSIONAL_EXTRA = [
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
const ENTERPRISE_EXTRA = [
    'balanced_scorecard',
    'root_cause_analysis',
    'ai_narrative_report',
    'digital_twin',
];
/**
 * Struktur paket indikatif — PRD 2.1. Angka final ditetapkan tim bisnis
 * (PRD Bagian 12 Pertanyaan Terbuka: harga & diskon tahunan belum ditetapkan).
 */
exports.PLAN_CATALOG = [
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
exports.PLAN_BY_CODE = new Map(exports.PLAN_CATALOG.map((p) => [p.code, p]));
/**
 * Harga satu paket untuk satu siklus, dalam rupiah penuh.
 *
 * SATU-SATUNYA tempat harga siklus dihitung. Pratinjau perubahan paket, faktur
 * konversi uji coba, faktur perpanjangan, dan katalog publik semuanya memanggil fungsi
 * ini — sehingga angka yang dilihat pengunjung di halaman depan dan angka yang tercetak
 * di faktur berasal dari perhitungan yang sama, bukan dari dua rumus yang kebetulan
 * mirip.
 */
function planPrice(plan, cycle) {
    const definition = exports.BILLING_CYCLE_BY_CODE.get(cycle) ?? exports.BILLING_CYCLE_BY_CODE.get('monthly');
    return Math.round(plan.monthlyPrice * definition.months * (1 - definition.discount));
}
/** Harga seluruh siklus untuk satu paket — bentuk yang dipakai katalog publik. */
function planPrices(plan) {
    const out = {};
    for (const cycle of exports.BILLING_CYCLES)
        out[cycle.code] = planPrice(plan, cycle.code);
    return out;
}
/** Feature flag efektif satu tenant. */
class FeatureFlags {
    plan;
    overrides;
    readOnly;
    readOnlyReason;
    expiresAt;
    constructor(plan, 
    /** Override per tenant (mis. Digital Twin dimatikan untuk organisasi tanpa aset fisik — PRD 6.17). */
    overrides = {}, 
    /** Tenant read-only saat tunggakan — SECURITY.md 16.4 */
    readOnly = false, readOnlyReason = null, 
    /** Batas masa berlaku langganan berjalan, bila ada. */
    expiresAt = null) {
        this.plan = plan;
        this.overrides = overrides;
        this.readOnly = readOnly;
        this.readOnlyReason = readOnlyReason;
        this.expiresAt = expiresAt;
    }
    isEnabled(module) {
        return this.overrides[module] ?? this.plan.features[module] ?? false;
    }
    enabledModules() {
        return exports.MODULE_KEYS.filter((m) => this.isEnabled(m));
    }
    quota(key) {
        return this.plan.quotas[key];
    }
    overBehaviour(key) {
        return this.plan.overBehaviour[key];
    }
    get planCode() {
        return this.plan.code;
    }
    toJSON() {
        const modules = {};
        for (const m of exports.MODULE_KEYS)
            modules[m] = this.isEnabled(m);
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
exports.FeatureFlags = FeatureFlags;
//# sourceMappingURL=featureFlags.js.map