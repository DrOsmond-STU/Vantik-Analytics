"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RlsScope = void 0;
exports.loadRlsScope = loadRlsScope;
exports.scopeFromEmbedToken = scopeFromEmbedToken;
/** Cakupan RLS efektif seorang subjek (pengguna + seluruh perannya). */
class RlsScope {
    rules;
    constructor(rules) {
        this.rules = rules;
    }
    static empty() {
        return new RlsScope([]);
    }
    get isUnrestricted() {
        return this.rules.length === 0;
    }
    dimensions() {
        return [...new Set(this.rules.map((r) => r.dimension))];
    }
    /** Aturan untuk satu dimensi; beberapa aturan pada dimensi sama bersifat AND (paling ketat menang). */
    rulesFor(dimension) {
        return this.rules.filter((r) => r.dimension === dimension);
    }
    /**
     * Menguji satu baris data. `row` adalah objek hasil parsing dataset —
     * kunci dimensi dicocokkan case-insensitive karena nama kolom berasal dari
     * berkas unggahan pengguna, bukan skema yang kita kendalikan.
     */
    permits(row) {
        if (this.isUnrestricted)
            return true;
        const lookup = new Map();
        for (const [k, v] of Object.entries(row))
            lookup.set(k.toLowerCase(), v);
        for (const rule of this.rules) {
            const raw = lookup.get(rule.dimension.toLowerCase());
            // Fail secure (SECURITY.md Bagian 2): baris yang tidak memuat kolom dimensi
            // pembatas TIDAK dianggap lolos — akses default ditolak, bukan diizinkan.
            if (raw === undefined || raw === null)
                return false;
            const value = String(raw);
            const inList = rule.values.some((v) => v.toLowerCase() === value.toLowerCase());
            if (rule.operator === 'in' && !inList)
                return false;
            if (rule.operator === 'not_in' && inList)
                return false;
        }
        return true;
    }
    /** Memfilter kumpulan baris. Selalu dipanggil di sisi server sebelum respons dibentuk. */
    filter(rows) {
        if (this.isUnrestricted)
            return rows;
        return rows.filter((r) => this.permits(r));
    }
    /**
     * Fragmen SQL untuk kolom dimensi yang tersimpan sebagai kolom nyata
     * (mis. `kpi_score_history.dimension_key`).
     */
    sqlFragment(column) {
        if (this.isUnrestricted)
            return null;
        const clauses = [];
        const params = [];
        for (const rule of this.rules) {
            if (rule.values.length === 0) {
                clauses.push('0 = 1');
                continue;
            }
            const placeholders = rule.values.map(() => '?').join(', ');
            clauses.push(rule.operator === 'in'
                ? `(${column} IN (${placeholders}))`
                : `(${column} IS NULL OR ${column} NOT IN (${placeholders}))`);
            params.push(...rule.values);
        }
        return { sql: clauses.join(' AND '), params };
    }
    toJSON() {
        return [...this.rules];
    }
}
exports.RlsScope = RlsScope;
/**
 * Memuat cakupan RLS efektif: aturan yang melekat pada pengguna DAN pada seluruh
 * perannya digabung. Beberapa aturan bersifat AND — pembatasan paling ketat menang,
 * konsisten dengan prinsip least privilege (SECURITY.md Bagian 2).
 */
function loadRlsScope(db, userId, roleIds) {
    const subjects = [['user', userId]];
    for (const roleId of roleIds)
        subjects.push(['role', roleId]);
    const rules = [];
    for (const [type, id] of subjects) {
        const rows = db.all('rls_rules', { subject_type: type, subject_id: id });
        for (const row of rows) {
            rules.push({
                dimension: row.dimension,
                operator: row.operator === 'not_in' ? 'not_in' : 'in',
                values: JSON.parse(row.values_json),
            });
        }
    }
    return new RlsScope(rules);
}
/**
 * Cakupan RLS yang diwariskan token sematan (PRD 6.21, SECURITY.md Bagian 15).
 * Dievaluasi ULANG di server tiap permintaan, tidak pernah diambil dari query string.
 */
function scopeFromEmbedToken(rlsScopeJson) {
    const parsed = JSON.parse(rlsScopeJson);
    return new RlsScope(parsed.map((r) => ({
        dimension: r.dimension,
        operator: r.operator === 'not_in' ? 'not_in' : 'in',
        values: r.values ?? [],
    })));
}
//# sourceMappingURL=rls.js.map