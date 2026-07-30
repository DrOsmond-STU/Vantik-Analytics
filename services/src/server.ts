/**
 * Titik masuk layanan.
 *
 * Menyajikan API dan hasil build frontend dari satu proses, sehingga cukup satu
 * aplikasi Node untuk dipasang — mendukung kebutuhan portabilitas PRD Bagian 7
 * (on-premise, cloud, hybrid) dan menjadi syarat praktis agar dapat berjalan di
 * shared hosting yang hanya mengizinkan satu aplikasi Node per domain.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import express from 'express';
import { createApp, notFoundHandler } from './app.ts';
import { resolveDataDir } from './platform/db.ts';

/**
 * Kandidat lokasi berkas statis frontend, diperiksa berurutan.
 *
 * Tata letak deployment (`public/` di sebelah berkas startup) diperiksa LEBIH DULU
 * daripada tata letak repositori kerja, karena itulah bentuk yang dipakai di server.
 */
function resolveWebRoot(): string | null {
  // Sengaja hanya berbasis `process.cwd()`: `__dirname` tidak ada saat berkas ini
  // dijalankan sebagai ESM di pengembangan, dan Passenger selalu menetapkan cwd ke
  // direktori aplikasi.
  const candidates = [
    process.env.VANTIK_WEB_ROOT,
    join(process.cwd(), 'public'),
    join(process.cwd(), '..', 'frontend', 'web-app', 'dist'),
    join(process.cwd(), 'frontend', 'web-app', 'dist'),
  ].filter((c): c is string => Boolean(c));

  for (const candidate of candidates) {
    const path = resolve(candidate);
    if (existsSync(join(path, 'index.html'))) return path;
  }
  return null;
}

/** Lintasan yang ditangani API/embed/webhook — tidak boleh diambil alih frontend. */
const API_PREFIX = /^\/(?:api|embed|webhooks|health|healthz)(?:\/|$)/;

/**
 * Apakah lintasan ini permintaan BERKAS, bukan rute aplikasi?
 *
 * Rute SPA tidak pernah memuat ekstensi (`/dasbor`, `/analitik/uji`), sedangkan
 * permintaan berkas selalu memuatnya (`/package.json`, `/load-env.js`, `/vantik.db`).
 */
const LOOKS_LIKE_FILE = /\.[^/]*$/;

/**
 * Memasang penyajian frontend di atas aplikasi API.
 *
 * Diekspor terpisah dari `startServer()` supaya perilakunya dapat diuji tanpa
 * mengikat porta — termasuk uji negatif bahwa berkas internal aplikasi
 * (`package.json`, `load-env.js`, berkas basis data) TIDAK tersaji.
 */
export function mountWebApp(app: express.Express, webRoot: string): void {
  app.use(
    express.static(webRoot, {
      // Aset ber-hash aman di-cache lama; index.html tidak boleh, agar rilis baru
      // langsung terlihat tanpa pengguna harus memaksa muat ulang.
      setHeaders: (res, path) => {
        if (path.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
        else if (/\.[0-9a-f]{8,}\./i.test(path)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }),
  );

  // Riwayat sisi klien: rute aplikasi dilayani index.html.
  //
  // Kriterianya BENTUK lintasan, bukan daftar-tolak nama berkas. Daftar-tolak sempat
  // dipakai di sini dan selalu ketinggalan satu nama berkas; pembalikannya — hanya
  // melayani yang berbentuk rute — tertutup secara desain. Permintaan berkas yang
  // tidak ada di `public/` sudah melewati express.static, jadi satu-satunya jawaban
  // benar adalah 404.
  //
  // Menyajikan index.html untuk lintasan berkas tidak membocorkan isinya, tetapi
  // membuat daftar periksa pasca-pasang mustahil dibaca: penguji tidak dapat
  // membedakan "terlindungi" dari "berkas benar-benar tersaji".
  app.get(/.*/, (req, res, next) => {
    if (API_PREFIX.test(req.path) || LOOKS_LIKE_FILE.test(req.path)) {
      next();
      return;
    }
    res.sendFile(join(webRoot, 'index.html'));
  });

  app.use(notFoundHandler());
}

export function startServer(): ReturnType<express.Express['listen']> {
  // Passenger (cPanel) menetapkan PORT sendiri; jangan pernah dipatok di kode.
  const port = Number(process.env.PORT ?? 4000);
  const { app, db, scheduler } = createApp();

  // Penjadwal dimulai DI SINI, bukan di `createApp()`.
  //
  // `createApp()` dipakai ratusan kali oleh pengujian; memulai ticker di sana akan
  // membuat setiap uji menjalankan pekerjaan latar dan saling mengganggu. Proses server
  // sungguhan hanya satu, dan hanya di situ ticker punya arti.
  scheduler.start();

  const webRoot = resolveWebRoot();
  if (webRoot) mountWebApp(app, webRoot);
  else app.use(notFoundHandler());

  const server = app.listen(port, () => {
    console.log(`[vantik] siap · port ${port} · driver ${db.driver} · data ${resolveDataDir()}`);
    if (!process.env.VANTIK_SCHEDULER_TOKEN) {
      // Dinyatakan terbuka: tanpa cron eksternal, penjadwalan hanya berjalan selama
      // proses hidup — dan Passenger mematikan proses yang idle.
      console.log('[vantik] VANTIK_SCHEDULER_TOKEN belum diset — penjadwalan hanya lewat ticker dalam proses');
    }
    if (!webRoot) {
      console.log('[vantik] build frontend tidak ditemukan — hanya API. Jalankan `npm run build`.');
    }
    if (process.env.NODE_ENV === 'production' && !process.env.VANTIK_MASTER_KEY) {
      // Tidak akan sampai di sini: KeyRing.fromEnv() sudah menolak lebih dulu.
      console.error('[vantik] VANTIK_MASTER_KEY belum diset (SECURITY.md Bagian 6)');
    }
  });

  const shutdown = (signal: string): void => {
    console.log(`[vantik] ${signal} diterima, menutup`);
    scheduler.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

/**
 * Apakah berkas ini titik masuk proses?
 *
 * `require.main === module` tidak dipakai karena hanya sah pada CommonJS, sedangkan
 * berkas yang sama juga dijalankan sebagai ESM saat pengembangan. Titik masuk
 * deployment (`app.js`) memanggil `startServer()` secara eksplisit, sehingga tidak
 * ada kemungkinan server dijalankan dua kali.
 */
function isEntrypoint(): boolean {
  const entry = process.argv[1] ?? '';
  return /(?:^|[\\/])server\.(?:ts|js|cjs|mjs)$/.test(entry);
}

if (isEntrypoint()) startServer();
