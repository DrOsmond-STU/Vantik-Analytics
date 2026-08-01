"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuotaExceededError = exports.RateLimitedError = exports.PayloadTooLargeError = exports.ConflictError = exports.NotFoundError = exports.ForbiddenError = exports.UnauthenticatedError = exports.ValidationError = exports.AppError = void 0;
exports.crossTenantAsNotFound = crossTenantAsNotFound;
/**
 * Kesalahan terstruktur lintas layanan.
 *
 * `messageKey` selalu merujuk kunci kamus i18n (DESIGN.md 8.2) — TIDAK ADA string UI
 * tertanam langsung di kode (TASK_INSTRUCTION.md Bagian 5 "Definition of Done").
 * Frontend menerjemahkan kunci; `detail` hanya untuk konteks teknis non-UI.
 */
class AppError extends Error {
    status;
    messageKey;
    detail;
    constructor(status, messageKey, detail) {
        super(messageKey);
        this.status = status;
        this.messageKey = messageKey;
        this.detail = detail;
        this.name = new.target.name;
    }
}
exports.AppError = AppError;
/** 400 — masukan tidak valid. */
class ValidationError extends AppError {
    constructor(messageKey, detail) {
        super(400, messageKey, detail);
    }
}
exports.ValidationError = ValidationError;
/** 401 — belum terautentikasi / sesi tidak berlaku. */
class UnauthenticatedError extends AppError {
    constructor(messageKey = 'error.unauthenticated', detail) {
        super(401, messageKey, detail);
    }
}
exports.UnauthenticatedError = UnauthenticatedError;
/**
 * 403 — terautentikasi tetapi tidak berwenang.
 * SECURITY.md Bagian 9: percobaan akses yang ditolak WAJIB tercatat di Log Aktivitas
 * sebagai potensi insiden keamanan — dicatat oleh error handler, bukan diserahkan
 * ke tiap pemanggil untuk mengingat.
 */
class ForbiddenError extends AppError {
    constructor(messageKey = 'error.forbidden', detail) {
        super(403, messageKey, detail);
    }
}
exports.ForbiddenError = ForbiddenError;
/** 404 — objek tidak ada, ATAU ada tetapi milik tenant lain (lihat catatan di bawah). */
class NotFoundError extends AppError {
    constructor(messageKey = 'error.not_found', detail) {
        super(404, messageKey, detail);
    }
}
exports.NotFoundError = NotFoundError;
/** 409 — konflik status (mis. dataset sudah tersertifikasi). */
class ConflictError extends AppError {
    constructor(messageKey, detail) {
        super(409, messageKey, detail);
    }
}
exports.ConflictError = ConflictError;
/** 413 — melebihi batas ukuran (SECURITY.md Bagian 7). */
class PayloadTooLargeError extends AppError {
    constructor(messageKey = 'error.upload_failed', detail) {
        super(413, messageKey, detail);
    }
}
exports.PayloadTooLargeError = PayloadTooLargeError;
/** 429 — melebihi rate limit / kuota (SECURITY.md 15, PRD 6.29). */
class RateLimitedError extends AppError {
    constructor(messageKey = 'error.rate_limited', detail) {
        super(429, messageKey, detail);
    }
}
exports.RateLimitedError = RateLimitedError;
/**
 * 402 — kuota paket langganan terlampaui dengan perilaku "blokir" (PRD 6.29).
 * Dipisah dari 429 agar UI dapat menawarkan upgrade paket, bukan sekadar "coba lagi nanti".
 */
class QuotaExceededError extends AppError {
    constructor(messageKey = 'error.quota_exceeded', detail) {
        super(402, messageKey, detail);
    }
}
exports.QuotaExceededError = QuotaExceededError;
/**
 * Objek milik tenant lain SELALU dilaporkan sebagai 404, bukan 403.
 * Membalas 403 akan membocorkan keberadaan objek milik tenant lain (enumeration oracle) —
 * bertentangan dengan SECURITY.md Bagian 16.1 yang menuntut isolasi tenant mutlak.
 */
function crossTenantAsNotFound(detail) {
    return new NotFoundError('error.not_found', detail);
}
//# sourceMappingURL=errors.js.map