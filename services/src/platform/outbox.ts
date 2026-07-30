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
    return id;
  }

  markSent(id: string): void {
    this.db
      .prepare("UPDATE notification_outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1 WHERE id = ?")
      .run(nowIso(), id);
  }

  markFailed(id: string, reason: string): void {
    this.db
      .prepare("UPDATE notification_outbox SET status = 'failed', failure_reason = ?, attempts = attempts + 1 WHERE id = ?")
      .run(reason, id);
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
