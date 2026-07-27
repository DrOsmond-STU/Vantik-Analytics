/**
 * Titik masuk layanan. Menyajikan API dan (bila tersedia) hasil build frontend
 * sehingga satu proses cukup untuk deployment on-premise sederhana — mendukung
 * kebutuhan portabilitas PRD Bagian 7 (on-premise, cloud, hybrid).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { createApp, notFoundHandler } from './app.ts';

const port = Number(process.env.PORT ?? 4000);
const { app, db } = createApp();

// Menyajikan frontend hasil build bila ada.
const webDist = join(process.cwd(), '..', 'frontend', 'web-app', 'dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api\/|embed\/|webhooks\/|health).*/, (_req, res) => {
    res.sendFile(join(webDist, 'index.html'));
  });
} else {
  app.use(notFoundHandler());
}

const server = app.listen(port, () => {
  console.log(`[vantik] API listening on :${port}`);
  if (!existsSync(webDist)) {
    console.log('[vantik] frontend build not found — API only. Run `npm run build` to serve the web app.');
  }
});

function shutdown(signal: string): void {
  console.log(`[vantik] ${signal} received, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
