/**
 * Pemangkasan tabel yang terus tumbuh.
 *
 * Alasan keberadaannya: seluruh keadaan aplikasi ada di satu berkas SQLite di shared
 * hosting yang berkuota disk. Beberapa tabel bertambah pada setiap login, setiap
 * permintaan yang dibatasi laju, setiap pembacaan sensor — dan tidak ada satu pun yang
 * pernah menyusut. Instalasi yang berjalan setahun akan menemukan berkasnya membengkak
 * karena hal-hal yang sudah tidak berguna: percobaan login dua tahun lalu, tantangan MFA
 * yang kedaluwarsa dalam lima menit, penghitung batas laju berjendela satu menit.
 *
 * DUA TABEL SENGAJA TIDAK ADA DI SINI: `audit_log` dan `usage_events` bersifat
 * append-only lewat trigger `RAISE(ABORT)` (SECURITY.md Bagian 9 & 16.3), jadi pemangkasan
 * pada keduanya MUSTAHIL tanpa melepas trigger itu — dan melepasnya berarti menghapus
 * kontrol keamanan demi ruang disk. Lihat `retentionReport()` yang melaporkan
 * pertumbuhannya secara terbuka alih-alih menyelesaikannya diam-diam.
 *
 * Setiap jendela dapat diatur lewat variabel lingkungan supaya operator tidak perlu
 * mengubah kode: angka bawaan di sini adalah keputusan teknis (berapa lama sebuah baris
 * masih berguna), bukan keputusan bisnis.
 */
import type { Db } from './db.ts';

/** Jendela retensi dalam HARI. Nol atau negatif = jangan pangkas tabel itu. */
export interface RetentionWindows {
  /** Percobaan login — cukup lama untuk menyelidiki insiden (SECURITY.md Bagian 9). */
  loginAttempts: number;
  /** Sesi yang sudah kedaluwarsa atau dicabut. Sesi hidup TIDAK pernah disentuh. */
  deadSessions: number;
  /** Tantangan MFA yang sudah dipakai atau kedaluwarsa. */
  mfaChallenges: number;
  /** Permintaan reset kata sandi yang sudah dipakai atau kedaluwarsa. */
  passwordResets: number;
  /** Jejak permintaan dasbor tertanam. */
  embedRequests: number;
  /** Pembacaan sensor Digital Twin — pertumbuhan tercepat bila modul itu dipakai. */
  sensorReadings: number;
  /** Pesan outbox yang BERHASIL terkirim. `queued`/`failed` tidak pernah dibuang. */
  sentNotifications: number;
  /** Cache hasil analisis statistik. Ia cache: membuangnya hanya berarti hitung ulang. */
  analysisCache: number;
  /** Jejak eksekusi penjadwal. */
  schedulerRuns: number;
}

/**
 * Angka bawaan.
 *
 * Dipilih dari pertanyaan "sesudah berapa lama baris ini tidak lagi menjawab pertanyaan
 * siapa pun?", bukan dari selera. Penghitung batas laju dan entri idempotency tidak ada
 * di sini karena keduanya sudah dibersihkan sendiri oleh pemiliknya pada setiap
 * pemakaian — jendelanya menit, bukan hari.
 */
export const DEFAULT_RETENTION: RetentionWindows = {
  loginAttempts: 90,
  deadSessions: 30,
  mfaChallenges: 30,
  passwordResets: 30,
  embedRequests: 365,
  sensorReadings: 90,
  sentNotifications: 30,
  analysisCache: 30,
  schedulerRuns: 30,
};

/** Nama variabel lingkungan per jendela. */
const ENV_KEYS: Record<keyof RetentionWindows, string> = {
  loginAttempts: 'VANTIK_RETAIN_LOGIN_ATTEMPTS_DAYS',
  deadSessions: 'VANTIK_RETAIN_DEAD_SESSIONS_DAYS',
  mfaChallenges: 'VANTIK_RETAIN_MFA_CHALLENGES_DAYS',
  passwordResets: 'VANTIK_RETAIN_PASSWORD_RESETS_DAYS',
  embedRequests: 'VANTIK_RETAIN_EMBED_REQUESTS_DAYS',
  sensorReadings: 'VANTIK_RETAIN_SENSOR_READINGS_DAYS',
  sentNotifications: 'VANTIK_RETAIN_SENT_NOTIFICATIONS_DAYS',
  analysisCache: 'VANTIK_RETAIN_ANALYSIS_CACHE_DAYS',
  schedulerRuns: 'VANTIK_RETAIN_SCHEDULER_RUNS_DAYS',
};

/**
 * Jendela efektif: bawaan, ditimpa variabel lingkungan yang sah.
 *
 * Nilai yang tidak dapat dibaca sebagai angka DIABAIKAN dan bawaan tetap dipakai —
 * salah ketik di `.env` tidak boleh berarti "pangkas sesudah NaN hari", yang pada
 * perbandingan tanggal akan menghapus segalanya atau tidak menghapus apa pun tanpa
 * ada yang tahu mana yang terjadi.
 */
export function resolveRetention(env: NodeJS.ProcessEnv = process.env): RetentionWindows {
  const out = { ...DEFAULT_RETENTION };
  for (const key of Object.keys(ENV_KEYS) as Array<keyof RetentionWindows>) {
    const raw = env[ENV_KEYS[key]];
    if (raw === undefined || raw.trim() === '') continue;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) continue;
    out[key] = Math.trunc(parsed);
  }
  return out;
}

export interface PruneOutcome {
  /** Baris terhapus per tabel; tabel yang jendelanya dimatikan tidak muncul. */
  deleted: Record<string, number>;
  total: number;
  /** Tabel yang dilewati beserta alasannya — supaya "tidak dipangkas" tidak senyap. */
  skipped: Record<string, string>;
}

function cutoffIso(days: number, now: number): string {
  return new Date(now - days * 86_400_000).toISOString();
}

/**
 * Menjalankan pemangkasan. Mengembalikan jumlah baris terhapus per tabel.
 *
 * Bekerja pada Db mentah, BUKAN `TenantScopedDb`, dan itu disengaja: sebagian baris yang
 * harus dipangkas justru tidak punya tenant — `login_attempts` untuk alamat email yang
 * tidak terdaftar sengaja bertenant NULL (kalau tidak, ia akan memberi tahu tenant mana
 * yang punya alamat itu). Pemangkasan per-tenant akan meninggalkan baris-baris itu
 * tumbuh selamanya.
 */
export function pruneExpiredRows(db: Db, options: { windows?: RetentionWindows; now?: number } = {}): PruneOutcome {
  const w = options.windows ?? resolveRetention();
  const now = options.now ?? Date.now();
  const deleted: Record<string, number> = {};
  const skipped: Record<string, string> = {};

  const run = (table: string, days: number, sql: string, params: Record<string, string | number>): void => {
    if (days <= 0) {
      skipped[table] = 'retensi dimatikan (jendela ≤ 0)';
      return;
    }
    deleted[table] = db.prepare(sql).run(params).changes;
  };

  db.transaction(() => {
    run('login_attempts', w.loginAttempts, 'DELETE FROM login_attempts WHERE attempted_at < :cutoff', {
      cutoff: cutoffIso(w.loginAttempts, now),
    });

    // Hanya sesi yang sudah MATI. Sesi yang masih hidup tidak pernah disentuh, betapa pun
    // tuanya — mencabut sesi seseorang demi ruang disk adalah kerusakan, bukan perawatan.
    run(
      'active_sessions',
      w.deadSessions,
      `DELETE FROM active_sessions
        WHERE (revoked_at IS NOT NULL AND revoked_at < :cutoff)
           OR (revoked_at IS NULL AND expires_at < :cutoff)`,
      { cutoff: cutoffIso(w.deadSessions, now) },
    );

    run(
      'mfa_challenges',
      w.mfaChallenges,
      `DELETE FROM mfa_challenges
        WHERE (consumed_at IS NOT NULL AND consumed_at < :cutoff)
           OR (consumed_at IS NULL AND expires_at < :cutoff)`,
      { cutoff: cutoffIso(w.mfaChallenges, now) },
    );

    run(
      'password_reset_requests',
      w.passwordResets,
      `DELETE FROM password_reset_requests
        WHERE (consumed_at IS NOT NULL AND consumed_at < :cutoff)
           OR (consumed_at IS NULL AND expires_at < :cutoff)`,
      { cutoff: cutoffIso(w.passwordResets, now) },
    );

    run('embed_requests', w.embedRequests, 'DELETE FROM embed_requests WHERE requested_at < :cutoff', {
      cutoff: cutoffIso(w.embedRequests, now),
    });

    run('sensor_readings', w.sensorReadings, 'DELETE FROM sensor_readings WHERE observed_at < :cutoff', {
      cutoff: cutoffIso(w.sensorReadings, now),
    });

    // HANYA yang berstatus `sent`. Pesan `queued` dan `failed` adalah pekerjaan yang
    // belum selesai — selama transport nyata belum dipasang, justru itulah satu-satunya
    // tempat kode pemulihan dan OTP dapat dibaca operator.
    run(
      'notification_outbox',
      w.sentNotifications,
      "DELETE FROM notification_outbox WHERE status = 'sent' AND created_at < :cutoff",
      { cutoff: cutoffIso(w.sentNotifications, now) },
    );

    run('stat_analyses', w.analysisCache, 'DELETE FROM stat_analyses WHERE created_at < :cutoff', {
      cutoff: cutoffIso(w.analysisCache, now),
    });

    run('scheduler_runs', w.schedulerRuns, 'DELETE FROM scheduler_runs WHERE started_at < :cutoff', {
      cutoff: cutoffIso(w.schedulerRuns, now),
    });
  })();

  // Dua tabel append-only dinyatakan terbuka, bukan dihilangkan dari laporan. Operator
  // yang membaca hasil pemangkasan harus tahu bahwa keduanya TIDAK ikut menyusut.
  skipped['audit_log'] = 'append-only (SECURITY.md Bagian 9) — trigger menolak DELETE';
  skipped['usage_events'] = 'append-only (SECURITY.md 16.3) — trigger menolak DELETE';

  return { deleted, total: Object.values(deleted).reduce((a, b) => a + b, 0), skipped };
}

/**
 * Laporan pertumbuhan, termasuk tabel yang TIDAK dapat dipangkas.
 *
 * Ada supaya "tabel append-only tumbuh tanpa batas" menjadi angka yang dapat dibaca
 * operator dan direncanakan, bukan kalimat di dokumen yang baru terasa ketika kuota
 * disk hosting penuh.
 */
export function retentionReport(db: Db): {
  windows: RetentionWindows;
  prunable: Array<{ table: string; rows: number; retainDays: number }>;
  appendOnly: Array<{ table: string; rows: number; oldest: string | null; note: string }>;
} {
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const oldest = (table: string, column: string): string | null =>
    (db.prepare(`SELECT MIN(${column}) AS m FROM ${table}`).get() as { m: string | null }).m;

  const windows = resolveRetention();
  return {
    windows,
    prunable: [
      { table: 'login_attempts', rows: count('login_attempts'), retainDays: windows.loginAttempts },
      { table: 'active_sessions', rows: count('active_sessions'), retainDays: windows.deadSessions },
      { table: 'mfa_challenges', rows: count('mfa_challenges'), retainDays: windows.mfaChallenges },
      { table: 'password_reset_requests', rows: count('password_reset_requests'), retainDays: windows.passwordResets },
      { table: 'embed_requests', rows: count('embed_requests'), retainDays: windows.embedRequests },
      { table: 'sensor_readings', rows: count('sensor_readings'), retainDays: windows.sensorReadings },
      { table: 'notification_outbox', rows: count('notification_outbox'), retainDays: windows.sentNotifications },
      { table: 'stat_analyses', rows: count('stat_analyses'), retainDays: windows.analysisCache },
      { table: 'scheduler_runs', rows: count('scheduler_runs'), retainDays: windows.schedulerRuns },
    ],
    appendOnly: [
      {
        table: 'audit_log',
        rows: count('auditdb.audit_log'),
        oldest: oldest('auditdb.audit_log', 'occurred_at'),
        note:
          'Kekal karena trigger (SECURITY.md Bagian 9). Tidak dapat dipangkas tanpa melepas ' +
          'kontrol itu. Bila ukurannya menjadi masalah, jalan yang benar adalah ROTASI BERKAS ' +
          'basis data audit per periode — bukan menghapus baris.',
      },
      {
        table: 'usage_events',
        rows: count('usage_events'),
        oldest: oldest('usage_events', 'occurred_at'),
        note:
          'Append-only karena menjadi bukti perhitungan tagihan (SECURITY.md 16.3). ' +
          'Tumbuh mengikuti pemakaian yang dimeter, bukan mengikuti waktu.',
      },
    ],
  };
}
