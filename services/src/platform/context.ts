/**
 * Konteks permintaan — satu-satunya tempat identitas, tenant, peran, RLS, dan feature
 * flag dirangkai. Modul fungsional menerima objek ini, bukan merakit sendiri.
 *
 * ARCHITECTURE.md 5.1 / SECURITY.md 16.1: `tenant_id` SELALU berasal dari konteks sesi
 * terverifikasi di server — tidak pernah dari header, query string, atau body.
 */
import type { AuditEntry, AuditService } from '../audit-service/index.ts';
import type { Db } from './db.ts';
import { ForbiddenError } from './errors.ts';
import { FeatureFlags, PLAN_BY_CODE, type ModuleKey, type PlanDefinition } from './featureFlags.ts';
import { can, requiresMfa, resolvePermissions, type EffectivePermissions, type Permission } from './rbac.ts';
import { resolvePlan } from './planCatalog.ts';
import { loadRlsScope, RlsScope } from './rls.ts';
import { TenantScopedDb } from './tenancy.ts';

export interface ActorIdentity {
  userId: string;
  employeeId: string;
  email: string;
  displayName: string;
  locale: 'id' | 'en';
  theme: 'light' | 'dark';
  roleIds: string[];
  roleCodes: string[];
  sessionId: string;
  /** Waktu re-autentikasi terakhir; aksi sensitif menuntut nilai yang masih segar (SECURITY.md 4). */
  reauthAt: string | null;
  mfaEnrolled: boolean;
}

export interface TenantInfo {
  id: string;
  name: string;
  slug: string;
  status: string;
  accentColor: string | null;
  logoText: string | null;
  whiteLabel: boolean;
  defaultLocale: string;
  maxDevicesPerUser: number;
}

/** Aksi yang menuntut re-autentikasi segar (SECURITY.md Bagian 4 & 16.3). */
const REAUTH_WINDOW_MS = 5 * 60 * 1000;
export const SENSITIVE_PERMISSIONS = new Set<Permission>([
  'authorization:write',
  'subscription:write',
  'billing:write',
  'device:unbind',
  'device:approve_transfer',
]);

export class RequestContext {
  readonly db: TenantScopedDb;
  readonly permissions: EffectivePermissions;

  constructor(
    rawDb: Db,
    readonly tenant: TenantInfo,
    readonly actor: ActorIdentity,
    roles: Array<{ permissions: Permission[]; denials: Permission[] }>,
    readonly flags: FeatureFlags,
    private readonly audit: AuditService,
    readonly ip: string | null,
    rlsScope?: RlsScope,
  ) {
    this.db = new TenantScopedDb(rawDb, tenant.id);
    this.permissions = resolvePermissions(roles);
    this.rls = rlsScope ?? loadRlsScope(this.db, actor.userId, actor.roleIds);
  }

  readonly rls: RlsScope;

  can(permission: Permission): boolean {
    return can(this.permissions, permission);
  }

  /**
   * Memeriksa izin; bila ditolak, mencatat percobaan akses ke Log Aktivitas SEBELUM
   * melempar. SECURITY.md Bagian 9 & TESTING.md Bagian 4 menuntut penolakan tercatat,
   * bukan hanya dibalas 403.
   */
  require(permission: Permission, context: { module: string; objectId?: string; objectLabel?: string }): void {
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
      if (SENSITIVE_PERMISSIONS.has(permission)) this.requireFreshAuth(permission, context.module);
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
    throw new ForbiddenError('error.forbidden', { permission });
  }

  /** Apakah peran pengguna mewajibkan MFA sementara MFA-nya belum aktif? */
  get mfaEnrolmentPending(): boolean {
    return requiresMfa(this.actor.roleCodes) && !this.actor.mfaEnrolled;
  }

  /**
   * Menolak seluruh pemakaian izin sampai MFA diaktifkan, bila peran mewajibkannya.
   *
   * Kuncinya 403 dengan kunci pemulihan yang JELAS, bukan 401: pengguna sudah
   * terautentikasi dengan benar, yang kurang adalah faktor kedua. Membalas 401 akan
   * membuat klien menganggap sesinya kedaluwarsa dan memaksa login berulang tanpa
   * pernah memberi tahu apa yang harus dilakukan.
   */
  private requireMfaEnrolment(module: string): void {
    if (!this.mfaEnrolmentPending) return;
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
    throw new ForbiddenError('error.mfa_enrolment_required', {
      recoveryKey: 'recovery.enrol_mfa',
      roles: this.actor.roleCodes,
    });
  }

  /** Aksi sensitif menuntut re-autentikasi dalam jendela waktu pendek. */
  private requireFreshAuth(permission: Permission, module: string): void {
    const at = this.actor.reauthAt ? Date.parse(this.actor.reauthAt) : 0;
    if (Date.now() - at <= REAUTH_WINDOW_MS) return;
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
    throw new ForbiddenError('error.reauth_required', { permission });
  }

  /** Modul yang dimatikan paket langganan berperilaku seolah tidak ada (PRD 6.27). */
  requireModule(module: ModuleKey): void {
    if (this.flags.isEnabled(module)) return;
    throw new ForbiddenError('error.module_not_in_plan', { module, plan: this.flags.planCode });
  }

  /**
   * Tenant dalam mode baca-saja akibat tunggakan atau masa berlaku habis
   * (SECURITY.md 16.4, PRD 6.27/6.28).
   *
   * Membaca tetap diizinkan dengan sengaja: data pelanggan tidak disandera, hanya
   * perubahan yang dihentikan sampai langganan dipulihkan.
   */
  requireWritable(): void {
    if (this.flags.readOnlyReason === 'subscription_expired') {
      throw new ForbiddenError('error.subscription_expired', {
        recoveryKey: 'recovery.renew_subscription',
        expiredAt: this.flags.expiresAt,
        status: this.tenant.status,
      });
    }
    if (this.flags.readOnly || this.tenant.status === 'read_only' || this.tenant.status === 'suspended') {
      throw new ForbiddenError('error.tenant_read_only', { status: this.tenant.status });
    }
  }

  /** Mencatat peristiwa dengan aktor & tenant sudah terisi dari konteks. */
  log(entry: Omit<AuditEntry, 'tenantId' | 'actorUserId' | 'actorLabel' | 'actorIp'>): void {
    this.audit.record({
      ...entry,
      tenantId: this.tenant.id,
      actorUserId: this.actor.userId,
      actorLabel: this.actor.displayName,
      actorIp: this.ip,
    });
  }

  auditService(): AuditService {
    return this.audit;
  }
}

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  accent_color: string | null;
  logo_text: string | null;
  white_label: number;
  default_locale: string;
  max_devices_per_user: number;
}

export function toTenantInfo(row: TenantRow): TenantInfo {
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

/** Baris langganan seperlunya untuk menghitung masa berlaku. */
export interface SubscriptionPeriodRow {
  status: string;
  trial_ends_at: string | null;
  current_period_end: string;
}

/**
 * Batas masa berlaku yang sesungguhnya.
 *
 * Selama uji coba, yang mengikat adalah akhir uji coba; setelah berbayar, akhir periode
 * berjalan. Keduanya tersimpan di baris yang sama, dan memilih yang keliru berarti uji
 * coba 14 hari tetap dapat menulis sampai akhir periode langganan yang belum pernah
 * dibayar.
 */
export function subscriptionExpiresAt(sub: SubscriptionPeriodRow): string {
  return sub.status === 'trialing' ? (sub.trial_ends_at ?? sub.current_period_end) : sub.current_period_end;
}

/** Benar bila masa berlaku sudah terlampaui pada saat dipanggil. */
export function subscriptionLapsed(sub: SubscriptionPeriodRow, at: number = Date.now()): boolean {
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
export function loadFeatureFlags(db: Db, tenantId: string, tenantStatus: string): FeatureFlags {
  const sub = db
    .prepare(
      `SELECT plan_code, status, trial_ends_at, current_period_end FROM subscriptions
        WHERE tenant_id = ? AND status IN ('trialing','active','past_due')
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(tenantId) as (SubscriptionPeriodRow & { plan_code: string }) | undefined;

  const planCode = sub?.plan_code ?? 'starter';
  // Katalog EFEKTIF, bukan definisi kode: kuota dan hak modul yang disunting operator
  // lewat CMS harus benar-benar berlaku, bukan hanya tampil di halaman depan.
  const plan: PlanDefinition = resolvePlan(db, planCode) ?? PLAN_BY_CODE.get('starter')!;
  const lapsed = sub !== undefined && subscriptionLapsed(sub);
  const blockedByStatus = tenantStatus === 'read_only' || tenantStatus === 'past_due';
  return new FeatureFlags(
    plan,
    {},
    lapsed || blockedByStatus,
    // Masa berlaku habis disebut lebih dulu: itu sebab yang dapat diselesaikan sendiri
    // oleh pelanggan, dan status tenant `past_due` biasanya hanyalah akibatnya.
    lapsed ? 'subscription_expired' : blockedByStatus ? 'tenant_status' : null,
    sub ? subscriptionExpiresAt(sub) : null,
  );
}
