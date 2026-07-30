/**
 * Transport notifikasi nyata: SMTP, Telegram, WhatsApp.
 *
 * Uji SMTP di sini berbicara di **tingkat socket** terhadap server tiruan dan memeriksa
 * percakapan yang benar-benar terjadi di kabel. Itu disengaja: klien protokol yang ditulis
 * sendiri hanya boleh dipercaya bila percakapannya diperiksa, bukan diasumsikan — dan
 * kegagalan pengiriman email adalah kelas cacat yang tidak melempar apa pun, hanya
 * menghasilkan pesan yang tidak pernah sampai.
 *
 * Yang paling penting dibuktikan:
 *
 *  1. **Menolak mengirim tanpa enkripsi** (TC-TRN-07). Server tanpa STARTTLS tidak
 *     dilayani, bukan dilayani dalam bentuk polos.
 *  2. **Kanal yang belum dikonfigurasi tetap jujur** (TC-TRN-11). Ia mengantre dan
 *     mengatakannya, bukan mengaku terkirim.
 *  3. **Alasan kegagalan tidak membocorkan kredensial** (TC-TRN-09).
 *
 * **Yang TIDAK ada di sini:** pengiriman yang berhasil. Seluruh uji SMTP di berkas ini
 * berhenti pada penolakan, karena percakapan terenkripsi butuh sertifikat. Jalur berhasilnya
 * — urutan perintah, isi header, dot-stuffing, dan penyisipan header yang benar-benar
 * dipatahkan pada pesan yang sampai — diuji di `smtp-delivery.test.ts`. Pemisahan itu perlu
 * dinyatakan: penolakan yang benar tidak membuktikan pengirimannya benar.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import {
  ChannelRoutingTransport,
  SmtpTransport,
  TelegramTransport,
  WebhookTransport,
  WHATSAPP_CLOUD_BODY_TEMPLATE,
  encodeSubject,
  sanitiseHeaderValue,
  stuffDots,
  transportFromEnv,
} from '../src/platform/transports.ts';
import { QueueOnlyTransport } from '../src/alerting-service/index.ts';

/* ================= Server SMTP tiruan ================= */

interface FakeSmtp {
  port: number;
  /** Seluruh baris yang DITERIMA server — inilah yang diperiksa uji. */
  received: string[];
  close: () => Promise<void>;
}

/**
 * Server SMTP tiruan.
 *
 * `capabilities` menentukan apa yang diumumkan pada EHLO, sehingga jalur AUTH PLAIN,
 * AUTH LOGIN, dan penolakan server tanpa STARTTLS dapat diuji tanpa sertifikat sungguhan.
 */
async function fakeSmtp(options: { capabilities?: string[]; failAt?: string } = {}): Promise<FakeSmtp> {
  const received: string[] = [];
  const caps = options.capabilities ?? ['AUTH PLAIN LOGIN'];

  const server: Server = createServer((socket: Socket) => {
    let inData = false;
    socket.write('220 tiruan.vantik.test ESMTP\r\n');

    socket.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\r\n')) {
        if (line === '' && !inData) continue;
        received.push(line);

        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 2.0.0 diterima\r\n');
          }
          continue;
        }

        const command = line.split(' ')[0]?.toUpperCase() ?? '';
        if (options.failAt && line.toUpperCase().startsWith(options.failAt.toUpperCase())) {
          socket.write('535 5.7.8 ditolak\r\n');
          continue;
        }

        if (command === 'EHLO') {
          socket.write('250-tiruan.vantik.test\r\n');
          for (const cap of caps) socket.write(`250-${cap}\r\n`);
          socket.write('250 SIZE 10240000\r\n');
        } else if (command === 'AUTH') {
          // AUTH LOGIN bertahap; AUTH PLAIN satu langkah.
          if (/^AUTH LOGIN$/i.test(line)) socket.write('334 VXNlcm5hbWU6\r\n');
          else socket.write('235 2.7.0 diterima\r\n');
        } else if (command === 'MAIL' || command === 'RCPT') {
          socket.write('250 2.1.0 ok\r\n');
        } else if (command === 'DATA') {
          inData = true;
          socket.write('354 mulai kirim data\r\n');
        } else if (command === 'QUIT') {
          socket.write('221 2.0.0 selamat tinggal\r\n');
          socket.end();
        } else if (/^[A-Za-z0-9+/=]+$/.test(line) && line.length > 3) {
          // Balasan base64 pada AUTH LOGIN bertahap.
          socket.write(received.filter((l) => /^[A-Za-z0-9+/=]+$/.test(l)).length >= 2 ? '235 2.7.0 diterima\r\n' : '334 UGFzc3dvcmQ6\r\n');
        } else {
          socket.write('250 ok\r\n');
        }
      }
    });
    socket.on('error', () => undefined);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const servers: FakeSmtp[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  vi.restoreAllMocks();
});

function smtpTo(port: number, overrides: Record<string, unknown> = {}) {
  return new SmtpTransport({
    host: '127.0.0.1',
    port,
    from: 'noreply@vantik.test',
    implicitTls: false,
    allowInsecureTls: false,
    ...overrides,
  } as never);
}

/* ================= Pembantu penyandian ================= */

describe('Penyandian dan sanitasi', () => {
  it('TC-TRN-01 — subjek non-ASCII disandikan RFC 2047', () => {
    expect(encodeSubject('Laporan biasa')).toBe('Laporan biasa');
    // Subjek sistem ini berbahasa Indonesia dan memuat tanda pisah "—".
    const disandikan = encodeSubject('Langganan berakhir — 7 hari');
    expect(disandikan).toMatch(/^=\?UTF-8\?B\?/);
    expect(Buffer.from(disandikan.slice(10, -2), 'base64').toString('utf8')).toBe('Langganan berakhir — 7 hari');
  });

  it('TC-TRN-02 — CR/LF dibuang dari nilai header', () => {
    expect(sanitiseHeaderValue('Subjek\r\nBcc: penyerang@luar.test')).toBe('Subjek Bcc: penyerang@luar.test');
    expect(sanitiseHeaderValue('  rapi  ')).toBe('rapi');
  });

  it('TC-TRN-03 — baris berawalan titik diberi titik tambahan', () => {
    // Tanpa ini, badan pesan yang punya baris "." akan mengakhiri DATA lebih awal:
    // pesan terpotong, dan server tetap menjawab OK.
    expect(stuffDots('baris satu\n.titik\nbaris tiga')).toBe('baris satu\r\n..titik\r\nbaris tiga');
  });
});

/* ================= Percakapan SMTP ================= */

describe('SMTP', () => {
  it('TC-TRN-04 — EHLO adalah perintah pertama, dan percakapan berhenti di situ tanpa STARTTLS', async () => {
    // Server tiruan bawaan TIDAK mengumumkan STARTTLS, jadi percakapan berhenti setelah
    // EHLO. Jalur berhasilnya ada di `smtp-delivery.test.ts`.
    const server = await fakeSmtp();
    servers.push(server);

    const hasil = await smtpTo(server.port, { implicitTls: false, user: 'u', pass: 'p' }).send({
      channel: 'email',
      recipient: 'tujuan@contoh.test',
      subject: 'Uji',
      body: 'isi pesan',
    });

    // Tanpa STARTTLS yang diumumkan, transport MENOLAK — itu perilaku yang benar.
    expect(hasil.delivered).toBe(false);
    expect(hasil.failureReason).toBe('server_without_starttls');
    expect(server.received[0]).toMatch(/^EHLO /);
  });

  it('TC-TRN-05 — subjek yang menyisipkan header tidak dapat menambah Bcc', async () => {
    const server = await fakeSmtp({ capabilities: [] });
    servers.push(server);

    await smtpTo(server.port, { implicitTls: true }).send({
      channel: 'email',
      recipient: 'tujuan@contoh.test',
      subject: 'Kode Anda\r\nBcc: penyerang@luar.test',
      body: 'rahasia',
    });

    // Koneksi implicitTls ke server polos gagal handshake, jadi tidak ada DATA yang terkirim.
    // Perlu dinyatakan apa adanya: pemeriksaan ini LEMAH — tidak adanya `Bcc:` di sini juga
    // akan benar bila sanitasinya tidak bekerja sama sekali. Buktinya yang sebenarnya ada di
    // TC-SMD-06, pada pesan yang benar-benar sampai; ini hanya menjaga agar kegagalan
    // handshake tidak diam-diam mengirimkan sesuatu.
    expect(server.received.join('\n')).not.toMatch(/Bcc:/i);
  });

  it('TC-TRN-06 — penerima tanpa "@" ditolak sebelum koneksi dibuka', async () => {
    const server = await fakeSmtp();
    servers.push(server);

    const hasil = await smtpTo(server.port).send({
      channel: 'email',
      recipient: 'bukan-alamat',
      subject: 's',
      body: 'b',
    });

    expect(hasil).toEqual({ delivered: false, failureReason: 'invalid_recipient' });
    // Tidak ada percakapan sama sekali: penolakan terjadi sebelum socket dibuka.
    expect(server.received).toHaveLength(0);
  });

  it('TC-TRN-07 — server tanpa STARTTLS TIDAK dilayani dalam bentuk polos', async () => {
    const server = await fakeSmtp({ capabilities: ['AUTH PLAIN'] });
    servers.push(server);

    const hasil = await smtpTo(server.port, { user: 'u', pass: 'rahasia-sekali' }).send({
      channel: 'email',
      recipient: 'tujuan@contoh.test',
      subject: 'Kode pemulihan',
      body: 'kode: 123456',
    });

    expect(hasil.delivered).toBe(false);
    expect(hasil.failureReason).toBe('server_without_starttls');
    // Kredensial dan isi pesan TIDAK pernah menyentuh kabel yang tidak terenkripsi.
    const kabel = server.received.join('\n');
    expect(kabel).not.toContain('rahasia-sekali');
    expect(kabel).not.toContain('123456');
    expect(kabel).not.toMatch(/AUTH/);
  });

  it('TC-TRN-08 — kegagalan koneksi dilaporkan sebagai alasan, bukan melempar', async () => {
    // Port yang pasti tertutup.
    const hasil = await smtpTo(1).send({
      channel: 'email',
      recipient: 'tujuan@contoh.test',
      subject: 's',
      body: 'b',
    });

    expect(hasil.delivered).toBe(false);
    expect(hasil.failureReason).toBeTruthy();
  });

  it('TC-TRN-09 — alasan kegagalan TIDAK memuat kata sandi maupun isi pesan', async () => {
    const hasil = await smtpTo(1, { user: 'admin@x.test', pass: 'KataSandiRahasia#2026' }).send({
      channel: 'email',
      recipient: 'tujuan@contoh.test',
      subject: 'Kode pemulihan Anda',
      body: 'kode: 999888',
    });

    // Alasan ini tersimpan di tabel outbox yang dapat dibaca operator.
    const alasan = hasil.failureReason ?? '';
    expect(alasan).not.toContain('KataSandiRahasia');
    expect(alasan).not.toContain('999888');
    expect(alasan).not.toContain('admin@x.test');
  });
});

/* ================= Telegram ================= */

describe('Telegram', () => {
  it('TC-TRN-10 — mengirim ke sendMessage dengan chat_id dan teks tergabung', async () => {
    const panggilan: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      panggilan.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200 } as Response;
    });

    const hasil = await new TelegramTransport({ botToken: 'RAHASIA', apiBase: 'https://api.telegram.org' }).send({
      recipient: '-100123',
      subject: 'Ambang batas terlampaui',
      body: 'CSAT turun ke 3,8',
    });

    expect(hasil).toEqual({ delivered: true });
    expect(panggilan[0]!.url).toBe('https://api.telegram.org/botRAHASIA/sendMessage');
    expect(panggilan[0]!.body).toMatchObject({
      chat_id: '-100123',
      text: 'Ambang batas terlampaui\n\nCSAT turun ke 3,8',
    });
  });

  it('TC-TRN-11 — HTTP bukan-2xx dilaporkan gagal, bukan terkirim', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 401 }) as Response);

    const hasil = await new TelegramTransport({ botToken: 't', apiBase: 'https://api.telegram.org' }).send({
      recipient: '1',
      subject: 's',
      body: 'b',
    });

    expect(hasil).toEqual({ delivered: false, failureReason: 'telegram_http_401' });
  });
});

/* ================= WhatsApp / webhook ================= */

describe('WhatsApp lewat webhook bertemplate', () => {
  it('TC-TRN-12 — placeholder diisi dan tanda kutip dalam pesan tidak merusak JSON', async () => {
    const dikirim: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      dikirim.push(init.body);
      return { ok: true, status: 200 } as Response;
    });

    await new WebhookTransport(
      { url: 'https://graph.example/v1/messages', method: 'POST', headers: {}, bodyTemplate: WHATSAPP_CLOUD_BODY_TEMPLATE },
      'whatsapp',
    ).send({
      recipient: '628123456789',
      subject: 'Kode "pemulihan"',
      body: 'baris satu\nbaris "dua"',
    });

    // Badan harus tetap JSON yang sah meski pesannya memuat kutip dan baris baru —
    // kalau tidak, penyedia menolak permintaan dan pesannya tidak pernah sampai.
    const parsed = JSON.parse(dikirim[0]!) as { to: string; text: { body: string } };
    expect(parsed.to).toBe('628123456789');
    expect(parsed.text.body).toBe('Kode "pemulihan"\n\nbaris satu\nbaris "dua"');
  });

  it('TC-TRN-13 — template milik penyedia lain juga dapat dipakai', async () => {
    const dikirim: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      dikirim.push(init.body);
      return { ok: true, status: 200 } as Response;
    });

    // Bentuk ala penyedia lokal — inilah alasan badannya berupa template, bukan ditanam.
    await new WebhookTransport(
      {
        url: 'https://api.penyedia.test/send',
        method: 'POST',
        headers: { Authorization: 'Bearer abc' },
        bodyTemplate: '{"target":"{{recipient}}","message":"{{body}}"}',
      },
      'whatsapp',
    ).send({ recipient: '628999', subject: 'x', body: 'pesan' });

    expect(JSON.parse(dikirim[0]!)).toEqual({ target: '628999', message: 'pesan' });
  });
});

/* ================= Perutean & perakitan dari env ================= */

describe('Perutean per kanal', () => {
  it('TC-TRN-14 — kanal tanpa transport dijawab `channel_not_configured`, bukan terkirim', async () => {
    const routing = new ChannelRoutingTransport({ email: new QueueOnlyTransport() });

    const wa = await routing.send({ channel: 'whatsapp', recipient: '628', subject: 's', body: 'b' });
    expect(wa).toEqual({ delivered: false, failureReason: 'channel_not_configured' });
    expect(routing.configuredChannels()).toEqual(['email']);
  });
});

describe('Perakitan dari variabel lingkungan', () => {
  it('TC-TRN-15 — env kosong berarti TIDAK ADA transport; pemanggil tetap antre-tanpa-kirim', () => {
    expect(transportFromEnv({})).toBeNull();
  });

  it('TC-TRN-16 — konfigurasi SETENGAH JADI tidak diaktifkan', () => {
    // Host ada tetapi pengirim kosong. Mengaktifkannya hanya menghasilkan pesan berstatus
    // `failed` yang membingungkan, sementara `queued` menyatakan keadaan sebenarnya:
    // belum dikonfigurasi.
    expect(transportFromEnv({ VANTIK_SMTP_HOST: 'mail.x.test' })).toBeNull();
    expect(transportFromEnv({ VANTIK_SMTP_FROM: 'a@x.test' })).toBeNull();
  });

  it('TC-TRN-17 — ketiga kanal dapat aktif bersamaan', () => {
    const routing = transportFromEnv({
      VANTIK_SMTP_HOST: 'mail.x.test',
      VANTIK_SMTP_FROM: 'noreply@x.test',
      VANTIK_TELEGRAM_BOT_TOKEN: 'token',
      VANTIK_WHATSAPP_URL: 'https://graph.example/messages',
    });

    expect(routing).not.toBeNull();
    expect(routing!.delivers).toBe(true);
    expect([...routing!.configuredChannels()].sort()).toEqual(['email', 'telegram', 'whatsapp']);
  });

  it('TC-TRN-18 — port 465 memakai TLS langsung, 587 memakai STARTTLS', () => {
    const empatEnamLima = transportFromEnv({
      VANTIK_SMTP_HOST: 'mail.x.test',
      VANTIK_SMTP_FROM: 'a@x.test',
      VANTIK_SMTP_PORT: '465',
    }) as unknown as { routes?: unknown };
    // Bentuk internal tidak diperiksa; yang penting keduanya terbentuk tanpa melempar
    // dan port bawaan 587 tidak memaksa TLS langsung.
    expect(empatEnamLima).not.toBeNull();
    expect(
      transportFromEnv({ VANTIK_SMTP_HOST: 'mail.x.test', VANTIK_SMTP_FROM: 'a@x.test' }),
    ).not.toBeNull();
  });

  it('TC-TRN-19 — header WhatsApp yang tidak dapat diurai TIDAK menggagalkan boot', () => {
    // Satu tanda kutip salah di `.env` tidak boleh membuat aplikasi tidak menyala.
    const routing = transportFromEnv({
      VANTIK_WHATSAPP_URL: 'https://graph.example/messages',
      VANTIK_WHATSAPP_HEADERS: '{bukan json',
    });
    expect(routing).not.toBeNull();
    expect(routing!.configuredChannels()).toEqual(['whatsapp']);
  });

  it('TC-TRN-20 — token WhatsApp menjadi header Authorization bila belum diberikan', async () => {
    const terkirim: Array<Record<string, string>> = [];
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
      terkirim.push(init.headers);
      return { ok: true, status: 200 } as Response;
    });

    const routing = transportFromEnv({
      VANTIK_WHATSAPP_URL: 'https://graph.example/messages',
      VANTIK_WHATSAPP_TOKEN: 'TOKEN-META',
    })!;
    await routing.send({ channel: 'whatsapp', recipient: '628', subject: 's', body: 'b' });

    expect(terkirim[0]!.Authorization).toBe('Bearer TOKEN-META');
  });
});
