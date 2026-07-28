/**
 * identity-service — Master Pegawai (PRD 6.18), Pengelolaan Otorisasi User (PRD 6.19),
 * Manajemen Perangkat & Sesi (PRD 6.30).
 *
 * Dipisah dari layanan lain SEJAK AWAL karena kebutuhan keamanan/audit lebih ketat
 * (ARCHITECTURE.md Bagian 3 & 11).
 */
import { newId, nowIso } from '../platform/db.ts';
import { hashPassword, validatePasswordPolicy } from '../platform/crypto.ts';
import { ConflictError, NotFoundError, ValidationError } from '../platform/errors.ts';
import type { RequestContext } from '../platform/context.ts';
import { STANDARD_ROLES, type Permission } from '../platform/rbac.ts';
import type { WhereClause } from '../platform/tenancy.ts';
import type { AuthService } from './auth.ts';

export * from './auth.ts';
export * from './deviceFingerprint.ts';

/* ------------------------------------------------------------------ */
/* Master Pegawai — PRD 6.18                                           */
/* ------------------------------------------------------------------ */

export interface EmployeeInput {
  fullName: string;
  nik: string;
  division: string;
  position: string;
  email: string;
  phone?: string;
  status?: 'active' | 'inactive' | 'resigned' | 'transferred';
}

export interface EmployeeRecord {
  id: string;
  full_name: string;
  nik: string;
  division: string;
  position: string;
  email: string;
  phone: string | null;
  status: string;
  status_changed_at: string | null;
  access_review_due_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * NIK dimaskirkan pada tampilan yang tidak memerlukan detail penuh (SECURITY.md Bagian 6).
 * Nilai penuh hanya dikembalikan bila pemanggil punya izin `employee:write`.
 */
export function maskNik(nik: string): string {
  if (nik.length <= 4) return '•'.repeat(nik.length);
  return `${'•'.repeat(nik.length - 4)}${nik.slice(-4)}`;
}

/** SLA peninjauan akses 1x24 jam setelah status pegawai berubah (SECURITY.md Bagian 5). */
export const ACCESS_REVIEW_SLA_MS = 24 * 60 * 60 * 1000;

export class EmployeeService {
  constructor(private readonly ctx: RequestContext) {}

  list(filter: { status?: string; division?: string; search?: string } = {}): Array<
    EmployeeRecord & { nik_display: string; linked_accounts: number; unlinked: boolean }
  > {
    this.ctx.require('employee:read', { module: 'Master Pegawai' });
    const where: WhereClause = {};
    if (filter.status) where.status = filter.status;
    if (filter.division) where.division = filter.division;
    const rows = this.ctx.db.all<EmployeeRecord>('employee_master', where, { orderBy: 'full_name' });

    const canSeeFull = this.ctx.can('employee:write');
    const search = filter.search?.toLowerCase();

    return rows
      .filter((r) => !search || r.full_name.toLowerCase().includes(search) || r.email.toLowerCase().includes(search))
      .map((r) => {
        const linked = this.ctx.db.count('system_user', { employee_id: r.id });
        return {
          ...r,
          nik: canSeeFull ? r.nik : maskNik(r.nik),
          nik_display: maskNik(r.nik),
          linked_accounts: linked,
          // Pegawai yang belum terhubung akun ditandai agar mudah ditindaklanjuti (PRD 6.18)
          unlinked: linked === 0,
        };
      });
  }

  create(input: EmployeeInput): EmployeeRecord {
    this.ctx.require('employee:write', { module: 'Master Pegawai' });
    this.ctx.requireWritable();

    const existing = this.ctx.db.get<EmployeeRecord>('employee_master', { nik: input.nik });
    if (existing) throw new ConflictError('error.employee_nik_exists', { nik: input.nik });

    const at = nowIso();
    const row = {
      id: newId('emp'),
      full_name: input.fullName,
      nik: input.nik,
      division: input.division,
      position: input.position,
      email: input.email.toLowerCase(),
      phone: input.phone ?? null,
      status: input.status ?? 'active',
      status_changed_at: at,
      access_review_due_at: null,
      created_at: at,
      updated_at: at,
    };
    this.ctx.db.insert('employee_master', row);
    this.ctx.log({
      action: 'employee.create',
      module: 'Master Pegawai',
      objectType: 'employee',
      objectId: row.id,
      objectLabel: row.full_name,
      // Data pegawai = klasifikasi Restricted (SECURITY.md Bagian 3): NIK tidak
      // ikut ditulis ke detail log.
      detail: { division: row.division, position: row.position },
    });
    return row as EmployeeRecord;
  }

  /**
   * Perubahan status memicu peninjauan otomatis terhadap akses akun terkait (PRD 6.18).
   * Akses dicabut otomatis bila tidak ditinjau dalam SLA (SECURITY.md Bagian 5).
   */
  changeStatus(
    employeeId: string,
    status: 'active' | 'inactive' | 'resigned' | 'transferred',
    auth: AuthService,
  ): { reviewDueAt: string | null; accountsFlagged: number } {
    this.ctx.require('employee:write', { module: 'Master Pegawai' });
    this.ctx.requireWritable();

    const employee = this.ctx.db.get<EmployeeRecord>('employee_master', { id: employeeId });
    if (!employee) throw new NotFoundError();

    const at = nowIso();
    const needsReview = status !== 'active';
    const reviewDueAt = needsReview ? new Date(Date.now() + ACCESS_REVIEW_SLA_MS).toISOString() : null;

    this.ctx.db.update(
      'employee_master',
      { id: employeeId },
      { status, status_changed_at: at, access_review_due_at: reviewDueAt, updated_at: at },
    );

    const accounts = this.ctx.db.all<{ id: string }>('system_user', { employee_id: employeeId });
    if (needsReview) {
      for (const account of accounts) {
        // Sesi dicabut segera; akun belum dinonaktifkan agar Admin dapat meninjau,
        // namun tidak ada sesi berjalan yang tetap hidup.
        auth.revokeSessionsForUser(this.ctx.tenant.id, account.id, 'employee_status_change');
      }
    }

    this.ctx.log({
      action: 'employee.status_change',
      module: 'Master Pegawai',
      objectType: 'employee',
      objectId: employeeId,
      objectLabel: employee.full_name,
      severity: needsReview ? 'warning' : 'info',
      detail: { from: employee.status, to: status, reviewDueAt, accountsAffected: accounts.length },
    });

    return { reviewDueAt, accountsFlagged: accounts.length };
  }

  /**
   * Akun yang peninjauan aksesnya sudah lewat SLA. Dipanggil proses terjadwal maupun
   * ditampilkan di UI sebagai antrean tindakan.
   */
  overdueAccessReviews(): Array<{ employee: EmployeeRecord; accounts: number }> {
    this.ctx.require('employee:read', { module: 'Master Pegawai' });
    const rows = this.ctx.db.all<EmployeeRecord>('employee_master', {
      access_review_due_at: { lte: nowIso() },
    });
    return rows.map((employee) => ({
      employee,
      accounts: this.ctx.db.count('system_user', { employee_id: employee.id }),
    }));
  }

  /** Impor massal via CSV (PRD 6.18). Baris gagal dilaporkan, tidak membatalkan seluruh impor. */
  importCsv(csv: string): { imported: number; skipped: Array<{ line: number; reasonKey: string }> } {
    this.ctx.require('employee:import', { module: 'Master Pegawai' });
    this.ctx.requireWritable();

    const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) throw new ValidationError('error.csv_empty');

    const header = lines[0]!.split(',').map((h) => h.trim().toLowerCase());
    const required = ['full_name', 'nik', 'division', 'position', 'email'];
    for (const col of required) {
      if (!header.includes(col)) throw new ValidationError('error.csv_missing_column', { column: col });
    }

    const skipped: Array<{ line: number; reasonKey: string }> = [];
    let imported = 0;

    this.ctx.db.transaction(() => {
      for (let i = 1; i < lines.length; i++) {
        const cells = splitCsvLine(lines[i]!);
        const record: Record<string, string> = {};
        header.forEach((h, idx) => (record[h] = (cells[idx] ?? '').trim()));

        if (!record.full_name || !record.nik || !record.email) {
          skipped.push({ line: i + 1, reasonKey: 'error.csv_missing_value' });
          continue;
        }
        if (this.ctx.db.get('employee_master', { nik: record.nik })) {
          skipped.push({ line: i + 1, reasonKey: 'error.employee_nik_exists' });
          continue;
        }
        const at = nowIso();
        this.ctx.db.insert('employee_master', {
          id: newId('emp'),
          full_name: record.full_name,
          nik: record.nik,
          division: record.division ?? '',
          position: record.position ?? '',
          email: record.email.toLowerCase(),
          phone: record.phone ?? null,
          status: 'active',
          status_changed_at: at,
          access_review_due_at: null,
          created_at: at,
          updated_at: at,
        });
        imported++;
      }
    });

    this.ctx.log({
      action: 'employee.import_csv',
      module: 'Master Pegawai',
      objectType: 'employee_batch',
      detail: { imported, skipped: skipped.length },
    });

    return { imported, skipped };
  }
}

/** Pemisah CSV sederhana yang menghormati tanda kutip. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else inQuotes = false;
      } else current += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      out.push(current);
      current = '';
    } else current += ch;
  }
  out.push(current);
  return out;
}

/* ------------------------------------------------------------------ */
/* Pengelolaan Otorisasi User — PRD 6.19                               */
/* ------------------------------------------------------------------ */

export interface CreateUserInput {
  employeeId: string;
  email: string;
  password?: string;
  authProvider?: 'local' | 'saml' | 'oidc';
  roleCodes: string[];
  locale?: 'id' | 'en';
}

export class AuthorizationService {
  constructor(private readonly ctx: RequestContext) {}

  listRoles(): Array<{ id: string; code: string; name_id: string; name_en: string; is_standard: number; permissions: Permission[]; denials: Permission[] }> {
    this.ctx.require('authorization:read', { module: 'Otorisasi User' });
    const rows = this.ctx.db.globalRead<{
      id: string;
      tenant_id: string | null;
      code: string;
      name_id: string;
      name_en: string;
      is_standard: number;
      permissions_json: string;
      denials_json: string;
    }>('roles');
    return rows
      .filter((r) => r.tenant_id === null || r.tenant_id === this.ctx.tenant.id)
      .map((r) => ({
        id: r.id,
        code: r.code,
        name_id: r.name_id,
        name_en: r.name_en,
        is_standard: r.is_standard,
        permissions: JSON.parse(r.permissions_json),
        denials: JSON.parse(r.denials_json),
      }));
  }

  listUsers(): Array<{
    id: string;
    email: string;
    status: string;
    mfa_enrolled: number;
    last_login_at: string | null;
    employee_name: string;
    division: string;
    roles: string[];
    rls: Array<{ dimension: string; operator: string; values: string[] }>;
  }> {
    this.ctx.require('authorization:read', { module: 'Otorisasi User' });
    const users = this.ctx.db.all<{
      id: string;
      email: string;
      status: string;
      mfa_enrolled: number;
      last_login_at: string | null;
      employee_id: string;
    }>('system_user', undefined, { orderBy: 'email' });

    return users.map((u) => {
      const employee = this.ctx.db.get<EmployeeRecord>('employee_master', { id: u.employee_id });
      const assignments = this.ctx.db.all<{ role_id: string }>('role_assignment', { user_id: u.id });
      const roleCodes = assignments
        .map((a) => this.roleById(a.role_id)?.code)
        .filter((c): c is string => Boolean(c));
      const rls = this.ctx.db
        .all<{ dimension: string; operator: string; values_json: string }>('rls_rules', {
          subject_type: 'user',
          subject_id: u.id,
        })
        .map((r) => ({ dimension: r.dimension, operator: r.operator, values: JSON.parse(r.values_json) }));

      return {
        id: u.id,
        email: u.email,
        status: u.status,
        mfa_enrolled: u.mfa_enrolled,
        last_login_at: u.last_login_at,
        employee_name: employee?.full_name ?? '—',
        division: employee?.division ?? '—',
        roles: roleCodes,
        rls,
      };
    });
  }

  private roleById(id: string): { id: string; code: string } | undefined {
    return this.ctx.db.globalRead<{ id: string; code: string }>('roles', { id })[0];
  }

  private roleByCode(code: string): { id: string } | undefined {
    const rows = this.ctx.db.globalRead<{ id: string; code: string; tenant_id: string | null }>('roles', { code });
    return rows.find((r) => r.tenant_id === null || r.tenant_id === this.ctx.tenant.id);
  }

  createUser(input: CreateUserInput): { id: string } {
    this.ctx.require('authorization:write', { module: 'Otorisasi User' });
    this.ctx.requireWritable();

    // Identitas pengguna bersumber dari Master Pegawai — tidak ada akun "mengambang"
    // (PRD Bagian 8, SECURITY.md Bagian 5).
    const employee = this.ctx.db.get<EmployeeRecord>('employee_master', { id: input.employeeId });
    if (!employee) throw new ValidationError('error.employee_required');

    if (this.ctx.db.get('system_user', { email: input.email.toLowerCase() })) {
      throw new ConflictError('error.user_email_exists');
    }

    let passwordHash: string | null = null;
    if ((input.authProvider ?? 'local') === 'local') {
      if (!input.password) throw new ValidationError('error.password_required');
      const policy = validatePasswordPolicy(input.password);
      if (!policy.ok) throw new ValidationError(policy.reasonKey!);
      passwordHash = hashPassword(input.password);
    }

    const at = nowIso();
    const id = newId('usr');
    this.ctx.db.insert('system_user', {
      id,
      employee_id: input.employeeId,
      email: input.email.toLowerCase(),
      password_hash: passwordHash,
      auth_provider: input.authProvider ?? 'local',
      mfa_enrolled: 0,
      status: 'active',
      locale: input.locale ?? 'id',
      theme: 'light',
      failed_attempts: 0,
      locked_until: null,
      last_login_at: null,
      password_history_json: '[]',
      created_at: at,
      updated_at: at,
      disabled_at: null,
    });

    for (const code of input.roleCodes) {
      const role = this.roleByCode(code);
      if (!role) throw new ValidationError('error.role_unknown', { code });
      this.ctx.db.insert('role_assignment', {
        id: newId('ra'),
        user_id: id,
        role_id: role.id,
        assigned_at: at,
        assigned_by: this.ctx.actor.userId,
      });
    }

    this.ctx.log({
      action: 'user.create',
      module: 'Otorisasi User',
      objectType: 'user',
      objectId: id,
      objectLabel: input.email,
      severity: 'notice',
      detail: { roles: input.roleCodes, employeeId: input.employeeId },
    });

    return { id };
  }

  setRoles(userId: string, roleCodes: string[]): void {
    this.ctx.require('authorization:write', { module: 'Otorisasi User', objectId: userId });
    this.ctx.requireWritable();

    // Tidak ada peran yang dapat mengubah hak akses miliknya sendiri (SECURITY.md Bagian 5).
    if (userId === this.ctx.actor.userId) {
      throw new ValidationError('error.cannot_change_own_access');
    }

    const user = this.ctx.db.get<{ id: string; email: string }>('system_user', { id: userId });
    if (!user) throw new NotFoundError();

    const before = this.ctx.db
      .all<{ role_id: string }>('role_assignment', { user_id: userId })
      .map((a) => this.roleById(a.role_id)?.code);

    this.ctx.db.transaction(() => {
      this.ctx.db.delete('role_assignment', { user_id: userId });
      for (const code of roleCodes) {
        const role = this.roleByCode(code);
        if (!role) throw new ValidationError('error.role_unknown', { code });
        this.ctx.db.insert('role_assignment', {
          id: newId('ra'),
          user_id: userId,
          role_id: role.id,
          assigned_at: nowIso(),
          assigned_by: this.ctx.actor.userId,
        });
      }
    });

    // Perubahan peran/hak akses tercatat otomatis & tidak dapat diubah (PRD 6.19).
    this.ctx.log({
      action: 'user.roles_changed',
      module: 'Otorisasi User',
      objectType: 'user',
      objectId: userId,
      objectLabel: user.email,
      severity: 'critical',
      detail: { before, after: roleCodes },
    });
  }

  setRls(
    subject: { type: 'user' | 'role'; id: string },
    rules: Array<{ dimension: string; operator: 'in' | 'not_in'; values: string[] }>,
  ): void {
    this.ctx.require('authorization:write', { module: 'Otorisasi User', objectId: subject.id });
    this.ctx.requireWritable();

    this.ctx.db.transaction(() => {
      this.ctx.db.delete('rls_rules', { subject_type: subject.type, subject_id: subject.id });
      for (const rule of rules) {
        this.ctx.db.insert('rls_rules', {
          id: newId('rls'),
          subject_type: subject.type,
          subject_id: subject.id,
          dimension: rule.dimension,
          operator: rule.operator,
          values_json: JSON.stringify(rule.values),
          created_at: nowIso(),
        });
      }
    });

    this.ctx.log({
      action: 'rls.changed',
      module: 'Otorisasi User',
      objectType: subject.type,
      objectId: subject.id,
      severity: 'critical',
      detail: { rules },
    });
  }

  /** Menonaktifkan akun instan TANPA menghapus riwayat data yang pernah dibuat (PRD 6.19). */
  disableUser(userId: string, auth: AuthService): void {
    this.ctx.require('authorization:write', { module: 'Otorisasi User', objectId: userId });
    this.ctx.requireWritable();

    const user = this.ctx.db.get<{ email: string }>('system_user', { id: userId });
    if (!user) throw new NotFoundError();

    const at = nowIso();
    this.ctx.db.update('system_user', { id: userId }, { status: 'disabled', disabled_at: at, updated_at: at });
    auth.revokeSessionsForUser(this.ctx.tenant.id, userId, 'account_disabled');

    this.ctx.log({
      action: 'user.disabled',
      module: 'Otorisasi User',
      objectType: 'user',
      objectId: userId,
      objectLabel: user.email,
      severity: 'critical',
    });
  }

  /**
   * Admin menetapkan ulang kata sandi pengguna lain (SECURITY.md Bagian 4).
   *
   * Tanpa jalur ini, pengguna yang lupa kata sandinya terkunci permanen: tidak ada
   * pemulihan mandiri, dan admin pun tidak punya cara menolong selain menyunting basis
   * data langsung. Kebijakan panjang & riwayat pemakaian ulang ditegakkan
   * `AuthService.changePassword()` yang sama dengan jalur mandiri — reset oleh admin
   * bukan pintu belakang untuk memasang kata sandi lemah.
   */
  resetPassword(userId: string, newPassword: string, auth: AuthService): void {
    this.ctx.require('authorization:write', { module: 'Otorisasi User', objectId: userId });
    this.ctx.requireWritable();

    // Pencarian ini ber-scope tenant, dan sengaja dilakukan SEBELUM menyentuh
    // AuthService yang mencari `system_user` lintas tenant. Tanpa urutan ini, admin
    // satu tenant dapat menetapkan ulang kata sandi pengguna tenant lain hanya dengan
    // menebak id-nya.
    const user = this.ctx.db.get<{ email: string }>('system_user', { id: userId });
    if (!user) throw new NotFoundError();

    // Akun sendiri lewat jalur mandiri, yang menuntut kata sandi lama. Reset di sini
    // mencabut seluruh sesi target — dipakai pada diri sendiri, admin akan mengeluarkan
    // dirinya di tengah pekerjaan tanpa alasan yang jelas baginya.
    if (userId === this.ctx.actor.userId) {
      throw new ValidationError('error.use_self_password_change');
    }

    auth.changePassword(userId, newPassword);

    // Reset justru dipakai ketika kata sandi lama diduga bocor. Sesi yang sudah berjalan
    // harus ikut mati — kalau tidak, penyusup tetap masuk memakai sesi lamanya dan
    // penggantian kata sandi hanya menyulitkan pemilik akun yang sah.
    const revoked = auth.revokeSessionsForUser(this.ctx.tenant.id, userId, 'password_reset_by_admin');

    this.ctx.log({
      action: 'user.password_reset',
      module: 'Otorisasi User',
      objectType: 'user',
      objectId: userId,
      objectLabel: user.email,
      severity: 'critical',
      detail: { sessionsRevoked: revoked },
    });
  }

  /** Peninjauan hak akses berkala, minimum kuartalan (SECURITY.md Bagian 5). */
  accessReview(): {
    generatedAt: string;
    users: Array<{ id: string; email: string; roles: string[]; lastLogin: string | null; employeeStatus: string }>;
  } {
    this.ctx.require('authorization:read', { module: 'Otorisasi User' });
    const users = this.listUsers();
    const report = {
      generatedAt: nowIso(),
      users: users.map((u) => {
        const account = this.ctx.db.get<{ employee_id: string }>('system_user', { id: u.id });
        const employee = account
          ? this.ctx.db.get<EmployeeRecord>('employee_master', { id: account.employee_id })
          : undefined;
        return {
          id: u.id,
          email: u.email,
          roles: u.roles,
          lastLogin: u.last_login_at,
          employeeStatus: employee?.status ?? 'unknown',
        };
      }),
    };
    this.ctx.log({
      action: 'access_review.generated',
      module: 'Otorisasi User',
      objectType: 'report',
      detail: { userCount: report.users.length },
    });
    return report;
  }
}

/* ------------------------------------------------------------------ */
/* Manajemen Perangkat & Sesi — PRD 6.30                               */
/* ------------------------------------------------------------------ */

export class DeviceService {
  constructor(private readonly ctx: RequestContext) {}

  /**
   * Halaman "Perangkat Saya" — transparansi WAJIB, karena data perangkat termasuk
   * data pribadi menurut UU PDP (PRD 6.30, SECURITY.md 17.3).
   */
  myDevices(): Array<{ id: string; label: string | null; first_seen: string; last_seen: string; status: string; current: boolean }> {
    const rows = this.ctx.db.all<{
      id: string;
      label: string | null;
      first_seen: string;
      last_seen: string;
      status: string;
    }>('device_bindings', { user_id: this.ctx.actor.userId }, { orderBy: 'last_seen DESC' });

    const session = this.ctx.db.get<{ device_id: string | null }>('active_sessions', {
      id: this.ctx.actor.sessionId,
    });
    return rows.map((r) => ({ ...r, current: r.id === session?.device_id }));
  }

  listAll(): Array<{ id: string; user_email: string; label: string | null; status: string; last_seen: string; last_ip: string | null }> {
    this.ctx.require('device:read', { module: 'Perangkat & Sesi' });
    const rows = this.ctx.db.all<{
      id: string;
      user_id: string;
      label: string | null;
      status: string;
      last_seen: string;
      last_ip: string | null;
    }>('device_bindings', undefined, { orderBy: 'last_seen DESC' });
    return rows.map((r) => ({
      id: r.id,
      user_email: this.ctx.db.get<{ email: string }>('system_user', { id: r.user_id })?.email ?? '—',
      label: r.label,
      status: r.status,
      last_seen: r.last_seen,
      last_ip: r.last_ip,
    }));
  }

  /**
   * Melepas ikatan perangkat. Memerlukan otorisasi Admin dan re-autentikasi
   * (`device:unbind` ada di SENSITIVE_PERMISSIONS) — SECURITY.md 17.2 menyebut jalur
   * ini sebagai titik paling mungkin disalahgunakan untuk berbagi akun.
   */
  unbind(deviceId: string, reason: string, auth: AuthService): void {
    this.ctx.require('device:unbind', { module: 'Perangkat & Sesi', objectId: deviceId });
    this.ctx.requireWritable();

    const device = this.ctx.db.get<{ id: string; user_id: string; label: string | null }>('device_bindings', {
      id: deviceId,
    });
    if (!device) throw new NotFoundError();

    const at = nowIso();
    this.ctx.db.update(
      'device_bindings',
      { id: deviceId },
      { status: 'unbound', unbound_at: at, unbound_by: this.ctx.actor.userId },
    );
    auth.revokeSessionsForUser(this.ctx.tenant.id, device.user_id, 'device_unbound');

    this.ctx.log({
      action: 'device.unbound',
      module: 'Perangkat & Sesi',
      objectType: 'device',
      objectId: deviceId,
      objectLabel: device.label,
      severity: 'critical',
      detail: { reason, userId: device.user_id },
    });
  }

  pendingTransfers(): Array<{ id: string; user_email: string; requested_at: string; reason: string | null; otp_verified: number }> {
    this.ctx.require('device:read', { module: 'Perangkat & Sesi' });
    const rows = this.ctx.db.all<{
      id: string;
      user_id: string;
      requested_at: string;
      reason: string | null;
      otp_verified: number;
    }>('device_transfer_requests', { status: 'pending' }, { orderBy: 'requested_at DESC' });
    return rows.map((r) => ({
      id: r.id,
      user_email: this.ctx.db.get<{ email: string }>('system_user', { id: r.user_id })?.email ?? '—',
      requested_at: r.requested_at,
      reason: r.reason,
      otp_verified: r.otp_verified,
    }));
  }

  /**
   * Menyetujui pemindahan perangkat. Selain persetujuan Admin, OTP wajib sudah
   * terverifikasi — dua faktor pada jalur yang paling rawan disalahgunakan.
   */
  approveTransfer(requestId: string, auth: AuthService): void {
    this.ctx.require('device:approve_transfer', { module: 'Perangkat & Sesi', objectId: requestId });
    this.ctx.requireWritable();

    const req = this.ctx.db.get<{
      id: string;
      user_id: string;
      new_fingerprint_hash: string;
      components_json: string;
      otp_verified: number;
      status: string;
      expires_at: string;
    }>('device_transfer_requests', { id: requestId });

    if (!req) throw new NotFoundError();
    if (req.status !== 'pending') throw new ConflictError('error.transfer_not_pending');
    if (Date.parse(req.expires_at) < Date.now()) throw new ConflictError('error.transfer_expired');
    if (req.otp_verified !== 1) throw new ValidationError('error.transfer_otp_required');

    const at = nowIso();
    this.ctx.db.transaction(() => {
      // Perangkat lama dilepas, perangkat baru diikat.
      this.ctx.db.update(
        'device_bindings',
        { user_id: req.user_id, status: 'active' },
        { status: 'unbound', unbound_at: at, unbound_by: this.ctx.actor.userId },
      );
      this.ctx.db.insert('device_bindings', {
        id: newId('dev'),
        user_id: req.user_id,
        fingerprint_hash: req.new_fingerprint_hash,
        component_hashes_json: req.components_json,
        label: 'Perangkat dipindahkan',
        status: 'active',
        first_seen: at,
        last_seen: at,
        last_ip: null,
        unbound_at: null,
        unbound_by: null,
      });
      this.ctx.db.update(
        'device_transfer_requests',
        { id: requestId },
        { status: 'approved', decided_at: at, decided_by: this.ctx.actor.userId },
      );
    });

    auth.revokeSessionsForUser(this.ctx.tenant.id, req.user_id, 'device_transferred');

    this.ctx.log({
      action: 'device.transfer_approved',
      module: 'Perangkat & Sesi',
      objectType: 'device_transfer',
      objectId: requestId,
      severity: 'critical',
      detail: { userId: req.user_id },
    });
  }

  activeSessions(): Array<{ id: string; user_email: string; issued_at: string; last_seen_at: string; ip: string | null; geo_label: string | null }> {
    this.ctx.require('device:read', { module: 'Perangkat & Sesi' });
    const rows = this.ctx.db.all<{
      id: string;
      user_id: string;
      issued_at: string;
      last_seen_at: string;
      ip: string | null;
      geo_label: string | null;
      revoked_at: string | null;
    }>('active_sessions', { revoked_at: null }, { orderBy: 'last_seen_at DESC' });
    return rows.map((r) => ({
      id: r.id,
      user_email: this.ctx.db.get<{ email: string }>('system_user', { id: r.user_id })?.email ?? '—',
      issued_at: r.issued_at,
      last_seen_at: r.last_seen_at,
      ip: r.ip,
      geo_label: r.geo_label,
    }));
  }
}

/** Menanam 13 peran standar (idempoten). Dipanggil saat bootstrap & provisioning tenant. */
export function seedStandardRoles(db: import('../platform/db.ts').Db): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO roles (id, tenant_id, code, name_id, name_en, is_standard,
                                  permissions_json, denials_json, created_at)
     VALUES (?, NULL, ?, ?, ?, 1, ?, ?, ?)`,
  );
  const at = nowIso();
  for (const role of STANDARD_ROLES) {
    insert.run(
      `role_${role.code}`,
      role.code,
      role.nameId,
      role.nameEn,
      JSON.stringify(role.permissions),
      JSON.stringify(role.denials),
      at,
    );
  }
}
