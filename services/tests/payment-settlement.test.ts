/**
 * Wewenang menyatakan sebuah faktur DIBAYAR.
 *
 * Berkas ini menutup cacat yang membuat seluruh paywall tidak berarti: `renew()` menerima
 * token pembayaran berupa string apa saja, menandai fakturnya sendiri lunas, lalu memajukan
 * masa berlaku. Pemegang `subscription:write` — yaitu pelanggan sendiri — dapat memperpanjang
 * ruang kerjanya gratis, berulang kali, tanpa satu rupiah pun masuk dan tanpa satu pun
 * kesalahan tercatat. Mematikan uji coba gratis tidak menolong sedikit pun selama pintu ini
 * terbuka.
 *
 * Yang dibuktikan di sini:
 *
 *  1. **Pelanggan tidak dapat menyatakan pembayarannya sendiri** (TC-PAY-04). Ini
 *     inti perubahannya, dan ditegakkan lewat penolakan izin — `*:*` pun kalah.
 *  2. **Meminta perpanjangan TIDAK memajukan masa berlaku** (TC-PAY-01/02). Yang keluar
 *     hanyalah faktur; ruang kerja tetap terkunci sampai uangnya tercatat.
 *  3. **Pencatatan wajib menyertakan referensi dan hanya berlaku sekali** (TC-PAY-06/07).
 *     Dua kali catat berarti dua siklus untuk satu uang yang masuk.
 *  4. **Webhook tanpa rahasia DITOLAK** (TC-PAY-10). Tanpa itu, tanda tangan yang sah
 *     adalah HMAC dengan kunci kosong — yang dapat dihitung siapa pun.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  createHarness,
  contextFor,
  provisionTenant,
  type Harness,
  type TenantFixture,
} from './helpers.ts';
import { BillingService, periodAfterPayment, periodEndFor } from '../src/billing-service/index.ts';
import { PlatformBillingService } from '../src/billing-service/settlement.ts';
import { MeteringService } from '../src/metering-service/index.ts';
import { loadFeatureFlags } from '../src/platform/context.ts';
import { ConflictError, ForbiddenError, ValidationError } from '../src/platform/errors.ts';
import { STANDARD_ROLE_BY_CODE } from '../src/platform/rbac.ts';

let harness: Harness;
let tenant: TenantFixture;

beforeEach(() => {
  harness = createHarness();
  tenant = provisionTenant(harness, { planCode: 'professional', trialDays: 30 });
});

afterEach(() => harness.cleanup());

function pelanggan(fixture: TenantFixture = tenant): BillingService {
  const ctx = contextFor(harness, fixture.tenantId, ['super_admin'], { mfaEnrolled: true });
  return new BillingService(ctx, new MeteringService(ctx));
}

function platform(): PlatformBillingService {
  return new PlatformBillingService(harness.db, harness.audit);
}

function operatorCtx(fixture: TenantFixture = tenant) {
  return contextFor(harness, fixture.tenantId, ['platform_operator'], { mfaEnrolled: true });
}

function setPeriod(fixture: TenantFixture, changes: Record<string, string | number | null>): void {
  const columns = Object.keys(changes)
    .map((c) => `${c} = ?`)
    .join(', ');
  harness.db
    .prepare(`UPDATE subscriptions SET ${columns} WHERE tenant_id = ?`)
    .run(...Object.values(changes), fixture.tenantId);
}

function subRow(fixture: TenantFixture = tenant): Record<string, string | number | null> {
  return harness.db.prepare('SELECT * FROM subscriptions WHERE tenant_id = ?').get(fixture.tenantId) as Record<
    string,
    string | number | null
  >;
}

function tenantStatus(fixture: TenantFixture = tenant): string {
  return (
    harness.db.prepare('SELECT status FROM tenants WHERE id = ?').get(fixture.tenantId) as { status: string }
  ).status;
}

function hariLalu(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** Masa berlaku sudah habis, dan pernah dibayar — pelanggan yang menunggak. */
function kedaluwarsakan(fixture: TenantFixture = tenant, sejakHari = 1): void {
  setPeriod(fixture, {
    status: 'active',
    trial_ends_at: null,
    current_period_end: hariLalu(sejakHari),
    activated_at: hariLalu(400),
  });
}

/* ================= Permintaan perpanjangan ================= */

describe('Permintaan perpanjangan', () => {
  it('TC-PAY-01 — menghasilkan faktur yang BELUM dibayar', () => {
    kedaluwarsakan();
    const invoice = pelanggan().requestRenewal();

    expect(invoice.status).not.toBe('paid');
    expect(invoice.paid_at).toBeNull();
    expect(invoice.total).toBeGreaterThan(0);
  });

  it('TC-PAY-02 — TIDAK memajukan masa berlaku, dan ruang kerja tetap terkunci', () => {
    kedaluwarsakan();
    const sebelum = subRow();

    pelanggan().requestRenewal();

    const sesudah = subRow();
    // Inilah cacat yang ditutup: dahulu panggilan ini sendiri yang memajukan periode.
    expect(sesudah.current_period_end).toBe(sebelum.current_period_end);
    expect(sesudah.status).toBe(sebelum.status);
    expect(loadFeatureFlags(harness.db, tenant.tenantId, tenantStatus()).readOnly).toBe(true);
  });

  it('TC-PAY-03 — menekan dua kali tidak menghasilkan dua tagihan', () => {
    kedaluwarsakan();
    const pertama = pelanggan().requestRenewal();
    const kedua = pelanggan().requestRenewal();

    expect(kedua.id).toBe(pertama.id);
    const jumlah = harness.db
      .prepare("SELECT COUNT(*) AS n FROM invoices WHERE tenant_id = ? AND kind = 'renewal'")
      .get(tenant.tenantId) as { n: number };
    expect(jumlah.n).toBe(1);
  });
});

/* ================= Pemisahan wewenang ================= */

describe('Wewenang menyatakan lunas', () => {
  it('TC-PAY-04 — Super Admin tenant TIDAK dapat mencatat pembayarannya sendiri', () => {
    kedaluwarsakan();
    const invoice = pelanggan().requestRenewal();
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin'], { mfaEnrolled: true });

    // Pemilik ruang kerja memegang `*:*`; yang menghentikannya adalah PENOLAKAN eksplisit.
    expect(ctx.can('subscription:write')).toBe(true);
    expect(ctx.can('billing:settle')).toBe(false);
    expect(() =>
      platform().recordPayment(ctx, invoice.id, { reference: 'REF-PALSU', methodLabel: 'ngaku bayar' }),
    ).toThrow(ForbiddenError);

    // Dan tidak ada apa pun yang berubah karena percobaan itu.
    expect(Date.parse(String(subRow().current_period_end))).toBeLessThan(Date.now());
    expect(loadFeatureFlags(harness.db, tenant.tenantId, tenantStatus()).readOnly).toBe(true);
  });

  it('TC-PAY-04b — pelanggan tidak dapat MEMBACA antrean faktur lintas tenant', () => {
    provisionTenant(harness, { slug: 'tenantlainx', planCode: 'starter', trialDays: 0 });
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin'], { mfaEnrolled: true });

    // `billing:read` dipegang Super Admin untuk membaca fakturnya SENDIRI. Memakainya
    // sebagai gerbang antrean lintas tenant akan membocorkan nama, paket, dan nilai
    // tagihan seluruh pelanggan lain lewat pintu yang tampak sekadar "daftar".
    expect(ctx.can('billing:read')).toBe(true);
    expect(() => platform().listUnpaid(ctx)).toThrow(ForbiddenError);
  });

  it('TC-PAY-05 — penolakan itu struktural, bukan kebetulan urutan izin', () => {
    const superAdmin = STANDARD_ROLE_BY_CODE.get('super_admin')!;
    const operator = STANDARD_ROLE_BY_CODE.get('platform_operator')!;

    // Terbaca langsung dari definisi peran: yang berutang ditolak, sisi platform diberi.
    expect(superAdmin.permissions).toContain('*:*');
    expect(superAdmin.denials).toContain('billing:settle');
    expect(operator.permissions).toContain('billing:settle');
  });

  it('TC-PAY-06 — operator platform mencatat pembayaran dan masa berlaku maju', () => {
    kedaluwarsakan();
    const invoice = pelanggan().requestRenewal();

    const hasil = platform().recordPayment(operatorCtx(), invoice.id, {
      reference: 'MUT-BCA-99871',
      methodLabel: 'Transfer BCA',
    });

    expect(hasil.status).toBe('paid');
    const sub = subRow();
    expect(sub.status).toBe('active');
    expect(sub.lapsed_at).toBeNull();
    expect(Date.parse(String(sub.current_period_end))).toBeGreaterThan(Date.now());
    expect(loadFeatureFlags(harness.db, tenant.tenantId, tenantStatus()).readOnly).toBe(false);
  });

  it('TC-PAY-07 — pencatatan tanpa nomor referensi ditolak', () => {
    kedaluwarsakan();
    const invoice = pelanggan().requestRenewal();

    // Tanpa referensi, pencatatan tidak dapat dicocokkan dengan mutasi rekening — jejak
    // audit yang tidak dapat diperiksa hanyalah catatan yang menenangkan.
    expect(() =>
      platform().recordPayment(operatorCtx(), invoice.id, { reference: '   ', methodLabel: 'Transfer' }),
    ).toThrow(ValidationError);
    expect(Date.parse(String(subRow().current_period_end))).toBeLessThan(Date.now());
  });

  it('TC-PAY-08 — satu faktur tidak dapat dicatat dua kali', () => {
    kedaluwarsakan();
    const invoice = pelanggan().requestRenewal();
    platform().recordPayment(operatorCtx(), invoice.id, { reference: 'MUT-1', methodLabel: 'Transfer' });
    const setelahSekali = subRow().current_period_end;

    expect(() =>
      platform().recordPayment(operatorCtx(), invoice.id, { reference: 'MUT-1', methodLabel: 'Transfer' }),
    ).toThrow(ConflictError);
    // Dua kali catat akan berarti dua siklus untuk satu uang yang masuk.
    expect(subRow().current_period_end).toBe(setelahSekali);
  });

  it('TC-PAY-09 — pencatatan tercatat di Log Aktivitas tenant yang dibayar', () => {
    kedaluwarsakan();
    const invoice = pelanggan().requestRenewal();
    platform().recordPayment(operatorCtx(), invoice.id, {
      reference: 'MUT-BCA-55512',
      methodLabel: 'Transfer BCA',
    });

    const jejak = harness.audit.operatorTrail(tenant.tenantId);
    const entri = jejak.filter((e) => e.action === 'billing.payment_recorded');
    expect(entri.length).toBe(1);
    // Dicatat terhadap tenant yang DIBAYAR — bukan tenant operatornya — dan ditandai
    // sebagai akses operator, sehingga tenant dapat melihatnya sendiri (SECURITY.md 16.2).
    expect(entri[0]!.operator_access).toBe(1);
    expect(String(entri[0]!.detail_json)).toContain('MUT-BCA-55512');
  });
});

/* ================= Aktivasi pertama ================= */

describe('Pembayaran pertama', () => {
  it('TC-PAY-10 — ruang kerja yang belum pernah aktif terbuka setelah dibayar', () => {
    const baru = provisionTenant(harness, { slug: 'belumbayarx', planCode: 'starter', trialDays: 0 });
    expect(loadFeatureFlags(harness.db, baru.tenantId, tenantStatus(baru)).readOnlyReason).toBe(
      'subscription_unpaid',
    );

    const invoice = pelanggan(baru).requestRenewal();
    // Antrean operator menandainya sebagai pembayaran PERTAMA, bukan perpanjangan.
    const antrean = platform().listUnpaid(operatorCtx(baru));
    expect(antrean.find((i) => i.id === invoice.id)?.first_payment).toBe(1);

    platform().recordPayment(operatorCtx(baru), invoice.id, {
      reference: 'MUT-PERTAMA-1',
      methodLabel: 'Transfer',
    });

    const sub = subRow(baru);
    expect(sub.activated_at).not.toBeNull();
    const flags = loadFeatureFlags(harness.db, baru.tenantId, tenantStatus(baru));
    expect(flags.readOnly).toBe(false);
    expect(flags.readOnlyReason).toBeNull();
  });

  it('TC-PAY-11 — sesudah aktif, blokir berikutnya berbunyi kedaluwarsa', () => {
    const baru = provisionTenant(harness, { slug: 'sudahbayarx', planCode: 'starter', trialDays: 0 });
    const invoice = pelanggan(baru).requestRenewal();
    platform().recordPayment(operatorCtx(baru), invoice.id, { reference: 'MUT-2', methodLabel: 'Transfer' });

    setPeriod(baru, { current_period_end: hariLalu(2) });

    // `activated_at` sudah terisi, jadi pesannya berpindah dari "belum aktif" ke
    // "kedaluwarsa" — dan tombolnya dari Aktifkan ke Perpanjang.
    expect(loadFeatureFlags(harness.db, baru.tenantId, tenantStatus(baru)).readOnlyReason).toBe(
      'subscription_expired',
    );
  });
});

/* ================= Webhook gateway ================= */

describe('Webhook payment gateway', () => {
  it('TC-PAY-12 — webhook DITOLAK bila rahasianya belum dikonfigurasi', () => {
    kedaluwarsakan();
    const invoice = pelanggan().requestRenewal();
    const body = JSON.stringify({ event: 'payment.succeeded', invoiceId: invoice.id });
    // Tanda tangan yang "sah" untuk rahasia kosong dapat dihitung siapa pun yang tahu
    // rahasianya belum diisi — jalur ini menyatakan faktur lunas, jadi harus fail secure.
    const tandaTangan = createHmac('sha256', '').update(body).digest('hex');

    const hasil = pelanggan().handleGatewayWebhook(body, tandaTangan, '');

    expect(hasil.accepted).toBe(false);
    expect(hasil.reasonKey).toBe('error.payment_webhook_not_configured');
    expect(Date.parse(String(subRow().current_period_end))).toBeLessThan(Date.now());
  });

  it('TC-PAY-13 — webhook bertanda tangan sah memajukan masa berlaku', () => {
    kedaluwarsakan();
    const invoice = pelanggan().requestRenewal();
    const secret = 'rahasia-webhook-uji';
    const body = JSON.stringify({ event: 'payment.succeeded', invoiceId: invoice.id, gatewayRef: 'GW-1' });

    const hasil = pelanggan().handleGatewayWebhook(
      body,
      createHmac('sha256', secret).update(body).digest('hex'),
      secret,
    );

    expect(hasil.accepted).toBe(true);
    expect(subRow().status).toBe('active');
    expect(Date.parse(String(subRow().current_period_end))).toBeGreaterThan(Date.now());
  });

  it('TC-PAY-14 — tanda tangan salah tetap ditolak', () => {
    kedaluwarsakan();
    const invoice = pelanggan().requestRenewal();
    const body = JSON.stringify({ event: 'payment.succeeded', invoiceId: invoice.id });

    const hasil = pelanggan().handleGatewayWebhook(body, 'a'.repeat(64), 'rahasia-webhook-uji');

    expect(hasil.accepted).toBe(false);
    expect(Date.parse(String(subRow().current_period_end))).toBeLessThan(Date.now());
  });
});

/* ================= Aturan periode dipakai bersama ================= */

describe('Perhitungan periode', () => {
  it('TC-PAY-15 — dua jalur pembayaran memakai aturan yang sama', () => {
    const cepat = periodAfterPayment(
      { period_start: '2026-08-01T00:00:00.000Z', period_end: '2026-09-01T00:00:00.000Z' },
      'monthly',
      '2026-07-30T00:00:00.000Z',
    );
    // Dibayar sebelum periodenya berakhir: tidak ada hari yang hangus.
    expect(cepat).toEqual({ start: '2026-08-01T00:00:00.000Z', end: '2026-09-01T00:00:00.000Z' });

    const telat = periodAfterPayment(
      { period_start: '2026-01-01T00:00:00.000Z', period_end: '2026-02-01T00:00:00.000Z' },
      'monthly',
      '2026-07-30T00:00:00.000Z',
    );
    // Terlambat lebih dari satu siklus: dihitung ulang dari tanggal pembayaran, supaya
    // pelanggan tidak membayar untuk periode yang sudah lewat lalu tetap terkunci.
    expect(telat.start).toBe('2026-07-30T00:00:00.000Z');
    expect(telat.end).toBe(periodEndFor('2026-07-30T00:00:00.000Z', 'monthly'));
    expect(Date.parse(telat.end)).toBeGreaterThan(Date.parse('2026-07-30T00:00:00.000Z'));
  });
});
