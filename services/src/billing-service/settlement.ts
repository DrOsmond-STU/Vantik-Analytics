/**
 * Pencatatan pembayaran oleh operator platform.
 *
 * Alasan keberadaannya adalah pemisahan wewenang. Sebelum berkas ini ada, `renew()` menerima
 * token pembayaran berupa string apa saja lalu menandai fakturnya sendiri lunas — sehingga
 * pelanggan dapat memperpanjang ruang kerjanya gratis, berulang kali, tanpa satu rupiah pun
 * masuk dan tanpa satu pun kesalahan tercatat. Pihak yang berutang tidak boleh menjadi pihak
 * yang menyatakan utangnya lunas.
 *
 * Sekarang hanya ada DUA pihak yang dapat menyatakan sebuah faktur dibayar:
 *
 *  1. **Webhook payment gateway** yang tanda tangannya diverifikasi (`BillingService`).
 *  2. **Operator platform** lewat berkas ini, memakai izin `billing:settle` — yang secara
 *     eksplisit DITOLAK untuk Super Admin tenant meski ia memegang `*:*`.
 *
 * Jalur kedua bukan solusi sementara. Selama payment gateway belum dipilih, transfer bank
 * adalah cara pembayaran yang sesungguhnya, dan mencatatnya harus meninggalkan jejak: siapa
 * mencatat, kapan, nomor referensinya apa. Ketika gateway akhirnya dipasang, ia masuk lewat
 * jalur pertama tanpa mengubah apa pun di sini.
 */
import { nowIso, type Db } from '../platform/db.ts';
import { ConflictError, NotFoundError, ValidationError } from '../platform/errors.ts';
import type { AuditService } from '../audit-service/index.ts';
import type { RequestContext } from '../platform/context.ts';
import { PLAN_BY_CODE } from '../platform/featureFlags.ts';
import { periodAfterPayment } from './index.ts';
import {
  verifyCallback,
  verifyGenericHmac,
  type CallbackEvent,
  type GatewayConfig,
} from './gateway.ts';

/** Faktur yang menunggu pembayaran, dilihat dari sisi platform (lintas tenant). */
export interface UnpaidInvoiceRow {
  id: string;
  number: string;
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  plan_code: string;
  billing_cycle: string;
  kind: string;
  period_start: string;
  period_end: string;
  total: number;
  currency: string;
  status: string;
  due_at: string;
  created_at: string;
  /** Benar bila ruang kerjanya belum pernah aktif — ini pembayaran PERTAMA, bukan perpanjangan. */
  first_payment: number;
}

export interface PaymentRecord {
  /** Nomor referensi transfer/setoran. Wajib: tanpa itu pencatatan tidak dapat ditelusuri. */
  reference: string;
  /** Cara bayar sebagaimana disebut operator, mis. "Transfer BCA". */
  methodLabel: string;
}

export class PlatformBillingService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /**
   * Faktur yang belum dibayar dari SELURUH tenant.
   *
   * Lintas tenant dengan sengaja: inilah antrean kerja operator, dan tanpa daftar ini
   * pencatatan pembayaran hanya dapat dilakukan bila seseorang sudah tahu nomor fakturnya.
   * Yang ditampilkan sebatas identitas tenant dan angka tagihan — bukan data analitiknya.
   *
   * Digerbangi `billing:settle`, BUKAN `billing:read`. Perbedaannya menentukan: `billing:read`
   * dipegang Super Admin setiap tenant untuk membaca fakturnya sendiri, dan memakainya di
   * sini berarti pelanggan dapat membaca nama, alamat, paket, dan nilai tagihan seluruh
   * pelanggan lain — kebocoran lintas tenant lewat pintu yang tampak sekadar "daftar".
   * Wewenang membaca antrean ini sama dengan wewenang menindaknya.
   */
  listUnpaid(ctx: RequestContext, limit = 200): UnpaidInvoiceRow[] {
    ctx.require('billing:settle', { module: 'Billing & Faktur' });

    return this.db
      .prepare(
        `SELECT i.id, i.number, i.tenant_id, t.name AS tenant_name, t.slug AS tenant_slug,
                s.plan_code, s.billing_cycle, i.kind, i.period_start, i.period_end,
                i.total, i.currency, i.status, i.due_at, i.created_at,
                CASE WHEN s.activated_at IS NULL THEN 1 ELSE 0 END AS first_payment
           FROM invoices i
           JOIN tenants t ON t.id = i.tenant_id
           LEFT JOIN subscriptions s ON s.tenant_id = i.tenant_id
          WHERE i.status <> 'paid' AND t.deleted_at IS NULL
          ORDER BY i.created_at ASC
          LIMIT ?`,
      )
      .all(limit) as UnpaidInvoiceRow[];
  }

  /**
   * Mencatat pembayaran yang benar-benar diterima, lalu memberlakukan periodenya.
   *
   * Perhitungan periodenya memakai `periodAfterPayment()` — fungsi yang sama dengan jalur
   * webhook. Itu bukan kerapian belaka: aturan "periode tidak boleh berakhir di masa lalu"
   * terlalu mudah menyimpang bila ditulis dua kali, dan menyimpangnya berarti pelanggan
   * membayar lalu tetap terkunci.
   */
  recordPayment(ctx: RequestContext, invoiceId: string, payment: PaymentRecord): UnpaidInvoiceRow {
    // Izin yang DITOLAK untuk Super Admin tenant, betapa pun luas izin lainnya.
    ctx.require('billing:settle', { module: 'Billing & Faktur', objectId: invoiceId });

    const reference = payment.reference?.trim() ?? '';
    if (!reference) {
      // Pencatatan tanpa referensi tidak dapat dicocokkan dengan mutasi rekening, sehingga
      // tidak dapat ditinjau kemudian — dan jejak audit yang tidak dapat diperiksa hanyalah
      // catatan yang menenangkan.
      throw new ValidationError('error.payment_reference_required');
    }
    const methodLabel = payment.methodLabel?.trim() || 'manual';

    const invoice = this.db
      .prepare(
        `SELECT i.id, i.number, i.tenant_id, i.kind, i.period_start, i.period_end, i.total, i.status,
                t.name AS tenant_name
           FROM invoices i JOIN tenants t ON t.id = i.tenant_id
          WHERE i.id = ? AND t.deleted_at IS NULL`,
      )
      .get(invoiceId) as
      | {
          id: string;
          number: string;
          tenant_id: string;
          kind: string;
          period_start: string;
          period_end: string;
          total: number;
          status: string;
          tenant_name: string;
        }
      | undefined;
    if (!invoice) throw new NotFoundError();

    // Sekali saja. Mencatat pembayaran dua kali akan memajukan masa berlaku dua siklus
    // untuk satu uang yang masuk.
    if (invoice.status === 'paid') {
      throw new ConflictError('error.invoice_already_paid', { invoice: invoice.number });
    }

    const sub = this.db
      .prepare(
        `SELECT id, billing_cycle, plan_code, activated_at, pending_plan_code
           FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(invoice.tenant_id) as
      | {
          id: string;
          billing_cycle: string;
          plan_code: string;
          activated_at: string | null;
          pending_plan_code: string | null;
        }
      | undefined;
    if (!sub) throw new NotFoundError('error.no_subscription');

    const at = nowIso();
    // `transaction()` MENGEMBALIKAN fungsi — ia harus dipanggil. Tanpa `()` di bawah,
    // seluruh blok ini tidak pernah berjalan dan pencatatan pembayaran diam-diam tidak
    // melakukan apa pun: faktur tetap terbuka, masa berlaku tidak maju, tanpa kesalahan.
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE invoices
              SET status = 'paid', paid_at = ?, gateway_ref = ?, payment_method_label = ?
            WHERE id = ?`,
        )
        .run(at, reference, methodLabel, invoiceId);

      if (invoice.kind === 'renewal' || sub.activated_at === null) {
        const period = periodAfterPayment(invoice, sub.billing_cycle, at);
        // Downgrade yang ditunda berlaku di awal siklus berikutnya (PRD 6.27) — dan siklus
        // berikutnya baru saja dimulai.
        const planCode = sub.pending_plan_code ?? sub.plan_code;
        this.db
          .prepare(
            `UPDATE subscriptions
                SET status = 'active', current_period_start = ?, current_period_end = ?,
                    lapsed_at = NULL, renewal_reminded_for = NULL,
                    plan_code = ?, pending_plan_code = NULL,
                    activated_at = COALESCE(activated_at, ?)
              WHERE id = ?`,
          )
          .run(period.start, period.end, planCode, at, sub.id);
        this.db
          .prepare("UPDATE tenants SET status = 'active', suspended_at = NULL WHERE id = ?")
          .run(invoice.tenant_id);
      }
    })();

    // Dicatat terhadap tenant yang dibayar, BUKAN tenant operatornya: yang perlu dapat
    // ditelusuri kemudian adalah riwayat pembayaran ruang kerja itu.
    this.audit.record({
      tenantId: invoice.tenant_id,
      actorUserId: ctx.actor.userId,
      actorLabel: ctx.actor.displayName,
      actorIp: ctx.ip,
      action: 'billing.payment_recorded',
      module: 'Billing & Faktur',
      objectType: 'invoice',
      objectId: invoiceId,
      objectLabel: invoice.number,
      severity: 'critical',
      operatorAccess: true,
      detail: {
        reference,
        methodLabel,
        total: invoice.total,
        firstPayment: sub.activated_at === null,
        plan: PLAN_BY_CODE.get(sub.plan_code)?.name ?? sub.plan_code,
      },
    });

    return this.listUnpaidFor(invoiceId);
  }

  /**
   * Kabar pembayaran dari penyedia, TANPA sesi.
   *
   * Ada di sisi platform karena payment gateway tidak punya — dan tidak boleh punya — sesi
   * pengguna. Sebelumnya endpoint webhook berada di balik `authenticate`, sehingga setiap
   * kabar dijawab 401: jalurnya terbaca benar di kode tetapi tidak pernah dapat dipanggil
   * penyedia mana pun. Otentikasinya adalah TANDA TANGAN pesan, bukan sesi.
   *
   * Lintas tenant, karena kabar datang untuk faktur mana pun. Faktur dicari lewat id yang
   * kita sendiri kirim sebagai `external_id`/`order_id`, jadi tidak ada penebakan tenant.
   */
  applyProviderCallback(
    rawBody: string,
    headers: Record<string, string | undefined>,
    options: { gateway: GatewayConfig | null; hmacSecret: string; ip: string | null },
  ): { accepted: boolean; reasonKey?: string } {
    let event: CallbackEvent;
    let invoiceId: string;
    let reference: string | null = null;
    let methodLabel: string | null = null;

    if (options.gateway) {
      const verdict = verifyCallback(options.gateway, rawBody, headers);
      if (!verdict.ok) return { accepted: false, reasonKey: verdict.reasonKey };
      ({ event, invoiceId, reference, methodLabel } = verdict);
    } else {
      // Jalur generik: HMAC-SHA256 di header `x-signature`. Rahasia kosong = penolakan.
      const check = verifyGenericHmac(options.hmacSecret, rawBody, String(headers['x-signature'] ?? ''));
      if (!check.ok) return { accepted: false, reasonKey: check.reasonKey };
      let payload: { event?: string; invoiceId?: string; gatewayRef?: string };
      try {
        payload = JSON.parse(rawBody) as typeof payload;
      } catch {
        return { accepted: false, reasonKey: 'error.webhook_payload_invalid' };
      }
      event =
        payload.event === 'payment.succeeded' ? 'paid' : payload.event === 'payment.failed' ? 'failed' : 'ignored';
      invoiceId = String(payload.invoiceId ?? '');
      reference = payload.gatewayRef ?? null;
    }

    const invoice = this.db
      .prepare(
        `SELECT i.id, i.tenant_id, i.number, i.kind, i.period_start, i.period_end, i.status
           FROM invoices i JOIN tenants t ON t.id = i.tenant_id
          WHERE i.id = ? AND t.deleted_at IS NULL`,
      )
      .get(invoiceId) as
      | {
          id: string;
          tenant_id: string;
          number: string;
          kind: string;
          period_start: string;
          period_end: string;
          status: string;
        }
      | undefined;
    if (!invoice) return { accepted: false, reasonKey: 'error.not_found' };

    // Idempoten. Penyedia MENGIRIM ULANG kabar yang tidak dijawab 2xx, dan tanpa penjagaan
    // ini pengiriman ulang memajukan masa berlaku satu siklus lagi untuk satu pembayaran.
    // Jawabannya tetap "diterima" supaya penyedia berhenti mencoba.
    if (event === 'paid' && invoice.status === 'paid') return { accepted: true };

    const sub = this.db
      .prepare(
        `SELECT id, billing_cycle, plan_code, activated_at, pending_plan_code
           FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(invoice.tenant_id) as
      | {
          id: string;
          billing_cycle: string;
          plan_code: string;
          activated_at: string | null;
          pending_plan_code: string | null;
        }
      | undefined;
    if (!sub) return { accepted: false, reasonKey: 'error.no_subscription' };

    const at = nowIso();
    if (event === 'paid') {
      this.db.transaction(() => {
        this.db
          .prepare(
            `UPDATE invoices SET status = 'paid', paid_at = ?, gateway_ref = COALESCE(?, gateway_ref),
                                 payment_method_label = COALESCE(?, payment_method_label)
              WHERE id = ?`,
          )
          .run(at, reference, methodLabel, invoice.id);

        if (invoice.kind === 'renewal' || sub.activated_at === null) {
          const period = periodAfterPayment(invoice, sub.billing_cycle, at);
          this.db
            .prepare(
              `UPDATE subscriptions
                  SET status = 'active', current_period_start = ?, current_period_end = ?,
                      lapsed_at = NULL, renewal_reminded_for = NULL,
                      plan_code = ?, pending_plan_code = NULL,
                      activated_at = COALESCE(activated_at, ?)
                WHERE id = ?`,
            )
            .run(period.start, period.end, sub.pending_plan_code ?? sub.plan_code, at, sub.id);
          this.db
            .prepare("UPDATE tenants SET status = 'active', suspended_at = NULL WHERE id = ?")
            .run(invoice.tenant_id);
        }
      })();
    } else if (event === 'failed') {
      this.db.prepare("UPDATE invoices SET status = 'failed' WHERE id = ?").run(invoice.id);
    }

    // Aktornya BUKAN manusia. Dicatat apa adanya, terhadap tenant yang dibayar, supaya
    // riwayat pembayaran dapat dibedakan dari pencatatan manual oleh operator.
    this.audit.record({
      tenantId: invoice.tenant_id,
      actorUserId: 'payment_gateway',
      actorLabel: options.gateway ? `gateway:${options.gateway.provider}` : 'gateway:generic',
      actorIp: options.ip,
      action: event === 'paid' ? 'billing.payment_confirmed' : 'billing.payment_notice',
      module: 'Billing & Faktur',
      objectType: 'invoice',
      objectId: invoice.id,
      objectLabel: invoice.number,
      severity: event === 'paid' ? 'notice' : 'info',
      detail: { event, reference, methodLabel },
    });

    return { accepted: true };
  }

  /** Baris faktur setelah dicatat — dipakai pemanggil untuk menampilkan hasilnya. */
  private listUnpaidFor(invoiceId: string): UnpaidInvoiceRow {
    return this.db
      .prepare(
        `SELECT i.id, i.number, i.tenant_id, t.name AS tenant_name, t.slug AS tenant_slug,
                s.plan_code, s.billing_cycle, i.kind, i.period_start, i.period_end,
                i.total, i.currency, i.status, i.due_at, i.created_at,
                CASE WHEN s.activated_at IS NULL THEN 1 ELSE 0 END AS first_payment
           FROM invoices i
           JOIN tenants t ON t.id = i.tenant_id
           LEFT JOIN subscriptions s ON s.tenant_id = i.tenant_id
          WHERE i.id = ?`,
      )
      .get(invoiceId) as UnpaidInvoiceRow;
  }
}
