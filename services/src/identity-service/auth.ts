/**
 * Autentikasi & manajemen sesi — SECURITY.md Bagian 4 & 17, PRD 6.30.
 */
import { randomInt } from 'node:crypto';
import type { AuditService } from '../audit-service/index.ts';
import { newId, nowIso, type Db } from '../platform/db.ts';
import { AppError, UnauthenticatedError, ValidationError } from '../platform/errors.ts';
import {
  generateToken,
  hashPassword,
  hashToken,
  verifyPassword,
  validatePasswordPolicy,
  sha256,
} from '../platform/crypto.ts';
import {
  assessTravel,
  DEFAULT_SIMILARITY_THRESHOLD,
  fingerprintHash,
  hashComponents,
  matchDevice,
  type FingerprintComponents,
} from './deviceFingerprint.ts';

/** Sesi berakhir setelah periode tidak aktif (SECURITY.md Bagian 4). */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
/** Penguncian sementara setelah percobaan gagal berulang (SECURITY.md Bagian 4). */
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;
const PASSWORD_HISTORY_SIZE = 5;

export interface LoginInput {
  email: string;
  password: string;
  tenantSlug?: string;
  fingerprint: FingerprintComponents;
  ip?: string | null;
  geo?: { lat: number; lon: number; label?: string } | null;
}

export interface LoginSuccess {
  kind: 'ok';
  token: string;
  sessionId: string;
  userId: string;
  tenantId: string;
  expiresAt: string;
  deviceId: string;
  /** True bila perangkat baru saja didaftarkan otomatis (perangkat pertama). */
  deviceRegistered: boolean;
}

/**
 * Penolakan selalu menjelaskan ALASAN dan LANGKAH PEMULIHAN, bukan sekadar
 * "akses ditolak" — SECURITY.md 17.4.
 */
export interface LoginRejected {
  kind: 'rejected';
  reasonKey: string;
  /** Kunci i18n untuk langkah pemulihan yang bisa ditempuh pengguna. */
  recoveryKey?: string;
  retryAfter?: string;
}

export type LoginResult = LoginSuccess | LoginRejected;

interface UserRow {
  id: string;
  tenant_id: string;
  employee_id: string;
  email: string;
  password_hash: string | null;
  status: string;
  failed_attempts: number;
  locked_until: string | null;
  password_history_json: string;
  mfa_enrolled: number;
}

interface DeviceRow {
  id: string;
  user_id: string;
  fingerprint_hash: string;
  component_hashes_json: string;
  status: string;
}

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /* ---------------------------------------------------------------- */
  /* Login                                                             */
  /* ---------------------------------------------------------------- */

  login(input: LoginInput): LoginResult {
    const email = input.email.trim().toLowerCase();
    const at = nowIso();
    const user = this.findUser(email, input.tenantSlug);

    if (!user || !user.password_hash) {
      // Pesan generik: tidak membocorkan apakah email terdaftar (user enumeration).
      this.recordAttempt(null, email, input.ip, 'bad_credentials', input.geo);
      this.audit.recordDenial({
        tenantId: user?.tenant_id ?? null,
        actorLabel: email,
        actorIp: input.ip ?? null,
        action: 'auth.login',
        module: 'Otorisasi User',
        detail: { reason: 'bad_credentials' },
      });
      return { kind: 'rejected', reasonKey: 'error.invalid_credentials' };
    }

    if (user.locked_until && Date.parse(user.locked_until) > Date.now()) {
      this.recordAttempt(user.tenant_id, email, input.ip, 'locked', input.geo);
      this.audit.recordDenial({
        tenantId: user.tenant_id,
        actorUserId: user.id,
        actorLabel: email,
        actorIp: input.ip ?? null,
        action: 'auth.login',
        module: 'Otorisasi User',
        detail: { reason: 'account_locked', until: user.locked_until },
      });
      return {
        kind: 'rejected',
        reasonKey: 'error.account_locked',
        recoveryKey: 'recovery.wait_or_contact_admin',
        retryAfter: user.locked_until,
      };
    }

    if (user.status !== 'active') {
      this.recordAttempt(user.tenant_id, email, input.ip, 'bad_credentials', input.geo);
      this.audit.recordDenial({
        tenantId: user.tenant_id,
        actorUserId: user.id,
        actorLabel: email,
        actorIp: input.ip ?? null,
        action: 'auth.login',
        module: 'Otorisasi User',
        detail: { reason: 'account_disabled' },
      });
      return {
        kind: 'rejected',
        reasonKey: 'error.account_disabled',
        recoveryKey: 'recovery.contact_admin',
      };
    }

    if (!verifyPassword(input.password, user.password_hash)) {
      this.registerFailure(user, email, input.ip, input.geo);
      return { kind: 'rejected', reasonKey: 'error.invalid_credentials' };
    }

    // --- Impossible travel (PRD 6.30, SECURITY.md 17.2) -------------
    if (input.geo) {
      const travel = this.checkImpossibleTravel(user, { ...input.geo, at });
      if (travel) return travel;
    }

    // --- Device binding (PRD 6.30) ----------------------------------
    const deviceOutcome = this.resolveDevice(user, input.fingerprint, input.ip ?? null);
    if (deviceOutcome.kind === 'rejected') {
      this.recordAttempt(user.tenant_id, email, input.ip, 'device_rejected', input.geo);
      return deviceOutcome;
    }

    // --- Single active session (PRD 6.30, SECURITY.md 17.2) ---------
    // Ditegakkan di server melalui invalidasi token sesi lama, bukan sekadar
    // menutup tab di sisi klien.
    this.revokeSessionsForUser(user.tenant_id, user.id, 'superseded_by_new_login');

    const token = generateToken();
    const sessionId = newId('ses');
    const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS).toISOString();

    this.db
      .prepare(
        `INSERT INTO active_sessions
           (id, tenant_id, user_id, token_hash, device_id, issued_at, expires_at, last_seen_at,
            ip, geo_lat, geo_lon, geo_label, reauth_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        sessionId,
        user.tenant_id,
        user.id,
        hashToken(token),
        deviceOutcome.deviceId,
        at,
        expiresAt,
        at,
        input.ip ?? null,
        input.geo?.lat ?? null,
        input.geo?.lon ?? null,
        input.geo?.label ?? null,
        at, // login menghitung sebagai autentikasi segar
      );

    this.db
      .prepare(
        `UPDATE system_user SET failed_attempts = 0, locked_until = NULL,
                                last_login_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(at, at, user.id);

    this.recordAttempt(user.tenant_id, email, input.ip, 'success', input.geo);
    this.audit.record({
      tenantId: user.tenant_id,
      actorUserId: user.id,
      actorLabel: email,
      actorIp: input.ip ?? null,
      action: 'auth.login',
      module: 'Otorisasi User',
      objectType: 'session',
      objectId: sessionId,
      detail: {
        deviceId: deviceOutcome.deviceId,
        deviceRegistered: deviceOutcome.registered,
      },
    });

    return {
      kind: 'ok',
      token,
      sessionId,
      userId: user.id,
      tenantId: user.tenant_id,
      expiresAt,
      deviceId: deviceOutcome.deviceId,
      deviceRegistered: deviceOutcome.registered,
    };
  }

  private findUser(email: string, tenantSlug?: string): UserRow | undefined {
    if (tenantSlug) {
      return this.db
        .prepare(
          `SELECT u.* FROM system_user u
             JOIN tenants t ON t.id = u.tenant_id
            WHERE LOWER(u.email) = ? AND t.slug = ? AND t.deleted_at IS NULL`,
        )
        .get(email, tenantSlug) as UserRow | undefined;
    }
    const matches = this.db
      .prepare(
        `SELECT u.* FROM system_user u
           JOIN tenants t ON t.id = u.tenant_id
          WHERE LOWER(u.email) = ? AND t.deleted_at IS NULL`,
      )
      .all(email) as UserRow[];
    // Email yang sama di beberapa tenant menuntut penyebutan tenant secara eksplisit.
    return matches.length === 1 ? matches[0] : undefined;
  }

  private registerFailure(
    user: UserRow,
    email: string,
    ip: string | null | undefined,
    geo: LoginInput['geo'],
  ): void {
    const attempts = user.failed_attempts + 1;
    const shouldLock = attempts >= MAX_FAILED_ATTEMPTS;
    const lockedUntil = shouldLock ? new Date(Date.now() + LOCKOUT_MS).toISOString() : null;

    this.db
      .prepare('UPDATE system_user SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?')
      .run(attempts, lockedUntil, nowIso(), user.id);

    this.recordAttempt(user.tenant_id, email, ip, 'bad_credentials', geo);
    this.audit.recordDenial({
      tenantId: user.tenant_id,
      actorUserId: user.id,
      actorLabel: email,
      actorIp: ip ?? null,
      action: 'auth.login',
      module: 'Otorisasi User',
      detail: { reason: 'bad_credentials', attempts, locked: shouldLock },
    });
  }

  private checkImpossibleTravel(
    user: UserRow,
    current: { lat: number; lon: number; at: string },
  ): LoginRejected | null {
    const previous = this.db
      .prepare(
        `SELECT geo_lat, geo_lon, attempted_at FROM login_attempts
          WHERE email = (SELECT email FROM system_user WHERE id = ?)
            AND outcome = 'success' AND geo_lat IS NOT NULL
          ORDER BY attempted_at DESC LIMIT 1`,
      )
      .get(user.id) as { geo_lat: number; geo_lon: number; attempted_at: string } | undefined;

    if (!previous) return null;

    const verdict = assessTravel(
      { lat: previous.geo_lat, lon: previous.geo_lon, at: previous.attempted_at },
      current,
    );
    if (!verdict.impossible) return null;

    // Blokir sementara + notifikasi ke Admin (PRD 6.30).
    const lockedUntil = new Date(Date.now() + LOCKOUT_MS).toISOString();
    this.db
      .prepare('UPDATE system_user SET locked_until = ?, updated_at = ? WHERE id = ?')
      .run(lockedUntil, nowIso(), user.id);

    this.recordAttempt(user.tenant_id, user.email, null, 'impossible_travel', current);
    this.audit.record({
      tenantId: user.tenant_id,
      actorUserId: user.id,
      actorLabel: user.email,
      action: 'auth.impossible_travel',
      module: 'Perangkat & Sesi',
      severity: 'critical',
      outcome: 'denied',
      detail: {
        distanceKm: Math.round(verdict.distanceKm),
        elapsedHours: Number(verdict.elapsedHours.toFixed(2)),
        impliedSpeedKmh: Math.round(verdict.impliedSpeedKmh),
      },
    });

    return {
      kind: 'rejected',
      reasonKey: 'error.impossible_travel',
      recoveryKey: 'recovery.contact_admin',
      retryAfter: lockedUntil,
    };
  }

  /**
   * Menentukan perangkat: mendaftarkan otomatis bila ini perangkat pertama,
   * mencocokkan dengan toleransi bila sudah ada, menolak bila melewati batas.
   */
  private resolveDevice(
    user: UserRow,
    fingerprint: FingerprintComponents,
    ip: string | null,
  ): { kind: 'ok'; deviceId: string; registered: boolean } | LoginRejected {
    const tenant = this.db
      .prepare('SELECT max_devices_per_user FROM tenants WHERE id = ?')
      .get(user.tenant_id) as { max_devices_per_user: number } | undefined;
    const maxDevices = tenant?.max_devices_per_user ?? 1;

    const devices = this.db
      .prepare("SELECT * FROM device_bindings WHERE tenant_id = ? AND user_id = ? AND status = 'active'")
      .all(user.tenant_id, user.id) as DeviceRow[];

    const at = nowIso();

    for (const device of devices) {
      const match = matchDevice(
        device.fingerprint_hash,
        JSON.parse(device.component_hashes_json),
        fingerprint,
        DEFAULT_SIMILARITY_THRESHOLD,
      );
      if (!match.matched) continue;

      // Perubahan wajar (pembaruan browser/OS): perbarui hash tersimpan agar
      // kemiripan tidak terus menurun sampai akhirnya mengunci pengguna sah.
      if (!match.exact) {
        this.db
          .prepare(
            `UPDATE device_bindings
                SET fingerprint_hash = ?, component_hashes_json = ?, last_seen = ?, last_ip = ?
              WHERE id = ?`,
          )
          .run(
            fingerprintHash(fingerprint),
            JSON.stringify(hashComponents(fingerprint)),
            at,
            ip,
            device.id,
          );
        this.audit.record({
          tenantId: user.tenant_id,
          actorUserId: user.id,
          actorLabel: user.email,
          actorIp: ip,
          action: 'device.fingerprint_drift_accepted',
          module: 'Perangkat & Sesi',
          objectType: 'device',
          objectId: device.id,
          severity: 'notice',
          detail: { similarity: Number(match.score.toFixed(3)) },
        });
      } else {
        this.db
          .prepare('UPDATE device_bindings SET last_seen = ?, last_ip = ? WHERE id = ?')
          .run(at, ip, device.id);
      }
      return { kind: 'ok', deviceId: device.id, registered: false };
    }

    // Perangkat tidak dikenal.
    if (devices.length >= maxDevices) {
      this.audit.recordDenial({
        tenantId: user.tenant_id,
        actorUserId: user.id,
        actorLabel: user.email,
        actorIp: ip,
        action: 'device.login_rejected',
        module: 'Perangkat & Sesi',
        detail: { boundDevices: devices.length, maxDevices },
      });
      return {
        kind: 'rejected',
        reasonKey: 'error.device_not_bound',
        // SECURITY.md 17.4 — sebutkan langkah pemulihan, bukan sekadar penolakan.
        recoveryKey: 'recovery.request_device_transfer',
      };
    }

    // Perangkat pertama (atau masih di bawah batas) didaftarkan otomatis (PRD 6.30).
    const deviceId = newId('dev');
    this.db
      .prepare(
        `INSERT INTO device_bindings
           (id, tenant_id, user_id, fingerprint_hash, component_hashes_json, label,
            status, first_seen, last_seen, last_ip)
         VALUES (?,?,?,?,?,?,'active',?,?,?)`,
      )
      .run(
        deviceId,
        user.tenant_id,
        user.id,
        fingerprintHash(fingerprint),
        JSON.stringify(hashComponents(fingerprint)),
        describeDevice(fingerprint),
        at,
        at,
        ip,
      );

    this.audit.record({
      tenantId: user.tenant_id,
      actorUserId: user.id,
      actorLabel: user.email,
      actorIp: ip,
      action: 'device.registered',
      module: 'Perangkat & Sesi',
      objectType: 'device',
      objectId: deviceId,
      severity: 'notice',
    });

    return { kind: 'ok', deviceId, registered: true };
  }

  private recordAttempt(
    tenantId: string | null,
    email: string,
    ip: string | null | undefined,
    outcome: string,
    geo?: { lat: number; lon: number } | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO login_attempts (id, tenant_id, email, attempted_at, ip, outcome, geo_lat, geo_lon)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(newId('att'), tenantId, email, nowIso(), ip ?? null, outcome, geo?.lat ?? null, geo?.lon ?? null);
  }

  /* ---------------------------------------------------------------- */
  /* Sesi                                                              */
  /* ---------------------------------------------------------------- */

  /** Memvalidasi token sesi. Fail secure: apa pun yang meragukan → ditolak. */
  resolveSession(token: string): { sessionId: string; userId: string; tenantId: string; reauthAt: string | null; deviceId: string | null } {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id, user_id, device_id, expires_at, last_seen_at, revoked_at, reauth_at
           FROM active_sessions WHERE token_hash = ?`,
      )
      .get(hashToken(token)) as
      | {
          id: string;
          tenant_id: string;
          user_id: string;
          device_id: string | null;
          expires_at: string;
          last_seen_at: string;
          revoked_at: string | null;
          reauth_at: string | null;
        }
      | undefined;

    if (!row) throw new UnauthenticatedError('error.session_invalid');
    if (row.revoked_at) throw new UnauthenticatedError('error.session_revoked');
    if (Date.parse(row.expires_at) <= Date.now()) {
      throw new UnauthenticatedError('error.session_expired');
    }
    if (Date.now() - Date.parse(row.last_seen_at) > IDLE_TIMEOUT_MS) {
      this.db
        .prepare("UPDATE active_sessions SET revoked_at = ?, revoked_reason = 'idle_timeout' WHERE id = ?")
        .run(nowIso(), row.id);
      throw new UnauthenticatedError('error.session_idle_timeout');
    }

    this.db.prepare('UPDATE active_sessions SET last_seen_at = ? WHERE id = ?').run(nowIso(), row.id);

    return {
      sessionId: row.id,
      userId: row.user_id,
      tenantId: row.tenant_id,
      reauthAt: row.reauth_at,
      deviceId: row.device_id,
    };
  }

  /** Re-autentikasi untuk aksi sensitif (SECURITY.md Bagian 4). */
  reauthenticate(sessionId: string, userId: string, password: string): boolean {
    const user = this.db.prepare('SELECT password_hash FROM system_user WHERE id = ?').get(userId) as
      | { password_hash: string | null }
      | undefined;
    if (!user?.password_hash || !verifyPassword(password, user.password_hash)) return false;
    this.db.prepare('UPDATE active_sessions SET reauth_at = ? WHERE id = ?').run(nowIso(), sessionId);
    return true;
  }

  logout(sessionId: string, tenantId: string, userId: string, actorLabel: string): void {
    this.db
      .prepare("UPDATE active_sessions SET revoked_at = ?, revoked_reason = 'logout' WHERE id = ?")
      .run(nowIso(), sessionId);
    this.audit.record({
      tenantId,
      actorUserId: userId,
      actorLabel,
      action: 'auth.logout',
      module: 'Otorisasi User',
      objectType: 'session',
      objectId: sessionId,
    });
  }

  revokeSessionsForUser(tenantId: string, userId: string, reason: string): number {
    return this.db
      .prepare(
        `UPDATE active_sessions SET revoked_at = ?, revoked_reason = ?
          WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL`,
      )
      .run(nowIso(), reason, tenantId, userId).changes;
  }

  /* ---------------------------------------------------------------- */
  /* Kata sandi                                                        */
  /* ---------------------------------------------------------------- */

  /** SECURITY.md Bagian 4: tidak boleh sama dengan 5 kata sandi terakhir. */
  changePassword(userId: string, newPassword: string): void {
    const policy = validatePasswordPolicy(newPassword);
    if (!policy.ok) throw new ValidationError(policy.reasonKey!);

    const user = this.db
      .prepare('SELECT password_hash, password_history_json FROM system_user WHERE id = ?')
      .get(userId) as { password_hash: string | null; password_history_json: string } | undefined;
    if (!user) throw new AppError(404, 'error.not_found');

    const history: string[] = JSON.parse(user.password_history_json);
    const candidates = [user.password_hash, ...history].filter(Boolean) as string[];
    for (const previous of candidates.slice(0, PASSWORD_HISTORY_SIZE)) {
      if (verifyPassword(newPassword, previous)) {
        throw new ValidationError('error.password_reused');
      }
    }

    const nextHistory = [user.password_hash, ...history]
      .filter(Boolean)
      .slice(0, PASSWORD_HISTORY_SIZE) as string[];

    this.db
      .prepare('UPDATE system_user SET password_hash = ?, password_history_json = ?, updated_at = ? WHERE id = ?')
      .run(hashPassword(newPassword), JSON.stringify(nextHistory), nowIso(), userId);
  }

  /* ---------------------------------------------------------------- */
  /* Permintaan pemindahan perangkat (PRD 6.30)                        */
  /* ---------------------------------------------------------------- */

  /**
   * Pengguna mengajukan pemindahan perangkat secara mandiri. Permintaan memerlukan
   * persetujuan Admin DAN verifikasi tambahan (OTP) — jalur ini adalah titik lemah
   * paling mungkin disalahgunakan untuk berbagi akun (SECURITY.md 17.2).
   */
  requestDeviceTransfer(input: {
    tenantId: string;
    userId: string;
    actorLabel: string;
    fingerprint: FingerprintComponents;
    reason?: string;
  }): { requestId: string; otp: string; expiresAt: string } {
    // OTP adalah FAKTOR AUTENTIKASI, jadi harus dari sumber acak kriptografis.
    //
    // `Math.random()` dapat diprediksi: keadaan xorshift128+ V8 dapat direkonstruksi
    // dari beberapa keluaran, sehingga penyerang yang dapat memicu permintaan
    // pemindahan miliknya sendiri berpeluang menebak OTP pengguna lain — persis pada
    // jalur yang komentar di atas sebut "paling mungkin disalahgunakan".
    // `randomInt` juga tidak bias, berbeda dari `Math.floor(rand * rentang)`.
    const otp = String(randomInt(100_000, 1_000_000));
    const id = newId('dtr');
    const at = nowIso();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    this.db
      .prepare(
        `INSERT INTO device_transfer_requests
           (id, tenant_id, user_id, new_fingerprint_hash, components_json, reason,
            otp_hash, otp_verified, status, requested_at, expires_at)
         VALUES (?,?,?,?,?,?,?,0,'pending',?,?)`,
      )
      .run(
        id,
        input.tenantId,
        input.userId,
        fingerprintHash(input.fingerprint),
        JSON.stringify(hashComponents(input.fingerprint)),
        input.reason ?? null,
        sha256(otp),
        at,
        expiresAt,
      );

    this.audit.record({
      tenantId: input.tenantId,
      actorUserId: input.userId,
      actorLabel: input.actorLabel,
      action: 'device.transfer_requested',
      module: 'Perangkat & Sesi',
      objectType: 'device_transfer',
      objectId: id,
      severity: 'notice',
    });

    // OTP dikembalikan agar dapat dikirim lewat kanal terpisah (email); tidak disimpan
    // sebagai teks biasa.
    return { requestId: id, otp, expiresAt };
  }

  verifyTransferOtp(requestId: string, otp: string): boolean {
    const row = this.db
      .prepare("SELECT otp_hash, expires_at, status FROM device_transfer_requests WHERE id = ?")
      .get(requestId) as { otp_hash: string; expires_at: string; status: string } | undefined;
    if (!row || row.status !== 'pending' || Date.parse(row.expires_at) < Date.now()) return false;
    if (sha256(otp) !== row.otp_hash) return false;
    this.db.prepare('UPDATE device_transfer_requests SET otp_verified = 1 WHERE id = ?').run(requestId);
    return true;
  }
}

/** Label perangkat yang dapat dibaca manusia untuk halaman "Perangkat Saya" (PRD 6.30). */
export function describeDevice(fp: FingerprintComponents): string {
  const ua = fp.userAgent;
  const os = /Windows/i.test(ua)
    ? 'Windows'
    : /Mac OS X|Macintosh/i.test(ua)
      ? 'macOS'
      : /Android/i.test(ua)
        ? 'Android'
        : /iPhone|iPad|iOS/i.test(ua)
          ? 'iOS'
          : /Linux/i.test(ua)
            ? 'Linux'
            : 'Unknown OS';
  const browser = /Edg\//i.test(ua)
    ? 'Edge'
    : /Chrome\//i.test(ua)
      ? 'Chrome'
      : /Safari\//i.test(ua)
        ? 'Safari'
        : /Firefox\//i.test(ua)
          ? 'Firefox'
          : 'Browser';
  return `${browser} · ${os} · ${fp.screenResolution}`;
}
