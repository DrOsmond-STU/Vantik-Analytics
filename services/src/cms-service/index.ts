/**
 * CMS — konten halaman publik dan katalog paket berlangganan.
 *
 * Dua keputusan bentuk yang menentukan sisanya:
 *
 * 1. **Konten disimpan sebagai PENIMPAAN, bukan salinan penuh.** Kamus i18n tetap
 *    memegang teks bawaan; tabel `site_content` hanya berisi kunci yang benar-benar
 *    diubah operator. Menyalin seluruh kamus ke basis data akan melahirkan dua sumber
 *    kebenaran yang perlahan berbeda — dan perbedaan itu baru ketahuan saat rilis
 *    berikutnya memperbaiki satu kalimat yang ternyata sudah "beku" di basis data.
 *
 * 2. **Katalog paket di basis data menimpa definisi kode, per kode paket.** Tabel
 *    kosong berarti "pakai bawaan `PLAN_CATALOG`". Itu membuat migrasi tidak mengubah
 *    harga instalasi mana pun secara diam-diam, dan membuat operator dapat kembali ke
 *    bawaan dengan menghapus satu baris alih-alih mengetik ulang angkanya.
 *
 * Keduanya BUKAN data ber-tenant: halaman depan dan daftar harga adalah permukaan
 * platform, dibaca pengunjung yang belum punya tenant sama sekali.
 */
import type { Db } from '../platform/db.ts';
import { definitionFromRow, resolveCatalog, resolvePlan, type PlanRow } from '../platform/planCatalog.ts';
import { ValidationError, ConflictError, NotFoundError } from '../platform/errors.ts';
import {
  MODULE_KEYS,
  PLAN_CATALOG,
  QUOTA_KEYS,
  type ModuleKey,
  type PlanDefinition,
  type QuotaKey,
} from '../platform/featureFlags.ts';

const LOCALES = ['id', 'en'] as const;
export type CmsLocale = (typeof LOCALES)[number];

/**
 * Kunci konten yang boleh disunting.
 *
 * Daftar-IZIN, bukan daftar-tolak. Kalau operator boleh menulis kunci apa pun, ia dapat
 * menimpa label tombol, pesan kesalahan, dan nama modul — teks yang diandalkan pengujian
 * dan yang menurut BRAND.md tidak diterjemahkan sama sekali. Kunci baru masuk ke sini
 * dengan sengaja, bukan karena kebetulan ada di kamus.
 */
export const EDITABLE_CONTENT_KEYS: readonly string[] = [
  'ui.landing_eyebrow',
  'ui.landing_headline',
  'ui.landing_sub',
  'ui.landing_trial_note',
  'ui.landing_stat_modules',
  'ui.landing_stat_domains',
  'ui.landing_stat_locales',
  'ui.landing_stat_tenancy',
  'ui.landing_modules_eyebrow',
  'ui.landing_modules_title',
  'ui.landing_modules_sub',
  'ui.landing_why_eyebrow',
  'ui.landing_why_title',
  'ui.landing_why_1_title',
  'ui.landing_why_1_body',
  'ui.landing_why_2_title',
  'ui.landing_why_2_body',
  'ui.landing_why_3_title',
  'ui.landing_why_3_body',
  'ui.landing_why_4_title',
  'ui.landing_why_4_body',
  'ui.landing_plans_eyebrow',
  'ui.landing_plans_title',
  'ui.landing_plans_sub',
  'ui.landing_cta_title',
  'ui.landing_cta_sub',
  'ui.tagline',
];

const EDITABLE = new Set(EDITABLE_CONTENT_KEYS);

/** Batas panjang. Teks halaman depan bukan tempat menyimpan dokumen. */
const MAX_VALUE_LENGTH = 2_000;

export interface ContentRow {
  key: string;
  locale: CmsLocale;
  value: string;
}

export interface PlanInput {
  code: string;
  name: string;
  monthlyPrice: number;
  annualPrice: number;
  quotas: Record<string, number>;
  modules: string[];
  description?: string | null;
  sortOrder?: number;
  published?: boolean;
}

function isLocale(value: string): value is CmsLocale {
  return (LOCALES as readonly string[]).includes(value);
}

/* ============================== Konten ============================== */

/**
 * Penimpaan konten untuk satu bahasa.
 *
 * Mengembalikan HANYA yang disunting. Pemanggil di sisi klien menggabungkannya di atas
 * kamus (`cms[key] ?? t(key)`), sehingga kunci yang belum pernah disentuh operator
 * otomatis ikut terbarui ketika rilis berikutnya memperbaiki kalimatnya.
 */
export function contentOverrides(db: Db, locale: string): Record<string, string> {
  if (!isLocale(locale)) return {};
  const rows = db
    .prepare('SELECT content_key, value FROM site_content WHERE locale = ?')
    .all(locale) as { content_key: string; value: string }[];
  const out: Record<string, string> = {};
  // Kunci yang sudah dicabut dari daftar-izin (mis. setelah halaman diubah) sengaja
  // TIDAK disajikan, meski barisnya masih ada — daftar-izin berlaku saat baca juga,
  // bukan hanya saat tulis.
  for (const row of rows) if (EDITABLE.has(row.content_key)) out[row.content_key] = row.value;
  return out;
}

/** Seluruh penimpaan, kedua bahasa — untuk antarmuka penyuntingan. */
export function allContentOverrides(db: Db): Record<CmsLocale, Record<string, string>> {
  return { id: contentOverrides(db, 'id'), en: contentOverrides(db, 'en') };
}

export function setContent(db: Db, key: string, locale: string, value: string, actor: string): void {
  if (!EDITABLE.has(key)) throw new ValidationError('error.content_key_not_editable', { key });
  if (!isLocale(locale)) throw new ValidationError('error.locale_unknown', { locale });

  const trimmed = value.trim();
  if (trimmed.length > MAX_VALUE_LENGTH) {
    throw new ValidationError('error.content_too_long', { max: MAX_VALUE_LENGTH });
  }

  // Mengosongkan berarti KEMBALI KE BAWAAN, bukan menampilkan halaman depan yang kosong.
  // Itu satu-satunya cara membatalkan suntingan tanpa harus mengetik ulang teks aslinya —
  // yang operator tidak punya salinannya.
  if (trimmed === '') {
    db.prepare('DELETE FROM site_content WHERE content_key = ? AND locale = ?').run(key, locale);
    return;
  }

  db.prepare(
    `INSERT INTO site_content (content_key, locale, value, updated_at, updated_by)
     VALUES (?,?,?,?,?)
     ON CONFLICT(content_key, locale) DO UPDATE SET
       value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(key, locale, trimmed, new Date().toISOString(), actor);
}

/* =========================== Katalog paket =========================== */

export function upsertPlan(db: Db, input: PlanInput, actor: string): void {
  if (!/^[a-z][a-z0-9_-]{1,30}$/.test(input.code)) {
    throw new ValidationError('error.plan_code_invalid');
  }
  if (input.name.trim() === '') throw new ValidationError('error.plan_name_required');
  for (const price of [input.monthlyPrice, input.annualPrice]) {
    if (!Number.isFinite(price) || price < 0 || !Number.isInteger(price)) {
      throw new ValidationError('error.plan_price_invalid');
    }
  }
  const unknown = input.modules.filter((m) => !(MODULE_KEYS as readonly string[]).includes(m));
  if (unknown.length > 0) throw new ValidationError('error.plan_module_unknown', { modules: unknown.join(', ') });

  const features: Record<string, boolean> = {};
  for (const key of MODULE_KEYS) features[key] = input.modules.includes(key);

  const seed = PLAN_CATALOG.find((plan) => plan.code === input.code);
  const quotas: Record<string, number> = {};
  for (const key of QUOTA_KEYS) {
    const value = input.quotas?.[key];
    quotas[key] = typeof value === 'number' && Number.isFinite(value) ? value : (seed?.quotas[key] ?? 0);
  }
  const overBehaviour = seed?.overBehaviour ?? PLAN_CATALOG[0]!.overBehaviour;

  db.prepare(
    `INSERT INTO plans (code, name, monthly_price, annual_price, features_json, quotas_json,
                        description, sort_order, published, updated_at, updated_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(code) DO UPDATE SET
       name = excluded.name, monthly_price = excluded.monthly_price,
       annual_price = excluded.annual_price, features_json = excluded.features_json,
       quotas_json = excluded.quotas_json, description = excluded.description,
       sort_order = excluded.sort_order, published = excluded.published,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(
    input.code,
    input.name.trim(),
    input.monthlyPrice,
    input.annualPrice,
    JSON.stringify(features),
    JSON.stringify({ quotas, overBehaviour }),
    input.description?.trim() || null,
    input.sortOrder ?? 100,
    input.published === false ? 0 : 1,
    new Date().toISOString(),
    actor,
  );
}

/**
 * Menarik paket dari katalog.
 *
 * Ditolak bila masih ada langganan yang memakainya — termasuk yang sudah `past_due`.
 * Paket yang hilang di tengah masa berlangganan membuat hak akses pelanggan tidak dapat
 * dihitung lagi, dan itu kerusakan yang jauh lebih mahal daripada satu baris katalog yang
 * terlihat usang. Untuk berhenti menjualnya, pakai `published = false`: paket hilang dari
 * halaman depan tetapi tetap dapat dihitung untuk yang sudah memakainya.
 */
export function deletePlan(db: Db, code: string): void {
  const row = db.prepare('SELECT code FROM plans WHERE code = ?').get(code);
  if (!row) throw new NotFoundError('error.plan_unknown');

  const used = db
    .prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE plan_code = ? AND status <> 'cancelled'")
    .get(code) as { n: number };
  if (used.n > 0) throw new ConflictError('error.plan_in_use', { count: String(used.n) });

  db.prepare('DELETE FROM plans WHERE code = ?').run(code);
}

/** Bentuk baris untuk antarmuka penyuntingan — termasuk yang belum diterbitkan. */
export function catalogForEditing(
  db: Db,
): (PlanDefinition & { published: boolean; description: string | null })[] {
  const rows = db.prepare('SELECT * FROM plans').all() as PlanRow[];
  return rows
    .map((row) => ({
      ...definitionFromRow(row),
      published: row.published !== 0,
      description: row.description,
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
}

export { resolveCatalog, resolvePlan };
