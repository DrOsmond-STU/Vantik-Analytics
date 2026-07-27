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
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { AUDIT_MIGRATIONS, MIGRATIONS, VAULT_MIGRATIONS, type Migration } from './schema.ts';
import { openSqlite, type DriverPreference, type SqliteDatabase } from './sqlite.ts';

export type Db = SqliteDatabase;

export interface DbPaths {
  main: string;
  audit: string;
  vault: string;
}

/**
 * Direktori data.
 *
 * Pada shared hosting, berkas basis data WAJIB berada di luar document root —
 * berkas `.db` yang dapat diunduh lewat HTTP berarti seluruh isi basis data bocor,
 * termasuk Log Aktivitas dan hash kata sandi. Default `../vantik-data` relatif
 * terhadap direktori aplikasi memenuhi itu untuk tata letak cPanel yang lazim.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.VANTIK_DATA_DIR;
  if (configured && configured.trim() !== '') {
    return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  }
  return resolve(process.cwd(), '.data');
}

export function resolveDbPaths(env: NodeJS.ProcessEnv = process.env): DbPaths {
  const dir = resolveDataDir(env);
  return {
    main: join(dir, 'vantik.db'),
    audit: join(dir, 'vantik-audit.db'),
    vault: join(dir, 'vantik-vault.db'),
  };
}

function runMigrations(db: Db, migrations: readonly Migration[], ledger: string): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${ledger} (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);
  const applied = new Set<string>(
    db.prepare(`SELECT id FROM ${ledger}`).all().map((r) => (r as { id: string }).id),
  );
  const record = db.prepare(`INSERT INTO ${ledger} (id, applied_at) VALUES (?, ?)`);
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.id, new Date().toISOString());
    })();
  }
}

export interface OpenDbOptions {
  paths?: DbPaths;
  /** Memaksa driver tertentu; dipakai pengujian untuk memverifikasi kedua jalur. */
  driver?: DriverPreference;
}

export function openDatabase(options: OpenDbOptions = {}): Db {
  const paths = options.paths ?? resolveDbPaths();

  for (const p of [paths.main, paths.audit, paths.vault]) {
    if (p !== ':memory:') mkdirSync(dirname(p), { recursive: true });
  }

  const db = openSqlite(paths.main, options.driver);

  // WAL memberi pembacaan bersamaan tanpa memblokir penulisan — relevan di shared
  // hosting di mana beberapa proses Passenger dapat berbagi berkas yang sama.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.prepare('ATTACH DATABASE ? AS auditdb').run(paths.audit);
  db.prepare('ATTACH DATABASE ? AS vault').run(paths.vault);

  runMigrations(db, MIGRATIONS, 'schema_migrations');
  runMigrations(db, AUDIT_MIGRATIONS, 'auditdb.schema_migrations');
  runMigrations(db, VAULT_MIGRATIONS, 'vault.schema_migrations');

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
export function newId(prefix: string): string {
  const random = randomBytes(6).toString('base64url');
  const stamp = Date.now().toString(36);
  return `${prefix}_${stamp}${random}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
