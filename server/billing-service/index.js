"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BillingService = exports.RENEWAL_REMINDER_DAYS = exports.DEFAULT_TAX_RATE = exports.GRACE_PERIOD_DAYS = void 0;
exports.periodEndFor = periodEndFor;
/**
 * billing-service — Manajemen Langganan & Paket (PRD 6.27), Billing & Faktur (PRD 6.28).
 *
 * SECURITY.md 16.3: data kartu pembayaran TIDAK PERNAH disentuh atau disimpan sistem
 * Vantik — seluruh proses ditangani payment gateway bersertifikasi PCI-DSS; sistem
 * hanya menyimpan token referensi dan metadata transaksi.
 */
const node_crypto_1 = require("node:crypto");
const db_ts_1 = require("../platform/db.js");
const errors_ts_1 = require("../platform/errors.js");
const featureFlags_ts_1 = require("../platform/featureFlags.js");
const context_ts_1 = require("../platform/context.js");
/** Masa tenggang sebelum layanan dibatasi (PRD 6.28). */
exports.GRACE_PERIOD_DAYS = 14;
/** PPN Indonesia; nilai final ditetapkan tim bisnis (PRD Bagian 12). */
exports.DEFAULT_TAX_RATE = 0.11;
/** Pengingat dikirim sekali, sejauh ini sebelum masa berlaku habis. */
exports.RENEWAL_REMINDER_DAYS = 7;
/** Nama siklus untuk baris faktur; bukan string UI — faktur dicetak apa adanya. */
const CYCLE_LABEL = {
    monthly: '1 bulan',
    quarterly: '3 bulan',
    semiannual: '6 bulan',
    annual: '12 bulan',
};
/**
 * Akhir periode bila sebuah siklus dimulai pada `startIso`.
 *
 * Memakai bulan kalender, bukan 30 hari — lihat `addMonths()`.
 */
function periodEndFor(startIso, cycle) {
    return (0, db_ts_1.addMonths)(startIso, (0, featureFlags_ts_1.cycleMonths)(cycle));
}
class BillingService {
    ctx;
    metering;
    outbox;
    constructor(ctx, metering, 
    /**
     * Antrean pemberitahuan. Opsional supaya pemakaian lama (dan pengujian yang hanya
     * memeriksa perhitungan) tetap dapat merangkai layanan ini tanpa outbox; bila tidak
     * ada, pengingat perpanjangan sekadar tidak diantrekan — tidak ada yang dicatat
     * sebagai terkirim padahal tidak.
     */
    outbox) {
        this.ctx = ctx;
        this.metering = metering;
        this.outbox = outbox;
    }
    currentSubscription() {
        const sub = this.ctx.db.all('subscriptions', undefined, {
            orderBy: 'created_at DESC',
            limit: 1,
        })[0];
        if (!sub)
            throw new errors_ts_1.NotFoundError('error.no_subscription');
        return sub;
    }
    toView(sub) {
        const plan = featureFlags_ts_1.PLAN_BY_CODE.get(sub.plan_code);
        const expiresAt = (0, context_ts_1.subscriptionExpiresAt)(sub);
        return {
            ...sub,
            plan_name: plan.name,
            cycle_months: (0, featureFlags_ts_1.cycleMonths)(sub.billing_cycle),
            expires_at: expiresAt,
            days_remaining: Math.ceil((Date.parse(expiresAt) - Date.now()) / 86_400_000),
            expired: (0, context_ts_1.subscriptionLapsed)(sub),
            price: (0, featureFlags_ts_1.planPrice)(plan, sub.billing_cycle),
            features: plan.features,
            quotas: plan.quotas,
        };
    }
    /** Paket aktif, siklus, tanggal perpanjangan, dan fitur tercakup (PRD 6.27). */
    currentPlan() {
        this.ctx.require('subscription:read', { module: 'Manajemen Langganan & Paket' });
        this.ctx.requireModule('subscription_management');
        return this.toView(this.currentSubscription());
    }
    availablePlans() {
        this.ctx.require('subscription:read', { module: 'Manajemen Langganan & Paket' });
        return featureFlags_ts_1.PLAN_CATALOG;
    }
    /**
     * Pratinjau perubahan paket.
     *
     * PRD 6.27: upgrade berlaku SEGERA, downgrade berlaku pada awal siklus berikutnya,
     * dengan perhitungan pro-rata yang transparan. Sistem memperingatkan bila konfigurasi
     * saat ini melebihi batas paket tujuan.
     */
    previewPlanChange(targetPlanCode) {
        this.ctx.require('subscription:read', { module: 'Manajemen Langganan & Paket' });
        const target = featureFlags_ts_1.PLAN_BY_CODE.get(targetPlanCode);
        if (!target)
            throw new errors_ts_1.ValidationError('error.plan_unknown', { plan: targetPlanCode });
        const sub = this.currentSubscription();
        const current = featureFlags_ts_1.PLAN_BY_CODE.get(sub.plan_code);
        const isUpgrade = target.sortOrder > current.sortOrder;
        // Peringatan bila konfigurasi saat ini melebihi kuota paket tujuan.
        const blockingIssues = [];
        const metrics = ['users', 'datasets', 'connections', 'embed_tokens', 'storage_mb'];
        for (const metric of metrics) {
            const newQuota = target.quotas[metric];
            if (newQuota < 0)
                continue;
            const used = this.metering.currentUsage(metric);
            if (used > newQuota)
                blockingIssues.push({ metric, current: used, newQuota });
        }
        let proration = null;
        if (isUpgrade) {
            const periodStart = Date.parse(sub.current_period_start);
            const periodEnd = Date.parse(sub.current_period_end);
            const totalMs = Math.max(1, periodEnd - periodStart);
            const remainingRatio = Math.max(0, Math.min(1, (periodEnd - Date.now()) / totalMs));
            const currentPrice = (0, featureFlags_ts_1.planPrice)(current, sub.billing_cycle);
            const targetPrice = (0, featureFlags_ts_1.planPrice)(target, sub.billing_cycle);
            const unusedCredit = Math.round(currentPrice * remainingRatio);
            const newCharge = Math.round(targetPrice * remainingRatio);
            proration = { unusedCredit, newCharge, dueNow: Math.max(0, newCharge - unusedCredit) };
        }
        return {
            fromPlan: sub.plan_code,
            toPlan: targetPlanCode,
            effective: isUpgrade ? 'immediate' : 'next_cycle',
            proration,
            blockingIssues,
        };
    }
    /** Menerapkan perubahan paket. Perubahan menuntut re-autentikasi (SECURITY.md 16.3). */
    changePlan(targetPlanCode, options = {}) {
        this.ctx.require('subscription:write', { module: 'Manajemen Langganan & Paket' });
        this.ctx.requireWritable();
        const preview = this.previewPlanChange(targetPlanCode);
        if (preview.blockingIssues.length > 0 && !options.acknowledgeDowngradeLoss) {
            throw new errors_ts_1.ConflictError('error.downgrade_exceeds_new_quota', {
                issues: preview.blockingIssues,
            });
        }
        const sub = this.currentSubscription();
        const at = (0, db_ts_1.nowIso)();
        if (preview.effective === 'immediate') {
            this.ctx.db.update('subscriptions', { id: sub.id }, { plan_code: targetPlanCode, pending_plan_code: null, status: 'active' });
            if (preview.proration && preview.proration.dueNow > 0) {
                this.issueInvoice({
                    lines: [
                        { description: `Pro-rata upgrade ke ${targetPlanCode}`, amount: preview.proration.newCharge },
                        { description: 'Kredit sisa periode paket sebelumnya', amount: -preview.proration.unusedCredit },
                    ],
                    periodStart: at,
                    periodEnd: sub.current_period_end,
                    kind: 'proration',
                });
            }
        }
        else {
            // Downgrade berlaku awal siklus berikutnya.
            this.ctx.db.update('subscriptions', { id: sub.id }, { pending_plan_code: targetPlanCode });
        }
        this.ctx.log({
            action: 'subscription.plan_changed',
            module: 'Manajemen Langganan & Paket',
            objectType: 'subscription',
            objectId: sub.id,
            severity: 'critical',
            detail: {
                from: sub.plan_code,
                to: targetPlanCode,
                effective: preview.effective,
                proration: preview.proration,
            },
        });
        return preview;
    }
    /**
     * Konversi uji coba ke berbayar TANPA kehilangan data yang dibuat selama uji coba
     * (PRD 6.27) — hanya status langganan yang berubah, tidak ada data yang disentuh.
     */
    convertTrial(paymentToken, paymentMethodLabel) {
        this.ctx.require('subscription:write', { module: 'Manajemen Langganan & Paket' });
        this.ctx.requireWritable();
        const sub = this.currentSubscription();
        if (sub.status !== 'trialing')
            throw new errors_ts_1.ConflictError('error.not_in_trial');
        const plan = featureFlags_ts_1.PLAN_BY_CODE.get(sub.plan_code);
        const at = (0, db_ts_1.nowIso)();
        const periodEnd = periodEndFor(at, sub.billing_cycle);
        this.ctx.db.update('subscriptions', { id: sub.id }, {
            status: 'active',
            current_period_start: at,
            current_period_end: periodEnd,
            lapsed_at: null,
            renewal_reminded_for: null,
        });
        const invoice = this.issueInvoice({
            lines: [
                {
                    description: `${plan.name} — ${CYCLE_LABEL[sub.billing_cycle] ?? sub.billing_cycle}`,
                    amount: (0, featureFlags_ts_1.planPrice)(plan, sub.billing_cycle),
                },
            ],
            periodStart: at,
            periodEnd,
            kind: 'renewal',
            // Hanya token referensi & label; tidak ada nomor kartu (SECURITY.md 16.3).
            gatewayRef: paymentToken,
            paymentMethodLabel,
        });
        this.ctx.log({
            action: 'subscription.trial_converted',
            module: 'Manajemen Langganan & Paket',
            objectType: 'subscription',
            objectId: sub.id,
            severity: 'notice',
            detail: { plan: sub.plan_code, invoiceId: invoice.id },
        });
        return invoice;
    }
    /** Pembatalan dengan penjelasan kapan akses berakhir & berapa lama data disimpan. */
    cancel(reason) {
        this.ctx.require('subscription:write', { module: 'Manajemen Langganan & Paket' });
        this.ctx.requireWritable();
        const sub = this.currentSubscription();
        // `auto_renew` ikut dimatikan supaya penegakan masa berlaku tidak menerbitkan
        // faktur perpanjangan untuk periode yang justru baru saja dibatalkan pelanggan.
        this.ctx.db.update('subscriptions', { id: sub.id }, { cancel_at_period_end: 1, auto_renew: 0 });
        const accessEndsAt = sub.current_period_end;
        const dataRetainedUntil = new Date(Date.parse(accessEndsAt) + 90 * 86_400_000).toISOString();
        this.ctx.log({
            action: 'subscription.canceled',
            module: 'Manajemen Langganan & Paket',
            objectType: 'subscription',
            objectId: sub.id,
            severity: 'critical',
            detail: { reason, accessEndsAt, dataRetainedUntil },
        });
        return { accessEndsAt, dataRetainedUntil };
    }
    /* ---------------- Billing & Faktur — PRD 6.28 ---------------- */
    listInvoices() {
        this.ctx.require('billing:read', { module: 'Billing & Faktur' });
        this.ctx.requireModule('billing_invoice');
        return this.ctx.db
            .all('invoices', undefined, {
            orderBy: 'created_at DESC',
        })
            .map((i) => ({ ...i, lines: JSON.parse(i.lines_json) }));
    }
    issueInvoice(input) {
        const subtotal = input.lines.reduce((acc, l) => acc + l.amount, 0);
        const taxRate = input.taxRate ?? exports.DEFAULT_TAX_RATE;
        const taxAmount = Math.round(subtotal * taxRate);
        const at = (0, db_ts_1.nowIso)();
        const id = (0, db_ts_1.newId)('inv');
        const sequence = this.ctx.db.count('invoices') + 1;
        const number = `INV/${at.slice(0, 4)}/${String(sequence).padStart(5, '0')}`;
        const row = {
            id,
            number,
            period_start: input.periodStart,
            period_end: input.periodEnd,
            subtotal,
            tax_rate: taxRate,
            tax_amount: taxAmount,
            total: subtotal + taxAmount,
            currency: 'IDR',
            status: input.gatewayRef ? 'paid' : 'open',
            due_at: new Date(Date.now() + exports.GRACE_PERIOD_DAYS * 86_400_000).toISOString(),
            paid_at: input.gatewayRef ? at : null,
            gateway_ref: input.gatewayRef ?? null,
            payment_method_label: input.paymentMethodLabel ?? null,
            kind: input.kind ?? 'adhoc',
            lines_json: JSON.stringify(input.lines),
            created_at: at,
        };
        this.ctx.db.insert('invoices', row);
        this.ctx.log({
            action: 'billing.invoice_issued',
            module: 'Billing & Faktur',
            objectType: 'invoice',
            objectId: id,
            objectLabel: number,
            detail: { total: row.total, status: row.status },
        });
        return { ...row, lines: input.lines };
    }
    /**
     * Webhook dari payment gateway. Tanda tangan DIVERIFIKASI untuk mencegah pemalsuan
     * status pembayaran (SECURITY.md 16.3).
     */
    handleGatewayWebhook(rawBody, signatureHeader, secret) {
        const expected = (0, node_crypto_1.createHmac)('sha256', secret).update(rawBody).digest('hex');
        const provided = signatureHeader.replace(/^sha256=/, '');
        if (provided.length !== expected.length ||
            !(0, node_crypto_1.timingSafeEqual)(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'))) {
            this.ctx.log({
                action: 'billing.webhook_rejected',
                module: 'Billing & Faktur',
                objectType: 'webhook',
                outcome: 'denied',
                severity: 'critical',
                detail: { reason: 'invalid_signature' },
            });
            return { accepted: false, reasonKey: 'error.webhook_signature_invalid' };
        }
        const payload = JSON.parse(rawBody);
        const invoice = this.ctx.db.get('invoices', { id: payload.invoiceId });
        if (!invoice)
            return { accepted: false, reasonKey: 'error.not_found' };
        if (payload.event === 'payment.succeeded') {
            this.ctx.db.update('invoices', { id: payload.invoiceId }, { status: 'paid', paid_at: (0, db_ts_1.nowIso)(), gateway_ref: payload.gatewayRef ?? null });
            this.applyPaidInvoice(invoice);
        }
        else if (payload.event === 'payment.failed') {
            this.ctx.db.update('invoices', { id: payload.invoiceId }, { status: 'failed' });
            this.applyDunning();
        }
        this.ctx.log({
            action: 'billing.webhook_processed',
            module: 'Billing & Faktur',
            objectType: 'invoice',
            objectId: payload.invoiceId,
            objectLabel: invoice.number,
            detail: { event: payload.event },
        });
        return { accepted: true };
    }
    /* ---------------- Masa berlaku & perpanjangan — PRD 6.27 ---------------- */
    /**
     * Efek pelunasan sebuah faktur terhadap langganan.
     *
     * Faktur `renewal` MEMAJUKAN masa berlaku ke periode yang tercantum pada faktur itu
     * sendiri — bukan menghitung ulang dari "sekarang". Bedanya nyata: pelanggan yang
     * membayar tiga hari terlambat tetap mendapat periode penuh yang sudah ditagihkan
     * kepadanya, dan tidak kehilangan tiga hari yang sudah dibayar.
     */
    applyPaidInvoice(invoice) {
        const sub = this.currentSubscription();
        const updates = { status: 'active' };
        if (invoice.kind === 'renewal') {
            // Periode hasil perpanjangan TIDAK BOLEH berakhir di masa lalu.
            //
            // Faktur diterbitkan untuk periode yang dimulai saat masa berlaku habis, supaya
            // pelanggan yang membayar cepat tidak kehilangan hari. Tetapi pelanggan yang
            // terlambat lebih lama daripada satu siklus akan membeli periode yang sudah
            // lewat: ia membayar, lalu tetap terkunci — dan tidak ada penjelasan yang masuk
            // akal untuk itu. Selama masa tunggakan ruang kerjanya baca-saja, jadi waktu itu
            // memang tidak ia pakai; periodenya dihitung ulang dari saat pembayaran.
            const at = (0, db_ts_1.nowIso)();
            const start = Date.parse(invoice.period_end) <= Date.now() ? at : invoice.period_start;
            updates.current_period_start = start;
            updates.current_period_end =
                start === invoice.period_start ? invoice.period_end : periodEndFor(start, sub.billing_cycle);
            updates.lapsed_at = null;
            updates.renewal_reminded_for = null;
            // Downgrade yang ditunda berlaku di awal siklus berikutnya (PRD 6.27) — dan
            // siklus berikutnya baru saja dimulai.
            if (sub.pending_plan_code) {
                updates.plan_code = sub.pending_plan_code;
                updates.pending_plan_code = null;
            }
        }
        this.ctx.db.update('subscriptions', { id: sub.id }, updates);
        this.ctx.db.rawRun("UPDATE tenants SET status = 'active', suspended_at = NULL WHERE id = :tenant_id");
    }
    /**
     * Memperpanjang langganan dengan membayar faktur perpanjangan yang terbuka.
     *
     * Ini adalah JALAN KELUAR dari blokir kedaluwarsa, dan sengaja diizinkan meski tenant
     * sedang baca-saja: `requireWritable()` TIDAK dipanggil di sini. Kalau dipanggil,
     * blokirnya akan mengunci pintu perbaikannya sendiri — pelanggan yang masa berlakunya
     * habis tidak akan pernah bisa memperpanjang lewat aplikasi.
     */
    renew(paymentToken, paymentMethodLabel) {
        this.ctx.require('subscription:write', { module: 'Manajemen Langganan & Paket' });
        const sub = this.currentSubscription();
        const open = this.ctx.db.all('invoices', { kind: 'renewal' }, { orderBy: 'created_at DESC' });
        const unpaid = open.find((i) => i.id && this.invoiceStatus(i.id) !== 'paid');
        // Tidak ada faktur terbuka: pelanggan memperpanjang lebih awal. Terbitkan satu
        // untuk periode berikutnya, lalu bayar — sehingga jalurnya sama, bukan cabang
        // istimewa yang perilakunya berbeda.
        const invoice = unpaid ??
            (() => {
                const plan = featureFlags_ts_1.PLAN_BY_CODE.get(sub.plan_code);
                const start = (0, context_ts_1.subscriptionLapsed)(sub) ? (0, context_ts_1.subscriptionExpiresAt)(sub) : sub.current_period_end;
                return this.issueInvoice({
                    lines: [
                        {
                            description: `${plan.name} — perpanjangan ${CYCLE_LABEL[sub.billing_cycle] ?? sub.billing_cycle}`,
                            amount: (0, featureFlags_ts_1.planPrice)(plan, sub.billing_cycle),
                        },
                    ],
                    periodStart: start,
                    periodEnd: periodEndFor(start, sub.billing_cycle),
                    kind: 'renewal',
                });
            })();
        this.ctx.db.update('invoices', { id: invoice.id }, {
            status: 'paid',
            paid_at: (0, db_ts_1.nowIso)(),
            gateway_ref: paymentToken,
            payment_method_label: paymentMethodLabel,
        });
        this.applyPaidInvoice({
            kind: 'renewal',
            period_start: invoice.period_start,
            period_end: invoice.period_end,
        });
        this.ctx.log({
            action: 'subscription.renewed',
            module: 'Manajemen Langganan & Paket',
            objectType: 'subscription',
            objectId: sub.id,
            severity: 'notice',
            detail: {
                cycle: sub.billing_cycle,
                periodEnd: invoice.period_end,
                invoiceId: invoice.id,
            },
        });
        return this.invoiceById(invoice.id);
    }
    invoiceStatus(invoiceId) {
        return this.ctx.db.get('invoices', { id: invoiceId })?.status ?? 'unknown';
    }
    invoiceById(invoiceId) {
        const row = this.ctx.db.get('invoices', {
            id: invoiceId,
        });
        if (!row)
            throw new errors_ts_1.NotFoundError();
        return { ...row, lines: JSON.parse(row.lines_json) };
    }
    /**
     * Menegakkan masa berlaku langganan — dijalankan penjadwal, satu kali per tenant.
     *
     * Yang DIKERJAKAN di sini hanyalah hal-hal yang butuh berjalan sekali: menerbitkan
     * faktur perpanjangan, mengirim pengingat, menaikkan tangga penurunan akses, dan
     * mencatatnya di Log Aktivitas. Blokirnya sendiri TIDAK di sini — `loadFeatureFlags()`
     * menghitung kedaluwarsa dari tanggal pada setiap permintaan, jadi tenant yang masa
     * berlakunya habis sudah berhenti dapat menulis bahkan bila penjadwal belum sempat
     * berjalan (shared hosting me-recycle proses yang idle; sebagian host tanpa cron).
     *
     * Tangga penurunan aksesnya sama dengan tangga tunggakan (PRD 6.28):
     * tenggang → baca-saja → suspensi, dan DATA TIDAK PERNAH dihapus karena keterlambatan.
     */
    enforceLifecycle() {
        const sub = this.ctx.db.all('subscriptions', undefined, {
            orderBy: 'created_at DESC',
            limit: 1,
        })[0];
        if (!sub || sub.status === 'canceled')
            return { stage: 'canceled', actions: 0 };
        const now = Date.now();
        const expiresAt = (0, context_ts_1.subscriptionExpiresAt)(sub);
        const msLeft = Date.parse(expiresAt) - now;
        let actions = 0;
        /* --- Masih berlaku: paling banyak kirim satu pengingat per periode. --- */
        if (msLeft > 0) {
            const withinReminderWindow = msLeft <= exports.RENEWAL_REMINDER_DAYS * 86_400_000;
            if (withinReminderWindow && sub.renewal_reminded_for !== expiresAt) {
                this.remind(sub, expiresAt, Math.ceil(msLeft / 86_400_000));
                // Ditandai dengan TANGGAL BERAKHIR, bukan sekadar "sudah pernah": setelah
                // diperpanjang, tanggalnya berbeda dan pengingat berikutnya boleh terkirim,
                // tanpa perlu ada yang ingat membersihkan penanda.
                this.ctx.db.update('subscriptions', { id: sub.id }, { renewal_reminded_for: expiresAt });
                actions++;
                return { stage: 'reminded', actions };
            }
            return { stage: 'active', actions };
        }
        /* --- Sudah lewat. --- */
        const lapsedAt = sub.lapsed_at ?? expiresAt;
        if (!sub.lapsed_at) {
            this.ctx.db.update('subscriptions', { id: sub.id }, { lapsed_at: lapsedAt, status: 'past_due' });
            actions++;
            // Faktur perpanjangan hanya diterbitkan bila pelanggan memang berniat lanjut.
            // Yang sudah membatalkan tidak ditagih untuk periode yang tidak ia minta.
            if (sub.auto_renew === 1 && sub.cancel_at_period_end === 0) {
                const plan = featureFlags_ts_1.PLAN_BY_CODE.get(sub.plan_code);
                const nextPlanCode = sub.pending_plan_code ?? sub.plan_code;
                const nextPlan = featureFlags_ts_1.PLAN_BY_CODE.get(nextPlanCode) ?? plan;
                this.issueInvoice({
                    lines: [
                        {
                            description: `${nextPlan.name} — perpanjangan ${CYCLE_LABEL[sub.billing_cycle] ?? sub.billing_cycle}`,
                            amount: (0, featureFlags_ts_1.planPrice)(nextPlan, sub.billing_cycle),
                        },
                    ],
                    periodStart: expiresAt,
                    periodEnd: periodEndFor(expiresAt, sub.billing_cycle),
                    kind: 'renewal',
                });
                actions++;
            }
            this.notifyLapsed(sub, expiresAt);
            this.ctx.log({
                action: 'subscription.lapsed',
                module: 'Manajemen Langganan & Paket',
                objectType: 'subscription',
                objectId: sub.id,
                severity: 'warning',
                detail: {
                    expiredAt: expiresAt,
                    cycle: sub.billing_cycle,
                    wasTrial: sub.status === 'trialing',
                    autoRenew: sub.auto_renew === 1,
                },
            });
        }
        const daysLapsed = (now - Date.parse(lapsedAt)) / 86_400_000;
        let stage = 'grace';
        let tenantStatus = 'past_due';
        if (daysLapsed > exports.GRACE_PERIOD_DAYS * 2) {
            stage = 'suspended';
            tenantStatus = 'suspended';
        }
        else if (daysLapsed > exports.GRACE_PERIOD_DAYS) {
            stage = 'read_only';
            tenantStatus = 'read_only';
        }
        if (this.ctx.tenant.status !== tenantStatus) {
            this.ctx.db.rawRun('UPDATE tenants SET status = :status WHERE id = :tenant_id', {
                status: tenantStatus,
            });
            actions++;
            // Suspensi menutup pintu sepenuhnya, jadi sesi yang masih terbuka pun dicabut —
            // kalau tidak, tab yang sudah terbuka tetap dapat membaca sampai tokennya habis.
            if (stage === 'suspended') {
                this.ctx.db.rawRun(`UPDATE active_sessions SET revoked_at = :at, revoked_reason = 'subscription_expired'
            WHERE tenant_id = :tenant_id AND revoked_at IS NULL`, { at: (0, db_ts_1.nowIso)() });
            }
            this.ctx.log({
                action: 'subscription.access_downgraded',
                module: 'Manajemen Langganan & Paket',
                objectType: 'tenant',
                objectId: this.ctx.tenant.id,
                severity: stage === 'suspended' ? 'critical' : 'warning',
                detail: { stage, daysLapsed: Math.round(daysLapsed), expiredAt: expiresAt },
            });
        }
        return { stage, actions };
    }
    /**
     * Siapa yang diberi tahu soal masa berlaku.
     *
     * Hanya pemegang `super_admin` — satu-satunya peran standar yang berwenang membayar
     * dan mengubah langganan. Mengirim ke seluruh pengguna tenant akan membocorkan
     * keadaan komersial organisasi kepada orang yang tidak berkepentingan.
     */
    billingRecipients() {
        const rows = this.ctx.db.raw(`SELECT DISTINCT u.email AS email
         FROM system_user u
         JOIN role_assignment ra ON ra.user_id = u.id AND ra.tenant_id = :tenant_id
        WHERE u.tenant_id = :tenant_id AND u.status = 'active'
          AND ra.user_id = u.id AND ra.role_id = 'role_super_admin'`);
        return rows.map((r) => r.email);
    }
    remind(sub, expiresAt, daysLeft) {
        const plan = featureFlags_ts_1.PLAN_BY_CODE.get(sub.plan_code);
        for (const recipient of this.billingRecipients()) {
            this.outbox?.enqueue({
                tenantId: this.ctx.tenant.id,
                purpose: 'subscription_renewal_reminder',
                channel: 'email',
                recipient,
                subject: `[Vantik] Langganan ${plan.name} berakhir dalam ${daysLeft} hari`,
                body: `Langganan ${plan.name} (${CYCLE_LABEL[sub.billing_cycle] ?? sub.billing_cycle}) untuk ` +
                    `${this.ctx.tenant.name} berakhir pada ${expiresAt.slice(0, 10)}. ` +
                    `Setelah tanggal itu ruang kerja beralih ke mode baca-saja sampai diperpanjang; ` +
                    `data tidak dihapus.`,
            });
        }
        this.ctx.log({
            action: 'subscription.renewal_reminded',
            module: 'Manajemen Langganan & Paket',
            objectType: 'subscription',
            objectId: sub.id,
            detail: { expiresAt, daysLeft },
        });
    }
    notifyLapsed(sub, expiresAt) {
        const plan = featureFlags_ts_1.PLAN_BY_CODE.get(sub.plan_code);
        for (const recipient of this.billingRecipients()) {
            this.outbox?.enqueue({
                tenantId: this.ctx.tenant.id,
                purpose: 'subscription_expired',
                channel: 'email',
                recipient,
                subject: `[Vantik] Masa berlaku langganan ${plan.name} telah habis`,
                body: `Masa berlaku langganan ${this.ctx.tenant.name} berakhir pada ${expiresAt.slice(0, 10)}. ` +
                    `Ruang kerja kini BACA-SAJA: seluruh data tetap dapat dilihat dan diunduh, tetapi ` +
                    `perubahan dihentikan sampai langganan diperpanjang. Setelah ${exports.GRACE_PERIOD_DAYS * 2} hari ` +
                    `tanpa perpanjangan, akses ditangguhkan sepenuhnya — data tetap disimpan.`,
            });
        }
    }
    /**
     * Penurunan akses bertahap akibat kegagalan pembayaran (PRD 6.28).
     * Urutan: peringatan → masa tenggang → mode BACA-SAJA → suspensi.
     * Data tenant TIDAK PERNAH langsung dihapus akibat tunggakan.
     */
    applyDunning() {
        const overdue = this.ctx.db.all('invoices', { status: 'failed' });
        if (overdue.length === 0)
            return { stage: 'grace' };
        const oldestDue = Math.min(...overdue.map((i) => Date.parse(i.due_at)));
        const daysOverdue = (Date.now() - oldestDue) / 86_400_000;
        let stage = 'grace';
        let tenantStatus = 'past_due';
        if (daysOverdue > exports.GRACE_PERIOD_DAYS * 2) {
            stage = 'suspended';
            tenantStatus = 'suspended';
        }
        else if (daysOverdue > exports.GRACE_PERIOD_DAYS) {
            stage = 'read_only';
            tenantStatus = 'read_only';
        }
        this.ctx.db.rawRun('UPDATE tenants SET status = :status WHERE id = :tenant_id', { status: tenantStatus });
        this.ctx.log({
            action: 'billing.dunning_applied',
            module: 'Billing & Faktur',
            objectType: 'tenant',
            objectId: this.ctx.tenant.id,
            severity: stage === 'suspended' ? 'critical' : 'warning',
            detail: { stage, daysOverdue: Math.round(daysOverdue), overdueInvoices: overdue.length },
        });
        return { stage };
    }
    /** Faktur dalam bentuk teks siap cetak (PDF dirender frontend dari struktur ini). */
    invoiceDocument(invoiceId) {
        this.ctx.require('billing:read', { module: 'Billing & Faktur', objectId: invoiceId });
        const row = this.ctx.db.get('invoices', {
            id: invoiceId,
        });
        if (!row)
            throw new errors_ts_1.NotFoundError();
        this.ctx.log({
            action: 'billing.invoice_downloaded',
            module: 'Billing & Faktur',
            objectType: 'invoice',
            objectId: invoiceId,
            objectLabel: row.number,
        });
        return {
            invoice: { ...row, lines: JSON.parse(row.lines_json) },
            tenant: { name: this.ctx.tenant.name, taxId: null },
            issuer: { name: 'Vantik Analytics' },
        };
    }
}
exports.BillingService = BillingService;
//# sourceMappingURL=index.js.map