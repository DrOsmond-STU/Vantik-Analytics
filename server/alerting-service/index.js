"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AlertService = exports.BACKOFF_MS = exports.MAX_DELIVERY_ATTEMPTS = exports.QueueOnlyTransport = exports.SUPPORTED_CHANNELS = void 0;
/**
 * alerting-service — Alert Center (PRD 6.16).
 *
 * ARCHITECTURE.md 4.4: KPI melewati threshold → rule engine → kanal → catat ke audit.
 * PRD 6.17 menegaskan Digital Twin memakai jalur notifikasi yang SAMA — tidak ada
 * jalur notifikasi terpisah yang berdiri sendiri.
 */
const db_ts_1 = require("../platform/db.js");
const errors_ts_1 = require("../platform/errors.js");
exports.SUPPORTED_CHANNELS = ['email', 'whatsapp', 'telegram', 'sms', 'teams', 'slack'];
/**
 * Transport bawaan: mengantre TANPA mengirim.
 *
 * Sebelumnya mengembalikan `delivered: true`, yang berarti sistem mencatat pengiriman
 * yang tidak pernah terjadi — bentuk kegagalan paling berbahaya, karena operator melihat
 * "terkirim" dan berhenti mencari. Sekarang ia menyatakan dirinya tidak mengirim, dan
 * pemanggil mencatat statusnya sebagai masih dalam antrean.
 */
class QueueOnlyTransport {
    delivers = false;
    sent = [];
    async send(input) {
        this.sent.push({ channel: input.channel, recipient: input.recipient, subject: input.subject });
        return { delivered: false, failureReason: 'no_transport_configured' };
    }
}
exports.QueueOnlyTransport = QueueOnlyTransport;
/** Retry dengan backoff bila kanal gagal (ARCHITECTURE.md Bagian 7). */
exports.MAX_DELIVERY_ATTEMPTS = 4;
exports.BACKOFF_MS = [0, 2_000, 8_000, 32_000];
class AlertService {
    ctx;
    transport;
    outbox;
    constructor(ctx, transport = new QueueOnlyTransport(), 
    /**
     * Antrean tempat pesan yang tidak dapat dikirim menunggu, LENGKAP DENGAN ISINYA.
     *
     * `alert_deliveries` mencatat percobaan pengiriman tetapi tidak menyimpan badan
     * pesan, sehingga operator tidak dapat menyampaikannya manual dari sana. Panduan
     * pemasangan menjanjikan bahwa selama belum ada transport nyata, pesan tertunda
     * dapat dibaca dan disampaikan lewat kanal terpercaya — janji itu hanya benar bila
     * isinya benar-benar tersimpan di suatu tempat.
     */
    outbox) {
        this.ctx = ctx;
        this.transport = transport;
        this.outbox = outbox;
    }
    listRules() {
        this.ctx.require('alert:read', { module: 'Alert Center' });
        this.ctx.requireModule('alert_center');
        return this.ctx.db.all('alert_rules', undefined, { orderBy: 'name' }).map((r) => ({
            ...r,
            channels: JSON.parse(r.channels_json),
            recipients: JSON.parse(r.recipients_json),
        }));
    }
    createRule(input) {
        this.ctx.require('alert:write', { module: 'Alert Center' });
        this.ctx.requireModule('alert_center');
        this.ctx.requireWritable();
        for (const channel of input.channels) {
            if (!exports.SUPPORTED_CHANNELS.includes(channel)) {
                throw new errors_ts_1.ValidationError('error.unsupported_channel', { channel });
            }
        }
        if (input.channels.length === 0)
            throw new errors_ts_1.ValidationError('error.channel_required');
        if (input.recipients.length === 0)
            throw new errors_ts_1.ValidationError('error.recipient_required');
        if (!input.kpiId && !input.assetId)
            throw new errors_ts_1.ValidationError('error.alert_source_required');
        const id = (0, db_ts_1.newId)('alr');
        this.ctx.db.insert('alert_rules', {
            id,
            name: input.name,
            kpi_id: input.kpiId ?? null,
            asset_id: input.assetId ?? null,
            sensor_code: input.sensorCode ?? null,
            comparator: input.comparator,
            threshold: input.threshold,
            channels_json: JSON.stringify(input.channels),
            recipients_json: JSON.stringify(input.recipients),
            enabled: 1,
            cooldown_minutes: input.cooldownMinutes ?? 60,
            created_at: (0, db_ts_1.nowIso)(),
        });
        this.ctx.log({
            action: 'alert.rule_create',
            module: 'Alert Center',
            objectType: 'alert_rule',
            objectId: id,
            objectLabel: input.name,
            detail: { channels: input.channels, threshold: input.threshold, comparator: input.comparator },
        });
        return { id };
    }
    toggleRule(ruleId, enabled) {
        this.ctx.require('alert:write', { module: 'Alert Center', objectId: ruleId });
        this.ctx.requireWritable();
        if (this.ctx.db.update('alert_rules', { id: ruleId }, { enabled: enabled ? 1 : 0 }) === 0) {
            throw new errors_ts_1.NotFoundError();
        }
        this.ctx.log({
            action: 'alert.rule_toggled',
            module: 'Alert Center',
            objectType: 'alert_rule',
            objectId: ruleId,
            detail: { enabled },
        });
    }
    breaches(comparator, value, threshold) {
        switch (comparator) {
            case 'gt':
                return value > threshold;
            case 'gte':
                return value >= threshold;
            case 'lt':
                return value < threshold;
            case 'lte':
                return value <= threshold;
            default:
                return false;
        }
    }
    /**
     * Mengevaluasi satu observasi terhadap aturan yang relevan.
     *
     * Cooldown mencegah NOTIFIKASI GANDA untuk penyimpangan yang sama (TESTING.md Bagian 2:
     * "tidak ada notifikasi ganda").
     */
    async evaluate(observation) {
        const filter = { enabled: 1 };
        if (observation.kpiId)
            filter.kpi_id = observation.kpiId;
        if (observation.assetId)
            filter.asset_id = observation.assetId;
        if (observation.sensorCode)
            filter.sensor_code = observation.sensorCode;
        const rules = this.ctx.db.all('alert_rules', filter);
        const triggered = [];
        for (const rule of rules) {
            if (!this.breaches(rule.comparator, observation.value, rule.threshold))
                continue;
            const cooldownStart = new Date(Date.now() - rule.cooldown_minutes * 60_000).toISOString();
            const recent = this.ctx.db.all('alert_events', {
                rule_id: rule.id,
                detected_at: { gte: cooldownStart },
            });
            if (recent.length > 0)
                continue; // masih dalam cooldown → tidak dikirim ulang
            const eventId = (0, db_ts_1.newId)('aev');
            const at = (0, db_ts_1.nowIso)();
            const distance = Math.abs(observation.value - rule.threshold) / Math.max(1, Math.abs(rule.threshold));
            const severity = distance > 0.25 ? 'critical' : 'warning';
            this.ctx.db.insert('alert_events', {
                id: eventId,
                rule_id: rule.id,
                detected_at: at,
                observed_value: observation.value,
                severity,
                message_key: 'alert.threshold_breached',
                context_json: JSON.stringify({ ...observation.context, label: observation.label }),
                acknowledged_by: null,
                acknowledged_at: null,
                follow_up_note: null,
            });
            const channels = JSON.parse(rule.channels_json);
            const recipients = JSON.parse(rule.recipients_json);
            let deliveries = 0;
            for (const channel of channels) {
                for (const recipient of recipients) {
                    await this.deliver(eventId, channel, recipient, rule, observation);
                    deliveries++;
                }
            }
            // Notifikasi terkirim dicatat ke audit (ARCHITECTURE.md 4.4).
            this.ctx.log({
                action: 'alert.triggered',
                module: 'Alert Center',
                objectType: 'alert_event',
                objectId: eventId,
                objectLabel: rule.name,
                severity: severity === 'critical' ? 'critical' : 'warning',
                detail: {
                    observedValue: observation.value,
                    threshold: rule.threshold,
                    comparator: rule.comparator,
                    channels,
                    recipients: recipients.length,
                },
            });
            triggered.push({ ruleId: rule.id, eventId, deliveries });
        }
        return triggered;
    }
    async deliver(eventId, channel, recipient, rule, observation) {
        const deliveryId = (0, db_ts_1.newId)('adl');
        const queuedAt = (0, db_ts_1.nowIso)();
        this.ctx.db.insert('alert_deliveries', {
            id: deliveryId,
            event_id: eventId,
            channel,
            recipient,
            queued_at: queuedAt,
            delivered_at: null,
            attempts: 0,
            outcome: 'queued',
            failure_reason: null,
        });
        const subject = `[Vantik] ${rule.name}`;
        // Nada tulisan: kesalahan/penyimpangan DIJELASKAN, bukan dramatis (BRAND.md 2).
        const body = `${observation.label}: ${observation.value} (ambang batas ${rule.threshold}).`;
        // Tanpa tujuan untuk kanal ini, statusnya tetap `queued` — bukan `delivered` (bohong)
        // dan bukan `failed` (juga bohong: tidak ada yang gagal, memang tidak ada pengirim).
        // Percobaan ulang berbackoff pun dilewati: mengulang empat kali dengan jeda 42 detik
        // ke tujuan yang tidak ada hanya memperlambat evaluasi aturan tanpa peluang berhasil.
        const routed = this.transport.canDeliver?.(channel) ?? this.transport.delivers;
        if (!routed) {
            await this.transport.send({ channel, recipient, subject, body });
            this.ctx.db.update('alert_deliveries', { id: deliveryId }, {
                outcome: 'queued',
                failure_reason: this.transport.delivers ? 'channel_not_configured' : 'no_transport_configured',
            });
            // Isinya disimpan di outbox supaya operator dapat membacanya dan menyampaikan
            // sendiri. Tanpa ini, `GET /notifications/outbox` melaporkan antrean kosong
            // sementara notifikasi ambang batas menumpuk tanpa pernah sampai ke siapa pun.
            this.outbox?.enqueue({
                tenantId: this.ctx.tenant.id,
                purpose: 'alert_notification',
                channel,
                recipient,
                subject,
                body,
            });
            return;
        }
        let lastFailure;
        for (let attempt = 1; attempt <= exports.MAX_DELIVERY_ATTEMPTS; attempt++) {
            const result = await this.transport.send({ channel, recipient, subject, body });
            if (result.delivered) {
                this.ctx.db.update('alert_deliveries', { id: deliveryId }, { delivered_at: (0, db_ts_1.nowIso)(), attempts: attempt, outcome: 'delivered' });
                return;
            }
            lastFailure = result.failureReason;
            this.ctx.db.update('alert_deliveries', { id: deliveryId }, { attempts: attempt });
        }
        this.ctx.db.update('alert_deliveries', { id: deliveryId }, { outcome: 'failed', failure_reason: lastFailure ?? 'unknown' });
    }
    /**
     * Riwayat notifikasi: siapa menerima, kapan, tindak lanjut apa (PRD 6.16).
     */
    history(limit = 100) {
        this.ctx.require('alert:read', { module: 'Alert Center' });
        const events = this.ctx.db.all('alert_events', undefined, {
            orderBy: 'detected_at DESC',
            limit,
        });
        return events.map((event) => ({
            event,
            ruleName: this.ctx.db.get('alert_rules', { id: event.rule_id })?.name ?? '—',
            deliveries: this.ctx.db.all('alert_deliveries', { event_id: event.id }),
        }));
    }
    acknowledge(eventId, note) {
        this.ctx.require('alert:acknowledge', { module: 'Alert Center', objectId: eventId });
        this.ctx.requireWritable();
        const changed = this.ctx.db.update('alert_events', { id: eventId }, { acknowledged_by: this.ctx.actor.userId, acknowledged_at: (0, db_ts_1.nowIso)(), follow_up_note: note ?? null });
        if (changed === 0)
            throw new errors_ts_1.NotFoundError();
        this.ctx.log({
            action: 'alert.acknowledged',
            module: 'Alert Center',
            objectType: 'alert_event',
            objectId: eventId,
            detail: { note },
        });
    }
    /** Waktu deteksi-ke-notifikasi — target < 5 menit (PRD Bagian 9). */
    detectionToNotificationStats() {
        this.ctx.require('alert:read', { module: 'Alert Center' });
        const rows = this.ctx.db.raw(`SELECT (julianday(d.delivered_at) - julianday(e.detected_at)) * 86400000 AS latency_ms
         FROM alert_deliveries d
         JOIN alert_events e ON e.id = d.event_id AND e.tenant_id = :tenant_id
        WHERE d.tenant_id = :tenant_id AND d.delivered_at IS NOT NULL`);
        const latencies = rows.map((r) => r.latency_ms).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
        if (latencies.length === 0)
            return { median: 0, p95: 0, samples: 0 };
        const at = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))];
        return { median: Math.round(at(0.5)), p95: Math.round(at(0.95)), samples: latencies.length };
    }
}
exports.AlertService = AlertService;
//# sourceMappingURL=index.js.map