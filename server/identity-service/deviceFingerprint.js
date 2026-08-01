"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GEO_TOLERANCE_KM = exports.MAX_PLAUSIBLE_SPEED_KMH = exports.DEFAULT_SIMILARITY_THRESHOLD = void 0;
exports.hashComponents = hashComponents;
exports.fingerprintHash = fingerprintHash;
exports.similarity = similarity;
exports.matchDevice = matchDevice;
exports.haversineKm = haversineKm;
exports.assessTravel = assessTravel;
/**
 * Device Fingerprint — PRD 6.30, SECURITY.md Bagian 17.
 *
 * Catatan jujur yang dituntut SECURITY.md 17.1: fingerprint adalah PENGENDALI KOMERSIAL,
 * bukan kontrol keamanan yang kuat. Fungsinya membuat berbagi akun cukup merepotkan
 * sehingga tidak praktis dilakukan massal — bukan menjadikannya mustahil. Karena itu
 * modul ini tidak pernah menggantikan autentikasi, MFA, atau RBAC.
 *
 * MAC address TIDAK dipakai: tidak terjangkau API browser, tidak sampai ke server
 * (OSI Layer 2), diacak iOS/Android modern, dan mudah dipalsukan (PRD 6.30).
 */
const crypto_ts_1 = require("../platform/crypto.js");
/**
 * Bobot per komponen untuk penilaian kemiripan.
 *
 * Komponen yang berubah saat browser/OS diperbarui (userAgent) diberi bobot rendah;
 * komponen stabil (canvas/WebGL/layar/zona waktu) diberi bobot tinggi. Ini yang membuat
 * pembaruan browser tidak mengunci pengguna sah — SECURITY.md 17.2 menyebut penguncian
 * pengguna berhak sebagai "risiko nyata", bukan sekadar ketidaknyamanan.
 */
const COMPONENT_WEIGHTS = {
    canvasHash: 0.24,
    webglHash: 0.24,
    screenResolution: 0.14,
    timezone: 0.12,
    fonts: 0.1,
    colorDepth: 0.06,
    language: 0.05,
    platform: 0.03,
    userAgent: 0.02,
};
/** Ambang kemiripan default; dapat dikonfigurasi per tenant (SECURITY.md 17.2). */
exports.DEFAULT_SIMILARITY_THRESHOLD = 0.82;
/**
 * Batas panjang tiap komponen fingerprint sebelum diproses.
 *
 * Seluruh nilai ini berasal dari KLIEN dan tidak ada yang berukuran wajar melebihi
 * batas ini — User-Agent browser nyata jauh di bawah 512 karakter. Tanpa batas,
 * masukan yang dirancang khusus memaksa normalisasi regex di bawah menelusuri ulang
 * secara polinomial; di shared hosting, CPU adalah kuota, sehingga satu permintaan
 * dapat menghabiskan jatah seluruh situs. Memotong lebih dulu membuat kasus terburuk
 * menjadi konstan, apa pun bentuk regexnya.
 */
const MAX_COMPONENT_LENGTH = 512;
const MAX_FONTS = 128;
function clamp(value) {
    return value.length > MAX_COMPONENT_LENGTH ? value.slice(0, MAX_COMPONENT_LENGTH) : value;
}
/** Menghash tiap komponen terpisah agar kemiripan dapat dinilai tanpa menyimpan atribut mentah. */
function hashComponents(components) {
    const normalisedFonts = components.fonts
        .slice(0, MAX_FONTS)
        .map((f) => clamp(f).trim().toLowerCase())
        .sort()
        .join(',');
    // userAgent dinormalisasi: nomor versi dibuang agar pembaruan minor tidak mengubah hash.
    const uaFamily = clamp(components.userAgent)
        .replace(/\d+(\.\d+)+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    const language = clamp(components.language);
    return {
        canvasHash: (0, crypto_ts_1.sha256)(clamp(components.canvasHash)),
        webglHash: (0, crypto_ts_1.sha256)(clamp(components.webglHash)),
        screenResolution: (0, crypto_ts_1.sha256)(clamp(components.screenResolution)),
        timezone: (0, crypto_ts_1.sha256)(clamp(components.timezone)),
        fonts: (0, crypto_ts_1.sha256)(normalisedFonts),
        colorDepth: (0, crypto_ts_1.sha256)(String(components.colorDepth)),
        language: (0, crypto_ts_1.sha256)(language.split('-')[0] ?? language),
        platform: (0, crypto_ts_1.sha256)(components.platform ? clamp(components.platform) : 'unknown'),
        userAgent: (0, crypto_ts_1.sha256)(uaFamily),
    };
}
/**
 * ID perangkat: hash gabungan seluruh komponen.
 * Disimpan sebagai hash, bukan kumpulan atribut mentah (SECURITY.md 17.2).
 */
function fingerprintHash(components) {
    const hashed = hashComponents(components);
    const ordered = Object.keys(COMPONENT_WEIGHTS)
        .map((k) => `${k}=${hashed[k]}`)
        .join('|');
    return (0, crypto_ts_1.sha256)(ordered);
}
/**
 * Skor kemiripan 0..1 antara perangkat tersimpan dan perangkat yang login sekarang.
 * Dipakai untuk mentoleransi perubahan wajar (PRD 6.30: "pembaruan versi browser atau OS").
 */
function similarity(stored, incoming) {
    let score = 0;
    let considered = 0;
    for (const [key, weight] of Object.entries(COMPONENT_WEIGHTS)) {
        const a = stored[key];
        const b = incoming[key];
        if (a === undefined || b === undefined)
            continue;
        considered += weight;
        if (a === b)
            score += weight;
    }
    return considered === 0 ? 0 : score / considered;
}
/** Membandingkan perangkat masuk terhadap satu perangkat terikat. */
function matchDevice(storedHash, storedComponents, incoming, threshold = exports.DEFAULT_SIMILARITY_THRESHOLD) {
    const incomingHash = fingerprintHash(incoming);
    if (incomingHash === storedHash)
        return { matched: true, exact: true, score: 1 };
    const score = similarity(storedComponents, hashComponents(incoming));
    return { matched: score >= threshold, exact: false, score };
}
/** Jarak lingkaran besar (km). */
function haversineKm(a, b) {
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
/**
 * Ambang kecepatan yang wajar. 900 km/jam kira-kira kecepatan jelajah pesawat komersial;
 * di bawah itu perpindahan dianggap mungkin.
 */
exports.MAX_PLAUSIBLE_SPEED_KMH = 900;
/**
 * Toleransi jarak untuk memperhitungkan VPN korporat dan ketidaktepatan geolokasi IP —
 * SECURITY.md 17.2 secara eksplisit menuntut ini agar tidak menghasilkan terlalu banyak
 * positif palsu.
 */
exports.GEO_TOLERANCE_KM = 120;
function assessTravel(previous, current) {
    const distanceKm = haversineKm(previous, current);
    const elapsedMs = Math.max(0, Date.parse(current.at) - Date.parse(previous.at));
    const elapsedHours = elapsedMs / 3_600_000;
    if (distanceKm <= exports.GEO_TOLERANCE_KM) {
        return { impossible: false, distanceKm, elapsedHours, impliedSpeedKmh: 0 };
    }
    if (elapsedHours <= 0) {
        return { impossible: true, distanceKm, elapsedHours, impliedSpeedKmh: Infinity };
    }
    const impliedSpeedKmh = distanceKm / elapsedHours;
    return {
        impossible: impliedSpeedKmh > exports.MAX_PLAUSIBLE_SPEED_KMH,
        distanceKm,
        elapsedHours,
        impliedSpeedKmh,
    };
}
//# sourceMappingURL=deviceFingerprint.js.map