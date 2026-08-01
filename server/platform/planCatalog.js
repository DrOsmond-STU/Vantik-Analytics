"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.definitionFromRow = definitionFromRow;
exports.resolveCatalog = resolveCatalog;
exports.resolvePlan = resolvePlan;
const featureFlags_ts_1 = require("./featureFlags.js");
const FALLBACK = featureFlags_ts_1.PLAN_CATALOG[0];
/** Baris tabel → definisi paket, dengan bawaan sebagai jaring pengaman per medan. */
function definitionFromRow(row) {
    const seed = featureFlags_ts_1.PLAN_CATALOG.find((plan) => plan.code === row.code);
    let features = {};
    let blob = {};
    try {
        features = JSON.parse(row.features_json);
        blob = JSON.parse(row.quotas_json);
    }
    catch {
        // JSON rusak pada satu baris tidak boleh menjatuhkan seluruh katalog —
        // paket itu jatuh ke bawaan, sisanya tetap terbaca.
        features = {};
        blob = {};
    }
    const resolvedFeatures = {};
    for (const key of featureFlags_ts_1.MODULE_KEYS)
        resolvedFeatures[key] = features[key] === true;
    const resolvedQuotas = {};
    const over = {};
    for (const key of featureFlags_ts_1.QUOTA_KEYS) {
        const value = blob.quotas?.[key];
        resolvedQuotas[key] = typeof value === 'number' ? value : (seed?.quotas[key] ?? 0);
        // Perilaku saat kuota terlampaui TIDAK disunting lewat CMS: itu keputusan yang
        // berdampak pada penagihan, bukan konten.
        over[key] = blob.overBehaviour?.[key] ?? seed?.overBehaviour[key] ?? FALLBACK.overBehaviour[key];
    }
    return {
        code: row.code,
        name: row.name,
        monthlyPrice: row.monthly_price,
        annualPrice: row.annual_price,
        features: resolvedFeatures,
        quotas: resolvedQuotas,
        overBehaviour: over,
        sortOrder: row.sort_order,
    };
}
/**
 * Katalog efektif.
 *
 * `includeUnpublished` memisahkan dua pertanyaan berbeda: "apa yang ditawarkan kepada
 * pengunjung?" dan "paket apa yang masih perlu dihitung?". Paket yang berhenti dijual
 * tetap harus menjawab pertanyaan kedua.
 */
function resolveCatalog(db, includeUnpublished = false) {
    const rows = db.prepare('SELECT * FROM plans').all();
    if (rows.length === 0)
        return [...featureFlags_ts_1.PLAN_CATALOG];
    return rows
        .filter((row) => includeUnpublished || row.published !== 0)
        .map(definitionFromRow)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
}
/** Satu paket menurut katalog efektif; `undefined` bila kodenya tidak dikenal. */
function resolvePlan(db, code) {
    const row = db.prepare('SELECT * FROM plans WHERE code = ?').get(code);
    if (row)
        return definitionFromRow(row);
    return featureFlags_ts_1.PLAN_CATALOG.find((plan) => plan.code === code);
}
//# sourceMappingURL=planCatalog.js.map