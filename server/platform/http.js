"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IdempotencyStore = exports.RateLimiter = void 0;
exports.clientIp = clientIp;
exports.authenticate = authenticate;
exports.requireContext = requireContext;
exports.errorHandler = errorHandler;
exports.securityHeaders = securityHeaders;
exports.asyncRoute = asyncRoute;
const errors_ts_1 = require("./errors.js");
const context_ts_1 = require("./context.js");
/** IP klien, memperhitungkan proxy tepercaya. */
function clientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0)
        return forwarded.split(',')[0].trim();
    return req.ip ?? null;
}
/** Metode yang tidak mengubah keadaan. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/**
 * Middleware autentikasi.
 *
 * `tenant_id` diambil dari SESI TERVERIFIKASI, tidak pernah dari header/query/body
 * (ARCHITECTURE.md 5.1, SECURITY.md 16.1). Header `X-Tenant-Id` yang dikirim klien
 * diabaikan sepenuhnya — bukan divalidasi, tetapi tidak pernah dibaca.
 *
 * Cookie sesi HANYA diterima untuk metode yang tidak mengubah keadaan; permintaan yang
 * menulis wajib membawa `Authorization: Bearer`. Itulah pertahanan CSRF-nya, dan
 * dipilih sebagai penghapusan kelas serangan alih-alih token CSRF: peramban tidak dapat
 * menambahkan header Authorization pada permintaan lintas-situs tanpa lolos preflight
 * CORS, sehingga formulir dari situs lain tidak punya jalan untuk menulis. `SameSite=Lax`
 * pada cookie tetap dipasang, tetapi keamanan tidak boleh bergantung HANYA pada satu
 * perilaku peramban yang bisa berbeda antar versi.
 *
 * Aman bagi klien resmi: web app memang sudah memakai `Authorization: Bearer`
 * (`frontend/web-app/src/lib/api.ts`); cookie semata kemudahan untuk pemuatan halaman.
 */
function authenticate(deps) {
    return (req, _res, next) => {
        try {
            const header = req.headers.authorization;
            const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
            const cookieToken = SAFE_METHODS.has(req.method)
                ? req.cookies?.vantik_session
                : undefined;
            const token = bearer ?? cookieToken;
            if (!token)
                throw new errors_ts_1.UnauthenticatedError();
            const session = deps.auth.resolveSession(token);
            const tenantRow = deps.db
                .prepare('SELECT * FROM tenants WHERE id = ? AND deleted_at IS NULL')
                .get(session.tenantId);
            if (!tenantRow)
                throw new errors_ts_1.UnauthenticatedError('error.tenant_unavailable');
            // Pendaftaran yang belum disetujui tidak boleh melewati titik ini.
            //
            // Login sudah menolaknya lebih dulu, jadi seharusnya tidak ada token yang sampai
            // ke sini — "seharusnya" itulah alasan pemeriksaan kedua ada. Bila persetujuan
            // dicabut setelah token terbit, atau sebuah jalur lain menerbitkan token tanpa
            // melewati `login()`, gerbangnya tetap satu tempat yang dilewati SETIAP permintaan
            // terautentikasi.
            if (tenantRow.approval_status !== undefined && tenantRow.approval_status !== 'approved') {
                throw new errors_ts_1.UnauthenticatedError(tenantRow.approval_status === 'rejected'
                    ? 'error.registration_rejected'
                    : 'error.registration_pending_approval');
            }
            const user = deps.db
                .prepare('SELECT * FROM system_user WHERE id = ? AND tenant_id = ?')
                .get(session.userId, session.tenantId);
            if (!user || user.status !== 'active')
                throw new errors_ts_1.UnauthenticatedError('error.account_disabled');
            const employee = deps.db
                .prepare('SELECT full_name FROM employee_master WHERE id = ?')
                .get(user.employee_id);
            const roleRows = deps.db
                .prepare(`SELECT r.id, r.code, r.permissions_json, r.denials_json
             FROM role_assignment ra JOIN roles r ON r.id = ra.role_id
            WHERE ra.user_id = ? AND ra.tenant_id = ?`)
                .all(session.userId, session.tenantId);
            const actor = {
                userId: user.id,
                employeeId: user.employee_id,
                email: user.email,
                displayName: employee?.full_name ?? user.email,
                locale: user.locale === 'en' ? 'en' : 'id',
                theme: user.theme === 'dark' ? 'dark' : 'light',
                roleIds: roleRows.map((r) => r.id),
                roleCodes: roleRows.map((r) => r.code),
                sessionId: session.sessionId,
                reauthAt: session.reauthAt,
                mfaEnrolled: user.mfa_enrolled === 1,
            };
            const tenant = (0, context_ts_1.toTenantInfo)(tenantRow);
            req.ctx = new context_ts_1.RequestContext(deps.db, tenant, actor, roleRows.map((r) => ({
                permissions: JSON.parse(r.permissions_json),
                denials: JSON.parse(r.denials_json),
            })), (0, context_ts_1.loadFeatureFlags)(deps.db, tenant.id, tenant.status), deps.audit, clientIp(req));
            next();
        }
        catch (error) {
            next(error);
        }
    };
}
function requireContext(req) {
    if (!req.ctx)
        throw new errors_ts_1.UnauthenticatedError();
    return req.ctx;
}
/**
 * Rate limiting sederhana berbasis jendela geser di memori.
 * Kuota UI dan kuota token integrasi dipisah (ARCHITECTURE.md Bagian 6).
 */
class RateLimiter {
    limit;
    windowMs;
    db;
    /**
     * Cadangan di memori, HANYA dipakai bila tidak ada basis data.
     *
     * Dipertahankan supaya `RateLimiter` tetap dapat dipakai di luar konteks HTTP (mis.
     * pengujian unit yang tidak merangkai basis data), tetapi jalur produksi selalu
     * memakai tabel.
     */
    hits = new Map();
    /** Pembersihan baris kedaluwarsa tidak perlu tiap permintaan; ini penghitungnya. */
    sweepCounter = 0;
    constructor(limit, windowMs, 
    /**
     * Penyimpanan penghitung yang DIBAGI antar-proses.
     *
     * Tanpa ini, penghitung ada di Map per-proses. Passenger di shared hosting
     * menjalankan beberapa proses dan me-recycle saat idle, jadi batas "10 per menit"
     * sebenarnya 10 × jumlah proses dan hilang setiap recycle — kontrol keamanan yang
     * meluruh tanpa terlihat, justru di platform yang menjadi target pemasangan.
     */
    db) {
        this.limit = limit;
        this.windowMs = windowMs;
        this.db = db;
    }
    check(key) {
        const now = Date.now();
        if (!this.db) {
            const window = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
            if (window.length >= this.limit)
                throw new errors_ts_1.RateLimitedError();
            window.push(now);
            this.hits.set(key, window);
            return;
        }
        const since = now - this.windowMs;
        // Baris kedaluwarsa untuk kunci INI dibuang lebih dulu, supaya hitungannya benar
        // tanpa bergantung pada pembersihan berkala.
        this.db.prepare('DELETE FROM rate_limit_hits WHERE bucket = ? AND hit_at_ms < ?').run(key, since);
        const used = this.db.prepare('SELECT COUNT(*) AS n FROM rate_limit_hits WHERE bucket = ?').get(key).n;
        if (used >= this.limit)
            throw new errors_ts_1.RateLimitedError();
        this.db.prepare('INSERT INTO rate_limit_hits (bucket, hit_at_ms) VALUES (?, ?)').run(key, now);
        // Kunci yang tidak pernah dipakai lagi (mis. IP yang hilang) tidak akan pernah
        // membersihkan dirinya lewat jalur di atas, jadi sesekali seluruh tabel disapu.
        if (++this.sweepCounter % 200 === 0) {
            this.db.prepare('DELETE FROM rate_limit_hits WHERE hit_at_ms < ?').run(since);
        }
    }
    middleware(keyFn) {
        return (req, _res, next) => {
            try {
                this.check(keyFn(req));
                next();
            }
            catch (error) {
                next(error);
            }
        };
    }
}
exports.RateLimiter = RateLimiter;
/**
 * Idempotensi untuk endpoint yang memicu efek samping (ARCHITECTURE.md Bagian 6) —
 * mis. kirim notifikasi, sertifikasi dataset. Mencegah duplikasi akibat retry jaringan.
 */
class IdempotencyStore {
    db;
    entries = new Map();
    ttlMs = 24 * 3600 * 1000;
    /**
     * `db` membuat respons idempoten DIBAGI antar-proses.
     *
     * Tanpanya, permintaan ulang yang mendarat di proses Passenger berbeda tidak menemukan
     * entri apa pun dan menjalankan aksinya untuk kedua kali — yang justru dicegah oleh
     * idempotensi (mis. mengirim notifikasi dua kali, menyertifikasi dataset dua kali).
     */
    constructor(db) {
        this.db = db;
    }
    get(key) {
        if (!this.db) {
            const entry = this.entries.get(key);
            if (!entry)
                return undefined;
            if (Date.now() - entry.at > this.ttlMs) {
                this.entries.delete(key);
                return undefined;
            }
            return { body: entry.body, status: entry.status };
        }
        const row = this.db
            .prepare('SELECT status, body_json, created_at_ms FROM idempotency_entries WHERE key = ?')
            .get(key);
        if (!row)
            return undefined;
        if (Date.now() - row.created_at_ms > this.ttlMs) {
            this.db.prepare('DELETE FROM idempotency_entries WHERE key = ?').run(key);
            return undefined;
        }
        return { body: JSON.parse(row.body_json), status: row.status };
    }
    set(key, status, body) {
        if (!this.db) {
            this.entries.set(key, { at: Date.now(), status, body });
            return;
        }
        // INSERT OR REPLACE: dua proses yang menyelesaikan permintaan yang sama nyaris
        // bersamaan tidak boleh saling menggagalkan lewat pelanggaran kunci utama.
        this.db
            .prepare(`INSERT INTO idempotency_entries (key, status, body_json, created_at_ms)
         VALUES (?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET status = excluded.status,
                                        body_json = excluded.body_json,
                                        created_at_ms = excluded.created_at_ms`)
            .run(key, status, JSON.stringify(body ?? null), Date.now());
    }
    middleware() {
        return (req, res, next) => {
            const key = req.headers['idempotency-key'];
            if (typeof key !== 'string' || key.length === 0) {
                next();
                return;
            }
            const scopedKey = `${req.ctx?.tenant.id ?? 'anon'}:${req.method}:${req.path}:${key}`;
            const cached = this.get(scopedKey);
            if (cached) {
                res.status(cached.status).json(cached.body);
                return;
            }
            const originalJson = res.json.bind(res);
            res.json = (body) => {
                this.set(scopedKey, res.statusCode, body);
                return originalJson(body);
            };
            next();
        };
    }
}
exports.IdempotencyStore = IdempotencyStore;
/**
 * Penanganan kesalahan terpusat.
 *
 * Respons hanya memuat KUNCI i18n, tidak pernah kalimat siap tampil — frontend
 * menerjemahkannya (DESIGN.md 8.2). Detail teknis internal tidak dibocorkan ke klien.
 */
function errorHandler() {
    return (error, req, res, _next) => {
        if (error instanceof errors_ts_1.AppError) {
            res.status(error.status).json({
                error: { key: error.messageKey, detail: error.detail ?? null },
            });
            return;
        }
        // Kesalahan tak terduga: pesan asli disimpan di log server, bukan dikirim ke klien.
        const message = error instanceof Error ? error.message : String(error);
        console.error('[vantik] unhandled error', { path: req.path, message });
        res.status(500).json({ error: { key: 'error.internal', detail: null } });
    };
}
/** Header keamanan dasar untuk seluruh respons aplikasi. */
function securityHeaders() {
    return (_req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        // Aplikasi utama tidak boleh disematkan di mana pun; hanya endpoint embed
        // yang menetapkan frame-ancestors sendiri per token (SECURITY.md 15).
        res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
        res.setHeader('X-Frame-Options', 'DENY');
        next();
    };
}
/** Pembungkus async agar penolakan promise sampai ke error handler. */
function asyncRoute(handler) {
    return (req, res, next) => {
        Promise.resolve(handler(req, res)).catch(next);
    };
}
//# sourceMappingURL=http.js.map