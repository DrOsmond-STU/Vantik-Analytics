/**
 * Konfigurasi uji komponen/DOM untuk web app.
 *
 * Terpisah dari konfigurasi `services/` karena kebutuhannya berbeda secara mendasar:
 * uji di sini butuh DOM (jsdom) dan transformasi JSX, sedangkan tsconfig `services/`
 * sengaja TIDAK memuat `lib: DOM` — server tidak boleh dapat menyentuh `document`
 * tanpa disadari.
 *
 * Uji kamus i18n dan token desain tetap berada di `services/tests/` karena keduanya
 * murni pemeriksaan data, tanpa render.
 */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.test.tsx'],
    setupFiles: ['tests/setup.ts'],
    restoreMocks: true,
  },
});
