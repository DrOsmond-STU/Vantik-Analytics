/**
 * Persiapan lingkungan uji DOM.
 *
 * jsdom tidak mengimplementasikan `HTMLCanvasElement.getContext()` dan melaporkannya
 * sebagai error tak terimplementasi untuk SETIAP pemanggilan. Pengumpulan atribut
 * perangkat memanggilnya belasan kali per render, sehingga keluaran uji terisi puluhan
 * baris derau yang justru menyembunyikan peringatan sungguhan.
 *
 * Yang dilakukan di sini adalah menyatakan perilaku itu secara eksplisit: `getContext()`
 * mengembalikan `null`, persis seperti peramban yang memblokir kanvas demi privasi
 * (Brave, Firefox dengan `resistFingerprinting`, atau ekstensi anti-pelacak). Itu bukan
 * penyamaran kegagalan — itu keadaan nyata yang wajib ditangani aplikasi, dan
 * `fingerprint.test.ts` memverifikasi penanganannya.
 */
import { beforeAll } from 'vitest';

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as HTMLCanvasElement['getContext'];
});
