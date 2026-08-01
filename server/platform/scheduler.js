"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Scheduler = exports.SCHEDULER_FRESHNESS_MS = exports.SCHEDULER_INTERVAL_MS = void 0;
exports.systemContext = systemContext;
const db_ts_1 = require("./db.js");
const context_ts_1 = require("./context.js");
const rls_ts_1 = require("./rls.js");
/** Jeda antar-putaran ticker. */
exports.SCHEDULER_INTERVAL_MS = 5 * 60 * 1000;
/** Sebuah pekerjaan dianggap masih segar bila berjalan dalam rentang ini. */
exports.SCHEDULER_FRESHNESS_MS = 4 * 60 * 1000;
/**
 * Izin yang diberikan kepada aktor sistem.
 *
 * Sengaja SEMPIT, bukan `*:*`: pekerjaan berkala berjalan tanpa manusia yang mengawasi,
 * jadi cacat di dalamnya tidak boleh dapat menghapus dataset atau mengubah peran. Yang
 * dibutuhkan hanya membaca KPI/laporan dan menulis peristiwa alert.
 */
const SYSTEM_PERMISSIONS = [
    'kpi:read',
    'alert:read',
    'alert:write',
    'report:read',
    'dataset:read',
];
/**
 * Konteks untuk pekerjaan berkala.
 *
 * Aktornya diberi kode peran sintetis `system`, yang sengaja BUKAN salah satu dari 13
 * peran standar. Efeknya: `requiresMfa()` mengembalikan false tanpa perlu pengecualian
 * khusus — MFA adalah kontrol untuk manusia, dan proses latar bukan manusia. Log
 * Aktivitas mencatatnya sebagai `system`, sehingga aksi otomatis dapat dibedakan dari
 * aksi orang.
 */
function systemContext(db, audit, tenantId) {
    const tenantRow = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
    const tenant = (0, context_ts_1.toTenantInfo)(tenantRow);
    return new context_ts_1.RequestContext(db, tenant, {
        userId: 'system',
        employeeId: 'system',
        email: 'system@vantik',
        displayName: 'Penjadwal Vantik',
        locale: tenant.defaultLocale === 'en' ? 'en' : 'id',
        theme: 'light',
        roleIds: ['role_system'],
        roleCodes: ['system'],
        sessionId: 'system-scheduler',
        reauthAt: (0, db_ts_1.nowIso)(),
        mfaEnrolled: true,
    }, [{ permissions: SYSTEM_PERMISSIONS, denials: [] }], (0, context_ts_1.loadFeatureFlags)(db, tenant.id, tenant.status), audit, null, 
    // Pekerjaan sistem tidak dibatasi RLS: ia mengevaluasi ambang batas untuk seluruh
    // organisasi, bukan mewakili satu pengguna. Ia juga tidak pernah mengembalikan baris
    // ke siapa pun — hasilnya berupa peristiwa alert.
    new rls_ts_1.RlsScope([]));
}
class Scheduler {
    db;
    audit;
    jobs;
    globalJobs;
    timer = null;
    constructor(db, audit, jobs, globalJobs = {}) {
        this.db = db;
        this.audit = audit;
        this.jobs = jobs;
        this.globalJobs = globalJobs;
    }
    /** Tenant yang aktif. Tenant disuspensi tidak dijadwalkan apa pun. */
    activeTenants() {
        return this.db
            .prepare("SELECT id FROM tenants WHERE deleted_at IS NULL AND status NOT IN ('suspended')")
            .all().map((r) => r.id);
    }
    /**
     * Klaim sebuah pekerjaan.
     *
     * Dua proses Passenger dapat memulai putaran nyaris bersamaan. Klaim ini membuat hanya
     * satu di antaranya yang bekerja: yang kedua melihat catatan yang masih segar dan
     * melewatkannya. Bukan penguncian sempurna — SQLite di shared hosting bukan tempat
     * membangun koordinasi terdistribusi — tetapi cukup untuk mencegah pekerjaan ganda
     * yang mengirim notifikasi dua kali.
     */
    claim(job) {
        const at = (0, db_ts_1.nowIso)();
        const existing = this.db
            .prepare('SELECT started_at, finished_at FROM scheduler_runs WHERE job = ?')
            .get(job);
        if (existing && Date.now() - Date.parse(existing.started_at) < exports.SCHEDULER_FRESHNESS_MS)
            return false;
        this.db
            .prepare(`INSERT INTO scheduler_runs (job, started_at, finished_at, outcome, detail_json)
         VALUES (?,?,NULL,NULL,NULL)
         ON CONFLICT(job) DO UPDATE SET started_at = excluded.started_at,
                                        finished_at = NULL,
                                        outcome = NULL,
                                        detail_json = NULL`)
            .run(job, at);
        return true;
    }
    finish(job, outcome, detail) {
        this.db
            .prepare('UPDATE scheduler_runs SET finished_at = ?, outcome = ?, detail_json = ? WHERE job = ?')
            .run((0, db_ts_1.nowIso)(), outcome, JSON.stringify(detail), job);
    }
    /** Menjalankan seluruh pekerjaan yang jatuh tempo. Aman dipanggil berulang. */
    async runDueJobs(options = {}) {
        const results = [];
        for (const [job, runner] of Object.entries(this.jobs)) {
            if (!options.force && !this.claim(job)) {
                results.push({ job, tenantsProcessed: 0, actions: 0, skipped: 'ran_recently' });
                continue;
            }
            if (options.force)
                this.claim(job);
            let actions = 0;
            let processed = 0;
            const failures = [];
            for (const tenantId of this.activeTenants()) {
                try {
                    actions += await runner(systemContext(this.db, this.audit, tenantId));
                    processed++;
                }
                catch (error) {
                    // Satu tenant yang gagal TIDAK boleh menghentikan tenant lain: pada platform
                    // multi-tenant itu berarti satu pelanggan dengan data rusak membekukan
                    // penjadwalan seluruh pelanggan lain.
                    failures.push(`${tenantId}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            this.finish(job, failures.length === 0 ? 'ok' : 'partial', { actions, processed, failures });
            results.push({ job, tenantsProcessed: processed, actions });
        }
        for (const [job, runner] of Object.entries(this.globalJobs)) {
            if (!options.force && !this.claim(job)) {
                results.push({ job, tenantsProcessed: 0, actions: 0, skipped: 'ran_recently' });
                continue;
            }
            if (options.force)
                this.claim(job);
            try {
                const actions = await runner(this.db);
                this.finish(job, 'ok', { actions });
                // `tenantsProcessed: 0` bukan kegagalan di sini — pekerjaan global memang tidak
                // menghitung tenant. Dibedakan lewat nama pekerjaannya, bukan lewat angka ini.
                results.push({ job, tenantsProcessed: 0, actions });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.finish(job, 'failed', { failures: [message] });
                results.push({ job, tenantsProcessed: 0, actions: 0, skipped: `failed: ${message}` });
            }
        }
        return results;
    }
    /** Status untuk operator: kapan tiap pekerjaan terakhir berjalan dan hasilnya. */
    status() {
        return this.db.prepare('SELECT * FROM scheduler_runs ORDER BY job').all().map((r) => ({
            job: r.job,
            startedAt: r.started_at,
            finishedAt: r.finished_at,
            outcome: r.outcome,
            detail: r.detail_json ? JSON.parse(r.detail_json) : null,
        }));
    }
    /**
     * Memulai ticker dan langsung menyusul pekerjaan yang terlewat.
     *
     * `unref()` supaya ticker tidak menahan proses tetap hidup — di shared hosting,
     * proses yang menolak mati bukan hal yang diinginkan penyedia hosting.
     */
    start() {
        if (this.timer)
            return;
        void this.runDueJobs().catch(() => {
            /* kegagalan penyusulan tidak boleh menggagalkan startup */
        });
        this.timer = setInterval(() => {
            void this.runDueJobs().catch(() => {
                /* sudah tercatat di scheduler_runs */
            });
        }, exports.SCHEDULER_INTERVAL_MS);
        this.timer.unref?.();
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
    }
}
exports.Scheduler = Scheduler;
//# sourceMappingURL=scheduler.js.map