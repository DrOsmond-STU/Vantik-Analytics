/**
 * Lapisan HTTP bersama: middleware autentikasi, penanganan kesalahan, dan rate limiting.
 *
 * Desain API mengikuti ARCHITECTURE.md Bagian 6 — REST `/api/v1/...`, token OAuth2/OIDC
 * bergaya JWT pendek umur, rate limiting per pengguna & per token integrasi,
 * dan `Idempotency-Key` pada endpoint yang memicu efek samping.
 */
import type { NextFunction, Request, Response } from 'express';
import type { AuditService } from '../audit-service/index.ts';
import type { Db } from './db.ts';
import { AppError, RateLimitedError, UnauthenticatedError } from './errors.ts';
import { loadFeatureFlags, RequestContext, toTenantInfo, type ActorIdentity } from './context.ts';
import type { AuthService } from '../identity-service/auth.ts';
import type { Permission } from './rbac.ts';

declare module 'express-serve-static-core' {
  interface Request {
    ctx?: RequestContext;
    rawBodyText?: string;
  }
}

export interface HttpDeps {
  db: Db;
  audit: AuditService;
  auth: AuthService;
}

/** IP klien, memperhitungkan proxy tepercaya. */
export function clientIp(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0]!.trim();
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
export function authenticate(deps: HttpDeps) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const header = req.headers.authorization;
      const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
      const cookieToken = SAFE_METHODS.has(req.method)
        ? (req as Request & { cookies?: Record<string, string> }).cookies?.vantik_session
        : undefined;
      const token = bearer ?? cookieToken;
      if (!token) throw new UnauthenticatedError();

      const session = deps.auth.resolveSession(token);

      const tenantRow = deps.db
        .prepare('SELECT * FROM tenants WHERE id = ? AND deleted_at IS NULL')
        .get(session.tenantId) as
        | (Parameters<typeof toTenantInfo>[0] & { approval_status?: string })
        | undefined;
      if (!tenantRow) throw new UnauthenticatedError('error.tenant_unavailable');

      // Pendaftaran yang belum disetujui tidak boleh melewati titik ini.
      //
      // Login sudah menolaknya lebih dulu, jadi seharusnya tidak ada token yang sampai
      // ke sini — "seharusnya" itulah alasan pemeriksaan kedua ada. Bila persetujuan
      // dicabut setelah token terbit, atau sebuah jalur lain menerbitkan token tanpa
      // melewati `login()`, gerbangnya tetap satu tempat yang dilewati SETIAP permintaan
      // terautentikasi.
      if (tenantRow.approval_status !== undefined && tenantRow.approval_status !== 'approved') {
        throw new UnauthenticatedError(
          tenantRow.approval_status === 'rejected'
            ? 'error.registration_rejected'
            : 'error.registration_pending_approval',
        );
      }

      const user = deps.db
        .prepare('SELECT * FROM system_user WHERE id = ? AND tenant_id = ?')
        .get(session.userId, session.tenantId) as
        | {
            id: string;
            employee_id: string;
            email: string;
            status: string;
            locale: string;
            theme: string;
            mfa_enrolled: number;
          }
        | undefined;
      if (!user || user.status !== 'active') throw new UnauthenticatedError('error.account_disabled');

      const employee = deps.db
        .prepare('SELECT full_name FROM employee_master WHERE id = ?')
        .get(user.employee_id) as { full_name: string } | undefined;

      const roleRows = deps.db
        .prepare(
          `SELECT r.id, r.code, r.permissions_json, r.denials_json
             FROM role_assignment ra JOIN roles r ON r.id = ra.role_id
            WHERE ra.user_id = ? AND ra.tenant_id = ?`,
        )
        .all(session.userId, session.tenantId) as Array<{
        id: string;
        code: string;
        permissions_json: string;
        denials_json: string;
      }>;

      const actor: ActorIdentity = {
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

      const tenant = toTenantInfo(tenantRow);
      req.ctx = new RequestContext(
        deps.db,
        tenant,
        actor,
        roleRows.map((r) => ({
          permissions: JSON.parse(r.permissions_json) as Permission[],
          denials: JSON.parse(r.denials_json) as Permission[],
        })),
        loadFeatureFlags(deps.db, tenant.id, tenant.status),
        deps.audit,
        clientIp(req),
      );

      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireContext(req: Request): RequestContext {
  if (!req.ctx) throw new UnauthenticatedError();
  return req.ctx;
}

/**
 * Rate limiting sederhana berbasis jendela geser di memori.
 * Kuota UI dan kuota token integrasi dipisah (ARCHITECTURE.md Bagian 6).
 */
export class RateLimiter {
  /**
   * Cadangan di memori, HANYA dipakai bila tidak ada basis data.
   *
   * Dipertahankan supaya `RateLimiter` tetap dapat dipakai di luar konteks HTTP (mis.
   * pengujian unit yang tidak merangkai basis data), tetapi jalur produksi selalu
   * memakai tabel.
   */
  private readonly hits = new Map<string, number[]>();

  /** Pembersihan baris kedaluwarsa tidak perlu tiap permintaan; ini penghitungnya. */
  private sweepCounter = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    /**
     * Penyimpanan penghitung yang DIBAGI antar-proses.
     *
     * Tanpa ini, penghitung ada di Map per-proses. Passenger di shared hosting
     * menjalankan beberapa proses dan me-recycle saat idle, jadi batas "10 per menit"
     * sebenarnya 10 × jumlah proses dan hilang setiap recycle — kontrol keamanan yang
     * meluruh tanpa terlihat, justru di platform yang menjadi target pemasangan.
     */
    private readonly db?: Db,
  ) {}

  check(key: string): void {
    const now = Date.now();
    if (!this.db) {
      const window = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
      if (window.length >= this.limit) throw new RateLimitedError();
      window.push(now);
      this.hits.set(key, window);
      return;
    }

    const since = now - this.windowMs;
    // Baris kedaluwarsa untuk kunci INI dibuang lebih dulu, supaya hitungannya benar
    // tanpa bergantung pada pembersihan berkala.
    this.db.prepare('DELETE FROM rate_limit_hits WHERE bucket = ? AND hit_at_ms < ?').run(key, since);

    const used = (
      this.db.prepare('SELECT COUNT(*) AS n FROM rate_limit_hits WHERE bucket = ?').get(key) as { n: number }
    ).n;
    if (used >= this.limit) throw new RateLimitedError();

    this.db.prepare('INSERT INTO rate_limit_hits (bucket, hit_at_ms) VALUES (?, ?)').run(key, now);

    // Kunci yang tidak pernah dipakai lagi (mis. IP yang hilang) tidak akan pernah
    // membersihkan dirinya lewat jalur di atas, jadi sesekali seluruh tabel disapu.
    if (++this.sweepCounter % 200 === 0) {
      this.db.prepare('DELETE FROM rate_limit_hits WHERE hit_at_ms < ?').run(since);
    }
  }

  middleware(keyFn: (req: Request) => string) {
    return (req: Request, _res: Response, next: NextFunction): void => {
      try {
        this.check(keyFn(req));
        next();
      } catch (error) {
        next(error);
      }
    };
  }
}

/**
 * Idempotensi untuk endpoint yang memicu efek samping (ARCHITECTURE.md Bagian 6) —
 * mis. kirim notifikasi, sertifikasi dataset. Mencegah duplikasi akibat retry jaringan.
 */
export class IdempotencyStore {
  private readonly entries = new Map<string, { at: number; body: unknown; status: number }>();
  private readonly ttlMs = 24 * 3600 * 1000;

  /**
   * `db` membuat respons idempoten DIBAGI antar-proses.
   *
   * Tanpanya, permintaan ulang yang mendarat di proses Passenger berbeda tidak menemukan
   * entri apa pun dan menjalankan aksinya untuk kedua kali — yang justru dicegah oleh
   * idempotensi (mis. mengirim notifikasi dua kali, menyertifikasi dataset dua kali).
   */
  constructor(private readonly db?: Db) {}

  get(key: string): { body: unknown; status: number } | undefined {
    if (!this.db) {
      const entry = this.entries.get(key);
      if (!entry) return undefined;
      if (Date.now() - entry.at > this.ttlMs) {
        this.entries.delete(key);
        return undefined;
      }
      return { body: entry.body, status: entry.status };
    }

    const row = this.db
      .prepare('SELECT status, body_json, created_at_ms FROM idempotency_entries WHERE key = ?')
      .get(key) as { status: number; body_json: string; created_at_ms: number } | undefined;
    if (!row) return undefined;
    if (Date.now() - row.created_at_ms > this.ttlMs) {
      this.db.prepare('DELETE FROM idempotency_entries WHERE key = ?').run(key);
      return undefined;
    }
    return { body: JSON.parse(row.body_json), status: row.status };
  }

  set(key: string, status: number, body: unknown): void {
    if (!this.db) {
      this.entries.set(key, { at: Date.now(), status, body });
      return;
    }
    // INSERT OR REPLACE: dua proses yang menyelesaikan permintaan yang sama nyaris
    // bersamaan tidak boleh saling menggagalkan lewat pelanggaran kunci utama.
    this.db
      .prepare(
        `INSERT INTO idempotency_entries (key, status, body_json, created_at_ms)
         VALUES (?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET status = excluded.status,
                                        body_json = excluded.body_json,
                                        created_at_ms = excluded.created_at_ms`,
      )
      .run(key, status, JSON.stringify(body ?? null), Date.now());
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
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
      res.json = (body: unknown): Response => {
        this.set(scopedKey, res.statusCode, body);
        return originalJson(body);
      };
      next();
    };
  }
}

/**
 * Penanganan kesalahan terpusat.
 *
 * Respons hanya memuat KUNCI i18n, tidak pernah kalimat siap tampil — frontend
 * menerjemahkannya (DESIGN.md 8.2). Detail teknis internal tidak dibocorkan ke klien.
 */
export function errorHandler() {
  return (error: unknown, req: Request, res: Response, _next: NextFunction): void => {
    if (error instanceof AppError) {
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
export function securityHeaders() {
  return (_req: Request, res: Response, next: NextFunction): void => {
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
export function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void> | void,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(handler(req, res)).catch(next);
  };
}
