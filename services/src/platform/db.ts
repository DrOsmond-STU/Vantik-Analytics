/**
 * Koneksi & migrasi basis data.
 *
 * Tiga penyimpanan terpisah secara fisik (ARCHITECTURE.md Bagian 11, SECURITY.md 6 & 9):
 *   - `main`     — basis data operasional
 *   - `auditdb`  — Log Aktivitas append-only, tidak boleh berbagi berkas dengan operasional
 *   - `vault`    — kredensial Koneksi Eksternal terenkripsi
 *
 * Ketiganya di-ATTACH ke satu koneksi agar dapat dibaca dalam satu kueri bila perlu,
 * namun tetap berkas terpisah sehingga backup/izin berkas dapat diatur berbeda.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AUDIT_MIGRATIONS, MIGRATIONS, VAULT_MIGRATIONS, type Migration } from './schema.ts';

export type Db = Database.Database;

export interface DbPaths {
  main: string;
  audit: string;
  vault: string;
}

export function resolveDbPaths(env: NodeJS.ProcessEnv = process.env): DbPaths {
  const dir = env.VANTIK_DATA_DIR ?? join(process.cwd(), '.data');
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
  /** ':memory:' untuk pengujian — ketiga penyimpanan memakai berkas sementara terpisah. */
  paths?: DbPaths;
  readonly?: boolean;
}

export function openDatabase(options: OpenDbOptions = {}): Db {
  const paths = options.paths ?? resolveDbPaths();

  for (const p of [paths.main, paths.audit, paths.vault]) {
    if (p !== ':memory:') mkdirSync(dirname(p), { recursive: true });
  }

  const db = new Database(paths.main);
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

/** ID stabil & dapat dibaca manusia untuk objek domain. */
export function newId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  const stamp = Date.now().toString(36);
  return `${prefix}_${stamp}${random}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
