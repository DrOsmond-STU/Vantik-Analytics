/**
 * Penjadwal pekerjaan berkala.
 *
 * Alasan keberadaannya: `schedule_cron` tersimpan untuk Report Designer dan aturan Alert
 * Center ada, tetapi TIDAK ADA yang menjalankannya. Evaluasi hanya terjadi ketika sebuah
 * panggilan API kebetulan memicunya, sehingga "Alert Center: Fungsional" sesungguhnya
 * berarti *on-demand* — ambang batas yang terlampaui tengah malam tidak diketahui siapa
 * pun sampai seseorang membuka aplikasi.
 *
 * Rancangannya mengikuti kenyataan shared hosting, bukan sebaliknya:
 *
 *  1. **Ticker dalam proses** menjalankan pekerjaan selama proses hidup.
 *  2. **Penyusulan saat boot** menjalankan pekerjaan yang terlewat, karena Passenger
 *     mematikan proses yang idle — tanpa ini, situs yang sepi tidak pernah mengevaluasi
 *     apa pun.
 *  3. **Endpoint pemicu** untuk host yang memang punya cron. Itu satu-satunya cara
 *     mendapatkan jadwal yang benar-benar andal di lingkungan yang me-recycle proses,
 *     dan panduan pemasangan menyatakannya terbuka alih-alih menjanjikan yang tidak bisa
 *     dipenuhi.
 *
 * `scheduler_runs` mencegah dua proses Passenger menjalankan pekerjaan yang sama
 * bersamaan, dan membuat "kapan terakhir berjalan" dapat dibaca operator.
 */
import type { AuditService } from '../audit-service/index.ts';
import { nowIso, type Db } from './db.ts';
import { RequestContext, loadFeatureFlags, toTenantInfo } from './context.ts';
import type { Permission } from './rbac.ts';
import { RlsScope } from './rls.ts';

/** Jeda antar-putaran ticker. */
export const SCHEDULER_INTERVAL_MS = 5 * 60 * 1000;

/** Sebuah pekerjaan dianggap masih segar bila berjalan dalam rentang ini. */
export const SCHEDULER_FRESHNESS_MS = 4 * 60 * 1000;

export interface JobOutcome {
  job: string;
  tenantsProcessed: number;
  actions: number;
  skipped?: string;
}

/**
 * Izin yang diberikan kepada aktor sistem.
 *
 * Sengaja SEMPIT, bukan `*:*`: pekerjaan berkala berjalan tanpa manusia yang mengawasi,
 * jadi cacat di dalamnya tidak boleh dapat menghapus dataset atau mengubah peran. Yang
 * dibutuhkan hanya membaca KPI/laporan dan menulis peristiwa alert.
 */
const SYSTEM_PERMISSIONS: Permission[] = [
  'kpi:read',
  'alert:read',
  'alert:write',
  'report:read',
  'dataset:read',
];

/**
 * Konteks untuk pekerjaan berkala.
 *
 * Aktornya diberi kode peran sintetis `system`, yang sengaja BUKAN salah satu dari 13
 * peran standar. Efeknya: `requiresMfa()` mengembalikan false tanpa perlu pengecualian
 * khusus — MFA adalah kontrol untuk manusia, dan proses latar bukan manusia. Log
 * Aktivitas mencatatnya sebagai `system`, sehingga aksi otomatis dapat dibedakan dari
 * aksi orang.
 */
export function systemContext(db: Db, audit: AuditService, tenantId: string): RequestContext {
  const tenantRow = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId) as Parameters<
    typeof toTenantInfo
  >[0];
  const tenant = toTenantInfo(tenantRow);

  return new RequestContext(
    db,
    tenant,
    {
      userId: 'system',
      employeeId: 'system',
      email: 'system@vantik',
      displayName: 'Penjadwal Vantik',
      locale: tenant.defaultLocale === 'en' ? 'en' : 'id',
      theme: 'light',
      roleIds: ['role_system'],
      roleCodes: ['system'],
      sessionId: 'system-scheduler',
      reauthAt: nowIso(),
      mfaEnrolled: true,
    },
    [{ permissions: SYSTEM_PERMISSIONS, denials: [] }],
    loadFeatureFlags(db, tenant.id, tenant.status),
    audit,
    null,
    // Pekerjaan sistem tidak dibatasi RLS: ia mengevaluasi ambang batas untuk seluruh
    // organisasi, bukan mewakili satu pengguna. Ia juga tidak pernah mengembalikan baris
    // ke siapa pun — hasilnya berupa peristiwa alert.
    new RlsScope([]),
  );
}

export type JobRunner = (ctx: RequestContext) => Promise<number> | number;

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly jobs: Record<string, JobRunner>,
  ) {}

  /** Tenant yang aktif. Tenant disuspensi tidak dijadwalkan apa pun. */
  private activeTenants(): string[] {
    return (
      this.db
        .prepare("SELECT id FROM tenants WHERE deleted_at IS NULL AND status NOT IN ('suspended')")
        .all() as Array<{ id: string }>
    ).map((r) => r.id);
  }

  /**
   * Klaim sebuah pekerjaan.
   *
   * Dua proses Passenger dapat memulai putaran nyaris bersamaan. Klaim ini membuat hanya
   * satu di antaranya yang bekerja: yang kedua melihat catatan yang masih segar dan
   * melewatkannya. Bukan penguncian sempurna — SQLite di shared hosting bukan tempat
   * membangun koordinasi terdistribusi — tetapi cukup untuk mencegah pekerjaan ganda
   * yang mengirim notifikasi dua kali.
   */
  private claim(job: string): boolean {
    const at = nowIso();
    const existing = this.db
      .prepare('SELECT started_at, finished_at FROM scheduler_runs WHERE job = ?')
      .get(job) as { started_at: string; finished_at: string | null } | undefined;

    if (existing && Date.now() - Date.parse(existing.started_at) < SCHEDULER_FRESHNESS_MS) return false;

    this.db
      .prepare(
        `INSERT INTO scheduler_runs (job, started_at, finished_at, outcome, detail_json)
         VALUES (?,?,NULL,NULL,NULL)
         ON CONFLICT(job) DO UPDATE SET started_at = excluded.started_at,
                                        finished_at = NULL,
                                        outcome = NULL,
                                        detail_json = NULL`,
      )
      .run(job, at);
    return true;
  }

  private finish(job: string, outcome: string, detail: Record<string, unknown>): void {
    this.db
      .prepare('UPDATE scheduler_runs SET finished_at = ?, outcome = ?, detail_json = ? WHERE job = ?')
      .run(nowIso(), outcome, JSON.stringify(detail), job);
  }

  /** Menjalankan seluruh pekerjaan yang jatuh tempo. Aman dipanggil berulang. */
  async runDueJobs(options: { force?: boolean } = {}): Promise<JobOutcome[]> {
    const results: JobOutcome[] = [];

    for (const [job, runner] of Object.entries(this.jobs)) {
      if (!options.force && !this.claim(job)) {
        results.push({ job, tenantsProcessed: 0, actions: 0, skipped: 'ran_recently' });
        continue;
      }
      if (options.force) this.claim(job);

      let actions = 0;
      let processed = 0;
      const failures: string[] = [];

      for (const tenantId of this.activeTenants()) {
        try {
          actions += await runner(systemContext(this.db, this.audit, tenantId));
          processed++;
        } catch (error) {
          // Satu tenant yang gagal TIDAK boleh menghentikan tenant lain: pada platform
          // multi-tenant itu berarti satu pelanggan dengan data rusak membekukan
          // penjadwalan seluruh pelanggan lain.
          failures.push(`${tenantId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      this.finish(job, failures.length === 0 ? 'ok' : 'partial', { actions, processed, failures });
      results.push({ job, tenantsProcessed: processed, actions });
    }

    return results;
  }

  /** Status untuk operator: kapan tiap pekerjaan terakhir berjalan dan hasilnya. */
  status(): Array<{ job: string; startedAt: string; finishedAt: string | null; outcome: string | null; detail: unknown }> {
    return (
      this.db.prepare('SELECT * FROM scheduler_runs ORDER BY job').all() as Array<{
        job: string;
        started_at: string;
        finished_at: string | null;
        outcome: string | null;
        detail_json: string | null;
      }>
    ).map((r) => ({
      job: r.job,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      outcome: r.outcome,
      detail: r.detail_json ? JSON.parse(r.detail_json) : null,
    }));
  }

  /**
   * Memulai ticker dan langsung menyusul pekerjaan yang terlewat.
   *
   * `unref()` supaya ticker tidak menahan proses tetap hidup — di shared hosting,
   * proses yang menolak mati bukan hal yang diinginkan penyedia hosting.
   */
  start(): void {
    if (this.timer) return;
    void this.runDueJobs().catch(() => {
      /* kegagalan penyusulan tidak boleh menggagalkan startup */
    });
    this.timer = setInterval(() => {
      void this.runDueJobs().catch(() => {
        /* sudah tercatat di scheduler_runs */
      });
    }, SCHEDULER_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
