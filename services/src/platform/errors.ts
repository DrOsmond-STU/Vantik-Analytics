/**
 * Kesalahan terstruktur lintas layanan.
 *
 * `messageKey` selalu merujuk kunci kamus i18n (DESIGN.md 8.2) — TIDAK ADA string UI
 * tertanam langsung di kode (TASK_INSTRUCTION.md Bagian 5 "Definition of Done").
 * Frontend menerjemahkan kunci; `detail` hanya untuk konteks teknis non-UI.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly messageKey: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(messageKey);
    this.name = new.target.name;
  }
}

/** 400 — masukan tidak valid. */
export class ValidationError extends AppError {
  constructor(messageKey: string, detail?: Record<string, unknown>) {
    super(400, messageKey, detail);
  }
}

/** 401 — belum terautentikasi / sesi tidak berlaku. */
export class UnauthenticatedError extends AppError {
  constructor(messageKey = 'error.unauthenticated', detail?: Record<string, unknown>) {
    super(401, messageKey, detail);
  }
}

/**
 * 403 — terautentikasi tetapi tidak berwenang.
 * SECURITY.md Bagian 9: percobaan akses yang ditolak WAJIB tercatat di Log Aktivitas
 * sebagai potensi insiden keamanan — dicatat oleh error handler, bukan diserahkan
 * ke tiap pemanggil untuk mengingat.
 */
export class ForbiddenError extends AppError {
  constructor(messageKey = 'error.forbidden', detail?: Record<string, unknown>) {
    super(403, messageKey, detail);
  }
}

/** 404 — objek tidak ada, ATAU ada tetapi milik tenant lain (lihat catatan di bawah). */
export class NotFoundError extends AppError {
  constructor(messageKey = 'error.not_found', detail?: Record<string, unknown>) {
    super(404, messageKey, detail);
  }
}

/** 409 — konflik status (mis. dataset sudah tersertifikasi). */
export class ConflictError extends AppError {
  constructor(messageKey: string, detail?: Record<string, unknown>) {
    super(409, messageKey, detail);
  }
}

/** 413 — melebihi batas ukuran (SECURITY.md Bagian 7). */
export class PayloadTooLargeError extends AppError {
  constructor(messageKey = 'error.upload_failed', detail?: Record<string, unknown>) {
    super(413, messageKey, detail);
  }
}

/** 429 — melebihi rate limit / kuota (SECURITY.md 15, PRD 6.29). */
export class RateLimitedError extends AppError {
  constructor(messageKey = 'error.rate_limited', detail?: Record<string, unknown>) {
    super(429, messageKey, detail);
  }
}

/**
 * 402 — kuota paket langganan terlampaui dengan perilaku "blokir" (PRD 6.29).
 * Dipisah dari 429 agar UI dapat menawarkan upgrade paket, bukan sekadar "coba lagi nanti".
 */
export class QuotaExceededError extends AppError {
  constructor(messageKey = 'error.quota_exceeded', detail?: Record<string, unknown>) {
    super(402, messageKey, detail);
  }
}

/**
 * Objek milik tenant lain SELALU dilaporkan sebagai 404, bukan 403.
 * Membalas 403 akan membocorkan keberadaan objek milik tenant lain (enumeration oracle) —
 * bertentangan dengan SECURITY.md Bagian 16.1 yang menuntut isolasi tenant mutlak.
 */
export function crossTenantAsNotFound(detail?: Record<string, unknown>): NotFoundError {
  return new NotFoundError('error.not_found', detail);
}
