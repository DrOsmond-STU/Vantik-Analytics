/**
 * Siklus berlangganan 1 / 3 / 6 / 12 bulan, dan penghentian otomatis saat masa berlaku
 * habis (PRD 6.27 & 6.28).
 *
 * Dua hal yang paling penting dibuktikan di berkas ini:
 *
 *  1. **Blokirnya tidak bergantung penjadwal.** TC-SUB-07 menjalankan penulisan pada
 *     tenant yang masa berlakunya lewat TANPA pernah memanggil pekerjaan berkala.
 *     Kalau blokir hanya berlaku setelah penjadwal berjalan, langganan kedaluwarsa
 *     tetap dapat menulis di shared hosting yang me-recycle proses idle.
 *  2. **Ada jalan keluarnya.** TC-SUB-16 memperpanjang justru ketika ruang kerja sedang
 *     terkunci. Blokir yang mengunci pintu perbaikannya sendiri bukan kontrol, melainkan
 *     jebakan.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  createHarness,
  contextFor,
  provisionTenant,
  syntheticCsv,
  type Harness,
  type TenantFixture,
} from './helpers.ts';
import { BillingService, GRACE_PERIOD_DAYS, periodEndFor } from '../src/billing-service/index.ts';
import { MeteringService } from '../src/metering-service/index.ts';
import { NotificationOutbox } from '../src/platform/outbox.ts';
import { addMonths } from '../src/platform/db.ts';
import {
  BILLING_CYCLES,
  PLAN_CATALOG,
  cycleMonths,
  isBillingCycle,
  planPrice,
} from '../src/platform/featureFlags.ts';
import { DatasetService } from '../src/data-platform-service/datasets.ts';
import { AppError } from '../src/platform/errors.ts';

let harness: Harness;
let tenant: TenantFixture;
let outbox: NotificationOutbox;

beforeEach(() => {
  harness = createHarness();
  tenant = provisionTenant(harness, { planCode: 'professional' });
  outbox = new NotificationOutbox(harness.db);
});

afterEach(() => harness.cleanup());

/** Layanan billing dengan konteks yang DIBACA ULANG dari basis data. */
function billing(fixture: TenantFixture = tenant): BillingService {
  const ctx = contextFor(harness, fixture.tenantId, ['super_admin']);
  return new BillingService(ctx, new MeteringService(ctx), outbox);
}

/** Menggeser masa berlaku langganan ke masa lalu/depan tanpa melewati layanan. */
function setPeriod(fixture: TenantFixture, changes: Record<string, string | number | null>): void {
  const columns = Object.keys(changes)
    .map((c) => `${c} = ?`)
    .join(', ');
  harness.db
    .prepare(`UPDATE subscriptions SET ${columns} WHERE tenant_id = ?`)
    .run(...Object.values(changes), fixture.tenantId);
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function subscriptionRow(fixture: TenantFixture = tenant): Record<string, string | number | null> {
  return harness.db.prepare('SELECT * FROM subscriptions WHERE tenant_id = ?').get(fixture.tenantId) as Record<
    string,
    string | number | null
  >;
}

function tenantStatus(fixture: TenantFixture = tenant): string {
  return (harness.db.prepare('SELECT status FROM tenants WHERE id = ?').get(fixture.tenantId) as { status: string })
    .status;
}

let unggahanKe = 0;

/** Penulisan nyata lewat modul fungsional — bukan tiruan `requireWritable()`. */
function unggah(fixture: TenantFixture): void {
  const ctx = contextFor(harness, fixture.tenantId, ['super_admin']);
  new DatasetService(ctx).upload({
    filename: `berkas${++unggahanKe}.csv`,
    content: Buffer.from(syntheticCsv({ rows: 5 })),
  });
}

/**
 * Mencoba menulis dan mengembalikan kesalahannya (atau null bila berhasil).
 *
 * Sengaja lewat `DatasetService.upload()`, bukan memanggil `requireWritable()`
 * langsung: yang perlu dibuktikan adalah blokirnya benar-benar sampai ke jalur yang
 * dipakai pengguna, bukan bahwa sebuah fungsi penjaga melempar bila dipanggil sendiri.
 */
function cobaMenulis(fixture: TenantFixture = tenant): AppError | null {
  try {
    unggah(fixture);
    return null;
  } catch (error) {
    return error as AppError;
  }
}

/* ================= Katalog siklus & harga ================= */

describe('Katalog siklus berlangganan', () => {
  it('TC-SUB-01 — empat siklus ditawarkan: 1, 3, 6, dan 12 bulan', () => {
    expect(BILLING_CYCLES.map((c) => c.code)).toEqual(['monthly', 'quarterly', 'semiannual', 'annual']);
    expect(BILLING_CYCLES.map((c) => c.months)).toEqual([1, 3, 6, 12]);
  });

  it('TC-SUB-02 — harga tahunan hasil hitung PERSIS sama dengan angka di katalog paket', () => {
    // Invarian ini yang membuat katalog dan kalkulator tidak dapat menyimpang diam-diam:
    // kalau seseorang mengubah `annualPrice` tanpa mengubah diskon (atau sebaliknya),
    // uji ini gagal alih-alih pelanggan ditagih angka yang berbeda dari yang dipajang.
    for (const plan of PLAN_CATALOG) {
      expect(planPrice(plan, 'annual'), `paket ${plan.code}`).toBe(plan.annualPrice);
    }
  });

  it('TC-SUB-03 — harga tiap siklus = harga bulanan × jumlah bulan × (1 − diskon)', () => {
    const pro = PLAN_CATALOG.find((p) => p.code === 'professional')!;
    expect(planPrice(pro, 'monthly')).toBe(4_500_000);
    expect(planPrice(pro, 'quarterly')).toBe(Math.round(4_500_000 * 3 * 0.95));
    expect(planPrice(pro, 'semiannual')).toBe(Math.round(4_500_000 * 6 * 0.9));
    expect(planPrice(pro, 'annual')).toBe(45_000_000);

    // Semakin panjang siklus, semakin murah per bulannya — kalau tidak, tidak ada
    // alasan komersial memilih siklus panjang.
    const perBulan = BILLING_CYCLES.map((c) => planPrice(pro, c.code) / c.months);
    expect([...perBulan].sort((a, b) => b - a)).toEqual(perBulan);
  });

  it('TC-SUB-04 — paket gratis tetap nol rupiah di seluruh siklus', () => {
    const starter = PLAN_CATALOG.find((p) => p.code === 'starter')!;
    for (const cycle of BILLING_CYCLES) expect(planPrice(starter, cycle.code)).toBe(0);
  });

  it('TC-SUB-05 — siklus tak dikenal ditolak penjaga tipe, bukan diterima diam-diam', () => {
    expect(isBillingCycle('monthly')).toBe(true);
    expect(isBillingCycle('semiannual')).toBe(true);
    expect(isBillingCycle('weekly')).toBe(false);
    expect(isBillingCycle('')).toBe(false);
    expect(isBillingCycle(12)).toBe(false);
  });
});

/* ================= Penanggalan periode ================= */

describe('Perhitungan akhir periode', () => {
  it('TC-SUB-06 — memakai bulan kalender, bukan kelipatan 30 hari', () => {
    expect(addMonths('2026-01-15T00:00:00.000Z', 1)).toBe('2026-02-15T00:00:00.000Z');
    expect(addMonths('2026-01-15T00:00:00.000Z', 3)).toBe('2026-04-15T00:00:00.000Z');
    expect(addMonths('2026-01-15T00:00:00.000Z', 6)).toBe('2026-07-15T00:00:00.000Z');
    expect(addMonths('2026-01-15T00:00:00.000Z', 12)).toBe('2027-01-15T00:00:00.000Z');
  });

  it('TC-SUB-07 — tanggal akhir bulan dijepit, tidak melimpah ke bulan berikutnya', () => {
    // Tanpa penjepitan, 31 Januari + 1 bulan menjadi 3 Maret: pelanggan mendapat dua
    // hari gratis setiap kali, dan tanggal tagihannya bergeser maju tiap periode.
    expect(addMonths('2026-01-31T00:00:00.000Z', 1)).toBe('2026-02-28T00:00:00.000Z');
    expect(addMonths('2024-01-31T00:00:00.000Z', 1)).toBe('2024-02-29T00:00:00.000Z'); // kabisat
    expect(addMonths('2026-03-31T00:00:00.000Z', 1)).toBe('2026-04-30T00:00:00.000Z');
    expect(addMonths('2026-08-31T00:00:00.000Z', 6)).toBe('2027-02-28T00:00:00.000Z');
  });

  it('TC-SUB-08 — periodEndFor menerjemahkan siklus menjadi tanggal', () => {
    const start = '2026-05-10T08:00:00.000Z';
    expect(periodEndFor(start, 'monthly')).toBe('2026-06-10T08:00:00.000Z');
    expect(periodEndFor(start, 'quarterly')).toBe('2026-08-10T08:00:00.000Z');
    expect(periodEndFor(start, 'semiannual')).toBe('2026-11-10T08:00:00.000Z');
    expect(periodEndFor(start, 'annual')).toBe('2027-05-10T08:00:00.000Z');
  });
});

/* ================= Pendaftaran dengan siklus pilihan ================= */

describe('Pemilihan siklus saat berlangganan', () => {
  it('TC-SUB-09 — keempat siklus dapat dipilih dan tersimpan apa adanya', () => {
    for (const cycle of BILLING_CYCLES) {
      const baru = provisionTenant(harness, { slug: `siklus${cycle.code}`, billingCycle: cycle.code });
      expect(subscriptionRow(baru).billing_cycle).toBe(cycle.code);
      expect(billing(baru).currentPlan().cycle_months).toBe(cycle.months);
    }
  });

  it('TC-SUB-10 — siklus tak dikenal DITOLAK saat provisioning', () => {
    expect(() =>
      harness.tenants.provision(
        {
          name: 'Organisasi Aneh',
          slug: 'siklusaneh',
          planCode: 'starter',
          // Nilai yang mungkin datang dari klien lama atau permintaan buatan tangan.
          billingCycle: 'weekly' as never,
          admin: { fullName: 'A', nik: 'NIK-X', email: 'a@siklusaneh.test', password: 'VantikTest#2026' },
        },
        'test',
      ),
    ).toThrowError(/error\.billing_cycle_unknown/);

    // Ditolak berarti TIDAK ADA tenant setengah jadi yang tertinggal.
    expect(harness.db.prepare('SELECT COUNT(*) c FROM tenants WHERE slug = ?').get('siklusaneh')).toEqual({ c: 0 });
  });
});

/* ================= Blokir otomatis ================= */

describe('Blokir otomatis saat masa berlaku habis', () => {
  it('TC-SUB-11 — masa berlaku lewat memblokir penulisan TANPA penjadwal pernah berjalan', () => {
    expect(cobaMenulis()).toBeNull(); // masih berlaku

    setPeriod(tenant, { status: 'active', trial_ends_at: null, current_period_end: daysFromNow(-1) });

    // Tidak ada `enforceLifecycle()` di sini — inilah inti pengujiannya. Status tenant
    // pun masih 'trial' di basis data; blokirnya dihitung dari tanggal.
    expect(tenantStatus()).toBe('trial');
    const error = cobaMenulis();
    expect(error?.status).toBe(403);
    expect(error?.messageKey).toBe('error.subscription_expired');
  });

  it('TC-SUB-12 — pesan penolakan menyebut LANGKAH PEMULIHAN, bukan sekadar "ditolak"', () => {
    setPeriod(tenant, { status: 'active', trial_ends_at: null, current_period_end: daysFromNow(-3) });
    const error = cobaMenulis();
    expect(error?.detail?.recoveryKey).toBe('recovery.renew_subscription');
    expect(error?.detail?.expiredAt).toBeTruthy();
  });

  it('TC-SUB-13 — data TIDAK disandera: membaca tetap berjalan setelah kedaluwarsa', () => {
    unggah(tenant);

    setPeriod(tenant, { status: 'active', trial_ends_at: null, current_period_end: daysFromNow(-1) });

    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    const daftar = new DatasetService(ctx).list();
    expect(daftar.length).toBeGreaterThan(0);
    expect(ctx.flags.readOnly).toBe(true);
    expect(ctx.flags.readOnlyReason).toBe('subscription_expired');
  });

  it('TC-SUB-14 — uji coba yang habis ikut memblokir, meski periode langganan masih jauh', () => {
    // Perangkap yang nyata: baris yang sama memuat DUA tanggal. Selama masih 'trialing'
    // yang mengikat adalah akhir uji coba; membaca kolom yang keliru berarti uji coba
    // 14 hari berlaku sepanjang periode langganan yang belum pernah dibayar.
    setPeriod(tenant, {
      status: 'trialing',
      trial_ends_at: daysFromNow(-1),
      current_period_end: daysFromNow(300),
    });
    expect(cobaMenulis()?.messageKey).toBe('error.subscription_expired');
  });

  it('TC-SUB-15 — langganan yang masih berlaku tidak terpengaruh', () => {
    setPeriod(tenant, { status: 'active', trial_ends_at: null, current_period_end: daysFromNow(1) });
    expect(cobaMenulis()).toBeNull();

    const view = billing().currentPlan();
    expect(view.expired).toBe(false);
    expect(view.days_remaining).toBe(1);
  });
});

/* ================= Tangga penurunan akses ================= */

describe('Tangga penurunan akses', () => {
  function jatuhTempoSejak(days: number): void {
    setPeriod(tenant, {
      status: 'active',
      trial_ends_at: null,
      current_period_end: daysFromNow(-days),
      lapsed_at: daysFromNow(-days),
    });
  }

  it('TC-SUB-16 — hari pertama: masa tenggang, tenant past_due', () => {
    jatuhTempoSejak(1);
    expect(billing().enforceLifecycle().stage).toBe('grace');
    expect(tenantStatus()).toBe('past_due');
  });

  it(`TC-SUB-17 — lewat ${GRACE_PERIOD_DAYS} hari: baca-saja`, () => {
    jatuhTempoSejak(GRACE_PERIOD_DAYS + 1);
    expect(billing().enforceLifecycle().stage).toBe('read_only');
    expect(tenantStatus()).toBe('read_only');
  });

  it(`TC-SUB-18 — lewat ${GRACE_PERIOD_DAYS * 2} hari: suspensi, dan sesi terbuka dicabut`, () => {
    harness.db
      .prepare(
        `INSERT INTO active_sessions (id, tenant_id, user_id, token_hash, device_id, issued_at,
                                      expires_at, last_seen_at, ip, reauth_at, revoked_at, revoked_reason)
         VALUES ('ses_uji', ?, ?, 'hash', NULL, ?, ?, ?, '203.0.113.10', NULL, NULL, NULL)`,
      )
      .run(tenant.tenantId, tenant.adminUserId, daysFromNow(-1), daysFromNow(1), daysFromNow(-1));

    jatuhTempoSejak(GRACE_PERIOD_DAYS * 2 + 1);
    expect(billing().enforceLifecycle().stage).toBe('suspended');
    expect(tenantStatus()).toBe('suspended');

    const sesi = harness.db.prepare('SELECT revoked_reason FROM active_sessions WHERE id = ?').get('ses_uji') as {
      revoked_reason: string | null;
    };
    expect(sesi.revoked_reason).toBe('subscription_expired');
  });

  it('TC-SUB-19 — data tenant TIDAK dihapus, bahkan setelah suspensi', () => {
    unggah(tenant);

    jatuhTempoSejak(GRACE_PERIOD_DAYS * 3);
    billing().enforceLifecycle();

    const tersisa = harness.db
      .prepare('SELECT COUNT(*) c FROM dataset_catalog WHERE tenant_id = ?')
      .get(tenant.tenantId) as { c: number };
    expect(tersisa.c).toBe(1);
  });
});

/* ================= Faktur perpanjangan & pengingat ================= */

describe('Faktur perpanjangan dan pemberitahuan', () => {
  it('TC-SUB-20 — satu faktur perpanjangan saja, meski pekerjaan berjalan berkali-kali', () => {
    setPeriod(tenant, { status: 'active', trial_ends_at: null, current_period_end: daysFromNow(-2) });

    billing().enforceLifecycle();
    billing().enforceLifecycle();
    billing().enforceLifecycle();

    const faktur = harness.db
      .prepare("SELECT COUNT(*) c FROM invoices WHERE tenant_id = ? AND kind = 'renewal'")
      .get(tenant.tenantId) as { c: number };
    expect(faktur.c).toBe(1);
  });

  it('TC-SUB-21 — nilai faktur perpanjangan sesuai siklus yang dipilih', () => {
    const setahun = provisionTenant(harness, { slug: 'setahunx', planCode: 'professional', billingCycle: 'annual' });
    setPeriod(setahun, { status: 'active', trial_ends_at: null, current_period_end: daysFromNow(-1) });
    billing(setahun).enforceLifecycle();

    const faktur = harness.db
      .prepare("SELECT subtotal, period_start, period_end FROM invoices WHERE tenant_id = ? AND kind = 'renewal'")
      .get(setahun.tenantId) as { subtotal: number; period_start: string; period_end: string };

    expect(faktur.subtotal).toBe(45_000_000);
    // Periode yang ditagih mulai dari saat masa berlaku habis — bukan dari "sekarang" —
    // supaya pelanggan yang telat membayar tidak kehilangan hari yang sudah ditagihkan.
    expect(faktur.period_end).toBe(periodEndFor(faktur.period_start, 'annual'));
  });

  it('TC-SUB-22 — yang sudah membatalkan TIDAK ditagih untuk periode berikutnya', () => {
    billing().cancel('pindah penyedia');
    setPeriod(tenant, { status: 'active', trial_ends_at: null, current_period_end: daysFromNow(-1) });
    billing().enforceLifecycle();

    const faktur = harness.db
      .prepare("SELECT COUNT(*) c FROM invoices WHERE tenant_id = ? AND kind = 'renewal'")
      .get(tenant.tenantId) as { c: number };
    expect(faktur.c).toBe(0);
    // Tetap diblokir — pembatalan menghentikan tagihan, bukan memperpanjang akses.
    expect(cobaMenulis()?.messageKey).toBe('error.subscription_expired');
  });

  it('TC-SUB-23 — pengingat dikirim sekali per periode, kepada admin saja', () => {
    setPeriod(tenant, { status: 'active', trial_ends_at: null, current_period_end: daysFromNow(3) });

    expect(billing().enforceLifecycle().stage).toBe('reminded');
    expect(billing().enforceLifecycle().stage).toBe('active'); // tidak diulang

    const antrean = harness.db
      .prepare("SELECT recipient FROM notification_outbox WHERE purpose = 'subscription_renewal_reminder'")
      .all() as Array<{ recipient: string }>;
    expect(antrean).toHaveLength(1);
    expect(antrean[0]!.recipient).toBe(`admin@${tenant.slug}.test`);
  });

  it('TC-SUB-24 — setelah tanggal berakhir bergeser, pengingat boleh terkirim lagi', () => {
    setPeriod(tenant, { status: 'active', trial_ends_at: null, current_period_end: daysFromNow(3) });
    billing().enforceLifecycle();

    // Penanda disimpan sebagai TANGGAL, bukan bendera "sudah pernah" — jadi periode
    // baru otomatis layak diingatkan tanpa ada yang perlu membersihkan penanda.
    setPeriod(tenant, { current_period_end: daysFromNow(5) });
    expect(billing().enforceLifecycle().stage).toBe('reminded');

    const jumlah = harness.db
      .prepare("SELECT COUNT(*) c FROM notification_outbox WHERE purpose = 'subscription_renewal_reminder'")
      .get() as { c: number };
    expect(jumlah.c).toBe(2);
  });

  it('TC-SUB-25 — kedaluwarsa memberi tahu admin dan tercatat di Log Aktivitas', () => {
    setPeriod(tenant, { status: 'active', trial_ends_at: null, current_period_end: daysFromNow(-1) });
    billing().enforceLifecycle();

    const pesan = harness.db
      .prepare("SELECT body FROM notification_outbox WHERE purpose = 'subscription_expired'")
      .all() as Array<{ body: string }>;
    expect(pesan).toHaveLength(1);
    expect(pesan[0]!.body).toContain('BACA-SAJA');

    const jejak = harness.audit.query(tenant.tenantId, {}).rows;
    expect(jejak.some((r) => r.action === 'subscription.lapsed')).toBe(true);
  });
});

/* ================= Perpanjangan: jalan keluar dari blokir ================= */

describe('Perpanjangan', () => {
  it('TC-SUB-26 — perpanjangan memajukan masa berlaku sepanjang siklus dan membuka blokir', () => {
    const tiga = provisionTenant(harness, { slug: 'tigabulanx', planCode: 'professional', billingCycle: 'quarterly' });
    const habis = daysFromNow(-1);
    setPeriod(tiga, { status: 'active', trial_ends_at: null, current_period_end: habis });
    expect(cobaMenulis(tiga)?.messageKey).toBe('error.subscription_expired');

    billing(tiga).enforceLifecycle(); // menerbitkan faktur perpanjangan
    billing(tiga).renew('tok_gateway_uji', 'VISA •••• 4321');

    const sub = subscriptionRow(tiga);
    expect(sub.status).toBe('active');
    expect(sub.lapsed_at).toBeNull();
    expect(sub.current_period_end).toBe(periodEndFor(String(sub.current_period_start), 'quarterly'));
    expect(cycleMonths(String(sub.billing_cycle))).toBe(3);
    expect(cobaMenulis(tiga)).toBeNull();
  });

  it('TC-SUB-27 — perpanjangan tetap dapat dilakukan SAAT ruang kerja sedang terkunci', () => {
    // Kalau `renew()` ikut tunduk pada `requireWritable()`, blokirnya mengunci pintu
    // keluarnya sendiri dan pelanggan tidak akan pernah bisa memulihkan diri.
    setPeriod(tenant, {
      status: 'active',
      trial_ends_at: null,
      current_period_end: daysFromNow(-(GRACE_PERIOD_DAYS * 2 + 2)),
    });
    billing().enforceLifecycle();
    expect(tenantStatus()).toBe('suspended');

    billing().renew('tok_gateway_uji', 'Transfer bank');
    expect(tenantStatus()).toBe('active');
    expect(cobaMenulis()).toBeNull();
  });

  it('TC-SUB-28 — perpanjangan lebih awal menyambung dari akhir periode berjalan', () => {
    const akhir = daysFromNow(10);
    setPeriod(tenant, { status: 'active', trial_ends_at: null, current_period_end: akhir });

    billing().renew('tok_awal', 'VISA •••• 1111');

    const sub = subscriptionRow(tenant);
    // Tidak ada hari yang hangus: periode baru mulai persis di akhir periode lama.
    expect(sub.current_period_start).toBe(akhir);
    expect(sub.current_period_end).toBe(periodEndFor(akhir, 'monthly'));
  });

  it('TC-SUB-29 — pembayaran lewat webhook memajukan periode sesuai faktur, bukan "sekarang"', () => {
    const habis = daysFromNow(-5);
    setPeriod(tenant, { status: 'active', trial_ends_at: null, current_period_end: habis });
    billing().enforceLifecycle();

    const faktur = harness.db
      .prepare("SELECT id, period_start, period_end FROM invoices WHERE tenant_id = ? AND kind = 'renewal'")
      .get(tenant.tenantId) as { id: string; period_start: string; period_end: string };

    const secret = 'rahasia-webhook-uji';
    const body = JSON.stringify({ event: 'payment.succeeded', invoiceId: faktur.id, gatewayRef: 'ref-1' });
    const signature = createHmac('sha256', secret).update(body).digest('hex');

    expect(billing().handleGatewayWebhook(body, signature, secret).accepted).toBe(true);

    const sub = subscriptionRow(tenant);
    expect(sub.current_period_start).toBe(faktur.period_start);
    expect(sub.current_period_end).toBe(faktur.period_end);
    expect(sub.status).toBe('active');
    expect(tenantStatus()).toBe('active');
  });

  it('TC-SUB-30 — faktur pro-rata yang lunas TIDAK memperpanjang masa berlaku', () => {
    const akhir = daysFromNow(20);
    setPeriod(tenant, { status: 'active', trial_ends_at: null, current_period_end: akhir });

    const proRata = billing().issueInvoice({
      lines: [{ description: 'Selisih upgrade', amount: 1_000_000 }],
      periodStart: new Date().toISOString(),
      periodEnd: akhir,
      kind: 'proration',
    });

    const secret = 'rahasia-webhook-uji';
    const body = JSON.stringify({ event: 'payment.succeeded', invoiceId: proRata.id });
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    billing().handleGatewayWebhook(body, signature, secret);

    // Masa berlaku tidak bergeser: yang dibayar adalah selisih paket, bukan waktu.
    expect(subscriptionRow(tenant).current_period_end).toBe(akhir);
  });

  it('TC-SUB-31 — downgrade tertunda baru berlaku ketika siklus berikutnya dibayar', () => {
    billing().changePlan('starter'); // downgrade → tertunda
    expect(subscriptionRow(tenant).pending_plan_code).toBe('starter');
    expect(subscriptionRow(tenant).plan_code).toBe('professional');

    setPeriod(tenant, { status: 'active', trial_ends_at: null, current_period_end: daysFromNow(-1) });
    billing().enforceLifecycle();
    billing().renew('tok_siklus_baru', 'Transfer bank');

    const sub = subscriptionRow(tenant);
    expect(sub.plan_code).toBe('starter');
    expect(sub.pending_plan_code).toBeNull();
  });

  it('TC-SUB-33 — perpanjangan yang dibayar sangat terlambat tetap berakhir di masa depan', () => {
    // Faktur diterbitkan untuk periode yang mulai saat masa berlaku habis. Pelanggan
    // yang terlambat lebih lama daripada satu siklus akan membeli periode yang sudah
    // lewat — ia membayar, lalu tetap terkunci. Periodenya dihitung ulang dari saat
    // pembayaran; waktu tunggakan itu memang tidak ia pakai karena ruang kerjanya
    // baca-saja.
    setPeriod(tenant, { status: 'active', trial_ends_at: null, current_period_end: daysFromNow(-95) });
    billing().enforceLifecycle();
    billing().renew('tok_telat', 'Transfer bank');

    const sub = subscriptionRow(tenant);
    expect(Date.parse(String(sub.current_period_end))).toBeGreaterThan(Date.now());
    expect(sub.current_period_end).toBe(periodEndFor(String(sub.current_period_start), 'monthly'));
    expect(cobaMenulis()).toBeNull();
  });

  it('TC-SUB-32 — tampilan langganan melaporkan masa berlaku, sisa hari, dan harga siklus', () => {
    const enam = provisionTenant(harness, { slug: 'enambulanx', planCode: 'professional', billingCycle: 'semiannual' });
    setPeriod(enam, { status: 'active', trial_ends_at: null, current_period_end: daysFromNow(45) });

    const view = billing(enam).currentPlan();
    expect(view.billing_cycle).toBe('semiannual');
    expect(view.cycle_months).toBe(6);
    expect(view.expires_at).toBe(subscriptionRow(enam).current_period_end);
    expect(view.days_remaining).toBe(45);
    expect(view.expired).toBe(false);
    expect(view.price).toBe(planPrice(PLAN_CATALOG.find((p) => p.code === 'professional')!, 'semiannual'));
  });
});
