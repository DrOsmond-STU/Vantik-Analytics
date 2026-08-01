"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.driverPreference = driverPreference;
exports.openSqlite = openSqlite;
const node_module_1 = require("node:module");
const node_path_1 = require("node:path");
/**
 * `node:sqlite` tidak menyediakan pembantu transaksi seperti better-sqlite3, jadi
 * dibuat di sini. Kedalaman dilacak dan tingkat bersarang memakai SAVEPOINT — sama
 * seperti perilaku better-sqlite3 — supaya transaksi bersarang tidak diam-diam
 * meng-commit lebih awal.
 */
class NodeSqliteAdapter {
    db;
    driver = 'node:sqlite';
    depth = 0;
    constructor(db) {
        this.db = db;
    }
    prepare(sql) {
        const statement = this.db.prepare(sql);
        return {
            run: (...params) => {
                const result = statement.run(...normalise(params));
                return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
            },
            get: (...params) => statement.get(...normalise(params)),
            all: (...params) => statement.all(...normalise(params)),
        };
    }
    exec(sql) {
        this.db.exec(sql);
    }
    pragma(statement) {
        // Penetapan nilai (mis. `foreign_keys = ON`) tidak mengembalikan baris; pembacaan
        // (mis. `database_list`) mengembalikan baris. `all()` menangani keduanya.
        return this.db.prepare(`PRAGMA ${statement}`).all();
    }
    transaction(fn) {
        return () => {
            const nested = this.depth > 0;
            const savepoint = `vantik_sp_${this.depth}`;
            this.db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN');
            this.depth++;
            try {
                const result = fn();
                this.depth--;
                this.db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
                return result;
            }
            catch (error) {
                this.depth--;
                // Rollback tidak boleh menutupi kesalahan aslinya — itulah yang perlu dilihat
                // pengembang, bukan kegagalan pembersihan yang menyusul.
                try {
                    this.db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
                }
                catch {
                    /* diabaikan dengan sengaja */
                }
                throw error;
            }
        };
    }
    close() {
        this.db.close();
    }
}
/**
 * Menyamakan nilai bind sebelum diteruskan ke driver mana pun.
 *
 * KEDUA driver menolak `undefined` dan `boolean` mentah — SQLite hanya mengenal
 * number/string/bigint/blob/null. Tanpa normalisasi di kedua jalur, medan opsional yang
 * tidak terisi berujung pada crash yang bergantung driver: satu pemasangan berjalan,
 * pemasangan lain gagal pada kode yang sama. Itu justru kegagalan yang paling mahal
 * dicari, karena hanya muncul di server orang lain.
 *
 * `undefined` → NULL, dan `boolean` → 0/1 (SQLite tidak punya tipe boolean). Kolom
 * `NOT NULL` tetap gagal keras seperti seharusnya, jadi normalisasi ini tidak menyamarkan
 * nilai yang memang wajib ada.
 */
function normalise(params) {
    return params.map((param) => {
        if (param === undefined)
            return null;
        if (typeof param === 'boolean')
            return param ? 1 : 0;
        if (param !== null && typeof param === 'object' && !Buffer.isBuffer(param) && !(param instanceof Uint8Array)) {
            // Objek parameter bernama: normalisasi nilainya juga.
            const out = {};
            for (const [key, value] of Object.entries(param)) {
                out[key] = value === undefined ? null : typeof value === 'boolean' ? (value ? 1 : 0) : value;
            }
            return out;
        }
        return param;
    });
}
class BetterSqliteAdapter {
    db;
    driver = 'better-sqlite3';
    constructor(db) {
        this.db = db;
    }
    prepare(sql) {
        const statement = this.db.prepare(sql);
        // Normalisasi diterapkan di SINI juga, bukan hanya pada jalur node:sqlite.
        // Kalau tidak, kedua driver tidak lagi setara dan pemanggil harus tahu driver mana
        // yang aktif — persis yang dihapus oleh adapter ini.
        return {
            run: (...params) => statement.run(...normalise(params)),
            get: (...params) => statement.get(...normalise(params)),
            all: (...params) => statement.all(...normalise(params)),
        };
    }
    exec(sql) {
        this.db.exec(sql);
    }
    pragma(statement) {
        const result = this.db.pragma(statement);
        return Array.isArray(result) ? result : [];
    }
    transaction(fn) {
        return this.db.transaction(fn);
    }
    close() {
        this.db.close();
    }
}
function driverPreference(env = process.env) {
    const requested = env.VANTIK_SQLITE_DRIVER;
    if (requested === 'better-sqlite3' || requested === 'node:sqlite')
        return requested;
    return 'auto';
}
/**
 * Membuka basis data dengan driver terbaik yang tersedia.
 *
 * `VANTIK_SQLITE_DRIVER` dapat memaksa salah satu driver — dipakai pengujian untuk
 * memverifikasi KEDUA jalur, sehingga fallback tidak menjadi kode yang tak pernah
 * teruji sampai terpakai di production.
 */
function openSqlite(filename, preference = driverPreference()) {
    const errors = [];
    if (preference === 'auto' || preference === 'better-sqlite3') {
        try {
            const create = loadBetterSqlite();
            return new BetterSqliteAdapter(create(filename));
        }
        catch (error) {
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
            return new NodeSqliteAdapter(new DatabaseSync(filename));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`node:sqlite: ${message}`);
        }
    }
    throw new Error('Tidak ada driver SQLite yang dapat dipakai. Pasang better-sqlite3, atau jalankan ' +
        `Node ≥ 22.5 agar node:sqlite tersedia. Rincian: ${errors.join(' | ')}`);
}
/** Dipisah agar dapat di-stub pada pengujian dan agar `require` tidak dievaluasi dini. */
function loadBetterSqlite() {
    const required = req('better-sqlite3');
    const ctor = required.default ?? required;
    return (filename) => new ctor(filename);
}
function loadNodeSqlite() {
    return req('node:sqlite');
}
/**
 * Pemuat modul sinkron yang bekerja pada keluaran CommonJS (deployment) MAUPUN saat
 * berjalan sebagai ESM (pengembangan & pengujian).
 *
 * `createRequire` sengaja diberi lintasan berbasis `process.cwd()`, bukan
 * `import.meta.url`: `import.meta` tidak sah pada keluaran CommonJS, sehingga
 * memakainya akan membuat berkas ini gagal dikompilasi untuk deployment.
 */
let cachedRequire = null;
function req(specifier) {
    if (!cachedRequire) {
        cachedRequire = (0, node_module_1.createRequire)((0, node_path_1.join)(process.cwd(), 'vantik-module-resolver.cjs'));
    }
    return cachedRequire(specifier);
}
//# sourceMappingURL=sqlite.js.map