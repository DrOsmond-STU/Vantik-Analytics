/**
 * TOTP (RFC 6238) & kode pemulihan — MFA untuk peran yang mewajibkannya
 * (SECURITY.md Bagian 4, `mfaRequired` di `rbac.ts`).
 *
 * Diimplementasikan di atas `node:crypto` saja, TANPA paket tambahan. Alasannya sama
 * dengan alasan adanya adapter SQLite: aplikasi harus dapat dipasang di shared hosting
 * yang tidak dapat mengompilasi modul native dan yang setiap dependensi tambahannya
 * menambah risiko `npm install` gagal. TOTP cukup kecil untuk ditulis dan diuji penuh
 * terhadap vektor uji resmi RFC 6238 — itu justru lebih baik daripada mempercayai
 * paket yang tidak diverifikasi.
 *
 * Yang SENGAJA tidak dilakukan di sini: menyimpan apa pun. Modul ini murni fungsi;
 * pemilik keadaan (rahasia, penghitung terakhir, kode pemulihan) adalah identity-service.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** Lebar langkah waktu TOTP, detik. 30 adalah nilai yang dipakai semua aplikasi autentikator. */
export const TOTP_STEP_SECONDS = 30;

/** Jumlah digit kode. */
export const TOTP_DIGITS = 6;

/**
 * Toleransi pergeseran jam, dinyatakan dalam jumlah langkah ke belakang & ke depan.
 *
 * 1 langkah (±30 detik) adalah kompromi yang disarankan RFC 6238 Bagian 6: cukup untuk
 * jam ponsel yang sedikit meleset, tanpa memperlebar jendela tebakan lebih dari perlu.
 * Memperbesarnya berarti memperbanyak kode yang sah pada satu saat.
 */
export const TOTP_WINDOW_STEPS = 1;

/** Panjang rahasia dalam byte. 20 byte = 160 bit, sesuai anjuran RFC 4226 Bagian 4. */
const SECRET_BYTES = 20;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 (RFC 4648) tanpa padding — format yang dibaca aplikasi autentikator. */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/**
 * Kebalikan `base32Encode`. Spasi dan huruf kecil ditoleransi karena pengguna sering
 * menyalin rahasia dengan spasi pemisah; karakter di luar alfabet ditolak, bukan
 * diabaikan diam-diam — rahasia yang salah baca akan menghasilkan kode yang selalu
 * gagal dan sangat membingungkan untuk didiagnosis.
 */
export function base32Decode(input: string): Buffer {
  const normalised = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (normalised === '') throw new Error('Rahasia base32 kosong');

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of normalised) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Karakter base32 tidak sah: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Rahasia MFA baru, dikembalikan dalam base32 siap ditampilkan/di-QR-kan. */
export function generateMfaSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/** Nomor langkah waktu untuk sebuah waktu. Diekspor agar dapat dipakai anti-replay. */
export function totpCounter(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
}

/**
 * HOTP (RFC 4226) — dasar TOTP.
 *
 * SHA-1 dipakai di sini BUKAN sebagai fungsi hash keamanan umum, melainkan karena
 * RFC 6238 menetapkannya sebagai algoritma default dan itulah satu-satunya yang
 * dipahami semua aplikasi autentikator. Kekuatannya di sini berasal dari rahasia
 * 160-bit dan masa hidup kode 30 detik, bukan dari ketahanan tabrakan SHA-1.
 */
function hotp(secret: Buffer, counter: number): string {
  const buffer = Buffer.alloc(8);
  // Counter 64-bit big-endian. `writeBigUInt64BE` menghindari kehilangan presisi
  // yang terjadi bila digeser dengan operator bitwise 32-bit.
  buffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', secret).update(buffer).digest();
  // Truncation dinamis (RFC 4226 Bagian 5.3).
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/** Kode TOTP untuk sebuah langkah waktu. */
export function totpCode(secretBase32: string, counter: number = totpCounter()): string {
  return hotp(base32Decode(secretBase32), counter);
}

export interface TotpVerification {
  valid: boolean;
  /**
   * Langkah waktu yang cocok. Pemanggil WAJIB menyimpannya dan menolak langkah yang
   * sama atau lebih lama pada verifikasi berikutnya — tanpa itu, satu kode yang
   * tertangkap masih dapat dipakai ulang selama jendelanya belum lewat.
   */
  counter: number | null;
}

/**
 * Memverifikasi kode terhadap rahasia, dengan toleransi pergeseran jam.
 *
 * `minCounter` menegakkan anti-replay: kode dari langkah yang sudah pernah dipakai
 * ditolak meskipun secara matematis masih sah.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  options: { atMs?: number; minCounter?: number; windowSteps?: number } = {},
): TotpVerification {
  const candidate = code.replace(/\s/g, '');
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(candidate)) return { valid: false, counter: null };

  const secret = base32Decode(secretBase32);
  const centre = totpCounter(options.atMs ?? Date.now());
  const window = options.windowSteps ?? TOTP_WINDOW_STEPS;

  for (let offset = -window; offset <= window; offset++) {
    const counter = centre + offset;
    if (counter < 0) continue;
    if (options.minCounter !== undefined && counter <= options.minCounter) continue;

    // Perbandingan waktu-konstan: perbandingan string biasa keluar lebih awal pada
    // digit pertama yang berbeda, yang secara teori membocorkan informasi.
    const expected = Buffer.from(hotp(secret, counter), 'utf8');
    const provided = Buffer.from(candidate, 'utf8');
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) {
      return { valid: true, counter };
    }
  }
  return { valid: false, counter: null };
}

/**
 * URI `otpauth://` untuk QR code.
 *
 * Nama penerbit disertakan dua kali (prefiks label dan parameter `issuer`) karena
 * aplikasi autentikator lama hanya membaca salah satunya.
 */
export function otpauthUri(input: { secret: string; accountLabel: string; issuer: string }): string {
  const label = encodeURIComponent(`${input.issuer}:${input.accountLabel}`);
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* ------------------------------------------------------------------ */
/* Kode pemulihan                                                     */
/* ------------------------------------------------------------------ */

/** Jumlah kode pemulihan yang diterbitkan sekali jalan. */
export const RECOVERY_CODE_COUNT = 10;

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // tanpa I, O, 0, 1
const RECOVERY_GROUP = 5;
const RECOVERY_GROUPS = 2;

/**
 * Kode pemulihan sekali pakai.
 *
 * Wajib ada, bukan pelengkap: TOTP tanpa jalur pemulihan berarti ponsel hilang =
 * akun hilang permanen, dan pada peran Super Admin itu bisa berarti tenant tanpa
 * administrator. Alfabetnya membuang karakter yang mudah tertukar saat dibaca manusia
 * dari kertas (I/1, O/0).
 */
export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const groups: string[] = [];
    for (let g = 0; g < RECOVERY_GROUPS; g++) {
      let group = '';
      for (let c = 0; c < RECOVERY_GROUP; c++) {
        group += RECOVERY_ALPHABET[randomInt(0, RECOVERY_ALPHABET.length)];
      }
      groups.push(group);
    }
    codes.push(groups.join('-'));
  }
  return codes;
}

/** Bentuk baku kode pemulihan untuk perbandingan: tanpa pemisah, huruf besar. */
export function normaliseRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}
