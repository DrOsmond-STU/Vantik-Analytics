/**
 * Design tokens — DESIGN.md Bagian 2.1 (Token Peran → Nilai per Mode) & Bagian 14.
 *
 * Sumber tunggal token; dikonsumsi frontend dan template email (ARCHITECTURE.md Bagian 10).
 * Komponen TIDAK PERNAH memanggil nilai hex langsung — selalu lewat token peran
 * (TASK_INSTRUCTION.md Bagian 7 "Konvensi Kode").
 */

export type ThemeMode = 'light' | 'dark';

/** Token peran → nilai per mode. Kolom Light/Dark persis mengikuti DESIGN.md tabel 2.1. */
export const roleTokens = {
  '--canvas': { light: '#F5F7FB', dark: '#0B1220' },
  '--surface': { light: '#FFFFFF', dark: '#131C33' },
  '--surface-raised': { light: '#FFFFFF', dark: '#1B2748' },
  '--border': { light: '#E3E7F0', dark: '#262F4A' },
  '--text-900': { light: '#101828', dark: '#F4F6FB' },
  '--text-600': { light: '#4A5468', dark: '#ABB3C8' },
  '--text-400': { light: '#8D96AA', dark: '#6D7690' },
  // Sidebar & top-level nav tetap gelap di kedua mode — DESIGN.md 7.3
  '--chrome': { light: '#0B1220', dark: '#05070D' },
  '--accent': { light: '#0EA5A5', dark: '#2DD4BF' },
  '--accent-soft': { light: '#E4F7F6', dark: '#0F2E2C' },
  '--good': { light: '#16A34A', dark: '#4ADE80' },
  '--good-soft': { light: '#E7F7EC', dark: '#123322' },
  '--warn': { light: '#F59E0B', dark: '#FBBF24' },
  '--warn-soft': { light: '#FEF3E0', dark: '#3A2C0C' },
  '--bad': { light: '#DC2626', dark: '#F87171' },
  '--bad-soft': { light: '#FCE9E9', dark: '#3A1414' },
  '--info': { light: '#3B5BDB', dark: '#7C93FF' },
} as const satisfies Record<string, Record<ThemeMode, string>>;

export type RoleToken = keyof typeof roleTokens;

/** DESIGN.md Bagian 3 — tipografi. */
export const typography = {
  '--font-display': "'Space Grotesk', system-ui, sans-serif",
  '--font-body': "'Inter', system-ui, sans-serif",
  '--font-mono': "'JetBrains Mono', ui-monospace, monospace",
} as const;

/** DESIGN.md Bagian 4 — spacing, radius & bayangan. */
export const layout = {
  '--radius': '14px',
  '--radius-sm': '9px',
  '--space-unit': '4px',
} as const;

export const shadow: Record<ThemeMode, string> = {
  light: '0 1px 2px rgba(16,24,40,.04), 0 1px 3px rgba(16,24,40,.06)',
  // Dark — bayangan lebih tegas karena kontras latar gelap lebih rendah (DESIGN.md 4)
  dark: '0 2px 6px rgba(0,0,0,.35)',
};

/**
 * DESIGN.md Bagian 2.2 — warna kategori data pada chart TIDAK ikut berbalik terang/gelap;
 * hanya kecerahannya disesuaikan tipis agar tetap kontras terhadap `--canvas` yang berbeda.
 * Ini menjaga konsistensi kognitif: warna "Wilayah Timur" dikenali sama di kedua mode.
 */
export const categoricalSeries = [
  { light: '#0EA5A5', dark: '#22B5B5' },
  { light: '#3B5BDB', dark: '#4E6DE6' },
  { light: '#F59E0B', dark: '#FFAA1E' },
  { light: '#7C3AED', dark: '#8B4CF2' },
  { light: '#16A34A', dark: '#22B058' },
  { light: '#DB2777', dark: '#E63B87' },
  { light: '#0891B2', dark: '#149DBF' },
  { light: '#CA8A04', dark: '#D89710' },
] as const;

export function seriesColor(index: number, mode: ThemeMode): string {
  // Modulo menjamin indeks selalu di dalam rentang; fallback tetap disediakan agar
  // pemakaian di bawah `noUncheckedIndexedAccess` tidak memerlukan assertion.
  const entry = categoricalSeries[Math.abs(index) % categoricalSeries.length] ?? categoricalSeries[0];
  return entry[mode];
}

/** Membangun blok deklarasi CSS custom property untuk satu mode. */
export function cssVariablesFor(mode: ThemeMode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [token, values] of Object.entries(roleTokens)) {
    out[token] = values[mode];
  }
  Object.assign(out, typography, layout);
  out['--shadow'] = shadow[mode];
  categoricalSeries.forEach((c, i) => {
    out[`--series-${i + 1}`] = c[mode];
  });
  return out;
}
