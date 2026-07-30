/**
 * Payment gateway: membuat tagihan yang dapat dibayar, dan memverifikasi kabar pembayarannya.
 *
 * Seluruhnya DIKONFIGURASI LEWAT VARIABEL LINGKUNGAN dan dibiarkan kosong secara bawaan.
 * Selama kosong, perilakunya persis seperti sebelumnya: faktur diterbitkan tanpa tautan
 * bayar, dan pembayarannya dicatat operator setelah mencocokkan mutasi rekening. Itu bukan
 * kemunduran — itu keadaan yang sebenarnya, dinyatakan apa adanya.
 *
 * TANPA DEPENDENSI BARU. Kedua penyedia dipanggil lewat `fetch` bawaan Node, karena SDK
 * resmi mereka menarik puluhan paket dan satu paket yang gagal terpasang adalah masalah
 * pemasangan nomor satu di shared hosting.
 *
 * DUA penyedia yang didukung, bukan template bebas seperti transport WhatsApp. Alasannya
 * berbeda: pesan WhatsApp hanya perlu dikirim, sedangkan tagihan harus DIBACA BALIK —
 * tautan bayarnya diambil dari respons, dan kabar pembayarannya diverifikasi keasliannya.
 * Bentuk respons dan cara tanda tangan tiap penyedia berbeda, dan menebaknya lewat template
 * berarti pembayaran yang tidak terbaca atau, lebih buruk, kabar palsu yang diterima.
 *
 * Keduanya menghadirkan **QRIS** di halaman pembayarannya sendiri, bersama virtual account
 * dan e-wallet. Jadi "tautan ke Xendit" dan "QRIS" adalah jalur yang sama, dan sistem ini
 * tidak perlu menggambar kode QR sendiri.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Batas waktu satu panggilan ke gateway. Permintaan HTTP tidak boleh menggantung. */
export const GATEWAY_TIMEOUT_MS = 15_000;

export type PaymentProvider = 'xendit' | 'midtrans';

export interface GatewayConfig {
  provider: PaymentProvider;
  /**
   * Kunci rahasia penyedia (Xendit: Secret API Key, Midtrans: Server Key).
   *
   * TIDAK PERNAH dikembalikan lewat API mana pun dan tidak pernah masuk pesan kesalahan —
   * lihat `summarise()`. Kunci ini dapat membuat tagihan atas nama Anda.
   */
  secretKey: string;
  /**
   * Token verifikasi kabar pembayaran.
   *
   * Xendit mengirim `x-callback-token` yang harus sama dengan nilai ini. Midtrans TIDAK
   * memakainya — ia menandatangani badan pesan dengan Server Key, jadi kolom ini boleh
   * kosong untuk Midtrans.
   */
  callbackToken: string;
  /** Basis URL API. Diisi untuk memakai lingkungan sandbox penyedia. */
  apiBase: string;
  /** Tujuan setelah pembayaran selesai/dibatalkan; kosong berarti halaman bawaan penyedia. */
  successUrl: string;
  failureUrl: string;
}

/** Hasil pembuatan tagihan yang dapat dibayar. */
export interface PaymentCharge {
  /** Rujukan tagihan di sisi penyedia, untuk dicocokkan saat rekonsiliasi. */
  reference: string;
  /** Halaman pembayaran penyedia — di sinilah QRIS, VA, dan e-wallet ditampilkan. */
  payUrl: string;
  /** Kapan tautannya kedaluwarsa, bila penyedia menyebutkannya. */
  expiresAt: string | null;
}

export interface ChargeInput {
  invoiceId: string;
  invoiceNumber: string;
  /** Rupiah penuh, bukan sen: kedua penyedia memakai satuan mata uang untuk IDR. */
  amount: number;
  currency: string;
  description: string;
  payerEmail: string | null;
  payerName: string | null;
}

const DEFAULT_API_BASE: Record<PaymentProvider, string> = {
  xendit: 'https://api.xendit.co',
  midtrans: 'https://app.midtrans.com',
};

function trimmed(value: string | undefined): string {
  return (value ?? '').trim();
}

/**
 * Merakit konfigurasi gateway dari variabel lingkungan.
 *
 * Mengembalikan `null` bila penyedianya tidak diisi ATAU kunci rahasianya kosong. Setengah
 * terkonfigurasi TIDAK diaktifkan: tautan bayar yang pasti gagal dibuat hanya menghasilkan
 * pesan kesalahan di layar pelanggan, sementara "belum dikonfigurasi" menyatakan keadaan
 * yang sebenarnya dan jalur manual tetap berjalan.
 */
export function resolveGatewayFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig | null {
  const provider = trimmed(env.VANTIK_PAYMENT_PROVIDER).toLowerCase();
  if (provider !== 'xendit' && provider !== 'midtrans') return null;

  const secretKey = trimmed(env.VANTIK_PAYMENT_SECRET_KEY);
  if (!secretKey) return null;

  return {
    provider,
    secretKey,
    callbackToken: trimmed(env.VANTIK_PAYMENT_CALLBACK_TOKEN),
    apiBase: (trimmed(env.VANTIK_PAYMENT_API_BASE) || DEFAULT_API_BASE[provider]).replace(/\/+$/, ''),
    successUrl: trimmed(env.VANTIK_PAYMENT_SUCCESS_URL),
    failureUrl: trimmed(env.VANTIK_PAYMENT_FAILURE_URL),
  };
}

/**
 * Ringkasan kesalahan yang aman dicatat.
 *
 * Hanya kode/nama, bukan pesan penuh: pesan kesalahan HTTP sering memuat URL berikut
 * kuncinya, dan alasan kegagalan ini ditampilkan ke pelanggan serta tersimpan di log.
 */
function summarise(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    if (code) return String(code).toLowerCase();
    if (/^gateway_/.test(error.message)) return error.message;
    return error.name === 'Error' ? 'gateway_failed' : error.name.toLowerCase();
  }
  return 'gateway_failed';
}

/**
 * Membuat tagihan yang dapat dibayar pelanggan.
 *
 * `invoiceId` dikirim sebagai identitas eksternal (`external_id` di Xendit, `order_id` di
 * Midtrans) supaya kabar pembayaran dapat dicocokkan kembali ke faktur yang benar tanpa
 * menyimpan pemetaan tambahan yang bisa menyimpang.
 */
export async function createCharge(config: GatewayConfig, input: ChargeInput): Promise<PaymentCharge> {
  const response =
    config.provider === 'xendit' ? await xenditInvoice(config, input) : await midtransSnap(config, input);
  return response;
}

async function postJson(
  url: string,
  authorization: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: authorization,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
  });

  let json: Record<string, unknown> = {};
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    // Respons yang bukan JSON tetap dilaporkan lewat kodenya; badan yang tidak dapat
    // diurai tidak boleh menjatuhkan permintaan pelanggan.
    json = {};
  }
  return { status: response.status, json };
}

/**
 * Xendit Invoice API.
 *
 * Dipilih ketimbang endpoint QRIS langsung (`/qr_codes`) karena halaman invoice Xendit
 * SUDAH menampilkan QRIS bersama virtual account dan e-wallet. Memakai endpoint QRIS akan
 * menghasilkan string QR mentah, dan menampilkannya berarti sistem ini harus menggambar
 * kode QR sendiri — pekerjaan yang sudah dilakukan penyedia dengan lebih baik.
 */
async function xenditInvoice(config: GatewayConfig, input: ChargeInput): Promise<PaymentCharge> {
  // Xendit memakai Basic auth dengan secret key sebagai username dan kata sandi kosong.
  const authorization = `Basic ${Buffer.from(`${config.secretKey}:`, 'utf8').toString('base64')}`;
  const body: Record<string, unknown> = {
    external_id: input.invoiceId,
    amount: input.amount,
    currency: input.currency,
    description: input.description,
  };
  if (input.payerEmail) body.payer_email = input.payerEmail;
  if (config.successUrl) body.success_redirect_url = config.successUrl;
  if (config.failureUrl) body.failure_redirect_url = config.failureUrl;

  const { status, json } = await postJson(`${config.apiBase}/v2/invoices`, authorization, body);
  if (status < 200 || status >= 300) throw new Error(`gateway_http_${status}`);

  const payUrl = typeof json.invoice_url === 'string' ? json.invoice_url : '';
  const reference = typeof json.id === 'string' ? json.id : input.invoiceId;
  if (!payUrl) throw new Error('gateway_no_pay_url');

  return {
    reference,
    payUrl,
    expiresAt: typeof json.expiry_date === 'string' ? json.expiry_date : null,
  };
}

/** Midtrans Snap: satu halaman pembayaran yang juga memuat QRIS. */
async function midtransSnap(config: GatewayConfig, input: ChargeInput): Promise<PaymentCharge> {
  const authorization = `Basic ${Buffer.from(`${config.secretKey}:`, 'utf8').toString('base64')}`;
  const body: Record<string, unknown> = {
    transaction_details: { order_id: input.invoiceId, gross_amount: input.amount },
    item_details: [
      { id: input.invoiceNumber, price: input.amount, quantity: 1, name: input.description.slice(0, 50) },
    ],
  };
  if (input.payerEmail || input.payerName) {
    body.customer_details = {
      ...(input.payerName ? { first_name: input.payerName } : {}),
      ...(input.payerEmail ? { email: input.payerEmail } : {}),
    };
  }
  if (config.successUrl) body.callbacks = { finish: config.successUrl };

  const { status, json } = await postJson(`${config.apiBase}/snap/v1/transactions`, authorization, body);
  if (status < 200 || status >= 300) throw new Error(`gateway_http_${status}`);

  const payUrl = typeof json.redirect_url === 'string' ? json.redirect_url : '';
  if (!payUrl) throw new Error('gateway_no_pay_url');

  return {
    reference: typeof json.token === 'string' ? json.token : input.invoiceId,
    payUrl,
    expiresAt: null,
  };
}

/** Hasil pembuatan tagihan, termasuk kegagalan yang dinyatakan apa adanya. */
export type ChargeOutcome =
  | { ok: true; charge: PaymentCharge }
  | { ok: false; failureReason: string };

/**
 * Membuat tagihan tanpa pernah melempar.
 *
 * Kegagalan gateway TIDAK BOLEH menggagalkan penerbitan faktur: fakturnya sah, dan jalur
 * pembayaran manual tetap ada. Yang terjadi hanyalah pelanggan tidak mendapat tautan bayar,
 * dan itu dikatakan kepadanya.
 */
export async function tryCreateCharge(config: GatewayConfig, input: ChargeInput): Promise<ChargeOutcome> {
  try {
    return { ok: true, charge: await createCharge(config, input) };
  } catch (error) {
    return { ok: false, failureReason: summarise(error) };
  }
}

/* ================= Verifikasi kabar pembayaran ================= */

/** Perbandingan waktu-tetap untuk dua string rahasia. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verifikasi HMAC-SHA256 generik (`x-signature`), untuk pemasangan yang memakai gateway
 * mana pun di luar dua penyedia bernama di atas.
 *
 * Rahasia kosong = penolakan. Tanpa itu, tanda tangan yang sah adalah HMAC dengan kunci
 * kosong — dapat dihitung siapa pun yang tahu rahasianya belum diisi.
 */
export function verifyGenericHmac(
  secret: string,
  rawBody: string,
  signatureHeader: string,
): { ok: boolean; reasonKey?: string } {
  if (secret.trim() === '') return { ok: false, reasonKey: 'error.payment_webhook_not_configured' };
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = signatureHeader.replace(/^sha256=/, '');
  if (!sameSecret(provided.toLowerCase(), expected)) {
    return { ok: false, reasonKey: 'error.webhook_signature_invalid' };
  }
  return { ok: true };
}

export type CallbackEvent = 'paid' | 'failed' | 'ignored';

export interface CallbackVerdict {
  ok: boolean;
  reasonKey?: string;
  event: CallbackEvent;
  /** Faktur yang dimaksud, dari `external_id`/`order_id`. */
  invoiceId: string;
  /** Rujukan di sisi penyedia, untuk disimpan sebagai bukti. */
  reference: string | null;
  methodLabel: string | null;
}

const DITOLAK = (reasonKey: string): CallbackVerdict => ({
  ok: false,
  reasonKey,
  event: 'ignored',
  invoiceId: '',
  reference: null,
  methodLabel: null,
});

/**
 * Memverifikasi kabar pembayaran dari penyedia yang dikonfigurasi.
 *
 * Ini jalur yang MENYATAKAN sebuah faktur lunas, jadi seluruh kegagalan verifikasi berakhir
 * pada penolakan — termasuk konfigurasi yang belum lengkap. Menerima kabar yang tidak dapat
 * diverifikasi berarti siapa pun yang mengetahui nomor faktur dapat membuka ruang kerja
 * tanpa membayar.
 */
export function verifyCallback(
  config: GatewayConfig,
  rawBody: string,
  headers: Record<string, string | undefined>,
): CallbackVerdict {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return DITOLAK('error.webhook_payload_invalid');
  }

  if (config.provider === 'xendit') {
    // Xendit tidak menandatangani badan pesan; ia mengirim token statis yang harus sama
    // dengan Callback Verification Token milik akun. Token kosong berarti belum
    // dikonfigurasi, dan itu penolakan — bukan "terima saja".
    if (!config.callbackToken) return DITOLAK('error.payment_callback_token_missing');
    const provided = headers['x-callback-token'] ?? '';
    if (!sameSecret(provided, config.callbackToken)) return DITOLAK('error.webhook_signature_invalid');

    const status = String(payload.status ?? '').toUpperCase();
    return {
      ok: true,
      event: status === 'PAID' || status === 'SETTLED' ? 'paid' : status === 'EXPIRED' ? 'failed' : 'ignored',
      invoiceId: String(payload.external_id ?? ''),
      reference: typeof payload.id === 'string' ? payload.id : null,
      methodLabel: paymentLabel(payload.payment_method, payload.payment_channel),
    };
  }

  // Midtrans: signature_key = SHA512(order_id + status_code + gross_amount + server_key).
  // Kunci server ikut di-hash, jadi hanya pihak yang memilikinya dapat menghasilkannya.
  const orderId = String(payload.order_id ?? '');
  const statusCode = String(payload.status_code ?? '');
  const grossAmount = String(payload.gross_amount ?? '');
  const provided = String(payload.signature_key ?? '');
  const expected = createHash('sha512')
    .update(`${orderId}${statusCode}${grossAmount}${config.secretKey}`, 'utf8')
    .digest('hex');
  if (!sameSecret(provided.toLowerCase(), expected)) return DITOLAK('error.webhook_signature_invalid');

  const status = String(payload.transaction_status ?? '').toLowerCase();
  const fraud = String(payload.fraud_status ?? 'accept').toLowerCase();
  // `capture` hanya lunas bila pemeriksaan penipuannya diterima; `challenge` menunggu
  // keputusan manual dan memperlakukannya sebagai lunas berarti membuka ruang kerja atas
  // pembayaran yang masih dapat dibatalkan.
  const paid = status === 'settlement' || (status === 'capture' && fraud === 'accept');
  return {
    ok: true,
    event: paid
      ? 'paid'
      : ['deny', 'cancel', 'expire', 'failure'].includes(status)
        ? 'failed'
        : 'ignored',
    invoiceId: orderId,
    reference: typeof payload.transaction_id === 'string' ? payload.transaction_id : null,
    methodLabel: paymentLabel(payload.payment_type, payload.bank),
  };
}

/** Nama cara bayar untuk dicetak di faktur; bukan string UI, jadi tidak diterjemahkan. */
function paymentLabel(primary: unknown, secondary: unknown): string | null {
  const parts = [primary, secondary]
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .map((v) => v.trim().toUpperCase());
  return parts.length > 0 ? parts.join(' · ') : null;
}
