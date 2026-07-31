/**
 * Uji koneksi yang benar-benar menyambung.
 *
 * `ConfigurationProbe` menjawab "ok" begitu bentuk konfigurasinya lengkap — host terisi,
 * kata sandi terisi. Artinya tombol *Uji Koneksi* menyatakan berhasil untuk host yang tidak
 * ada, kata sandi yang salah, dan basis data yang tidak pernah dibuat. Itu kelas kebohongan
 * yang sama dengan transport notifikasi yang mengaku terkirim: operator melihat centang
 * hijau lalu berhenti mencari, dan kegagalannya baru muncul jauh kemudian.
 *
 * TANPA DEPENDENSI BARU. Protokol PostgreSQL dan MySQL ditulis langsung di atas `node:net`
 * dan `node:crypto`, karena satu paket yang gagal terpasang adalah masalah pemasangan nomor
 * satu di shared hosting. Yang ditulis hanyalah **jabat tangan sampai autentikasi selesai** —
 * bukan klien SQL lengkap. Itu memang yang perlu dibuktikan sebuah uji koneksi: host benar,
 * port benar, kredensial diterima, basis datanya ada.
 *
 * Batas yang dinyatakan, bukan disembunyikan:
 *
 *  - **Oracle** butuh Oracle Instant Client (pustaka native) yang tidak dapat dipasang di
 *    shared hosting. Dijawab `error.connection_driver_unavailable`, bukan dibiarkan mengaku
 *    berhasil.
 *  - **MySQL** dengan `caching_sha2_password` (bawaan MySQL 8) di atas koneksi tanpa TLS
 *    memerlukan pertukaran kunci RSA yang tidak diterapkan di sini; dijawab apa adanya.
 */
import { connect as netConnect, type Socket } from 'node:net';
import { createHash, createHmac, pbkdf2Sync, randomBytes, createSign } from 'node:crypto';
import type { ConnectionKind } from './connections.ts';

/** Batas waktu satu uji koneksi. Uji yang menggantung menahan permintaan operator. */
export const PROBE_TIMEOUT_MS = 10_000;

export interface ProbeInput {
  kind: ConnectionKind;
  host?: string | null;
  port?: number | null;
  databaseName?: string | null;
  username?: string | null;
  secrets: Record<string, string>;
  options: Record<string, unknown>;
}

export interface ProbeResult {
  ok: boolean;
  reasonKey?: string;
  latencyMs?: number;
  /** Keterangan teknis singkat — versi server, kode kesalahan. TIDAK PERNAH memuat kredensial. */
  detail?: string;
}

/**
 * Kesalahan jaringan menjadi kunci pesan.
 *
 * Sengaja hanya kode: pesan kesalahan socket dapat memuat host, port, dan kadang bagian
 * kredensial, sementara hasil uji ini ditampilkan di layar dan tersimpan di riwayat koneksi.
 */
function networkReason(error: unknown): string {
  const code = (error as { code?: string } | undefined)?.code ?? '';
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'error.connection_host_unreachable';
    case 'ECONNREFUSED':
      return 'error.connection_refused';
    case 'ETIMEDOUT':
    case 'ABORT_ERR':
      return 'error.connection_timeout';
    case 'ECONNRESET':
      return 'error.connection_reset';
    default:
      return 'error.connection_failed';
  }
}

/* ================= Socket pembantu ================= */

/** Socket dengan antrean baca berbasis panjang, cukup untuk kedua protokol di bawah. */
class Wire {
  private buffer = Buffer.alloc(0);
  private waiter: { need: (buf: Buffer) => number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null =
    null;

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.pump();
    });
    socket.on('error', (error: Error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('closed')));
  }

  private fail(error: Error): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.reject(error);
  }

  private pump(): void {
    if (!this.waiter) return;
    const size = this.waiter.need(this.buffer);
    if (size <= 0 || this.buffer.length < size) return;
    const out = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    const waiter = this.waiter;
    this.waiter = null;
    waiter.resolve(out);
  }

  /** Menunggu sampai `need()` melaporkan panjang pesan yang lengkap. */
  read(need: (buf: Buffer) => number): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      this.waiter = { need, resolve, reject };
      this.pump();
    });
  }

  write(data: Buffer): void {
    this.socket.write(data);
  }
}

function openSocket(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port });
    const onError = (error: Error): void => reject(error);
    socket.setTimeout(PROBE_TIMEOUT_MS, () => socket.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.removeListener('error', onError);
      resolve(socket);
    });
  });
}

/* ================= PostgreSQL ================= */

/** Pesan PostgreSQL: 1 byte tipe + panjang 4 byte (termasuk dirinya). */
function pgFrame(buf: Buffer): number {
  if (buf.length < 5) return 0;
  return 1 + buf.readUInt32BE(1);
}

function pgStartup(user: string, database: string): Buffer {
  const params = `user\0${user}\0database\0${database}\0application_name\0vantik\0\0`;
  const body = Buffer.from(params, 'utf8');
  const out = Buffer.alloc(8 + body.length);
  out.writeUInt32BE(8 + body.length, 0);
  out.writeUInt32BE(196_608, 4); // protokol 3.0
  body.copy(out, 8);
  return out;
}

function pgMessage(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(5 + body.length);
  out.write(type, 0, 'ascii');
  out.writeUInt32BE(4 + body.length, 1);
  body.copy(out, 5);
  return out;
}

/** SCRAM-SHA-256, seperti dituntut PostgreSQL modern. */
function scramClientFinal(
  password: string,
  clientNonce: string,
  serverFirst: string,
): { message: Buffer; serverKey: Buffer; authMessage: string } {
  const parts = Object.fromEntries(
    serverFirst.split(',').map((p) => [p.slice(0, 1), p.slice(2)]),
  ) as Record<string, string>;
  const salt = Buffer.from(parts.s ?? '', 'base64');
  const iterations = Number(parts.i ?? '4096');
  const combinedNonce = parts.r ?? '';

  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const withoutProof = `c=biws,r=${combinedNonce}`;
  const authMessage = `n=,r=${clientNonce},${serverFirst},${withoutProof}`;
  const clientSignature = createHmac('sha256', storedKey).update(authMessage).digest();
  const proof = Buffer.alloc(clientKey.length);
  for (let i = 0; i < clientKey.length; i++) proof[i] = clientKey[i]! ^ clientSignature[i]!;

  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest();
  return {
    message: Buffer.from(`${withoutProof},p=${proof.toString('base64')}`, 'utf8'),
    serverKey,
    authMessage,
  };
}

/** Kode SQLSTATE yang perlu dibedakan; sisanya digabung sebagai kegagalan umum. */
function pgErrorReason(fields: Record<string, string>): string {
  switch (fields.C) {
    case '28P01':
    case '28000':
      return 'error.connection_credential_rejected';
    case '3D000':
      return 'error.connection_database_missing';
    default:
      return 'error.connection_failed';
  }
}

/**
 * Jabat tangan PostgreSQL sampai ReadyForQuery.
 *
 * Dipisahkan supaya uji koneksi dan penarikan data memakai jalur autentikasi yang SAMA.
 * Menduplikasinya berarti keduanya dapat menyimpang — mis. tombol "Uji Koneksi" berhasil
 * sementara sinkronisasi gagal pada server yang sama, kegagalan yang mustahil dijelaskan
 * kepada orang yang baru saja melihat tanda centang hijau.
 *
 * Mengembalikan `null` bila berhasil; bila gagal, mengembalikan `ProbeResult` yang sudah
 * berisi alasannya.
 */
async function pgHandshake(
  wire: Wire,
  user: string,
  password: string,
  database: string,
  started: number,
): Promise<ProbeResult | null> {
  wire.write(pgStartup(user, database));

  const clientNonce = randomBytes(18).toString('base64');
  let serverFirst = '';

  for (;;) {
    const frame = await wire.read(pgFrame);
    const type = String.fromCharCode(frame[0]!);
    const body = frame.subarray(5);

    if (type === 'E') {
      const fields = pgErrorFields(body);
      return { ok: false, reasonKey: pgErrorReason(fields), detail: fields.C, latencyMs: Date.now() - started };
    }

    if (type === 'R') {
      const auth = body.readUInt32BE(0);
      if (auth === 0) continue; // AuthenticationOk — tunggu ReadyForQuery
      if (auth === 3) {
        wire.write(pgMessage('p', Buffer.concat([Buffer.from(password, 'utf8'), Buffer.alloc(1)])));
        continue;
      }
      if (auth === 5) {
        // MD5: md5(md5(password + user) + salt)
        const salt = body.subarray(4, 8);
        const inner = createHash('md5').update(password + user, 'utf8').digest('hex');
        const outer = createHash('md5').update(Buffer.concat([Buffer.from(inner, 'utf8'), salt])).digest('hex');
        wire.write(pgMessage('p', Buffer.concat([Buffer.from(`md5${outer}`, 'utf8'), Buffer.alloc(1)])));
        continue;
      }
      if (auth === 10) {
        // SASL: pilih SCRAM-SHA-256 bila ditawarkan.
        const mechanisms = body.subarray(4).toString('utf8').split('\0').filter(Boolean);
        if (!mechanisms.includes('SCRAM-SHA-256')) {
          return {
            ok: false,
            reasonKey: 'error.connection_auth_unsupported',
            detail: mechanisms.join(','),
            latencyMs: Date.now() - started,
          };
        }
        const first = Buffer.from(`n,,n=,r=${clientNonce}`, 'utf8');
        const len = Buffer.alloc(4);
        len.writeInt32BE(first.length);
        wire.write(pgMessage('p', Buffer.concat([Buffer.from('SCRAM-SHA-256\0', 'utf8'), len, first])));
        continue;
      }
      if (auth === 11) {
        serverFirst = body.subarray(4).toString('utf8');
        const { message } = scramClientFinal(password, clientNonce, serverFirst);
        wire.write(pgMessage('p', message));
        continue;
      }
      if (auth === 12) continue; // server-final; keberhasilan ditandai ReadyForQuery
      return {
        ok: false,
        reasonKey: 'error.connection_auth_unsupported',
        detail: `auth_${auth}`,
        latencyMs: Date.now() - started,
      };
    }

    // ReadyForQuery: jabat tangan selesai dan basis datanya ada.
    if (type === 'Z') return null;
    // S (ParameterStatus), K (BackendKeyData), N (Notice) diabaikan.
  }
}

/** ErrorResponse: pasangan kode-huruf + nilai, diakhiri byte nol. */
function pgErrorFields(body: Buffer): Record<string, string> {
  const fields: Record<string, string> = {};
  let offset = 0;
  while (offset < body.length && body[offset] !== 0) {
    const key = String.fromCharCode(body[offset]!);
    const end = body.indexOf(0, offset + 1);
    fields[key] = body.toString('utf8', offset + 1, end);
    offset = end + 1;
  }
  return fields;
}

async function probePostgres(input: ProbeInput): Promise<ProbeResult> {
  const started = Date.now();
  let socket: Socket | null = null;

  try {
    socket = await openSocket(input.host!, input.port ?? 5432);
    const failure = await pgHandshake(
      new Wire(socket),
      input.username!,
      input.secrets.password ?? '',
      input.databaseName!,
      started,
    );
    return failure ?? { ok: true, latencyMs: Date.now() - started, detail: 'postgresql' };
  } catch (error) {
    return { ok: false, reasonKey: networkReason(error), latencyMs: Date.now() - started };
  } finally {
    socket?.destroy();
  }
}

/* ================= MySQL ================= */

/** Paket MySQL: panjang 3 byte little-endian + nomor urut. */
function mysqlFrame(buf: Buffer): number {
  if (buf.length < 4) return 0;
  return 4 + buf.readUIntLE(0, 3);
}

/** `mysql_native_password`: SHA1(pw) XOR SHA1(salt + SHA1(SHA1(pw))). */
function mysqlNativePassword(password: string, salt: Buffer): Buffer {
  if (!password) return Buffer.alloc(0);
  const stage1 = createHash('sha1').update(password, 'utf8').digest();
  const stage2 = createHash('sha1').update(stage1).digest();
  const scrambled = createHash('sha1').update(Buffer.concat([salt, stage2])).digest();
  const out = Buffer.alloc(stage1.length);
  for (let i = 0; i < stage1.length; i++) out[i] = stage1[i]! ^ scrambled[i]!;
  return out;
}

/**
 * Jabat tangan MySQL sampai OK packet.
 *
 * Dipisahkan dengan alasan yang sama seperti `pgHandshake`: uji koneksi dan penarikan data
 * wajib memakai jalur autentikasi yang SAMA, supaya keduanya tidak dapat menyimpang.
 *
 * Mengembalikan `ProbeResult` penuh — termasuk versi server pada keberhasilan. Versi itu
 * ditampilkan operator setelah uji koneksi; membuangnya berarti layar kehilangan satu-satunya
 * petunjuk tentang server mana yang sebenarnya dihubungi.
 */
async function mysqlHandshake(wire: Wire, input: ProbeInput, started: number): Promise<ProbeResult> {
  {
    const handshake = await wire.read(mysqlFrame);
    const body = handshake.subarray(4);

    if (body[0] === 0xff) {
      // Server menolak sebelum jabat tangan — biasanya host tidak diizinkan.
      return { ok: false, reasonKey: 'error.connection_refused', detail: body.subarray(3).toString('utf8').slice(0, 60), latencyMs: Date.now() - started };
    }

    // v10: versi protokol, versi server (nul-terminated), thread id, salt bagian 1.
    const versionEnd = body.indexOf(0, 1);
    const serverVersion = body.toString('utf8', 1, versionEnd);
    // Susunan handshake v10 setelah thread id, dan setiap angka di bawah adalah tempat yang
    // mudah meleset satu byte — melesetnya tidak melempar apa pun, hanya menghasilkan nama
    // plugin dan salt yang keliru, sehingga kata sandi yang benar ditolak.
    let offset = versionEnd + 1 + 4;
    const salt1 = body.subarray(offset, offset + 8);
    offset += 8 + 1 + 2 + 1 + 2 + 2; // salt1, filler, kemampuan bawah, charset, status, kemampuan atas
    const saltLength = body[offset] ?? 21;
    offset += 1 + 10; // panjang salt + 10 byte cadangan
    const part2Length = Math.max(13, saltLength - 8);
    const salt2 = body.subarray(offset, offset + part2Length - 1); // buang NUL di ujung
    offset += part2Length;
    const plugin = body.toString('utf8', offset).replace(/\0.*$/, '');
    const salt = Buffer.concat([salt1, salt2]);

    if (plugin && plugin !== 'mysql_native_password') {
      // MySQL 8 memakai caching_sha2_password; jalur cepatnya butuh pertukaran kunci RSA
      // di atas koneksi tanpa TLS. Dikatakan apa adanya — server terjangkau, autentikasinya
      // yang belum didukung — supaya operator tahu persis apa yang harus diubah.
      return {
        ok: false,
        reasonKey: 'error.connection_auth_unsupported',
        detail: `${plugin} · ${serverVersion}`,
        latencyMs: Date.now() - started,
      };
    }

    const authData = mysqlNativePassword(input.secrets.password ?? '', salt);
    const user = Buffer.from(input.username!, 'utf8');
    const database = Buffer.from(input.databaseName!, 'utf8');
    const response = Buffer.alloc(32 + user.length + 1 + 1 + authData.length + database.length + 1 + 22);
    let p = 0;
    // Kemampuan klien: PROTOCOL_41 | SECURE_CONNECTION | CONNECT_WITH_DB | PLUGIN_AUTH.
    response.writeUInt32LE(0x0002_0000 | 0x0000_8000 | 0x0000_0200 | 0x0000_0008, p);
    p += 4;
    response.writeUInt32LE(16_777_215, p); // ukuran paket maksimum
    p += 4;
    response.writeUInt8(45, p); // utf8mb4
    p += 1 + 23;
    user.copy(response, p);
    p += user.length + 1;
    response.writeUInt8(authData.length, p);
    p += 1;
    authData.copy(response, p);
    p += authData.length;
    database.copy(response, p);
    p += database.length + 1;
    p += Buffer.from('mysql_native_password\0', 'utf8').copy(response, p);

    const packet = Buffer.alloc(4 + p);
    packet.writeUIntLE(p, 0, 3);
    packet.writeUInt8(1, 3);
    response.subarray(0, p).copy(packet, 4);
    wire.write(packet);

    const reply = await wire.read(mysqlFrame);
    const status = reply[4];
    if (status === 0x00) return { ok: true, latencyMs: Date.now() - started, detail: serverVersion };
    if (status === 0xff) {
      const code = reply.readUInt16LE(5);
      // 1045 = akses ditolak, 1049 = basis data tidak dikenal.
      const reasonKey =
        code === 1045
          ? 'error.connection_credential_rejected'
          : code === 1049
            ? 'error.connection_database_missing'
            : 'error.connection_failed';
      return { ok: false, reasonKey, detail: `mysql_${code}`, latencyMs: Date.now() - started };
    }
    return { ok: false, reasonKey: 'error.connection_auth_unsupported', detail: `status_${status}`, latencyMs: Date.now() - started };
  }
}

async function probeMysql(input: ProbeInput): Promise<ProbeResult> {
  const started = Date.now();
  let socket: Socket | null = null;

  try {
    socket = await openSocket(input.host!, input.port ?? 3306);
    return await mysqlHandshake(new Wire(socket), input, started);
  } catch (error) {
    return { ok: false, reasonKey: networkReason(error), latencyMs: Date.now() - started };
  } finally {
    socket?.destroy();
  }
}

/* ================= REST ================= */

async function probeRest(input: ProbeInput): Promise<ProbeResult> {
  const started = Date.now();
  const url = String(input.host ?? '');
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, reasonKey: 'error.connection_url_required', latencyMs: 0 };
  }

  const headerName = String(input.options.authHeader ?? 'Authorization');
  const scheme = String(input.options.authScheme ?? 'Bearer');
  const apiKey = input.secrets.api_key ?? '';

  try {
    const response = await fetch(url, {
      method: String(input.options.method ?? 'GET'),
      headers: { Accept: 'application/json', [headerName]: scheme ? `${scheme} ${apiKey}` : apiKey },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    // 401/403 dibedakan dari kegagalan lain: keduanya berarti sambungannya berhasil dan
    // yang salah adalah kredensialnya — perbaikan yang sama sekali berbeda.
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reasonKey: 'error.connection_credential_rejected', detail: String(response.status), latencyMs: Date.now() - started };
    }
    if (!response.ok) {
      return { ok: false, reasonKey: 'error.connection_failed', detail: String(response.status), latencyMs: Date.now() - started };
    }
    return { ok: true, latencyMs: Date.now() - started, detail: String(response.status) };
  } catch (error) {
    return { ok: false, reasonKey: networkReason(error), latencyMs: Date.now() - started };
  }
}

/* ================= Google Sheets ================= */

/**
 * Menukar service account JSON dengan access token.
 *
 * Membuktikan kuncinya sah dan akunnya masih aktif — bukan sekadar bahwa JSON-nya berbentuk
 * benar. Tanda tangan RS256 dibuat dengan `node:crypto`, jadi tidak ada SDK Google yang
 * perlu dipasang.
 */
async function probeGoogleSheets(input: ProbeInput): Promise<ProbeResult> {
  const started = Date.now();
  let account: { client_email?: string; private_key?: string; token_uri?: string };
  try {
    account = JSON.parse(input.secrets.service_account_json ?? '{}') as typeof account;
  } catch {
    return { ok: false, reasonKey: 'error.connection_credential_malformed', latencyMs: 0 };
  }
  if (!account.client_email || !account.private_key) {
    return { ok: false, reasonKey: 'error.connection_credential_malformed', latencyMs: 0 };
  }

  const tokenUri = account.token_uri ?? 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
      aud: tokenUri,
      iat: now,
      exp: now + 300,
    }),
  ).toString('base64url');

  try {
    const signature = createSign('RSA-SHA256')
      .update(`${header}.${claims}`)
      .sign(account.private_key)
      .toString('base64url');

    const response = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${claims}.${signature}`,
      }).toString(),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (response.status === 400 || response.status === 401) {
      return { ok: false, reasonKey: 'error.connection_credential_rejected', detail: String(response.status), latencyMs: Date.now() - started };
    }
    if (!response.ok) {
      return { ok: false, reasonKey: 'error.connection_failed', detail: String(response.status), latencyMs: Date.now() - started };
    }
    return { ok: true, latencyMs: Date.now() - started, detail: 'google_oauth' };
  } catch (error) {
    // Kunci privat yang rusak membuat penandatanganan melempar; itu masalah kredensial,
    // bukan masalah jaringan.
    const code = (error as { code?: string } | undefined)?.code ?? '';
    if (!code || code.startsWith('ERR_OSSL') || code === 'ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE') {
      return { ok: false, reasonKey: 'error.connection_credential_malformed', latencyMs: Date.now() - started };
    }
    return { ok: false, reasonKey: networkReason(error), latencyMs: Date.now() - started };
  }
}

/* ================= Perakitan ================= */

/**
 * Menguji koneksi sungguhan, setelah bentuk konfigurasinya divalidasi pemanggil.
 *
 * Oracle sengaja dijawab "driver tidak tersedia" alih-alih dicoba: ia memerlukan Oracle
 * Instant Client, pustaka native yang tidak dapat dipasang di shared hosting. Mengaku
 * berhasil di sana akan menjadi kebohongan yang paling mahal dari semuanya, karena baru
 * ketahuan ketika seseorang mengandalkan datanya.
 */
/* ================= Penarikan data ================= */

/**
 * Batas jumlah baris satu penarikan.
 *
 * Bukan angka hiasan: hasilnya dikumpulkan di memori sebelum masuk basis data, dan aplikasi
 * ini berjalan di shared hosting dengan batas memori 512MB–1GB. Satu `SELECT` tanpa `WHERE`
 * pada tabel berisi jutaan baris akan mematikan prosesnya — dan yang mati bukan hanya
 * sinkronisasi itu, melainkan seluruh aplikasi untuk semua penyewa.
 */
export const MAX_SYNC_ROWS = 50_000;

/** Batas waktu satu penarikan. Lebih panjang dari uji koneksi: query memang butuh waktu. */
export const QUERY_TIMEOUT_MS = 60_000;

export interface QueryResult {
  ok: boolean;
  reasonKey?: string;
  detail?: string;
  columns: string[];
  rows: string[][];
  /** Benar bila hasil dipotong pada MAX_SYNC_ROWS — dinyatakan, bukan didiamkan. */
  truncated: boolean;
  latencyMs?: number;
}

const EMPTY: Omit<QueryResult, 'ok'> = { columns: [], rows: [], truncated: false };

/**
 * Hanya SELECT yang boleh dijalankan.
 *
 * Kredensial koneksi sering diberi hak tulis oleh administrator basis data yang sedang
 * terburu-buru. Bila sebuah kolom query dapat memuat `DELETE` atau `DROP`, maka layar
 * konfigurasi di aplikasi ini menjadi jalan menghapus isi basis data produksi orang lain —
 * dengan kredensial mereka sendiri, sehingga jejaknya pun menunjuk ke mereka.
 *
 * Pemeriksaannya sengaja KETAT dan menolak apa pun yang meragukan: satu pernyataan, diawali
 * `SELECT` atau `WITH`, tanpa titik koma di tengah, tanpa komentar. Query sah yang tertolak
 * hanya merepotkan; query berbahaya yang lolos tidak dapat ditarik kembali.
 */
export function assertReadOnlyQuery(sql: string): { ok: true } | { ok: false; reasonKey: string } {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (trimmed === '') return { ok: false, reasonKey: 'error.query_empty' };

  // Komentar dapat menyembunyikan pernyataan kedua dari mata pembaca, bukan dari server.
  if (/--|\/\*|\*\//.test(trimmed)) return { ok: false, reasonKey: 'error.query_comment_not_allowed' };
  // Titik koma yang TERSISA setelah yang di ujung dibuang berarti ada lebih dari satu
  // pernyataan — jalur klasik menyelipkan perintah tulis di belakang SELECT yang tampak sah.
  if (trimmed.includes(';')) return { ok: false, reasonKey: 'error.query_multiple_statements' };
  if (!/^(select|with)\s/i.test(trimmed)) return { ok: false, reasonKey: 'error.query_select_only' };
  // `WITH ... AS (INSERT ...) SELECT` benar-benar menulis di PostgreSQL, dan diawali `WITH`.
  if (/\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|call|do)\b/i.test(trimmed)) {
    return { ok: false, reasonKey: 'error.query_select_only' };
  }
  return { ok: true };
}

/* ----- PostgreSQL ----- */

async function queryPostgres(input: ProbeInput, sql: string, limit: number): Promise<QueryResult> {
  const started = Date.now();
  let socket: Socket | null = null;

  try {
    socket = await openSocket(input.host!, input.port ?? 5432);
    socket.setTimeout(QUERY_TIMEOUT_MS, () => socket?.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    const wire = new Wire(socket);

    const failure = await pgHandshake(
      wire,
      input.username!,
      input.secrets.password ?? '',
      input.databaseName!,
      started,
    );
    if (failure) return { ...EMPTY, ok: false, reasonKey: failure.reasonKey, detail: failure.detail };

    wire.write(pgMessage('Q', Buffer.from(`${sql}\0`, 'utf8')));

    let columns: string[] = [];
    const rows: string[][] = [];
    let truncated = false;

    for (;;) {
      const frame = await wire.read(pgFrame);
      const type = String.fromCharCode(frame[0]!);
      const body = frame.subarray(5);

      if (type === 'T') {
        // RowDescription: jumlah kolom, lalu nama diakhiri NUL diikuti 18 byte metadata.
        const count = body.readUInt16BE(0);
        const names: string[] = [];
        let offset = 2;
        for (let i = 0; i < count; i++) {
          const end = body.indexOf(0, offset);
          names.push(body.toString('utf8', offset, end));
          offset = end + 1 + 18;
        }
        columns = names;
        continue;
      }

      if (type === 'D') {
        // DataRow: panjang -1 berarti NULL — dibedakan dari string kosong, karena keduanya
        // punya arti berbeda di hampir setiap dataset.
        const count = body.readUInt16BE(0);
        const values: string[] = [];
        let offset = 2;
        for (let i = 0; i < count; i++) {
          const length = body.readInt32BE(offset);
          offset += 4;
          if (length < 0) {
            values.push('');
            continue;
          }
          values.push(body.toString('utf8', offset, offset + length));
          offset += length;
        }
        if (rows.length < limit) rows.push(values);
        else truncated = true;
        continue;
      }

      if (type === 'E') {
        const fields = pgErrorFields(body);
        return {
          ...EMPTY,
          ok: false,
          reasonKey: 'error.query_failed',
          detail: fields.C ? `pg_${fields.C}` : undefined,
        };
      }

      // ReadyForQuery menutup rangkaian, termasuk setelah CommandComplete.
      if (type === 'Z') break;
      // C (CommandComplete), N (Notice), S (ParameterStatus) tidak menambah baris.
    }

    return { ok: true, columns, rows, truncated, latencyMs: Date.now() - started };
  } catch (error) {
    return { ...EMPTY, ok: false, reasonKey: networkReason(error), latencyMs: Date.now() - started };
  } finally {
    socket?.destroy();
  }
}

/* ----- MySQL ----- */

/** Bilangan berpanjang-variabel MySQL (§ length-encoded integer). */
function lenencInt(buf: Buffer, offset: number): { value: number; next: number } | null {
  const first = buf[offset];
  if (first === undefined) return null;
  if (first < 0xfb) return { value: first, next: offset + 1 };
  if (first === 0xfc) return { value: buf.readUInt16LE(offset + 1), next: offset + 3 };
  if (first === 0xfd) return { value: buf.readUIntLE(offset + 1, 3), next: offset + 4 };
  if (first === 0xfe) return { value: Number(buf.readBigUInt64LE(offset + 1)), next: offset + 9 };
  return null; // 0xfb = NULL, ditangani pemanggil
}

/** String berpanjang-variabel. `null` berarti NULL SQL, bukan string kosong. */
function lenencString(buf: Buffer, offset: number): { value: string | null; next: number } {
  if (buf[offset] === 0xfb) return { value: null, next: offset + 1 };
  const length = lenencInt(buf, offset);
  if (!length) return { value: null, next: offset + 1 };
  return {
    value: buf.toString('utf8', length.next, length.next + length.value),
    next: length.next + length.value,
  };
}

/** Paket EOF: penanda 0xfe dengan muatan pendek — dibedakan dari lenenc-int 0xfe. */
function isEof(payload: Buffer): boolean {
  return payload[0] === 0xfe && payload.length < 9;
}

async function queryMysql(input: ProbeInput, sql: string, limit: number): Promise<QueryResult> {
  const started = Date.now();
  let socket: Socket | null = null;

  try {
    socket = await openSocket(input.host!, input.port ?? 3306);
    socket.setTimeout(QUERY_TIMEOUT_MS, () => socket?.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    const wire = new Wire(socket);

    const handshake = await mysqlHandshake(wire, input, started);
    if (!handshake.ok) return { ...EMPTY, ok: false, reasonKey: handshake.reasonKey, detail: handshake.detail };

    // COM_QUERY: 0x03 diikuti teks query. Nomor urut kembali ke 0 pada perintah baru.
    const payload = Buffer.concat([Buffer.from([0x03]), Buffer.from(sql, 'utf8')]);
    const packet = Buffer.alloc(4 + payload.length);
    packet.writeUIntLE(payload.length, 0, 3);
    packet.writeUInt8(0, 3);
    payload.copy(packet, 4);
    wire.write(packet);

    const first = (await wire.read(mysqlFrame)).subarray(4);
    if (first[0] === 0xff) {
      return { ...EMPTY, ok: false, reasonKey: 'error.query_failed', detail: `mysql_${first.readUInt16LE(1)}` };
    }
    if (first[0] === 0x00) {
      // OK packet: pernyataan tanpa hasil. Tidak seharusnya terjadi — hanya SELECT yang
      // sampai ke sini — tetapi dijawab jujur alih-alih dibiarkan menggantung.
      return { ok: true, columns: [], rows: [], truncated: false, latencyMs: Date.now() - started };
    }

    const columnCount = lenencInt(first, 0)?.value ?? 0;
    const columns: string[] = [];
    for (let i = 0; i < columnCount; i++) {
      const def = (await wire.read(mysqlFrame)).subarray(4);
      // catalog, schema, table, org_table, name — nama adalah string lenenc KELIMA.
      let offset = 0;
      let name: string | null = null;
      for (let field = 0; field < 5; field++) {
        const read = lenencString(def, offset);
        offset = read.next;
        name = read.value;
      }
      columns.push(name ?? `kolom_${i + 1}`);
    }

    // EOF penutup daftar kolom (CLIENT_DEPRECATE_EOF tidak diminta, jadi paket ini ada).
    const afterColumns = (await wire.read(mysqlFrame)).subarray(4);
    if (!isEof(afterColumns)) {
      return { ...EMPTY, ok: false, reasonKey: 'error.query_failed', detail: 'unexpected_packet' };
    }

    const rows: string[][] = [];
    let truncated = false;
    for (;;) {
      const body = (await wire.read(mysqlFrame)).subarray(4);
      if (isEof(body)) break;
      if (body[0] === 0xff) {
        return { ...EMPTY, ok: false, reasonKey: 'error.query_failed', detail: `mysql_${body.readUInt16LE(1)}` };
      }

      const values: string[] = [];
      let offset = 0;
      for (let i = 0; i < columnCount; i++) {
        const read = lenencString(body, offset);
        values.push(read.value ?? '');
        offset = read.next;
      }
      if (rows.length < limit) rows.push(values);
      else truncated = true;
    }

    return { ok: true, columns, rows, truncated, latencyMs: Date.now() - started };
  } catch (error) {
    return { ...EMPTY, ok: false, reasonKey: networkReason(error), latencyMs: Date.now() - started };
  } finally {
    socket?.destroy();
  }
}

/**
 * Menjalankan satu query baca terhadap koneksi eksternal.
 *
 * Hasilnya sengaja berupa TEKS, sama seperti pembaca CSV dan XLSX. Deteksi tipe kolom sudah
 * ada di jalur dataset dan telah teruji; menebak tipe di sini berarti dua tempat yang harus
 * sepakat — dan diam-diam menyimpang.
 */
export async function runQuery(input: ProbeInput, sql: string, limit = MAX_SYNC_ROWS): Promise<QueryResult> {
  const guard = assertReadOnlyQuery(sql);
  if (!guard.ok) return { ...EMPTY, ok: false, reasonKey: guard.reasonKey };

  const capped = Math.max(1, Math.min(limit, MAX_SYNC_ROWS));
  switch (input.kind) {
    case 'postgresql':
      return queryPostgres(input, sql, capped);
    case 'mysql':
      return queryMysql(input, sql, capped);
    default:
      // REST, Google Sheets, dan Oracle tidak berbicara SQL lewat jalur ini.
      return { ...EMPTY, ok: false, reasonKey: 'error.connection_driver_unavailable' };
  }
}

export async function probeConnection(input: ProbeInput): Promise<ProbeResult> {
  switch (input.kind) {
    case 'rest_api':
      return probeRest(input);
    case 'postgresql':
      return probePostgres(input);
    case 'mysql':
      return probeMysql(input);
    case 'google_sheets':
      return probeGoogleSheets(input);
    case 'oracle':
      return { ok: false, reasonKey: 'error.connection_driver_unavailable', detail: 'oracle_instant_client' };
    default:
      return { ok: false, reasonKey: 'error.connection_driver_unavailable' };
  }
}
