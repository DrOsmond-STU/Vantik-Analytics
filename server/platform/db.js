"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveDataDir = resolveDataDir;
exports.resolveDbPaths = resolveDbPaths;
exports.openDatabase = openDatabase;
exports.newId = newId;
exports.nowIso = nowIso;
exports.addMonths = addMonths;
/**
 * Koneksi & migrasi basis data.
 *
 * Tiga penyimpanan terpisah secara fisik (ARCHITECTURE.md Bagian 11, SECURITY.md 6 & 9):
 *   - `main`     — basis data operasional
 *   - `auditdb`  — Log Aktivitas append-only, tidak boleh berbagi berkas dengan operasional
 *   - `vault`    — kredensial Koneksi Eksternal terenkripsi
 *
 * Ketiganya di-ATTACH ke satu koneksi agar dapat dibaca dalam satu kueri bila perlu,
 * namun tetap berkas terpisah sehingga backup dan izin berkas dapat diatur berbeda.
 *
 * Driver SQLite dipilih saat runtime (lihat `sqlite.ts`) — penting agar aplikasi tetap
 * dapat dipasang di shared hosting yang tidak dapat mengompilasi modul native.
 */
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const schema_ts_1 = require("./schema.js");
const sqlite_ts_1 = require("./sqlite.js");
/**
 * Direktori data.
 *
 * Pada shared hosting, berkas basis data WAJIB berada di luar document root —
 * berkas `.db` yang dapat diunduh lewat HTTP berarti seluruh isi basis data bocor,
 * termasuk Log Aktivitas dan hash kata sandi. Default `../vantik-data` relatif
 * terhadap direktori aplikasi memenuhi itu untuk tata letak cPanel yang lazim.
 */
function resolveDataDir(env = process.env) {
    const configured = env.VANTIK_DATA_DIR;
    if (configured && configured.trim() !== '') {
        return (0, node_path_1.isAbsolute)(configured) ? configured : (0, node_path_1.resolve)(process.cwd(), configured);
    }
    return (0, node_path_1.resolve)(process.cwd(), '.data');
}
function resolveDbPaths(env = process.env) {
    const dir = resolveDataDir(env);
    return {
        main: (0, node_path_1.join)(dir, 'vantik.db'),
        audit: (0, node_path_1.join)(dir, 'vantik-audit.db'),
        vault: (0, node_path_1.join)(dir, 'vantik-vault.db'),
    };
}
function runMigrations(db, migrations, ledger) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${ledger} (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);
    const applied = new Set(db.prepare(`SELECT id FROM ${ledger}`).all().map((r) => r.id));
    const record = db.prepare(`INSERT INTO ${ledger} (id, applied_at) VALUES (?, ?)`);
    for (const migration of migrations) {
        if (applied.has(migration.id))
            continue;
        db.transaction(() => {
            db.exec(migration.sql);
            record.run(migration.id, new Date().toISOString());
        })();
    }
}
function openDatabase(options = {}) {
    const paths = options.paths ?? resolveDbPaths();
    for (const p of [paths.main, paths.audit, paths.vault]) {
        if (p !== ':memory:')
            (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(p), { recursive: true });
    }
    const db = (0, sqlite_ts_1.openSqlite)(paths.main, options.driver);
    // WAL memberi pembacaan bersamaan tanpa memblokir penulisan — relevan di shared
    // hosting di mana beberapa proses Passenger dapat berbagi berkas yang sama.
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.prepare('ATTACH DATABASE ? AS auditdb').run(paths.audit);
    db.prepare('ATTACH DATABASE ? AS vault').run(paths.vault);
    runMigrations(db, schema_ts_1.MIGRATIONS, 'schema_migrations');
    runMigrations(db, schema_ts_1.AUDIT_MIGRATIONS, 'auditdb.schema_migrations');
    runMigrations(db, schema_ts_1.VAULT_MIGRATIONS, 'vault.schema_migrations');
    return db;
}
/**
 * ID stabil & dapat dibaca manusia untuk objek domain.
 *
 * Bagian acaknya berasal dari `randomBytes`, BUKAN `Math.random()`. ID ini melekat
 * pada objek yang berkonsekuensi — sesi, penugasan peran, permintaan pemindahan
 * perangkat — dan `Math.random()` dapat diprediksi: keadaan internal V8 dapat
 * direkonstruksi dari beberapa keluaran. Awalan waktu tetap dipertahankan supaya ID
 * masih terurut kronologis dan mudah dibaca manusia saat menelusuri Log Aktivitas.
 */
function newId(prefix) {
    const random = (0, node_crypto_1.randomBytes)(6).toString('base64url');
    const stamp = Date.now().toString(36);
    return `${prefix}_${stamp}${random}`;
}
function nowIso() {
    return new Date().toISOString();
}
/**
 * Menambah sejumlah bulan kalender pada sebuah waktu ISO.
 *
 * Tidak memakai `hari × 30` karena siklus langganan dijual dalam BULAN, bukan dalam
 * 30 hari: pelanggan yang berlangganan 31 Januari untuk satu bulan harus jatuh tempo
 * 28 Februari, bukan 2 Maret. `Date.setUTCMonth` sendiri melimpah pada kasus itu
 * (31 Januari + 1 bulan menjadi 3 Maret pada tahun biasa), jadi tanggalnya dijepit ke
 * hari terakhir bulan tujuan — itulah satu-satunya alasan fungsi ini ada alih-alih
 * memanggil `setUTCMonth` langsung di tempat pemakaian.
 */
function addMonths(fromIso, months) {
    const from = new Date(fromIso);
    const day = from.getUTCDate();
    const target = new Date(from.getTime());
    target.setUTCDate(1);
    target.setUTCMonth(target.getUTCMonth() + months);
    const lastDayOfTargetMonth = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(day, lastDayOfTargetMonth));
    return target.toISOString();
}
//# sourceMappingURL=db.js.map