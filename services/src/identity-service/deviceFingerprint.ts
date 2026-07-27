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
import { sha256 } from '../platform/crypto.ts';

/** Atribut mentah yang dikirim klien. Diperlakukan sebagai MASUKAN TIDAK TEPERCAYA. */
export interface FingerprintComponents {
  userAgent: string;
  screenResolution: string;
  colorDepth: number;
  timezone: string;
  language: string;
  fonts: string[];
  canvasHash: string;
  webglHash: string;
  platform?: string;
}

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
} as const;

type ComponentKey = keyof typeof COMPONENT_WEIGHTS;

/** Ambang kemiripan default; dapat dikonfigurasi per tenant (SECURITY.md 17.2). */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.82;

export interface HashedComponents {
  [key: string]: string;
}

/** Menghash tiap komponen terpisah agar kemiripan dapat dinilai tanpa menyimpan atribut mentah. */
export function hashComponents(components: FingerprintComponents): HashedComponents {
  const normalisedFonts = [...components.fonts].map((f) => f.trim().toLowerCase()).sort().join(',');
  // userAgent dinormalisasi: nomor versi dibuang agar pembaruan minor tidak mengubah hash.
  const uaFamily = components.userAgent
    .replace(/\d+(\.\d+)+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  return {
    canvasHash: sha256(components.canvasHash),
    webglHash: sha256(components.webglHash),
    screenResolution: sha256(components.screenResolution),
    timezone: sha256(components.timezone),
    fonts: sha256(normalisedFonts),
    colorDepth: sha256(String(components.colorDepth)),
    language: sha256(components.language.split('-')[0] ?? components.language),
    platform: sha256(components.platform ?? 'unknown'),
    userAgent: sha256(uaFamily),
  };
}

/**
 * ID perangkat: hash gabungan seluruh komponen.
 * Disimpan sebagai hash, bukan kumpulan atribut mentah (SECURITY.md 17.2).
 */
export function fingerprintHash(components: FingerprintComponents): string {
  const hashed = hashComponents(components);
  const ordered = (Object.keys(COMPONENT_WEIGHTS) as ComponentKey[])
    .map((k) => `${k}=${hashed[k]}`)
    .join('|');
  return sha256(ordered);
}

/**
 * Skor kemiripan 0..1 antara perangkat tersimpan dan perangkat yang login sekarang.
 * Dipakai untuk mentoleransi perubahan wajar (PRD 6.30: "pembaruan versi browser atau OS").
 */
export function similarity(stored: HashedComponents, incoming: HashedComponents): number {
  let score = 0;
  let considered = 0;
  for (const [key, weight] of Object.entries(COMPONENT_WEIGHTS) as Array<[ComponentKey, number]>) {
    const a = stored[key];
    const b = incoming[key];
    if (a === undefined || b === undefined) continue;
    considered += weight;
    if (a === b) score += weight;
  }
  return considered === 0 ? 0 : score / considered;
}

export interface DeviceMatch {
  matched: boolean;
  exact: boolean;
  score: number;
}

/** Membandingkan perangkat masuk terhadap satu perangkat terikat. */
export function matchDevice(
  storedHash: string,
  storedComponents: HashedComponents,
  incoming: FingerprintComponents,
  threshold = DEFAULT_SIMILARITY_THRESHOLD,
): DeviceMatch {
  const incomingHash = fingerprintHash(incoming);
  if (incomingHash === storedHash) return { matched: true, exact: true, score: 1 };
  const score = similarity(storedComponents, hashComponents(incoming));
  return { matched: score >= threshold, exact: false, score };
}

/* ------------------------------------------------------------------ */
/* Deteksi impossible travel — PRD 6.30, SECURITY.md 17.2              */
/* ------------------------------------------------------------------ */

export interface GeoPoint {
  lat: number;
  lon: number;
  at: string;
}

/** Jarak lingkaran besar (km). */
export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Ambang kecepatan yang wajar. 900 km/jam kira-kira kecepatan jelajah pesawat komersial;
 * di bawah itu perpindahan dianggap mungkin.
 */
export const MAX_PLAUSIBLE_SPEED_KMH = 900;

/**
 * Toleransi jarak untuk memperhitungkan VPN korporat dan ketidaktepatan geolokasi IP —
 * SECURITY.md 17.2 secara eksplisit menuntut ini agar tidak menghasilkan terlalu banyak
 * positif palsu.
 */
export const GEO_TOLERANCE_KM = 120;

export interface TravelVerdict {
  impossible: boolean;
  distanceKm: number;
  elapsedHours: number;
  impliedSpeedKmh: number;
}

export function assessTravel(previous: GeoPoint, current: GeoPoint): TravelVerdict {
  const distanceKm = haversineKm(previous, current);
  const elapsedMs = Math.max(0, Date.parse(current.at) - Date.parse(previous.at));
  const elapsedHours = elapsedMs / 3_600_000;

  if (distanceKm <= GEO_TOLERANCE_KM) {
    return { impossible: false, distanceKm, elapsedHours, impliedSpeedKmh: 0 };
  }
  if (elapsedHours <= 0) {
    return { impossible: true, distanceKm, elapsedHours, impliedSpeedKmh: Infinity };
  }
  const impliedSpeedKmh = distanceKm / elapsedHours;
  return {
    impossible: impliedSpeedKmh > MAX_PLAUSIBLE_SPEED_KMH,
    distanceKm,
    elapsedHours,
    impliedSpeedKmh,
  };
}
