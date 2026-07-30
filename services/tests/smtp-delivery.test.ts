/**
 * Pengiriman SMTP yang BERHASIL, diperiksa di kabel.
 *
 * Berkas ini menutup lubang yang membuat `transports.test.ts` lulus 20 kali tanpa pernah
 * membuktikan satu pesan pun terkirim: seluruh uji SMTP di sana berhenti pada penolakan
 * (server tanpa STARTTLS, penerima salah bentuk, koneksi gagal). Penolakan yang benar tidak
 * membuktikan pengirimannya benar — dan pada kanal yang membawa OTP serta kode pemulihan
 * kata sandi, "tidak pernah sampai" adalah cacat yang tidak melempar apa pun.
 *
 * **Batas kejujuran berkas ini:** `node:tls` DIGANTI supaya percakapan dapat diperiksa tanpa
 * sertifikat sungguhan — jadi yang diuji di sini adalah PROTOKOLNYA, bukan enkripsinya.
 * Keputusan soal enkripsi diuji di tempat lain dan tidak dilemahkan di sini: TC-TRN-07
 * membuktikan server tanpa STARTTLS ditolak, dan TC-TRN-18 membuktikan pemetaan port ke
 * mode TLS. Yang dibuktikan di sini adalah urutan perintah, isi header, dan bahwa kredensial
 * tidak pernah dikirim sebelum lapisan aman diminta.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';

/**
 * `node:tls` palsu.
 *
 * Dua bentuk pemakaian di `transports.ts` harus dilayani: koneksi TLS langsung (port 465)
 * dan peningkatan soket yang sudah ada (STARTTLS pada port 587). Keduanya di sini menjadi
 * soket polos — cukup untuk memeriksa percakapan, dan itulah satu-satunya klaim uji ini.
 */
vi.mock('node:tls', async () => {
  const net = await import('node:net');
  return {
    connect: (options: Record<string, unknown>, callback?: () => void): unknown => {
      if (options.socket) {
        // STARTTLS: soket yang sama dipakai apa adanya.
        if (callback) setImmediate(callback);
        return options.socket;
      }
      const socket = net.connect({ host: String(options.host), port: Number(options.port) });
      socket.once('connect', () => {
        callback?.();
        socket.emit('secureConnect');
      });
      return socket;
    },
  };
});

const { SmtpTransport } = await import('../src/platform/transports.ts');

/* ================= Server SMTP tiruan ================= */

interface Tiruan {
  port: number;
  /** Perintah yang diterima, di luar fase DATA. */
  perintah: string[];
  /** Badan pesan lengkap per pesan yang selesai. */
  pesan: string[];
  close: () => Promise<void>;
}

async function serverTiruan(
  options: { capabilities?: string[]; tolakPada?: string } = {},
): Promise<Tiruan> {
  const perintah: string[] = [];
  const pesan: string[] = [];
  const caps = options.capabilities ?? ['STARTTLS', 'AUTH PLAIN LOGIN'];
  let balasanBase64 = 0;

  const server: Server = createServer((socket: Socket) => {
    let sisa = '';
    let dalamData = false;
    let badan = '';
    socket.write('220 tiruan.vantik.test ESMTP\r\n');

    socket.on('data', (chunk: Buffer) => {
      sisa += chunk.toString('utf8');
      let batas: number;
      while ((batas = sisa.indexOf('\r\n')) >= 0) {
        const baris = sisa.slice(0, batas);
        sisa = sisa.slice(batas + 2);

        if (dalamData) {
          if (baris === '.') {
            dalamData = false;
            pesan.push(badan);
            badan = '';
            socket.write('250 2.0.0 diterima\r\n');
          } else {
            badan += `${baris}\n`;
          }
          continue;
        }

        perintah.push(baris);
        const kata = baris.split(' ')[0]?.toUpperCase() ?? '';

        if (options.tolakPada && baris.toUpperCase().startsWith(options.tolakPada.toUpperCase())) {
          socket.write('535 5.7.8 ditolak\r\n');
          continue;
        }

        if (kata === 'EHLO') {
          socket.write('250-tiruan.vantik.test\r\n');
          for (const cap of caps) socket.write(`250-${cap}\r\n`);
          socket.write('250 SIZE 10240000\r\n');
        } else if (kata === 'STARTTLS') {
          socket.write('220 2.0.0 siap memulai TLS\r\n');
        } else if (kata === 'AUTH') {
          if (/^AUTH LOGIN$/i.test(baris)) {
            balasanBase64 = 0;
            socket.write('334 VXNlcm5hbWU6\r\n');
          } else socket.write('235 2.7.0 diterima\r\n');
        } else if (kata === 'MAIL' || kata === 'RCPT') {
          socket.write('250 2.1.0 ok\r\n');
        } else if (kata === 'DATA') {
          dalamData = true;
          socket.write('354 mulai kirim data\r\n');
        } else if (kata === 'QUIT') {
          socket.write('221 2.0.0 selamat tinggal\r\n');
          socket.end();
        } else {
          // Balasan base64 pada AUTH LOGIN bertahap: pengguna dulu, lalu kata sandi.
          balasanBase64 += 1;
          socket.write(balasanBase64 >= 2 ? '235 2.7.0 diterima\r\n' : '334 UGFzc3dvcmQ6\r\n');
        }
      }
    });
    socket.on('error', () => undefined);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    port: typeof address === 'object' && address ? address.port : 0,
    perintah,
    pesan,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const server: Tiruan[] = [];
afterEach(async () => {
  for (const s of server.splice(0)) await s.close();
});

let tiruan: Tiruan;
beforeEach(async () => {
  tiruan = await serverTiruan();
  server.push(tiruan);
});

function kirim(
  overrides: Record<string, unknown> = {},
  pesan: Partial<{ recipient: string; subject: string; body: string }> = {},
) {
  return new SmtpTransport({
    host: '127.0.0.1',
    port: tiruan.port,
    from: 'notifikasi@vantik.test',
    user: 'notifikasi@vantik.test',
    pass: 'kata-sandi-smtp-rahasia',
    implicitTls: false,
    allowInsecureTls: true,
    ...overrides,
  } as never).send({
    channel: 'email',
    recipient: pesan.recipient ?? 'tujuan@contoh.test',
    subject: pesan.subject ?? 'Pemulihan kata sandi',
    body: pesan.body ?? 'Kode Anda: 123456',
  });
}

/* ================= Jalur berhasil ================= */

describe('Pengiriman berhasil', () => {
  it('TC-SMD-01 — STARTTLS: urutan perintahnya benar dan pesan diterima', async () => {
    const hasil = await kirim();

    expect(hasil).toEqual({ delivered: true });
    const urutan = tiruan.perintah.map((p) => p.split(' ')[0]?.toUpperCase());
    // EHLO diulang setelah STARTTLS — wajib menurut RFC 3207, karena kemampuan yang
    // diumumkan sebelum enkripsi tidak boleh dipercaya.
    expect(urutan).toEqual(['EHLO', 'STARTTLS', 'EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
    expect(tiruan.pesan).toHaveLength(1);
  });

  it('TC-SMD-02 — kredensial dikirim SETELAH STARTTLS, bukan sebelumnya', async () => {
    await kirim();

    const indeksStarttls = tiruan.perintah.findIndex((p) => /^STARTTLS/i.test(p));
    const indeksAuth = tiruan.perintah.findIndex((p) => /^AUTH/i.test(p));
    expect(indeksStarttls).toBeGreaterThanOrEqual(0);
    expect(indeksAuth).toBeGreaterThan(indeksStarttls);

    // Bentuk AUTH PLAIN: \0pengguna\0sandi.
    const auth = tiruan.perintah[indeksAuth]!.replace(/^AUTH PLAIN /i, '');
    expect(Buffer.from(auth, 'base64').toString('utf8')).toBe('\0notifikasi@vantik.test\0kata-sandi-smtp-rahasia');
  });

  it('TC-SMD-03 — TLS langsung (port 465) tidak memakai STARTTLS', async () => {
    const hasil = await kirim({ implicitTls: true });

    expect(hasil).toEqual({ delivered: true });
    expect(tiruan.perintah.some((p) => /^STARTTLS/i.test(p))).toBe(false);
    expect(tiruan.pesan).toHaveLength(1);
  });

  it('TC-SMD-04 — header pesan lengkap dan subjek non-ASCII disandikan di kabel', async () => {
    await kirim({}, { subject: 'Langganan berakhir — 7 hari' });

    const badan = tiruan.pesan[0]!;
    expect(badan).toContain('From: notifikasi@vantik.test');
    expect(badan).toContain('To: tujuan@contoh.test');
    expect(badan).toContain('Content-Type: text/plain; charset=UTF-8');
    // Yang lewat di kabel adalah encoded-word, bukan UTF-8 mentah: sebagian server
    // memotong subjek non-ASCII dan pengguna menerima subjek rusak tanpa kesalahan apa pun.
    const subjek = badan.split('\n').find((l) => l.startsWith('Subject:'))!;
    expect(subjek).toMatch(/^Subject: =\?UTF-8\?B\?/);
    expect(Buffer.from(subjek.slice(19, -2), 'base64').toString('utf8')).toBe('Langganan berakhir — 7 hari');
  });

  it('TC-SMD-05 — baris berawalan titik tidak memotong pesan', async () => {
    await kirim({}, { body: 'baris satu\n.\nbaris tiga' });

    const badan = tiruan.pesan[0]!;
    // Titik tunggal di kabel menjadi dua titik; tanpa itu server menganggap pesan selesai
    // di baris itu dan tetap menjawab OK — pesan terpotong tanpa ada yang tahu.
    expect(badan).toContain('\n..\n');
    expect(badan).toContain('baris tiga');
    expect(tiruan.pesan).toHaveLength(1);
  });

  it('TC-SMD-06 — subjek yang menyisipkan header TIDAK menghasilkan Bcc di kabel', async () => {
    const hasil = await kirim({}, { subject: 'Kode Anda\r\nBcc: penyerang@luar.test' });

    // Diperiksa pada pengiriman yang BERHASIL: inilah satu-satunya keadaan di mana header
    // sungguhan sampai ke server, jadi inilah satu-satunya tempat penyisipan dapat terbukti
    // gagal. Pemeriksaan pada koneksi yang gagal handshake tidak membuktikan apa pun.
    expect(hasil.delivered).toBe(true);
    const badan = tiruan.pesan[0]!;
    expect(badan).not.toMatch(/^Bcc:/im);
    const barisSubjek = badan.split('\n').filter((l) => l.startsWith('Subject:'));
    expect(barisSubjek).toHaveLength(1);
    expect(barisSubjek[0]).toContain('penyerang@luar.test'); // jadi teks subjek, bukan header
  });

  it('TC-SMD-07 — AUTH LOGIN bertahap dipakai bila server tidak menawarkan PLAIN', async () => {
    await tiruan.close();
    server.length = 0;
    tiruan = await serverTiruan({ capabilities: ['STARTTLS', 'AUTH LOGIN'] });
    server.push(tiruan);

    const hasil = await kirim();

    expect(hasil).toEqual({ delivered: true });
    const setelahAuth = tiruan.perintah.slice(tiruan.perintah.findIndex((p) => /^AUTH LOGIN$/i.test(p)));
    // Pengguna lalu kata sandi, masing-masing base64 pada barisnya sendiri.
    expect(Buffer.from(setelahAuth[1]!, 'base64').toString('utf8')).toBe('notifikasi@vantik.test');
    expect(Buffer.from(setelahAuth[2]!, 'base64').toString('utf8')).toBe('kata-sandi-smtp-rahasia');
  });
});

/* ================= Penolakan di tengah percakapan ================= */

describe('Penolakan server', () => {
  it('TC-SMD-08 — AUTH ditolak: kode server dilaporkan dan DATA tidak pernah dikirim', async () => {
    await tiruan.close();
    server.length = 0;
    tiruan = await serverTiruan({ tolakPada: 'AUTH' });
    server.push(tiruan);

    const hasil = await kirim();

    expect(hasil.delivered).toBe(false);
    expect(hasil.failureReason).toBe('smtp_535');
    expect(tiruan.pesan).toHaveLength(0);
    // Alasan yang tercatat hanya kode: ia disimpan di tabel outbox yang dapat dibaca operator.
    expect(hasil.failureReason).not.toContain('kata-sandi-smtp-rahasia');
  });

  it('TC-SMD-09 — penerima ditolak: pesan tidak dikirim ke siapa pun', async () => {
    await tiruan.close();
    server.length = 0;
    tiruan = await serverTiruan({ tolakPada: 'RCPT' });
    server.push(tiruan);

    const hasil = await kirim();

    expect(hasil).toEqual({ delivered: false, failureReason: 'smtp_535' });
    expect(tiruan.pesan).toHaveLength(0);
  });

  it('TC-SMD-10 — isi pesan tidak muncul di alasan kegagalan', async () => {
    await tiruan.close();
    server.length = 0;
    tiruan = await serverTiruan({ tolakPada: 'MAIL' });
    server.push(tiruan);

    const hasil = await kirim({}, { body: 'Kode pemulihan: 987654' });

    expect(hasil.delivered).toBe(false);
    expect(String(hasil.failureReason)).not.toContain('987654');
  });
});
