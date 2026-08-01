"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenantService = exports.POST_CANCELLATION_RETENTION_DAYS = void 0;
const db_ts_1 = require("../platform/db.js");
const errors_ts_1 = require("../platform/errors.js");
const crypto_ts_1 = require("../platform/crypto.js");
const featureFlags_ts_1 = require("../platform/featureFlags.js");
const tenancy_ts_1 = require("../platform/tenancy.js");
const index_ts_1 = require("../identity-service/index.js");
/** Retensi data setelah berhenti berlangganan sebelum penghapusan permanen. */
exports.POST_CANCELLATION_RETENTION_DAYS = 90;
class TenantService {
    db;
    audit;
    operator;
    constructor(db, audit) {
        this.db = db;
        this.audit = audit;
        this.operator = new tenancy_ts_1.PlatformOperatorDb(db);
    }
    /** Menanam katalog paket (idempoten). */
    seedPlans() {
        const insert = this.db.prepare(`INSERT OR REPLACE INTO plans (code, name, monthly_price, annual_price,
                                     features_json, quotas_json, sort_order)
       VALUES (?,?,?,?,?,?,?)`);
        for (const plan of featureFlags_ts_1.PLAN_CATALOG) {
            insert.run(plan.code, plan.name, plan.monthlyPrice, plan.annualPrice, JSON.stringify(plan.features), JSON.stringify({ quotas: plan.quotas, overBehaviour: plan.overBehaviour }), plan.sortOrder);
        }
        (0, index_ts_1.seedStandardRoles)(this.db);
    }
    /**
     * Provisioning tenant baru — otomatis saat pendaftaran (PRD 6.26).
     * Menyiapkan tenant, langganan uji coba, pegawai admin, akun admin, dan peran.
     */
    provision(input, actorLabel = 'system') {
        if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(input.slug)) {
            throw new errors_ts_1.ValidationError('error.invalid_tenant_slug');
        }
        if (this.db.prepare('SELECT 1 FROM tenants WHERE slug = ?').get(input.slug)) {
            throw new errors_ts_1.ConflictError('error.tenant_slug_taken');
        }
        if (!featureFlags_ts_1.PLAN_BY_CODE.has(input.planCode)) {
            throw new errors_ts_1.ValidationError('error.plan_unknown', { plan: input.planCode });
        }
        // Siklus divalidasi DI SINI, bukan hanya di rute HTTP: provisioning juga dipanggil
        // dari seed dan dari alat operator, dan siklus yang tidak dikenal akan tersimpan
        // sebagai masa berlaku satu bulan tanpa ada yang menyadarinya.
        if (!(0, featureFlags_ts_1.isBillingCycle)(input.billingCycle)) {
            throw new errors_ts_1.ValidationError('error.billing_cycle_unknown', { cycle: input.billingCycle });
        }
        const policy = (0, crypto_ts_1.validatePasswordPolicy)(input.admin.password);
        if (!policy.ok)
            throw new errors_ts_1.ValidationError(policy.reasonKey);
        const at = (0, db_ts_1.nowIso)();
        const tenantId = (0, db_ts_1.newId)('ten');
        const employeeId = (0, db_ts_1.newId)('emp');
        const adminUserId = (0, db_ts_1.newId)('usr');
        const trialDays = input.trialDays ?? 14;
        const trialEnds = new Date(Date.now() + trialDays * 86_400_000).toISOString();
        this.db.transaction(() => {
            this.db
                .prepare(`INSERT INTO tenants (id, name, slug, status, isolation_level, accent_color, logo_text,
                                white_label, default_locale, max_devices_per_user, created_at,
                                approval_status, approval_requested_at)
           VALUES (?,?,?,'trial',?,NULL,NULL,?,?,1,?,?,?)`)
                .run(tenantId, input.name, input.slug, input.isolationLevel ?? (input.planCode === 'enterprise' ? 'separate_schema' : 'shared_schema'), input.planCode === 'enterprise' ? 1 : 0, input.defaultLocale ?? 'id', at, input.requiresApproval ? 'pending' : 'approved', input.requiresApproval ? at : null);
            this.db
                .prepare(`INSERT INTO subscriptions (id, tenant_id, plan_code, billing_cycle, status, trial_ends_at,
                                      current_period_start, current_period_end, cancel_at_period_end,
                                      pending_plan_code, created_at)
           VALUES (?,?,?,?,'trialing',?,?,?,0,NULL,?)`)
                .run((0, db_ts_1.newId)('sub'), tenantId, input.planCode, input.billingCycle, trialEnds, at, trialEnds, at);
            this.db
                .prepare(`INSERT INTO employee_master (id, tenant_id, full_name, nik, division, position, email,
                                        phone, status, status_changed_at, access_review_due_at,
                                        created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,NULL,'active',?,NULL,?,?)`)
                .run(employeeId, tenantId, input.admin.fullName, input.admin.nik, input.admin.division ?? 'Administrasi', input.admin.position ?? 'Administrator', input.admin.email.toLowerCase(), at, at, at);
            this.db
                .prepare(`INSERT INTO system_user (id, tenant_id, employee_id, email, password_hash, auth_provider,
                                    mfa_enrolled, status, locale, theme, failed_attempts, locked_until,
                                    last_login_at, password_history_json, created_at, updated_at, disabled_at)
           VALUES (?,?,?,?,?, 'local', 0, 'active', ?, 'light', 0, NULL, NULL, '[]', ?, ?, NULL)`)
                .run(adminUserId, tenantId, employeeId, input.admin.email.toLowerCase(), (0, crypto_ts_1.hashPassword)(input.admin.password), input.defaultLocale ?? 'id', at, at);
            this.db
                .prepare(`INSERT INTO role_assignment (id, tenant_id, user_id, role_id, assigned_at, assigned_by)
           VALUES (?,?,?,?,?,'system')`)
                .run((0, db_ts_1.newId)('ra'), tenantId, adminUserId, 'role_super_admin', at);
        })();
        this.audit.record({
            tenantId,
            actorLabel,
            action: 'tenant.provisioned',
            module: 'Manajemen Tenant',
            objectType: 'tenant',
            objectId: tenantId,
            objectLabel: input.name,
            severity: 'notice',
            operatorAccess: true,
            detail: { plan: input.planCode, billingCycle: input.billingCycle, trialDays },
        });
        return { tenantId, adminUserId };
    }
    /** Daftar tenant untuk Platform Operator. */
    listTenants(ctx) {
        ctx.require('tenant:read', { module: 'Manajemen Tenant' });
        if (!ctx.can('tenant:provision')) {
            // Admin tenant biasa hanya melihat tenantnya sendiri.
            const own = this.operator.getTenant(ctx.tenant.id);
            return own ? [own] : [];
        }
        return this.operator.listTenants();
    }
    /* ---------------- Persetujuan pendaftaran mandiri ---------------- */
    /**
     * Antrean pendaftaran yang menunggu keputusan.
     *
     * Hanya untuk peran yang berwenang membuat tenant (`tenant:provision`) — Platform
     * Operator. Admin sebuah tenant TIDAK boleh melihat pendaftaran organisasi lain;
     * daftar ini memuat nama organisasi dan email calon administrator, yang bukan
     * urusannya.
     */
    listPendingRegistrations(ctx) {
        ctx.require('tenant:provision', { module: 'Manajemen Tenant' });
        return this.db
            .prepare(`SELECT t.id, t.name, t.slug, t.approval_requested_at, t.created_at,
                s.plan_code, s.billing_cycle,
                u.email AS admin_email, e.full_name AS admin_name
           FROM tenants t
           JOIN subscriptions s ON s.tenant_id = t.id
           JOIN system_user   u ON u.tenant_id = t.id
           JOIN employee_master e ON e.id = u.employee_id
          WHERE t.approval_status = 'pending' AND t.deleted_at IS NULL
          GROUP BY t.id
          ORDER BY t.approval_requested_at ASC`)
            .all();
    }
    /**
     * Menyetujui atau menolak sebuah pendaftaran.
     *
     * Penolakan TIDAK menghapus apa pun. Data pendaftar tetap ada sampai retensi berjalan,
     * dan alasannya tersimpan — keputusan yang tidak dapat ditinjau ulang bukan keputusan
     * administratif, melainkan penghapusan yang tidak tercatat.
     */
    decideRegistration(ctx, tenantId, decision, note) {
        ctx.require('tenant:provision', { module: 'Manajemen Tenant', objectId: tenantId });
        const tenant = this.db
            .prepare("SELECT id, name, approval_status FROM tenants WHERE id = ? AND deleted_at IS NULL")
            .get(tenantId);
        if (!tenant)
            throw new errors_ts_1.NotFoundError();
        // Keputusan hanya berlaku sekali. Tanpa penjagaan ini, "setujui" pada tenant yang
        // sudah lama aktif akan menulis ulang tanggal keputusannya dan mengaburkan riwayat.
        if (tenant.approval_status !== 'pending') {
            throw new errors_ts_1.ConflictError('error.registration_already_decided', {
                approvalStatus: tenant.approval_status,
            });
        }
        if (decision === 'rejected' && !note?.trim()) {
            // Penolakan tanpa alasan tidak dapat dijelaskan kepada pendaftar, dan tidak dapat
            // ditinjau kemudian.
            throw new errors_ts_1.ValidationError('error.rejection_reason_required');
        }
        const at = (0, db_ts_1.nowIso)();
        this.db
            .prepare(`UPDATE tenants
            SET approval_status = ?, approval_decided_at = ?, approval_decided_by = ?, approval_note = ?
          WHERE id = ?`)
            .run(decision, at, ctx.actor.userId, note?.trim() ?? null, tenantId);
        this.audit.record({
            tenantId,
            actorUserId: ctx.actor.userId,
            actorLabel: ctx.actor.displayName,
            actorIp: ctx.ip,
            action: decision === 'approved' ? 'tenant.registration_approved' : 'tenant.registration_rejected',
            module: 'Manajemen Tenant',
            objectType: 'tenant',
            objectId: tenantId,
            objectLabel: tenant.name,
            severity: 'critical',
            operatorAccess: true,
            detail: { note: note?.trim() ?? null },
        });
        return { tenantId, approvalStatus: decision };
    }
    /** Alamat administrator pertama sebuah tenant — penerima kabar keputusan. */
    registrationContact(tenantId) {
        return this.db
            .prepare(`SELECT u.email AS email, e.full_name AS name, t.name AS tenantName
           FROM system_user u
           JOIN employee_master e ON e.id = u.employee_id
           JOIN tenants t ON t.id = u.tenant_id
          WHERE u.tenant_id = ?
          ORDER BY u.created_at ASC LIMIT 1`)
            .get(tenantId);
    }
    /** Alamat seluruh Platform Operator aktif — penerima kabar pendaftaran baru. */
    operatorContacts() {
        return this.db
            .prepare(`SELECT DISTINCT u.email AS email
             FROM system_user u
             JOIN role_assignment ra ON ra.user_id = u.id
            WHERE ra.role_id = 'role_platform_operator' AND u.status = 'active'`)
            .all().map((r) => r.email);
    }
    /**
     * Suspensi tenant TANPA menghapus data (PRD 6.26, SECURITY.md 16.4).
     * Urutan penurunan akses: peringatan → masa tenggang → mode baca-saja → suspensi.
     */
    suspend(ctx, tenantId, reason) {
        ctx.require('tenant:suspend', { module: 'Manajemen Tenant', objectId: tenantId });
        const tenant = this.operator.getTenant(tenantId);
        if (!tenant)
            throw new errors_ts_1.NotFoundError();
        const at = (0, db_ts_1.nowIso)();
        this.db.prepare("UPDATE tenants SET status = 'suspended', suspended_at = ? WHERE id = ?").run(at, tenantId);
        this.db
            .prepare("UPDATE active_sessions SET revoked_at = ?, revoked_reason = 'tenant_suspended' WHERE tenant_id = ? AND revoked_at IS NULL")
            .run(at, tenantId);
        this.audit.record({
            tenantId,
            actorUserId: ctx.actor.userId,
            actorLabel: ctx.actor.displayName,
            action: 'tenant.suspended',
            module: 'Manajemen Tenant',
            objectType: 'tenant',
            objectId: tenantId,
            objectLabel: String(tenant.name),
            severity: 'critical',
            operatorAccess: true,
            detail: { reason },
        });
    }
    restore(ctx, tenantId) {
        ctx.require('tenant:suspend', { module: 'Manajemen Tenant', objectId: tenantId });
        if (!this.operator.getTenant(tenantId))
            throw new errors_ts_1.NotFoundError();
        this.db.prepare("UPDATE tenants SET status = 'active', suspended_at = NULL WHERE id = ?").run(tenantId);
        this.audit.record({
            tenantId,
            actorUserId: ctx.actor.userId,
            actorLabel: ctx.actor.displayName,
            action: 'tenant.restored',
            module: 'Manajemen Tenant',
            objectType: 'tenant',
            objectId: tenantId,
            severity: 'notice',
            operatorAccess: true,
        });
    }
    /** Identitas visual per tenant, dalam batas paket (PRD 6.26). */
    configureBranding(ctx, branding) {
        ctx.require('tenant:configure', { module: 'Manajemen Tenant' });
        ctx.requireWritable();
        if (branding.accentColor && !/^#[0-9A-Fa-f]{6}$/.test(branding.accentColor)) {
            throw new errors_ts_1.ValidationError('error.invalid_color');
        }
        // White-label penuh hanya untuk Enterprise (PRD 2.1).
        if (branding.logoText && ctx.flags.planCode !== 'enterprise') {
            throw new errors_ts_1.ForbiddenError('error.white_label_requires_enterprise');
        }
        if (branding.maxDevicesPerUser !== undefined && branding.maxDevicesPerUser < 1) {
            throw new errors_ts_1.ValidationError('error.invalid_device_limit');
        }
        const updates = [];
        const params = [];
        if (branding.accentColor !== undefined) {
            updates.push('accent_color = ?');
            params.push(branding.accentColor);
        }
        if (branding.logoText !== undefined) {
            updates.push('logo_text = ?');
            params.push(branding.logoText);
        }
        if (branding.defaultLocale !== undefined) {
            updates.push('default_locale = ?');
            params.push(branding.defaultLocale);
        }
        if (branding.maxDevicesPerUser !== undefined) {
            updates.push('max_devices_per_user = ?');
            params.push(branding.maxDevicesPerUser);
        }
        if (updates.length === 0)
            return;
        params.push(ctx.tenant.id);
        this.db.prepare(`UPDATE tenants SET ${updates.join(', ')} WHERE id = ?`).run(...params);
        ctx.log({
            action: 'tenant.branding_configured',
            module: 'Manajemen Tenant',
            objectType: 'tenant',
            objectId: ctx.tenant.id,
            detail: branding,
        });
    }
    /**
     * Ekspor seluruh data tenant — data portability saat berhenti berlangganan
     * (PRD 6.26, SECURITY.md 16.4). Tenant berhak mengekspor sebelum & selama retensi.
     */
    exportTenantData(ctx) {
        ctx.require('tenant:read', { module: 'Manajemen Tenant' });
        const tables = [
            'employee_master',
            'system_user',
            'role_assignment',
            'rls_rules',
            'dataset_catalog',
            'dataset_columns',
            'dataset_rows',
            'external_connections',
            'model_tables',
            'model_fields',
            'business_dictionary',
            'kpi_definition',
            'kpi_threshold',
            'kpi_score_history',
            'alert_rules',
            'alert_events',
            'dashboards',
            'reports',
            'assets',
            'sensor_definitions',
            'bsc_perspectives',
            'bsc_objectives',
        ];
        const out = {};
        for (const table of tables) {
            out[table] = ctx.db.all(table);
            // Kredensial TIDAK ikut diekspor — vault tetap tertutup meski data lain keluar.
        }
        out.audit_log = ctx.auditService().query(ctx.tenant.id, { limit: 100_000 }).rows;
        ctx.log({
            action: 'tenant.data_exported',
            module: 'Manajemen Tenant',
            objectType: 'tenant',
            objectId: ctx.tenant.id,
            severity: 'critical',
            detail: { tables: tables.length },
        });
        return out;
    }
    /**
     * Menandai tenant untuk penghapusan setelah periode retensi.
     * SECURITY.md 16.4: penghapusan permanen hanya setelah periode retensi yang
     * diumumkan di muka — tunggakan TIDAK PERNAH menyebabkan penghapusan seketika.
     */
    scheduleDeletion(ctx, tenantId) {
        ctx.require('tenant:suspend', { module: 'Manajemen Tenant', objectId: tenantId });
        if (!this.operator.getTenant(tenantId))
            throw new errors_ts_1.NotFoundError();
        const at = (0, db_ts_1.nowIso)();
        const retentionUntil = new Date(Date.now() + exports.POST_CANCELLATION_RETENTION_DAYS * 86_400_000).toISOString();
        this.db.prepare('UPDATE tenants SET deleted_at = ?, retention_until = ? WHERE id = ?').run(at, retentionUntil, tenantId);
        this.audit.record({
            tenantId,
            actorUserId: ctx.actor.userId,
            actorLabel: ctx.actor.displayName,
            action: 'tenant.deletion_scheduled',
            module: 'Manajemen Tenant',
            objectType: 'tenant',
            objectId: tenantId,
            severity: 'critical',
            operatorAccess: true,
            detail: { retentionUntil, retentionDays: exports.POST_CANCELLATION_RETENTION_DAYS },
        });
        return { retentionUntil };
    }
    /** Jejak akses Platform Operator yang dapat dilihat tenant (SECURITY.md 16.2). */
    operatorAccessTrail(ctx) {
        ctx.require('tenant:read', { module: 'Manajemen Tenant' });
        return this.audit.operatorTrail(ctx.tenant.id);
    }
}
exports.TenantService = TenantService;
//# sourceMappingURL=index.js.map