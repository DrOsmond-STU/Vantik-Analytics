/**
 * Format angka, tanggal & mata uang — DESIGN.md Bagian 8.3.
 *
 * Memakai `Intl.NumberFormat` / `Intl.DateTimeFormat` bawaan browser, BUKAN fungsi
 * format manual per komponen, untuk konsistensi dan pengurangan bug lokalisasi
 * (DESIGN.md Bagian 13).
 */
import type { Locale } from '../i18n/dictionary.ts';

const intlLocale = (locale: Locale): string => (locale === 'en' ? 'en-US' : 'id-ID');

export function formatNumber(value: number | null | undefined, locale: Locale, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(intlLocale(locale), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatDecimal(value: number | null | undefined, locale: Locale, digits = 2): string {
  return formatNumber(value, locale, digits);
}

export function formatPercent(value: number | null | undefined, locale: Locale, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(intlLocale(locale), {
    style: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value / 100);
}

/**
 * Mata uang mengikuti DATA, bukan bahasa antarmuka (DESIGN.md 8.3):
 * pengguna EN yang melihat data rupiah tetap melihat Rp/IDR, bukan dikonversi.
 */
export function formatCurrency(
  value: number | null | undefined,
  locale: Locale,
  currency = 'IDR',
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(intlLocale(locale), {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

/** Tanggal pendek: `24 Jul 2026` (id) / `Jul 24, 2026` (en). */
export function formatDate(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(intlLocale(locale), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

export function formatDateTime(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(intlLocale(locale), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/**
 * Format khusus Log Aktivitas.
 *
 * DESIGN.md 8.3: Log Aktivitas SELALU memakai format tidak ambigu (ISO 8601 dengan
 * offset zona waktu) karena fungsinya untuk audit lintas Auditor yang mungkin berbeda
 * locale — bukan mengikuti pilihan bahasa antarmuka.
 */
export function formatAuditTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  const pad = (n: number): string => String(n).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '−';
  const absolute = Math.abs(offsetMinutes);
  const offset = `UTC${sign}${pad(Math.floor(absolute / 60))}${absolute % 60 ? `:${pad(absolute % 60)}` : ''}`;

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} (${offset})`
  );
}

export function formatBytes(bytes: number | null | undefined, locale: Locale): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${formatNumber(value, locale, unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Periode `YYYY-MM` menjadi label bulan yang terbaca. */
export function formatPeriod(period: string, locale: Locale): string {
  const [year, month] = period.split('-');
  if (!year || !month) return period;
  const date = new Date(Number(year), Number(month) - 1, 1);
  return new Intl.DateTimeFormat(intlLocale(locale), { month: 'short', year: 'numeric' }).format(date);
}

/** Periode berjalan dalam format `YYYY-MM`. */
export function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}
