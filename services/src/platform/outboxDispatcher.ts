/**
 * Pengirim antrean notifikasi.
 *
 * Alasan keberadaannya: `NotificationOutbox` hanya MENYIMPAN. Sebelum berkas ini ada,
 * `markSent()` dan `markFailed()` tidak pernah dipanggil dari mana pun — artinya operator
 * yang mengisi kredensial SMTP dengan benar tetap tidak akan melihat satu pun pesan
 * terkirim, dan kode pemulihan kata sandi tetap mengendap di antrean selamanya. Konfigurasi
 * yang tidak mengubah apa pun adalah bentuk kegagalan yang paling sulit didiagnosis, karena
 * semua bagiannya tampak benar.
 *
 * Dijalankan di dua tempat, dan keduanya diperlukan:
 *
 *  1. **Segera setelah pesan masuk antrean** (`kick()`), karena OTP pemindahan perangkat
 *     hanya berguna dalam hitungan menit — menunggu putaran penjadwal berikutnya membuat
 *     jalur pemulihan terasa rusak meski akhirnya berhasil.
 *  2. **Dari penjadwal**, karena Passenger mematikan proses yang idle: pengiriman yang
 *     dimulai di langkah 1 dapat mati bersama prosesnya, dan hanya sapuan berkalalah yang
 *     memastikan pesan yang tertinggal tetap terkirim.
 */
import type { Channel, NotificationTransport } from '../alerting-service/index.ts';
import type { NotificationOutbox } from './outbox.ts';

/**
 * Batas percobaan per pesan.
 *
 * Cukup untuk melewati gangguan sesaat, tetapi berhenti pada alamat yang memang salah —
 * mencoba selamanya berarti setiap putaran penjadwal membayar timeout SMTP untuk pesan yang
 * tidak akan pernah terkirim, dan itu memperlambat pengiriman pesan yang masih bisa.
 */
export const MAX_OUTBOX_ATTEMPTS = 5;

/** Banyak pesan per batch. Dibatasi agar satu putaran tidak menahan proses terlalu lama. */
export const OUTBOX_BATCH = 25;

/**
 * Batas batch per sapuan.
 *
 * Sapuan menguras antrean selama masih ada kemajuan, tetapi tidak tanpa batas: proses di
 * shared hosting juga harus melayani permintaan, dan antrean yang tiba-tiba panjang lebih
 * baik dihabiskan pada beberapa putaran penjadwal daripada menahan satu proses berjam-jam.
 */
export const MAX_SWEEP_ROUNDS = 20;

export interface DispatchResult {
  sent: number;
  failed: number;
  /** Pesan yang kanalnya belum dikonfigurasi: DILEWATI, tetap `queued`, tanpa menambah percobaan. */
  skipped: number;
}

export class OutboxDispatcher {
  private running = false;
  private queuedKick = false;

  constructor(
    private readonly outbox: NotificationOutbox,
    private readonly transport: NotificationTransport,
  ) {}

  /**
   * Menyalakan pengiriman segera setelah `enqueue()`, tanpa menahan pemanggilnya.
   *
   * Dipanggil dari jalur permintaan HTTP: pengguna yang menekan "lupa kata sandi" tidak
   * boleh menunggu percakapan SMTP selesai — 15 detik timeout akan terlihat sebagai aplikasi
   * yang menggantung. Karena itu sapuan dijalankan setelah respons keluar, dan setiap
   * kesalahan di dalamnya DITELAN: pengiriman yang gagal tidak boleh menjatuhkan proses.
   */
  attach(): void {
    if (!this.transport.delivers) return; // tanpa tujuan, sapuan hanya membakar putaran
    this.outbox.setDispatchHook(() => {
      setImmediate(() => {
        void this.dispatchDue().catch(() => undefined);
      });
    });
  }

  /**
   * Mengirim satu batch pesan yang menunggu.
   *
   * Tidak berjalan ganda: sapuan dari penjadwal dan sapuan dari `enqueue()` dapat bertemu,
   * dan dua pengirim yang membaca baris `queued` yang sama akan mengirim pesan itu dua kali.
   * Bila sapuan kedua datang saat yang pertama berjalan, ia ditandai untuk dijalankan sekali
   * lagi sesudahnya — bukan dibuang, karena baris yang memicunya mungkin belum terbaca.
   */
  async dispatchDue(): Promise<DispatchResult> {
    if (this.running) {
      this.queuedKick = true;
      return { sent: 0, failed: 0, skipped: 0 };
    }

    this.running = true;
    const total: DispatchResult = { sent: 0, failed: 0, skipped: 0 };
    try {
      for (let round = 0; round < MAX_SWEEP_ROUNDS; round++) {
        this.queuedKick = false;
        const batch = await this.sweep();
        total.sent += batch.sent;
        total.failed += batch.failed;
        total.skipped += batch.skipped;

        // Baris yang statusnya berubah. Pesan yang DILEWATI tidak termasuk — membaca ulang
        // baris yang sama tidak akan menghasilkan hasil berbeda, jadi putaran yang hanya
        // melewati harus berhenti; kalau tidak, satu kanal yang belum dikonfigurasi cukup
        // untuk membuat sapuan berputar tanpa akhir.
        const changed = batch.sent + batch.failed;
        if (changed === 0) break;

        const batchWasFull = changed + batch.skipped >= OUTBOX_BATCH;
        if (!batchWasFull && !this.queuedKick) break;
      }
    } finally {
      this.running = false;
    }
    return total;
  }

  private async sweep(): Promise<DispatchResult> {
    const result: DispatchResult = { sent: 0, failed: 0, skipped: 0 };
    if (!this.transport.delivers) return result;

    for (const row of this.outbox.pendingAll(OUTBOX_BATCH)) {
      const channel = row.channel as Channel;
      if (this.transport.canDeliver && !this.transport.canDeliver(channel)) {
        // Kanal yang belum dikonfigurasi TIDAK dihitung sebagai kegagalan. Menghitungnya
        // akan menghabiskan batas percobaan pesan yang belum pernah punya tujuan, lalu
        // menandainya `failed` — padahal yang benar adalah "masih menunggu dikonfigurasi".
        result.skipped += 1;
        continue;
      }

      let outcome: { delivered: boolean; failureReason?: string };
      try {
        outcome = await this.transport.send({
          channel,
          recipient: row.recipient,
          subject: row.subject,
          body: row.body,
        });
      } catch (error) {
        // Transport yang melempar diperlakukan sama dengan transport yang menjawab gagal.
        // Namanya saja yang dicatat: pesan kesalahan dapat memuat URL berikut tokennya, dan
        // kolom ini dapat dibaca operator.
        outcome = { delivered: false, failureReason: error instanceof Error ? error.name.toLowerCase() : 'send_threw' };
      }

      if (outcome.delivered) {
        this.outbox.markSent(row.id);
        result.sent += 1;
        continue;
      }

      const status = this.outbox.recordFailure(row.id, outcome.failureReason ?? 'send_failed', MAX_OUTBOX_ATTEMPTS);
      if (status === 'failed') result.failed += 1;
    }
    return result;
  }
}
