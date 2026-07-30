/**
 * stats-service — Statistik Deskriptif (6.22), Uji Hipotesis (6.23),
 * Regresi & Korelasi (6.24).
 *
 * Dipisah dari `ai-engine-service` secara sengaja (ARCHITECTURE.md Bagian 3):
 * komputasi statistik bersifat DETERMINISTIK dan dapat diaudit (input sama → output
 * sama persis), sedangkan AI engine probabilistik dan bergantung penyedia eksternal.
 * Pemisahan ini memungkinkan hasil statistik di-cache dan diverifikasi independen —
 * penting karena outputnya dipakai untuk laporan resmi dan kajian kebijakan.
 */
export * from './distributions.ts';
export * from './descriptive.ts';
export * from './hypothesis.ts';
export * from './regression.ts';
export * from './service.ts';
