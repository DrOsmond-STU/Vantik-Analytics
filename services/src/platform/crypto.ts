/**
 * Primitif kriptografi platform.
 *
 * SECURITY.md Bagian 6 — enkripsi & perlindungan data:
 *  - Kredensial Koneksi Eksternal disimpan di secrets vault terenkripsi TERPISAH dari
 *    basis data aplikasi, tidak pernah ditampilkan sebagai teks biasa setelah disimpan.
 *  - Kunci enkripsi dikelola terpusat dengan rotasi berkala (KMS di production).
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * Amplop terenkripsi. `keyVersion` disimpan bersama ciphertext agar rotasi kunci
 * (SECURITY.md 6) dapat dilakukan tanpa mendekripsi ulang seluruh data sekaligus.
 */
export interface SealedSecret {
  keyVersion: number;
  iv: string;
  tag: string;
  ciphertext: string;
}

/**
 * Sumber kunci. Di production ini dipenuhi KMS; di sini dibaca dari environment.
 * Sengaja TIDAK ada nilai default yang bisa dipakai production — kunci lemah yang
 * ter-hardcode adalah kebocoran yang menunggu terjadi.
 */
export class KeyRing {
  private readonly keys = new Map<number, Buffer>();

  constructor(keys: Array<{ version: number; material: Buffer }>) {
    if (keys.length === 0) throw new Error('KeyRing requires at least one key');
    for (const k of keys) {
      if (k.material.length !== KEY_BYTES) {
        throw new Error(`Key v${k.version} must be ${KEY_BYTES} bytes (AES-256)`);
      }
      this.keys.set(k.version, k.material);
    }
    this.currentVersion = Math.max(...keys.map((k) => k.version));
  }

  readonly currentVersion: number;

  get(version: number): Buffer {
    const key = this.keys.get(version);
    if (!key) throw new Error(`Encryption key version ${version} is not available`);
    return key;
  }

  /**
   * Membangun KeyRing dari environment.
   * `VANTIK_MASTER_KEY` = 32 byte hex/base64. Untuk development/test, kunci acak
   * dibangkitkan per proses — data terenkripsi tidak akan bertahan antar-restart,
   * yang justru benar untuk lingkungan non-produksi.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): KeyRing {
    const raw = env.VANTIK_MASTER_KEY;
    if (raw) {
      const material = raw.length === 64 ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
      return new KeyRing([{ version: 1, material }]);
    }
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'VANTIK_MASTER_KEY wajib diset di production (SECURITY.md Bagian 6 — manajemen kunci)',
      );
    }
    return new KeyRing([{ version: 1, material: randomBytes(KEY_BYTES) }]);
  }
}

export function seal(keyring: KeyRing, plaintext: string): SealedSecret {
  const version = keyring.currentVersion;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyring.get(version), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    keyVersion: version,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function open(keyring: KeyRing, sealed: SealedSecret): string {
  const decipher = createDecipheriv(
    ALGORITHM,
    keyring.get(sealed.keyVersion),
    Buffer.from(sealed.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/* ------------------------------------------------------------------ */
/* Kata sandi akun lokal — SECURITY.md Bagian 4                        */
/* ------------------------------------------------------------------ */

/** Minimum 12 karakter, kombinasi huruf/angka/simbol (SECURITY.md Bagian 4). */
export function validatePasswordPolicy(password: string): { ok: boolean; reasonKey?: string } {
  if (password.length < 12) return { ok: false, reasonKey: 'error.password_too_short' };
  if (!/[A-Za-z]/.test(password)) return { ok: false, reasonKey: 'error.password_needs_letter' };
  if (!/[0-9]/.test(password)) return { ok: false, reasonKey: 'error.password_needs_digit' };
  if (!/[^A-Za-z0-9]/.test(password)) return { ok: false, reasonKey: 'error.password_needs_symbol' };
  return { ok: true };
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64!, 'base64');
  const expected = Buffer.from(hashB64!, 'base64');
  const derived = scryptSync(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/* ------------------------------------------------------------------ */
/* Token & hash                                                        */
/* ------------------------------------------------------------------ */

/** Token acak untuk sesi & embed token. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Hash token untuk penyimpanan. Token sesi/embed disimpan sebagai hash agar
 * kebocoran basis data tidak langsung menghasilkan token yang dapat dipakai.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Perbandingan waktu-tetap untuk nilai heksadesimal berpanjang sama. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
