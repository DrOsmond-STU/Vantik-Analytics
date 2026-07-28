/**
 * Komposisi modular monolith.
 *
 * ARCHITECTURE.md Bagian 1: batas domain (bounded context) sudah dipisah sejak awal
 * agar dapat dipecah menjadi microservices tanpa refactor besar. Berkas ini adalah
 * SATU-SATUNYA tempat konteks-konteks itu dirangkai — tidak ada layanan yang
 * mengimpor internal layanan lain secara langsung.
 */
import { timingSafeEqual } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';

import { AuditService } from './audit-service/index.ts';
import { openDatabase, type Db, type DbPaths } from './platform/db.ts';
import { NotificationOutbox } from './platform/outbox.ts';
import { Scheduler, SCHEDULER_INTERVAL_MS, type JobRunner } from './platform/scheduler.ts';
import { KeyRing } from './platform/crypto.ts';
import { ValidationError } from './platform/errors.ts';
import {
  asyncRoute,
  authenticate,
  clientIp,
  errorHandler,
  IdempotencyStore,
  RateLimiter,
  requireContext,
  securityHeaders,
  type HttpDeps,
} from './platform/http.ts';
import { MODULE_KEYS } from './platform/featureFlags.ts';
import { requiresMfa } from './platform/rbac.ts';

import { AuthService, AuthorizationService, DeviceService, EmployeeService } from './identity-service/index.ts';
import type { FingerprintComponents } from './identity-service/deviceFingerprint.ts';
import { TenantService } from './tenant-service/index.ts';
import { BillingService } from './billing-service/index.ts';
import { MeteringService } from './metering-service/index.ts';
import { ConnectionService, DatasetService, DataModelingService, KpiService } from './data-platform-service/index.ts';
import {
  StatsService,
  type CorrelationSpec,
  type DescriptiveSpec,
  type HypothesisSpec,
  type RegressionSpec,
} from './stats-service/index.ts';
import {
  AiAnalyticsService,
  DiscoveryService,
  ForecastService,
  NarrativeService,
  RcaService,
} from './ai-engine-service/index.ts';
import { DashboardService, EmbedRenderer, EmbedService, ReportService } from './designer-service/index.ts';
import { AlertService, QueueOnlyTransport, type NotificationTransport } from './alerting-service/index.ts';
import { DigitalTwinService } from './iot-gateway-service/index.ts';
import { BalancedScorecardService, CockpitService } from './presentation-service/index.ts';

export interface AppOptions {
  paths?: DbPaths;
  db?: Db;
  keyring?: KeyRing;
}

export interface VantikApp {
  app: Express;
  db: Db;
  audit: AuditService;
  auth: AuthService;
  tenants: TenantService;
  keyring: KeyRing;
  /** Penjadwal; `startServer()` yang memulainya, bukan `createApp()` — lihat catatan di sana. */
  scheduler: Scheduler;
}

export function createApp(options: AppOptions = {}): VantikApp {
  const db = options.db ?? openDatabase({ paths: options.paths });
  const keyring = options.keyring ?? KeyRing.fromEnv();
  const audit = new AuditService(db);
  const outbox = new NotificationOutbox(db);

  /**
   * Satu transport dipakai bersama seluruh permintaan.
   *
   * Sebelumnya setiap pemanggilan membangun stub-nya sendiri, sehingga memasang transport
   * nyata berarti menyunting tiga tempat dan berisiko satu terlewat — satu jalur notifikasi
   * yang masih memakai stub tidak akan memunculkan kesalahan apa pun, hanya pesan yang
   * tidak pernah terkirim. Ganti baris ini saja untuk mengaktifkan pengiriman nyata.
   */
  const notificationTransport: NotificationTransport = new QueueOnlyTransport();
  const auth = new AuthService(db, audit, outbox);
  const tenants = new TenantService(db, audit);
  tenants.seedPlans();

  const deps: HttpDeps = { db, audit, auth };
  const app = express();

  app.set('trust proxy', true);
  app.use(securityHeaders());
  app.use(cookieParser());
  app.use(
    express.json({
      limit: '250mb',
      verify: (req, _res, buffer) => {
        // Body mentah disimpan untuk verifikasi tanda tangan webhook (SECURITY.md 16.3).
        (req as Request).rawBodyText = buffer.toString('utf8');
      },
    }),
  );

  /**
   * Cookie sesi dipasang dari SATU tempat.
   *
   * Login dan verifikasi MFA sama-sama menerbitkan sesi; menyalin opsi cookie di dua
   * tempat berarti suatu saat salah satunya kehilangan `httpOnly` atau `secure` tanpa
   * ada yang menyadarinya.
   */
  const issueSessionCookie = (res: Response, token: string, expiresAt: string): void => {
    res.cookie('vantik_session', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      expires: new Date(expiresAt),
    });
  };

  /**
   * Fingerprint dari klien adalah MASUKAN TIDAK TEPERCAYA (SECURITY.md 17.2) — hashing
   * dan seluruh keputusan terjadi di server. Dipusatkan agar login dan verifikasi MFA
   * membaca bentuk yang sama; bila tidak, hash tantangan dan hash login bisa berbeda dan
   * verifikasi selalu gagal dengan alasan yang sulit dilacak.
   */
  const readFingerprint = (raw: Record<string, unknown>, req: Request): FingerprintComponents => ({
    userAgent: String(raw.userAgent ?? req.headers['user-agent'] ?? ''),
    screenResolution: String(raw.screenResolution ?? ''),
    colorDepth: Number(raw.colorDepth ?? 24),
    timezone: String(raw.timezone ?? ''),
    language: String(raw.language ?? 'id'),
    fonts: Array.isArray(raw.fonts) ? (raw.fonts as string[]) : [],
    canvasHash: String(raw.canvasHash ?? ''),
    webglHash: String(raw.webglHash ?? ''),
    platform: raw.platform ? String(raw.platform) : undefined,
  });

  // Penghitung batas laju & respons idempoten disimpan di basis data, bukan memori.
  // Passenger menjalankan beberapa proses dan me-recycle saat idle; keadaan di memori
  // membuat batasnya terkalikan jumlah proses lalu hilang saat recycle.
  const loginLimiter = new RateLimiter(10, 60_000, db);
  const apiLimiter = new RateLimiter(600, 60_000, db);
  const embedLimiter = new RateLimiter(120, 60_000, db);
  const idempotency = new IdempotencyStore(db);

  /* ================= Publik: kesehatan & autentikasi ================= */

  // DEPLOYMENT.md Bagian 7: endpoint `/healthz` per layanan dipantau liveness/readiness
  // probe Kubernetes. `/health` dipertahankan sebagai alias untuk pemanggil lain.
  const health = (_req: Request, res: Response): void => {
    res.json({ status: 'ok', service: 'vantik-analytics' });
  };
  app.get('/health', health);
  app.get('/healthz', health);

  app.post(
    '/api/v1/auth/login',
    loginLimiter.middleware((req) => `login:${clientIp(req) ?? 'unknown'}`),
    asyncRoute((req, res) => {
      const body = req.body as {
        email?: string;
        password?: string;
        tenantSlug?: string;
        fingerprint?: Record<string, unknown>;
        geo?: { lat: number; lon: number; label?: string };
      };
      if (!body.email || !body.password || !body.fingerprint) {
        throw new ValidationError('error.missing_credentials');
      }

      const result = auth.login({
        email: body.email,
        password: body.password,
        tenantSlug: body.tenantSlug,
        fingerprint: readFingerprint(body.fingerprint, req),
        ip: clientIp(req),
        geo: body.geo ?? null,
      });

      if (result.kind === 'rejected') {
        res.status(401).json({
          error: { key: result.reasonKey, recoveryKey: result.recoveryKey ?? null, retryAfter: result.retryAfter ?? null },
        });
        return;
      }

      // Faktor kedua belum selesai: TIDAK ada cookie sesi dan tidak ada token sesi yang
      // dikembalikan. Sampai kode terverifikasi, pemanggil tidak punya kewenangan apa pun.
      if (result.kind === 'mfa_required') {
        res.status(200).json({
          mfaRequired: true,
          challengeToken: result.challengeToken,
          expiresAt: result.expiresAt,
          recoveryAccepted: result.recoveryAccepted,
        });
        return;
      }

      issueSessionCookie(res, result.token, result.expiresAt);
      res.json({
        token: result.token,
        expiresAt: result.expiresAt,
        deviceRegistered: result.deviceRegistered,
      });
    }),
  );

  /**
   * Langkah kedua login.
   *
   * Memakai batas laju setingkat login dan berkunci pada token tantangan: batas
   * per-tantangan sudah ditegakkan di dalam AuthService, dan ini menambah batas
   * per-pemanggil supaya penyerang tidak dapat memutar banyak tantangan sekaligus.
   */
  app.post(
    '/api/v1/auth/mfa/verify',
    loginLimiter.middleware((req) => `mfa:${clientIp(req) ?? 'unknown'}`),
    asyncRoute((req, res) => {
      const body = req.body as {
        challengeToken?: string;
        code?: string;
        fingerprint?: Record<string, unknown>;
      };
      if (!body.challengeToken || !body.code || !body.fingerprint) {
        throw new ValidationError('error.missing_credentials');
      }

      const result = auth.verifyMfaChallenge({
        challengeToken: body.challengeToken,
        code: String(body.code),
        fingerprint: readFingerprint(body.fingerprint, req),
        ip: clientIp(req),
      });

      if (result.kind !== 'ok') {
        const rejected = result as { reasonKey?: string; recoveryKey?: string };
        res.status(401).json({
          error: { key: rejected.reasonKey ?? 'error.mfa_code_invalid', recoveryKey: rejected.recoveryKey ?? null },
        });
        return;
      }

      issueSessionCookie(res, result.token, result.expiresAt);
      res.json({
        token: result.token,
        expiresAt: result.expiresAt,
        deviceRegistered: result.deviceRegistered,
      });
    }),
  );

  /* ----- Pemulihan perangkat: jalur PUBLIK (PRD 6.30, SECURITY.md 17.4) -----
   *
   * Publik karena pengguna yang perlu memindahkan perangkat justru tidak dapat masuk —
   * itulah sebabnya ia di sini. Batas laju setingkat login, dan balasannya seragam untuk
   * kredensial salah maupun email tak dikenal supaya endpoint ini tidak dapat dipakai
   * memetakan siapa saja yang terdaftar.
   */
  app.post(
    '/api/v1/devices/transfers',
    loginLimiter.middleware((req) => `transfer:${clientIp(req) ?? 'unknown'}`),
    asyncRoute((req, res) => {
      const body = req.body as {
        email?: string;
        password?: string;
        tenantSlug?: string;
        fingerprint?: Record<string, unknown>;
        reason?: string;
      };
      if (!body.email || !body.password || !body.fingerprint) {
        throw new ValidationError('error.missing_credentials');
      }

      const result = auth.beginDeviceTransfer({
        email: body.email,
        password: body.password,
        tenantSlug: body.tenantSlug,
        fingerprint: readFingerprint(body.fingerprint, req),
        reason: body.reason,
        ip: clientIp(req),
      });

      if (!result.accepted) {
        res.status(401).json({ error: { key: result.reasonKey, recoveryKey: 'recovery.contact_admin' } });
        return;
      }

      // OTP TIDAK ada di respons ini. Ia dikirim ke alamat terdaftar pengguna; itulah
      // yang membedakan pemilik akun dari orang yang meminjam kredensialnya.
      res.json({
        requestId: result.requestId,
        expiresAt: result.expiresAt,
        // Dinyatakan apa adanya: bila belum ada transport nyata, pesan menunggu di outbox
        // dan Admin harus menyampaikannya. Lebih baik pengguna tahu daripada menunggu
        // pesan yang tidak akan datang.
        courierAvailable: result.courierAvailable,
        nextStepKey: 'recovery.enter_transfer_otp',
      });
    }),
  );

  app.post(
    '/api/v1/devices/transfers/:id/verify-otp',
    loginLimiter.middleware((req) => `transfer-otp:${clientIp(req) ?? 'unknown'}`),
    asyncRoute((req, res) => {
      const otp = String((req.body as { otp?: string }).otp ?? '');
      if (otp === '') throw new ValidationError('error.missing_credentials');

      const result = auth.verifyDeviceTransferOtp({
        requestId: req.params.id!,
        otp,
        ip: clientIp(req),
      });

      if (!result.verified) {
        res.status(400).json({ error: { key: result.reasonKey ?? 'error.transfer_otp_invalid', detail: null } });
        return;
      }
      // Verifikasi OTP BUKAN persetujuan — Admin masih harus menyetujui. Dua gerbang
      // independen, dan pengguna diberi tahu bahwa ia sekarang menunggu.
      res.json({ verified: true, awaitingApprovalKey: 'recovery.awaiting_admin_approval' });
    }),
  );

  /* ================= Embed: jalur PUBLIK terisolasi ================= */
  // ARCHITECTURE.md 4.5: berjalan pada jalur publik dengan permukaan API paling
  // minimal (hanya baca, hanya dashboard terbit) agar kompromi di sini tidak memberi
  // jalan ke designer-service internal.

  const embedRenderer = new EmbedRenderer(db, audit);

  app.get(
    '/embed/v1/dashboard',
    embedLimiter.middleware((req) => `embed:${clientIp(req) ?? 'unknown'}`),
    asyncRoute((req, res) => {
      const token = String(req.query.token ?? '');
      const origin = (req.headers.origin as string | undefined) ?? (req.headers.referer as string | undefined) ?? null;
      const normalisedOrigin = origin ? new URL(origin).origin : null;

      const result = embedRenderer.render({ token, origin: normalisedOrigin, ip: clientIp(req) });
      if (!result.ok) {
        res.status(result.status).json({ error: { key: result.reasonKey } });
        return;
      }

      // frame-ancestors mengikuti domain whitelist per token — mencegah clickjacking
      // sekaligus membatasi domain yang boleh menampilkan iframe (SECURITY.md 15).
      res.setHeader('Content-Security-Policy', result.frameAncestors);
      res.removeHeader('X-Frame-Options');
      res.json(result);
    }),
  );

  /* ================= Terautentikasi ================= */

  const api = express.Router();
  api.use(authenticate(deps));
  api.use(apiLimiter.middleware((req) => `api:${req.ctx?.actor.userId ?? clientIp(req)}`));
  api.use(idempotency.middleware());

  // --- Sesi & profil ---
  api.get('/me', (req, res) => {
    const ctx = requireContext(req);
    res.json({
      user: {
        id: ctx.actor.userId,
        email: ctx.actor.email,
        displayName: ctx.actor.displayName,
        locale: ctx.actor.locale,
        theme: ctx.actor.theme,
        roles: ctx.actor.roleCodes,
        mfaEnrolled: ctx.actor.mfaEnrolled,
      },
      tenant: ctx.tenant,
      flags: ctx.flags.toJSON(),
      rls: { restricted: !ctx.rls.isUnrestricted, dimensions: ctx.rls.dimensions() },
      permissions: [...ctx.permissions.granted],
    });
  });

  api.patch('/me/preferences', (req, res) => {
    const ctx = requireContext(req);
    const body = req.body as { locale?: 'id' | 'en'; theme?: 'light' | 'dark' };
    const updates: Record<string, string> = {};
    if (body.locale === 'id' || body.locale === 'en') updates.locale = body.locale;
    if (body.theme === 'light' || body.theme === 'dark') updates.theme = body.theme;
    if (Object.keys(updates).length > 0) {
      // Preferensi tema & bahasa disimpan di profil (server-side), bukan hanya
      // localStorage, agar konsisten lintas perangkat (DESIGN.md 7.2 & 13).
      ctx.db.update('system_user', { id: ctx.actor.userId }, updates);
    }
    res.json({ ok: true, ...updates });
  });

  /* --- MFA: pendaftaran & pengelolaan (SECURITY.md Bagian 4) --- */
  //
  // Rute-rute ini SENGAJA tidak memanggil `ctx.require(...)`: seluruhnya hanya menyentuh
  // akun pemanggil sendiri, dan izin apa pun akan ditolak oleh penegakan MFA di
  // `RequestContext` selama MFA belum aktif. Tanpa pengecualian ini, pengguna dengan
  // peran yang mewajibkan MFA akan terkunci total — tidak dapat bekerja DAN tidak dapat
  // mendaftar. Pemeriksaan modul pun tidak dipakai: MFA bukan fitur berbayar.

  api.get('/mfa/status', (req, res) => {
    const ctx = requireContext(req);
    res.json({
      ...auth.mfaStatus(ctx.tenant.id, ctx.actor.userId),
      requiredByRole: ctx.mfaEnrolmentPending || ctx.actor.mfaEnrolled,
      enrolmentPending: ctx.mfaEnrolmentPending,
    });
  });

  api.post('/mfa/enroll', (req, res) => {
    const ctx = requireContext(req);
    const result = auth.beginMfaEnrolment({
      tenantId: ctx.tenant.id,
      userId: ctx.actor.userId,
      // Nama penerbit mengikuti merek tenant bila di-white-label (BRAND.md Bagian 1),
      // supaya entri di aplikasi autentikator dapat dikenali pengguna.
      issuer: ctx.tenant.logoText ?? ctx.tenant.name,
    });
    if (result.alreadyActive) {
      res.status(409).json({ error: { key: 'error.mfa_already_active', detail: null } });
      return;
    }
    res.json(result);
  });

  api.post(
    '/mfa/activate',
    loginLimiter.middleware((req) => `mfa-activate:${req.ctx?.actor.userId ?? clientIp(req) ?? 'unknown'}`),
    (req, res) => {
      const ctx = requireContext(req);
      const code = String((req.body as { code?: string }).code ?? '');
      const result = auth.activateMfa({
        tenantId: ctx.tenant.id,
        userId: ctx.actor.userId,
        code,
        ip: ctx.ip,
      });
      if (!result.activated) {
        res.status(400).json({ error: { key: result.reasonKey ?? 'error.mfa_code_invalid', detail: null } });
        return;
      }
      // Kode pemulihan hanya muncul SEKALI di sini. Setelah respons ini hanya hash-nya
      // yang tersimpan, jadi klien wajib menampilkannya untuk dicatat pengguna.
      res.json({ activated: true, recoveryCodes: result.recoveryCodes });
    },
  );

  api.post(
    '/mfa/disable',
    loginLimiter.middleware((req) => `mfa-disable:${req.ctx?.actor.userId ?? clientIp(req) ?? 'unknown'}`),
    (req, res) => {
      const ctx = requireContext(req);
      // Peran yang mewajibkan MFA tidak boleh melepasnya. Pemeriksaan ada di sini karena
      // di sinilah peran pemanggil diketahui; AuthService sengaja tidak tahu soal peran.
      if (requiresMfa(ctx.actor.roleCodes)) {
        res.status(403).json({
          error: { key: 'error.mfa_required_by_role', detail: { roles: ctx.actor.roleCodes } },
        });
        return;
      }
      const result = auth.disableMfa({
        tenantId: ctx.tenant.id,
        userId: ctx.actor.userId,
        code: String((req.body as { code?: string }).code ?? ''),
        ip: ctx.ip,
      });
      if (!result.disabled) {
        res.status(400).json({ error: { key: result.reasonKey ?? 'error.mfa_code_invalid', detail: null } });
        return;
      }
      res.json({ disabled: true });
    },
  );

  api.post(
    '/mfa/recovery-codes',
    loginLimiter.middleware((req) => `mfa-recovery:${req.ctx?.actor.userId ?? clientIp(req) ?? 'unknown'}`),
    (req, res) => {
      const ctx = requireContext(req);
      const result = auth.regenerateRecoveryCodes({
        tenantId: ctx.tenant.id,
        userId: ctx.actor.userId,
        code: String((req.body as { code?: string }).code ?? ''),
        ip: ctx.ip,
      });
      if (result.codes.length === 0) {
        res.status(400).json({ error: { key: result.reasonKey ?? 'error.mfa_code_invalid', detail: null } });
        return;
      }
      res.json({ recoveryCodes: result.codes });
    },
  );

  api.post('/auth/logout', (req, res) => {
    const ctx = requireContext(req);
    auth.logout(ctx.actor.sessionId, ctx.tenant.id, ctx.actor.userId, ctx.actor.displayName);
    res.clearCookie('vantik_session');
    res.json({ ok: true });
  });

  // Re-autentikasi memakai batas laju setingkat LOGIN, bukan batas API umum.
  //
  // Endpoint ini memeriksa kata sandi, jadi ia adalah orakel kata sandi. Batas API umum
  // (600/menit) cukup untuk membaca data, tetapi terlalu longgar untuk menebak kata
  // sandi — dan justru endpoint inilah yang menjaga aksi paling sensitif
  // (SECURITY.md Bagian 4 & 16.3).
  api.post(
    '/auth/reauthenticate',
    loginLimiter.middleware((req) => `reauth:${req.ctx?.actor.userId ?? clientIp(req) ?? 'unknown'}`),
    (req, res) => {
      const ctx = requireContext(req);
      const password = String((req.body as { password?: string }).password ?? '');
      const ok = auth.reauthenticate(ctx.actor.sessionId, ctx.actor.userId, password);
      res.status(ok ? 200 : 401).json({ ok });
    },
  );

  api.get('/modules', (req, res) => {
    const ctx = requireContext(req);
    res.json({
      modules: MODULE_KEYS.map((key) => ({ key, enabled: ctx.flags.isEnabled(key) })),
      plan: ctx.flags.planCode,
      readOnly: ctx.flags.readOnly,
    });
  });

  /* --- Dataset & Data Quality (PRD 6.11, 6.14) --- */

  const datasetsOf = (req: Request): DatasetService =>
    new DatasetService(requireContext(req), new MeteringService(requireContext(req)));

  api.get('/datasets', (req, res) => {
    res.json({ datasets: datasetsOf(req).list(req.query as { status?: string; certification?: string }) });
  });

  api.get('/datasets/:id', (req, res) => {
    res.json(datasetsOf(req).get(req.params.id!));
  });

  api.post('/datasets/upload', (req, res) => {
    const body = req.body as { filename?: string; contentBase64?: string; name?: string; classification?: string };
    if (!body.filename || !body.contentBase64) throw new ValidationError('error.upload_payload_required');
    res.status(201).json(
      datasetsOf(req).upload({
        filename: body.filename,
        content: Buffer.from(body.contentBase64, 'base64'),
        name: body.name,
        classification: body.classification as 'internal' | undefined,
      }),
    );
  });

  api.get('/datasets/:id/rows', (req, res) => {
    res.json(
      datasetsOf(req).rows(req.params.id!, {
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      }),
    );
  });

  api.post('/datasets/:id/columns/confirm', (req, res) => {
    datasetsOf(req).confirmColumnTypes(req.params.id!, (req.body as { types: Record<string, never> }).types);
    res.json({ ok: true });
  });

  api.post('/datasets/:id/map', (req, res) => {
    datasetsOf(req).mapColumns(req.params.id!, (req.body as { mappings: never[] }).mappings);
    res.json({ ok: true });
  });

  api.post('/datasets/:id/quality-check', (req, res) => {
    res.json(datasetsOf(req).runQualityCheck(req.params.id!));
  });

  api.get('/datasets/:id/quality-history', (req, res) => {
    res.json({ history: datasetsOf(req).qualityHistory(req.params.id!) });
  });

  api.post('/datasets/:id/certify', (req, res) => {
    const body = req.body as { decision: 'certified' | 'rejected'; note?: string };
    res.json(datasetsOf(req).certify(req.params.id!, body.decision, body.note));
  });

  api.get('/datasets/:id/export', (req, res) => {
    res.type('text/csv').send(datasetsOf(req).exportCsv(req.params.id!));
  });

  /* --- Koneksi Eksternal (PRD 6.12) --- */

  const connectionsOf = (req: Request): ConnectionService =>
    new ConnectionService(requireContext(req), keyring, undefined, new MeteringService(requireContext(req)));

  api.get('/connections', (req, res) => {
    res.json({ connections: connectionsOf(req).list() });
  });

  api.post('/connections', (req, res) => {
    res.status(201).json(connectionsOf(req).create(req.body as never));
  });

  api.post(
    '/connections/:id/test',
    asyncRoute(async (req, res) => {
      res.json(await connectionsOf(req).testConnection(req.params.id!));
    }),
  );

  api.post('/connections/:id/rotate', (req, res) => {
    connectionsOf(req).rotateSecrets(req.params.id!, (req.body as { secrets: Record<string, string> }).secrets);
    res.json({ ok: true });
  });

  api.get('/connections/:id/history', (req, res) => {
    res.json({ runs: connectionsOf(req).syncHistory(req.params.id!) });
  });

  api.delete('/connections/:id', (req, res) => {
    connectionsOf(req).delete(req.params.id!);
    res.json({ ok: true });
  });

  /* --- Data Modeling (PRD 6.13) --- */

  const modelingOf = (req: Request): DataModelingService => new DataModelingService(requireContext(req));

  api.get('/model/tables', (req, res) => {
    res.json({ tables: modelingOf(req).listTables() });
  });
  api.post('/model/tables', (req, res) => {
    res.status(201).json(modelingOf(req).createTable(req.body as never));
  });
  api.post('/model/fields', (req, res) => {
    res.status(201).json(modelingOf(req).addField(req.body as never));
  });
  api.get('/model/lineage/:type/:id', (req, res) => {
    res.json(modelingOf(req).lineage(req.params.type!, req.params.id!));
  });
  api.get('/model/dictionary', (req, res) => {
    res.json({ terms: modelingOf(req).listDictionary(req.query.q as string | undefined) });
  });
  api.post('/model/dictionary', (req, res) => {
    modelingOf(req).upsertTerm(req.body as never);
    res.json({ ok: true });
  });

  /* --- KPI Center (PRD 6.15) --- */

  const kpiOf = (req: Request): KpiService => new KpiService(requireContext(req));

  api.get('/kpis', (req, res) => {
    res.json({ kpis: kpiOf(req).list() });
  });
  api.post('/kpis', (req, res) => {
    res.status(201).json(kpiOf(req).create(req.body as never));
  });
  api.get('/kpis/:id/history', (req, res) => {
    res.json({ history: kpiOf(req).historyFor(req.params.id!, Number(req.query.limit ?? 24)) });
  });
  api.post('/kpis/:id/thresholds', (req, res) => {
    kpiOf(req).setThresholds(req.params.id!, (req.body as { thresholds: never[] }).thresholds);
    res.json({ ok: true });
  });
  api.post('/kpis/:id/propose', (req, res) => {
    res.json({ approvalId: kpiOf(req).proposeChange(req.params.id!, req.body as never) });
  });
  api.post('/kpis/approvals/:approvalId/decide', (req, res) => {
    const body = req.body as { decision: 'approved' | 'rejected'; note?: string };
    kpiOf(req).decideChange(req.params.approvalId!, body.decision, body.note);
    res.json({ ok: true });
  });
  api.post('/kpis/:id/capture', (req, res) => {
    const ctx = requireContext(req);
    const body = req.body as { period: string; datasetId: string };
    const rows = new DatasetService(ctx).allRows(body.datasetId);
    res.json({ captured: kpiOf(req).captureScores(req.params.id!, body.period, rows) });
  });

  /* --- Alert Center (PRD 6.16) --- */

  const alertsOf = (req: Request): AlertService =>
    new AlertService(requireContext(req), notificationTransport, outbox);

  api.get('/alerts/rules', (req, res) => {
    res.json({ rules: alertsOf(req).listRules() });
  });
  api.post('/alerts/rules', (req, res) => {
    res.status(201).json(alertsOf(req).createRule(req.body as never));
  });
  api.post('/alerts/rules/:id/toggle', (req, res) => {
    alertsOf(req).toggleRule(req.params.id!, Boolean((req.body as { enabled: boolean }).enabled));
    res.json({ ok: true });
  });
  api.get('/alerts/history', (req, res) => {
    res.json({ events: alertsOf(req).history(Number(req.query.limit ?? 100)) });
  });
  api.post('/alerts/events/:id/acknowledge', (req, res) => {
    alertsOf(req).acknowledge(req.params.id!, (req.body as { note?: string }).note);
    res.json({ ok: true });
  });
  api.get('/alerts/latency', (req, res) => {
    res.json(alertsOf(req).detectionToNotificationStats());
  });
  api.post(
    '/alerts/evaluate',
    asyncRoute(async (req, res) => {
      res.json({ triggered: await alertsOf(req).evaluate(req.body as never) });
    }),
  );

  /* --- Dashboard / Report / Visualization / Embed (Domain 2) --- */

  const dashboardsOf = (req: Request): DashboardService =>
    new DashboardService(requireContext(req), new MeteringService(requireContext(req)));
  const reportsOf = (req: Request): ReportService => new ReportService(requireContext(req));
  const embedOf = (req: Request): EmbedService =>
    new EmbedService(requireContext(req), new MeteringService(requireContext(req)));

  api.get('/dashboards', (req, res) => {
    res.json({ dashboards: dashboardsOf(req).list(), templates: dashboardsOf(req).templates() });
  });
  api.post('/dashboards', (req, res) => {
    res.status(201).json(dashboardsOf(req).create(req.body as never));
  });
  api.get('/dashboards/:id', (req, res) => {
    res.json(dashboardsOf(req).get(req.params.id!));
  });
  api.put('/dashboards/:id/draft', (req, res) => {
    dashboardsOf(req).saveDraft(req.params.id!, (req.body as { widgets: never[] }).widgets);
    res.json({ ok: true });
  });
  api.post('/dashboards/:id/publish', (req, res) => {
    res.json(dashboardsOf(req).publish(req.params.id!));
  });
  api.get('/dashboards/:id/versions', (req, res) => {
    res.json({ versions: dashboardsOf(req).versions(req.params.id!) });
  });
  api.get('/visualizations', (req, res) => {
    res.json({ catalog: dashboardsOf(req).visualizationCatalog() });
  });

  api.get('/reports', (req, res) => {
    res.json({ reports: reportsOf(req).list() });
  });
  api.post('/reports', (req, res) => {
    res.status(201).json(reportsOf(req).create(req.body as never));
  });
  api.put('/reports/:id/blocks', (req, res) => {
    reportsOf(req).saveBlocks(req.params.id!, (req.body as { blocks: never[] }).blocks);
    res.json({ ok: true });
  });
  api.post('/reports/:id/signature', (req, res) => {
    reportsOf(req).setSignature(req.params.id!, req.body as never);
    res.json({ ok: true });
  });
  api.post('/reports/:id/schedule', (req, res) => {
    const body = req.body as { cron: string; recipients: string[] };
    reportsOf(req).schedule(req.params.id!, body.cron, body.recipients);
    res.json({ ok: true });
  });
  api.get('/reports/:id/render', (req, res) => {
    res.json(reportsOf(req).renderDocument(req.params.id!));
  });

  api.get('/dashboards/:id/embed-tokens', (req, res) => {
    res.json({ tokens: embedOf(req).list(req.params.id!), usage: embedOf(req).usageStats(req.params.id!) });
  });
  api.post('/dashboards/:id/embed-tokens', (req, res) => {
    res.status(201).json(embedOf(req).issue({ ...(req.body as object), dashboardId: req.params.id! } as never));
  });
  api.delete('/embed-tokens/:id', (req, res) => {
    embedOf(req).revoke(req.params.id!);
    res.json({ ok: true });
  });

  /* --- Analitik Cerdas (Domain 3) --- */

  api.post(
    '/ai/ask',
    asyncRoute(async (req, res) => {
      const ctx = requireContext(req);
      const service = new AiAnalyticsService(ctx, undefined, new MeteringService(ctx));
      const body = req.body as { question: string; datasetId?: string; locale?: 'id' | 'en' };
      res.json(await service.ask(body.question, { datasetId: body.datasetId, locale: body.locale }));
    }),
  );
  api.get('/ai/history', (req, res) => {
    const ctx = requireContext(req);
    res.json({ queries: new AiAnalyticsService(ctx).history() });
  });
  api.post('/forecast', (req, res) => {
    res.json(new ForecastService(requireContext(req)).run(req.body as never));
  });
  api.post('/rca/generate', (req, res) => {
    const ctx = requireContext(req);
    const body = req.body as { title: string; datasetId: string; metricField: string; dimensionFields: string[]; kpiId?: string };
    const rows = new DatasetService(ctx).allRows(body.datasetId);
    res.json(new RcaService(ctx).generate({ ...body, rows }));
  });
  api.post('/rca/:id/validate', (req, res) => {
    new RcaService(requireContext(req)).validate(req.params.id!, req.body as never);
    res.json({ ok: true });
  });
  api.get('/rca', (req, res) => {
    res.json({ records: new RcaService(requireContext(req)).list() });
  });
  api.get('/discovery/:datasetId', (req, res) => {
    res.json(new DiscoveryService(requireContext(req)).explore(req.params.datasetId!));
  });
  api.post('/narrative/generate', (req, res) => {
    res.json(new NarrativeService(requireContext(req)).generate(req.body as never));
  });
  api.get('/narrative', (req, res) => {
    res.json({ reports: new NarrativeService(requireContext(req)).list() });
  });

  /* --- Analisis Statistik (Domain 4) --- */

  const statsOf = (req: Request): StatsService => new StatsService(requireContext(req));

  /**
   * Memeriksa bentuk permintaan statistik SEBELUM diteruskan ke layanan.
   *
   * Tanpa ini, badan permintaan yang salah bentuk (mis. `predictors` alih-alih
   * `predictorFields`) menembus sampai ke kode numerik dan meledak sebagai
   * TypeError — yang oleh error handler menjadi 500. Permintaan salah dari klien
   * adalah 400: 500 menyesatkan operator (terlihat seperti server rusak) dan
   * tidak memberi klien informasi untuk memperbaiki permintaannya.
   */
  function statsSpec<T>(
    body: unknown,
    fields: { text?: readonly string[]; list?: readonly string[] },
  ): T {
    if (typeof body !== 'object' || body === null) {
      throw new ValidationError('error.validation_failed', { reason: 'body' });
    }
    const record = body as Record<string, unknown>;
    for (const field of ['datasetId', ...(fields.text ?? [])]) {
      const value = record[field];
      if (typeof value !== 'string' || value.trim() === '') {
        throw new ValidationError('error.validation_failed', { field });
      }
    }
    for (const field of fields.list ?? []) {
      const value = record[field];
      if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== 'string')) {
        throw new ValidationError('error.validation_failed', { field });
      }
    }
    return record as T;
  }

  api.post('/stats/descriptive', (req, res) => {
    res.json(statsOf(req).descriptive(statsSpec<DescriptiveSpec>(req.body, { list: ['fields'] })));
  });
  api.post('/stats/hypothesis', (req, res) => {
    res.json(statsOf(req).hypothesis(statsSpec<HypothesisSpec>(req.body, { text: ['test'] })));
  });
  api.post('/stats/correlation', (req, res) => {
    res.json(statsOf(req).correlation(statsSpec<CorrelationSpec>(req.body, { list: ['fields'] })));
  });
  api.post('/stats/regression', (req, res) => {
    res.json(
      statsOf(req).regression(
        statsSpec<RegressionSpec>(req.body, {
          text: ['kind', 'responseField'],
          list: ['predictorFields'],
        }),
      ),
    );
  });

  /* --- Digital Twin (PRD 6.17) --- */

  const twinOf = (req: Request): DigitalTwinService =>
    new DigitalTwinService(requireContext(req), new AlertService(requireContext(req), notificationTransport, outbox));

  api.get('/twin/floor-plan', (req, res) => {
    res.json({ zones: twinOf(req).floorPlan() });
  });
  api.post('/twin/zones', (req, res) => {
    res.status(201).json(twinOf(req).createZone(req.body as never));
  });
  api.post('/twin/assets', (req, res) => {
    res.status(201).json(twinOf(req).createAsset(req.body as never));
  });
  api.get('/twin/assets/:id', (req, res) => {
    res.json(twinOf(req).assetDetail(req.params.id!));
  });
  api.post(
    '/twin/readings',
    asyncRoute(async (req, res) => {
      res.json(await twinOf(req).ingestReading(req.body as never));
    }),
  );
  api.get('/twin/maintenance-queue', (req, res) => {
    res.json({ queue: twinOf(req).maintenanceQueue() });
  });
  api.post('/twin/assets/:id/tickets', (req, res) => {
    res.status(201).json(twinOf(req).createTicket(req.params.id!, req.body as never));
  });
  api.post('/twin/simulate', (req, res) => {
    res.json(twinOf(req).simulate(req.body as never));
  });
  api.get('/twin/energy', (req, res) => {
    res.json({ comparison: twinOf(req).energyComparison(req.query.sensor as string | undefined) });
  });

  /* --- Kepemimpinan (Domain 1) --- */

  api.get('/cockpit/executive', (req, res) => {
    const period = String(req.query.period ?? new Date().toISOString().slice(0, 7));
    res.json(new CockpitService(requireContext(req)).executive(period));
  });
  api.get('/cockpit/operational', (req, res) => {
    const period = String(req.query.period ?? new Date().toISOString().slice(0, 7));
    res.json(new CockpitService(requireContext(req)).operational(period, req.query.division as string | undefined));
  });
  api.get('/scorecard', (req, res) => {
    const period = String(req.query.period ?? new Date().toISOString().slice(0, 7));
    res.json(
      new BalancedScorecardService(requireContext(req)).scorecard(period, {
        comparePeriod: req.query.compare as string | undefined,
      }),
    );
  });
  api.post('/scorecard/seed', (req, res) => {
    new BalancedScorecardService(requireContext(req)).seedStandardPerspectives();
    res.json({ ok: true });
  });
  api.post('/scorecard/perspectives', (req, res) => {
    res.status(201).json(new BalancedScorecardService(requireContext(req)).addPerspective(req.body as never));
  });
  api.post('/scorecard/objectives', (req, res) => {
    res.status(201).json(new BalancedScorecardService(requireContext(req)).addObjective(req.body as never));
  });
  api.get('/scorecard/strategy-map', (req, res) => {
    res.json(new BalancedScorecardService(requireContext(req)).strategyMap());
  });

  /* --- Administrasi Sistem (Domain 7) --- */

  api.get('/employees', (req, res) => {
    res.json({ employees: new EmployeeService(requireContext(req)).list(req.query as never) });
  });
  api.post('/employees', (req, res) => {
    res.status(201).json(new EmployeeService(requireContext(req)).create(req.body as never));
  });
  api.post('/employees/:id/status', (req, res) => {
    const body = req.body as { status: 'active' | 'inactive' | 'resigned' | 'transferred' };
    res.json(new EmployeeService(requireContext(req)).changeStatus(req.params.id!, body.status, auth));
  });
  api.post('/employees/import', (req, res) => {
    res.json(new EmployeeService(requireContext(req)).importCsv((req.body as { csv: string }).csv));
  });
  api.get('/employees/access-reviews', (req, res) => {
    res.json({ overdue: new EmployeeService(requireContext(req)).overdueAccessReviews() });
  });

  api.get('/authorization/users', (req, res) => {
    res.json({ users: new AuthorizationService(requireContext(req)).listUsers() });
  });
  api.get('/authorization/roles', (req, res) => {
    res.json({ roles: new AuthorizationService(requireContext(req)).listRoles() });
  });
  api.post('/authorization/users', (req, res) => {
    res.status(201).json(new AuthorizationService(requireContext(req)).createUser(req.body as never));
  });
  api.put('/authorization/users/:id/roles', (req, res) => {
    new AuthorizationService(requireContext(req)).setRoles(req.params.id!, (req.body as { roles: string[] }).roles);
    res.json({ ok: true });
  });
  api.put('/authorization/rls', (req, res) => {
    const body = req.body as { subject: { type: 'user' | 'role'; id: string }; rules: never[] };
    new AuthorizationService(requireContext(req)).setRls(body.subject, body.rules);
    res.json({ ok: true });
  });
  api.post('/authorization/users/:id/disable', (req, res) => {
    new AuthorizationService(requireContext(req)).disableUser(req.params.id!, auth);
    res.json({ ok: true });
  });
  api.get('/authorization/access-review', (req, res) => {
    res.json(new AuthorizationService(requireContext(req)).accessReview());
  });

  api.get('/audit', (req, res) => {
    const ctx = requireContext(req);
    ctx.require('audit:read', { module: 'Log Aktivitas' });
    res.json(
      audit.query(ctx.tenant.id, {
        userId: req.query.userId as string | undefined,
        module: req.query.module as string | undefined,
        severity: req.query.severity as never,
        outcome: req.query.outcome as never,
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
        search: req.query.q as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : 100,
        offset: req.query.offset ? Number(req.query.offset) : 0,
      }),
    );
  });
  api.get('/audit/summary', (req, res) => {
    const ctx = requireContext(req);
    ctx.require('audit:read', { module: 'Log Aktivitas' });
    const since = String(req.query.since ?? new Date(Date.now() - 30 * 86_400_000).toISOString());
    res.json(audit.summary(ctx.tenant.id, since));
  });
  api.get('/audit/export', (req, res) => {
    const ctx = requireContext(req);
    ctx.require('audit:export', { module: 'Log Aktivitas' });
    res.type('text/csv').send(audit.exportCsv(ctx.tenant.id, req.query as never));
  });

  api.get('/devices/mine', (req, res) => {
    res.json({ devices: new DeviceService(requireContext(req)).myDevices() });
  });
  api.get('/devices', (req, res) => {
    res.json({ devices: new DeviceService(requireContext(req)).listAll() });
  });
  api.post('/devices/:id/unbind', (req, res) => {
    new DeviceService(requireContext(req)).unbind(req.params.id!, String((req.body as { reason?: string }).reason ?? ''), auth);
    res.json({ ok: true });
  });
  api.get('/devices/transfers', (req, res) => {
    res.json({ requests: new DeviceService(requireContext(req)).pendingTransfers() });
  });
  api.post('/devices/transfers/:id/approve', (req, res) => {
    new DeviceService(requireContext(req)).approveTransfer(req.params.id!, auth);
    res.json({ ok: true });
  });
  /**
   * Outbox notifikasi untuk operator.
   *
   * Ada supaya pesan yang belum terkirim TERLIHAT. Selama transport bawaan dipakai,
   * setiap notifikasi berstatus `queued` — dan tanpa daftar ini, tidak ada cara mengetahui
   * bahwa OTP pemindahan perangkat sedang menunggu seseorang menyampaikannya.
   *
   * Isi pesan sensitif (OTP) TIDAK disertakan: membiarkannya terbaca dari sini akan
   * meniadakan gunanya faktor itu.
   */
  api.get('/notifications/outbox', (req, res) => {
    const ctx = requireContext(req);
    ctx.require('device:read', { module: 'Perangkat & Sesi' });
    res.json({
      counts: outbox.counts(ctx.tenant.id),
      entries: outbox.list(ctx.tenant.id),
      transportConfigured: false,
    });
  });

  api.get('/sessions', (req, res) => {
    res.json({ sessions: new DeviceService(requireContext(req)).activeSessions() });
  });

  /* --- Langganan & Billing (Domain 8) --- */

  const billingOf = (req: Request): BillingService =>
    new BillingService(requireContext(req), new MeteringService(requireContext(req)));

  api.get('/subscription', (req, res) => {
    res.json({ subscription: billingOf(req).currentPlan(), plans: billingOf(req).availablePlans() });
  });
  api.post('/subscription/preview', (req, res) => {
    res.json(billingOf(req).previewPlanChange((req.body as { plan: string }).plan));
  });
  api.post('/subscription/change', (req, res) => {
    const body = req.body as { plan: string; acknowledgeDowngradeLoss?: boolean };
    res.json(billingOf(req).changePlan(body.plan, { acknowledgeDowngradeLoss: body.acknowledgeDowngradeLoss }));
  });
  api.post('/subscription/convert-trial', (req, res) => {
    const body = req.body as { paymentToken: string; paymentMethodLabel: string };
    res.json(billingOf(req).convertTrial(body.paymentToken, body.paymentMethodLabel));
  });
  api.post('/subscription/cancel', (req, res) => {
    res.json(billingOf(req).cancel((req.body as { reason?: string }).reason));
  });
  api.get('/invoices', (req, res) => {
    res.json({ invoices: billingOf(req).listInvoices() });
  });
  api.get('/invoices/:id', (req, res) => {
    res.json(billingOf(req).invoiceDocument(req.params.id!));
  });
  api.get('/usage', (req, res) => {
    const ctx = requireContext(req);
    const metering = new MeteringService(ctx);
    res.json({
      snapshot: metering.snapshot(),
      ai: metering.aiUsageBreakdown(),
      breaches: metering.breachedThresholds(),
    });
  });

  api.get('/tenants', (req, res) => {
    res.json({ tenants: tenants.listTenants(requireContext(req)) });
  });
  api.patch('/tenant/branding', (req, res) => {
    tenants.configureBranding(requireContext(req), req.body as never);
    res.json({ ok: true });
  });
  api.post('/tenants/:id/suspend', (req, res) => {
    tenants.suspend(requireContext(req), req.params.id!, String((req.body as { reason?: string }).reason ?? ''));
    res.json({ ok: true });
  });
  api.post('/tenants/:id/restore', (req, res) => {
    tenants.restore(requireContext(req), req.params.id!);
    res.json({ ok: true });
  });
  api.get('/tenant/export', (req, res) => {
    res.json(tenants.exportTenantData(requireContext(req)));
  });
  api.get('/tenant/operator-access', (req, res) => {
    res.json({ trail: tenants.operatorAccessTrail(requireContext(req)) });
  });

  // Pemicu penjadwal didaftarkan SEBELUM router `/api/v1`.
  //
  // Router itu memasang `authenticate()`, yang akan menolak permintaan cron dengan 401
  // sebelum token bersama sempat diperiksa. Kegagalan itu sempat terjadi dan tampak
  // seperti "token salah" padahal token sudah benar — urutan pendaftaran rute adalah
  // bagian dari perilakunya, bukan detail kosmetik.
  /**
   * Pemicu untuk cron eksternal.
   *
   * Ada karena Passenger mematikan proses yang idle: ticker dalam proses berhenti bersama
   * prosesnya, sehingga situs yang sepi tidak akan mengevaluasi apa pun. Host yang punya
   * cron dapat memanggil endpoint ini secara berkala dan mendapatkan penjadwalan yang
   * benar-benar andal.
   *
   * Diautentikasi dengan token bersama, BUKAN sesi: cron tidak punya sesi, dan memaksa
   * satu akun manusia menyimpan kata sandi di crontab jauh lebih buruk. Tanpa
   * `VANTIK_SCHEDULER_TOKEN` yang diset, endpoint ini menolak semua permintaan —
   * fail secure, bukan terbuka tanpa sengaja.
   */
  app.post(
    '/api/v1/system/scheduler/run',
    loginLimiter.middleware((req) => `scheduler:${clientIp(req) ?? 'unknown'}`),
    asyncRoute(async (req, res) => {
      const expected = process.env.VANTIK_SCHEDULER_TOKEN;
      const provided = req.headers['x-vantik-scheduler-token'];
      if (!expected || typeof provided !== 'string' || provided.length !== expected.length) {
        res.status(401).json({ error: { key: 'error.unauthenticated', detail: null } });
        return;
      }
      // Perbandingan waktu-konstan: token bersama tidak boleh dapat ditebak
      // karakter demi karakter dari selisih waktu balasan.
      if (!timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'))) {
        res.status(401).json({ error: { key: 'error.unauthenticated', detail: null } });
        return;
      }
      res.json({ ran: await scheduler.runDueJobs({ force: true }) });
    }),
  );

  app.use('/api/v1', api);

  /* --- Webhook payment gateway (tanda tangan diverifikasi) --- */
  app.post(
    '/webhooks/payment',
    authenticate(deps),
    asyncRoute((req, res) => {
      const ctx = requireContext(req);
      const billing = new BillingService(ctx, new MeteringService(ctx));
      const secret = process.env.VANTIK_PAYMENT_WEBHOOK_SECRET ?? '';
      const result = billing.handleGatewayWebhook(
        req.rawBodyText ?? '',
        String(req.headers['x-signature'] ?? ''),
        secret,
      );
      res.status(result.accepted ? 200 : 400).json(result);
    }),
  );


  /* ================= Penjadwal (PRD 6.4 & 6.16) ================= */

  /**
   * Sweep ambang batas KPI.
   *
   * Inilah yang sebelumnya tidak pernah berjalan: aturan alert ada, tetapi evaluasinya
   * hanya terjadi bila sebuah panggilan API kebetulan memicunya. Ambang batas yang
   * terlampaui tengah malam tidak diketahui siapa pun sampai seseorang membuka aplikasi.
   */
  const sweepAlerts: JobRunner = async (ctx) => {
    const period = new Date().toISOString().slice(0, 7);
    const breaching = new KpiService(ctx).breaching(period);
    if (breaching.length === 0) return 0;

    const alerts = new AlertService(ctx, notificationTransport, outbox);
    let triggered = 0;
    for (const { kpi, score } of breaching) {
      const events = await alerts.evaluate({
        kpiId: kpi.id,
        value: score.value,
        label: kpi.name,
        context: { period, source: 'scheduler' },
      });
      triggered += events.length;
    }
    return triggered;
  };

  /**
   * Laporan terjadwal.
   *
   * Cooldown-nya adalah `scheduler_runs` + antrean outbox: laporan yang sama tidak
   * dikirim ulang dalam satu putaran, dan yang belum terkirim tetap terlihat alih-alih
   * dicatat sebagai berhasil.
   */
  const dispatchScheduledReports: JobRunner = (ctx) => {
    const due = ctx.db.all<{ id: string; name: string; schedule_cron: string | null; schedule_recipients_json: string | null }>(
      'reports',
    );
    let queued = 0;
    for (const report of due) {
      if (!report.schedule_cron || !report.schedule_recipients_json) continue;
      const recipients = JSON.parse(report.schedule_recipients_json) as string[];
      for (const recipient of recipients) {
        outbox.enqueue({
          tenantId: ctx.tenant.id,
          purpose: 'scheduled_report',
          channel: 'email',
          recipient,
          subject: `[Vantik] ${report.name}`,
          body: `Laporan terjadwal "${report.name}" siap diunduh di aplikasi.`,
        });
        queued++;
      }
    }
    return queued;
  };

  const scheduler = new Scheduler(db, audit, {
    'alerts.sweep': sweepAlerts,
    'reports.scheduled': dispatchScheduledReports,
  });

  api.get('/system/scheduler', (req, res) => {
    const ctx = requireContext(req);
    ctx.require('alert:read', { module: 'Alert Center' });
    res.json({ jobs: scheduler.status(), intervalMs: SCHEDULER_INTERVAL_MS });
  });

  app.use(errorHandler());

  return { app, db, audit, auth, tenants, keyring, scheduler };
}

/** Respons 404 JSON konsisten untuk rute yang tidak dikenal. */
export function notFoundHandler() {
  return (_req: Request, res: Response): void => {
    res.status(404).json({ error: { key: 'error.not_found', detail: null } });
  };
}
