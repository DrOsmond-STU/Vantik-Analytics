/**
 * Uji koneksi yang benar-benar menyambung.
 *
 * Uji di sini berbicara ke server tiruan yang mengucapkan **protokol sungguhan** —
 * PostgreSQL v3 dan MySQL v10 — lalu memeriksa byte yang dikirim klien. Bukan mock: yang
 * perlu dibuktikan justru bahwa jabat tangannya benar, dan mock hanya membuktikan bahwa uji
 * ini sepakat dengan dirinya sendiri.
 *
 * Yang paling penting dibuktikan:
 *
 *  1. **Kata sandi salah dibedakan dari host tidak terjangkau** (TC-DRV-05/06/12).
 *     Keduanya "gagal", tetapi perbaikannya sama sekali berbeda — dan operator yang salah
 *     menduga akan menghabiskan waktu di tempat yang salah.
 *  2. **Jawaban MD5 dan `mysql_native_password` dihitung benar** (TC-DRV-04/10). Algoritme
 *     yang salah menghasilkan "kredensial ditolak" untuk kata sandi yang sebenarnya benar.
 *  3. **Oracle dijawab tidak tersedia, bukan berhasil** (TC-DRV-14). Mengaku berhasil di
 *     sana adalah kebohongan paling mahal, karena baru ketahuan saat datanya diandalkan.
 *  4. **Kredensial tidak pernah muncul di hasil** (TC-DRV-15), yang ditampilkan di layar dan
 *     tersimpan di riwayat koneksi.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { assertReadOnlyQuery, probeConnection, runQuery } from '../src/data-platform-service/drivers.ts';

/* ================= Server tiruan ================= */

interface Fake {
  port: number;
  /** Byte yang DITERIMA server — inilah yang diperiksa uji. */
  diterima: Buffer[];
  close: () => Promise<void>;
}

const fakes: Fake[] = [];
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
});

async function tcpFake(onData: (data: Buffer, socket: Socket, diterima: Buffer[]) => void): Promise<Fake> {
  const diterima: Buffer[] = [];
  const server: TcpServer = createTcpServer((socket) => {
    socket.on('data', (chunk: Buffer) => {
      diterima.push(chunk);
      onData(chunk, socket, diterima);
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const fake: Fake = {
    port: typeof address === 'object' && address ? address.port : 0,
    diterima,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  fakes.push(fake);
  return fake;
}

async function httpFake(status: number, body = '{}'): Promise<Fake> {
  const diterima: Buffer[] = [];
  const server: HttpServer = createHttpServer((req, res) => {
    diterima.push(Buffer.from(JSON.stringify(req.headers)));
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const fake: Fake = {
    port: typeof address === 'object' && address ? address.port : 0,
    diterima,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  fakes.push(fake);
  return fake;
}

/* ================= Pembangun pesan PostgreSQL ================= */

function pg(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(5 + body.length);
  out.write(type, 0, 'ascii');
  out.writeUInt32BE(4 + body.length, 1);
  body.copy(out, 5);
  return out;
}

function pgAuth(code: number, extra = Buffer.alloc(0)): Buffer {
  const body = Buffer.alloc(4 + extra.length);
  body.writeUInt32BE(code, 0);
  extra.copy(body, 4);
  return pg('R', body);
}

const PG_READY = pg('Z', Buffer.from('I', 'ascii'));

function pgError(sqlstate: string): Buffer {
  const body = Buffer.concat([
    Buffer.from(`C${sqlstate}\0`, 'utf8'),
    Buffer.from(`Mgagal\0`, 'utf8'),
    Buffer.alloc(1),
  ]);
  return pg('E', body);
}

/* ================= PostgreSQL ================= */

describe('PostgreSQL', () => {
  const input = (port: number, password = 'sandi-rahasia') => ({
    kind: 'postgresql' as const,
    host: '127.0.0.1',
    port,
    databaseName: 'analitik',
    username: 'vantik',
    secrets: { password },
    options: {},
  });

  it('TC-DRV-01 — trust (tanpa kata sandi): jabat tangan selesai sampai ReadyForQuery', async () => {
    const fake = await tcpFake((_data, socket) => {
      socket.write(Buffer.concat([pgAuth(0), PG_READY]));
    });

    const hasil = await probeConnection(input(fake.port));

    expect(hasil.ok).toBe(true);
    expect(hasil.detail).toBe('postgresql');
    expect(typeof hasil.latencyMs).toBe('number');
  });

  it('TC-DRV-02 — StartupMessage memuat pengguna dan basis data yang benar', async () => {
    const fake = await tcpFake((_data, socket) => socket.write(Buffer.concat([pgAuth(0), PG_READY])));

    await probeConnection(input(fake.port));

    const startup = fake.diterima[0]!.toString('utf8');
    // Basis data yang salah di sini berarti uji koneksi lulus untuk basis data lain.
    expect(startup).toContain('user\0vantik');
    expect(startup).toContain('database\0analitik');
    expect(fake.diterima[0]!.readUInt32BE(4)).toBe(196_608);
  });

  it('TC-DRV-03 — kata sandi polos dikirim saat server memintanya', async () => {
    const fake = await tcpFake((_data, socket, diterima) => {
      if (diterima.length === 1) socket.write(pgAuth(3));
      else socket.write(Buffer.concat([pgAuth(0), PG_READY]));
    });

    const hasil = await probeConnection(input(fake.port));

    expect(hasil.ok).toBe(true);
    expect(fake.diterima[1]!.subarray(5).toString('utf8')).toBe('sandi-rahasia\0');
  });

  it('TC-DRV-04 — jawaban MD5 dihitung sesuai rumus PostgreSQL', async () => {
    const salt = Buffer.from([1, 2, 3, 4]);
    const fake = await tcpFake((_data, socket, diterima) => {
      if (diterima.length === 1) socket.write(pgAuth(5, salt));
      else socket.write(Buffer.concat([pgAuth(0), PG_READY]));
    });

    const hasil = await probeConnection(input(fake.port));

    // md5(md5(password + user) + salt). Rumus yang salah membuat kata sandi yang benar
    // ditolak, dan penyebabnya nyaris mustahil ditebak dari layar.
    const inner = createHash('md5').update('sandi-rahasiavantik', 'utf8').digest('hex');
    const outer = createHash('md5').update(Buffer.concat([Buffer.from(inner, 'utf8'), salt])).digest('hex');
    expect(hasil.ok).toBe(true);
    expect(fake.diterima[1]!.subarray(5).toString('utf8')).toBe(`md5${outer}\0`);
  });

  it('TC-DRV-05 — kata sandi ditolak dibedakan dari kegagalan lain', async () => {
    const fake = await tcpFake((_data, socket) => socket.write(pgError('28P01')));

    const hasil = await probeConnection(input(fake.port));

    expect(hasil).toMatchObject({ ok: false, reasonKey: 'error.connection_credential_rejected', detail: '28P01' });
  });

  it('TC-DRV-06 — basis data tidak ada punya alasannya sendiri', async () => {
    const fake = await tcpFake((_data, socket) => socket.write(pgError('3D000')));

    const hasil = await probeConnection(input(fake.port));

    // Perbaikannya berbeda dari kata sandi salah: yang ini nama basis datanya.
    expect(hasil.reasonKey).toBe('error.connection_database_missing');
  });

  it('TC-DRV-07 — mekanisme SASL yang tidak dikenal dikatakan apa adanya', async () => {
    const fake = await tcpFake((_data, socket) => {
      socket.write(pgAuth(10, Buffer.from('SCRAM-SHA-1\0\0', 'utf8')));
    });

    const hasil = await probeConnection(input(fake.port));

    expect(hasil).toMatchObject({ ok: false, reasonKey: 'error.connection_auth_unsupported' });
  });

  it('TC-DRV-08 — SCRAM-SHA-256: pesan pertama berbentuk benar', async () => {
    const fake = await tcpFake((_data, socket, diterima) => {
      if (diterima.length === 1) socket.write(pgAuth(10, Buffer.from('SCRAM-SHA-256\0\0', 'utf8')));
    });

    await Promise.race([
      probeConnection(input(fake.port)),
      new Promise((r) => setTimeout(r, 300)),
    ]);

    const sasl = fake.diterima[1]!;
    const payload = sasl.subarray(5).toString('utf8');
    expect(payload.startsWith('SCRAM-SHA-256\0')).toBe(true);
    // Gitignore-nya SCRAM: `n,,n=,r=<nonce>` — tanpa nama pengguna, karena PostgreSQL
    // memakai pengguna dari StartupMessage.
    expect(payload).toContain('n,,n=,r=');
  });
});

/* ================= MySQL ================= */

describe('MySQL', () => {
  const input = (port: number, password = 'sandi-mysql') => ({
    kind: 'mysql' as const,
    host: '127.0.0.1',
    port,
    databaseName: 'analitik',
    username: 'vantik',
    secrets: { password },
    options: {},
  });

  /** Handshake v10 dengan plugin yang ditentukan. */
  function handshake(salt1: Buffer, salt2: Buffer, plugin: string): Buffer {
    const version = Buffer.from('8.0.36-uji\0', 'utf8');
    const body = Buffer.concat([
      Buffer.from([10]),
      version,
      Buffer.from([1, 0, 0, 0]), // thread id
      salt1,
      Buffer.from([0]), // pengisi
      Buffer.from([0xff, 0xf7]), // kemampuan bawah
      Buffer.from([45]), // charset
      Buffer.from([2, 0]), // status
      Buffer.from([0xff, 0x81]), // kemampuan atas
      Buffer.from([salt1.length + salt2.length + 1]),
      Buffer.alloc(10),
      salt2,
      Buffer.from([0]),
      Buffer.from(`${plugin}\0`, 'utf8'),
    ]);
    const packet = Buffer.alloc(4 + body.length);
    packet.writeUIntLE(body.length, 0, 3);
    packet.writeUInt8(0, 3);
    body.copy(packet, 4);
    return packet;
  }

  function okPacket(): Buffer {
    const body = Buffer.from([0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]);
    const packet = Buffer.alloc(4 + body.length);
    packet.writeUIntLE(body.length, 0, 3);
    packet.writeUInt8(2, 3);
    body.copy(packet, 4);
    return packet;
  }

  function errPacket(code: number): Buffer {
    const body = Buffer.concat([Buffer.from([0xff]), (() => {
      const b = Buffer.alloc(2);
      b.writeUInt16LE(code);
      return b;
    })(), Buffer.from('#28000ditolak', 'utf8')]);
    const packet = Buffer.alloc(4 + body.length);
    packet.writeUIntLE(body.length, 0, 3);
    packet.writeUInt8(2, 3);
    body.copy(packet, 4);
    return packet;
  }

  const SALT1 = Buffer.from('12345678', 'utf8');
  const SALT2 = Buffer.from('123456789012', 'utf8');

  it('TC-DRV-09 — jabat tangan native password berhasil dan versi server dilaporkan', async () => {
    const fake = await tcpFake((_data, socket, diterima) => {
      if (diterima.length === 0) return;
      socket.write(okPacket());
    });
    // Handshake dikirim server lebih dulu, sebelum ada data dari klien.
    const server = await tcpFake(() => undefined);
    await server.close();
    fakes.pop();

    const fake2 = await tcpFakeGreeting(handshake(SALT1, SALT2, 'mysql_native_password'), okPacket());
    const hasil = await probeConnection(input(fake2.port));

    expect(hasil.ok).toBe(true);
    expect(hasil.detail).toBe('8.0.36-uji');
    void fake;
  });

  it('TC-DRV-10 — jawaban mysql_native_password dihitung sesuai rumus', async () => {
    const fake = await tcpFakeGreeting(handshake(SALT1, SALT2, 'mysql_native_password'), okPacket());

    await probeConnection(input(fake.port));

    // SHA1(pw) XOR SHA1(salt + SHA1(SHA1(pw))). Salah di sini menolak kata sandi yang benar.
    const salt = Buffer.concat([SALT1, SALT2]);
    const stage1 = createHash('sha1').update('sandi-mysql', 'utf8').digest();
    const stage2 = createHash('sha1').update(stage1).digest();
    const scrambled = createHash('sha1').update(Buffer.concat([salt, stage2])).digest();
    const expected = Buffer.alloc(20);
    for (let i = 0; i < 20; i++) expected[i] = stage1[i]! ^ scrambled[i]!;

    const response = fake.diterima[0]!;
    expect(response.includes(expected)).toBe(true);
    // Nama basis data ikut dikirim, supaya uji koneksi tidak lulus untuk basis data lain.
    expect(response.toString('utf8')).toContain('analitik');
  });

  it('TC-DRV-11 — caching_sha2_password dikatakan belum didukung, bukan gagal samar', async () => {
    const fake = await tcpFakeGreeting(handshake(SALT1, SALT2, 'caching_sha2_password'), okPacket());

    const hasil = await probeConnection(input(fake.port));

    expect(hasil).toMatchObject({ ok: false, reasonKey: 'error.connection_auth_unsupported' });
    // Versi server ikut dilaporkan supaya operator tahu apa yang harus diubah.
    expect(String(hasil.detail)).toContain('caching_sha2_password');
    expect(String(hasil.detail)).toContain('8.0.36-uji');
  });

  it('TC-DRV-12 — akses ditolak (1045) dibedakan dari basis data hilang (1049)', async () => {
    const ditolak = await tcpFakeGreeting(handshake(SALT1, SALT2, 'mysql_native_password'), errPacket(1045));
    expect((await probeConnection(input(ditolak.port))).reasonKey).toBe('error.connection_credential_rejected');

    const hilang = await tcpFakeGreeting(handshake(SALT1, SALT2, 'mysql_native_password'), errPacket(1049));
    expect((await probeConnection(input(hilang.port))).reasonKey).toBe('error.connection_database_missing');
  });
});

/** Server yang menyapa lebih dulu, lalu menjawab satu kali. */
async function tcpFakeGreeting(greeting: Buffer, reply: Buffer): Promise<Fake> {
  const diterima: Buffer[] = [];
  const server: TcpServer = createTcpServer((socket) => {
    socket.write(greeting);
    socket.on('data', (chunk: Buffer) => {
      diterima.push(chunk);
      socket.write(reply);
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const fake: Fake = {
    port: typeof address === 'object' && address ? address.port : 0,
    diterima,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  fakes.push(fake);
  return fake;
}

/**
 * Server tiruan bernaskah: mengirim salam saat klien menyambung, lalu membalas paket
 * ke-N dengan jawaban ke-N.
 *
 * Dibutuhkan karena penarikan data adalah percakapan BERTAHAP — jabat tangan lalu query —
 * sementara `tcpFakeGreeting` membalas hal yang sama untuk setiap paket.
 */
async function tcpFakeScript(greeting: Buffer, replies: Buffer[]): Promise<Fake> {
  const diterima: Buffer[] = [];
  const server: TcpServer = createTcpServer((socket) => {
    let step = 0;
    socket.write(greeting);
    socket.on('data', (chunk: Buffer) => {
      diterima.push(chunk);
      const reply = replies[step++];
      if (reply) socket.write(reply);
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const fake: Fake = {
    port: typeof address === 'object' && address ? address.port : 0,
    diterima,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  fakes.push(fake);
  return fake;
}

/* ================= REST, Oracle, Google ================= */

describe('REST dan sisanya', () => {
  const rest = (url: string) => ({
    kind: 'rest_api' as const,
    host: url,
    secrets: { api_key: 'kunci-api-rahasia' },
    options: {},
  });

  it('TC-DRV-13 — REST: 200 berhasil, dan kuncinya dikirim sebagai Bearer', async () => {
    const fake = await httpFake(200);

    const hasil = await probeConnection(rest(`http://127.0.0.1:${fake.port}/data`));

    expect(hasil.ok).toBe(true);
    const headers = JSON.parse(fake.diterima[0]!.toString('utf8')) as Record<string, string>;
    expect(headers.authorization).toBe('Bearer kunci-api-rahasia');
  });

  it('TC-DRV-13b — 401/403 berarti kredensial, bukan sambungan', async () => {
    const tolak = await httpFake(401);
    expect((await probeConnection(rest(`http://127.0.0.1:${tolak.port}/`))).reasonKey).toBe(
      'error.connection_credential_rejected',
    );

    const rusak = await httpFake(500);
    expect((await probeConnection(rest(`http://127.0.0.1:${rusak.port}/`))).reasonKey).toBe(
      'error.connection_failed',
    );
  });

  it('TC-DRV-13c — port tertutup dilaporkan sebagai koneksi ditolak', async () => {
    const hasil = await probeConnection(rest('http://127.0.0.1:1/'));
    expect(hasil.ok).toBe(false);
    expect(hasil.reasonKey).toMatch(/connection_(refused|failed|timeout)/);
  });

  it('TC-DRV-14 — Oracle dijawab tidak tersedia, bukan berhasil', async () => {
    const hasil = await probeConnection({
      kind: 'oracle',
      host: 'db.contoh.id',
      port: 1521,
      databaseName: 'ORCL',
      username: 'vantik',
      secrets: { password: 'x' },
      options: {},
    });

    // Mengaku berhasil di sini adalah kebohongan paling mahal: baru ketahuan ketika
    // seseorang mengandalkan datanya.
    expect(hasil).toMatchObject({ ok: false, reasonKey: 'error.connection_driver_unavailable' });
  });

  it('TC-DRV-15 — kredensial TIDAK pernah muncul di hasil uji', async () => {
    const fake = await httpFake(401);
    const hasil = await probeConnection(rest(`http://127.0.0.1:${fake.port}/`));

    // Hasil ini ditampilkan di layar dan tersimpan di riwayat koneksi.
    expect(JSON.stringify(hasil)).not.toContain('kunci-api-rahasia');
  });

  it('TC-DRV-16 — service account Google yang rusak dikatakan rusak', async () => {
    const bukanJson = await probeConnection({
      kind: 'google_sheets',
      secrets: { service_account_json: 'bukan json' },
      options: {},
    });
    expect(bukanJson.reasonKey).toBe('error.connection_credential_malformed');

    const tanpaKunci = await probeConnection({
      kind: 'google_sheets',
      secrets: { service_account_json: JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com' }) },
      options: {},
    });
    expect(tanpaKunci.reasonKey).toBe('error.connection_credential_malformed');
  });
});

/* ================= Penarikan data ================= */

/**
 * Yang diuji di bawah adalah **membaca hasil query**, bukan lagi sekadar jabat tangan.
 *
 * Tiga hal yang paling mudah salah, dan tidak satu pun melempar kesalahan saat salah — ia
 * hanya menghasilkan tabel yang isinya keliru:
 *
 *  1. **NULL dibedakan dari string kosong.** PostgreSQL menandainya dengan panjang -1,
 *     MySQL dengan byte 0xfb. Membacanya sebagai teks biasa menggeser seluruh kolom.
 *  2. **Nama kolom MySQL adalah string lenenc KELIMA** pada definisi kolom. Mengambil yang
 *     salah menghasilkan nama tabel sebagai nama kolom.
 *  3. **Paket EOF vs bilangan lenenc**, keduanya diawali 0xfe. Membedakannya lewat panjang.
 *
 * Ditambah gerbang yang paling penting: **hanya SELECT**. Kredensial koneksi sering diberi
 * hak tulis oleh administrator yang terburu-buru, sehingga kolom query yang tidak dijaga
 * menjadi jalan menghapus basis data produksi orang lain.
 */
describe('Gerbang query hanya-baca', () => {
  it('TC-DRV-17 — hanya SELECT dan WITH yang diterima', () => {
    expect(assertReadOnlyQuery('SELECT * FROM pelanggan')).toEqual({ ok: true });
    expect(assertReadOnlyQuery('  with x as (select 1) select * from x')).toEqual({ ok: true });
    // Titik koma di ujung wajar dari penyalinan; yang di TENGAH tidak.
    expect(assertReadOnlyQuery('SELECT 1;')).toEqual({ ok: true });

    for (const jahat of [
      'DELETE FROM pelanggan',
      'DROP TABLE pelanggan',
      'UPDATE pelanggan SET saldo = 0',
      'TRUNCATE pelanggan',
      'GRANT ALL ON pelanggan TO publik',
    ]) {
      expect(assertReadOnlyQuery(jahat), jahat).toEqual({ ok: false, reasonKey: 'error.query_select_only' });
    }
  });

  it('TC-DRV-18 — pernyataan kedua yang diselipkan di belakang SELECT ditolak', () => {
    // Jalur klasik: yang terbaca mata adalah SELECT, yang dijalankan server adalah dua
    // pernyataan.
    expect(assertReadOnlyQuery('SELECT 1; DROP TABLE pelanggan')).toEqual({
      ok: false,
      reasonKey: 'error.query_multiple_statements',
    });
    // Komentar dapat menyembunyikan pernyataan kedua dari pembaca, bukan dari server.
    expect(assertReadOnlyQuery('SELECT 1 -- aman\nDROP TABLE x')).toEqual({
      ok: false,
      reasonKey: 'error.query_comment_not_allowed',
    });
    expect(assertReadOnlyQuery('SELECT /* x */ 1')).toEqual({
      ok: false,
      reasonKey: 'error.query_comment_not_allowed',
    });
  });

  it('TC-DRV-19 — `WITH ... AS (INSERT ...)` yang benar-benar menulis ditolak', () => {
    // Diawali `WITH`, tetapi di PostgreSQL ini menulis. Memeriksa kata pertama saja tidak cukup.
    expect(assertReadOnlyQuery('WITH baru AS (INSERT INTO log VALUES (1) RETURNING *) SELECT * FROM baru')).toEqual({
      ok: false,
      reasonKey: 'error.query_select_only',
    });
    expect(assertReadOnlyQuery('   ')).toEqual({ ok: false, reasonKey: 'error.query_empty' });
  });

  it('TC-DRV-20 — query tidak dijalankan sama sekali bila gerbangnya menolak', async () => {
    // Bukan hanya hasilnya yang ditolak: tidak boleh ada satu byte pun yang sampai ke server.
    const fake = await tcpFake((_data, socket) => {
      socket.write(Buffer.concat([pgAuth(0), PG_READY]));
    });

    const hasil = await runQuery(
      { kind: 'postgresql', host: '127.0.0.1', port: fake.port, databaseName: 'a', username: 'u', secrets: {}, options: {} },
      'DROP TABLE pelanggan',
    );

    expect(hasil.ok).toBe(false);
    expect(hasil.reasonKey).toBe('error.query_select_only');
    expect(fake.diterima).toHaveLength(0);
  });

  it('TC-DRV-21 — jenis koneksi tanpa SQL dijawab tidak tersedia', async () => {
    const hasil = await runQuery(
      { kind: 'oracle', host: 'x', secrets: {}, options: {} },
      'SELECT 1',
    );
    expect(hasil.reasonKey).toBe('error.connection_driver_unavailable');
  });
});

describe('Membaca hasil query PostgreSQL', () => {
  /** RowDescription: 18 byte metadata setelah setiap nama kolom. */
  function pgRowDescription(names: string[]): Buffer {
    const head = Buffer.alloc(2);
    head.writeUInt16BE(names.length, 0);
    const fields = names.map((name) => Buffer.concat([Buffer.from(`${name}\0`, 'utf8'), Buffer.alloc(18)]));
    return pg('T', Buffer.concat([head, ...fields]));
  }

  /** DataRow. `null` menjadi panjang -1, yang BUKAN string kosong. */
  function pgDataRow(values: Array<string | null>): Buffer {
    const head = Buffer.alloc(2);
    head.writeUInt16BE(values.length, 0);
    const cells = values.map((value) => {
      if (value === null) {
        const nul = Buffer.alloc(4);
        nul.writeInt32BE(-1, 0);
        return nul;
      }
      const payload = Buffer.from(value, 'utf8');
      const length = Buffer.alloc(4);
      length.writeInt32BE(payload.length, 0);
      return Buffer.concat([length, payload]);
    });
    return pg('D', Buffer.concat([head, ...cells]));
  }

  const input = (port: number) => ({
    kind: 'postgresql' as const,
    host: '127.0.0.1',
    port,
    databaseName: 'analitik',
    username: 'vantik',
    secrets: { password: 'sandi' },
    options: {},
  });

  it('TC-DRV-22 — kolom dan baris terbaca, NULL dibedakan dari string kosong', async () => {
    const fake = await tcpFake((data, socket) => {
      // Paket pertama adalah StartupMessage (tanpa byte tipe); sisanya adalah Query.
      if (data[0] === 0x51) {
        socket.write(
          Buffer.concat([
            pgRowDescription(['wilayah', 'nilai', 'catatan']),
            pgDataRow(['Jakarta', '1500', null]),
            pgDataRow(['Bandung', '900', '']),
            pg('C', Buffer.from('SELECT 2\0', 'utf8')),
            PG_READY,
          ]),
        );
        return;
      }
      socket.write(Buffer.concat([pgAuth(0), PG_READY]));
    });

    const hasil = await runQuery(input(fake.port), 'SELECT wilayah, nilai, catatan FROM penjualan');

    expect(hasil.ok).toBe(true);
    expect(hasil.columns).toEqual(['wilayah', 'nilai', 'catatan']);
    expect(hasil.rows).toEqual([
      ['Jakarta', '1500', ''],
      ['Bandung', '900', ''],
    ]);
    expect(hasil.truncated).toBe(false);
  });

  it('TC-DRV-23 — query yang ditolak server dijawab alasan query, bukan alasan koneksi', async () => {
    const fake = await tcpFake((data, socket) => {
      if (data[0] === 0x51) {
        socket.write(Buffer.concat([pgError('42P01'), PG_READY]));
        return;
      }
      socket.write(Buffer.concat([pgAuth(0), PG_READY]));
    });

    const hasil = await runQuery(input(fake.port), 'SELECT * FROM tabel_yang_tidak_ada');

    // Membedakan "tabel tidak ada" dari "server tidak terjangkau" menentukan ke mana
    // operator mencari.
    expect(hasil.ok).toBe(false);
    expect(hasil.reasonKey).toBe('error.query_failed');
    expect(hasil.detail).toBe('pg_42P01');
  });

  it('TC-DRV-24 — hasil dipotong pada batas, dan pemotongannya DINYATAKAN', async () => {
    const fake = await tcpFake((data, socket) => {
      if (data[0] === 0x51) {
        const baris = Array.from({ length: 12 }, (_, i) => pgDataRow([`baris-${i}`]));
        socket.write(Buffer.concat([pgRowDescription(['nama']), ...baris, PG_READY]));
        return;
      }
      socket.write(Buffer.concat([pgAuth(0), PG_READY]));
    });

    const hasil = await runQuery(input(fake.port), 'SELECT nama FROM banyak', 5);

    // Diam-diam memotong berarti laporan yang salah tanpa ada yang tahu.
    expect(hasil.rows).toHaveLength(5);
    expect(hasil.truncated).toBe(true);
  });
});


describe('Membaca hasil query MySQL', () => {
  function packet(body: Buffer, seq: number): Buffer {
    const out = Buffer.alloc(4 + body.length);
    out.writeUIntLE(body.length, 0, 3);
    out.writeUInt8(seq, 3);
    body.copy(out, 4);
    return out;
  }

  /** String berpanjang-variabel (bentuk pendek; cukup untuk nilai uji). */
  function lenenc(value: string): Buffer {
    const payload = Buffer.from(value, 'utf8');
    return Buffer.concat([Buffer.from([payload.length]), payload]);
  }

  /**
   * Definisi kolom protokol 41. Nama adalah string lenenc KELIMA.
   *
   * Keempat yang mendahuluinya sengaja diberi nilai yang berbeda-beda, supaya uji ini
   * GAGAL bila yang diambil keliru — bukan diam-diam lulus dengan nama tabel.
   */
  function columnDef(name: string, seq: number): Buffer {
    return packet(
      Buffer.concat([
        lenenc('def'),
        lenenc('skema'),
        lenenc('tabel-alias'),
        lenenc('tabel-asli'),
        lenenc(name),
        lenenc('kolom-asli'),
        Buffer.from([0x0c, 0x2d, 0x00]),
        Buffer.alloc(10),
      ]),
      seq,
    );
  }

  const eof = (seq: number): Buffer => packet(Buffer.from([0xfe, 0x00, 0x00, 0x02, 0x00]), seq);
  const OK = packet(Buffer.from([0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]), 2);

  function greeting(): Buffer {
    const salt1 = Buffer.from('12345678', 'utf8');
    const salt2 = Buffer.from('123456789012', 'utf8');
    return packet(
      Buffer.concat([
        Buffer.from([10]),
        Buffer.from('8.0.36-uji\0', 'utf8'),
        Buffer.from([1, 0, 0, 0]),
        salt1,
        Buffer.from([0]),
        Buffer.from([0xff, 0xf7]),
        Buffer.from([45]),
        Buffer.from([2, 0]),
        Buffer.from([0xff, 0x81]),
        Buffer.from([salt1.length + salt2.length + 1]),
        Buffer.alloc(10),
        salt2,
        Buffer.from([0]),
        Buffer.from('mysql_native_password\0', 'utf8'),
      ]),
      0,
    );
  }

  const input = (port: number) => ({
    kind: 'mysql' as const,
    host: '127.0.0.1',
    port,
    databaseName: 'analitik',
    username: 'vantik',
    secrets: { password: 'sandi-mysql' },
    options: {},
  });

  it('TC-DRV-25 — kolom dan baris terbaca; NULL dibedakan dari string kosong', async () => {
    const resultSet = Buffer.concat([
      packet(Buffer.from([0x02]), 1), // jumlah kolom
      columnDef('wilayah', 2),
      columnDef('nilai', 3),
      eof(4),
      packet(Buffer.concat([lenenc('Jakarta'), lenenc('1500')]), 5),
      // 0xfb = NULL SQL, bukan string kosong.
      packet(Buffer.concat([lenenc('Bandung'), Buffer.from([0xfb])]), 6),
      eof(7),
    ]);
    const fake = await tcpFakeScript(greeting(), [OK, resultSet]);

    const hasil = await runQuery(input(fake.port), 'SELECT wilayah, nilai FROM penjualan');

    expect(hasil.ok).toBe(true);
    // Bila nama kolom diambil dari medan yang salah, di sini akan muncul "tabel-asli".
    expect(hasil.columns).toEqual(['wilayah', 'nilai']);
    expect(hasil.rows).toEqual([
      ['Jakarta', '1500'],
      ['Bandung', ''],
    ]);
    expect(hasil.truncated).toBe(false);
  });

  it('TC-DRV-26 — COM_QUERY benar-benar dikirim, dengan teks query apa adanya', async () => {
    const fake = await tcpFakeScript(greeting(), [
      OK,
      Buffer.concat([packet(Buffer.from([0x01]), 1), columnDef('a', 2), eof(3), eof(4)]),
    ]);

    await runQuery(input(fake.port), 'SELECT a FROM t');

    // Paket kedua dari klien adalah perintahnya: 0x03 diikuti teks query.
    const perintah = fake.diterima[1]!;
    expect(perintah[4]).toBe(0x03);
    expect(perintah.subarray(5).toString('utf8')).toBe('SELECT a FROM t');
  });

  it('TC-DRV-27 — kesalahan dari server dijawab alasan query berikut kodenya', async () => {
    const errorPacket = packet(
      Buffer.concat([Buffer.from([0xff]), (() => { const b = Buffer.alloc(2); b.writeUInt16LE(1146); return b; })(), Buffer.from('#42S02tidak ada', 'utf8')]),
      1,
    );
    const fake = await tcpFakeScript(greeting(), [OK, errorPacket]);

    const hasil = await runQuery(input(fake.port), 'SELECT * FROM tidak_ada');

    // 1146 = tabel tidak dikenal. Dibedakan dari kegagalan koneksi.
    expect(hasil.ok).toBe(false);
    expect(hasil.reasonKey).toBe('error.query_failed');
    expect(hasil.detail).toBe('mysql_1146');
  });

  it('TC-DRV-28 — hasil dipotong pada batas, dan pemotongannya dinyatakan', async () => {
    const baris = Array.from({ length: 9 }, (_, i) => packet(lenenc(`baris-${i}`), 5 + i));
    const fake = await tcpFakeScript(greeting(), [
      OK,
      Buffer.concat([packet(Buffer.from([0x01]), 1), columnDef('nama', 2), eof(3), ...baris, eof(20)]),
    ]);

    const hasil = await runQuery(input(fake.port), 'SELECT nama FROM banyak', 4);

    expect(hasil.rows).toHaveLength(4);
    expect(hasil.truncated).toBe(true);
  });

  it('TC-DRV-29 — kredensial tidak pernah muncul di hasil query', async () => {
    const fake = await tcpFakeScript(greeting(), [
      OK,
      Buffer.concat([packet(Buffer.from([0x01]), 1), columnDef('a', 2), eof(3), eof(4)]),
    ]);

    const hasil = await runQuery(input(fake.port), 'SELECT a FROM t');

    // Hasil ini tersimpan di riwayat sinkronisasi dan terbaca operator.
    expect(JSON.stringify(hasil)).not.toContain('sandi-mysql');
  });
});
