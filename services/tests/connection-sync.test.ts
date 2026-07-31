/**
 * Penarikan data dari basis data eksternal, dari query sampai menjadi dataset.
 *
 * `drivers.test.ts` sudah membuktikan bahwa hasil query dibaca benar dari kabel. Yang diuji
 * di sini adalah apa yang terjadi SETELAH itu — dan di situlah janji sebelumnya tidak
 * ditepati: `sync()` menerima callback `fetcher`, satu-satunya pemanggilnya adalah penyemai
 * data demo, dan barisnya hanya DIHITUNG lalu dibuang. Koneksi dapat dibuktikan hidup,
 * tetapi datanya tidak pernah bisa masuk.
 *
 * Empat hal yang dibuktikan:
 *
 *  1. **Datanya benar-benar mendarat** sebagai dataset yang dapat dibaca (TC-SYN-01), bukan
 *     sekadar angka di riwayat sinkronisasi.
 *  2. **Kegagalan tercatat sebagai kegagalan** (TC-SYN-04). Riwayat yang memperlihatkan
 *     keberhasilan pada hari basis datanya mati adalah riwayat yang tidak berguna.
 *  3. **Pemotongan dinyatakan** (TC-SYN-05), bukan didiamkan.
 *  4. **Nilai berkoma tidak menggeser kolom** (TC-SYN-06) — satu nama perusahaan
 *     "PT Maju, Tbk" sudah cukup untuk merusak seluruh tabel tanpa satu pun kesalahan muncul.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { createHarness, contextFor, provisionTenant, type Harness, type TenantFixture } from './helpers.ts';
import { ConnectionService, toCsv } from '../src/data-platform-service/connections.ts';
import { DatasetService } from '../src/data-platform-service/index.ts';

let harness: Harness;
let tenant: TenantFixture;
const servers: TcpServer[] = [];

/* ================= Server PostgreSQL tiruan ================= */

function pg(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(5 + body.length);
  out.write(type, 0, 'ascii');
  out.writeUInt32BE(4 + body.length, 1);
  body.copy(out, 5);
  return out;
}

const PG_READY = pg('Z', Buffer.from('I', 'ascii'));
const PG_AUTH_OK = pg('R', Buffer.alloc(4));

function rowDescription(names: string[]): Buffer {
  const head = Buffer.alloc(2);
  head.writeUInt16BE(names.length, 0);
  return pg(
    'T',
    Buffer.concat([head, ...names.map((n) => Buffer.concat([Buffer.from(`${n}\0`, 'utf8'), Buffer.alloc(18)]))]),
  );
}

function dataRow(values: string[]): Buffer {
  const head = Buffer.alloc(2);
  head.writeUInt16BE(values.length, 0);
  const cells = values.map((value) => {
    const payload = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(4);
    length.writeInt32BE(payload.length, 0);
    return Buffer.concat([length, payload]);
  });
  return pg('D', Buffer.concat([head, ...cells]));
}

/** Server yang menjawab jabat tangan lalu satu hasil query. */
async function fakePostgres(queryReply: Buffer): Promise<number> {
  const server = createTcpServer((socket) => {
    socket.on('data', (chunk: Buffer) => {
      // Paket 'Q' adalah query; sisanya bagian jabat tangan.
      socket.write(chunk[0] === 0x51 ? queryReply : Buffer.concat([PG_AUTH_OK, PG_READY]));
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  return typeof address === 'object' && address ? address.port : 0;
}

/* ================= Perkakas ================= */

function services(): { connections: ConnectionService; datasets: DatasetService } {
  const ctx = contextFor(harness, tenant.tenantId, ['super_admin'], { mfaEnrolled: true });
  return { connections: new ConnectionService(ctx, harness.keyring), datasets: new DatasetService(ctx) };
}

/** Membuat koneksi PostgreSQL yang menunjuk ke server tiruan, beserta query-nya. */
function makeConnection(connections: ConnectionService, port: number, query: string, rowLimit?: number): string {
  const created = connections.create({
    name: 'Gudang Data',
    kind: 'postgresql',
    host: '127.0.0.1',
    port,
    databaseName: 'analitik',
    username: 'vantik',
    secrets: { password: 'sandi' },
    options: { query, ...(rowLimit ? { rowLimit } : {}) },
  } as never) as { id: string };
  return created.id;
}

/** Menyerap CSV menjadi dataset, persis seperti rute HTTP. */
const ingestInto = (datasets: DatasetService) => (csv: string, name: string) => {
  datasets.upload({ filename: `${name.replace(/[^\w.-]+/g, '-')}.csv`, content: Buffer.from(csv, 'utf8'), name });
};

beforeEach(() => {
  harness = createHarness();
  tenant = provisionTenant(harness, { trialDays: 30 });
});

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  harness.cleanup();
});

/* ================= Jalur berhasil ================= */

describe('Menarik data menjadi dataset', () => {
  it('TC-SYN-01 — baris dari basis data benar-benar mendarat dan dapat dibaca kembali', async () => {
    const port = await fakePostgres(
      Buffer.concat([
        rowDescription(['wilayah', 'nilai']),
        dataRow(['Jakarta', '1500']),
        dataRow(['Bandung', '900']),
        PG_READY,
      ]),
    );
    const { connections, datasets } = services();
    const id = makeConnection(connections, port, 'SELECT wilayah, nilai FROM penjualan');

    const hasil = await connections.syncFromSource(id, ingestInto(datasets));

    expect(hasil.outcome).toBe('success');
    expect(hasil.rowsIngested).toBe(2);

    // Yang penting bukan angkanya, melainkan bahwa datanya ADA dan terbaca.
    const dataset = datasets.list()[0]!;
    expect(dataset.row_count).toBe(2);
    const rows = datasets.allRows(dataset.id);
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).toContain('Jakarta');
    expect(JSON.stringify(rows)).toContain('1500');
  });

  it('TC-SYN-02 — riwayat sinkronisasi mencatat keberhasilan berikut jumlah barisnya', async () => {
    const port = await fakePostgres(Buffer.concat([rowDescription(['a']), dataRow(['1']), PG_READY]));
    const { connections, datasets } = services();
    const id = makeConnection(connections, port, 'SELECT a FROM t');

    await connections.syncFromSource(id, ingestInto(datasets));

    const runs = connections.syncHistory(id) as Array<{ outcome: string; rows_ingested: number }>;
    expect(runs[0]!.outcome).toBe('success');
    expect(runs[0]!.rows_ingested).toBe(1);
  });

  it('TC-SYN-03 — tabel kosong adalah keberhasilan, bukan kegagalan', async () => {
    // Nol baris memang hasil yang sah. Menyamakannya dengan kegagalan membuat operator
    // mengejar masalah yang tidak ada.
    const port = await fakePostgres(Buffer.concat([rowDescription(['a']), PG_READY]));
    const { connections, datasets } = services();
    const id = makeConnection(connections, port, 'SELECT a FROM kosong');

    const hasil = await connections.syncFromSource(id, ingestInto(datasets));

    expect(hasil.outcome).toBe('success');
    expect(hasil.rowsIngested).toBe(0);
  });
});

/* ================= Kegagalan & batas ================= */

describe('Kegagalan dan batas', () => {
  it('TC-SYN-04 — query yang ditolak basis data tercatat sebagai KEGAGALAN', async () => {
    const errorFrame = pg(
      'E',
      Buffer.concat([Buffer.from('C42P01\0', 'utf8'), Buffer.from('Mtidak ada\0', 'utf8'), Buffer.alloc(1)]),
    );
    const port = await fakePostgres(Buffer.concat([errorFrame, PG_READY]));
    const { connections, datasets } = services();
    const id = makeConnection(connections, port, 'SELECT * FROM tidak_ada');

    await expect(connections.syncFromSource(id, ingestInto(datasets))).rejects.toMatchObject({
      messageKey: 'error.query_failed',
    });

    // Riwayat yang memperlihatkan keberhasilan pada hari basis datanya bermasalah adalah
    // riwayat yang tidak berguna.
    const runs = connections.syncHistory(id) as Array<{ outcome: string; message_key: string | null }>;
    expect(runs[0]!.outcome).toBe('query_failed');
    // Alasan yang SEBENARNYA, bukan "tidak terjangkau": salah ketik nama tabel akan
    // mengirim operator memeriksa kredensial — tempat yang sama sekali salah.
    expect(runs[0]!.message_key).toBe('error.query_failed');
    // Dan tidak ada dataset setengah jadi yang tertinggal.
    expect(datasets.list()).toHaveLength(0);
  });

  it('TC-SYN-04b — query yang salah TIDAK mengunci koneksi yang sehat', async () => {
    const errorFrame = pg(
      'E',
      Buffer.concat([Buffer.from('C42P01\0', 'utf8'), Buffer.from('Mtidak ada\0', 'utf8'), Buffer.alloc(1)]),
    );
    const port = await fakePostgres(Buffer.concat([errorFrame, PG_READY]));
    const { connections, datasets } = services();
    const id = makeConnection(connections, port, 'SELECT * FROM tidak_ada');

    // Tiga kali salah ketik nama tabel. Bila dihitung sebagai kegagalan koneksi, ini
    // mengunci koneksi yang sebenarnya sehat — dan yang terkunci bukan hanya orang yang
    // salah ketik, melainkan seluruh sinkronisasi terjadwal di belakangnya.
    for (let i = 0; i < 3; i++) {
      await expect(connections.syncFromSource(id, ingestInto(datasets))).rejects.toThrow();
    }

    const conn = harness.db
      .prepare('SELECT status, consecutive_failures, locked_until FROM external_connections WHERE id = ?')
      .get(id) as { status: string; consecutive_failures: number; locked_until: string | null };
    expect(conn.consecutive_failures).toBe(0);
    expect(conn.locked_until).toBeNull();
    expect(conn.status).toBe('connected');
  });

  it('TC-SYN-05 — hasil yang dipotong DINYATAKAN kepada pemanggil', async () => {
    const baris = Array.from({ length: 10 }, (_, i) => dataRow([`baris-${i}`]));
    const port = await fakePostgres(Buffer.concat([rowDescription(['nama']), ...baris, PG_READY]));
    const { connections, datasets } = services();
    const id = makeConnection(connections, port, 'SELECT nama FROM banyak', 3);

    const hasil = await connections.syncFromSource(id, ingestInto(datasets));

    // Diam-diam memotong berarti laporan yang salah tanpa ada yang tahu.
    expect(hasil.truncated).toBe(true);
    expect(hasil.rowsIngested).toBe(3);
  });

  it('TC-SYN-06 — nilai berkoma dan berkutip tidak menggeser kolom', () => {
    // Satu nama perusahaan sudah cukup merusak seluruh tabel tanpa kesalahan apa pun muncul.
    const csv = toCsv(
      ['nama', 'catatan'],
      [
        ['PT Maju, Tbk', 'baik'],
        ['PT "Sejahtera"', 'baris\nbaru'],
      ],
    );

    expect(csv.split('\n')[0]).toBe('nama,catatan');
    expect(csv).toContain('"PT Maju, Tbk"');
    expect(csv).toContain('"PT ""Sejahtera"""');
    expect(csv).toContain('"baris\nbaru"');
  });

  it('TC-SYN-07 — koneksi tanpa query ditolak sebelum menyentuh jaringan', async () => {
    const { connections, datasets } = services();
    // Port yang tidak ada yang mendengarkan: bila jaringan sempat disentuh, yang muncul
    // adalah kegagalan koneksi, bukan kunci pesan di bawah.
    const id = makeConnection(connections, 1, '');

    await expect(connections.syncFromSource(id, ingestInto(datasets))).rejects.toMatchObject({
      messageKey: 'error.query_not_configured',
    });
  });

  it('TC-SYN-08 — query yang menulis ditolak, dan tidak ada dataset yang dibuat', async () => {
    const port = await fakePostgres(Buffer.concat([rowDescription(['a']), PG_READY]));
    const { connections, datasets } = services();
    const id = makeConnection(connections, port, 'DELETE FROM pelanggan');

    await expect(connections.syncFromSource(id, ingestInto(datasets))).rejects.toMatchObject({
      messageKey: 'error.query_select_only',
    });
    expect(datasets.list()).toHaveLength(0);
  });

  it('TC-SYN-09 — peran tanpa connection:sync tertahan', async () => {
    const port = await fakePostgres(Buffer.concat([rowDescription(['a']), PG_READY]));
    const { connections, datasets } = services();
    const id = makeConnection(connections, port, 'SELECT a FROM t');

    const supervisor = new ConnectionService(
      contextFor(harness, tenant.tenantId, ['supervisor']),
      harness.keyring,
    );

    await expect(supervisor.syncFromSource(id, ingestInto(datasets))).rejects.toThrow();
  });
});

/* ================= Kredensial ================= */

describe('Kredensial', () => {
  it('TC-SYN-10 — kata sandi tidak pernah muncul di riwayat maupun hasil', async () => {
    const port = await fakePostgres(Buffer.concat([rowDescription(['a']), dataRow(['1']), PG_READY]));
    const { connections, datasets } = services();
    const id = makeConnection(connections, port, 'SELECT a FROM t');

    const hasil = await connections.syncFromSource(id, ingestInto(datasets));

    expect(JSON.stringify(hasil)).not.toContain('sandi');
    expect(JSON.stringify(connections.syncHistory(id))).not.toContain('sandi');
    // Termasuk di Log Aktivitas, yang dapat dibaca auditor.
    const log = harness.db
      .prepare("SELECT detail_json FROM auditdb.audit_log WHERE action = 'connection.sync'")
      .all() as Array<{ detail_json: string | null }>;
    expect(JSON.stringify(log)).not.toContain('sandi');
  });
});
