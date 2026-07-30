/**
 * tenant-service — Manajemen Tenant (PRD 6.26).
 *
 * SECURITY.md 16.2: peran Platform Operator punya akses lintas tenant HANYA untuk
 * fungsi administratif (provisioning, suspensi, dukungan) — BUKAN akses baca terhadap
 * data analitik pelanggan. Setiap aktivitasnya tercatat di jalur audit terpisah yang
 * dapat dilihat tenant terkait.
 */
import type { AuditService } from '../audit-service/index.ts';
import { newId, nowIso, type Db } from '../platform/db.ts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../platform/errors.ts';
import { hashPassword, validatePasswordPolicy } from '../platform/crypto.ts';
import {
  PLAN_BY_CODE,
  PLAN_CATALOG,
  isBillingCycle,
  resolveTrialDays,
  type BillingCycle,
} from '../platform/featureFlags.ts';
import type { RequestContext } from '../platform/context.ts';
import { PlatformOperatorDb } from '../platform/tenancy.ts';
import { seedStandardRoles } from '../identity-service/index.ts';

export interface ProvisionInput {
  name: string;
  slug: string;
  planCode: string;
  billingCycle: BillingCycle;
  trialDays?: number;
  admin: { fullName: string; nik: string; email: string; password: string; division?: string; position?: string };
  isolationLevel?: 'shared_schema' | 'separate_schema' | 'separate_db';
  defaultLocale?: 'id' | 'en';
  /**
   * Menandai pendaftaran yang masih menunggu persetujuan admin.
   *
   * Dinyatakan oleh PEMANGGIL, bukan disimpulkan di sini: provisioning oleh Platform
   * Operator sudah merupakan persetujuan itu sendiri — memintanya menyetujui ulang apa
   * yang baru saja ia buat hanya menambah langkah tanpa menambah kendali.
   */
  requiresApproval?: boolean;
}

export interface TenantRecord {
  id: string;
  name: string;
  slug: string;
  status: string;
  isolation_level: string;
  created_at: string;
  suspended_at: string | null;
  deleted_at: string | null;
  retention_until: string | null;
}

/** Retensi data setelah berhenti berlangganan sebelum penghapusan permanen. */
export const POST_CANCELLATION_RETENTION_DAYS = 90;

export class TenantService {
  private readonly operator: PlatformOperatorDb;

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {
    this.operator = new PlatformOperatorDb(db);
  }

  /** Menanam katalog paket (idempoten). */
  seedPlans(): void {
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO plans (code, name, monthly_price, annual_price,
                                     features_json, quotas_json, sort_order)
       VALUES (?,?,?,?,?,?,?)`,
    );
    for (const plan of PLAN_CATALOG) {
      insert.run(
        plan.code,
        plan.name,
        plan.monthlyPrice,
        plan.annualPrice,
        JSON.stringify(plan.features),
        JSON.stringify({ quotas: plan.quotas, overBehaviour: plan.overBehaviour }),
        plan.sortOrder,
      );
    }
    seedStandardRoles(this.db);
  }

  /**
   * Provisioning tenant baru — otomatis saat pendaftaran (PRD 6.26).
   * Menyiapkan tenant, langganan uji coba, pegawai admin, akun admin, dan peran.
   */
  provision(input: ProvisionInput, actorLabel = 'system'): { tenantId: string; adminUserId: string } {
    if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(input.slug)) {
      throw new ValidationError('error.invalid_tenant_slug');
    }
    if (this.db.prepare('SELECT 1 FROM tenants WHERE slug = ?').get(input.slug)) {
      throw new ConflictError('error.tenant_slug_taken');
    }
    if (!PLAN_BY_CODE.has(input.planCode)) {
      throw new ValidationError('error.plan_unknown', { plan: input.planCode });
    }
    // Siklus divalidasi DI SINI, bukan hanya di rute HTTP: provisioning juga dipanggil
    // dari seed dan dari alat operator, dan siklus yang tidak dikenal akan tersimpan
    // sebagai masa berlaku satu bulan tanpa ada yang menyadarinya.
    if (!isBillingCycle(input.billingCycle)) {
      throw new ValidationError('error.billing_cycle_unknown', { cycle: input.billingCycle });
    }
    const policy = validatePasswordPolicy(input.admin.password);
    if (!policy.ok) throw new ValidationError(policy.reasonKey!);

    const at = nowIso();
    const tenantId = newId('ten');
    const employeeId = newId('emp');
    const adminUserId = newId('usr');
    /**
     * Uji coba gratis: MATI secara bawaan (`VANTIK_TRIAL_DAYS`).
     *
     * Tanpa uji coba, langganan lahir dalam keadaan belum dibayar — masa berlakunya
     * berakhir pada detik yang sama ia dibuat, sehingga ruang kerjanya dapat DIBACA tetapi
     * tidak dapat menulis sampai pembayaran pertama tercatat. Sengaja bukan "tenant
     * disuspensi": pelanggan yang sudah membayar lewat transfer perlu dapat masuk, melihat
     * halaman Langganan, dan menyelesaikannya sendiri.
     */
    const trialDays = input.trialDays ?? resolveTrialDays();
    const trialEnds = trialDays > 0 ? new Date(Date.now() + trialDays * 86_400_000).toISOString() : null;

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO tenants (id, name, slug, status, isolation_level, accent_color, logo_text,
                                white_label, default_locale, max_devices_per_user, created_at,
                                approval_status, approval_requested_at)
           VALUES (?,?,?,'trial',?,NULL,NULL,?,?,1,?,?,?)`,
        )
        .run(
          tenantId,
          input.name,
          input.slug,
          input.isolationLevel ?? (input.planCode === 'enterprise' ? 'separate_schema' : 'shared_schema'),
          input.planCode === 'enterprise' ? 1 : 0,
          input.defaultLocale ?? 'id',
          at,
          input.requiresApproval ? 'pending' : 'approved',
          input.requiresApproval ? at : null,
        );

      this.db
        .prepare(
          `INSERT INTO subscriptions (id, tenant_id, plan_code, billing_cycle, status, trial_ends_at,
                                      current_period_start, current_period_end, cancel_at_period_end,
                                      pending_plan_code, created_at, activated_at)
           VALUES (?,?,?,?,?,?,?,?,0,NULL,?,NULL)`,
        )
        .run(
          newId('sub'),
          tenantId,
          input.planCode,
          input.billingCycle,
          trialEnds ? 'trialing' : 'past_due',
          trialEnds,
          at,
          // Tanpa uji coba, masa berlaku berakhir pada saat pembuatan: `subscriptionLapsed`
          // langsung benar, dan blokirnya berlaku sejak permintaan pertama tanpa menunggu
          // penjadwal. `activated_at` NULL menandai belum pernah dibayar, supaya pesannya
          // berbunyi "belum aktif" alih-alih "masa berlaku habis".
          trialEnds ?? at,
          at,
        );

      this.db
        .prepare(
          `INSERT INTO employee_master (id, tenant_id, full_name, nik, division, position, email,
                                        phone, status, status_changed_at, access_review_due_at,
                                        created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,NULL,'active',?,NULL,?,?)`,
        )
        .run(
          employeeId,
          tenantId,
          input.admin.fullName,
          input.admin.nik,
          input.admin.division ?? 'Administrasi',
          input.admin.position ?? 'Administrator',
          input.admin.email.toLowerCase(),
          at,
          at,
          at,
        );

      this.db
        .prepare(
          `INSERT INTO system_user (id, tenant_id, employee_id, email, password_hash, auth_provider,
                                    mfa_enrolled, status, locale, theme, failed_attempts, locked_until,
                                    last_login_at, password_history_json, created_at, updated_at, disabled_at)
           VALUES (?,?,?,?,?, 'local', 0, 'active', ?, 'light', 0, NULL, NULL, '[]', ?, ?, NULL)`,
        )
        .run(
          adminUserId,
          tenantId,
          employeeId,
          input.admin.email.toLowerCase(),
          hashPassword(input.admin.password),
          input.defaultLocale ?? 'id',
          at,
          at,
        );

      this.db
        .prepare(
          `INSERT INTO role_assignment (id, tenant_id, user_id, role_id, assigned_at, assigned_by)
           VALUES (?,?,?,?,?,'system')`,
        )
        .run(newId('ra'), tenantId, adminUserId, 'role_super_admin', at);
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
  listTenants(ctx: RequestContext): TenantRecord[] {
    ctx.require('tenant:read', { module: 'Manajemen Tenant' });
    if (!ctx.can('tenant:provision')) {
      // Admin tenant biasa hanya melihat tenantnya sendiri.
      const own = this.operator.getTenant(ctx.tenant.id);
      return own ? [own as unknown as TenantRecord] : [];
    }
    return this.operator.listTenants() as unknown as TenantRecord[];
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
  listPendingRegistrations(ctx: RequestContext): Array<{
    id: string;
    name: string;
    slug: string;
    plan_code: string;
    billing_cycle: string;
    admin_email: string;
    admin_name: string;
    approval_requested_at: string | null;
    created_at: string;
  }> {
    ctx.require('tenant:provision', { module: 'Manajemen Tenant' });
    return this.db
      .prepare(
        `SELECT t.id, t.name, t.slug, t.approval_requested_at, t.created_at,
                s.plan_code, s.billing_cycle,
                u.email AS admin_email, e.full_name AS admin_name
           FROM tenants t
           JOIN subscriptions s ON s.tenant_id = t.id
           JOIN system_user   u ON u.tenant_id = t.id
           JOIN employee_master e ON e.id = u.employee_id
          WHERE t.approval_status = 'pending' AND t.deleted_at IS NULL
          GROUP BY t.id
          ORDER BY t.approval_requested_at ASC`,
      )
      .all() as ReturnType<TenantService['listPendingRegistrations']>;
  }

  /**
   * Menyetujui atau menolak sebuah pendaftaran.
   *
   * Penolakan TIDAK menghapus apa pun. Data pendaftar tetap ada sampai retensi berjalan,
   * dan alasannya tersimpan — keputusan yang tidak dapat ditinjau ulang bukan keputusan
   * administratif, melainkan penghapusan yang tidak tercatat.
   */
  decideRegistration(
    ctx: RequestContext,
    tenantId: string,
    decision: 'approved' | 'rejected',
    note?: string,
  ): { tenantId: string; approvalStatus: string } {
    ctx.require('tenant:provision', { module: 'Manajemen Tenant', objectId: tenantId });

    const tenant = this.db
      .prepare("SELECT id, name, approval_status FROM tenants WHERE id = ? AND deleted_at IS NULL")
      .get(tenantId) as { id: string; name: string; approval_status: string } | undefined;
    if (!tenant) throw new NotFoundError();

    // Keputusan hanya berlaku sekali. Tanpa penjagaan ini, "setujui" pada tenant yang
    // sudah lama aktif akan menulis ulang tanggal keputusannya dan mengaburkan riwayat.
    if (tenant.approval_status !== 'pending') {
      throw new ConflictError('error.registration_already_decided', {
        approvalStatus: tenant.approval_status,
      });
    }
    if (decision === 'rejected' && !note?.trim()) {
      // Penolakan tanpa alasan tidak dapat dijelaskan kepada pendaftar, dan tidak dapat
      // ditinjau kemudian.
      throw new ValidationError('error.rejection_reason_required');
    }

    const at = nowIso();
    this.db
      .prepare(
        `UPDATE tenants
            SET approval_status = ?, approval_decided_at = ?, approval_decided_by = ?, approval_note = ?
          WHERE id = ?`,
      )
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
  registrationContact(tenantId: string): { email: string; name: string; tenantName: string } | undefined {
    return this.db
      .prepare(
        `SELECT u.email AS email, e.full_name AS name, t.name AS tenantName
           FROM system_user u
           JOIN employee_master e ON e.id = u.employee_id
           JOIN tenants t ON t.id = u.tenant_id
          WHERE u.tenant_id = ?
          ORDER BY u.created_at ASC LIMIT 1`,
      )
      .get(tenantId) as { email: string; name: string; tenantName: string } | undefined;
  }

  /** Alamat seluruh Platform Operator aktif — penerima kabar pendaftaran baru. */
  operatorContacts(): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT u.email AS email
             FROM system_user u
             JOIN role_assignment ra ON ra.user_id = u.id
            WHERE ra.role_id = 'role_platform_operator' AND u.status = 'active'`,
        )
        .all() as Array<{ email: string }>
    ).map((r) => r.email);
  }

  /**
   * Suspensi tenant TANPA menghapus data (PRD 6.26, SECURITY.md 16.4).
   * Urutan penurunan akses: peringatan → masa tenggang → mode baca-saja → suspensi.
   */
  suspend(ctx: RequestContext, tenantId: string, reason: string): void {
    ctx.require('tenant:suspend', { module: 'Manajemen Tenant', objectId: tenantId });
    const tenant = this.operator.getTenant(tenantId);
    if (!tenant) throw new NotFoundError();

    const at = nowIso();
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

  restore(ctx: RequestContext, tenantId: string): void {
    ctx.require('tenant:suspend', { module: 'Manajemen Tenant', objectId: tenantId });
    if (!this.operator.getTenant(tenantId)) throw new NotFoundError();

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
  configureBranding(
    ctx: RequestContext,
    branding: { accentColor?: string; logoText?: string; defaultLocale?: 'id' | 'en'; maxDevicesPerUser?: number },
  ): void {
    ctx.require('tenant:configure', { module: 'Manajemen Tenant' });
    ctx.requireWritable();

    if (branding.accentColor && !/^#[0-9A-Fa-f]{6}$/.test(branding.accentColor)) {
      throw new ValidationError('error.invalid_color');
    }
    // White-label penuh hanya untuk Enterprise (PRD 2.1).
    if (branding.logoText && ctx.flags.planCode !== 'enterprise') {
      throw new ForbiddenError('error.white_label_requires_enterprise');
    }
    if (branding.maxDevicesPerUser !== undefined && branding.maxDevicesPerUser < 1) {
      throw new ValidationError('error.invalid_device_limit');
    }

    const updates: string[] = [];
    const params: unknown[] = [];
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
    if (updates.length === 0) return;

    params.push(ctx.tenant.id);
    this.db.prepare(`UPDATE tenants SET ${updates.join(', ')} WHERE id = ?`).run(...(params as never[]));

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
  exportTenantData(ctx: RequestContext): Record<string, unknown[]> {
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

    const out: Record<string, unknown[]> = {};
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
  scheduleDeletion(ctx: RequestContext, tenantId: string): { retentionUntil: string } {
    ctx.require('tenant:suspend', { module: 'Manajemen Tenant', objectId: tenantId });
    if (!this.operator.getTenant(tenantId)) throw new NotFoundError();

    const at = nowIso();
    const retentionUntil = new Date(
      Date.now() + POST_CANCELLATION_RETENTION_DAYS * 86_400_000,
    ).toISOString();

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
      detail: { retentionUntil, retentionDays: POST_CANCELLATION_RETENTION_DAYS },
    });

    return { retentionUntil };
  }

  /** Jejak akses Platform Operator yang dapat dilihat tenant (SECURITY.md 16.2). */
  operatorAccessTrail(ctx: RequestContext): ReturnType<AuditService['operatorTrail']> {
    ctx.require('tenant:read', { module: 'Manajemen Tenant' });
    return this.audit.operatorTrail(ctx.tenant.id);
  }
}
