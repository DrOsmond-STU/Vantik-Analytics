/**
 * Pengumpulan atribut perangkat — PRD 6.30, SECURITY.md 17.2 & 17.3.
 *
 * Uji ini ada karena kegagalan di sini tidak terlihat seperti kegagalan: bila
 * `collectFingerprint()` melempar, `submit()` di layar masuk masuk ke blok catch dan
 * pengguna menerima "terjadi kesalahan pada sistem" — tanpa petunjuk bahwa penyebabnya
 * peramban yang memblokir kanvas demi privasi. Justru pengguna yang paling peduli privasi
 * yang akan terkunci, dan pesannya tidak akan pernah menyebut sebabnya.
 */
import { describe, expect, it } from 'vitest';
import { collectFingerprint } from '../src/lib/fingerprint.ts';

describe('Atribut perangkat dikumpulkan tanpa dapat menggagalkan login', () => {
  it('TC-WEB-13 — kanvas terblokir tidak melempar, hanya menandai "unavailable"', () => {
    // setup.ts membuat getContext() mengembalikan null, seperti peramban ber-privasi ketat.
    const fp = collectFingerprint();

    expect(fp.canvasHash).toBe('unavailable');
    expect(fp.webglHash).toBe('unavailable');
    // Daftar font dideteksi lewat pengukuran kanvas; tanpa kanvas hasilnya kosong,
    // bukan undefined yang akan gagal divalidasi server.
    expect(fp.fonts).toEqual([]);
  });

  it('TC-WEB-14 — seluruh medan wajib tetap terisi dan bertipe benar', () => {
    const fp = collectFingerprint();

    // Server memvalidasi bentuknya; medan yang hilang membuat login gagal dengan
    // kesalahan validasi yang tidak dapat dipahami pengguna.
    expect(typeof fp.userAgent).toBe('string');
    expect(fp.screenResolution).toMatch(/^\d+x\d+$/);
    expect(typeof fp.colorDepth).toBe('number');
    expect(typeof fp.timezone).toBe('string');
    expect(typeof fp.language).toBe('string');
    expect(typeof fp.platform).toBe('string');
    expect(Array.isArray(fp.fonts)).toBe(true);
  });

  it('TC-WEB-15 — tidak ada "ID perangkat" jadi yang dikirim klien', () => {
    const fp = collectFingerprint();

    // SECURITY.md 17.2: klien mengirim ATRIBUT; hashing, pencocokan, dan keputusan
    // seluruhnya di server. Klien yang mengirim id jadi dapat memalsukannya.
    const keys = Object.keys(fp).sort();
    expect(keys).toEqual([
      'canvasHash',
      'colorDepth',
      'fonts',
      'language',
      'platform',
      'screenResolution',
      'timezone',
      'userAgent',
      'webglHash',
    ]);
    expect(keys).not.toContain('deviceId');
    expect(keys).not.toContain('fingerprintHash');
  });
});
