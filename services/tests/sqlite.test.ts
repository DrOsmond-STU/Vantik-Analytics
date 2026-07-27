/**
 * Adapter driver SQLite — kedua jalur driver.
 *
 * Alasan berkas uji ini ada: seluruh cerita pemasangan di shared hosting bergantung
 * pada jalur `node:sqlite`, dan jalur itu HANYA terpakai ketika `better-sqlite3` gagal
 * dimuat — kondisi yang tidak pernah terjadi di mesin pengembang. Tanpa uji yang
 * memaksa kedua driver, fallback baru terbukti benar atau salah di server produksi
 * orang lain.
 *
 * Kontrak yang dijaga: keduanya harus tidak dapat dibedakan oleh pemanggil, karena
 * seluruh aplikasi memakai `SqliteDatabase` tanpa tahu driver mana yang aktif.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  driverPreference,
  openSqlite,
  type DriverPreference,
  type SqliteDatabase,
} from '../src/platform/sqlite.ts';
import { openDatabase } from '../src/platform/db.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vantik-sqlite-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function open(preference: DriverPreference, name = 'a.db'): SqliteDatabase {
  return openSqlite(join(dir, name), preference);
}

describe('Pemilihan driver — VANTIK_SQLITE_DRIVER', () => {
  it('TC-SQL-01 — tanpa konfigurasi, preferensi adalah auto', () => {
    expect(driverPreference({})).toBe('auto');
    expect(driverPreference({ VANTIK_SQLITE_DRIVER: '' })).toBe('auto');
    // Nilai tak dikenal TIDAK boleh menggagalkan startup — jatuh ke auto.
    expect(driverPreference({ VANTIK_SQLITE_DRIVER: 'postgres' })).toBe('auto');
  });

  it('TC-SQL-02 — driver dapat dipaksa lewat lingkungan', () => {
    expect(driverPreference({ VANTIK_SQLITE_DRIVER: 'node:sqlite' })).toBe('node:sqlite');
    expect(driverPreference({ VANTIK_SQLITE_DRIVER: 'better-sqlite3' })).toBe('better-sqlite3');
  });

  it('TC-SQL-03 — auto memilih better-sqlite3 bila tersedia', () => {
    const db = open('auto');
    // Di CI better-sqlite3 terpasang; bila tidak, fallback harus tetap memberi driver sah.
    expect(['better-sqlite3', 'node:sqlite']).toContain(db.driver);
    db.close();
  });

  it('TC-SQL-04 — driver yang dipaksa benar-benar dipakai, bukan diabaikan', () => {
    const nodeDb = open('node:sqlite', 'n.db');
    expect(nodeDb.driver).toBe('node:sqlite');
    nodeDb.close();

    const betterDb = open('better-sqlite3', 'b.db');
    expect(betterDb.driver).toBe('better-sqlite3');
    betterDb.close();
  });
});

/**
 * Setiap perilaku diuji terhadap KEDUA driver dengan tabel uji yang sama, sehingga
 * perbedaan halus (bentuk `changes`, penanganan `undefined`, transaksi bersarang)
 * tertangkap alih-alih tersembunyi di balik driver yang kebetulan dipakai.
 */
for (const driver of ['better-sqlite3', 'node:sqlite'] as const) {
  describe(`Kesetaraan perilaku — ${driver}`, () => {
    let db: SqliteDatabase;

    beforeEach(() => {
      db = open(driver);
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT, flag INTEGER, note TEXT)');
    });

    afterEach(() => {
      db.close();
    });

    it(`TC-SQL-05 (${driver}) — run melaporkan changes & lastInsertRowid`, () => {
      const result = db.prepare('INSERT INTO t (label, flag, note) VALUES (?,?,?)').run('a', 1, 'x');
      expect(result.changes).toBe(1);
      expect(Number(result.lastInsertRowid)).toBeGreaterThan(0);
      // `changes` harus number, bukan bigint — pemanggil membandingkannya dengan number.
      expect(typeof result.changes).toBe('number');
    });

    it(`TC-SQL-06 (${driver}) — get mengembalikan satu baris, all mengembalikan semua`, () => {
      const insert = db.prepare('INSERT INTO t (label, flag, note) VALUES (?,?,?)');
      insert.run('a', 1, 'x');
      insert.run('b', 0, 'y');

      const one = db.prepare('SELECT label FROM t WHERE label = ?').get('a') as { label: string };
      expect(one.label).toBe('a');

      const all = db.prepare('SELECT label FROM t ORDER BY label').all() as Array<{ label: string }>;
      expect(all.map((r) => r.label)).toEqual(['a', 'b']);
    });

    it(`TC-SQL-07 (${driver}) — get mengembalikan undefined bila tidak ada baris`, () => {
      expect(db.prepare('SELECT label FROM t WHERE label = ?').get('tidak-ada')).toBeUndefined();
      expect(db.prepare('SELECT label FROM t').all()).toEqual([]);
    });

    it(`TC-SQL-08 (${driver}) — undefined disimpan sebagai NULL, bukan menggagalkan kueri`, () => {
      // node:sqlite menolak `undefined` mentah; adapter menyamakannya dengan better-sqlite3.
      db.prepare('INSERT INTO t (label, flag, note) VALUES (?,?,?)').run('a', 1, undefined);
      const row = db.prepare('SELECT note FROM t WHERE label = ?').get('a') as { note: unknown };
      expect(row.note).toBeNull();
    });

    it(`TC-SQL-09 (${driver}) — boolean disimpan sebagai 0/1`, () => {
      const insert = db.prepare('INSERT INTO t (label, flag, note) VALUES (?,?,?)');
      insert.run('benar', true as unknown as number, null);
      insert.run('salah', false as unknown as number, null);

      const rows = db.prepare('SELECT label, flag FROM t ORDER BY label').all() as Array<{ label: string; flag: number }>;
      expect(rows).toEqual([
        { label: 'benar', flag: 1 },
        { label: 'salah', flag: 0 },
      ]);
    });

    it(`TC-SQL-10 (${driver}) — parameter bernama didukung, termasuk undefined di dalamnya`, () => {
      db.prepare('INSERT INTO t (label, flag, note) VALUES (:label, :flag, :note)').run({
        label: 'named',
        flag: true,
        note: undefined,
      });
      const row = db.prepare('SELECT label, flag, note FROM t WHERE label = :label').get({ label: 'named' }) as {
        label: string;
        flag: number;
        note: unknown;
      };
      expect(row).toEqual({ label: 'named', flag: 1, note: null });
    });

    it(`TC-SQL-11 (${driver}) — pragma penetapan tidak melempar, pragma pembacaan mengembalikan baris`, () => {
      expect(() => db.pragma('foreign_keys = ON')).not.toThrow();
      const list = db.pragma('database_list');
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThan(0);
    });

    it(`TC-SQL-12 (${driver}) — transaction mengembalikan FUNGSI; tanpa dipanggil tidak ada efek`, () => {
      // Bentuk ini mengikuti better-sqlite3. Pernah menjadi bug nyata: nilai kembalian
      // dibuang sehingga penyediaan tenant tidak menulis apa pun.
      const run = db.transaction(() => {
        db.prepare('INSERT INTO t (label) VALUES (?)').run('belum');
      });
      expect(typeof run).toBe('function');
      expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toMatchObject({ n: 0 });

      run();
      expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toMatchObject({ n: 1 });
    });

    it(`TC-SQL-13 (${driver}) — transaksi yang gagal mengembalikan seluruh perubahannya`, () => {
      const boom = db.transaction(() => {
        db.prepare('INSERT INTO t (label) VALUES (?)').run('a');
        db.prepare('INSERT INTO t (label) VALUES (?)').run('b');
        throw new Error('gagal di tengah');
      });

      expect(boom).toThrow('gagal di tengah');
      expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toMatchObject({ n: 0 });
    });

    it(`TC-SQL-14 (${driver}) — transaksi bersarang tidak commit lebih awal`, () => {
      // Bila tingkat dalam meng-commit sendiri, kegagalan tingkat luar akan meninggalkan
      // penulisan separuh jadi — tepatnya yang dicegah SAVEPOINT.
      const outer = db.transaction(() => {
        db.prepare('INSERT INTO t (label) VALUES (?)').run('luar');
        db.transaction(() => {
          db.prepare('INSERT INTO t (label) VALUES (?)').run('dalam');
        })();
        throw new Error('luar gagal');
      });

      expect(outer).toThrow('luar gagal');
      expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toMatchObject({ n: 0 });
    });

    it(`TC-SQL-15 (${driver}) — transaksi dalam yang gagal dapat ditangani tanpa membatalkan yang luar`, () => {
      const outer = db.transaction(() => {
        db.prepare('INSERT INTO t (label) VALUES (?)').run('luar');
        try {
          db.transaction(() => {
            db.prepare('INSERT INTO t (label) VALUES (?)').run('dalam');
            throw new Error('dalam gagal');
          })();
        } catch {
          /* ditangani dengan sengaja */
        }
        return 'selesai';
      });

      expect(outer()).toBe('selesai');
      const labels = (db.prepare('SELECT label FROM t').all() as Array<{ label: string }>).map((r) => r.label);
      expect(labels).toEqual(['luar']);
    });

    it(`TC-SQL-16 (${driver}) — transaksi berurutan setelah kegagalan tetap dapat dipakai`, () => {
      expect(
        db.transaction(() => {
          throw new Error('pertama gagal');
        }),
      ).toThrow('pertama gagal');

      db.transaction(() => {
        db.prepare('INSERT INTO t (label) VALUES (?)').run('kedua');
      })();

      expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toMatchObject({ n: 1 });
    });

    it(`TC-SQL-17 (${driver}) — nilai biner bertahan utuh`, () => {
      const blob = Buffer.from([0, 1, 2, 250, 255]);
      db.exec('CREATE TABLE b (id INTEGER PRIMARY KEY, payload BLOB)');
      db.prepare('INSERT INTO b (payload) VALUES (?)').run(blob);
      const row = db.prepare('SELECT payload FROM b').get() as { payload: Uint8Array };
      expect(Buffer.from(row.payload).equals(blob)).toBe(true);
    });
  });
}

describe('Kegagalan pemilihan driver dilaporkan jelas', () => {
  it('TC-SQL-18 — driver yang diminta tetapi tidak dapat dimuat melempar pesan yang menyebut penyebabnya', () => {
    // Lintasan tidak sah membuat pembukaan gagal pada driver mana pun, sehingga cabang
    // penanganan kesalahan ikut teruji tanpa perlu mencabut modul native.
    expect(() => openSqlite(join(dir, 'tidak', 'ada', 'direktori', 'x.db'), 'better-sqlite3')).toThrow(
      /better-sqlite3/,
    );
    expect(() => openSqlite(join(dir, 'tidak', 'ada', 'direktori', 'x.db'), 'node:sqlite')).toThrow(
      /driver SQLite/,
    );
  });
});

describe('openDatabase memakai adapter untuk ketiga penyimpanan', () => {
  for (const driver of ['better-sqlite3', 'node:sqlite'] as const) {
    it(`TC-SQL-19 (${driver}) — main, auditdb, dan vault ter-ATTACH sebagai berkas terpisah`, () => {
      const db = openDatabase({
        paths: { main: join(dir, 'm.db'), audit: join(dir, 'a.db'), vault: join(dir, 'v.db') },
        driver,
      });

      expect(db.driver).toBe(driver);

      const names = (db.pragma('database_list') as Array<{ name: string }>).map((r) => r.name).sort();
      expect(names).toEqual(['auditdb', 'main', 'vault']);

      // Migrasi ketiga penyimpanan sudah berjalan.
      expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toMatchObject({ n: expect.any(Number) });
      expect(db.prepare('SELECT COUNT(*) AS n FROM auditdb.schema_migrations').get()).toMatchObject({
        n: expect.any(Number),
      });
      expect(db.prepare('SELECT COUNT(*) AS n FROM vault.schema_migrations').get()).toMatchObject({
        n: expect.any(Number),
      });

      db.close();
    });

    it(`TC-SQL-20 (${driver}) — migrasi idempoten: membuka ulang tidak menjalankannya dua kali`, () => {
      const paths = { main: join(dir, `m-${driver}.db`), audit: join(dir, `a-${driver}.db`), vault: join(dir, `v-${driver}.db`) };

      const first = openDatabase({ paths, driver });
      const applied = (first.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n;
      first.close();

      const second = openDatabase({ paths, driver });
      expect(second.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toMatchObject({ n: applied });
      second.close();
    });
  }
});
