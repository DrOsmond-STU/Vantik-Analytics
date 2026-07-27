/**
 * audit-service — Log Aktivitas (PRD 6.20).
 *
 * Dipisah dari layanan lain SEJAK AWAL dan tidak berbagi basis data dengan layanan
 * operasional (ARCHITECTURE.md Bagian 3 & 11, SECURITY.md Bagian 9).
 *
 * Penulisan bersifat append-only dan ditegakkan TRIGGER basis data — tidak ada fungsi
 * update/delete yang diekspor modul ini, dan seandainya ada, basis data akan menolaknya.
 */
import type { Db } from '../platform/db.ts';
import { newId, nowIso } from '../platform/db.ts';

export type AuditSeverity = 'info' | 'notice' | 'warning' | 'critical';
export type AuditOutcome = 'success' | 'denied' | 'failure';

export interface AuditEntry {
  tenantId: string | null;
  actorUserId?: string | null;
  actorLabel: string;
  actorIp?: string | null;
  action: string;
  module: string;
  objectType?: string | null;
  objectId?: string | null;
  objectLabel?: string | null;
  severity?: AuditSeverity;
  outcome?: AuditOutcome;
  detail?: Record<string, unknown> | null;
  /** SECURITY.md 16.2 — aktivitas Platform Operator lintas tenant dicatat terpisah. */
  operatorAccess?: boolean;
}

export interface AuditQuery {
  userId?: string;
  module?: string;
  action?: string;
  severity?: AuditSeverity;
  outcome?: AuditOutcome;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface AuditRecord {
  id: string;
  tenant_id: string | null;
  occurred_at: string;
  actor_user_id: string | null;
  actor_label: string;
  actor_ip: string | null;
  action: string;
  module: string;
  object_type: string | null;
  object_id: string | null;
  object_label: string | null;
  severity: AuditSeverity;
  outcome: AuditOutcome;
  detail_json: string | null;
  operator_access: number;
  partition_month: string;
}

/**
 * Penulis log. Menerima handle basis data langsung karena menulis ke skema `auditdb`
 * yang berada di luar cakupan `TenantScopedDb` — tenant_id divalidasi oleh pemanggil
 * lewat `AuditContext` di bawah.
 */
export class AuditService {
  constructor(private readonly db: Db) {}

  /**
   * Mencatat satu peristiwa. Defaultnya CATAT — TASK_INSTRUCTION.md Bagian 6:
   * "Aksi apa pun yang penting untuk diketahui siapa melakukannya → defaultnya catat,
   *  bukan sebaliknya."
   */
  record(entry: AuditEntry): AuditRecord {
    const occurredAt = nowIso();
    const row: AuditRecord = {
      id: newId('log'),
      tenant_id: entry.tenantId,
      occurred_at: occurredAt,
      actor_user_id: entry.actorUserId ?? null,
      actor_label: entry.actorLabel,
      actor_ip: entry.actorIp ?? null,
      action: entry.action,
      module: entry.module,
      object_type: entry.objectType ?? null,
      object_id: entry.objectId ?? null,
      object_label: entry.objectLabel ?? null,
      severity: entry.severity ?? 'info',
      outcome: entry.outcome ?? 'success',
      detail_json: entry.detail ? JSON.stringify(entry.detail) : null,
      operator_access: entry.operatorAccess ? 1 : 0,
      partition_month: occurredAt.slice(0, 7),
    };

    this.db
      .prepare(
        `INSERT INTO auditdb.audit_log
           (id, tenant_id, occurred_at, actor_user_id, actor_label, actor_ip, action, module,
            object_type, object_id, object_label, severity, outcome, detail_json,
            operator_access, partition_month)
         VALUES (@id, @tenant_id, @occurred_at, @actor_user_id, @actor_label, @actor_ip, @action,
                 @module, @object_type, @object_id, @object_label, @severity, @outcome,
                 @detail_json, @operator_access, @partition_month)`,
      )
      .run(row);

    return row;
  }

  /** Percobaan akses yang ditolak = potensi insiden keamanan (PRD 6.20, SECURITY.md 9). */
  recordDenial(entry: Omit<AuditEntry, 'outcome' | 'severity'>): AuditRecord {
    return this.record({ ...entry, outcome: 'denied', severity: 'warning' });
  }

  /**
   * Pencarian log untuk satu tenant.
   *
   * `tenantId` WAJIB dan berasal dari sesi terverifikasi. Auditor satu tenant tidak
   * pernah dapat membaca log tenant lain, sejalan dengan SECURITY.md 16.1.
   */
  query(tenantId: string, q: AuditQuery = {}): { rows: AuditRecord[]; total: number } {
    const where: string[] = ['tenant_id = @tenant_id'];
    const params: Record<string, unknown> = { tenant_id: tenantId };

    if (q.userId) {
      where.push('actor_user_id = @user_id');
      params.user_id = q.userId;
    }
    if (q.module) {
      where.push('module = @module');
      params.module = q.module;
    }
    if (q.action) {
      where.push('action = @action');
      params.action = q.action;
    }
    if (q.severity) {
      where.push('severity = @severity');
      params.severity = q.severity;
    }
    if (q.outcome) {
      where.push('outcome = @outcome');
      params.outcome = q.outcome;
    }
    if (q.from) {
      where.push('occurred_at >= @from');
      params.from = q.from;
    }
    if (q.to) {
      where.push('occurred_at <= @to');
      params.to = q.to;
    }
    if (q.search) {
      where.push('(actor_label LIKE @search OR object_label LIKE @search OR action LIKE @search)');
      params.search = `%${q.search}%`;
    }

    const clause = where.join(' AND ');
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM auditdb.audit_log WHERE ${clause}`)
        .get(params) as { n: number }
    ).n;

    const rows = this.db
      .prepare(
        `SELECT * FROM auditdb.audit_log WHERE ${clause}
         ORDER BY occurred_at DESC, id DESC
         LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: q.limit ?? 100, offset: q.offset ?? 0 }) as AuditRecord[];

    return { rows, total };
  }

  /**
   * Jejak akses Platform Operator terhadap sebuah tenant.
   * SECURITY.md 16.2: "tercatat di log yang dapat dilihat tenant tersebut
   * (transparansi akses vendor)."
   */
  operatorTrail(tenantId: string, limit = 100): AuditRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM auditdb.audit_log
          WHERE tenant_id = ? AND operator_access = 1
          ORDER BY occurred_at DESC LIMIT ?`,
      )
      .all(tenantId, limit) as AuditRecord[];
  }

  /** Ekspor untuk audit eksternal / permintaan regulator (PRD 6.20). */
  exportCsv(tenantId: string, q: AuditQuery = {}): string {
    const { rows } = this.query(tenantId, { ...q, limit: q.limit ?? 100_000 });
    const header = [
      'timestamp_iso8601',
      'actor',
      'actor_ip',
      'action',
      'module',
      'object_type',
      'object_id',
      'object_label',
      'severity',
      'outcome',
    ];
    const escape = (v: unknown): string => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [
          // DESIGN.md 8.3: Log Aktivitas SELALU memakai format tidak ambigu (ISO 8601),
          // apa pun locale Auditor yang membacanya.
          r.occurred_at,
          r.actor_label,
          r.actor_ip,
          r.action,
          r.module,
          r.object_type,
          r.object_id,
          r.object_label,
          r.severity,
          r.outcome,
        ]
          .map(escape)
          .join(','),
      );
    }
    return lines.join('\n');
  }

  /**
   * Statistik ringkas untuk panel Log Aktivitas.
   * Cakupan pencatatan aksi kritikal ditargetkan 100% (PRD Bagian 9).
   */
  summary(tenantId: string, sinceIso: string): {
    total: number;
    denied: number;
    critical: number;
    byModule: Array<{ module: string; n: number }>;
  } {
    const base = 'FROM auditdb.audit_log WHERE tenant_id = ? AND occurred_at >= ?';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n ${base}`).get(tenantId, sinceIso) as { n: number }).n;
    const denied = (
      this.db
        .prepare(`SELECT COUNT(*) AS n ${base} AND outcome = 'denied'`)
        .get(tenantId, sinceIso) as { n: number }
    ).n;
    const critical = (
      this.db
        .prepare(`SELECT COUNT(*) AS n ${base} AND severity = 'critical'`)
        .get(tenantId, sinceIso) as { n: number }
    ).n;
    const byModule = this.db
      .prepare(`SELECT module, COUNT(*) AS n ${base} GROUP BY module ORDER BY n DESC`)
      .all(tenantId, sinceIso) as Array<{ module: string; n: number }>;
    return { total, denied, critical, byModule };
  }

  /**
   * Pengarsipan sebelum penghapusan (PRD 6.20 — retensi ≥24 bulan, dapat diarsipkan).
   * Dijalankan proses pemeliharaan, bukan lewat antarmuka aplikasi; tetap tidak dapat
   * menghapus dari `audit_log` karena trigger menolak DELETE.
   */
  archiveOlderThan(cutoffIso: string): number {
    const rows = this.db
      .prepare('SELECT * FROM auditdb.audit_log WHERE occurred_at < ?')
      .all(cutoffIso) as AuditRecord[];
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO auditdb.audit_log_archive (id, archived_at, payload_json) VALUES (?, ?, ?)',
    );
    const at = nowIso();
    this.db.transaction(() => {
      for (const r of rows) insert.run(r.id, at, JSON.stringify(r));
    })();
    return rows.length;
  }
}
