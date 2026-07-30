import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Setiap berkas test memakai basis data sementara sendiri; jalankan berurutan
    // di dalam satu berkas namun paralel antar-berkas.
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/seed.ts', 'src/server.ts'],
      // TESTING.md Lampiran 15 — target cakupan per domain.
      // Gate global konservatif; target per-domain ditegakkan lewat review.
      thresholds: { lines: 70, functions: 70, branches: 65, statements: 70 },
    },
  },
});
