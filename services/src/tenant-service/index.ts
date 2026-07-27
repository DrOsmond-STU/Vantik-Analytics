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
import { PLAN_BY_CODE, PLAN_CATALOG } from '../platform/featureFlags.ts';
import type { RequestContext } from '../platform/context.ts';
import { PlatformOperatorDb } from '../platform/tenancy.ts';
import { seedStandardRoles } from '../identity-service/index.ts';

export interface ProvisionInput {
  name: string;
  slug: string;
  planCode: string;
  billingCycle: 'monthly' | 'annual';
  trialDays?: number;
  admin: { fullName: string; nik: string; email: string; password: string; division?: string; position?: string };
  isolationLevel?: 'shared_schema' | 'separate_schema' | 'separate_db';
  defaultLocale?: 'id' | 'en';
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
    const policy = validatePasswordPolicy(input.admin.password);
    if (!policy.ok) throw new ValidationError(policy.reasonKey!);

    const at = nowIso();
    const tenantId = newId('ten');
    const employeeId = newId('emp');
    const adminUserId = newId('usr');
    const trialDays = input.trialDays ?? 14;
    const trialEnds = new Date(Date.now() + trialDays * 86_400_000).toISOString();

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO tenants (id, name, slug, status, isolation_level, accent_color, logo_text,
                                white_label, default_locale, max_devices_per_user, created_at)
           VALUES (?,?,?,'trial',?,NULL,NULL,?,?,1,?)`,
        )
        .run(
          tenantId,
          input.name,
          input.slug,
          input.isolationLevel ?? (input.planCode === 'enterprise' ? 'separate_schema' : 'shared_schema'),
          input.planCode === 'enterprise' ? 1 : 0,
          input.defaultLocale ?? 'id',
          at,
        );

      this.db
        .prepare(
          `INSERT INTO subscriptions (id, tenant_id, plan_code, billing_cycle, status, trial_ends_at,
                                      current_period_start, current_period_end, cancel_at_period_end,
                                      pending_plan_code, created_at)
           VALUES (?,?,?,?,'trialing',?,?,?,0,NULL,?)`,
        )
        .run(
          newId('sub'),
          tenantId,
          input.planCode,
          input.billingCycle,
          trialEnds,
          at,
          trialEnds,
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
