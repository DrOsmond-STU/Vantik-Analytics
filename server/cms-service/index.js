"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolvePlan = exports.resolveCatalog = exports.EDITABLE_CONTENT_KEYS = void 0;
exports.contentOverrides = contentOverrides;
exports.allContentOverrides = allContentOverrides;
exports.setContent = setContent;
exports.upsertPlan = upsertPlan;
exports.deletePlan = deletePlan;
exports.catalogForEditing = catalogForEditing;
const planCatalog_ts_1 = require("../platform/planCatalog.js");
Object.defineProperty(exports, "resolveCatalog", { enumerable: true, get: function () { return planCatalog_ts_1.resolveCatalog; } });
Object.defineProperty(exports, "resolvePlan", { enumerable: true, get: function () { return planCatalog_ts_1.resolvePlan; } });
const errors_ts_1 = require("../platform/errors.js");
const featureFlags_ts_1 = require("../platform/featureFlags.js");
const LOCALES = ['id', 'en'];
/**
 * Kunci konten yang boleh disunting.
 *
 * Daftar-IZIN, bukan daftar-tolak. Kalau operator boleh menulis kunci apa pun, ia dapat
 * menimpa label tombol, pesan kesalahan, dan nama modul — teks yang diandalkan pengujian
 * dan yang menurut BRAND.md tidak diterjemahkan sama sekali. Kunci baru masuk ke sini
 * dengan sengaja, bukan karena kebetulan ada di kamus.
 */
exports.EDITABLE_CONTENT_KEYS = [
    'ui.landing_eyebrow',
    'ui.landing_headline',
    'ui.landing_sub',
    'ui.landing_trial_note',
    'ui.landing_stat_modules',
    'ui.landing_stat_domains',
    'ui.landing_stat_locales',
    'ui.landing_stat_tenancy',
    'ui.landing_modules_eyebrow',
    'ui.landing_modules_title',
    'ui.landing_modules_sub',
    'ui.landing_why_eyebrow',
    'ui.landing_why_title',
    'ui.landing_why_1_title',
    'ui.landing_why_1_body',
    'ui.landing_why_2_title',
    'ui.landing_why_2_body',
    'ui.landing_why_3_title',
    'ui.landing_why_3_body',
    'ui.landing_why_4_title',
    'ui.landing_why_4_body',
    'ui.landing_plans_eyebrow',
    'ui.landing_plans_title',
    'ui.landing_plans_sub',
    'ui.landing_cta_title',
    'ui.landing_cta_sub',
    'ui.tagline',
];
const EDITABLE = new Set(exports.EDITABLE_CONTENT_KEYS);
/** Batas panjang. Teks halaman depan bukan tempat menyimpan dokumen. */
const MAX_VALUE_LENGTH = 2_000;
function isLocale(value) {
    return LOCALES.includes(value);
}
/* ============================== Konten ============================== */
/**
 * Penimpaan konten untuk satu bahasa.
 *
 * Mengembalikan HANYA yang disunting. Pemanggil di sisi klien menggabungkannya di atas
 * kamus (`cms[key] ?? t(key)`), sehingga kunci yang belum pernah disentuh operator
 * otomatis ikut terbarui ketika rilis berikutnya memperbaiki kalimatnya.
 */
function contentOverrides(db, locale) {
    if (!isLocale(locale))
        return {};
    const rows = db
        .prepare('SELECT content_key, value FROM site_content WHERE locale = ?')
        .all(locale);
    const out = {};
    // Kunci yang sudah dicabut dari daftar-izin (mis. setelah halaman diubah) sengaja
    // TIDAK disajikan, meski barisnya masih ada — daftar-izin berlaku saat baca juga,
    // bukan hanya saat tulis.
    for (const row of rows)
        if (EDITABLE.has(row.content_key))
            out[row.content_key] = row.value;
    return out;
}
/** Seluruh penimpaan, kedua bahasa — untuk antarmuka penyuntingan. */
function allContentOverrides(db) {
    return { id: contentOverrides(db, 'id'), en: contentOverrides(db, 'en') };
}
function setContent(db, key, locale, value, actor) {
    if (!EDITABLE.has(key))
        throw new errors_ts_1.ValidationError('error.content_key_not_editable', { key });
    if (!isLocale(locale))
        throw new errors_ts_1.ValidationError('error.locale_unknown', { locale });
    const trimmed = value.trim();
    if (trimmed.length > MAX_VALUE_LENGTH) {
        throw new errors_ts_1.ValidationError('error.content_too_long', { max: MAX_VALUE_LENGTH });
    }
    // Mengosongkan berarti KEMBALI KE BAWAAN, bukan menampilkan halaman depan yang kosong.
    // Itu satu-satunya cara membatalkan suntingan tanpa harus mengetik ulang teks aslinya —
    // yang operator tidak punya salinannya.
    if (trimmed === '') {
        db.prepare('DELETE FROM site_content WHERE content_key = ? AND locale = ?').run(key, locale);
        return;
    }
    db.prepare(`INSERT INTO site_content (content_key, locale, value, updated_at, updated_by)
     VALUES (?,?,?,?,?)
     ON CONFLICT(content_key, locale) DO UPDATE SET
       value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`).run(key, locale, trimmed, new Date().toISOString(), actor);
}
/* =========================== Katalog paket =========================== */
function upsertPlan(db, input, actor) {
    if (!/^[a-z][a-z0-9_-]{1,30}$/.test(input.code)) {
        throw new errors_ts_1.ValidationError('error.plan_code_invalid');
    }
    if (input.name.trim() === '')
        throw new errors_ts_1.ValidationError('error.plan_name_required');
    for (const price of [input.monthlyPrice, input.annualPrice]) {
        if (!Number.isFinite(price) || price < 0 || !Number.isInteger(price)) {
            throw new errors_ts_1.ValidationError('error.plan_price_invalid');
        }
    }
    const unknown = input.modules.filter((m) => !featureFlags_ts_1.MODULE_KEYS.includes(m));
    if (unknown.length > 0)
        throw new errors_ts_1.ValidationError('error.plan_module_unknown', { modules: unknown.join(', ') });
    const features = {};
    for (const key of featureFlags_ts_1.MODULE_KEYS)
        features[key] = input.modules.includes(key);
    const seed = featureFlags_ts_1.PLAN_CATALOG.find((plan) => plan.code === input.code);
    const quotas = {};
    for (const key of featureFlags_ts_1.QUOTA_KEYS) {
        const value = input.quotas?.[key];
        quotas[key] = typeof value === 'number' && Number.isFinite(value) ? value : (seed?.quotas[key] ?? 0);
    }
    const overBehaviour = seed?.overBehaviour ?? featureFlags_ts_1.PLAN_CATALOG[0].overBehaviour;
    db.prepare(`INSERT INTO plans (code, name, monthly_price, annual_price, features_json, quotas_json,
                        description, sort_order, published, updated_at, updated_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(code) DO UPDATE SET
       name = excluded.name, monthly_price = excluded.monthly_price,
       annual_price = excluded.annual_price, features_json = excluded.features_json,
       quotas_json = excluded.quotas_json, description = excluded.description,
       sort_order = excluded.sort_order, published = excluded.published,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`).run(input.code, input.name.trim(), input.monthlyPrice, input.annualPrice, JSON.stringify(features), JSON.stringify({ quotas, overBehaviour }), input.description?.trim() || null, input.sortOrder ?? 100, input.published === false ? 0 : 1, new Date().toISOString(), actor);
}
/**
 * Menarik paket dari katalog.
 *
 * Ditolak bila masih ada langganan yang memakainya — termasuk yang sudah `past_due`.
 * Paket yang hilang di tengah masa berlangganan membuat hak akses pelanggan tidak dapat
 * dihitung lagi, dan itu kerusakan yang jauh lebih mahal daripada satu baris katalog yang
 * terlihat usang. Untuk berhenti menjualnya, pakai `published = false`: paket hilang dari
 * halaman depan tetapi tetap dapat dihitung untuk yang sudah memakainya.
 */
function deletePlan(db, code) {
    const row = db.prepare('SELECT code FROM plans WHERE code = ?').get(code);
    if (!row)
        throw new errors_ts_1.NotFoundError('error.plan_unknown');
    const used = db
        .prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE plan_code = ? AND status <> 'cancelled'")
        .get(code);
    if (used.n > 0)
        throw new errors_ts_1.ConflictError('error.plan_in_use', { count: String(used.n) });
    db.prepare('DELETE FROM plans WHERE code = ?').run(code);
}
/** Bentuk baris untuk antarmuka penyuntingan — termasuk yang belum diterbitkan. */
function catalogForEditing(db) {
    const rows = db.prepare('SELECT * FROM plans').all();
    return rows
        .map((row) => ({
        ...(0, planCatalog_ts_1.definitionFromRow)(row),
        published: row.published !== 0,
        description: row.description,
    }))
        .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
}
//# sourceMappingURL=index.js.map