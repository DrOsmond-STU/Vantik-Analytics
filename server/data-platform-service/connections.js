"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConnectionService = exports.ConfigurationProbe = exports.CONNECTION_LOCK_MS = exports.MAX_CONSECUTIVE_FAILURES = exports.SUPPORTED_KINDS = void 0;
/**
 * Koneksi Eksternal — PRD 6.12, SECURITY.md Bagian 8.
 *
 * Zero Trust (SECURITY.md Bagian 2): setiap koneksi ke sumber data eksternal
 * diperlakukan tidak tepercaya sampai diverifikasi dan dienkripsi.
 */
const db_ts_1 = require("../platform/db.js");
const errors_ts_1 = require("../platform/errors.js");
const crypto_ts_1 = require("../platform/crypto.js");
exports.SUPPORTED_KINDS = [
    'rest_api',
    'postgresql',
    'mysql',
    'oracle',
    'google_sheets',
];
/** Penguncian sementara setelah kegagalan autentikasi berulang (SECURITY.md Bagian 8). */
exports.MAX_CONSECUTIVE_FAILURES = 3;
exports.CONNECTION_LOCK_MS = 30 * 60 * 1000;
/**
 * Probe bawaan. Melakukan validasi bentuk konfigurasi tanpa menghubungi jaringan.
 * Uji koneksi berjalan pada jalur terisolasi TANPA mengekspos kredensial ke log
 * aplikasi (SECURITY.md Bagian 8) — karena itu tidak ada satu pun `console.log`
 * atau pesan kesalahan yang memuat isi `secrets`.
 */
class ConfigurationProbe {
    async test(input) {
        const started = Date.now();
        const requiredSecret = {
            rest_api: ['api_key'],
            postgresql: ['password'],
            mysql: ['password'],
            oracle: ['password'],
            google_sheets: ['service_account_json'],
        };
        if (input.kind !== 'rest_api' && input.kind !== 'google_sheets') {
            if (!input.host)
                return { ok: false, reasonKey: 'error.connection_host_required' };
            if (!input.databaseName)
                return { ok: false, reasonKey: 'error.connection_database_required' };
            if (!input.username)
                return { ok: false, reasonKey: 'error.connection_username_required' };
        }
        if (input.kind === 'rest_api' && !input.host) {
            return { ok: false, reasonKey: 'error.connection_url_required' };
        }
        for (const field of requiredSecret[input.kind]) {
            if (!input.secrets[field])
                return { ok: false, reasonKey: 'error.connection_credential_required' };
        }
        return { ok: true, latencyMs: Date.now() - started };
    }
}
exports.ConfigurationProbe = ConfigurationProbe;
class ConnectionService {
    ctx;
    keyring;
    probe;
    metering;
    constructor(ctx, keyring, probe = new ConfigurationProbe(), metering) {
        this.ctx = ctx;
        this.keyring = keyring;
        this.probe = probe;
        this.metering = metering;
    }
    list() {
        this.ctx.require('connection:read', { module: 'Koneksi Eksternal' });
        this.ctx.requireModule('external_connection');
        const rows = this.ctx.db.all('external_connections', undefined, {
            orderBy: 'name',
        });
        return rows.map((r) => ({ ...r, secret_fields: this.secretFields(r.id) }));
    }
    secretFields(connectionId) {
        return this.ctx.db
            .all('connection_secrets', { connection_id: connectionId })
            .map((s) => s.field);
    }
    create(input) {
        this.ctx.require('connection:write', { module: 'Koneksi Eksternal' });
        this.ctx.requireModule('external_connection');
        this.ctx.requireWritable();
        if (!exports.SUPPORTED_KINDS.includes(input.kind)) {
            throw new errors_ts_1.ValidationError('error.connection_kind_unsupported', { kind: input.kind });
        }
        this.metering?.assertWithinQuota('connections', 1);
        const at = (0, db_ts_1.nowIso)();
        const id = (0, db_ts_1.newId)('con');
        this.ctx.db.transaction(() => {
            this.ctx.db.insert('external_connections', {
                id,
                name: input.name,
                kind: input.kind,
                host: input.host ?? null,
                port: input.port ?? null,
                database_name: input.databaseName ?? null,
                username: input.username ?? null,
                options_json: input.options ? JSON.stringify(input.options) : null,
                status: 'never_tested',
                // Least privilege: kredensial read-only direkomendasikan (SECURITY.md Bagian 8)
                read_only: input.readOnly === false ? 0 : 1,
                schedule: input.schedule ?? 'manual',
                last_sync_at: null,
                last_sync_outcome: null,
                consecutive_failures: 0,
                locked_until: null,
                created_by: this.ctx.actor.userId,
                created_at: at,
                updated_at: at,
            });
            this.storeSecrets(id, input.secrets ?? {});
        });
        this.metering?.record('connections', 1, 'connection.create');
        this.ctx.log({
            action: 'connection.create',
            module: 'Koneksi Eksternal',
            objectType: 'connection',
            objectId: id,
            objectLabel: input.name,
            severity: 'notice',
            // Kredensial TIDAK PERNAH disalin ke log (SECURITY.md Bagian 8).
            detail: {
                kind: input.kind,
                host: input.host ?? null,
                readOnly: input.readOnly !== false,
                secretFields: Object.keys(input.secrets ?? {}),
            },
        });
        return this.get(id);
    }
    get(connectionId) {
        this.ctx.require('connection:read', { module: 'Koneksi Eksternal', objectId: connectionId });
        const row = this.ctx.db.get('external_connections', {
            id: connectionId,
        });
        if (!row)
            throw new errors_ts_1.NotFoundError();
        return { ...row, secret_fields: this.secretFields(connectionId) };
    }
    /** Menyimpan rahasia ke vault terpisah, terenkripsi AES-256-GCM (SECURITY.md Bagian 6). */
    storeSecrets(connectionId, secrets) {
        const at = (0, db_ts_1.nowIso)();
        for (const [field, value] of Object.entries(secrets)) {
            if (!value)
                continue;
            const sealed = (0, crypto_ts_1.seal)(this.keyring, value);
            this.ctx.db.rawRun(`INSERT INTO vault.connection_secrets
           (connection_id, tenant_id, field, key_version, iv, tag, ciphertext, rotated_at)
         VALUES (:connection_id, :tenant_id, :field, :key_version, :iv, :tag, :ciphertext, :rotated_at)
         ON CONFLICT(connection_id, field) DO UPDATE SET
           key_version = excluded.key_version, iv = excluded.iv,
           tag = excluded.tag, ciphertext = excluded.ciphertext, rotated_at = excluded.rotated_at`, {
                connection_id: connectionId,
                field,
                key_version: sealed.keyVersion,
                iv: sealed.iv,
                tag: sealed.tag,
                ciphertext: sealed.ciphertext,
                rotated_at: at,
            });
        }
    }
    /**
     * Membuka rahasia HANYA untuk dipakai proses koneksi.
     * Private: tidak ada endpoint yang dapat mengembalikan nilai ini ke klien.
     */
    loadSecrets(connectionId) {
        const rows = this.ctx.db.all('connection_secrets', { connection_id: connectionId });
        const out = {};
        for (const row of rows) {
            out[row.field] = (0, crypto_ts_1.open)(this.keyring, {
                keyVersion: row.key_version,
                iv: row.iv,
                tag: row.tag,
                ciphertext: row.ciphertext,
            });
        }
        return out;
    }
    /** "Uji Koneksi" — dijalankan sebelum konfigurasi disimpan/diaktifkan (PRD 6.12). */
    async testConnection(connectionId) {
        this.ctx.require('connection:test', { module: 'Koneksi Eksternal', objectId: connectionId });
        const conn = this.ctx.db.get('external_connections', { id: connectionId });
        if (!conn)
            throw new errors_ts_1.NotFoundError();
        if (conn.locked_until && Date.parse(conn.locked_until) > Date.now()) {
            throw new errors_ts_1.ConflictError('error.connection_locked', { until: conn.locked_until });
        }
        const result = await this.probe.test({
            kind: conn.kind,
            host: conn.host,
            port: conn.port,
            databaseName: conn.database_name,
            username: conn.username,
            secrets: this.loadSecrets(connectionId),
            options: conn.options_json ? JSON.parse(conn.options_json) : {},
        });
        const at = (0, db_ts_1.nowIso)();
        if (result.ok) {
            this.ctx.db.update('external_connections', { id: connectionId }, { status: 'connected', consecutive_failures: 0, locked_until: null, updated_at: at });
        }
        else {
            const failures = conn.consecutive_failures + 1;
            const locked = failures >= exports.MAX_CONSECUTIVE_FAILURES;
            this.ctx.db.update('external_connections', { id: connectionId }, {
                status: locked ? 'locked' : 'auth_failed',
                consecutive_failures: failures,
                locked_until: locked ? new Date(Date.now() + exports.CONNECTION_LOCK_MS).toISOString() : null,
                updated_at: at,
            });
        }
        this.ctx.log({
            action: 'connection.test',
            module: 'Koneksi Eksternal',
            objectType: 'connection',
            objectId: connectionId,
            objectLabel: conn.name,
            outcome: result.ok ? 'success' : 'failure',
            severity: result.ok ? 'info' : 'warning',
            detail: { reasonKey: result.reasonKey, latencyMs: result.latencyMs },
        });
        return result;
    }
    /**
     * Sinkronisasi terjadwal/manual (PRD 6.12, ARCHITECTURE.md 4.2).
     * Kegagalan memicu notifikasi ke Data Engineer melalui Alert Center.
     */
    async sync(connectionId, fetcher, onFailure) {
        this.ctx.require('connection:sync', { module: 'Koneksi Eksternal', objectId: connectionId });
        this.ctx.requireWritable();
        const conn = this.ctx.db.get('external_connections', { id: connectionId });
        if (!conn)
            throw new errors_ts_1.NotFoundError();
        if (conn.locked_until && Date.parse(conn.locked_until) > Date.now()) {
            throw new errors_ts_1.ConflictError('error.connection_locked', { until: conn.locked_until });
        }
        const runId = (0, db_ts_1.newId)('syn');
        const startedAt = (0, db_ts_1.nowIso)();
        this.ctx.db.insert('connection_sync_runs', {
            id: runId,
            connection_id: connectionId,
            started_at: startedAt,
            finished_at: null,
            outcome: 'running',
            rows_ingested: 0,
            message_key: null,
        });
        try {
            const { rows } = await fetcher();
            const at = (0, db_ts_1.nowIso)();
            this.ctx.db.update('connection_sync_runs', { id: runId }, { finished_at: at, outcome: 'success', rows_ingested: rows.length });
            this.ctx.db.update('external_connections', { id: connectionId }, {
                status: 'connected',
                last_sync_at: at,
                last_sync_outcome: 'success',
                consecutive_failures: 0,
                updated_at: at,
            });
            this.ctx.log({
                action: 'connection.sync',
                module: 'Koneksi Eksternal',
                objectType: 'connection',
                objectId: connectionId,
                objectLabel: conn.name,
                detail: { rows: rows.length },
            });
            return { outcome: 'success', rowsIngested: rows.length };
        }
        catch (error) {
            const at = (0, db_ts_1.nowIso)();
            const reasonKey = error instanceof Error && error.message === 'auth_failed'
                ? 'error.connection_auth_failed'
                : 'error.connection_unreachable';
            this.ctx.db.update('connection_sync_runs', { id: runId }, { finished_at: at, outcome: 'auth_failed', rows_ingested: 0, message_key: reasonKey });
            const failures = (this.ctx.db.get('external_connections', { id: connectionId })
                ?.consecutive_failures ?? 0) + 1;
            const locked = failures >= exports.MAX_CONSECUTIVE_FAILURES;
            this.ctx.db.update('external_connections', { id: connectionId }, {
                status: locked ? 'locked' : 'auth_failed',
                last_sync_at: at,
                last_sync_outcome: reasonKey,
                consecutive_failures: failures,
                locked_until: locked ? new Date(Date.now() + exports.CONNECTION_LOCK_MS).toISOString() : null,
                updated_at: at,
            });
            this.ctx.log({
                action: 'connection.sync',
                module: 'Koneksi Eksternal',
                objectType: 'connection',
                objectId: connectionId,
                objectLabel: conn.name,
                outcome: 'failure',
                severity: 'warning',
                detail: { reasonKey, consecutiveFailures: failures, locked },
            });
            onFailure?.(reasonKey);
            return { outcome: reasonKey, rowsIngested: 0 };
        }
    }
    syncHistory(connectionId) {
        this.ctx.require('connection:read', { module: 'Koneksi Eksternal', objectId: connectionId });
        return this.ctx.db.all('connection_sync_runs', { connection_id: connectionId }, { orderBy: 'started_at DESC', limit: 50 });
    }
    /** Rotasi kredensial berkala (SECURITY.md Bagian 6, PRD Bagian 11 mitigasi risiko). */
    rotateSecrets(connectionId, secrets) {
        this.ctx.require('connection:write', { module: 'Koneksi Eksternal', objectId: connectionId });
        this.ctx.requireWritable();
        if (!this.ctx.db.get('external_connections', { id: connectionId }))
            throw new errors_ts_1.NotFoundError();
        this.storeSecrets(connectionId, secrets);
        this.ctx.db.update('external_connections', { id: connectionId }, { status: 'never_tested', consecutive_failures: 0, locked_until: null, updated_at: (0, db_ts_1.nowIso)() });
        this.ctx.log({
            action: 'connection.rotate_credentials',
            module: 'Koneksi Eksternal',
            objectType: 'connection',
            objectId: connectionId,
            severity: 'notice',
            detail: { fields: Object.keys(secrets) },
        });
    }
    delete(connectionId) {
        this.ctx.require('connection:write', { module: 'Koneksi Eksternal', objectId: connectionId });
        this.ctx.requireWritable();
        const conn = this.ctx.db.get('external_connections', { id: connectionId });
        if (!conn)
            throw new errors_ts_1.NotFoundError();
        this.ctx.db.transaction(() => {
            this.ctx.db.delete('connection_secrets', { connection_id: connectionId });
            this.ctx.db.delete('connection_sync_runs', { connection_id: connectionId });
            this.ctx.db.delete('external_connections', { id: connectionId });
        });
        this.ctx.log({
            action: 'connection.delete',
            module: 'Koneksi Eksternal',
            objectType: 'connection',
            objectId: connectionId,
            objectLabel: conn.name,
            severity: 'notice',
        });
    }
}
exports.ConnectionService = ConnectionService;
//# sourceMappingURL=connections.js.map