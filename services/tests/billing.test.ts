/**
 * Langganan & Paket (PRD 6.27) dan Billing & Faktur (PRD 6.28).
 *
 * Domain 8 diklaim "Fungsional" di README, jadi klaim itu harus punya bukti. Yang diuji
 * di sini bukan hanya jalur bahagia, melainkan aturan yang punya konsekuensi uang dan
 * akses: arah upgrade/downgrade, pro-rata, kuota yang terlampaui saat turun paket,
 * verifikasi tanda tangan webhook, dan penurunan akses bertahap akibat tunggakan.
 *
 * SECURITY.md 16.3: sistem tidak pernah menyentuh data kartu — hanya token referensi.
 * Karena itu tidak ada satu pun nomor kartu di berkas ini, bahkan yang palsu.
 */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contextFor, createHarness, createUser, provisionTenant, type Harness } from './helpers.ts';
import { BillingService, DEFAULT_TAX_RATE, GRACE_PERIOD_DAYS } from '../src/billing-service/index.ts';
import { MeteringService } from '../src/metering-service/index.ts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../src/platform/errors.ts';
import type { RequestContext } from '../src/platform/context.ts';

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

afterEach(() => {
  harness.cleanup();
});

function billingFor(ctx: RequestContext): BillingService {
  return new BillingService(ctx, new MeteringService(ctx));
}

/** Tenant + konteks Super Admin pada paket tertentu. */
function setup(planCode: string): { ctx: RequestContext; billing: BillingService; tenantId: string } {
  const tenant = provisionTenant(harness, { planCode });
  const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
  return { ctx, billing: billingFor(ctx), tenantId: tenant.tenantId };
}

describe('Manajemen Langganan & Paket — PRD 6.27', () => {
  it('TC-BIL-01 — paket aktif memuat fitur & kuota paket, bukan daftar kosong', () => {
    const { billing } = setup('professional');
    const plan = billing.currentPlan();

    expect(plan.plan_code).toBe('professional');
    expect(plan.plan_name).toBeTruthy();
    expect(Object.keys(plan.features).length).toBeGreaterThan(0);
    expect(Object.keys(plan.quotas).length).toBeGreaterThan(0);
    expect(plan.current_period_end > plan.current_period_start).toBe(true);
  });

  it('TC-BIL-02 — katalog paket tersedia untuk perbandingan', () => {
    const { billing } = setup('starter');
    const plans = billing.availablePlans();
    expect(plans.length).toBeGreaterThanOrEqual(3);
    // Urutan naik agar UI dapat menampilkan jenjang tanpa mengurutkan sendiri.
    const orders = plans.map((p) => p.sortOrder);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it('TC-BIL-03 — upgrade berlaku SEGERA dan menyertakan pro-rata transparan', () => {
    const { billing } = setup('starter');
    const preview = billing.previewPlanChange('enterprise');

    expect(preview.effective).toBe('immediate');
    expect(preview.proration).not.toBeNull();
    // Transparan berarti ketiga angkanya terlihat, bukan hanya total yang harus dibayar.
    expect(preview.proration!.newCharge).toBeGreaterThan(0);
    expect(preview.proration!.unusedCredit).toBeGreaterThanOrEqual(0);
    expect(preview.proration!.dueNow).toBe(
      Math.max(0, preview.proration!.newCharge - preview.proration!.unusedCredit),
    );
  });

  it('TC-BIL-04 — downgrade berlaku awal siklus berikutnya dan TIDAK menagih pro-rata', () => {
    const { billing } = setup('enterprise');
    const preview = billing.previewPlanChange('starter');

    expect(preview.effective).toBe('next_cycle');
    expect(preview.proration).toBeNull();
  });

  it('TC-BIL-05 — paket tujuan yang tidak dikenal ditolak sebagai kesalahan masukan', () => {
    const { billing } = setup('starter');
    expect(() => billing.previewPlanChange('paket-fiktif')).toThrow(ValidationError);
  });

  it('TC-BIL-06 — upgrade langsung mengubah paket aktif dan menerbitkan faktur pro-rata', () => {
    const { billing } = setup('starter');

    const applied = billing.changePlan('enterprise');
    expect(applied.effective).toBe('immediate');
    expect(billing.currentPlan().plan_code).toBe('enterprise');
    expect(billing.currentPlan().pending_plan_code).toBeNull();

    const invoices = billing.listInvoices();
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.total).toBeGreaterThan(0);
  });

  it('TC-BIL-06b — upgrade dari paket berbayar mengkreditkan sisa periode di faktur', () => {
    // Starter berharga 0, jadi kreditnya memang nol; kredit hanya bermakna antar paket
    // BERBAYAR — di situlah pelanggan harus dapat melihat bahwa ia tidak dibayar dua kali.
    const { billing } = setup('professional');
    const applied = billing.changePlan('enterprise');

    expect(applied.proration!.unusedCredit).toBeGreaterThan(0);
    const lines = billing.listInvoices()[0]!.lines;
    expect(lines.some((l) => l.amount > 0)).toBe(true);
    expect(lines.find((l) => l.amount < 0)!.amount).toBe(-applied.proration!.unusedCredit);
    // Yang ditagih sekarang adalah selisihnya, bukan harga penuh paket baru.
    expect(applied.proration!.dueNow).toBeLessThan(applied.proration!.newCharge);
  });

  it('TC-BIL-07 — downgrade menyimpan paket tertunda tanpa mencabut akses sekarang', () => {
    const { billing } = setup('enterprise');
    billing.changePlan('starter');

    const plan = billing.currentPlan();
    // Akses hari ini TIDAK boleh berubah — pengguna sudah membayar periode berjalan.
    expect(plan.plan_code).toBe('enterprise');
    expect(plan.pending_plan_code).toBe('starter');
  });

  it('TC-BIL-08 — downgrade yang melampaui kuota paket tujuan diblokir sampai diakui', () => {
    const tenant = provisionTenant(harness, { planCode: 'enterprise' });
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const billing = billingFor(ctx);

    // Pengguna ditambah lewat jalur nyata, bukan INSERT rakitan, sehingga angka pemakaian
    // yang dinilai billing berasal dari data yang sama yang dibaca MeteringService.
    const starterUserQuota = billing.availablePlans().find((p) => p.code === 'starter')!.quotas.users;
    for (let i = 0; i < starterUserQuota + 2; i++) {
      createUser(harness, tenant.tenantId, `pengguna${i}@bil.test`, 'business_analyst');
    }

    const preview = billing.previewPlanChange('starter');
    expect(preview.blockingIssues.length).toBeGreaterThan(0);
    expect(preview.blockingIssues[0]!.current).toBeGreaterThan(preview.blockingIssues[0]!.newQuota);

    // Tanpa pengakuan eksplisit atas kehilangan, perubahan ditolak.
    expect(() => billing.changePlan('starter')).toThrow(ConflictError);

    // Dengan pengakuan, perubahan diteruskan — keputusan tetap milik pelanggan.
    expect(() => billing.changePlan('starter', { acknowledgeDowngradeLoss: true })).not.toThrow();
  });

  it('TC-BIL-09 — paket dengan kuota tak terbatas tidak pernah memblokir', () => {
    const { billing } = setup('starter');
    const preview = billing.previewPlanChange('enterprise');
    // Enterprise memakai -1 (tak terbatas); -1 tidak boleh dibaca sebagai "kuota 0".
    expect(preview.blockingIssues).toEqual([]);
  });

  it('TC-BIL-10 — konversi uji coba mengubah status tanpa menyentuh data, dan menerbitkan faktur', () => {
    const { ctx, billing } = setup('professional');
    // Tenant baru memang mulai sebagai `trialing` (tenant-service), jadi tidak ada yang
    // perlu disiapkan — justru itu keadaan yang ingin diuji.
    expect(billing.currentPlan().status).toBe('trialing');

    const datasetsBefore = ctx.db.count('dataset_catalog');
    const invoice = billing.convertTrial('tok_gateway_abc', 'VISA •••• 4242');

    expect(billing.currentPlan().status).toBe('active');
    expect(invoice.status).toBe('paid');
    expect(invoice.paid_at).not.toBeNull();
    expect(invoice.payment_method_label).toBe('VISA •••• 4242');
    // Data uji coba tidak boleh hilang saat konversi (PRD 6.27).
    expect(ctx.db.count('dataset_catalog')).toBe(datasetsBefore);
  });

  it('TC-BIL-11 — konversi uji coba ditolak bila langganan tidak sedang uji coba', () => {
    const { ctx, billing } = setup('professional');
    // Sudah aktif — konversi kedua tidak boleh menerbitkan faktur lagi.
    ctx.db.update('subscriptions', { id: billing.currentPlan().id }, { status: 'active' });

    expect(() => billing.convertTrial('tok_x', 'VISA')).toThrow(ConflictError);
    expect(billing.listInvoices()).toHaveLength(0);
  });

  it('TC-BIL-12 — pembatalan menyebutkan kapan akses berakhir DAN sampai kapan data disimpan', () => {
    const { billing } = setup('professional');
    const result = billing.cancel('terlalu mahal');

    // Pelanggan harus dapat merencanakan; "dibatalkan" saja tidak cukup informatif.
    expect(result.accessEndsAt).toBe(billing.currentPlan().current_period_end);
    expect(Date.parse(result.dataRetainedUntil)).toBeGreaterThan(Date.parse(result.accessEndsAt));
    expect(billing.currentPlan().cancel_at_period_end).toBe(1);
  });
});

describe('Billing & Faktur — PRD 6.28', () => {
  it('TC-BIL-13 — faktur menghitung PPN dan total secara eksplisit', () => {
    const { billing } = setup('professional');
    const invoice = billing.issueInvoice({
      lines: [
        { description: 'Langganan', amount: 1_000_000 },
        { description: 'Tambahan pengguna', amount: 250_000 },
      ],
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2026-06-30T23:59:59.000Z',
    });

    expect(invoice.subtotal).toBe(1_250_000);
    expect(invoice.tax_rate).toBe(DEFAULT_TAX_RATE);
    expect(invoice.tax_amount).toBe(Math.round(1_250_000 * DEFAULT_TAX_RATE));
    expect(invoice.total).toBe(invoice.subtotal + invoice.tax_amount);
    expect(invoice.currency).toBe('IDR');
  });

  it('TC-BIL-14 — tarif pajak dapat ditimpa (PRD Bagian 12 belum memfinalkannya)', () => {
    const { billing } = setup('professional');
    const invoice = billing.issueInvoice({
      lines: [{ description: 'Langganan', amount: 1_000_000 }],
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2026-06-30T23:59:59.000Z',
      taxRate: 0,
    });
    expect(invoice.tax_amount).toBe(0);
    expect(invoice.total).toBe(1_000_000);
  });

  it('TC-BIL-15 — nomor faktur berurutan dan tidak pernah terpakai dua kali', () => {
    const { billing } = setup('professional');
    const numbers = [1, 2, 3].map(
      (n) =>
        billing.issueInvoice({
          lines: [{ description: `Baris ${n}`, amount: 100_000 }],
          periodStart: '2026-06-01T00:00:00.000Z',
          periodEnd: '2026-06-30T23:59:59.000Z',
        }).number,
    );
    expect(new Set(numbers).size).toBe(3);
    expect(numbers.every((n) => /^INV\/\d{4}\/\d{5}$/.test(n))).toBe(true);
  });

  it('TC-BIL-16 — faktur tanpa pembayaran berstatus open dengan jatuh tempo masa tenggang', () => {
    const { billing } = setup('professional');
    const invoice = billing.issueInvoice({
      lines: [{ description: 'Langganan', amount: 500_000 }],
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2026-06-30T23:59:59.000Z',
    });

    expect(invoice.status).toBe('open');
    expect(invoice.paid_at).toBeNull();
    const daysUntilDue = (Date.parse(invoice.due_at) - Date.now()) / 86_400_000;
    expect(Math.round(daysUntilDue)).toBe(GRACE_PERIOD_DAYS);
  });

  it('TC-BIL-17 — dokumen faktur memuat identitas penerbit & tenant untuk dicetak', () => {
    const { billing } = setup('professional');
    const issued = billing.issueInvoice({
      lines: [{ description: 'Langganan', amount: 500_000 }],
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2026-06-30T23:59:59.000Z',
    });

    const doc = billing.invoiceDocument(issued.id);
    expect(doc.invoice.number).toBe(issued.number);
    expect(doc.invoice.lines).toHaveLength(1);
    expect(doc.tenant.name).toBeTruthy();
    expect(doc.issuer.name).toBeTruthy();
  });

  it('TC-BIL-18 — faktur yang tidak ada menghasilkan 404, bukan dokumen kosong', () => {
    const { billing } = setup('professional');
    expect(() => billing.invoiceDocument('inv_tidak_ada')).toThrow(NotFoundError);
  });
});

describe('Webhook payment gateway — SECURITY.md 16.3', () => {
  const SECRET = 'rahasia-webhook-uji';

  function sign(body: string, secret = SECRET): string {
    return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  }

  it('TC-BIL-19 — tanda tangan sah menandai faktur lunas dan mengaktifkan kembali tenant', () => {
    const { ctx, billing } = setup('professional');
    const invoice = billing.issueInvoice({
      lines: [{ description: 'Langganan', amount: 500_000 }],
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2026-06-30T23:59:59.000Z',
    });
    ctx.db.rawRun("UPDATE tenants SET status = 'past_due' WHERE id = :tenant_id");

    const body = JSON.stringify({ event: 'payment.succeeded', invoiceId: invoice.id, gatewayRef: 'ref_123' });
    expect(billing.handleGatewayWebhook(body, sign(body), SECRET)).toEqual({ accepted: true });

    const stored = billing.listInvoices().find((i) => i.id === invoice.id)!;
    expect(stored.status).toBe('paid');
    expect(stored.paid_at).not.toBeNull();

    const tenant = harness.db.prepare('SELECT status FROM tenants WHERE id = ?').get(ctx.tenant.id) as { status: string };
    expect(tenant.status).toBe('active');
  });

  it('TC-BIL-20 — tanda tangan palsu DITOLAK dan tidak mengubah status pembayaran', () => {
    const { billing } = setup('professional');
    const invoice = billing.issueInvoice({
      lines: [{ description: 'Langganan', amount: 500_000 }],
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2026-06-30T23:59:59.000Z',
    });

    const body = JSON.stringify({ event: 'payment.succeeded', invoiceId: invoice.id });
    const result = billing.handleGatewayWebhook(body, sign(body, 'rahasia-yang-salah'), SECRET);

    expect(result.accepted).toBe(false);
    expect(result.reasonKey).toBe('error.webhook_signature_invalid');
    // Status pembayaran adalah uang: pemalsuan tidak boleh menembus satu langkah pun.
    expect(billing.listInvoices().find((i) => i.id === invoice.id)!.status).toBe('open');
  });

  it('TC-BIL-21 — tanda tangan dengan panjang berbeda ditolak tanpa melempar', () => {
    const { billing } = setup('professional');
    const body = JSON.stringify({ event: 'payment.succeeded', invoiceId: 'inv_x' });
    // timingSafeEqual melempar bila panjang berbeda; penjaga panjang harus mendahuluinya.
    expect(billing.handleGatewayWebhook(body, 'sha256=pendek', SECRET)).toEqual({
      accepted: false,
      reasonKey: 'error.webhook_signature_invalid',
    });
  });

  it('TC-BIL-22 — penolakan tanda tangan tercatat sebagai insiden di Log Aktivitas', () => {
    const { ctx, billing } = setup('professional');
    const body = JSON.stringify({ event: 'payment.succeeded', invoiceId: 'inv_x' });
    billing.handleGatewayWebhook(body, sign(body, 'salah'), SECRET);

    const entries = harness.db
      .prepare(
        "SELECT action, outcome, severity FROM auditdb.audit_log WHERE tenant_id = ? AND action = 'billing.webhook_rejected'",
      )
      .all(ctx.tenant.id) as Array<{ action: string; outcome: string; severity: string }>;

    expect(entries).toHaveLength(1);
    expect(entries[0]!.outcome).toBe('denied');
    expect(entries[0]!.severity).toBe('critical');
  });

  it('TC-BIL-23 — webhook untuk faktur yang tidak dikenal ditolak, bukan diterima diam-diam', () => {
    const { billing } = setup('professional');
    const body = JSON.stringify({ event: 'payment.succeeded', invoiceId: 'inv_tidak_ada' });
    expect(billing.handleGatewayWebhook(body, sign(body), SECRET)).toEqual({
      accepted: false,
      reasonKey: 'error.not_found',
    });
  });

  it('TC-BIL-24 — pembayaran gagal menandai faktur failed dan memulai dunning', () => {
    const { ctx, billing } = setup('professional');
    const invoice = billing.issueInvoice({
      lines: [{ description: 'Langganan', amount: 500_000 }],
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2026-06-30T23:59:59.000Z',
    });

    const body = JSON.stringify({ event: 'payment.failed', invoiceId: invoice.id });
    expect(billing.handleGatewayWebhook(body, sign(body), SECRET)).toEqual({ accepted: true });

    expect(billing.listInvoices().find((i) => i.id === invoice.id)!.status).toBe('failed');
    const tenant = harness.db.prepare('SELECT status FROM tenants WHERE id = ?').get(ctx.tenant.id) as { status: string };
    expect(tenant.status).toBe('past_due');
  });
});

describe('Dunning — penurunan akses bertahap (PRD 6.28)', () => {
  /** Menerbitkan faktur gagal dengan jatuh tempo sejumlah hari di masa lalu. */
  function overdueInvoice(ctx: RequestContext, billing: BillingService, daysAgo: number): void {
    const invoice = billing.issueInvoice({
      lines: [{ description: 'Langganan', amount: 500_000 }],
      periodStart: '2026-01-01T00:00:00.000Z',
      periodEnd: '2026-01-31T23:59:59.000Z',
    });
    ctx.db.update(
      'invoices',
      { id: invoice.id },
      { status: 'failed', due_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString() },
    );
  }

  it('TC-BIL-25 — tanpa faktur gagal, tahapnya grace dan tidak ada perubahan status', () => {
    const { billing } = setup('professional');
    expect(billing.applyDunning()).toEqual({ stage: 'grace' });
  });

  it('TC-BIL-26 — dalam masa tenggang: status past_due, akses masih penuh', () => {
    const { ctx, billing } = setup('professional');
    overdueInvoice(ctx, billing, 3);

    expect(billing.applyDunning()).toEqual({ stage: 'grace' });
    const tenant = harness.db.prepare('SELECT status FROM tenants WHERE id = ?').get(ctx.tenant.id) as { status: string };
    expect(tenant.status).toBe('past_due');
  });

  it('TC-BIL-27 — melewati masa tenggang: mode BACA-SAJA, data tetap utuh', () => {
    const { ctx, billing } = setup('professional');
    overdueInvoice(ctx, billing, GRACE_PERIOD_DAYS + 2);

    expect(billing.applyDunning()).toEqual({ stage: 'read_only' });
    const tenant = harness.db.prepare('SELECT status FROM tenants WHERE id = ?').get(ctx.tenant.id) as { status: string };
    expect(tenant.status).toBe('read_only');
    // Tunggakan tidak pernah menghapus data pelanggan.
    expect(ctx.db.count('invoices')).toBeGreaterThan(0);
  });

  it('TC-BIL-28 — tunggakan berkepanjangan: suspensi, tetapi data TIDAK dihapus', () => {
    const { ctx, billing } = setup('professional');
    overdueInvoice(ctx, billing, GRACE_PERIOD_DAYS * 2 + 5);

    expect(billing.applyDunning()).toEqual({ stage: 'suspended' });
    const tenant = harness.db.prepare('SELECT status FROM tenants WHERE id = ?').get(ctx.tenant.id) as { status: string };
    expect(tenant.status).toBe('suspended');
    expect(ctx.db.count('invoices')).toBeGreaterThan(0);
  });

  it('TC-BIL-29 — tahap ditentukan faktur TERTUNGGAK PALING LAMA, bukan yang terbaru', () => {
    const { ctx, billing } = setup('professional');
    overdueInvoice(ctx, billing, GRACE_PERIOD_DAYS * 2 + 10); // lama
    overdueInvoice(ctx, billing, 1); // baru

    // Faktur baru tidak boleh "menyegarkan" tunggakan lama.
    expect(billing.applyDunning()).toEqual({ stage: 'suspended' });
  });
});

describe('Izin & mode baca-saja pada billing', () => {
  it('TC-BIL-30 — peran tanpa subscription:read tidak dapat melihat paket', () => {
    const tenant = provisionTenant(harness, { planCode: 'professional' });
    const ctx = contextFor(harness, tenant.tenantId, ['business_analyst']);
    expect(() => billingFor(ctx).currentPlan()).toThrow(ForbiddenError);
  });

  it('TC-BIL-31 — peran tanpa billing:read tidak dapat melihat faktur', () => {
    const tenant = provisionTenant(harness, { planCode: 'professional' });
    const ctx = contextFor(harness, tenant.tenantId, ['business_analyst']);
    expect(() => billingFor(ctx).listInvoices()).toThrow(ForbiddenError);
  });

  it('TC-BIL-32 — Auditor dapat membaca faktur tetapi tidak mengubah paket', () => {
    const tenant = provisionTenant(harness, { planCode: 'professional' });
    const auditorCtx = contextFor(harness, tenant.tenantId, ['auditor']);
    // Auditor bertugas memeriksa; kemampuan mengubah langganan bukan bagian tugasnya.
    expect(() => billingFor(auditorCtx).changePlan('enterprise')).toThrow(ForbiddenError);
  });

  it('TC-BIL-33 — tenant dalam mode baca-saja tidak dapat mengubah langganan', () => {
    const tenant = provisionTenant(harness, { planCode: 'professional' });
    harness.db.prepare("UPDATE tenants SET status = 'read_only' WHERE id = ?").run(tenant.tenantId);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);

    expect(() => billingFor(ctx).changePlan('enterprise')).toThrow();
    expect(() => billingFor(ctx).cancel()).toThrow();
  });
});
