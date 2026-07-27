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

/**
 * Middleware autentikasi.
 *
 * `tenant_id` diambil dari SESI TERVERIFIKASI, tidak pernah dari header/query/body
 * (ARCHITECTURE.md 5.1, SECURITY.md 16.1). Header `X-Tenant-Id` yang dikirim klien
 * diabaikan sepenuhnya — bukan divalidasi, tetapi tidak pernah dibaca.
 */
export function authenticate(deps: HttpDeps) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const header = req.headers.authorization;
      const cookieToken = (req as Request & { cookies?: Record<string, string> }).cookies?.vantik_session;
      const token = header?.startsWith('Bearer ') ? header.slice(7) : cookieToken;
      if (!token) throw new UnauthenticatedError();

      const session = deps.auth.resolveSession(token);

      const tenantRow = deps.db
        .prepare('SELECT * FROM tenants WHERE id = ? AND deleted_at IS NULL')
        .get(session.tenantId) as Parameters<typeof toTenantInfo>[0] | undefined;
      if (!tenantRow) throw new UnauthenticatedError('error.tenant_unavailable');

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
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  check(key: string): void {
    const now = Date.now();
    const window = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (window.length >= this.limit) throw new RateLimitedError();
    window.push(now);
    this.hits.set(key, window);
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

  get(key: string): { body: unknown; status: number } | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return { body: entry.body, status: entry.status };
  }

  set(key: string, status: number, body: unknown): void {
    this.entries.set(key, { at: Date.now(), status, body });
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
