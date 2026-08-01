"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OutboxDispatcher = exports.MAX_SWEEP_ROUNDS = exports.OUTBOX_BATCH = exports.MAX_OUTBOX_ATTEMPTS = void 0;
/**
 * Batas percobaan per pesan.
 *
 * Cukup untuk melewati gangguan sesaat, tetapi berhenti pada alamat yang memang salah —
 * mencoba selamanya berarti setiap putaran penjadwal membayar timeout SMTP untuk pesan yang
 * tidak akan pernah terkirim, dan itu memperlambat pengiriman pesan yang masih bisa.
 */
exports.MAX_OUTBOX_ATTEMPTS = 5;
/** Banyak pesan per batch. Dibatasi agar satu putaran tidak menahan proses terlalu lama. */
exports.OUTBOX_BATCH = 25;
/**
 * Batas batch per sapuan.
 *
 * Sapuan menguras antrean selama masih ada kemajuan, tetapi tidak tanpa batas: proses di
 * shared hosting juga harus melayani permintaan, dan antrean yang tiba-tiba panjang lebih
 * baik dihabiskan pada beberapa putaran penjadwal daripada menahan satu proses berjam-jam.
 */
exports.MAX_SWEEP_ROUNDS = 20;
class OutboxDispatcher {
    outbox;
    transport;
    running = false;
    queuedKick = false;
    constructor(outbox, transport) {
        this.outbox = outbox;
        this.transport = transport;
    }
    /**
     * Menyalakan pengiriman segera setelah `enqueue()`, tanpa menahan pemanggilnya.
     *
     * Dipanggil dari jalur permintaan HTTP: pengguna yang menekan "lupa kata sandi" tidak
     * boleh menunggu percakapan SMTP selesai — 15 detik timeout akan terlihat sebagai aplikasi
     * yang menggantung. Karena itu sapuan dijalankan setelah respons keluar, dan setiap
     * kesalahan di dalamnya DITELAN: pengiriman yang gagal tidak boleh menjatuhkan proses.
     */
    attach() {
        if (!this.transport.delivers)
            return; // tanpa tujuan, sapuan hanya membakar putaran
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
    async dispatchDue() {
        if (this.running) {
            this.queuedKick = true;
            return { sent: 0, failed: 0, skipped: 0 };
        }
        this.running = true;
        const total = { sent: 0, failed: 0, skipped: 0 };
        try {
            for (let round = 0; round < exports.MAX_SWEEP_ROUNDS; round++) {
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
                if (changed === 0)
                    break;
                const batchWasFull = changed + batch.skipped >= exports.OUTBOX_BATCH;
                if (!batchWasFull && !this.queuedKick)
                    break;
            }
        }
        finally {
            this.running = false;
        }
        return total;
    }
    async sweep() {
        const result = { sent: 0, failed: 0, skipped: 0 };
        if (!this.transport.delivers)
            return result;
        for (const row of this.outbox.pendingAll(exports.OUTBOX_BATCH)) {
            const channel = row.channel;
            if (this.transport.canDeliver && !this.transport.canDeliver(channel)) {
                // Kanal yang belum dikonfigurasi TIDAK dihitung sebagai kegagalan. Menghitungnya
                // akan menghabiskan batas percobaan pesan yang belum pernah punya tujuan, lalu
                // menandainya `failed` — padahal yang benar adalah "masih menunggu dikonfigurasi".
                result.skipped += 1;
                continue;
            }
            let outcome;
            try {
                outcome = await this.transport.send({
                    channel,
                    recipient: row.recipient,
                    subject: row.subject,
                    body: row.body,
                });
            }
            catch (error) {
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
            const status = this.outbox.recordFailure(row.id, outcome.failureReason ?? 'send_failed', exports.MAX_OUTBOX_ATTEMPTS);
            if (status === 'failed')
                result.failed += 1;
        }
        return result;
    }
}
exports.OutboxDispatcher = OutboxDispatcher;
//# sourceMappingURL=outboxDispatcher.js.map