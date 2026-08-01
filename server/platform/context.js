"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RequestContext = exports.SENSITIVE_PERMISSIONS = void 0;
exports.toTenantInfo = toTenantInfo;
exports.subscriptionExpiresAt = subscriptionExpiresAt;
exports.subscriptionLapsed = subscriptionLapsed;
exports.loadFeatureFlags = loadFeatureFlags;
const errors_ts_1 = require("./errors.js");
const featureFlags_ts_1 = require("./featureFlags.js");
const rbac_ts_1 = require("./rbac.js");
const rls_ts_1 = require("./rls.js");
const tenancy_ts_1 = require("./tenancy.js");
/** Aksi yang menuntut re-autentikasi segar (SECURITY.md Bagian 4 & 16.3). */
const REAUTH_WINDOW_MS = 5 * 60 * 1000;
exports.SENSITIVE_PERMISSIONS = new Set([
    'authorization:write',
    'subscription:write',
    'billing:write',
    'device:unbind',
    'device:approve_transfer',
]);
class RequestContext {
    tenant;
    actor;
    flags;
    audit;
    ip;
    db;
    permissions;
    constructor(rawDb, tenant, actor, roles, flags, audit, ip, rlsScope) {
        this.tenant = tenant;
        this.actor = actor;
        this.flags = flags;
        this.audit = audit;
        this.ip = ip;
        this.db = new tenancy_ts_1.TenantScopedDb(rawDb, tenant.id);
        this.permissions = (0, rbac_ts_1.resolvePermissions)(roles);
        this.rls = rlsScope ?? (0, rls_ts_1.loadRlsScope)(this.db, actor.userId, actor.roleIds);
    }
    rls;
    can(permission) {
        return (0, rbac_ts_1.can)(this.permissions, permission);
    }
    /**
     * Memeriksa izin; bila ditolak, mencatat percobaan akses ke Log Aktivitas SEBELUM
     * melempar. SECURITY.md Bagian 9 & TESTING.md Bagian 4 menuntut penolakan tercatat,
     * bukan hanya dibalas 403.
     */
    require(permission, context) {
        // Penegakan MFA mendahului pemeriksaan izin.
        //
        // Peran yang menandai `mfaRequired` (Data Engineer, Data Steward, System Admin,
        // Super Admin, Platform Operator) tidak boleh dipakai sebelum MFA diaktifkan.
        // Diperiksa di SINI, bukan di setiap rute, karena satu rute yang lupa memeriksa
        // akan membatalkan seluruh kontrolnya — pola yang sama dengan alasan `TenantScopedDb`
        // tidak pernah memberi koneksi mentah.
        //
        // Endpoint pendaftaran MFA sengaja tidak memakai `require()`: ia hanya menyentuh
        // akun pemanggil sendiri. Tanpa pengecualian itu, pengguna yang wajib MFA tetapi
        // belum mendaftar akan terkunci total — tidak dapat bekerja DAN tidak dapat
        // mendaftar.
        this.requireMfaEnrolment(context.module);
        if (this.can(permission)) {
            if (exports.SENSITIVE_PERMISSIONS.has(permission))
                this.requireFreshAuth(permission, context.module);
            return;
        }
        this.audit.recordDenial({
            tenantId: this.tenant.id,
            actorUserId: this.actor.userId,
            actorLabel: this.actor.displayName,
            actorIp: this.ip,
            action: 'access.denied',
            module: context.module,
            objectType: 'permission',
            objectId: context.objectId ?? permission,
            objectLabel: context.objectLabel ?? permission,
            detail: { permission, roles: this.actor.roleCodes },
        });
        throw new errors_ts_1.ForbiddenError('error.forbidden', { permission });
    }
    /** Apakah peran pengguna mewajibkan MFA sementara MFA-nya belum aktif? */
    get mfaEnrolmentPending() {
        return (0, rbac_ts_1.requiresMfa)(this.actor.roleCodes) && !this.actor.mfaEnrolled;
    }
    /**
     * Menolak seluruh pemakaian izin sampai MFA diaktifkan, bila peran mewajibkannya.
     *
     * Kuncinya 403 dengan kunci pemulihan yang JELAS, bukan 401: pengguna sudah
     * terautentikasi dengan benar, yang kurang adalah faktor kedua. Membalas 401 akan
     * membuat klien menganggap sesinya kedaluwarsa dan memaksa login berulang tanpa
     * pernah memberi tahu apa yang harus dilakukan.
     */
    requireMfaEnrolment(module) {
        if (!this.mfaEnrolmentPending)
            return;
        this.audit.recordDenial({
            tenantId: this.tenant.id,
            actorUserId: this.actor.userId,
            actorLabel: this.actor.displayName,
            actorIp: this.ip,
            action: 'access.mfa_enrolment_required',
            module,
            objectType: 'user',
            objectId: this.actor.userId,
            detail: { roles: this.actor.roleCodes },
        });
        throw new errors_ts_1.ForbiddenError('error.mfa_enrolment_required', {
            recoveryKey: 'recovery.enrol_mfa',
            roles: this.actor.roleCodes,
        });
    }
    /** Aksi sensitif menuntut re-autentikasi dalam jendela waktu pendek. */
    requireFreshAuth(permission, module) {
        const at = this.actor.reauthAt ? Date.parse(this.actor.reauthAt) : 0;
        if (Date.now() - at <= REAUTH_WINDOW_MS)
            return;
        this.audit.recordDenial({
            tenantId: this.tenant.id,
            actorUserId: this.actor.userId,
            actorLabel: this.actor.displayName,
            actorIp: this.ip,
            action: 'access.reauth_required',
            module,
            objectType: 'permission',
            objectId: permission,
        });
        throw new errors_ts_1.ForbiddenError('error.reauth_required', { permission });
    }
    /** Modul yang dimatikan paket langganan berperilaku seolah tidak ada (PRD 6.27). */
    requireModule(module) {
        if (this.flags.isEnabled(module))
            return;
        throw new errors_ts_1.ForbiddenError('error.module_not_in_plan', { module, plan: this.flags.planCode });
    }
    /**
     * Tenant dalam mode baca-saja akibat tunggakan atau masa berlaku habis
     * (SECURITY.md 16.4, PRD 6.27/6.28).
     *
     * Membaca tetap diizinkan dengan sengaja: data pelanggan tidak disandera, hanya
     * perubahan yang dihentikan sampai langganan dipulihkan.
     */
    requireWritable() {
        if (this.flags.readOnlyReason === 'subscription_expired') {
            throw new errors_ts_1.ForbiddenError('error.subscription_expired', {
                recoveryKey: 'recovery.renew_subscription',
                expiredAt: this.flags.expiresAt,
                status: this.tenant.status,
            });
        }
        if (this.flags.readOnly || this.tenant.status === 'read_only' || this.tenant.status === 'suspended') {
            throw new errors_ts_1.ForbiddenError('error.tenant_read_only', { status: this.tenant.status });
        }
    }
    /** Mencatat peristiwa dengan aktor & tenant sudah terisi dari konteks. */
    log(entry) {
        this.audit.record({
            ...entry,
            tenantId: this.tenant.id,
            actorUserId: this.actor.userId,
            actorLabel: this.actor.displayName,
            actorIp: this.ip,
        });
    }
    auditService() {
        return this.audit;
    }
}
exports.RequestContext = RequestContext;
function toTenantInfo(row) {
    return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        status: row.status,
        accentColor: row.accent_color,
        logoText: row.logo_text,
        whiteLabel: row.white_label === 1,
        defaultLocale: row.default_locale,
        maxDevicesPerUser: row.max_devices_per_user,
    };
}
/**
 * Batas masa berlaku yang sesungguhnya.
 *
 * Selama uji coba, yang mengikat adalah akhir uji coba; setelah berbayar, akhir periode
 * berjalan. Keduanya tersimpan di baris yang sama, dan memilih yang keliru berarti uji
 * coba 14 hari tetap dapat menulis sampai akhir periode langganan yang belum pernah
 * dibayar.
 */
function subscriptionExpiresAt(sub) {
    return sub.status === 'trialing' ? (sub.trial_ends_at ?? sub.current_period_end) : sub.current_period_end;
}
/** Benar bila masa berlaku sudah terlampaui pada saat dipanggil. */
function subscriptionLapsed(sub, at = Date.now()) {
    return Date.parse(subscriptionExpiresAt(sub)) <= at;
}
/**
 * Menyusun feature flag efektif dari langganan aktif tenant.
 *
 * Masa berlaku dihitung DI SINI, dari tanggal, pada setiap permintaan — bukan dibaca
 * dari status yang sudah dituliskan penjadwal. Alasannya adalah kenyataan shared
 * hosting: Passenger mematikan proses yang idle, dan sebagian host tidak punya cron,
 * jadi penjadwal bisa saja belum berjalan sejak masa berlaku habis. Kalau blokir
 * bergantung padanya, langganan yang kedaluwarsa tetap dapat menulis sampai ada yang
 * kebetulan membangunkan penjadwal — persis kegagalan senyap yang hendak dicegah.
 *
 * Penjadwal tetap ada, tetapi tugasnya lain: MENERBITKAN faktur perpanjangan, menaikkan
 * tangga penurunan akses, dan memberi tahu pelanggan. Blokirnya sendiri tidak menunggu
 * siapa pun.
 */
function loadFeatureFlags(db, tenantId, tenantStatus) {
    const sub = db
        .prepare(`SELECT plan_code, status, trial_ends_at, current_period_end FROM subscriptions
        WHERE tenant_id = ? AND status IN ('trialing','active','past_due')
        ORDER BY created_at DESC LIMIT 1`)
        .get(tenantId);
    const planCode = sub?.plan_code ?? 'starter';
    const plan = featureFlags_ts_1.PLAN_BY_CODE.get(planCode) ?? featureFlags_ts_1.PLAN_BY_CODE.get('starter');
    const lapsed = sub !== undefined && subscriptionLapsed(sub);
    const blockedByStatus = tenantStatus === 'read_only' || tenantStatus === 'past_due';
    return new featureFlags_ts_1.FeatureFlags(plan, {}, lapsed || blockedByStatus, 
    // Masa berlaku habis disebut lebih dulu: itu sebab yang dapat diselesaikan sendiri
    // oleh pelanggan, dan status tenant `past_due` biasanya hanyalah akibatnya.
    lapsed ? 'subscription_expired' : blockedByStatus ? 'tenant_status' : null, sub ? subscriptionExpiresAt(sub) : null);
}
//# sourceMappingURL=context.js.map