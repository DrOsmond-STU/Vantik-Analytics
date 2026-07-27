/**
 * Adapter driver SQLite.
 *
 * Alasan keberadaan berkas ini: `better-sqlite3` adalah modul NATIVE yang menuntut
 * kompilasi (node-gyp) atau ketersediaan prebuilt binary. Pada **shared hosting**
 * keduanya sering tidak tersedia — tidak ada build tool, dan versi ABI Node bisa tidak
 * cocok dengan prebuild yang ada. Kegagalan itu terjadi saat `npm install`, sebelum
 * satu baris kode aplikasi berjalan.
 *
 * Karena itu driver dipilih saat runtime:
 *   1. `better-sqlite3` bila dapat dimuat — paling cepat dan paling matang;
 *   2. `node:sqlite` bila tidak — bawaan Node ≥ 22.5, TANPA kompilasi apa pun.
 *
 * Aplikasi hanya memakai lima kemampuan (`prepare`, `exec`, `pragma`, `transaction`,
 * `close`), sehingga permukaan yang harus disamakan sempit dan dapat diuji penuh.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';

export type SqlParam = string | number | bigint | Buffer | Uint8Array | null;
export type SqlRow = Record<string, unknown>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/**
 * Bentuk kembalian sengaja `unknown` — sama seperti `better-sqlite3`. Pemanggil
 * menyatakan bentuk barisnya sendiri lewat `as`, sehingga tipe baris tetap dekat
 * dengan kueri yang menghasilkannya alih-alih dipaksa ke satu tipe generik.
 */
export interface SqliteStatement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  /** Menjalankan PRAGMA dan mengembalikan baris hasilnya (kosong untuk penetapan nilai). */
  pragma(statement: string): unknown[];
  /**
   * Membungkus `fn` dalam transaksi. Mengembalikan FUNGSI yang harus dipanggil —
   * mengikuti bentuk `better-sqlite3` agar seluruh pemanggil tetap sama.
   */
  transaction<T>(fn: () => T): () => T;
  close(): void;
  /** Nama driver yang benar-benar dipakai — ditampilkan di log startup & /healthz. */
  readonly driver: 'better-sqlite3' | 'node:sqlite';
}

/* ------------------------------------------------------------------ */
/* Pembungkus node:sqlite                                             */
/* ------------------------------------------------------------------ */

interface NodeSqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): SqlRow | undefined;
  all(...params: unknown[]): SqlRow[];
}

interface NodeSqliteDatabase {
  prepare(sql: string): NodeSqliteStatement;
  exec(sql: string): void;
  close(): void;
}

/**
 * `node:sqlite` tidak menyediakan pembantu transaksi seperti better-sqlite3, jadi
 * dibuat di sini. Kedalaman dilacak dan tingkat bersarang memakai SAVEPOINT — sama
 * seperti perilaku better-sqlite3 — supaya transaksi bersarang tidak diam-diam
 * meng-commit lebih awal.
 */
class NodeSqliteAdapter implements SqliteDatabase {
  readonly driver = 'node:sqlite' as const;
  private depth = 0;

  constructor(private readonly db: NodeSqliteDatabase) {}

  prepare(sql: string): SqliteStatement {
    const statement = this.db.prepare(sql);
    return {
      run: (...params: unknown[]): RunResult => {
        const result = statement.run(...normalise(params));
        return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
      },
      get: (...params: unknown[]): unknown => statement.get(...normalise(params)),
      all: (...params: unknown[]): unknown[] => statement.all(...normalise(params)),
    };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(statement: string): unknown[] {
    // Penetapan nilai (mis. `foreign_keys = ON`) tidak mengembalikan baris; pembacaan
    // (mis. `database_list`) mengembalikan baris. `all()` menangani keduanya.
    return this.db.prepare(`PRAGMA ${statement}`).all();
  }

  transaction<T>(fn: () => T): () => T {
    return (): T => {
      const nested = this.depth > 0;
      const savepoint = `vantik_sp_${this.depth}`;
      this.db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN');
      this.depth++;
      try {
        const result = fn();
        this.depth--;
        this.db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
        return result;
      } catch (error) {
        this.depth--;
        // Rollback tidak boleh menutupi kesalahan aslinya — itulah yang perlu dilihat
        // pengembang, bukan kegagalan pembersihan yang menyusul.
        try {
          this.db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
        } catch {
          /* diabaikan dengan sengaja */
        }
        throw error;
      }
    };
  }

  close(): void {
    this.db.close();
  }
}

/**
 * `node:sqlite` menolak `undefined` sebagai nilai bind, sedangkan better-sqlite3
 * memperlakukannya seperti NULL pada beberapa jalur. Disamakan di sini agar perilaku
 * aplikasi tidak bergantung pada driver yang terpilih.
 */
function normalise(params: unknown[]): unknown[] {
  return params.map((param) => {
    if (param === undefined) return null;
    if (typeof param === 'boolean') return param ? 1 : 0;
    if (param !== null && typeof param === 'object' && !Buffer.isBuffer(param) && !(param instanceof Uint8Array)) {
      // Objek parameter bernama: normalisasi nilainya juga.
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(param as Record<string, unknown>)) {
        out[key] = value === undefined ? null : typeof value === 'boolean' ? (value ? 1 : 0) : value;
      }
      return out;
    }
    return param;
  });
}

/* ------------------------------------------------------------------ */
/* Pembungkus better-sqlite3                                          */
/* ------------------------------------------------------------------ */

interface BetterSqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(statement: string): unknown;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

class BetterSqliteAdapter implements SqliteDatabase {
  readonly driver = 'better-sqlite3' as const;

  constructor(private readonly db: BetterSqliteDatabase) {}

  prepare(sql: string): SqliteStatement {
    return this.db.prepare(sql);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(statement: string): unknown[] {
    const result = this.db.pragma(statement);
    return Array.isArray(result) ? (result as unknown[]) : [];
  }

  transaction<T>(fn: () => T): () => T {
    return this.db.transaction(fn);
  }

  close(): void {
    this.db.close();
  }
}

/* ------------------------------------------------------------------ */
/* Pemilihan driver                                                   */
/* ------------------------------------------------------------------ */

export type DriverPreference = 'auto' | 'better-sqlite3' | 'node:sqlite';

export function driverPreference(env: NodeJS.ProcessEnv = process.env): DriverPreference {
  const requested = env.VANTIK_SQLITE_DRIVER;
  if (requested === 'better-sqlite3' || requested === 'node:sqlite') return requested;
  return 'auto';
}

/**
 * Membuka basis data dengan driver terbaik yang tersedia.
 *
 * `VANTIK_SQLITE_DRIVER` dapat memaksa salah satu driver — dipakai pengujian untuk
 * memverifikasi KEDUA jalur, sehingga fallback tidak menjadi kode yang tak pernah
 * teruji sampai terpakai di production.
 */
export function openSqlite(filename: string, preference: DriverPreference = driverPreference()): SqliteDatabase {
  const errors: string[] = [];

  if (preference === 'auto' || preference === 'better-sqlite3') {
    try {
      const create = loadBetterSqlite();
      return new BetterSqliteAdapter(create(filename));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`better-sqlite3: ${message}`);
      if (preference === 'better-sqlite3') {
        throw new Error(`Driver better-sqlite3 diminta tetapi tidak dapat dimuat — ${message}`);
      }
    }
  }

  if (preference === 'auto' || preference === 'node:sqlite') {
    try {
      const { DatabaseSync } = loadNodeSqlite();
      return new NodeSqliteAdapter(new DatabaseSync(filename) as unknown as NodeSqliteDatabase);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`node:sqlite: ${message}`);
    }
  }

  throw new Error(
    'Tidak ada driver SQLite yang dapat dipakai. Pasang better-sqlite3, atau jalankan ' +
      `Node ≥ 22.5 agar node:sqlite tersedia. Rincian: ${errors.join(' | ')}`,
  );
}

/** Dipisah agar dapat di-stub pada pengujian dan agar `require` tidak dievaluasi dini. */
function loadBetterSqlite(): (filename: string) => BetterSqliteDatabase {
  const required = req('better-sqlite3') as unknown;
  const ctor = (required as { default?: unknown }).default ?? required;
  return (filename: string) => new (ctor as new (f: string) => BetterSqliteDatabase)(filename);
}

function loadNodeSqlite(): { DatabaseSync: new (filename: string) => unknown } {
  return req('node:sqlite') as { DatabaseSync: new (filename: string) => unknown };
}

/**
 * Pemuat modul sinkron yang bekerja pada keluaran CommonJS (deployment) MAUPUN saat
 * berjalan sebagai ESM (pengembangan & pengujian).
 *
 * `createRequire` sengaja diberi lintasan berbasis `process.cwd()`, bukan
 * `import.meta.url`: `import.meta` tidak sah pada keluaran CommonJS, sehingga
 * memakainya akan membuat berkas ini gagal dikompilasi untuk deployment.
 */
let cachedRequire: NodeRequire | null = null;

function req(specifier: string): unknown {
  if (!cachedRequire) {
    cachedRequire = createRequire(join(process.cwd(), 'vantik-module-resolver.cjs'));
  }
  return cachedRequire(specifier);
}
