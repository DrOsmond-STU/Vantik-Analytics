/**
 * Outbox notifikasi.
 *
 * Alasan keberadaannya: transport bawaan tidak mengirim apa pun, dan sebelumnya ia
 * melaporkan `delivered: true` — sistem mencatat pengiriman yang tak pernah terjadi.
 * Itu bentuk kegagalan paling mahal, karena operator melihat "terkirim" lalu berhenti
 * mencari. Outbox membuat kenyataannya terlihat: pesan yang belum terkirim tetap ada,
 * berstatus `queued`, dan dapat dibaca operator.
 *
 * Dipakai untuk pesan yang bukan alert — terutama OTP pemindahan perangkat, satu-satunya
 * jalur pemulihan bagi pengguna yang berganti perangkat.
 */
import { newId, nowIso, type Db } from './db.ts';

export type OutboxStatus = 'queued' | 'sent' | 'failed';

export interface OutboxEntry {
  id: string;
  purpose: string;
  channel: string;
  recipient: string;
  subject: string;
  status: OutboxStatus;
  attempts: number;
  failure_reason: string | null;
  sensitive: number;
  created_at: string;
  sent_at: string | null;
}

export class NotificationOutbox {
  constructor(private readonly db: Db) {}

  /**
   * Dipanggil setiap kali ada pesan masuk antrean.
   *
   * Ada supaya pengiriman dapat dimulai segera setelah pesan dibuat tanpa setiap pemanggil
   * `enqueue()` harus tahu soal transport: OTP yang baru berguna dalam beberapa menit tidak
   * boleh menunggu putaran penjadwal berikutnya. Bila tidak ada yang memasangnya, perilaku
   * lama tidak berubah sama sekali — pesan hanya tersimpan.
   */
  private dispatchHook: (() => void) | null = null;

  setDispatchHook(hook: () => void): void {
    this.dispatchHook = hook;
  }

  /**
   * Memasukkan pesan ke antrean.
   *
   * `sensitive` menandai pesan yang isinya adalah rahasia sekali pakai (OTP), supaya
   * pembaca outbox dapat menyembunyikan `body`-nya kecuali pemanggil benar-benar berhak
   * — tanpa itu, daftar outbox menjadi jalan memutar untuk membaca OTP orang lain.
   */
  enqueue(input: {
    tenantId: string;
    purpose: string;
    channel: string;
    recipient: string;
    subject: string;
    body: string;
    sensitive?: boolean;
  }): string {
    const id = newId('out');
    this.db
      .prepare(
        `INSERT INTO notification_outbox
           (id, tenant_id, purpose, channel, recipient, subject, body, status, attempts,
            failure_reason, sensitive, created_at, sent_at)
         VALUES (?,?,?,?,?,?,?,'queued',0,NULL,?,?,NULL)`,
      )
      .run(
        id,
        input.tenantId,
        input.purpose,
        input.channel,
        input.recipient,
        input.subject,
        input.body,
        input.sensitive ? 1 : 0,
        nowIso(),
      );
    // Setelah baris tersimpan, bukan sebelum: pengirim yang berjalan lebih dulu tidak akan
    // menemukan apa pun untuk dikirim.
    this.dispatchHook?.();
    return id;
  }

  /**
   * Menandai terkirim. Isi pesan SENSITIF dihapus di sini.
   *
   * Sebelum ada transport, badan OTP harus tetap tersimpan — itu satu-satunya salinan yang
   * dapat dibacakan Admin. Setelah benar-benar terkirim, ia berhenti menjadi jalan
   * pemulihan dan tinggal menjadi rahasia yang mengendap di basis data. Pengguna yang tidak
   * menerima emailnya dapat meminta kode baru; kode lama yang tersimpan tidak menolong
   * siapa pun kecuali yang membaca basis data.
   */
  markSent(id: string): void {
    this.db
      .prepare(
        `UPDATE notification_outbox
            SET status = 'sent', sent_at = ?, attempts = attempts + 1,
                failure_reason = NULL,
                body = CASE WHEN sensitive = 1 THEN '' ELSE body END
          WHERE id = ?`,
      )
      .run(nowIso(), id);
  }

  markFailed(id: string, reason: string): void {
    this.db
      .prepare("UPDATE notification_outbox SET status = 'failed', failure_reason = ?, attempts = attempts + 1 WHERE id = ?")
      .run(reason, id);
  }

  /**
   * Mencatat satu percobaan yang gagal, dan menyerah hanya setelah batas percobaan.
   *
   * Statusnya tetap `queued` selama masih ada percobaan tersisa, karena "failed" pada
   * percobaan pertama akan membuat gangguan sesaat pada server email terlihat permanen —
   * dan menghentikan percobaan ulang untuk pesan yang sebenarnya masih dapat terkirim.
   *
   * Mengembalikan status akhir baris agar pemanggil dapat melaporkannya.
   */
  recordFailure(id: string, reason: string, maxAttempts: number): OutboxStatus {
    this.db
      .prepare(
        `UPDATE notification_outbox
            SET attempts = attempts + 1,
                failure_reason = ?,
                status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'queued' END
          WHERE id = ?`,
      )
      .run(reason, maxAttempts, id);
    const row = this.db.prepare('SELECT status FROM notification_outbox WHERE id = ?').get(id) as
      | { status: OutboxStatus }
      | undefined;
    return row?.status ?? 'failed';
  }

  /**
   * Pesan menunggu dari SELURUH tenant, untuk pengirim yang berjalan global.
   *
   * Diurutkan menurut jumlah percobaan lebih dulu, baru umur: tanpa itu, beberapa alamat
   * yang selalu gagal akan mengisi setiap batch dan OTP yang baru dibuat tidak pernah
   * mendapat giliran.
   */
  pendingAll(limit = 50): Array<OutboxEntry & { tenant_id: string; body: string }> {
    return this.db
      .prepare(
        `SELECT id, tenant_id, purpose, channel, recipient, subject, body, status, attempts,
                failure_reason, sensitive, created_at, sent_at
           FROM notification_outbox
          WHERE status = 'queued'
          ORDER BY attempts ASC, created_at ASC
          LIMIT ?`,
      )
      .all(limit) as Array<OutboxEntry & { tenant_id: string; body: string }>;
  }

  /** Pesan yang masih menunggu transport, terlama lebih dulu. */
  pending(tenantId: string, limit = 100): Array<OutboxEntry & { body: string }> {
    return this.db
      .prepare(
        `SELECT id, purpose, channel, recipient, subject, body, status, attempts, failure_reason,
                sensitive, created_at, sent_at
           FROM notification_outbox
          WHERE tenant_id = ? AND status = 'queued'
          ORDER BY created_at ASC
          LIMIT ?`,
      )
      .all(tenantId, limit) as Array<OutboxEntry & { body: string }>;
  }

  /**
   * Daftar untuk operator. `body` DIHILANGKAN pada entri sensitif.
   *
   * Membiarkan OTP terbaca dari daftar outbox akan meniadakan gunanya faktor itu: siapa
   * pun dengan izin membaca outbox dapat menyelesaikan pemindahan perangkat orang lain.
   */
  list(tenantId: string, limit = 200): OutboxEntry[] {
    return this.db
      .prepare(
        `SELECT id, purpose, channel, recipient, subject, status, attempts, failure_reason,
                sensitive, created_at, sent_at
           FROM notification_outbox
          WHERE tenant_id = ?
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(tenantId, limit) as OutboxEntry[];
  }

  counts(tenantId: string): Record<OutboxStatus, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM notification_outbox WHERE tenant_id = ? GROUP BY status')
      .all(tenantId) as Array<{ status: OutboxStatus; n: number }>;
    const out: Record<OutboxStatus, number> = { queued: 0, sent: 0, failed: 0 };
    for (const row of rows) out[row.status] = row.n;
    return out;
  }
}
