"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlatformOperatorDb = exports.TenantScopedDb = exports.GLOBAL_TABLES = exports.TENANT_SCOPED_TABLES = void 0;
exports.extractTables = extractTables;
const db_ts_1 = require("./db.js");
/**
 * Tabel yang membawa data pelanggan dan WAJIB difilter per tenant.
 * Menambah tabel baru ber-tenant tanpa mendaftarkannya di sini akan tertangkap oleh
 * uji `TC-TEN-04` (lihat tests/tenancy.test.ts).
 */
exports.TENANT_SCOPED_TABLES = new Set([
    'subscriptions',
    'invoices',
    'usage_events',
    'employee_master',
    'system_user',
    'role_assignment',
    'rls_rules',
    'device_bindings',
    'active_sessions',
    'device_transfer_requests',
    'mfa_recovery_codes',
    'mfa_challenges',
    'notification_outbox',
    'dataset_catalog',
    'dataset_columns',
    'dataset_rows',
    'external_connections',
    'connection_sync_runs',
    'model_tables',
    'model_fields',
    'data_lineage',
    'business_dictionary',
    'dq_runs',
    'kpi_definition',
    'kpi_threshold',
    'kpi_score_history',
    'kpi_approvals',
    'alert_rules',
    'alert_events',
    'alert_deliveries',
    'dashboards',
    'dashboard_versions',
    'reports',
    'embed_tokens',
    'ai_queries',
    'forecast_runs',
    'rca_records',
    'narrative_reports',
    'stat_analyses',
    'asset_zones',
    'assets',
    'sensor_definitions',
    'sensor_readings',
    'failure_predictions',
    'maintenance_tickets',
    'bsc_perspectives',
    'bsc_objectives',
    'connection_secrets',
]);
/** Tabel global yang memang tidak ber-tenant (katalog paket, peran standar, dsb.). */
exports.GLOBAL_TABLES = new Set([
    'plans',
    'tenants',
    'roles',
    'login_attempts',
    'audit_log',
    'audit_log_archive',
    'embed_requests',
    'schema_migrations',
]);
function identifier(name) {
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) {
        throw new Error(`Unsafe SQL identifier: ${name}`);
    }
    return name;
}
function buildWhere(where, params) {
    if (!where)
        return '';
    const parts = [];
    for (const [rawCol, condition] of Object.entries(where)) {
        const col = identifier(rawCol);
        if (condition !== null && typeof condition === 'object' && !Buffer.isBuffer(condition)) {
            if ('in' in condition) {
                if (condition.in.length === 0) {
                    parts.push('0 = 1');
                    continue;
                }
                parts.push(`${col} IN (${condition.in.map(() => '?').join(', ')})`);
                params.push(...condition.in);
            }
            else if ('like' in condition) {
                parts.push(`${col} LIKE ?`);
                params.push(condition.like);
            }
            else if ('gte' in condition) {
                parts.push(`${col} >= ?`);
                params.push(condition.gte);
            }
            else if ('lte' in condition) {
                parts.push(`${col} <= ?`);
                params.push(condition.lte);
            }
            else if ('not' in condition) {
                parts.push(condition.not === null ? `${col} IS NOT NULL` : `${col} <> ?`);
                if (condition.not !== null)
                    params.push(condition.not);
            }
        }
        else if (condition === null) {
            parts.push(`${col} IS NULL`);
        }
        else {
            parts.push(`${col} = ?`);
            params.push(condition);
        }
    }
    return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
}
/**
 * Akses basis data yang terikat pada satu tenant.
 *
 * `tenantId` bersifat readonly dan hanya dapat diisi oleh `platform/context.ts` dari
 * sesi terverifikasi — tidak ada setter publik.
 */
class TenantScopedDb {
    db;
    tenantId;
    constructor(db, tenantId) {
        this.db = db;
        this.tenantId = tenantId;
        if (!tenantId) {
            // Fail secure (SECURITY.md Bagian 2): tanpa konteks tenant, akses ditolak —
            // bukan diperlakukan sebagai "semua tenant".
            throw new Error('TenantScopedDb requires a verified tenant id');
        }
    }
    assertScoped(table) {
        const bare = table.includes('.') ? table.split('.').pop() : table;
        if (!exports.TENANT_SCOPED_TABLES.has(bare)) {
            throw new Error(`Table "${table}" is not registered as tenant-scoped. ` +
                'Register it in TENANT_SCOPED_TABLES or use globalRead() for genuinely global tables.');
        }
    }
    all(table, where, options = {}) {
        this.assertScoped(table);
        const params = [this.tenantId];
        let sql = `SELECT * FROM ${identifier(table)} WHERE tenant_id = ?`;
        const extra = buildWhere(where, params);
        if (extra)
            sql += ` AND ${extra.slice(' WHERE '.length)}`;
        if (options.orderBy)
            sql += ` ORDER BY ${identifier(options.orderBy.split(' ')[0])}${/ DESC$/i.test(options.orderBy) ? ' DESC' : ''}`;
        if (options.limit !== undefined)
            sql += ` LIMIT ${Number(options.limit)}`;
        if (options.offset !== undefined)
            sql += ` OFFSET ${Number(options.offset)}`;
        return this.db.prepare(sql).all(...params);
    }
    get(table, where) {
        return this.all(table, where, { limit: 1 })[0];
    }
    count(table, where) {
        this.assertScoped(table);
        const params = [this.tenantId];
        let sql = `SELECT COUNT(*) AS n FROM ${identifier(table)} WHERE tenant_id = ?`;
        const extra = buildWhere(where, params);
        if (extra)
            sql += ` AND ${extra.slice(' WHERE '.length)}`;
        return this.db.prepare(sql).get(...params).n;
    }
    insert(table, values) {
        this.assertScoped(table);
        // tenant_id selalu ditimpa dengan konteks sesi — nilai apa pun yang dikirim
        // pemanggil diabaikan (ARCHITECTURE.md 5.1).
        const row = { ...values, tenant_id: this.tenantId };
        const cols = Object.keys(row).map(identifier);
        const sql = `INSERT INTO ${identifier(table)} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
        this.db.prepare(sql).run(...Object.values(row));
        return row;
    }
    update(table, where, values) {
        this.assertScoped(table);
        const { tenant_id: _ignored, ...safe } = values;
        const setCols = Object.keys(safe).map(identifier);
        if (setCols.length === 0)
            return 0;
        const params = [...Object.values(safe), this.tenantId];
        let sql = `UPDATE ${identifier(table)} SET ${setCols.map((c) => `${c} = ?`).join(', ')} WHERE tenant_id = ?`;
        const extra = buildWhere(where, params);
        if (extra)
            sql += ` AND ${extra.slice(' WHERE '.length)}`;
        return this.db.prepare(sql).run(...params).changes;
    }
    delete(table, where) {
        this.assertScoped(table);
        const params = [this.tenantId];
        let sql = `DELETE FROM ${identifier(table)} WHERE tenant_id = ?`;
        const extra = buildWhere(where, params);
        if (extra)
            sql += ` AND ${extra.slice(' WHERE '.length)}`;
        return this.db.prepare(sql).run(...params).changes;
    }
    /**
     * Jalan keluar untuk kueri kompleks (JOIN, agregasi).
     *
     * SQL WAJIB memakai placeholder bernama `:tenant_id` untuk setiap tabel ber-tenant
     * yang disentuh. Bila tidak, kueri ditolak sebelum dieksekusi — inilah yang membuat
     * "lupa memfilter" menjadi kegagalan yang terlihat saat pengembangan, bukan kebocoran
     * senyap di production.
     */
    raw(sql, params = {}) {
        this.assertRawIsScoped(sql);
        return this.db.prepare(sql).all({ ...params, tenant_id: this.tenantId });
    }
    rawOne(sql, params = {}) {
        this.assertRawIsScoped(sql);
        return this.db.prepare(sql).get({ ...params, tenant_id: this.tenantId });
    }
    rawRun(sql, params = {}) {
        this.assertRawIsScoped(sql);
        return this.db.prepare(sql).run({ ...params, tenant_id: this.tenantId }).changes;
    }
    assertRawIsScoped(sql) {
        const touched = extractTables(sql);
        const scoped = touched.filter((t) => exports.TENANT_SCOPED_TABLES.has(t));
        if (scoped.length === 0)
            return;
        // INSERT ke tabel ber-tenant: `tenant_id` wajib termasuk kolom yang ditulis DAN
        // nilainya wajib placeholder `:tenant_id` — sehingga nilai yang benar-benar
        // tersimpan selalu berasal dari konteks sesi, bukan dari pemanggil.
        if (/^\s*insert\s+/i.test(sql)) {
            const columnList = /insert\s+(?:or\s+\w+\s+)?into\s+[A-Za-z_][A-Za-z0-9_.]*\s*\(([^)]*)\)/i.exec(sql);
            const writesTenantColumn = columnList
                ? columnList[1].split(',').some((c) => c.trim().toLowerCase() === 'tenant_id')
                : false;
            if (!writesTenantColumn || !/:tenant_id\b/.test(sql)) {
                throw new Error(`Raw INSERT touches tenant-scoped tables [${scoped.join(', ')}] without binding ` +
                    '`tenant_id` to `:tenant_id`. Refused (SECURITY.md 16.1).');
            }
            // Klausa ON CONFLICT ... DO UPDATE tidak boleh menulis ulang tenant_id.
            if (/do\s+update[\s\S]*\btenant_id\s*=/i.test(sql)) {
                throw new Error('Raw upsert must not reassign tenant_id. Refused (SECURITY.md 16.1).');
            }
            return;
        }
        // SELECT/UPDATE/DELETE: setiap tabel ber-tenant yang disentuh harus punya
        // pembanding tenant_id.
        const filters = (sql.match(/tenant_id\s*=\s*:tenant_id/gi) ?? []).length;
        if (filters < scoped.length) {
            throw new Error(`Raw SQL touches tenant-scoped tables [${scoped.join(', ')}] but only has ${filters} ` +
                '`tenant_id = :tenant_id` filter(s). Refused (SECURITY.md 16.1).');
        }
    }
    /** Transaksi yang tetap terikat tenant yang sama. */
    transaction(fn) {
        return this.db.transaction(fn)();
    }
    /** Akses baca ke tabel global (plans, roles standar). Tidak dapat menyentuh data tenant. */
    globalRead(table, where, options = {}) {
        const bare = table.includes('.') ? table.split('.').pop() : table;
        if (!exports.GLOBAL_TABLES.has(bare)) {
            throw new Error(`globalRead() refused: "${table}" holds tenant data — use all() instead.`);
        }
        const params = [];
        let sql = `SELECT * FROM ${identifier(table)}${buildWhere(where, params)}`;
        if (options.orderBy)
            sql += ` ORDER BY ${identifier(options.orderBy.split(' ')[0])}${/ DESC$/i.test(options.orderBy) ? ' DESC' : ''}`;
        if (options.limit !== undefined)
            sql += ` LIMIT ${Number(options.limit)}`;
        return this.db.prepare(sql).all(...params);
    }
    /** Untuk kebutuhan platform (mis. audit writer) yang sudah memvalidasi tenant sendiri. */
    unsafeHandle(reason) {
        void reason;
        return this.db;
    }
    newId = db_ts_1.newId;
    now = db_ts_1.nowIso;
}
exports.TenantScopedDb = TenantScopedDb;
/** Mengekstrak nama tabel dari klausa FROM/JOIN/INTO/UPDATE untuk validasi kueri mentah. */
function extractTables(sql) {
    const found = new Set();
    const pattern = /\b(?:from|join|into|update)\s+([A-Za-z_][A-Za-z0-9_.]*)/gi;
    let match;
    while ((match = pattern.exec(sql)) !== null) {
        const name = match[1];
        found.add(name.includes('.') ? name.split('.').pop() : name);
    }
    return [...found];
}
/**
 * Akses lintas-tenant untuk peran Platform Operator (SECURITY.md 16.2).
 *
 * Hanya untuk fungsi administratif (provisioning, suspensi) — BUKAN akses baca terhadap
 * data analitik pelanggan. Setiap pemakaian menuliskan jejak audit `operator_access = 1`
 * yang dapat dilihat tenant terkait.
 */
class PlatformOperatorDb {
    db;
    constructor(db) {
        this.db = db;
    }
    listTenants() {
        return this.db.prepare('SELECT * FROM tenants ORDER BY created_at DESC').all();
    }
    getTenant(id) {
        return this.db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
    }
    /** Akses administratif ke satu tenant; pemanggil wajib mencatat jejak audit operator. */
    scopedTo(tenantId) {
        return new TenantScopedDb(this.db, tenantId);
    }
    handle() {
        return this.db;
    }
}
exports.PlatformOperatorDb = PlatformOperatorDb;
//# sourceMappingURL=tenancy.js.map