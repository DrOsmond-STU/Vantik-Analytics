/**
 * Payment gateway: tautan bayar, dan kabar pembayaran yang dapat dipercaya.
 *
 * Uji di sini berbicara ke server HTTP tiruan yang meniru bentuk **Xendit** dan **Midtrans**,
 * bukan ke mock yang mengembalikan apa saja. Alasannya sama seperti pada transport SMTP:
 * klien yang menebak bentuk respons hanya boleh dipercaya bila percakapannya diperiksa, dan
 * kegagalan pembayaran adalah kelas cacat yang tidak melempar apa pun — pelanggan membayar,
 * lalu ruang kerjanya tetap terkunci.
 *
 * Empat hal yang paling penting dibuktikan:
 *
 *  1. **Kunci rahasia tidak pernah bocor** (TC-PGW-04). Kunci ini dapat membuat tagihan atas
 *     nama pemilik platform, dan alasan kegagalan ditampilkan ke pelanggan.
 *  2. **Kabar palsu ditolak** (TC-PGW-08/09/11), termasuk saat gateway belum dikonfigurasi —
 *     jalur ini MENYATAKAN faktur lunas.
 *  3. **Kabar yang dikirim ulang tidak memajukan masa berlaku dua kali** (TC-PGW-13).
 *     Penyedia memang mengirim ulang kabar yang tidak dijawab 2xx.
 *  4. **Gateway yang gagal tidak menggagalkan penerbitan faktur** (TC-PGW-05). Fakturnya sah,
 *     dan jalur pembayaran manual tetap ada.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createHarness, contextFor, provisionTenant, type Harness, type TenantFixture } from './helpers.ts';
import { BillingService } from '../src/billing-service/index.ts';
import {
  GATEWAY_TIMEOUT_MS,
  resolveGatewayFromEnv,
  tryCreateCharge,
  verifyCallback,
  type GatewayConfig,
} from '../src/billing-service/gateway.ts';
import { PlatformBillingService } from '../src/billing-service/settlement.ts';
import { MeteringService } from '../src/metering-service/index.ts';
import { loadFeatureFlags } from '../src/platform/context.ts';

let harness: Harness;
let tenant: TenantFixture;

beforeEach(() => {
  harness = createHarness();
  tenant = provisionTenant(harness, { planCode: 'professional', trialDays: 30 });
});

/* ================= Penyedia tiruan ================= */

interface Tiruan {
  base: string;
  /** Permintaan yang DITERIMA penyedia — inilah yang diperiksa uji. */
  diterima: Array<{ path: string; auth: string; body: Record<string, unknown> }>;
  close: () => Promise<void>;
}

async function penyediaTiruan(
  responder: (path: string, body: Record<string, unknown>) => { status: number; json: unknown },
): Promise<Tiruan> {
  const diterima: Tiruan['diterima'] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += String(c)));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = {};
      }
      diterima.push({ path: req.url ?? '', auth: String(req.headers.authorization ?? ''), body });
      const hasil = responder(req.url ?? '', body);
      res.writeHead(hasil.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(hasil.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    diterima,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const servers: Tiruan[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  harness.cleanup();
});

function konfigurasi(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    provider: 'xendit',
    secretKey: 'xnd_development_KUNCI_SANGAT_RAHASIA',
    callbackToken: 'token-callback-rahasia',
    apiBase: 'http://127.0.0.1:1',
    successUrl: '',
    failureUrl: '',
    ...overrides,
  };
}

function billing(config: GatewayConfig | null): BillingService {
  const ctx = contextFor(harness, tenant.tenantId, ['super_admin'], { mfaEnrolled: true });
  return new BillingService(ctx, new MeteringService(ctx), undefined, config);
}

function kedaluwarsakan(): void {
  harness.db
    .prepare(
      `UPDATE subscriptions
          SET status = 'active', trial_ends_at = NULL, current_period_end = ?, activated_at = ?
        WHERE tenant_id = ?`,
    )
    .run(
      new Date(Date.now() - 86_400_000).toISOString(),
      new Date(Date.now() - 400 * 86_400_000).toISOString(),
      tenant.tenantId,
    );
}

function invoiceRow(id: string): Record<string, string | number | null> {
  return harness.db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as Record<string, string | number | null>;
}

function subRow(): Record<string, string | number | null> {
  return harness.db.prepare('SELECT * FROM subscriptions WHERE tenant_id = ?').get(tenant.tenantId) as Record<
    string,
    string | number | null
  >;
}

/* ================= Konfigurasi ================= */

describe('Konfigurasi gateway', () => {
  it('TC-PGW-01 — kosong secara bawaan; setengah terkonfigurasi tidak diaktifkan', () => {
    expect(resolveGatewayFromEnv({})).toBeNull();
    // Penyedia diisi tetapi kunci kosong: tautan bayar yang pasti gagal dibuat hanya
    // menghasilkan pesan kesalahan di layar pelanggan.
    expect(resolveGatewayFromEnv({ VANTIK_PAYMENT_PROVIDER: 'xendit' })).toBeNull();
    expect(resolveGatewayFromEnv({ VANTIK_PAYMENT_SECRET_KEY: 'kunci' })).toBeNull();
    // Penyedia yang tidak dikenal DIABAIKAN, bukan dipaksa jalan.
    expect(
      resolveGatewayFromEnv({ VANTIK_PAYMENT_PROVIDER: 'gopay-langsung', VANTIK_PAYMENT_SECRET_KEY: 'k' }),
    ).toBeNull();
  });

  it('TC-PGW-02 — terisi lengkap memakai basis URL bawaan penyedia', () => {
    const xendit = resolveGatewayFromEnv({
      VANTIK_PAYMENT_PROVIDER: 'Xendit',
      VANTIK_PAYMENT_SECRET_KEY: ' kunci ',
      VANTIK_PAYMENT_CALLBACK_TOKEN: 'tok',
    });
    expect(xendit).toMatchObject({ provider: 'xendit', secretKey: 'kunci', apiBase: 'https://api.xendit.co' });

    const midtrans = resolveGatewayFromEnv({
      VANTIK_PAYMENT_PROVIDER: 'midtrans',
      VANTIK_PAYMENT_SECRET_KEY: 'SB-Mid-server-x',
      VANTIK_PAYMENT_API_BASE: 'https://app.sandbox.midtrans.com/',
    });
    // Garis miring di ujung dibuang, supaya URL tidak menjadi `..com//snap`.
    expect(midtrans?.apiBase).toBe('https://app.sandbox.midtrans.com');
  });
});

/* ================= Pembuatan tagihan ================= */

describe('Pembuatan tagihan', () => {
  it('TC-PGW-03 — Xendit: faktur mendapat tautan bayar, dan external_id-nya nomor faktur kita', async () => {
    const server = await penyediaTiruan(() => ({
      status: 200,
      json: { id: 'xnd-inv-1', invoice_url: 'https://checkout.xendit.co/web/xnd-inv-1', expiry_date: '2026-08-05T00:00:00Z' },
    }));
    servers.push(server);
    kedaluwarsakan();

    const invoice = await billing(konfigurasi({ apiBase: server.base })).requestRenewal();

    expect(invoice.pay_url).toBe('https://checkout.xendit.co/web/xnd-inv-1');
    expect(invoice.charge_error).toBeNull();
    expect(server.diterima[0]!.path).toBe('/v2/invoices');
    // `external_id` harus id faktur kita: itulah yang dipakai mencocokkan kabar pembayaran
    // kembali ke faktur yang benar, tanpa pemetaan tambahan yang dapat menyimpang.
    expect(server.diterima[0]!.body.external_id).toBe(invoice.id);
    expect(server.diterima[0]!.body.amount).toBe(invoice.total);
    expect(invoiceRow(invoice.id).gateway_ref).toBe('xnd-inv-1');
  });

  it('TC-PGW-03b — Midtrans: order_id-nya nomor faktur kita, dan redirect_url dipakai', async () => {
    const server = await penyediaTiruan(() => ({
      status: 201,
      json: { token: 'snap-token-1', redirect_url: 'https://app.midtrans.com/snap/v3/redirection/snap-token-1' },
    }));
    servers.push(server);
    kedaluwarsakan();

    const invoice = await billing(
      konfigurasi({ provider: 'midtrans', apiBase: server.base, secretKey: 'SB-Mid-server-RAHASIA' }),
    ).requestRenewal();

    expect(invoice.pay_url).toContain('/snap/v3/redirection/');
    expect(server.diterima[0]!.path).toBe('/snap/v1/transactions');
    expect(server.diterima[0]!.body.transaction_details).toMatchObject({
      order_id: invoice.id,
      gross_amount: invoice.total,
    });
  });

  it('TC-PGW-04 — kunci rahasia dikirim sebagai Basic auth, dan TIDAK muncul di alasan kegagalan', async () => {
    const server = await penyediaTiruan(() => ({ status: 401, json: { message: 'invalid key' } }));
    servers.push(server);
    kedaluwarsakan();
    const config = konfigurasi({ apiBase: server.base });

    const invoice = await billing(config).requestRenewal();

    // Terkirim sebagaimana mestinya…
    const auth = server.diterima[0]!.auth;
    expect(Buffer.from(auth.replace('Basic ', ''), 'base64').toString('utf8')).toBe(`${config.secretKey}:`);
    // …tetapi tidak pernah muncul di kolom yang dibaca pelanggan maupun operator.
    expect(invoice.charge_error).toBe('gateway_http_401');
    expect(JSON.stringify(invoice)).not.toContain(config.secretKey);
    expect(String(invoiceRow(invoice.id).charge_error)).not.toContain(config.secretKey);
  });

  it('TC-PGW-05 — gateway gagal TIDAK menggagalkan penerbitan faktur', async () => {
    kedaluwarsakan();
    // Port yang pasti tertutup.
    const invoice = await billing(konfigurasi({ apiBase: 'http://127.0.0.1:1' })).requestRenewal();

    // Fakturnya tetap sah dan dapat dibayar lewat jalur manual.
    expect(invoice.id).toBeTruthy();
    expect(invoice.total).toBeGreaterThan(0);
    expect(invoice.status).not.toBe('paid');
    expect(invoice.pay_url).toBeNull();
    expect(invoice.charge_error).toBeTruthy();
  });

  it('TC-PGW-06 — tanpa gateway, faktur diterbitkan tanpa tautan dan tanpa mengaku gagal', async () => {
    kedaluwarsakan();
    const invoice = await billing(null).requestRenewal();

    expect(invoice.pay_url).toBeNull();
    // Bedanya dengan TC-PGW-05: tidak ada kegagalan, memang belum dikonfigurasi.
    expect(invoice.charge_error).toBeNull();
  });

  it('TC-PGW-07 — menekan tombol dua kali tidak membuat dua tagihan di penyedia', async () => {
    let dipanggil = 0;
    const server = await penyediaTiruan(() => {
      dipanggil += 1;
      return { status: 200, json: { id: `xnd-${dipanggil}`, invoice_url: `https://checkout.test/${dipanggil}` } };
    });
    servers.push(server);
    kedaluwarsakan();
    const svc = billing(konfigurasi({ apiBase: server.base }));

    const pertama = await svc.requestRenewal();
    const kedua = await svc.requestRenewal();

    expect(kedua.id).toBe(pertama.id);
    expect(kedua.pay_url).toBe(pertama.pay_url);
    // Satu tagihan untuk satu periode: nomor pembayaran tidak boleh berubah-ubah.
    expect(dipanggil).toBe(1);
  });

  it('TC-PGW-07b — batas waktu panggilan gateway dinyatakan, bukan menggantung', () => {
    expect(GATEWAY_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

/* ================= Kabar pembayaran: Xendit ================= */

describe('Kabar pembayaran Xendit', () => {
  const body = (external: string, status = 'PAID'): string =>
    JSON.stringify({ id: 'xnd-cb-1', external_id: external, status, payment_method: 'QR_CODE', payment_channel: 'QRIS' });

  it('TC-PGW-08 — token callback salah DITOLAK', async () => {
    kedaluwarsakan();
    const invoice = await billing(konfigurasi()).requestRenewal();

    const hasil = billing(konfigurasi()).handleProviderCallback(body(invoice.id), {
      'x-callback-token': 'token-yang-salah',
    });

    expect(hasil.accepted).toBe(false);
    expect(hasil.reasonKey).toBe('error.webhook_signature_invalid');
    expect(invoiceRow(invoice.id).status).not.toBe('paid');
  });

  it('TC-PGW-09 — token callback KOSONG di konfigurasi juga ditolak', async () => {
    kedaluwarsakan();
    const invoice = await billing(konfigurasi()).requestRenewal();

    // Tanpa penjagaan ini, header kosong akan cocok dengan konfigurasi kosong dan siapa pun
    // yang mengetahui nomor faktur dapat membuka ruang kerja tanpa membayar.
    const hasil = billing(konfigurasi({ callbackToken: '' })).handleProviderCallback(body(invoice.id), {
      'x-callback-token': '',
    });

    expect(hasil.accepted).toBe(false);
    expect(hasil.reasonKey).toBe('error.payment_callback_token_missing');
    expect(invoiceRow(invoice.id).status).not.toBe('paid');
  });

  it('TC-PGW-10 — kabar sah membuka ruang kerja dan mencatat cara bayarnya', async () => {
    kedaluwarsakan();
    const invoice = await billing(konfigurasi()).requestRenewal();

    const hasil = billing(konfigurasi()).handleProviderCallback(body(invoice.id), {
      'x-callback-token': 'token-callback-rahasia',
    });

    expect(hasil.accepted).toBe(true);
    expect(invoiceRow(invoice.id).status).toBe('paid');
    expect(invoiceRow(invoice.id).payment_method_label).toBe('QR_CODE · QRIS');
    expect(subRow().status).toBe('active');
    expect(Date.parse(String(subRow().current_period_end))).toBeGreaterThan(Date.now());
    expect(loadFeatureFlags(harness.db, tenant.tenantId, 'trial').readOnly).toBe(false);
  });

  it('TC-PGW-11 — status EXPIRED tidak dianggap lunas', async () => {
    kedaluwarsakan();
    const invoice = await billing(konfigurasi()).requestRenewal();

    billing(konfigurasi()).handleProviderCallback(body(invoice.id, 'EXPIRED'), {
      'x-callback-token': 'token-callback-rahasia',
    });

    expect(invoiceRow(invoice.id).status).not.toBe('paid');
    expect(Date.parse(String(subRow().current_period_end))).toBeLessThan(Date.now());
  });

  it('TC-PGW-12 — faktur yang tidak dikenal dijawab tidak ditemukan', () => {
    const hasil = billing(konfigurasi()).handleProviderCallback(body('inv_tidak_ada'), {
      'x-callback-token': 'token-callback-rahasia',
    });
    expect(hasil).toEqual({ accepted: false, reasonKey: 'error.not_found' });
  });

  it('TC-PGW-13 — kabar yang DIKIRIM ULANG tidak memajukan masa berlaku dua kali', async () => {
    kedaluwarsakan();
    const invoice = await billing(konfigurasi()).requestRenewal();
    const svc = billing(konfigurasi());
    const header = { 'x-callback-token': 'token-callback-rahasia' };

    svc.handleProviderCallback(body(invoice.id), header);
    const setelahSekali = subRow().current_period_end;
    const ulang = svc.handleProviderCallback(body(invoice.id), header);

    // Penyedia mengirim ulang kabar yang tidak dijawab 2xx. Jawabannya tetap 'diterima'
    // supaya ia berhenti mencoba, tetapi masa berlakunya TIDAK maju lagi.
    expect(ulang.accepted).toBe(true);
    expect(subRow().current_period_end).toBe(setelahSekali);
  });
});

/* ================= Kabar pembayaran: Midtrans ================= */

describe('Kabar pembayaran Midtrans', () => {
  const midtrans = (): GatewayConfig =>
    konfigurasi({ provider: 'midtrans', secretKey: 'SB-Mid-server-RAHASIA', callbackToken: '' });

  function badan(invoiceId: string, status: string, fraud = 'accept'): string {
    const statusCode = '200';
    const gross = '4995000.00';
    const signature = createHash('sha512')
      .update(`${invoiceId}${statusCode}${gross}${midtrans().secretKey}`, 'utf8')
      .digest('hex');
    return JSON.stringify({
      order_id: invoiceId,
      status_code: statusCode,
      gross_amount: gross,
      signature_key: signature,
      transaction_status: status,
      fraud_status: fraud,
      transaction_id: 'mt-trx-1',
      payment_type: 'qris',
      bank: 'gopay',
    });
  }

  it('TC-PGW-14 — tanda tangan sah dengan status settlement dianggap lunas', async () => {
    kedaluwarsakan();
    const invoice = await billing(midtrans()).requestRenewal();

    const hasil = billing(midtrans()).handleProviderCallback(badan(invoice.id, 'settlement'), {});

    expect(hasil.accepted).toBe(true);
    expect(invoiceRow(invoice.id).status).toBe('paid');
    expect(invoiceRow(invoice.id).payment_method_label).toBe('QRIS · GOPAY');
  });

  it('TC-PGW-15 — tanda tangan yang dipalsukan ditolak', async () => {
    kedaluwarsakan();
    const invoice = await billing(midtrans()).requestRenewal();
    const palsu = JSON.stringify({
      order_id: invoice.id,
      status_code: '200',
      gross_amount: '4995000.00',
      signature_key: 'a'.repeat(128),
      transaction_status: 'settlement',
    });

    const hasil = billing(midtrans()).handleProviderCallback(palsu, {});

    expect(hasil.accepted).toBe(false);
    expect(invoiceRow(invoice.id).status).not.toBe('paid');
  });

  it('TC-PGW-16 — capture yang masih ditinjau penipuan TIDAK dianggap lunas', async () => {
    kedaluwarsakan();
    const invoice = await billing(midtrans()).requestRenewal();

    // `challenge` menunggu keputusan manual; memperlakukannya sebagai lunas berarti membuka
    // ruang kerja atas pembayaran yang masih dapat dibatalkan.
    billing(midtrans()).handleProviderCallback(badan(invoice.id, 'capture', 'challenge'), {});

    expect(invoiceRow(invoice.id).status).not.toBe('paid');
  });
});

/* ================= Jalur HTTP: tanpa sesi ================= */

describe('Kabar pembayaran tanpa sesi', () => {
  function platform(): PlatformBillingService {
    return new PlatformBillingService(harness.db, harness.audit);
  }
  const xenditBody = (external: string, status = 'PAID'): string =>
    JSON.stringify({ id: 'xnd-cb-9', external_id: external, status, payment_method: 'QR_CODE', payment_channel: 'QRIS' });

  it('TC-PGW-20 — payment gateway tidak punya sesi, dan tetap dapat menyatakan lunas', async () => {
    kedaluwarsakan();
    const invoice = await billing(konfigurasi()).requestRenewal();

    // Inilah bentuk yang benar-benar dipanggil penyedia: tanpa token sesi, tanpa konteks
    // tenant. Sebelumnya rutenya berada di balik `authenticate` dan setiap kabar dijawab
    // 401 — jalurnya terbaca benar di kode tetapi tidak pernah dapat dipakai siapa pun.
    const hasil = platform().applyProviderCallback(
      xenditBody(invoice.id),
      { 'x-callback-token': 'token-callback-rahasia' },
      { gateway: konfigurasi(), hmacSecret: '', ip: '127.0.0.1' },
    );

    expect(hasil).toEqual({ accepted: true });
    expect(invoiceRow(invoice.id).status).toBe('paid');
    expect(subRow().status).toBe('active');
    expect(Date.parse(String(subRow().current_period_end))).toBeGreaterThan(Date.now());
  });

  it('TC-PGW-21 — aktornya dicatat sebagai gateway, bukan sebagai manusia', async () => {
    kedaluwarsakan();
    const invoice = await billing(konfigurasi()).requestRenewal();
    platform().applyProviderCallback(
      xenditBody(invoice.id),
      { 'x-callback-token': 'token-callback-rahasia' },
      { gateway: konfigurasi(), hmacSecret: '', ip: '203.0.113.7' },
    );

    const jejak = harness.audit
      .operatorTrail(tenant.tenantId, 50)
      .concat(
        harness.db
          .prepare("SELECT * FROM auditdb.audit_log WHERE tenant_id = ? AND action = 'billing.payment_confirmed'")
          .all(tenant.tenantId) as never[],
      );
    const entri = jejak.filter((e) => (e as { action: string }).action === 'billing.payment_confirmed');
    expect(entri.length).toBeGreaterThan(0);
    // Dibedakan dari pencatatan manual operator, supaya riwayat pembayaran dapat dibaca:
    // mana yang otomatis, mana yang dicocokkan manusia.
    expect((entri[0] as { actor_label: string }).actor_label).toBe('gateway:xendit');
  });

  it('TC-PGW-22 — kabar ulang lewat jalur tanpa sesi juga tidak memajukan dua kali', async () => {
    kedaluwarsakan();
    const invoice = await billing(konfigurasi()).requestRenewal();
    const opts = { gateway: konfigurasi(), hmacSecret: '', ip: null };
    const svc = platform();

    svc.applyProviderCallback(xenditBody(invoice.id), { 'x-callback-token': 'token-callback-rahasia' }, opts);
    const setelahSekali = subRow().current_period_end;
    const ulang = svc.applyProviderCallback(
      xenditBody(invoice.id),
      { 'x-callback-token': 'token-callback-rahasia' },
      opts,
    );

    expect(ulang.accepted).toBe(true);
    expect(subRow().current_period_end).toBe(setelahSekali);
  });

  it('TC-PGW-23 — jalur HMAC generik tetap berjalan, dan rahasia kosong ditolak', async () => {
    kedaluwarsakan();
    const invoice = await billing(null).requestRenewal();
    const body = JSON.stringify({ event: 'payment.succeeded', invoiceId: invoice.id, gatewayRef: 'GEN-1' });
    const secret = 'rahasia-generik';
    const signature = createHash('sha256').update('x').digest('hex'); // sengaja salah

    // Rahasia kosong = penolakan, bukan "terima apa saja".
    expect(
      platform().applyProviderCallback(body, {}, { gateway: null, hmacSecret: '', ip: null }),
    ).toEqual({ accepted: false, reasonKey: 'error.payment_webhook_not_configured' });

    // Tanda tangan salah juga ditolak.
    expect(
      platform().applyProviderCallback(
        body,
        { 'x-signature': signature },
        { gateway: null, hmacSecret: secret, ip: null },
      ).accepted,
    ).toBe(false);

    // Tanda tangan benar diterima.
    const { createHmac } = await import('node:crypto');
    const sah = createHmac('sha256', secret).update(body).digest('hex');
    const hasil = platform().applyProviderCallback(
      body,
      { 'x-signature': sah },
      { gateway: null, hmacSecret: secret, ip: null },
    );
    expect(hasil).toEqual({ accepted: true });
    expect(invoiceRow(invoice.id).status).toBe('paid');
  });
});

/* ================= Gateway belum dikonfigurasi ================= */

describe('Tanpa gateway', () => {
  it('TC-PGW-17 — kabar pembayaran DITOLAK bila gateway belum dikonfigurasi', () => {
    const hasil = billing(null).handleProviderCallback(JSON.stringify({ external_id: 'x', status: 'PAID' }), {
      'x-callback-token': 'apa saja',
    });

    expect(hasil).toEqual({
      accepted: false,
      reasonKey: 'error.payment_gateway_not_configured',
    });
  });

  it('TC-PGW-18 — badan pesan yang bukan JSON ditolak, bukan menjatuhkan proses', () => {
    const verdict = verifyCallback(konfigurasi(), 'bukan json', { 'x-callback-token': 'token-callback-rahasia' });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasonKey).toBe('error.webhook_payload_invalid');
  });

  it('TC-PGW-19 — kegagalan jaringan dilaporkan sebagai alasan, bukan melempar', async () => {
    const hasil = await tryCreateCharge(konfigurasi({ apiBase: 'http://127.0.0.1:1' }), {
      invoiceId: 'inv_1',
      invoiceNumber: 'INV/1',
      amount: 1000,
      currency: 'IDR',
      description: 'uji',
      payerEmail: null,
      payerName: null,
    });

    expect(hasil.ok).toBe(false);
    if (!hasil.ok) expect(hasil.failureReason).toBeTruthy();
  });
});
