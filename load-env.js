/**
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
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
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
