#!/usr/bin/env node
/**
 * Menyusun folder `deploy/` yang siap diunggah ke shared hosting.
 *
 * Alasan pemaketan dilakukan di sini, bukan di server: shared hosting umumnya tidak
 * dapat menjalankan `tsc`/`vite` (batas memori & tidak ada devDependencies), sehingga
 * kompilasi harus selesai sebelum unggah. Yang dikirim hanya JavaScript biasa,
 * aset statis, dan dependensi runtime.
 *
 * Tata letak hasil:
 *   deploy/
 *   ├── app.js          ← berkas startup untuk Passenger (cPanel "Setup Node.js App")
 *   ├── package.json    ← dependensi RUNTIME saja
 *   ├── .htaccess       ← menolak akses langsung ke berkas aplikasi & basis data
 *   ├── server/         ← hasil kompilasi services/dist
 *   ├── public/         ← hasil build frontend
 *   └── .env.example
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deploy = join(root, 'deploy');

const serverDist = join(root, 'services', 'dist');
const webDist = join(root, 'frontend', 'web-app', 'dist');

for (const [label, path] of [
  ['hasil kompilasi server', serverDist],
  ['hasil build frontend', webDist],
]) {
  if (!existsSync(path)) {
    console.error(`[deploy] ${label} tidak ditemukan di ${path}`);
    console.error('[deploy] jalankan `npm run build` terlebih dahulu');
    process.exit(1);
  }
}

rmSync(deploy, { recursive: true, force: true });
mkdirSync(deploy, { recursive: true });

cpSync(serverDist, join(deploy, 'server'), { recursive: true });
cpSync(webDist, join(deploy, 'public'), { recursive: true });

// Versi dependensi diambil dari package.json layanan agar tidak pernah menyimpang.
const servicePkg = JSON.parse(readFileSync(join(root, 'services', 'package.json'), 'utf8'));
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const deployPkg = {
  name: 'vantik-analytics',
  version: rootPkg.version,
  private: true,
  description: 'Vantik Analytics — paket siap pasang (shared hosting / VPS)',
  // TANPA "type": "module" — Passenger memuat berkas startup lewat require(),
  // dan seluruh keluaran kompilasi berformat CommonJS.
  main: 'app.js',
  scripts: {
    start: 'node app.js',
    // `-r ./load-env.js` wajib: tanpa memuat .env, seed menulis ke direktori data
    // DEFAULT sementara server membaca VANTIK_DATA_DIR — dua basis data berbeda.
    seed: 'node -r ./load-env.js server/platform/seed.js',
  },
  dependencies: {
    express: servicePkg.dependencies.express,
    'cookie-parser': servicePkg.dependencies['cookie-parser'],
  },
  // better-sqlite3 bersifat OPSIONAL dengan sengaja: ia modul native, dan pada banyak
  // shared hosting kompilasinya gagal. Bila gagal, `npm install` TETAP berhasil dan
  // aplikasi otomatis memakai `node:sqlite` bawaan Node (lihat services/src/platform/sqlite.ts).
  optionalDependencies: {
    'better-sqlite3': servicePkg.dependencies['better-sqlite3'],
  },
  engines: { node: '>=20' },
};
writeFileSync(join(deploy, 'package.json'), `${JSON.stringify(deployPkg, null, 2)}\n`);

// Berkas startup Passenger.
writeFileSync(
  join(deploy, 'app.js'),
  `/**
 * Berkas startup aplikasi.
 *
 * Dipakai oleh Phusion Passenger (cPanel/CloudLinux "Setup Node.js App") maupun oleh
 * \`node app.js\` biasa pada VPS. Passenger menetapkan PORT dan cwd sendiri, jadi
 * keduanya tidak pernah dipatok di kode.
 */
'use strict';

// Memuat variabel dari .env bila ada, tanpa dependensi tambahan.
require('./load-env.js');

const { startServer } = require('./server/server.js');

startServer();
`,
);

// Pemuat .env minimalis — menghindari dependensi tambahan di server.
writeFileSync(
  join(deploy, 'load-env.js'),
  `/**
 * Pemuat .env tanpa dependensi.
 *
 * Shared hosting sering tidak menyediakan cara mudah menyetel variabel lingkungan
 * per-proses selain lewat panel; berkas .env di direktori aplikasi lebih praktis.
 * Variabel yang SUDAH ada di lingkungan tidak pernah ditimpa — nilai dari panel
 * hosting harus menang atas berkas.
 */
'use strict';

const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const file = join(process.cwd(), '.env');
if (existsSync(file)) {
  for (const rawLine of readFileSync(file, 'utf8').split(/\\r?\\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
`,
);

cpSync(join(root, 'infra', 'shared-hosting', '.htaccess'), join(deploy, '.htaccess'));
cpSync(join(root, 'infra', 'shared-hosting', 'env.production.example'), join(deploy, '.env.example'));
cpSync(join(root, 'docs', 'DEPLOY-SHARED-HOSTING.md'), join(deploy, 'BACA-SAYA-DEPLOY.md'));

// Marker agar Node memperlakukan folder server/ sebagai CommonJS walau ada
// package.json induk yang menyatakan "type": "module".
writeFileSync(join(deploy, 'server', 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);

console.log('[deploy] paket siap di ./deploy');
console.log('[deploy] isi:');
console.log('  app.js  load-env.js  package.json  .htaccess  .env.example  server/  public/');
console.log('[deploy] langkah berikutnya: lihat deploy/BACA-SAYA-DEPLOY.md');
