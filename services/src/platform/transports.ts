/**
 * Transport notifikasi nyata: email (SMTP), WhatsApp, dan Telegram.
 *
 * Seluruhnya DIKONFIGURASI LEWAT VARIABEL LINGKUNGAN dan dibiarkan kosong secara bawaan.
 * Kanal yang tidak dikonfigurasi berperilaku persis seperti sebelumnya — mengantre tanpa
 * mengirim, dan MENGATAKANNYA (`delivered: false`). Itu keputusan sadar: "tercatat
 * terkirim" yang salah lebih berbahaya daripada kegagalan yang terlihat, terutama untuk
 * OTP dan kode pemulihan kata sandi.
 *
 * TANPA DEPENDENSI BARU. SMTP ditulis di atas `node:tls`/`node:net` alih-alih memakai
 * pustaka, karena satu paket yang gagal terpasang adalah masalah pemasangan nomor satu di
 * shared hosting — dan seluruh bentuk proyek ini memang menghindarinya. Risiko "menulis
 * klien protokol sendiri" dibayar dengan uji yang berbicara di tingkat socket terhadap
 * server SMTP tiruan, bukan dengan harapan.
 */
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { connect as netConnect, type Socket } from 'node:net';
import type { Channel, NotificationTransport } from '../alerting-service/index.ts';

/** Batas waktu satu percakapan SMTP. Koneksi yang menggantung tidak boleh menahan permintaan. */
export const SMTP_TIMEOUT_MS = 15_000;

export interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  /** Alamat pengirim; wajib, karena banyak server menolak MAIL FROM yang tidak dikenal. */
  from: string;
  /**
   * `true` = TLS langsung sejak koneksi (port 465). `false` = mulai polos lalu STARTTLS
   * (port 587). Keduanya terenkripsi — yang berbeda hanya kapan enkripsinya dimulai.
   */
  implicitTls: boolean;
  /**
   * Mengizinkan sertifikat yang tidak dapat diverifikasi.
   *
   * Ada karena sebagian shared hosting menyajikan sertifikat mail yang tidak cocok dengan
   * nama host-nya, dan tanpa jalan keluar ini operator akan terjebak. Bawaannya MATI, dan
   * menyalakannya berarti menerima bahwa lalu lintas dapat disadap oleh pihak yang dapat
   * menyisipkan diri — termasuk isi kode pemulihan kata sandi yang lewat di sana.
   */
  allowInsecureTls: boolean;
}

export interface TelegramConfig {
  botToken: string;
  apiBase: string;
}

export interface WebhookConfig {
  url: string;
  method: string;
  headers: Record<string, string>;
  /**
   * Badan permintaan dengan placeholder `{{recipient}}`, `{{subject}}`, `{{body}}`.
   *
   * Berbentuk template, BUKAN bentuk milik satu penyedia, karena "API WhatsApp" bukan satu
   * hal: WhatsApp Cloud API milik Meta, Fonnte, Wablas, dan Twilio semuanya berbeda bentuk
   * badannya. Menanam salah satu di kode berarti menebak penyedia mana yang dipakai, lalu
   * salah untuk semua yang lain.
   */
  bodyTemplate: string;
}

/* ================= Sanitasi ================= */

/**
 * Membuang CR/LF dari nilai yang akan masuk header SMTP.
 *
 * Tanpa ini, subjek atau alamat yang memuat baris baru dapat MENYISIPKAN header tambahan —
 * termasuk `Bcc:` — sehingga satu pesan dapat dialihkan ke penerima lain. Kanal ini
 * membawa OTP dan kode pemulihan kata sandi, jadi penyisipan header di sini setara dengan
 * penyerahan kunci akun.
 */
export function sanitiseHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Menyandikan subjek sebagai encoded-word RFC 2047 bila memuat karakter non-ASCII.
 *
 * Diperlukan karena subjek di sistem ini berbahasa Indonesia dan memuat karakter seperti
 * "—" atau "×". Tanpa penyandian, sebagian server memotong atau mengacaukannya, dan yang
 * diterima pengguna adalah subjek rusak — bukan kegagalan yang terlihat.
 */
export function encodeSubject(subject: string): string {
  const clean = sanitiseHeaderValue(subject);
  // eslint-disable-next-line no-control-regex
  if (!/[^\x20-\x7E]/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

/**
 * Dot-stuffing RFC 5321: baris yang dimulai dengan titik diberi titik tambahan.
 *
 * Tanpa ini, badan pesan yang kebetulan punya baris berawalan "." akan mengakhiri data
 * lebih awal — pesan terpotong, dan server tetap menjawab OK.
 */
export function stuffDots(body: string): string {
  return body.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

/* ================= SMTP ================= */

interface SmtpReply {
  code: number;
  text: string;
}

/**
 * Percakapan SMTP satu pesan.
 *
 * Sengaja minimal: satu penerima, badan teks polos, satu pesan per koneksi. Tidak ada
 * pooling, tidak ada lampiran. Menambah keduanya berarti menambah keadaan yang harus
 * benar di lingkungan yang me-recycle proses — dan yang dibutuhkan sistem ini adalah
 * mengirim beberapa pesan pendek per hari secara andal.
 */
export class SmtpTransport implements NotificationTransport {
  readonly delivers = true;

  constructor(private readonly config: SmtpConfig) {}

  async send(input: {
    channel: Channel;
    recipient: string;
    subject: string;
    body: string;
  }): Promise<{ delivered: boolean; failureReason?: string }> {
    const recipient = sanitiseHeaderValue(input.recipient);
    if (!recipient.includes('@')) return { delivered: false, failureReason: 'invalid_recipient' };

    let socket: Socket | TLSSocket | null = null;
    try {
      socket = await this.openSocket();
      const say = this.conversation(socket);

      await say(null, [220]);
      let greeting = await say(`EHLO ${this.hostnameForEhlo()}`, [250]);

      if (!this.config.implicitTls) {
        if (!/STARTTLS/i.test(greeting.text)) {
          // Menolak melanjutkan tanpa enkripsi. Mengirim kredensial dan kode pemulihan
          // dalam bentuk polos lebih buruk daripada tidak mengirim sama sekali.
          return { delivered: false, failureReason: 'server_without_starttls' };
        }
        await say('STARTTLS', [220]);
        socket = await this.upgradeToTls(socket);
        const secureSay = this.conversation(socket);
        greeting = await secureSay(`EHLO ${this.hostnameForEhlo()}`, [250]);
        return await this.deliver(secureSay, greeting, recipient, input);
      }

      return await this.deliver(say, greeting, recipient, input);
    } catch (error) {
      // Pesan kesalahan dari socket TIDAK memuat kredensial maupun badan pesan; hanya
      // ringkasannya yang dikembalikan supaya alasan kegagalan dapat dibaca operator
      // tanpa membocorkan isi OTP ke tabel outbox.
      return { delivered: false, failureReason: summariseError(error) };
    } finally {
      socket?.destroy();
    }
  }

  private async deliver(
    say: (line: string | null, expect: number[]) => Promise<SmtpReply>,
    greeting: SmtpReply,
    recipient: string,
    input: { subject: string; body: string },
  ): Promise<{ delivered: boolean; failureReason?: string }> {
    if (this.config.user && this.config.pass) {
      if (/AUTH[ -=][^\r\n]*PLAIN/i.test(greeting.text)) {
        const token = Buffer.from(`\0${this.config.user}\0${this.config.pass}`, 'utf8').toString('base64');
        await say(`AUTH PLAIN ${token}`, [235]);
      } else if (/AUTH[ -=][^\r\n]*LOGIN/i.test(greeting.text)) {
        await say('AUTH LOGIN', [334]);
        await say(Buffer.from(this.config.user, 'utf8').toString('base64'), [334]);
        await say(Buffer.from(this.config.pass, 'utf8').toString('base64'), [235]);
      } else {
        return { delivered: false, failureReason: 'server_without_supported_auth' };
      }
    }

    await say(`MAIL FROM:<${sanitiseHeaderValue(this.config.from)}>`, [250]);
    await say(`RCPT TO:<${recipient}>`, [250, 251]);
    await say('DATA', [354]);

    const headers = [
      `From: ${sanitiseHeaderValue(this.config.from)}`,
      `To: ${recipient}`,
      `Subject: ${encodeSubject(input.subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      `Date: ${new Date().toUTCString()}`,
    ].join('\r\n');

    await say(`${headers}\r\n\r\n${stuffDots(input.body)}\r\n.`, [250]);
    await say('QUIT', [221]).catch(() => undefined); // penutupan kasar bukan kegagalan kirim
    return { delivered: true };
  }

  /** Nama host untuk EHLO. Tidak perlu dapat diselesaikan DNS; harus ada dan tanpa spasi. */
  private hostnameForEhlo(): string {
    const domain = this.config.from.split('@')[1];
    return domain && /^[A-Za-z0-9.-]+$/.test(domain) ? domain : 'localhost';
  }

  private openSocket(): Promise<Socket | TLSSocket> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      const socket = this.config.implicitTls
        ? tlsConnect({
            host: this.config.host,
            port: this.config.port,
            rejectUnauthorized: !this.config.allowInsecureTls,
          })
        : netConnect({ host: this.config.host, port: this.config.port });

      socket.setTimeout(SMTP_TIMEOUT_MS, () => socket.destroy(new Error('smtp_timeout')));
      socket.once('error', onError);
      socket.once(this.config.implicitTls ? 'secureConnect' : 'connect', () => {
        socket.removeListener('error', onError);
        resolve(socket);
      });
    });
  }

  private upgradeToTls(plain: Socket | TLSSocket): Promise<TLSSocket> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      const secure = tlsConnect(
        {
          socket: plain as Socket,
          servername: this.config.host,
          rejectUnauthorized: !this.config.allowInsecureTls,
        },
        () => {
          secure.removeListener('error', onError);
          resolve(secure);
        },
      );
      secure.setTimeout(SMTP_TIMEOUT_MS, () => secure.destroy(new Error('smtp_timeout')));
      secure.once('error', onError);
    });
  }

  /**
   * Membuat fungsi percakapan atas sebuah socket.
   *
   * Balasan SMTP dapat berupa beberapa baris (`250-...` lalu `250 ...`); pembacaan
   * dianggap selesai hanya ketika baris terakhir memakai spasi, bukan tanda hubung.
   */
  private conversation(socket: Socket | TLSSocket): (line: string | null, expect: number[]) => Promise<SmtpReply> {
    let buffer = '';
    const pending: Array<{ expect: number[]; resolve: (r: SmtpReply) => void; reject: (e: Error) => void }> = [];

    const flush = (): void => {
      while (pending.length > 0) {
        const match = /^(?:\d{3}-[^\n]*\n)*(\d{3}) [^\n]*\n/.exec(buffer);
        if (!match) return;
        const chunk = buffer.slice(0, match[0].length);
        buffer = buffer.slice(match[0].length);
        const waiter = pending.shift()!;
        const code = Number(match[1]);
        if (waiter.expect.includes(code)) waiter.resolve({ code, text: chunk });
        else waiter.reject(new Error(`smtp_${code}`));
      }
    };

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8').replace(/\r\n/g, '\n');
      flush();
    });
    socket.on('error', (error: Error) => {
      while (pending.length > 0) pending.shift()!.reject(error);
    });
    socket.on('close', () => {
      while (pending.length > 0) pending.shift()!.reject(new Error('smtp_connection_closed'));
    });

    return (line, expect) =>
      new Promise<SmtpReply>((resolve, reject) => {
        pending.push({ expect, resolve, reject });
        flush();
        if (line !== null) socket.write(`${line}\r\n`);
      });
  }
}

/* ================= HTTP: Telegram & WhatsApp ================= */

/** Telegram Bot API. `recipient` adalah chat id, bukan nomor telepon. */
export class TelegramTransport implements NotificationTransport {
  readonly delivers = true;

  constructor(private readonly config: TelegramConfig) {}

  async send(input: { subject: string; body: string; recipient: string }): Promise<{
    delivered: boolean;
    failureReason?: string;
  }> {
    try {
      const response = await fetch(`${this.config.apiBase}/bot${this.config.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: input.recipient,
          text: input.subject ? `${input.subject}\n\n${input.body}` : input.body,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(SMTP_TIMEOUT_MS),
      });
      if (!response.ok) return { delivered: false, failureReason: `telegram_http_${response.status}` };
      return { delivered: true };
    } catch (error) {
      return { delivered: false, failureReason: summariseError(error) };
    }
  }
}

/**
 * Transport HTTP berbentuk template — dipakai untuk WhatsApp dan kanal lain.
 *
 * Bentuk badannya ditentukan operator, bukan ditanam di kode, karena "API WhatsApp" bukan
 * satu hal. Placeholder yang tersedia: `{{recipient}}`, `{{subject}}`, `{{body}}`, dan
 * masing-masing disisipkan sebagai string JSON yang sudah di-escape sehingga tanda kutip
 * atau baris baru di dalam pesan tidak merusak badan permintaan.
 */
export class WebhookTransport implements NotificationTransport {
  readonly delivers = true;

  constructor(
    private readonly config: WebhookConfig,
    private readonly label: string,
  ) {}

  async send(input: { subject: string; body: string; recipient: string }): Promise<{
    delivered: boolean;
    failureReason?: string;
  }> {
    const jsonEscape = (value: string): string => JSON.stringify(value).slice(1, -1);
    const body = this.config.bodyTemplate
      .replace(/\{\{recipient\}\}/g, jsonEscape(input.recipient))
      .replace(/\{\{subject\}\}/g, jsonEscape(input.subject))
      .replace(/\{\{body\}\}/g, jsonEscape(input.body));

    try {
      const response = await fetch(this.config.url, {
        method: this.config.method,
        headers: { 'Content-Type': 'application/json', ...this.config.headers },
        body,
        signal: AbortSignal.timeout(SMTP_TIMEOUT_MS),
      });
      if (!response.ok) return { delivered: false, failureReason: `${this.label}_http_${response.status}` };
      return { delivered: true };
    } catch (error) {
      return { delivered: false, failureReason: summariseError(error) };
    }
  }
}

/* ================= Perutean per kanal ================= */

/**
 * Meneruskan pesan ke transport sesuai kanalnya.
 *
 * Kanal yang tidak punya transport TIDAK dianggap terkirim — ia dijawab
 * `channel_not_configured`, sama jujurnya dengan sebelum ada transport sama sekali.
 * `delivers` bernilai true bila ADA setidaknya satu kanal terkonfigurasi, karena itulah
 * yang menentukan apakah pemanggil layak mencoba ulang.
 */
export class ChannelRoutingTransport implements NotificationTransport {
  readonly delivers: boolean;

  constructor(private readonly routes: Partial<Record<Channel, NotificationTransport>>) {
    this.delivers = Object.keys(routes).length > 0;
  }

  configuredChannels(): Channel[] {
    return Object.keys(this.routes) as Channel[];
  }

  canDeliver(channel: Channel): boolean {
    return this.routes[channel] !== undefined;
  }

  async send(input: {
    channel: Channel;
    recipient: string;
    subject: string;
    body: string;
  }): Promise<{ delivered: boolean; failureReason?: string }> {
    const transport = this.routes[input.channel];
    if (!transport) return { delivered: false, failureReason: 'channel_not_configured' };
    return transport.send(input);
  }
}

/* ================= Perakitan dari variabel lingkungan ================= */

function trimmed(value: string | undefined): string {
  return (value ?? '').trim();
}

/** Bentuk badan bawaan untuk WhatsApp Cloud API milik Meta. */
export const WHATSAPP_CLOUD_BODY_TEMPLATE =
  '{"messaging_product":"whatsapp","to":"{{recipient}}","type":"text",' +
  '"text":{"preview_url":false,"body":"{{subject}}\\n\\n{{body}}"}}';

/**
 * Merakit transport dari variabel lingkungan.
 *
 * Sebuah kanal aktif HANYA bila seluruh nilai wajibnya terisi. Konfigurasi setengah jadi
 * — host ada tetapi pengirim kosong — TIDAK diaktifkan, karena kanal yang aktif tetapi
 * pasti gagal hanya menghasilkan pesan berstatus `failed` yang membingungkan, sementara
 * `queued` menyatakan keadaan yang sebenarnya: belum dikonfigurasi.
 *
 * Mengembalikan `null` bila tidak ada satu pun kanal terkonfigurasi, sehingga pemanggil
 * dapat mempertahankan perilaku antre-tanpa-mengirim tanpa cabang khusus.
 */
export function transportFromEnv(env: NodeJS.ProcessEnv = process.env): ChannelRoutingTransport | null {
  const routes: Partial<Record<Channel, NotificationTransport>> = {};

  const smtpHost = trimmed(env.VANTIK_SMTP_HOST);
  const smtpFrom = trimmed(env.VANTIK_SMTP_FROM);
  if (smtpHost && smtpFrom) {
    const port = Number(trimmed(env.VANTIK_SMTP_PORT)) || 587;
    routes.email = new SmtpTransport({
      host: smtpHost,
      port,
      user: trimmed(env.VANTIK_SMTP_USER) || undefined,
      pass: trimmed(env.VANTIK_SMTP_PASSWORD) || undefined,
      from: smtpFrom,
      // Port 465 memakai TLS sejak koneksi; 587 memulai polos lalu STARTTLS. Dapat
      // dipaksa lewat VANTIK_SMTP_IMPLICIT_TLS untuk host yang tidak lazim.
      implicitTls: trimmed(env.VANTIK_SMTP_IMPLICIT_TLS)
        ? trimmed(env.VANTIK_SMTP_IMPLICIT_TLS).toLowerCase() === 'true'
        : port === 465,
      allowInsecureTls: trimmed(env.VANTIK_SMTP_ALLOW_INSECURE_TLS).toLowerCase() === 'true',
    });
  }

  const telegramToken = trimmed(env.VANTIK_TELEGRAM_BOT_TOKEN);
  if (telegramToken) {
    routes.telegram = new TelegramTransport({
      botToken: telegramToken,
      apiBase: trimmed(env.VANTIK_TELEGRAM_API_BASE) || 'https://api.telegram.org',
    });
  }

  const waUrl = trimmed(env.VANTIK_WHATSAPP_URL);
  if (waUrl) {
    let headers: Record<string, string> = {};
    const rawHeaders = trimmed(env.VANTIK_WHATSAPP_HEADERS);
    if (rawHeaders) {
      try {
        const parsed = JSON.parse(rawHeaders) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          headers = Object.fromEntries(
            Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
          );
        }
      } catch {
        // Header yang tidak dapat diurai DIABAIKAN, bukan menggagalkan boot: satu tanda
        // kutip yang salah di `.env` tidak boleh membuat seluruh aplikasi tidak menyala.
        headers = {};
      }
    }
    const token = trimmed(env.VANTIK_WHATSAPP_TOKEN);
    if (token && !Object.keys(headers).some((h) => h.toLowerCase() === 'authorization')) {
      headers.Authorization = `Bearer ${token}`;
    }
    routes.whatsapp = new WebhookTransport(
      {
        url: waUrl,
        method: trimmed(env.VANTIK_WHATSAPP_METHOD) || 'POST',
        headers,
        bodyTemplate: trimmed(env.VANTIK_WHATSAPP_BODY_TEMPLATE) || WHATSAPP_CLOUD_BODY_TEMPLATE,
      },
      'whatsapp',
    );
  }

  return Object.keys(routes).length > 0 ? new ChannelRoutingTransport(routes) : null;
}

/**
 * Ringkasan kesalahan yang aman dicatat.
 *
 * Sengaja hanya kode/nama, bukan pesan penuh: pesan kesalahan socket dan HTTP dapat
 * memuat URL berikut token di dalamnya, dan alasan kegagalan disimpan di tabel outbox
 * yang dapat dibaca operator.
 */
function summariseError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    if (code) return String(code).toLowerCase();
    if (/^smtp_/.test(error.message)) return error.message;
    return error.name === 'Error' ? 'send_failed' : error.name.toLowerCase();
  }
  return 'send_failed';
}
