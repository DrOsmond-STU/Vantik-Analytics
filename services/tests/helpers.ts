/**
 * Perkakas pengujian bersama.
 *
 * TESTING.md Bagian 11: data uji sepenuhnya SINTETIS; setiap berkas test memakai
 * basis data sementara sendiri sehingga tidak ada kebocoran keadaan antar-test.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../src/audit-service/index.ts';
import { openDatabase, type Db } from '../src/platform/db.ts';
import { KeyRing } from '../src/platform/crypto.ts';
import { RequestContext, loadFeatureFlags, toTenantInfo } from '../src/platform/context.ts';
import { requiresMfa, STANDARD_ROLES, type RoleCode } from '../src/platform/rbac.ts';
import { RlsScope, type RlsRule } from '../src/platform/rls.ts';
import type { BillingCycle } from '../src/platform/featureFlags.ts';
import { AuthService } from '../src/identity-service/auth.ts';
import { TenantService } from '../src/tenant-service/index.ts';
import type { FingerprintComponents } from '../src/identity-service/deviceFingerprint.ts';

export interface Harness {
  db: Db;
  audit: AuditService;
  auth: AuthService;
  tenants: TenantService;
  keyring: KeyRing;
  dir: string;
  cleanup: () => void;
}

export function createHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'vantik-test-'));
  const db = openDatabase({
    paths: {
      main: join(dir, 'main.db'),
      audit: join(dir, 'audit.db'),
      vault: join(dir, 'vault.db'),
    },
  });
  const audit = new AuditService(db);
  const auth = new AuthService(db, audit);
  const tenants = new TenantService(db, audit);
  tenants.seedPlans();
  const keyring = new KeyRing([{ version: 1, material: randomBytes(32) }]);

  return {
    db,
    audit,
    auth,
    tenants,
    keyring,
    dir,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const TEST_PASSWORD = 'VantikTest#2026';

export interface TenantFixture {
  tenantId: string;
  adminUserId: string;
  slug: string;
}

let tenantCounter = 0;

export function provisionTenant(
  harness: Harness,
  options: { planCode?: string; slug?: string; billingCycle?: BillingCycle; trialDays?: number } = {},
): TenantFixture {
  const slug = options.slug ?? `tenant${++tenantCounter}x`;
  const { tenantId, adminUserId } = harness.tenants.provision(
    {
      name: `Organisasi ${slug}`,
      slug,
      planCode: options.planCode ?? 'enterprise',
      billingCycle: options.billingCycle ?? 'monthly',
      trialDays: options.trialDays,
      admin: {
        fullName: 'Admin Uji',
        nik: `NIK-${slug}`,
        email: `admin@${slug}.test`,
        password: TEST_PASSWORD,
      },
    },
    'test',
  );
  return { tenantId, adminUserId, slug };
}

/**
 * Membangun konteks permintaan untuk peran tertentu tanpa melewati HTTP.
 * `rls` memungkinkan pengujian negatif Row-Level Security (TESTING.md Bagian 4).
 */
export function contextFor(
  harness: Harness,
  tenantId: string,
  roleCodes: RoleCode[],
  options: { userId?: string; rls?: RlsRule[]; freshAuth?: boolean; mfaEnrolled?: boolean } = {},
): RequestContext {
  const tenantRow = harness.db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId) as Parameters<
    typeof toTenantInfo
  >[0];
  const tenant = toTenantInfo(tenantRow);

  const userId =
    options.userId ??
    (harness.db.prepare('SELECT id FROM system_user WHERE tenant_id = ? LIMIT 1').get(tenantId) as { id: string }).id;
  const user = harness.db.prepare('SELECT * FROM system_user WHERE id = ?').get(userId) as {
    id: string;
    employee_id: string;
    email: string;
  };

  const roles = roleCodes.map((code) => {
    const role = STANDARD_ROLES.find((r) => r.code === code);
    if (!role) throw new Error(`unknown role ${code}`);
    return { permissions: role.permissions, denials: role.denials };
  });

  return new RequestContext(
    harness.db,
    tenant,
    {
      userId: user.id,
      employeeId: user.employee_id,
      email: user.email,
      displayName: user.email,
      locale: 'id',
      theme: 'light',
      roleIds: roleCodes.map((c) => `role_${c}`),
      roleCodes,
      sessionId: `test-session-${userId}`,
      reauthAt: options.freshAuth === false ? null : new Date().toISOString(),
      // Default mewakili pengguna yang TERPASANG BENAR: MFA aktif tepat ketika perannya
      // mewajibkannya. Dengan begitu uji tentang dataset atau KPI tidak perlu ikut
      // memikirkan MFA, sementara uji penegakan MFA menyatakan `mfaEnrolled: false`
      // secara eksplisit — keadaan itu memang kekecualian, bukan keadaan normal.
      mfaEnrolled: options.mfaEnrolled ?? requiresMfa(roleCodes),
    },
    roles,
    loadFeatureFlags(harness.db, tenant.id, tenant.status),
    harness.audit,
    '203.0.113.10',
    options.rls ? new RlsScope(options.rls) : undefined,
  );
}

/** Membuat pengguna tambahan di dalam tenant (untuk uji peran & RLS). */
export function createUser(
  harness: Harness,
  tenantId: string,
  email: string,
  roleCode: RoleCode,
): string {
  const at = new Date().toISOString();
  const employeeId = `emp_${email.replace(/\W/g, '')}`;
  const userId = `usr_${email.replace(/\W/g, '')}`;

  harness.db
    .prepare(
      `INSERT INTO employee_master (id, tenant_id, full_name, nik, division, position, email,
                                    phone, status, status_changed_at, access_review_due_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,NULL,'active',?,NULL,?,?)`,
    )
    .run(employeeId, tenantId, email, `NIK-${userId}`, 'Uji', 'Staf', email, at, at, at);

  harness.db
    .prepare(
      `INSERT INTO system_user (id, tenant_id, employee_id, email, password_hash, auth_provider, mfa_enrolled,
                                status, locale, theme, failed_attempts, locked_until, last_login_at,
                                password_history_json, created_at, updated_at, disabled_at)
       VALUES (?,?,?,?,NULL,'local',0,'active','id','light',0,NULL,NULL,'[]',?,?,NULL)`,
    )
    .run(userId, tenantId, employeeId, email, at, at);

  harness.db
    .prepare('INSERT INTO role_assignment (id, tenant_id, user_id, role_id, assigned_at, assigned_by) VALUES (?,?,?,?,?,?)')
    .run(`ra_${userId}`, tenantId, userId, `role_${roleCode}`, at, 'test');

  return userId;
}

/** Fingerprint perangkat sintetis. */
export function fingerprint(overrides: Partial<FingerprintComponents> = {}): FingerprintComponents {
  return {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    screenResolution: '1920x1080',
    colorDepth: 24,
    timezone: 'Asia/Jakarta',
    language: 'id-ID',
    fonts: ['Inter', 'Arial', 'Roboto'],
    canvasHash: 'canvas-signature-alpha',
    webglHash: 'Intel|Mesa Intel UHD|WebGL GLSL ES 1.0',
    platform: 'Linux x86_64',
    ...overrides,
  };
}

/** Dataset CSV sintetis dengan kesalahan disengaja dalam proporsi DIKETAHUI. */
export function syntheticCsv(options: {
  rows: number;
  duplicateRows?: number;
  missingCells?: number;
  invalidCells?: number;
}): string {
  const header = 'wilayah,kanal,jumlah_tiket,skor_csat';
  const lines: string[] = [header];
  const regions = ['Wilayah Timur', 'Wilayah Barat', 'Wilayah Tengah'];

  for (let i = 0; i < options.rows; i++) {
    lines.push(`${regions[i % regions.length]},Chat,${100 + i},${(3 + (i % 20) / 10).toFixed(2)}`);
  }
  for (let i = 0; i < (options.duplicateRows ?? 0); i++) {
    lines.push(lines[1]!); // salinan persis baris pertama
  }
  // Baris bercacat dibuat UNIK satu sama lain (skor berbeda) supaya jumlah duplikat
  // yang terdeteksi persis sama dengan `duplicateRows` — tanpa ini, baris bercacat
  // ikut terhitung sebagai duplikat dan uji proporsi TESTING.md Bagian 5 jadi kabur.
  for (let i = 0; i < (options.missingCells ?? 0); i++) {
    lines.push(`${regions[i % regions.length]},Email,,${(1 + i / 100).toFixed(3)}`);
  }
  for (let i = 0; i < (options.invalidCells ?? 0); i++) {
    lines.push(`${regions[i % regions.length]},SMS,dua-puluh,${(2 + i / 100).toFixed(3)}`);
  }
  return lines.join('\n');
}
