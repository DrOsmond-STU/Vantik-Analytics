/**
 * Pengurasan antrean notifikasi.
 *
 * Berkas ini ada karena satu kesalahan yang lolos dari 20 uji transport: transport dapat
 * berbicara SMTP dengan sempurna dan tetap TIDAK ADA yang terkirim, sebab `markSent()` dan
 * `markFailed()` tidak pernah dipanggil dari mana pun. Operator yang mengisi kredensialnya
 * dengan benar akan melihat antrean yang tidak bergerak, tanpa satu pun pesan kesalahan.
 * Yang dibuktikan di sini bukan protokolnya, melainkan bahwa pesan benar-benar berpindah
 * status — dan empat keputusan yang mudah salah tanpa terlihat:
 *
 *  1. **Kanal yang belum dikonfigurasi DILEWATI** (TC-OBD-05), tidak dihitung sebagai
 *     percobaan. Menghitungnya akan menghabiskan batas percobaan pesan yang belum pernah
 *     punya tujuan, lalu menandainya `failed` — padahal yang benar adalah "menunggu
 *     dikonfigurasi", dan isinya harus tetap dapat dibaca operator.
 *  2. **Gangguan sesaat tidak permanen** (TC-OBD-06): pesan tetap `queued` sampai batas
 *     percobaan habis, bukan `failed` pada kegagalan pertama.
 *  3. **Tidak ada pengiriman ganda** (TC-OBD-09). Dua sapuan yang bertemu pada baris yang
 *     sama berarti pengguna menerima OTP dua kali, dan yang kedua membingungkan.
 *  4. **Isi pesan sensitif dihapus setelah terkirim** (TC-OBD-03) — setelah benar-benar
 *     sampai, OTP di basis data berhenti menjadi jalan pemulihan dan tinggal jadi rahasia
 *     yang mengendap.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, provisionTenant, type Harness, type TenantFixture } from './helpers.ts';
import { NotificationOutbox } from '../src/platform/outbox.ts';
import { MAX_OUTBOX_ATTEMPTS, OUTBOX_BATCH, OutboxDispatcher } from '../src/platform/outboxDispatcher.ts';
import type { Channel, NotificationTransport } from '../src/alerting-service/index.ts';

let harness: Harness;
let tenant: TenantFixture;
let outbox: NotificationOutbox;

beforeEach(() => {
  harness = createHarness();
  tenant = provisionTenant(harness);
  outbox = new NotificationOutbox(harness.db);
});

afterEach(() => harness.cleanup());

/** Transport palsu yang dapat diatur: kanal apa yang dilayaninya, dan apakah ia berhasil. */
class TransportUji implements NotificationTransport {
  readonly delivers = true;
  readonly terkirim: Array<{ channel: Channel; recipient: string; subject: string; body: string }> = [];
  gagalDengan: string | null = null;
  lempar = false;

  constructor(private readonly kanal: Channel[] | null = null) {}

  canDeliver(channel: Channel): boolean {
    return this.kanal === null ? true : this.kanal.includes(channel);
  }

  async send(input: { channel: Channel; recipient: string; subject: string; body: string }): Promise<{
    delivered: boolean;
    failureReason?: string;
  }> {
    if (this.lempar) throw new TypeError('transport rusak');
    if (this.gagalDengan) return { delivered: false, failureReason: this.gagalDengan };
    this.terkirim.push(input);
    return { delivered: true };
  }
}

function antrekan(overrides: Partial<{ channel: string; recipient: string; sensitive: boolean }> = {}): string {
  return outbox.enqueue({
    tenantId: tenant.tenantId,
    purpose: 'uji',
    channel: overrides.channel ?? 'email',
    recipient: overrides.recipient ?? 'penerima@contoh.id',
    subject: 'Subjek uji',
    body: 'isi pesan uji',
    sensitive: overrides.sensitive,
  });
}

function baris(id: string): { status: string; attempts: number; failure_reason: string | null; body: string } {
  return harness.db
    .prepare('SELECT status, attempts, failure_reason, body FROM notification_outbox WHERE id = ?')
    .get(id) as { status: string; attempts: number; failure_reason: string | null; body: string };
}

/* ================= Pengiriman ================= */

describe('Pengurasan antrean', () => {
  it('TC-OBD-01 — pesan menunggu benar-benar dikirim dan ditandai terkirim', async () => {
    const id = antrekan();
    const transport = new TransportUji();

    const hasil = await new OutboxDispatcher(outbox, transport).dispatchDue();

    expect(hasil).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(transport.terkirim).toHaveLength(1);
    expect(transport.terkirim[0]).toMatchObject({ recipient: 'penerima@contoh.id', body: 'isi pesan uji' });
    expect(baris(id)).toMatchObject({ status: 'sent', attempts: 1, failure_reason: null });
  });

  it('TC-OBD-02 — pesan yang sudah terkirim tidak dikirim ulang pada sapuan berikutnya', async () => {
    antrekan();
    const transport = new TransportUji();
    const dispatcher = new OutboxDispatcher(outbox, transport);

    await dispatcher.dispatchDue();
    const kedua = await dispatcher.dispatchDue();

    expect(kedua.sent).toBe(0);
    expect(transport.terkirim).toHaveLength(1);
  });

  it('TC-OBD-03 — isi pesan sensitif dihapus setelah terkirim, isi biasa dipertahankan', async () => {
    const otp = antrekan({ sensitive: true });
    const biasa = antrekan();
    const transport = new TransportUji();

    await new OutboxDispatcher(outbox, transport).dispatchDue();

    // Yang dikirim tetap lengkap — penghapusan terjadi SESUDAH pesan sampai.
    expect(transport.terkirim.map((m) => m.body)).toEqual(['isi pesan uji', 'isi pesan uji']);
    expect(baris(otp).body).toBe('');
    expect(baris(biasa).body).toBe('isi pesan uji');
  });

  it('TC-OBD-04 — transport yang tidak mengirim apa pun tidak menyentuh antrean', async () => {
    const id = antrekan();
    const diam: NotificationTransport = {
      delivers: false,
      send: async () => ({ delivered: false, failureReason: 'no_transport_configured' }),
    };

    const hasil = await new OutboxDispatcher(outbox, diam).dispatchDue();

    // Perilaku bawaan tidak berubah: tetap `queued`, tanpa percobaan yang terbuang.
    expect(hasil).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(baris(id)).toMatchObject({ status: 'queued', attempts: 0 });
  });
});

/* ================= Kanal yang belum dikonfigurasi ================= */

describe('Kanal belum dikonfigurasi', () => {
  it('TC-OBD-05 — dilewati tanpa menambah percobaan, dan isinya tetap dapat dibaca', async () => {
    const surel = antrekan({ channel: 'email' });
    const teams = antrekan({ channel: 'teams' });
    const transport = new TransportUji(['email']);

    const hasil = await new OutboxDispatcher(outbox, transport).dispatchDue();

    expect(hasil).toEqual({ sent: 1, failed: 0, skipped: 1 });
    expect(baris(surel).status).toBe('sent');
    // Inilah yang penting: Teams tidak menjadi `failed`, percobaannya tidak terpakai, dan
    // operator masih dapat membaca isinya untuk disampaikan manual.
    expect(baris(teams)).toMatchObject({ status: 'queued', attempts: 0, failure_reason: null });
    expect(baris(teams).body).toBe('isi pesan uji');
  });

  it('TC-OBD-05b — antrean yang seluruhnya belum berkanal tidak membuat sapuan berputar tanpa akhir', async () => {
    for (let i = 0; i < OUTBOX_BATCH + 5; i++) antrekan({ channel: 'slack' });
    const transport = new TransportUji(['email']);

    const hasil = await new OutboxDispatcher(outbox, transport).dispatchDue();

    // Satu batch, lalu berhenti: tidak ada baris yang berubah, jadi mengulang mustahil
    // menghasilkan hasil lain.
    expect(hasil).toEqual({ sent: 0, failed: 0, skipped: OUTBOX_BATCH });
  });
});

/* ================= Kegagalan dan percobaan ulang ================= */

describe('Kegagalan', () => {
  it('TC-OBD-06 — kegagalan pertama TIDAK permanen: statusnya tetap menunggu', async () => {
    const id = antrekan();
    const transport = new TransportUji();
    transport.gagalDengan = 'smtp_421';

    const hasil = await new OutboxDispatcher(outbox, transport).dispatchDue();

    expect(hasil).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(baris(id)).toMatchObject({ status: 'queued', attempts: 1, failure_reason: 'smtp_421' });
  });

  it('TC-OBD-07 — menyerah setelah batas percobaan, dengan alasan terakhir tercatat', async () => {
    const id = antrekan();
    const transport = new TransportUji();
    transport.gagalDengan = 'smtp_550';
    const dispatcher = new OutboxDispatcher(outbox, transport);

    for (let i = 0; i < MAX_OUTBOX_ATTEMPTS; i++) await dispatcher.dispatchDue();

    expect(baris(id)).toMatchObject({
      status: 'failed',
      attempts: MAX_OUTBOX_ATTEMPTS,
      failure_reason: 'smtp_550',
    });
    // Baris `failed` tidak diambil lagi — percobaan tidak bertambah setelah menyerah.
    await dispatcher.dispatchDue();
    expect(baris(id).attempts).toBe(MAX_OUTBOX_ATTEMPTS);
  });

  it('TC-OBD-08 — transport yang melempar diperlakukan sebagai kegagalan, bukan menjatuhkan sapuan', async () => {
    const id = antrekan();
    const transport = new TransportUji();
    transport.lempar = true;

    const hasil = await new OutboxDispatcher(outbox, transport).dispatchDue();

    expect(hasil.sent).toBe(0);
    // Hanya NAMA kesalahan yang dicatat: pesan kesalahan dapat memuat URL berikut tokennya,
    // dan kolom ini dapat dibaca operator.
    expect(baris(id)).toMatchObject({ status: 'queued', attempts: 1, failure_reason: 'typeerror' });
  });
});

/* ================= Ketertiban ================= */

describe('Ketertiban sapuan', () => {
  it('TC-OBD-09 — dua sapuan yang bertemu tidak mengirim pesan yang sama dua kali', async () => {
    antrekan();
    const transport = new TransportUji();
    const dispatcher = new OutboxDispatcher(outbox, transport);

    await Promise.all([dispatcher.dispatchDue(), dispatcher.dispatchDue(), dispatcher.dispatchDue()]);

    // Tanpa penjaga, tiga sapuan membaca baris `queued` yang sama dan pengguna menerima
    // OTP-nya tiga kali.
    expect(transport.terkirim).toHaveLength(1);
  });

  it('TC-OBD-10 — pesan yang berulang gagal tidak menghalangi pesan baru', async () => {
    const macet = antrekan({ recipient: 'macet@contoh.id' });
    const transport = new TransportUji();
    transport.gagalDengan = 'smtp_451';
    const dispatcher = new OutboxDispatcher(outbox, transport);
    await dispatcher.dispatchDue();
    await dispatcher.dispatchDue();

    transport.gagalDengan = null;
    const baru = antrekan({ recipient: 'baru@contoh.id' });
    await dispatcher.dispatchDue();

    // Urutannya menurut jumlah percobaan lebih dulu: yang baru mendapat giliran pertama,
    // bukan menunggu di belakang alamat yang sudah dua kali gagal.
    expect(transport.terkirim.map((m) => m.recipient)).toEqual(['baru@contoh.id', 'macet@contoh.id']);
    expect(baris(baru).status).toBe('sent');
    // Yang macet pun akhirnya terkirim begitu gangguannya berhenti — percobaan sebelumnya
    // tetap terhitung, jadi batas percobaan tidak diam-diam kembali ke nol.
    expect(baris(macet)).toMatchObject({ status: 'sent', attempts: 3 });
  });

  it('TC-OBD-11 — antrean lebih panjang dari satu batch terkuras dalam satu sapuan', async () => {
    for (let i = 0; i < OUTBOX_BATCH + 7; i++) antrekan({ recipient: `orang${i}@contoh.id` });
    const transport = new TransportUji();

    const hasil = await new OutboxDispatcher(outbox, transport).dispatchDue();

    expect(hasil.sent).toBe(OUTBOX_BATCH + 7);
  });
});

/* ================= Pemicu saat pesan masuk ================= */

describe('Pemicu saat masuk antrean', () => {
  it('TC-OBD-12 — `attach()` membuat pesan terkirim tanpa menunggu penjadwal', async () => {
    const transport = new TransportUji();
    new OutboxDispatcher(outbox, transport).attach();

    const id = antrekan();
    // Pemicunya dijalankan setelah pemanggil selesai — supaya respons HTTP tidak menunggu
    // percakapan SMTP — jadi pada saat ini belum ada apa pun yang terkirim.
    expect(baris(id).status).toBe('queued');

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(baris(id).status).toBe('sent');
    expect(transport.terkirim).toHaveLength(1);
  });

  it('TC-OBD-13 — tanpa kanal terkonfigurasi, `attach()` tidak memasang pemicu apa pun', async () => {
    let dipanggil = 0;
    const diam: NotificationTransport = {
      delivers: false,
      send: async () => {
        dipanggil += 1;
        return { delivered: false };
      },
    };
    new OutboxDispatcher(outbox, diam).attach();

    antrekan();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // Tidak ada percakapan jaringan yang dimulai untuk antrean yang tidak punya tujuan.
    expect(dipanggil).toBe(0);
  });
});
