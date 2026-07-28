/**
 * Autentikasi & manajemen sesi — SECURITY.md Bagian 4 & 17, PRD 6.30.
 */
import { randomBytes, randomInt } from 'node:crypto';
import type { NotificationOutbox } from '../platform/outbox.ts';
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
  generateMfaSecret,
  generateRecoveryCodes,
  normaliseRecoveryCode,
  otpauthUri,
  verifyTotp,
} from '../platform/totp.ts';
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

/**
 * Umur token pemulihan kata sandi.
 *
 * Pendek karena token itu setara kata sandi selama masih hidup. Tiga puluh menit cukup
 * untuk membaca pesan dan mengetik sandi baru, tetapi terlalu singkat untuk berguna bila
 * pesannya kelak ditemukan di kotak masuk yang sudah tidak dijaga.
 */
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

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

/**
 * Kata sandi & perangkat sudah lolos, tetapi faktor kedua belum.
 *
 * Sengaja TIDAK memuat sesi, token sesi, atau apa pun yang dapat memanggil API: sampai
 * kode terverifikasi, pemanggil tidak memiliki kewenangan apa pun. `challengeToken`
 * hanya berguna untuk satu hal, yaitu menyelesaikan langkah kedua.
 */
export interface LoginMfaRequired {
  kind: 'mfa_required';
  challengeToken: string;
  expiresAt: string;
  /** Memberi tahu klien bahwa kode pemulihan juga diterima di kolom yang sama. */
  recoveryAccepted: true;
}

export type LoginResult = LoginSuccess | LoginRejected | LoginMfaRequired;

/** Masa hidup tantangan MFA. Cukup untuk membuka aplikasi autentikator, tidak lebih. */
export const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * Batas percobaan kode per tantangan.
 *
 * Kode 6 digit hanya punya 10⁶ kemungkinan, jadi batasnya harus per-tantangan, bukan
 * hanya per-satuan waktu: tanpa ini penyerang dapat menebak berkali-kali pada satu
 * tantangan yang masih hidup. Habis percobaan → tantangan mati, harus login ulang.
 */
export const MFA_MAX_CHALLENGE_ATTEMPTS = 5;

/** Kegagalan MFA berturut-turut yang mengunci akun, sejalan dengan kebijakan kata sandi. */
export const MFA_LOCKOUT_THRESHOLD = 10;

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
  mfa_secret: string | null;
  mfa_last_counter: number | null;
  mfa_failed_attempts: number;
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
    /**
     * Outbox opsional.
     *
     * Opsional supaya pengujian unit dapat membangun AuthService tanpa merangkai
     * penyimpanan pesan. Bila tidak diberikan, OTP pemindahan perangkat tetap dibuat dan
     * di-hash, tetapi tidak ada yang mengirimkannya — dan `beginDeviceTransfer()`
     * mengembalikan `courierAvailable: false` supaya pemanggil dapat menyatakan itu
     * kepada pengguna alih-alih membiarkannya menunggu pesan yang tak akan datang.
     */
    private readonly outbox?: NotificationOutbox,
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

    // --- Faktor kedua (SECURITY.md Bagian 4) ------------------------
    //
    // Bila MFA sudah aktif, sesi TIDAK diterbitkan di sini. Yang diterbitkan adalah
    // tantangan berumur pendek; kata sandi tidak perlu dikirim ulang pada langkah
    // kedua, dan tidak ada keadaan setengah-masuk yang dapat memanggil API.
    if (user.mfa_enrolled === 1 && user.mfa_secret) {
      return this.issueMfaChallenge(user, email, deviceOutcome.deviceId, input, at);
    }

    return this.issueSession(user, email, deviceOutcome, input.ip ?? null, input.geo ?? null, at, {
      mfaUsed: null,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Penerbitan sesi                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Dipisah dari `login()` supaya jalur "kata sandi saja" dan jalur "kata sandi + MFA"
   * menerbitkan sesi dengan cara yang IDENTIK. Menduplikasi blok ini akan membuat kedua
   * jalur bisa menyimpang — mis. satu lupa menyetel `reauth_at` atau lupa mereset
   * penghitung kegagalan.
   */
  private issueSession(
    user: UserRow,
    email: string,
    deviceOutcome: { deviceId: string; registered: boolean },
    ip: string | null,
    geo: { lat: number; lon: number; label?: string } | null,
    at: string,
    options: { mfaUsed: 'totp' | 'recovery_code' | null },
  ): LoginSuccess {
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
        ip,
        geo?.lat ?? null,
        geo?.lon ?? null,
        geo?.label ?? null,
        at, // login menghitung sebagai autentikasi segar
      );

    this.db
      .prepare(
        `UPDATE system_user SET failed_attempts = 0, locked_until = NULL, mfa_failed_attempts = 0,
                                last_login_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(at, at, user.id);

    this.recordAttempt(user.tenant_id, email, ip, 'success', geo);
    this.audit.record({
      tenantId: user.tenant_id,
      actorUserId: user.id,
      actorLabel: email,
      actorIp: ip,
      action: 'auth.login',
      module: 'Otorisasi User',
      objectType: 'session',
      objectId: sessionId,
      detail: {
        deviceId: deviceOutcome.deviceId,
        deviceRegistered: deviceOutcome.registered,
        // Dicatat supaya Auditor dapat membedakan masuk dengan autentikator dari
        // masuk dengan kode pemulihan — yang kedua layak ditinjau.
        mfa: options.mfaUsed,
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

  /* ---------------------------------------------------------------- */
  /* MFA — TOTP (SECURITY.md Bagian 4)                                 */
  /* ---------------------------------------------------------------- */

  /** Langkah kedua login: menerbitkan tantangan, bukan sesi. */
  private issueMfaChallenge(
    user: UserRow,
    email: string,
    deviceId: string,
    input: LoginInput,
    at: string,
  ): LoginMfaRequired {
    // Tantangan lama pengguna ini dimatikan lebih dulu. Membiarkan beberapa tantangan
    // hidup bersamaan akan mengalikan jumlah percobaan tebakan yang tersedia.
    this.db
      .prepare('UPDATE mfa_challenges SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL')
      .run(at, user.id);

    const challengeToken = generateToken();
    const expiresAt = new Date(Date.now() + MFA_CHALLENGE_TTL_MS).toISOString();

    this.db
      .prepare(
        `INSERT INTO mfa_challenges
           (id, tenant_id, user_id, token_hash, device_id, fingerprint_hash, ip, geo_json,
            attempts, issued_at, expires_at, consumed_at)
         VALUES (?,?,?,?,?,?,?,?,0,?,?,NULL)`,
      )
      .run(
        newId('mfc'),
        user.tenant_id,
        user.id,
        hashToken(challengeToken),
        deviceId,
        fingerprintHash(input.fingerprint),
        input.ip ?? null,
        input.geo ? JSON.stringify(input.geo) : null,
        at,
        expiresAt,
      );

    this.audit.record({
      tenantId: user.tenant_id,
      actorUserId: user.id,
      actorLabel: email,
      actorIp: input.ip ?? null,
      action: 'auth.mfa_challenge_issued',
      module: 'Otorisasi User',
      objectType: 'user',
      objectId: user.id,
      detail: { deviceId },
    });

    return { kind: 'mfa_required', challengeToken, expiresAt, recoveryAccepted: true };
  }

  /**
   * Menyelesaikan langkah kedua.
   *
   * Menerima kode TOTP maupun kode pemulihan di kolom yang sama: pengguna yang panik
   * karena ponselnya hilang tidak perlu menemukan menu berbeda, dan servernya toh
   * dapat membedakan keduanya dari bentuknya.
   */
  verifyMfaChallenge(input: {
    challengeToken: string;
    code: string;
    fingerprint: FingerprintComponents;
    ip?: string | null;
  }): LoginResult {
    const at = nowIso();
    const challenge = this.db
      .prepare('SELECT * FROM mfa_challenges WHERE token_hash = ?')
      .get(hashToken(input.challengeToken)) as
      | {
          id: string;
          tenant_id: string;
          user_id: string;
          device_id: string | null;
          fingerprint_hash: string | null;
          ip: string | null;
          geo_json: string | null;
          attempts: number;
          expires_at: string;
          consumed_at: string | null;
        }
      | undefined;

    // Tantangan tidak dikenal / sudah dipakai / kedaluwarsa → semuanya dibalas sama,
    // supaya tidak ada cara membedakan "token salah" dari "token kedaluwarsa".
    if (!challenge || challenge.consumed_at || Date.parse(challenge.expires_at) <= Date.now()) {
      return { kind: 'rejected', reasonKey: 'error.mfa_challenge_invalid', recoveryKey: 'recovery.login_again' };
    }

    // Tantangan terikat pada perangkat yang memulainya. Tanpa ini, token tantangan yang
    // tercuri dapat diselesaikan dari perangkat lain — melemahkan device binding
    // justru di langkah yang seharusnya memperkuatnya.
    if (challenge.fingerprint_hash && challenge.fingerprint_hash !== fingerprintHash(input.fingerprint)) {
      this.consumeChallenge(challenge.id, at);
      this.audit.recordDenial({
        tenantId: challenge.tenant_id,
        actorUserId: challenge.user_id,
        actorLabel: challenge.user_id,
        actorIp: input.ip ?? null,
        action: 'auth.mfa_challenge_device_mismatch',
        module: 'Otorisasi User',
        // `recordDenial` menetapkan severity sendiri — seluruh penolakan diperlakukan
        // sebagai potensi insiden keamanan (SECURITY.md Bagian 9).
        detail: { challengeId: challenge.id },
      });
      return { kind: 'rejected', reasonKey: 'error.mfa_challenge_invalid', recoveryKey: 'recovery.login_again' };
    }

    if (challenge.attempts >= MFA_MAX_CHALLENGE_ATTEMPTS) {
      this.consumeChallenge(challenge.id, at);
      return {
        kind: 'rejected',
        reasonKey: 'error.mfa_too_many_attempts',
        recoveryKey: 'recovery.login_again',
      };
    }

    const user = this.db.prepare('SELECT * FROM system_user WHERE id = ?').get(challenge.user_id) as
      | UserRow
      | undefined;
    if (!user || user.status !== 'active' || !user.mfa_secret) {
      this.consumeChallenge(challenge.id, at);
      return { kind: 'rejected', reasonKey: 'error.mfa_challenge_invalid', recoveryKey: 'recovery.login_again' };
    }

    const outcome = this.checkSecondFactor(user, input.code, input.ip ?? null);
    if (!outcome.ok) {
      this.db
        .prepare('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE id = ?')
        .run(challenge.id);
      this.registerMfaFailure(user, input.ip ?? null);
      const remaining = MFA_MAX_CHALLENGE_ATTEMPTS - (challenge.attempts + 1);
      if (remaining <= 0) this.consumeChallenge(challenge.id, at);
      return {
        kind: 'rejected',
        reasonKey: 'error.mfa_code_invalid',
        recoveryKey: remaining > 0 ? 'recovery.try_code_again' : 'recovery.login_again',
      };
    }

    this.consumeChallenge(challenge.id, at);

    const geo = challenge.geo_json
      ? (JSON.parse(challenge.geo_json) as { lat: number; lon: number; label?: string })
      : null;

    return this.issueSession(
      user,
      user.email,
      { deviceId: challenge.device_id ?? '', registered: false },
      input.ip ?? null,
      geo,
      at,
      { mfaUsed: outcome.method },
    );
  }

  private consumeChallenge(id: string, at: string): void {
    this.db.prepare('UPDATE mfa_challenges SET consumed_at = ? WHERE id = ?').run(at, id);
  }

  /**
   * Memeriksa kode TOTP, lalu kode pemulihan bila TOTP gagal.
   *
   * Anti-replay TOTP ditegakkan lewat `mfa_last_counter`: langkah waktu yang sudah
   * pernah dipakai ditolak walau kodenya secara matematis masih sah dalam jendelanya.
   */
  private checkSecondFactor(
    user: UserRow,
    code: string,
    ip: string | null,
  ): { ok: true; method: 'totp' | 'recovery_code' } | { ok: false } {
    const totp = verifyTotp(user.mfa_secret!, code, { minCounter: user.mfa_last_counter ?? undefined });
    if (totp.valid && totp.counter !== null) {
      this.db
        .prepare('UPDATE system_user SET mfa_last_counter = ?, mfa_failed_attempts = 0, updated_at = ? WHERE id = ?')
        .run(totp.counter, nowIso(), user.id);
      return { ok: true, method: 'totp' };
    }

    const candidate = sha256(normaliseRecoveryCode(code));
    const recovery = this.db
      .prepare('SELECT id FROM mfa_recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL')
      .get(user.id, candidate) as { id: string } | undefined;

    if (recovery) {
      const at = nowIso();
      // Sekali pakai: ditandai terpakai SEBELUM sesi diterbitkan, sehingga dua
      // permintaan bersamaan dengan kode yang sama tidak keduanya berhasil.
      this.db.prepare('UPDATE mfa_recovery_codes SET used_at = ?, used_ip = ? WHERE id = ?').run(at, ip, recovery.id);
      const remaining = this.countUnusedRecoveryCodes(user.id);
      this.audit.record({
        tenantId: user.tenant_id,
        actorUserId: user.id,
        actorLabel: user.email,
        actorIp: ip,
        action: 'auth.mfa_recovery_code_used',
        module: 'Otorisasi User',
        objectType: 'user',
        objectId: user.id,
        // Pemakaian kode pemulihan layak ditinjau: bisa jadi ponsel hilang, bisa juga
        // penyalahgunaan. Sisa kode disertakan agar habisnya tidak mengejutkan.
        severity: 'warning',
        detail: { remainingRecoveryCodes: remaining },
      });
      return { ok: true, method: 'recovery_code' };
    }

    return { ok: false };
  }

  private countUnusedRecoveryCodes(userId: string): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL')
        .get(userId) as { n: number }
    ).n;
  }

  /** Kegagalan MFA berulang mengunci akun, sama seperti kegagalan kata sandi. */
  private registerMfaFailure(user: UserRow, ip: string | null): void {
    const attempts = (user.mfa_failed_attempts ?? 0) + 1;
    const at = nowIso();
    const lock = attempts >= MFA_LOCKOUT_THRESHOLD;

    this.db
      .prepare('UPDATE system_user SET mfa_failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?')
      .run(attempts, lock ? new Date(Date.now() + LOCKOUT_MS).toISOString() : user.locked_until, at, user.id);

    this.audit.recordDenial({
      tenantId: user.tenant_id,
      actorUserId: user.id,
      actorLabel: user.email,
      actorIp: ip,
      action: 'auth.mfa_failed',
      module: 'Otorisasi User',
      detail: { attempts, locked: lock },
    });
  }

  /* ---------------- Pendaftaran & pengelolaan MFA ---------------- */

  /**
   * Langkah 1 pendaftaran: membuat rahasia TETAPI belum mengaktifkan.
   *
   * Rahasia yang dibuat lalu ditinggalkan tidak boleh membuat akun tiba-tiba menuntut
   * kode — itu akan mengunci pengguna yang sekadar membuka halaman pengaturan lalu
   * menutupnya. Karena itu `mfa_enrolled` baru berubah pada `activateMfa()`.
   */
  beginMfaEnrolment(input: {
    tenantId: string;
    userId: string;
    issuer?: string;
  }): { secret: string; otpauthUri: string; alreadyActive: boolean } {
    const user = this.requireUser(input.tenantId, input.userId);
    if (user.mfa_enrolled === 1) {
      // Rahasia yang aktif TIDAK pernah dikembalikan lagi. Mengembalikannya berarti
      // sesi yang dibajak dapat menyalin faktor kedua korban.
      return { secret: '', otpauthUri: '', alreadyActive: true };
    }

    const secret = generateMfaSecret();
    this.db
      .prepare('UPDATE system_user SET mfa_secret = ?, mfa_last_counter = NULL, updated_at = ? WHERE id = ?')
      .run(secret, nowIso(), user.id);

    return {
      secret,
      otpauthUri: otpauthUri({
        secret,
        accountLabel: user.email,
        issuer: input.issuer && input.issuer.trim() !== '' ? input.issuer : 'Vantik Analytics',
      }),
      alreadyActive: false,
    };
  }

  /** Langkah 2: kode yang benar membuktikan autentikator tersimpan, baru MFA diaktifkan. */
  activateMfa(input: {
    tenantId: string;
    userId: string;
    code: string;
    ip?: string | null;
  }): { activated: boolean; recoveryCodes: string[]; reasonKey?: string } {
    const user = this.requireUser(input.tenantId, input.userId);
    if (user.mfa_enrolled === 1) return { activated: false, recoveryCodes: [], reasonKey: 'error.mfa_already_active' };
    if (!user.mfa_secret) return { activated: false, recoveryCodes: [], reasonKey: 'error.mfa_not_started' };

    const verification = verifyTotp(user.mfa_secret, input.code);
    if (!verification.valid) {
      this.registerMfaFailure(user, input.ip ?? null);
      return { activated: false, recoveryCodes: [], reasonKey: 'error.mfa_code_invalid' };
    }

    const at = nowIso();
    const codes = generateRecoveryCodes();

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE system_user
              SET mfa_enrolled = 1, mfa_activated_at = ?, mfa_last_counter = ?,
                  mfa_failed_attempts = 0, updated_at = ?
            WHERE id = ?`,
        )
        .run(at, verification.counter, at, user.id);
      this.replaceRecoveryCodes(user, codes, at);
    })();

    this.audit.record({
      tenantId: user.tenant_id,
      actorUserId: user.id,
      actorLabel: user.email,
      actorIp: input.ip ?? null,
      action: 'auth.mfa_activated',
      module: 'Otorisasi User',
      objectType: 'user',
      objectId: user.id,
      severity: 'notice',
      detail: { recoveryCodesIssued: codes.length },
    });

    // Kode dikembalikan SEKALI ini saja; setelahnya hanya hash-nya yang tersimpan.
    return { activated: true, recoveryCodes: codes };
  }

  /**
   * Mematikan MFA.
   *
   * Menuntut kode yang sah, bukan hanya sesi yang aktif: sesi yang dibajak tidak boleh
   * dapat melepas faktor kedua korban. Peran yang mewajibkan MFA ditolak sepenuhnya —
   * pemeriksaan `mfaRequired` ada di pemanggil karena di situlah peran diketahui.
   */
  disableMfa(input: {
    tenantId: string;
    userId: string;
    code: string;
    ip?: string | null;
  }): { disabled: boolean; reasonKey?: string } {
    const user = this.requireUser(input.tenantId, input.userId);
    if (user.mfa_enrolled !== 1 || !user.mfa_secret) {
      return { disabled: false, reasonKey: 'error.mfa_not_active' };
    }

    const outcome = this.checkSecondFactor(user, input.code, input.ip ?? null);
    if (!outcome.ok) {
      this.registerMfaFailure(user, input.ip ?? null);
      return { disabled: false, reasonKey: 'error.mfa_code_invalid' };
    }

    const at = nowIso();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE system_user
              SET mfa_enrolled = 0, mfa_secret = NULL, mfa_activated_at = NULL,
                  mfa_last_counter = NULL, updated_at = ?
            WHERE id = ?`,
        )
        .run(at, user.id);
      this.db.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?').run(user.id);
    })();

    this.audit.record({
      tenantId: user.tenant_id,
      actorUserId: user.id,
      actorLabel: user.email,
      actorIp: input.ip ?? null,
      action: 'auth.mfa_disabled',
      module: 'Otorisasi User',
      objectType: 'user',
      objectId: user.id,
      // Melepas faktor kedua adalah penurunan postur keamanan akun — selalu critical.
      severity: 'critical',
      detail: { method: outcome.method },
    });

    return { disabled: true };
  }

  /** Menerbitkan ulang kode pemulihan; yang lama langsung tidak berlaku. */
  regenerateRecoveryCodes(input: {
    tenantId: string;
    userId: string;
    code: string;
    ip?: string | null;
  }): { codes: string[]; reasonKey?: string } {
    const user = this.requireUser(input.tenantId, input.userId);
    if (user.mfa_enrolled !== 1 || !user.mfa_secret) return { codes: [], reasonKey: 'error.mfa_not_active' };

    // Kode pemulihan tidak diterima untuk aksi ini — hanya TOTP. Kalau tidak, satu kode
    // pemulihan yang bocor dapat dipakai untuk mencetak sepuluh yang baru dan
    // mempertahankan akses selamanya.
    const verification = verifyTotp(user.mfa_secret, input.code, { minCounter: user.mfa_last_counter ?? undefined });
    if (!verification.valid) {
      this.registerMfaFailure(user, input.ip ?? null);
      return { codes: [], reasonKey: 'error.mfa_code_invalid' };
    }

    const at = nowIso();
    const codes = generateRecoveryCodes();
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE system_user SET mfa_last_counter = ?, updated_at = ? WHERE id = ?')
        .run(verification.counter, at, user.id);
      this.replaceRecoveryCodes(user, codes, at);
    })();

    this.audit.record({
      tenantId: user.tenant_id,
      actorUserId: user.id,
      actorLabel: user.email,
      actorIp: input.ip ?? null,
      action: 'auth.mfa_recovery_codes_regenerated',
      module: 'Otorisasi User',
      objectType: 'user',
      objectId: user.id,
      severity: 'notice',
      detail: { issued: codes.length },
    });

    return { codes };
  }

  /** Status MFA untuk ditampilkan di profil. Tidak pernah memuat rahasianya. */
  mfaStatus(tenantId: string, userId: string): {
    enrolled: boolean;
    activatedAt: string | null;
    secretPending: boolean;
    remainingRecoveryCodes: number;
  } {
    const user = this.requireUser(tenantId, userId);
    return {
      enrolled: user.mfa_enrolled === 1,
      activatedAt: (user as UserRow & { mfa_activated_at: string | null }).mfa_activated_at ?? null,
      secretPending: user.mfa_enrolled !== 1 && Boolean(user.mfa_secret),
      remainingRecoveryCodes: this.countUnusedRecoveryCodes(userId),
    };
  }

  private replaceRecoveryCodes(user: UserRow, codes: string[], at: string): void {
    this.db.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?').run(user.id);
    const insert = this.db.prepare(
      `INSERT INTO mfa_recovery_codes (id, tenant_id, user_id, code_hash, created_at, used_at, used_ip)
       VALUES (?,?,?,?,?,NULL,NULL)`,
    );
    for (const code of codes) {
      insert.run(newId('mrc'), user.tenant_id, user.id, sha256(normaliseRecoveryCode(code)), at);
    }
  }

  /**
   * Pengguna dalam tenant pemanggil.
   *
   * `tenant_id` selalu ikut dalam kondisi WHERE: `userId` datang dari sesi, tetapi
   * memasangkannya dengan tenant membuat kekeliruan pemanggil tidak dapat menyeberang
   * batas tenant (SECURITY.md 16.1).
   */
  private requireUser(tenantId: string, userId: string): UserRow {
    const user = this.db
      .prepare('SELECT * FROM system_user WHERE id = ? AND tenant_id = ?')
      .get(userId, tenantId) as UserRow | undefined;
    if (!user) throw new UnauthenticatedError();
    return user;
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

  /**
   * Pintu masuk PUBLIK jalur pemulihan perangkat.
   *
   * Harus publik: pengguna yang perlu memindahkan perangkat justru TIDAK dapat masuk —
   * itu sebabnya ia di sini. Sebelumnya `requestDeviceTransfer()` tidak dipanggil rute
   * mana pun, sehingga `recovery.request_device_transfer` yang dijanjikan pada penolakan
   * `error.device_not_bound` menunjuk ke jalur yang tidak ada: pengguna sah dengan laptop
   * baru terkunci permanen.
   *
   * Kata sandi tetap diverifikasi di sini. Tanpa itu, siapa pun yang tahu email seseorang
   * dapat membanjiri kotak masuknya dengan OTP dan memicu peninjauan Admin berulang.
   *
   * OTP TIDAK PERNAH dikembalikan ke pemanggil. Ia dikirim ke alamat TERDAFTAR pengguna
   * lewat outbox. Itulah inti kontrolnya: yang dibuktikan bukan "saya tahu kata sandinya"
   * (itu sudah dibuktikan) melainkan "saya menguasai kontak terdaftar akun ini" — persis
   * pembeda antara pemilik akun dan rekan yang meminjam kredensial, yang oleh komentar
   * di atas disebut penyalahgunaan paling mungkin.
   */
  beginDeviceTransfer(input: {
    email: string;
    password: string;
    tenantSlug?: string;
    fingerprint: FingerprintComponents;
    reason?: string;
    ip?: string | null;
  }):
    | { accepted: true; requestId: string; expiresAt: string; courierAvailable: boolean }
    | { accepted: false; reasonKey: string } {
    const email = input.email.trim().toLowerCase();
    const user = this.findUser(email, input.tenantSlug);

    // Balasan seragam untuk email tak dikenal, kata sandi salah, dan akun nonaktif:
    // endpoint publik ini tidak boleh menjadi cara memetakan siapa saja yang terdaftar.
    if (!user || !user.password_hash || user.status !== 'active' || !verifyPassword(input.password, user.password_hash)) {
      this.audit.recordDenial({
        tenantId: user?.tenant_id ?? null,
        actorUserId: user?.id ?? null,
        actorLabel: email,
        actorIp: input.ip ?? null,
        action: 'device.transfer_request_denied',
        module: 'Perangkat & Sesi',
        detail: { reason: 'bad_credentials' },
      });
      return { accepted: false, reasonKey: 'error.invalid_credentials' };
    }

    // Permintaan lama dimatikan lebih dulu: beberapa permintaan hidup bersamaan
    // mengalikan jumlah tebakan OTP yang tersedia.
    this.db
      .prepare("UPDATE device_transfer_requests SET status = 'expired' WHERE user_id = ? AND status = 'pending'")
      .run(user.id);

    const { requestId, otp, expiresAt } = this.requestDeviceTransfer({
      tenantId: user.tenant_id,
      userId: user.id,
      actorLabel: email,
      fingerprint: input.fingerprint,
      reason: input.reason,
    });

    this.outbox?.enqueue({
      tenantId: user.tenant_id,
      purpose: 'device_transfer_otp',
      channel: 'email',
      recipient: user.email,
      subject: 'Kode verifikasi pemindahan perangkat',
      body:
        `Kode verifikasi pemindahan perangkat Anda: ${otp}\n` +
        `Berlaku sampai ${expiresAt}.\n\n` +
        'Bila Anda tidak meminta pemindahan perangkat, abaikan pesan ini dan hubungi Admin.',
      // Ditandai sensitif supaya pembaca outbox tidak dapat membaca OTP orang lain.
      sensitive: true,
    });

    return { accepted: true, requestId, expiresAt, courierAvailable: Boolean(this.outbox) };
  }

  /**
   * Verifikasi OTP pemindahan perangkat.
   *
   * `approveTransfer()` menuntut `otp_verified === 1`, tetapi sebelumnya TIDAK ADA kode
   * yang pernah menyetel kolom itu — gerbangnya mustahil dilewati, sehingga persetujuan
   * Admin pun selalu gagal. Ini yang menutupnya.
   */
  verifyDeviceTransferOtp(input: {
    requestId: string;
    otp: string;
    ip?: string | null;
  }): { verified: boolean; reasonKey?: string } {
    const request = this.db
      .prepare('SELECT * FROM device_transfer_requests WHERE id = ?')
      .get(input.requestId) as
      | {
          id: string;
          tenant_id: string;
          user_id: string;
          otp_hash: string;
          otp_verified: number;
          status: string;
          expires_at: string;
        }
      | undefined;

    if (!request || request.status !== 'pending' || Date.parse(request.expires_at) <= Date.now()) {
      return { verified: false, reasonKey: 'error.transfer_not_pending' };
    }
    if (request.otp_verified === 1) return { verified: true };

    // Perbandingan atas HASH, bukan teks: OTP tidak pernah disimpan terbaca.
    if (sha256(input.otp.replace(/\s/g, '')) !== request.otp_hash) {
      this.audit.recordDenial({
        tenantId: request.tenant_id,
        actorUserId: request.user_id,
        actorLabel: request.user_id,
        actorIp: input.ip ?? null,
        action: 'device.transfer_otp_failed',
        module: 'Perangkat & Sesi',
        detail: { requestId: request.id },
      });
      return { verified: false, reasonKey: 'error.transfer_otp_invalid' };
    }

    this.db.prepare('UPDATE device_transfer_requests SET otp_verified = 1 WHERE id = ?').run(request.id);
    this.audit.record({
      tenantId: request.tenant_id,
      actorUserId: request.user_id,
      actorLabel: request.user_id,
      actorIp: input.ip ?? null,
      action: 'device.transfer_otp_verified',
      module: 'Perangkat & Sesi',
      objectType: 'device_transfer',
      objectId: request.id,
      severity: 'notice',
      // Verifikasi OTP BUKAN persetujuan. Admin masih harus menyetujui — dua gerbang
      // independen, sesuai PRD 6.30.
      detail: { awaitingAdminApproval: true },
    });
    return { verified: true };
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

  /* ---------------------------------------------------------------- */
  /* Pemulihan kata sandi (SECURITY.md Bagian 4)                       */
  /* ---------------------------------------------------------------- */

  /**
   * Mengajukan pemulihan kata sandi.
   *
   * SELALU mengembalikan bentuk jawaban yang sama, ada atau tidak ada akun dengan alamat
   * itu. Formulir yang menjawab berbeda untuk alamat terdaftar dan tidak terdaftar adalah
   * alat pemetaan gratis: siapa pun dapat menguji daftar alamat dan tahu mana yang punya
   * akun di organisasi ini. Jadi keberadaan akun tidak pernah bocor lewat nilai kembalian —
   * yang membedakan hanya ada-tidaknya pesan di antrean, dan antrean itu hanya dapat dibaca
   * pemegang izin.
   *
   * Tokennya disimpan sebagai hash, sama seperti token sesi dan kode pemulihan MFA: basis
   * data yang bocor tidak boleh menjadi kunci untuk merebut setiap akun di dalamnya.
   */
  requestPasswordReset(input: { email: string; tenantSlug?: string; ip?: string | null }): {
    accepted: true;
    /** Hanya untuk pengujian & operator; TIDAK pernah dikembalikan lewat HTTP. */
    tokenForDelivery?: string;
  } {
    const email = input.email.trim().toLowerCase();
    const at = nowIso();

    const tenant = input.tenantSlug
      ? (this.db.prepare('SELECT id FROM tenants WHERE slug = ?').get(input.tenantSlug) as
          | { id: string }
          | undefined)
      : undefined;

    const user = this.db
      .prepare(
        `SELECT u.id, u.tenant_id, u.status FROM system_user u
          WHERE lower(u.email) = ?${input.tenantSlug ? ' AND u.tenant_id = ?' : ''}
          LIMIT 1`,
      )
      .get(...(input.tenantSlug ? [email, tenant?.id ?? ''] : [email])) as
      | { id: string; tenant_id: string; status: string }
      | undefined;

    // Akun nonaktif sengaja diperlakukan seperti akun yang tidak ada: memulihkan kata
    // sandinya tidak akan memberi akses apa pun, dan membedakan jawabannya hanya
    // memberitahu penebak bahwa alamat itu pernah terdaftar.
    if (!user || user.status !== 'active') {
      this.audit.record({
        tenantId: tenant?.id ?? user?.tenant_id ?? 'unknown',
        actorUserId: 'anonymous',
        actorLabel: email,
        actorIp: input.ip ?? null,
        action: 'auth.password_reset_requested',
        module: 'Perangkat & Sesi',
        objectType: 'email',
        objectId: email,
        outcome: 'denied',
        detail: { reason: 'no_active_account' },
      });
      return { accepted: true };
    }

    // Permintaan lama untuk akun yang sama dimatikan. Tanpa ini, setiap permintaan baru
    // menambah satu token hidup, dan cukup satu yang bocor untuk merebut akun.
    this.db
      .prepare("UPDATE password_reset_requests SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL")
      .run(at, user.id);

    const token = randomBytes(32).toString('base64url');
    this.db
      .prepare(
        `INSERT INTO password_reset_requests
           (id, tenant_id, user_id, email, token_hash, requested_at, expires_at, consumed_at, requested_ip)
         VALUES (?,?,?,?,?,?,?,NULL,?)`,
      )
      .run(
        newId('prq'),
        user.tenant_id,
        user.id,
        email,
        sha256(token),
        at,
        new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString(),
        input.ip ?? null,
      );

    this.outbox?.enqueue({
      tenantId: user.tenant_id,
      purpose: 'password_reset',
      channel: 'email',
      recipient: email,
      subject: '[Vantik] Pemulihan kata sandi',
      body:
        `Kode pemulihan kata sandi Anda: ${token}\n\n` +
        `Berlaku ${PASSWORD_RESET_TTL_MS / 60_000} menit dan hanya dapat dipakai sekali. ` +
        `Bila Anda tidak meminta ini, abaikan pesan ini — kata sandi Anda tidak berubah.`,
      sensitive: true,
    });

    this.audit.record({
      tenantId: user.tenant_id,
      actorUserId: 'anonymous',
      actorLabel: email,
      actorIp: input.ip ?? null,
      action: 'auth.password_reset_requested',
      module: 'Perangkat & Sesi',
      objectType: 'user',
      objectId: user.id,
      severity: 'notice',
    });

    return { accepted: true, tokenForDelivery: token };
  }

  /**
   * Menyelesaikan pemulihan dengan token.
   *
   * Sesi yang sedang berjalan DICABUT: pemulihan dipakai justru ketika pemilik akun
   * kehilangan kendali, jadi membiarkan sesi lama hidup akan menyisakan pintu bagi
   * siapa pun yang sudah masuk lebih dulu.
   */
  completePasswordReset(token: string, newPassword: string): { ok: boolean; reasonKey?: string } {
    const row = this.db
      .prepare(
        `SELECT id, tenant_id, user_id, expires_at, consumed_at
           FROM password_reset_requests WHERE token_hash = ?`,
      )
      .get(sha256(token)) as
      | { id: string; tenant_id: string; user_id: string; expires_at: string; consumed_at: string | null }
      | undefined;

    if (!row || row.consumed_at || Date.parse(row.expires_at) < Date.now()) {
      return { ok: false, reasonKey: 'error.reset_token_invalid' };
    }

    // Kebijakan panjang & penolakan pemakaian ulang ditegakkan `changePassword()` yang
    // sama dengan kedua jalur lain; pemulihan bukan pintu belakang untuk sandi lemah.
    // Bila ia melempar, token TIDAK ditandai terpakai supaya pengguna dapat mencoba lagi
    // dengan kata sandi yang memenuhi syarat.
    this.changePassword(row.user_id, newPassword);

    const at = nowIso();
    this.db.prepare('UPDATE password_reset_requests SET consumed_at = ? WHERE id = ?').run(at, row.id);
    const revoked = this.revokeSessionsForUser(row.tenant_id, row.user_id, 'password_reset');

    this.audit.record({
      tenantId: row.tenant_id,
      actorUserId: row.user_id,
      actorLabel: 'pemulihan kata sandi',
      actorIp: null,
      action: 'auth.password_reset_completed',
      module: 'Perangkat & Sesi',
      objectType: 'user',
      objectId: row.user_id,
      severity: 'critical',
      detail: { sessionsRevoked: revoked },
    });

    return { ok: true };
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
