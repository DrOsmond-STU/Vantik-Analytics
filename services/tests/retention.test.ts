/**
 * Pemangkasan tabel yang terus tumbuh.
 *
 * Empat hal yang paling penting dibuktikan di sini, dan semuanya adalah hal yang
 * "berfungsi" tanpa melemparkan kesalahan apa pun bila salah:
 *
 *  1. **Sesi yang masih hidup tidak pernah dihapus** (TC-RET-04). Mencabut sesi orang
 *     demi ruang disk adalah kerusakan, bukan perawatan.
 *  2. **Pesan `queued`/`failed` tidak pernah dibuang** (TC-RET-08). Selama transport
 *     nyata belum dipasang, antrean itu satu-satunya tempat kode pemulihan dan OTP dapat
 *     dibaca operator — membuangnya berarti menghapus satu-satunya salinannya.
 *  3. **Baris ber-tenant NULL ikut terpangkas** (TC-RET-02). Inilah alasan pekerjaan ini
 *     global, bukan per tenant.
 *  4. **Tabel append-only TIDAK disentuh dan dilaporkan apa adanya** (TC-RET-11 & 12).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, provisionTenant, type Harness, type TenantFixture } from './helpers.ts';
import {
  DEFAULT_RETENTION,
  pruneExpiredRows,
  resolveRetention,
  retentionReport,
} from '../src/platform/retention.ts';

let harness: Harness;
let tenant: TenantFixture;

beforeEach(() => {
  harness = createHarness();
  tenant = provisionTenant(harness);
});

afterEach(() => harness.cleanup());

function hariLalu(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}
function hariDepan(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}
function jumlah(table: string): number {
  return (harness.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/* ================= Konfigurasi jendela ================= */

describe('Jendela retensi', () => {
  it('TC-RET-01 — variabel lingkungan menimpa bawaan; nilai tak masuk akal DIABAIKAN', () => {
    expect(resolveRetention({}).loginAttempts).toBe(DEFAULT_RETENTION.loginAttempts);
    expect(resolveRetention({ VANTIK_RETAIN_LOGIN_ATTEMPTS_DAYS: '30' }).loginAttempts).toBe(30);

    // Salah ketik tidak boleh berarti "pangkas sesudah NaN hari" — pada perbandingan
    // tanggal itu akan menghapus segalanya atau tidak sama sekali, tanpa ada yang tahu
    // mana yang terjadi.
    for (const buruk of ['', '   ', 'tiga puluh', 'abc', 'NaN', 'Infinity']) {
      expect(resolveRetention({ VANTIK_RETAIN_LOGIN_ATTEMPTS_DAYS: buruk }).loginAttempts).toBe(
        DEFAULT_RETENTION.loginAttempts,
      );
    }
    // Nol mematikan pemangkasan tabel itu — itu pilihan yang sah, bukan salah ketik.
    expect(resolveRetention({ VANTIK_RETAIN_LOGIN_ATTEMPTS_DAYS: '0' }).loginAttempts).toBe(0);
  });
});

/* ================= Percobaan login ================= */

describe('Percobaan login', () => {
  function catatPercobaan(email: string, umurHari: number, tenantId: string | null): void {
    harness.db
      .prepare(
        `INSERT INTO login_attempts (id, tenant_id, email, attempted_at, ip, outcome, geo_lat, geo_lon)
         VALUES (?,?,?,?,'203.0.113.10','bad_credentials',NULL,NULL)`,
      )
      .run(`att_${email}_${umurHari}`, tenantId, email, hariLalu(umurHari));
  }

  it('TC-RET-02 — baris TANPA tenant ikut terpangkas', () => {
    // Percobaan untuk alamat yang tidak terdaftar sengaja bertenant NULL, supaya tidak
    // membocorkan tenant mana yang memiliki alamat itu. Pemangkasan per-tenant akan
    // meninggalkannya tumbuh selamanya — inilah alasan pekerjaan ini global.
    catatPercobaan('orang.asing@luar.test', 200, null);
    catatPercobaan('admin@dalam.test', 200, tenant.tenantId);
    catatPercobaan('baru@dalam.test', 1, tenant.tenantId);
    expect(jumlah('login_attempts')).toBe(3);

    const hasil = pruneExpiredRows(harness.db);

    expect(hasil.deleted.login_attempts).toBe(2);
    expect(jumlah('login_attempts')).toBe(1);
  });

  it('TC-RET-03 — batas jendela dihormati, bukan dibulatkan', () => {
    catatPercobaan('tepat.sebelum@x.test', DEFAULT_RETENTION.loginAttempts + 1, tenant.tenantId);
    catatPercobaan('tepat.sesudah@x.test', DEFAULT_RETENTION.loginAttempts - 1, tenant.tenantId);

    pruneExpiredRows(harness.db);

    const sisa = harness.db.prepare('SELECT email FROM login_attempts').all() as Array<{ email: string }>;
    expect(sisa.map((r) => r.email)).toEqual(['tepat.sesudah@x.test']);
  });
});

/* ================= Sesi ================= */

describe('Sesi', () => {
  function catatSesi(
    id: string,
    opts: { issued: number; expires: number; revoked?: number },
  ): void {
    harness.db
      .prepare(
        `INSERT INTO active_sessions (id, tenant_id, user_id, token_hash, device_id, issued_at,
                                      expires_at, last_seen_at, ip, reauth_at, revoked_at, revoked_reason)
         VALUES (?,?,?,?,NULL,?,?,?,'203.0.113.10',NULL,?,NULL)`,
      )
      .run(
        id,
        tenant.tenantId,
        tenant.adminUserId,
        `hash-${id}`,
        hariLalu(opts.issued),
        opts.expires < 0 ? hariDepan(-opts.expires) : hariLalu(opts.expires),
        hariLalu(opts.issued),
        opts.revoked === undefined ? null : hariLalu(opts.revoked),
      );
  }

  it('TC-RET-04 — sesi yang masih HIDUP tidak pernah dihapus, betapa pun tuanya', () => {
    // Sesi terbit setahun lalu tetapi masa berlakunya masih di masa depan (mis. token
    // berumur panjang). Menghapusnya berarti mengeluarkan orang dari aplikasi demi ruang
    // disk — kerusakan, bukan perawatan.
    catatSesi('ses_hidup_tua', { issued: 365, expires: -30 });
    catatSesi('ses_mati_tua', { issued: 365, expires: 360 });

    pruneExpiredRows(harness.db);

    const sisa = harness.db.prepare('SELECT id FROM active_sessions').all() as Array<{ id: string }>;
    expect(sisa.map((r) => r.id)).toEqual(['ses_hidup_tua']);
  });

  it('TC-RET-05 — sesi yang dicabut baru saja tetap disimpan sebagai jejak', () => {
    catatSesi('ses_dicabut_baru', { issued: 40, expires: 35, revoked: 2 });
    catatSesi('ses_dicabut_lama', { issued: 400, expires: 395, revoked: 90 });

    pruneExpiredRows(harness.db);

    const sisa = harness.db.prepare('SELECT id FROM active_sessions').all() as Array<{ id: string }>;
    expect(sisa.map((r) => r.id)).toEqual(['ses_dicabut_baru']);
  });
});

/* ================= Tantangan MFA & reset sandi ================= */

describe('Tantangan berumur pendek', () => {
  it('TC-RET-06 — tantangan MFA kedaluwarsa dibuang, yang masih berlaku tidak', () => {
    const masuk = (id: string, expires: number, consumed: number | null): void => {
      harness.db
        .prepare(
          `INSERT INTO mfa_challenges (id, tenant_id, user_id, token_hash, device_id, fingerprint_hash,
                                       ip, geo_json, attempts, issued_at, expires_at, consumed_at)
           VALUES (?,?,?,?,NULL,NULL,NULL,NULL,0,?,?,?)`,
        )
        .run(
          id,
          tenant.tenantId,
          tenant.adminUserId,
          `h-${id}`,
          hariLalu(100),
          expires < 0 ? hariDepan(-expires) : hariLalu(expires),
          consumed === null ? null : hariLalu(consumed),
        );
    };
    masuk('mfa_mati', 90, null);
    masuk('mfa_terpakai_lama', 90, 90);
    masuk('mfa_masih_berlaku', -1, null);

    pruneExpiredRows(harness.db);

    const sisa = harness.db.prepare('SELECT id FROM mfa_challenges').all() as Array<{ id: string }>;
    expect(sisa.map((r) => r.id)).toEqual(['mfa_masih_berlaku']);
  });

  it('TC-RET-07 — permintaan reset kata sandi lama dibuang', () => {
    const masuk = (id: string, expires: number): void => {
      harness.db
        .prepare(
          `INSERT INTO password_reset_requests (id, tenant_id, user_id, email, token_hash,
                                                requested_at, expires_at, consumed_at, requested_ip)
           VALUES (?,?,?,?,?,?,?,NULL,NULL)`,
        )
        .run(
          id,
          tenant.tenantId,
          tenant.adminUserId,
          'admin@x.test',
          `h-${id}`,
          hariLalu(expires + 1),
          expires < 0 ? hariDepan(-expires) : hariLalu(expires),
        );
    };
    masuk('rst_lama', 60);
    masuk('rst_baru', -1);

    pruneExpiredRows(harness.db);

    const sisa = harness.db.prepare('SELECT id FROM password_reset_requests').all() as Array<{ id: string }>;
    expect(sisa.map((r) => r.id)).toEqual(['rst_baru']);
  });
});

/* ================= Antrean notifikasi ================= */

describe('Antrean notifikasi', () => {
  it('TC-RET-08 — pesan `queued` dan `failed` TIDAK PERNAH dibuang, seberapa pun lama', () => {
    const masuk = (id: string, status: string, umur: number): void => {
      harness.db
        .prepare(
          `INSERT INTO notification_outbox
             (id, tenant_id, purpose, channel, recipient, subject, body, status, attempts,
              failure_reason, sensitive, created_at, sent_at)
           VALUES (?,?,'uji','email','a@b.test','s','b',?,0,NULL,0,?,NULL)`,
        )
        .run(id, tenant.tenantId, status, hariLalu(umur));
    };
    masuk('out_queued_purba', 'queued', 900);
    masuk('out_failed_purba', 'failed', 900);
    masuk('out_sent_lama', 'sent', 900);
    masuk('out_sent_baru', 'sent', 2);

    pruneExpiredRows(harness.db);

    // Selama transport nyata belum dipasang, `queued` adalah satu-satunya tempat kode
    // pemulihan dan OTP dapat dibaca operator. Membuangnya menghapus satu-satunya
    // salinannya, dan pengguna kehilangan jalan masuk tanpa ada yang tahu penyebabnya.
    const sisa = (harness.db.prepare('SELECT id FROM notification_outbox ORDER BY id').all() as Array<{ id: string }>)
      .map((r) => r.id);
    expect(sisa).toEqual(['out_failed_purba', 'out_queued_purba', 'out_sent_baru']);
  });
});

/* ================= Cache & jejak operasional ================= */

describe('Cache dan jejak', () => {
  it('TC-RET-09 — cache hasil analisis lama dibuang; membuangnya hanya berarti hitung ulang', () => {
    const masuk = (id: string, umur: number): void => {
      harness.db
        .prepare(
          `INSERT INTO stat_analyses (id, tenant_id, dataset_id, kind, spec_json, spec_hash,
                                      result_json, created_at, created_by, rls_scope_json)
           VALUES (?,?, 'ds-uji', 'descriptive','{}',?,'{}',?,?,'[]')`,
        )
        .run(id, tenant.tenantId, `hash-${id}`, hariLalu(umur), tenant.adminUserId);
    };
    masuk('an_lama', 60);
    masuk('an_baru', 1);

    pruneExpiredRows(harness.db);

    const sisa = harness.db.prepare('SELECT id FROM stat_analyses').all() as Array<{ id: string }>;
    expect(sisa.map((r) => r.id)).toEqual(['an_baru']);
  });

  it('TC-RET-10 — pembacaan sensor lama dibuang sesuai jendela yang dikonfigurasi', () => {
    const masuk = (umur: number): void => {
      harness.db
        .prepare(
          `INSERT INTO sensor_readings (tenant_id, asset_id, sensor_code, observed_at, value)
           VALUES (?, 'aset-1', 'suhu', ?, 30.0)`,
        )
        .run(tenant.tenantId, hariLalu(umur));
    };
    masuk(200);
    masuk(100);
    masuk(5);

    // Jendela dipersempit lewat konfigurasi, bukan lewat perubahan kode.
    const hasil = pruneExpiredRows(harness.db, {
      windows: { ...DEFAULT_RETENTION, sensorReadings: 30 },
    });

    expect(hasil.deleted.sensor_readings).toBe(2);
    expect(jumlah('sensor_readings')).toBe(1);
  });
});

/* ================= Tabel append-only ================= */

describe('Tabel yang TIDAK dapat dipangkas', () => {
  it('TC-RET-11 — pemangkasan tidak menyentuh audit_log maupun usage_events', () => {
    harness.audit.record({
      tenantId: tenant.tenantId,
      actorLabel: 'uji',
      action: 'uji.peristiwa',
      module: 'Log Aktivitas',
      objectType: 'uji',
    });
    harness.db
      .prepare(
        `INSERT INTO usage_events (id, tenant_id, metric, quantity, occurred_at, source, meta_json)
         VALUES ('ue_purba', ?, 'ai_calls', 1, ?, 'uji', NULL)`,
      )
      .run(tenant.tenantId, hariLalu(900));

    const sebelumAudit = jumlah('auditdb.audit_log');
    const sebelumUsage = jumlah('usage_events');

    const hasil = pruneExpiredRows(harness.db);

    expect(jumlah('auditdb.audit_log')).toBe(sebelumAudit);
    expect(jumlah('usage_events')).toBe(sebelumUsage);
    // Tidak boleh muncul di daftar `deleted` — kalau muncul, berarti ada yang menambahkan
    // DELETE terhadap tabel yang trigger-nya seharusnya menolak.
    expect(hasil.deleted).not.toHaveProperty('audit_log');
    expect(hasil.deleted).not.toHaveProperty('usage_events');
  });

  it('TC-RET-12 — keduanya DILAPORKAN sebagai dilewati, bukan dihilangkan dari laporan', () => {
    const hasil = pruneExpiredRows(harness.db);

    // "Tidak dipangkas" yang senyap membuat operator menyimpulkan seluruh tabel menyusut.
    expect(hasil.skipped['audit_log']).toMatch(/append-only/);
    expect(hasil.skipped['usage_events']).toMatch(/append-only/);
  });

  it('TC-RET-13 — trigger memang menolak DELETE, jadi pemangkasan mustahil bukan sekadar dilewati', () => {
    harness.audit.record({
      tenantId: tenant.tenantId,
      actorLabel: 'uji',
      action: 'uji.kekal',
      module: 'Log Aktivitas',
      objectType: 'uji',
    });

    // Trigger `BEFORE DELETE` menyala PER BARIS, jadi tabel kosong tidak akan menolak
    // apa pun — barisnya harus benar-benar ada supaya penolakannya teruji.
    harness.db
      .prepare(
        `INSERT INTO usage_events (id, tenant_id, metric, quantity, occurred_at, source, meta_json)
         VALUES ('ue_kekal', ?, 'ai_calls', 1, ?, 'uji', NULL)`,
      )
      .run(tenant.tenantId, hariLalu(900));

    // Ini membuktikan alasan pengecualiannya nyata. Bila suatu saat trigger dilepas,
    // uji INI yang gagal — bukan alasan di komentar yang diam-diam menjadi salah.
    expect(() => harness.db.prepare('DELETE FROM auditdb.audit_log').run()).toThrowError(/immutable/i);
    expect(() => harness.db.prepare('DELETE FROM usage_events').run()).toThrowError(/append-only/i);
  });

  it('TC-RET-14 — laporan retensi menyebut jumlah baris dan yang tertua', () => {
    harness.audit.record({
      tenantId: tenant.tenantId,
      actorLabel: 'uji',
      action: 'uji.laporan',
      module: 'Log Aktivitas',
      objectType: 'uji',
    });

    const laporan = retentionReport(harness.db);

    const audit = laporan.appendOnly.find((r) => r.table === 'audit_log')!;
    expect(audit.rows).toBeGreaterThan(0);
    expect(audit.oldest).toBeTruthy();
    expect(audit.note).toMatch(/ROTASI BERKAS/);

    // Jendela yang berlaku ikut dilaporkan, supaya operator tahu angka apa yang dipakai
    // tanpa harus membaca kode atau menebak dari `.env`.
    expect(laporan.windows.loginAttempts).toBe(DEFAULT_RETENTION.loginAttempts);
    expect(laporan.prunable.find((r) => r.table === 'sensor_readings')?.retainDays).toBe(
      DEFAULT_RETENTION.sensorReadings,
    );
  });
});

/* ================= Sifat aman dijalankan berulang ================= */

describe('Sifat pekerjaan', () => {
  it('TC-RET-15 — aman dijalankan berulang: putaran kedua tidak menghapus apa pun lagi', () => {
    harness.db
      .prepare(
        `INSERT INTO login_attempts (id, tenant_id, email, attempted_at, ip, outcome, geo_lat, geo_lon)
         VALUES ('att_x', NULL, 'a@b.test', ?, NULL, 'bad_credentials', NULL, NULL)`,
      )
      .run(hariLalu(200));

    expect(pruneExpiredRows(harness.db).total).toBe(1);
    expect(pruneExpiredRows(harness.db).total).toBe(0);
  });

  it('TC-RET-16 — jendela nol mematikan pemangkasan tabel itu dan menyatakannya', () => {
    harness.db
      .prepare(
        `INSERT INTO login_attempts (id, tenant_id, email, attempted_at, ip, outcome, geo_lat, geo_lon)
         VALUES ('att_y', NULL, 'a@b.test', ?, NULL, 'bad_credentials', NULL, NULL)`,
      )
      .run(hariLalu(900));

    const hasil = pruneExpiredRows(harness.db, { windows: { ...DEFAULT_RETENTION, loginAttempts: 0 } });

    expect(jumlah('login_attempts')).toBe(1);
    expect(hasil.deleted).not.toHaveProperty('login_attempts');
    expect(hasil.skipped['login_attempts']).toMatch(/dimatikan/);
  });
});
