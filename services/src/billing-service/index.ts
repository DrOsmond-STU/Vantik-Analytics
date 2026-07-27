/**
 * billing-service — Manajemen Langganan & Paket (PRD 6.27), Billing & Faktur (PRD 6.28).
 *
 * SECURITY.md 16.3: data kartu pembayaran TIDAK PERNAH disentuh atau disimpan sistem
 * Vantik — seluruh proses ditangani payment gateway bersertifikasi PCI-DSS; sistem
 * hanya menyimpan token referensi dan metadata transaksi.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { newId, nowIso } from '../platform/db.ts';
import { ConflictError, NotFoundError, ValidationError } from '../platform/errors.ts';
import { PLAN_BY_CODE, PLAN_CATALOG, type QuotaKey } from '../platform/featureFlags.ts';
import type { RequestContext } from '../platform/context.ts';
import type { MeteringService } from '../metering-service/index.ts';

/** Masa tenggang sebelum layanan dibatasi (PRD 6.28). */
export const GRACE_PERIOD_DAYS = 14;
/** PPN Indonesia; nilai final ditetapkan tim bisnis (PRD Bagian 12). */
export const DEFAULT_TAX_RATE = 0.11;

export interface SubscriptionView {
  id: string;
  plan_code: string;
  plan_name: string;
  billing_cycle: string;
  status: string;
  trial_ends_at: string | null;
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: number;
  pending_plan_code: string | null;
  features: Record<string, boolean>;
  quotas: Record<string, number>;
}

export interface InvoiceView {
  id: string;
  number: string;
  period_start: string;
  period_end: string;
  subtotal: number;
  tax_rate: number;
  tax_amount: number;
  total: number;
  currency: string;
  status: string;
  due_at: string;
  paid_at: string | null;
  payment_method_label: string | null;
  lines: Array<{ description: string; amount: number }>;
}

export interface PlanChangePreview {
  fromPlan: string;
  toPlan: string;
  effective: 'immediate' | 'next_cycle';
  /** Perhitungan pro-rata yang transparan (PRD 6.27). */
  proration: { unusedCredit: number; newCharge: number; dueNow: number } | null;
  blockingIssues: Array<{ metric: QuotaKey; current: number; newQuota: number }>;
}

export class BillingService {
  constructor(
    private readonly ctx: RequestContext,
    private readonly metering: MeteringService,
  ) {}

  private currentSubscription(): {
    id: string;
    plan_code: string;
    billing_cycle: string;
    status: string;
    trial_ends_at: string | null;
    current_period_start: string;
    current_period_end: string;
    cancel_at_period_end: number;
    pending_plan_code: string | null;
  } {
    const sub = this.ctx.db.all<{
      id: string;
      plan_code: string;
      billing_cycle: string;
      status: string;
      trial_ends_at: string | null;
      current_period_start: string;
      current_period_end: string;
      cancel_at_period_end: number;
      pending_plan_code: string | null;
    }>('subscriptions', undefined, { orderBy: 'created_at DESC', limit: 1 })[0];
    if (!sub) throw new NotFoundError('error.no_subscription');
    return sub;
  }

  /** Paket aktif, siklus, tanggal perpanjangan, dan fitur tercakup (PRD 6.27). */
  currentPlan(): SubscriptionView {
    this.ctx.require('subscription:read', { module: 'Manajemen Langganan & Paket' });
    this.ctx.requireModule('subscription_management');

    const sub = this.currentSubscription();
    const plan = PLAN_BY_CODE.get(sub.plan_code)!;
    return {
      ...sub,
      plan_name: plan.name,
      features: plan.features,
      quotas: plan.quotas,
    };
  }

  availablePlans(): typeof PLAN_CATALOG {
    this.ctx.require('subscription:read', { module: 'Manajemen Langganan & Paket' });
    return PLAN_CATALOG;
  }

  /**
   * Pratinjau perubahan paket.
   *
   * PRD 6.27: upgrade berlaku SEGERA, downgrade berlaku pada awal siklus berikutnya,
   * dengan perhitungan pro-rata yang transparan. Sistem memperingatkan bila konfigurasi
   * saat ini melebihi batas paket tujuan.
   */
  previewPlanChange(targetPlanCode: string): PlanChangePreview {
    this.ctx.require('subscription:read', { module: 'Manajemen Langganan & Paket' });

    const target = PLAN_BY_CODE.get(targetPlanCode);
    if (!target) throw new ValidationError('error.plan_unknown', { plan: targetPlanCode });

    const sub = this.currentSubscription();
    const current = PLAN_BY_CODE.get(sub.plan_code)!;
    const isUpgrade = target.sortOrder > current.sortOrder;

    // Peringatan bila konfigurasi saat ini melebihi kuota paket tujuan.
    const blockingIssues: PlanChangePreview['blockingIssues'] = [];
    const metrics: QuotaKey[] = ['users', 'datasets', 'connections', 'embed_tokens', 'storage_mb'];
    for (const metric of metrics) {
      const newQuota = target.quotas[metric];
      if (newQuota < 0) continue;
      const used = this.metering.currentUsage(metric);
      if (used > newQuota) blockingIssues.push({ metric, current: used, newQuota });
    }

    let proration: PlanChangePreview['proration'] = null;
    if (isUpgrade) {
      const periodStart = Date.parse(sub.current_period_start);
      const periodEnd = Date.parse(sub.current_period_end);
      const totalMs = Math.max(1, periodEnd - periodStart);
      const remainingRatio = Math.max(0, Math.min(1, (periodEnd - Date.now()) / totalMs));

      const currentPrice = sub.billing_cycle === 'annual' ? current.annualPrice : current.monthlyPrice;
      const targetPrice = sub.billing_cycle === 'annual' ? target.annualPrice : target.monthlyPrice;

      const unusedCredit = Math.round(currentPrice * remainingRatio);
      const newCharge = Math.round(targetPrice * remainingRatio);
      proration = { unusedCredit, newCharge, dueNow: Math.max(0, newCharge - unusedCredit) };
    }

    return {
      fromPlan: sub.plan_code,
      toPlan: targetPlanCode,
      effective: isUpgrade ? 'immediate' : 'next_cycle',
      proration,
      blockingIssues,
    };
  }

  /** Menerapkan perubahan paket. Perubahan menuntut re-autentikasi (SECURITY.md 16.3). */
  changePlan(targetPlanCode: string, options: { acknowledgeDowngradeLoss?: boolean } = {}): PlanChangePreview {
    this.ctx.require('subscription:write', { module: 'Manajemen Langganan & Paket' });
    this.ctx.requireWritable();

    const preview = this.previewPlanChange(targetPlanCode);
    if (preview.blockingIssues.length > 0 && !options.acknowledgeDowngradeLoss) {
      throw new ConflictError('error.downgrade_exceeds_new_quota', {
        issues: preview.blockingIssues,
      });
    }

    const sub = this.currentSubscription();
    const at = nowIso();

    if (preview.effective === 'immediate') {
      this.ctx.db.update(
        'subscriptions',
        { id: sub.id },
        { plan_code: targetPlanCode, pending_plan_code: null, status: 'active' },
      );
      if (preview.proration && preview.proration.dueNow > 0) {
        this.issueInvoice({
          lines: [
            { description: `Pro-rata upgrade ke ${targetPlanCode}`, amount: preview.proration.newCharge },
            { description: 'Kredit sisa periode paket sebelumnya', amount: -preview.proration.unusedCredit },
          ],
          periodStart: at,
          periodEnd: sub.current_period_end,
        });
      }
    } else {
      // Downgrade berlaku awal siklus berikutnya.
      this.ctx.db.update('subscriptions', { id: sub.id }, { pending_plan_code: targetPlanCode });
    }

    this.ctx.log({
      action: 'subscription.plan_changed',
      module: 'Manajemen Langganan & Paket',
      objectType: 'subscription',
      objectId: sub.id,
      severity: 'critical',
      detail: {
        from: sub.plan_code,
        to: targetPlanCode,
        effective: preview.effective,
        proration: preview.proration,
      },
    });

    return preview;
  }

  /**
   * Konversi uji coba ke berbayar TANPA kehilangan data yang dibuat selama uji coba
   * (PRD 6.27) — hanya status langganan yang berubah, tidak ada data yang disentuh.
   */
  convertTrial(paymentToken: string, paymentMethodLabel: string): InvoiceView {
    this.ctx.require('subscription:write', { module: 'Manajemen Langganan & Paket' });
    this.ctx.requireWritable();

    const sub = this.currentSubscription();
    if (sub.status !== 'trialing') throw new ConflictError('error.not_in_trial');

    const plan = PLAN_BY_CODE.get(sub.plan_code)!;
    const at = nowIso();
    const periodEnd = new Date(
      Date.now() + (sub.billing_cycle === 'annual' ? 365 : 30) * 86_400_000,
    ).toISOString();

    this.ctx.db.update(
      'subscriptions',
      { id: sub.id },
      { status: 'active', current_period_start: at, current_period_end: periodEnd },
    );

    const invoice = this.issueInvoice({
      lines: [
        {
          description: `${plan.name} — ${sub.billing_cycle === 'annual' ? 'Tahunan' : 'Bulanan'}`,
          amount: sub.billing_cycle === 'annual' ? plan.annualPrice : plan.monthlyPrice,
        },
      ],
      periodStart: at,
      periodEnd,
      // Hanya token referensi & label; tidak ada nomor kartu (SECURITY.md 16.3).
      gatewayRef: paymentToken,
      paymentMethodLabel,
    });

    this.ctx.log({
      action: 'subscription.trial_converted',
      module: 'Manajemen Langganan & Paket',
      objectType: 'subscription',
      objectId: sub.id,
      severity: 'notice',
      detail: { plan: sub.plan_code, invoiceId: invoice.id },
    });

    return invoice;
  }

  /** Pembatalan dengan penjelasan kapan akses berakhir & berapa lama data disimpan. */
  cancel(reason?: string): { accessEndsAt: string; dataRetainedUntil: string } {
    this.ctx.require('subscription:write', { module: 'Manajemen Langganan & Paket' });
    this.ctx.requireWritable();

    const sub = this.currentSubscription();
    this.ctx.db.update('subscriptions', { id: sub.id }, { cancel_at_period_end: 1 });

    const accessEndsAt = sub.current_period_end;
    const dataRetainedUntil = new Date(Date.parse(accessEndsAt) + 90 * 86_400_000).toISOString();

    this.ctx.log({
      action: 'subscription.canceled',
      module: 'Manajemen Langganan & Paket',
      objectType: 'subscription',
      objectId: sub.id,
      severity: 'critical',
      detail: { reason, accessEndsAt, dataRetainedUntil },
    });

    return { accessEndsAt, dataRetainedUntil };
  }

  /* ---------------- Billing & Faktur — PRD 6.28 ---------------- */

  listInvoices(): InvoiceView[] {
    this.ctx.require('billing:read', { module: 'Billing & Faktur' });
    this.ctx.requireModule('billing_invoice');
    return this.ctx.db
      .all<Omit<InvoiceView, 'lines'> & { lines_json: string }>('invoices', undefined, {
        orderBy: 'created_at DESC',
      })
      .map((i) => ({ ...i, lines: JSON.parse(i.lines_json) }));
  }

  issueInvoice(input: {
    lines: Array<{ description: string; amount: number }>;
    periodStart: string;
    periodEnd: string;
    gatewayRef?: string;
    paymentMethodLabel?: string;
    taxRate?: number;
  }): InvoiceView {
    const subtotal = input.lines.reduce((acc, l) => acc + l.amount, 0);
    const taxRate = input.taxRate ?? DEFAULT_TAX_RATE;
    const taxAmount = Math.round(subtotal * taxRate);
    const at = nowIso();
    const id = newId('inv');
    const sequence = this.ctx.db.count('invoices') + 1;
    const number = `INV/${at.slice(0, 4)}/${String(sequence).padStart(5, '0')}`;

    const row = {
      id,
      number,
      period_start: input.periodStart,
      period_end: input.periodEnd,
      subtotal,
      tax_rate: taxRate,
      tax_amount: taxAmount,
      total: subtotal + taxAmount,
      currency: 'IDR',
      status: input.gatewayRef ? 'paid' : 'open',
      due_at: new Date(Date.now() + GRACE_PERIOD_DAYS * 86_400_000).toISOString(),
      paid_at: input.gatewayRef ? at : null,
      gateway_ref: input.gatewayRef ?? null,
      payment_method_label: input.paymentMethodLabel ?? null,
      lines_json: JSON.stringify(input.lines),
      created_at: at,
    };
    this.ctx.db.insert('invoices', row);

    this.ctx.log({
      action: 'billing.invoice_issued',
      module: 'Billing & Faktur',
      objectType: 'invoice',
      objectId: id,
      objectLabel: number,
      detail: { total: row.total, status: row.status },
    });

    return { ...row, lines: input.lines } as InvoiceView;
  }

  /**
   * Webhook dari payment gateway. Tanda tangan DIVERIFIKASI untuk mencegah pemalsuan
   * status pembayaran (SECURITY.md 16.3).
   */
  handleGatewayWebhook(
    rawBody: string,
    signatureHeader: string,
    secret: string,
  ): { accepted: boolean; reasonKey?: string } {
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const provided = signatureHeader.replace(/^sha256=/, '');

    if (
      provided.length !== expected.length ||
      !timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'))
    ) {
      this.ctx.log({
        action: 'billing.webhook_rejected',
        module: 'Billing & Faktur',
        objectType: 'webhook',
        outcome: 'denied',
        severity: 'critical',
        detail: { reason: 'invalid_signature' },
      });
      return { accepted: false, reasonKey: 'error.webhook_signature_invalid' };
    }

    const payload = JSON.parse(rawBody) as { event: string; invoiceId: string; gatewayRef?: string };
    const invoice = this.ctx.db.get<{ id: string; number: string }>('invoices', { id: payload.invoiceId });
    if (!invoice) return { accepted: false, reasonKey: 'error.not_found' };

    if (payload.event === 'payment.succeeded') {
      this.ctx.db.update(
        'invoices',
        { id: payload.invoiceId },
        { status: 'paid', paid_at: nowIso(), gateway_ref: payload.gatewayRef ?? null },
      );
      const sub = this.currentSubscription();
      this.ctx.db.update('subscriptions', { id: sub.id }, { status: 'active' });
      this.ctx.db.rawRun("UPDATE tenants SET status = 'active' WHERE id = :tenant_id");
    } else if (payload.event === 'payment.failed') {
      this.ctx.db.update('invoices', { id: payload.invoiceId }, { status: 'failed' });
      this.applyDunning();
    }

    this.ctx.log({
      action: 'billing.webhook_processed',
      module: 'Billing & Faktur',
      objectType: 'invoice',
      objectId: payload.invoiceId,
      objectLabel: invoice.number,
      detail: { event: payload.event },
    });

    return { accepted: true };
  }

  /**
   * Penurunan akses bertahap akibat kegagalan pembayaran (PRD 6.28).
   * Urutan: peringatan → masa tenggang → mode BACA-SAJA → suspensi.
   * Data tenant TIDAK PERNAH langsung dihapus akibat tunggakan.
   */
  applyDunning(): { stage: 'grace' | 'read_only' | 'suspended' } {
    const overdue = this.ctx.db.all<{ id: string; due_at: string }>('invoices', { status: 'failed' });
    if (overdue.length === 0) return { stage: 'grace' };

    const oldestDue = Math.min(...overdue.map((i) => Date.parse(i.due_at)));
    const daysOverdue = (Date.now() - oldestDue) / 86_400_000;

    let stage: 'grace' | 'read_only' | 'suspended' = 'grace';
    let tenantStatus = 'past_due';
    if (daysOverdue > GRACE_PERIOD_DAYS * 2) {
      stage = 'suspended';
      tenantStatus = 'suspended';
    } else if (daysOverdue > GRACE_PERIOD_DAYS) {
      stage = 'read_only';
      tenantStatus = 'read_only';
    }

    this.ctx.db.rawRun('UPDATE tenants SET status = :status WHERE id = :tenant_id', { status: tenantStatus });

    this.ctx.log({
      action: 'billing.dunning_applied',
      module: 'Billing & Faktur',
      objectType: 'tenant',
      objectId: this.ctx.tenant.id,
      severity: stage === 'suspended' ? 'critical' : 'warning',
      detail: { stage, daysOverdue: Math.round(daysOverdue), overdueInvoices: overdue.length },
    });

    return { stage };
  }

  /** Faktur dalam bentuk teks siap cetak (PDF dirender frontend dari struktur ini). */
  invoiceDocument(invoiceId: string): {
    invoice: InvoiceView;
    tenant: { name: string; taxId: string | null };
    issuer: { name: string };
  } {
    this.ctx.require('billing:read', { module: 'Billing & Faktur', objectId: invoiceId });
    const row = this.ctx.db.get<Omit<InvoiceView, 'lines'> & { lines_json: string }>('invoices', {
      id: invoiceId,
    });
    if (!row) throw new NotFoundError();

    this.ctx.log({
      action: 'billing.invoice_downloaded',
      module: 'Billing & Faktur',
      objectType: 'invoice',
      objectId: invoiceId,
      objectLabel: row.number,
    });

    return {
      invoice: { ...row, lines: JSON.parse(row.lines_json) },
      tenant: { name: this.ctx.tenant.name, taxId: null },
      issuer: { name: 'Vantik Analytics' },
    };
  }
}
