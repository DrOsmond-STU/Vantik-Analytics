"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MeteringService = exports.USAGE_ALERT_THRESHOLDS = void 0;
/**
 * metering-service — Usage Metering & Kuota (PRD 6.29).
 *
 * `usage_events` bersifat append-only (SECURITY.md 16.3): angka tagihan harus selalu
 * dapat ditelusuri ke catatan penggunaan aslinya.
 */
const db_ts_1 = require("../platform/db.js");
const errors_ts_1 = require("../platform/errors.js");
/** Ambang notifikasi otomatis (PRD 6.29). */
exports.USAGE_ALERT_THRESHOLDS = [0.8, 1.0];
class MeteringService {
    ctx;
    constructor(ctx) {
        this.ctx = ctx;
    }
    /** Mencatat pemakaian. Append-only — tidak ada jalur update/delete. */
    record(metric, quantity, source, meta) {
        this.ctx.db.insert('usage_events', {
            id: (0, db_ts_1.newId)('use'),
            metric,
            quantity,
            occurred_at: (0, db_ts_1.nowIso)(),
            source,
            meta_json: meta ? JSON.stringify(meta) : null,
        });
    }
    /** Total pemakaian pada siklus penagihan berjalan. */
    currentUsage(metric) {
        if (metric === 'users')
            return this.ctx.db.count('system_user', { status: 'active' });
        if (metric === 'connections')
            return this.ctx.db.count('external_connections');
        if (metric === 'datasets')
            return this.ctx.db.count('dataset_catalog', { status: 'ready' });
        if (metric === 'embed_tokens')
            return this.ctx.db.count('embed_tokens', { revoked_at: null });
        // Metrik kumulatif (storage, panggilan AI) dihitung dari usage_events siklus berjalan.
        const start = this.currentPeriodStart();
        const row = this.ctx.db.rawOne(`SELECT SUM(quantity) AS total FROM usage_events
        WHERE tenant_id = :tenant_id AND metric = :metric AND occurred_at >= :start`, { metric, start });
        return row?.total ?? 0;
    }
    currentPeriodStart() {
        const sub = this.ctx.db.all('subscriptions', undefined, {
            orderBy: 'created_at DESC',
            limit: 1,
        })[0];
        if (sub)
            return sub.current_period_start;
        const now = new Date();
        return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    }
    /**
     * Memeriksa kuota SEBELUM aksi dijalankan.
     *
     * PRD 6.29: pengguna tidak boleh mendapat tagihan mengejutkan tanpa persetujuan
     * sebelumnya — karena itu metrik ber-perilaku `block` menolak aksi, sedangkan
     * `overage` diizinkan namun kelebihannya dicatat untuk ditagih transparan.
     */
    assertWithinQuota(metric, increment = 1) {
        const quota = this.ctx.flags.quota(metric);
        if (quota < 0)
            return; // tidak dibatasi
        const used = this.currentUsage(metric);
        if (used + increment <= quota)
            return;
        if (this.ctx.flags.overBehaviour(metric) === 'block') {
            this.ctx.log({
                action: 'quota.blocked',
                module: 'Usage Metering & Kuota',
                objectType: 'quota',
                objectId: metric,
                outcome: 'denied',
                severity: 'warning',
                detail: { used, quota, increment },
            });
            throw new errors_ts_1.QuotaExceededError('error.quota_exceeded', { metric, used, quota });
        }
        this.record(metric, 0, 'quota.overage_entered', { used, quota });
    }
    /** Ringkasan penggunaan vs kuota, beserta proyeksi (PRD 6.29). */
    snapshot() {
        this.ctx.require('usage:read', { module: 'Usage Metering & Kuota' });
        this.ctx.requireModule('usage_metering');
        const metrics = [
            'users',
            'datasets',
            'storage_mb',
            'connections',
            'embed_tokens',
            'ai_calls_monthly',
        ];
        return metrics.map((metric) => {
            const quota = this.ctx.flags.quota(metric);
            const used = this.currentUsage(metric);
            const unlimited = quota < 0;
            return {
                metric,
                used,
                quota,
                ratio: unlimited ? 0 : quota === 0 ? (used > 0 ? 1 : 0) : used / quota,
                behaviour: this.ctx.flags.overBehaviour(metric),
                projectedExhaustionAt: unlimited ? null : this.projectExhaustion(metric, used, quota),
                unlimited,
            };
        });
    }
    /**
     * Proyeksi kapan kuota tercapai berdasarkan laju pemakaian 14 hari terakhir.
     * Mengembalikan null bila laju tidak cukup untuk memproyeksikan — lebih baik tidak
     * menjanjikan angka daripada menampilkan tebakan yang menyesatkan (BRAND.md Bagian 2).
     */
    projectExhaustion(metric, used, quota) {
        if (quota <= 0 || used >= quota)
            return null;
        const since = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
        const row = this.ctx.db.rawOne(`SELECT SUM(quantity) AS total FROM usage_events
        WHERE tenant_id = :tenant_id AND metric = :metric AND occurred_at >= :since`, { metric, since });
        const recent = row?.total ?? 0;
        if (recent <= 0)
            return null;
        const perDay = recent / 14;
        const daysLeft = (quota - used) / perDay;
        if (!Number.isFinite(daysLeft) || daysLeft > 365)
            return null;
        return new Date(Date.now() + daysLeft * 24 * 3600 * 1000).toISOString();
    }
    /**
     * Metrik yang melewati ambang notifikasi. Dipakai Alert Center untuk mengirim
     * notifikasi otomatis pada 80% dan 100% kuota (PRD 6.29).
     */
    breachedThresholds() {
        const out = [];
        for (const snap of this.snapshot()) {
            if (snap.unlimited)
                continue;
            for (const threshold of exports.USAGE_ALERT_THRESHOLDS) {
                if (snap.ratio >= threshold)
                    out.push({ metric: snap.metric, ratio: snap.ratio, threshold });
            }
        }
        return out;
    }
    /**
     * Rincian penggunaan yang dapat diaudit tenant — dasar penagihan harus dapat
     * ditelusuri ke catatan aslinya (PRD 6.29, SECURITY.md 16.3).
     */
    auditTrail(metric, limit = 200) {
        this.ctx.require('usage:read', { module: 'Usage Metering & Kuota' });
        return this.ctx.db.all('usage_events', { metric }, { orderBy: 'occurred_at DESC', limit });
    }
    /** Metering panggilan AI dihitung & ditampilkan TERPISAH (PRD 6.29). */
    aiUsageBreakdown() {
        const start = this.currentPeriodStart();
        const bySource = this.ctx.db.raw(`SELECT source, COUNT(*) AS n FROM usage_events
        WHERE tenant_id = :tenant_id AND metric = 'ai_calls_monthly' AND occurred_at >= :start
        GROUP BY source ORDER BY n DESC`, { start });
        return {
            calls: this.currentUsage('ai_calls_monthly'),
            quota: this.ctx.flags.quota('ai_calls_monthly'),
            bySource,
        };
    }
}
exports.MeteringService = MeteringService;
//# sourceMappingURL=index.js.map