/**
 * Pengujian multi-tema & multi-bahasa — TESTING.md Bagian 9.
 *
 * Regresi wajib setiap rilis:
 *  - 100% kunci string memiliki padanan di KEDUA bahasa; tidak ada yang jatuh ke
 *    placeholder atau kode mentah.
 *  - Nama modul TIDAK ikut diterjemahkan saat bahasa antarmuka diganti.
 *  - Seluruh token warna DESIGN.md 2.1 terdefinisi di kedua mode.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Akar repositori dihitung dari lokasi BERKAS INI, bukan dari `process.cwd()`.
 *
 * Dengan cwd, hasil uji bergantung pada direktori tempat vitest dipanggil: lulus lewat
 * `npm test` (cwd = services/) tetapi gagal lewat `npx vitest run` dari akar repositori.
 * Uji tidak boleh sensitif terhadap hal itu.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
import { DICTIONARY_KEYS, dictionary, translate } from '../../frontend/web-app/src/i18n/dictionary.ts';
import { ALL_NAV_ITEMS, NAV_GROUPS } from '../../frontend/web-app/src/app/navigation.ts';
import { roleTokens, cssVariablesFor } from '../../shared/design-tokens/src/index.ts';
import { MODULE_KEYS } from '../src/platform/featureFlags.ts';

describe('Kamus istilah — DESIGN.md 8.2 & TESTING.md Bagian 9', () => {
  it('TC-I18N-01 — 100% kunci memiliki padanan Bahasa Indonesia DAN English', () => {
    const incomplete: string[] = [];
    for (const key of DICTIONARY_KEYS) {
      const [id, en] = dictionary[key];
      if (!id || id.trim() === '') incomplete.push(`${key} (id)`);
      if (!en || en.trim() === '') incomplete.push(`${key} (en)`);
    }
    expect(incomplete).toEqual([]);
    expect(DICTIONARY_KEYS.length).toBeGreaterThan(200);
  });

  it('TC-I18N-02 — kunci memakai format namespace.key', () => {
    const malformed = DICTIONARY_KEYS.filter((key) => !/^[a-z_]+(\.[a-z0-9_]+)+$/.test(key));
    expect(malformed).toEqual([]);
  });

  it('TC-I18N-03 — kunci tak dikenal dikembalikan apa adanya, bukan string kosong', () => {
    // Kunci yang hilang harus TERLIHAT saat pengujian, bukan menghilang diam-diam.
    expect(translate('tidak.ada.kunci.ini', 'id')).toBe('tidak.ada.kunci.ini');
  });

  it('TC-I18N-04 — parameter tersubstitusi di kedua bahasa', () => {
    const id = translate('ui.showing_rows', 'id', { shown: 10, total: 97 });
    const en = translate('ui.showing_rows', 'en', { shown: 10, total: 97 });
    expect(id).toContain('10');
    expect(id).toContain('97');
    expect(en).toContain('10');
    expect(en).toContain('97');
    expect(id).not.toContain('{shown}');
    expect(en).not.toContain('{total}');
  });

  it('TC-I18N-05 — placeholder pada teks interpretasi statistik selalu terisi', () => {
    const interpretationKeys = DICTIONARY_KEYS.filter((k) => k.startsWith('interpret.'));
    expect(interpretationKeys.length).toBeGreaterThan(0);

    for (const key of interpretationKeys) {
      for (const locale of ['id', 'en'] as const) {
        const template = translate(key, locale);
        const placeholders = [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
        const params = Object.fromEntries(placeholders.map((p) => [p, 'X']));
        expect(translate(key, locale, params)).not.toMatch(/\{\w+\}/);
      }
    }
  });

  it('TC-I18N-06 — istilah "Threshold" konsisten diterjemahkan "Ambang Batas"', () => {
    // DESIGN.md Bagian 12: istilah teknis dijaga konsisten di seluruh modul.
    expect(translate('table.threshold', 'id')).toBe('Ambang Batas');
    const inconsistent = DICTIONARY_KEYS.filter((key) => {
      const idText = dictionary[key][0];
      return /\bthreshold\b/i.test(dictionary[key][1]) && /\b(Batas|Limit)\b/.test(idText) && !idText.includes('Ambang Batas');
    });
    expect(inconsistent).toEqual([]);
  });

  it('TC-I18N-07 — status On Track / At Risk sengaja sama di kedua bahasa', () => {
    expect(translate('status.on_track', 'id')).toBe(translate('status.on_track', 'en'));
    expect(translate('status.at_risk', 'id')).toBe(translate('status.at_risk', 'en'));
    // "Kritis"/"Critical" MEMANG diterjemahkan.
    expect(translate('status.critical', 'id')).toBe('Kritis');
    expect(translate('status.critical', 'en')).toBe('Critical');
  });

  it('TC-I18N-08 — pesan kesalahan menjelaskan, bukan meminta maaf', () => {
    const apologetic = DICTIONARY_KEYS.filter((key) => key.startsWith('error.')).filter((key) =>
      /\b(maaf|sorry|apolog)/i.test(dictionary[key][0] + dictionary[key][1]),
    );
    expect(apologetic).toEqual([]);
  });
});

describe('Nama modul tidak diterjemahkan — DESIGN.md 8.1 & BRAND.md Bagian 7', () => {
  it('TC-I18N-09 — label navigasi modul identik terlepas dari bahasa antarmuka', () => {
    // Label modul disimpan sebagai satu string, bukan pasangan per bahasa —
    // secara struktural mustahil ikut diterjemahkan.
    for (const item of ALL_NAV_ITEMS) {
      expect(typeof item.label).toBe('string');
      expect(item.label.length).toBeGreaterThan(0);
      // Tidak boleh berupa kunci i18n.
      expect(DICTIONARY_KEYS).not.toContain(item.label);
    }
    expect(ALL_NAV_ITEMS.map((i) => i.label)).toContain('KPI Center');
    expect(ALL_NAV_ITEMS.map((i) => i.label)).toContain('Executive Cockpit');
    expect(ALL_NAV_ITEMS.map((i) => i.label)).toContain('Dashboard Designer');
  });

  it('TC-I18N-10 — nama domain (pengelompokan navigasi) JUSTRU diterjemahkan', () => {
    for (const group of NAV_GROUPS) {
      expect(DICTIONARY_KEYS).toContain(group.labelKey);
      expect(translate(group.labelKey, 'id')).not.toBe('');
      expect(translate(group.labelKey, 'en')).not.toBe('');
    }
    expect(translate('domain.ai', 'id')).toBe('Analitik Cerdas (AI)');
    expect(translate('domain.ai', 'en')).toBe('Intelligent Analytics (AI)');
  });

  it('TC-I18N-11 — navigasi memuat 30 modul dalam 8 domain (PRD Lampiran B)', () => {
    expect(NAV_GROUPS).toHaveLength(8);
    expect(ALL_NAV_ITEMS).toHaveLength(30);
  });

  it('TC-I18N-12 — setiap modul navigasi terhubung ke feature flag yang valid', () => {
    for (const item of ALL_NAV_ITEMS) {
      expect(MODULE_KEYS).toContain(item.moduleKey);
    }
    // Sebaliknya: setiap feature flag punya modul di navigasi.
    const navKeys = new Set(ALL_NAV_ITEMS.map((i) => i.moduleKey));
    for (const key of MODULE_KEYS) expect(navKeys.has(key)).toBe(true);
  });
});

describe('Token desain Light & Dark — DESIGN.md Bagian 2 & 7', () => {
  it('TC-THEME-01 — setiap token peran punya nilai di KEDUA mode', () => {
    for (const [token, values] of Object.entries(roleTokens)) {
      expect(values.light, `${token} light`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(values.dark, `${token} dark`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('TC-THEME-02 — nilai Light dan Dark benar-benar berbeda untuk permukaan & teks', () => {
    const mustDiffer = ['--canvas', '--surface', '--text-900', '--border'] as const;
    for (const token of mustDiffer) {
      expect(roleTokens[token].light).not.toBe(roleTokens[token].dark);
    }
  });

  it('TC-THEME-03 — sidebar (--chrome) tetap gelap di kedua mode (DESIGN.md 7.3)', () => {
    const luminance = (hex: string): number => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    };
    expect(luminance(roleTokens['--chrome'].light)).toBeLessThan(0.2);
    expect(luminance(roleTokens['--chrome'].dark)).toBeLessThan(0.2);
  });

  it('TC-THEME-04 — tokens.css mendefinisikan setiap token peran untuk kedua tema', () => {
    const css = readFileSync(join(repoRoot, 'shared', 'design-tokens', 'src', 'tokens.css'), 'utf8');
    const lightBlock = css.slice(css.indexOf("[data-theme='light']"), css.indexOf("[data-theme='dark']"));
    const darkBlock = css.slice(css.indexOf("[data-theme='dark']"));

    for (const token of Object.keys(roleTokens)) {
      expect(lightBlock, `${token} missing in light`).toContain(`${token}:`);
      expect(darkBlock, `${token} missing in dark`).toContain(`${token}:`);
    }
  });

  it('TC-THEME-05 — cssVariablesFor menghasilkan set token lengkap per mode', () => {
    for (const mode of ['light', 'dark'] as const) {
      const variables = cssVariablesFor(mode);
      for (const token of Object.keys(roleTokens)) expect(variables[token]).toBeDefined();
      expect(variables['--font-display']).toContain('Space Grotesk');
      expect(variables['--font-mono']).toContain('JetBrains Mono');
      expect(variables['--shadow']).toBeDefined();
    }
  });

  it('TC-THEME-06 — warna kategori data tidak berbalik antar-mode (DESIGN.md 2.2)', () => {
    const light = cssVariablesFor('light');
    const dark = cssVariablesFor('dark');
    const hueOf = (hex: string): number => {
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max === min) return 0;
      const d = max - min;
      let h: number;
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      return ((h * 60) + 360) % 360;
    };

    for (let i = 1; i <= 8; i++) {
      const l = light[`--series-${i}`]!;
      const d = dark[`--series-${i}`]!;
      // Hue tetap (identitas kategori dikenali sama); hanya kecerahan disesuaikan tipis.
      expect(Math.abs(hueOf(l) - hueOf(d))).toBeLessThan(12);
    }
  });
});
