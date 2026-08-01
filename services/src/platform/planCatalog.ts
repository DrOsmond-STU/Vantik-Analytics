/**
 * Resolusi katalog paket.
 *
 * Berada di `platform/` — BUKAN di `cms-service/` — karena bukan hanya CMS yang
 * membutuhkannya. Hak akses per tenant (`loadFeatureFlags`) dan validasi provisioning
 * juga harus melihat katalog yang SAMA; kalau tidak, kuota yang disunting operator
 * tampil di halaman depan tetapi tidak pernah benar-benar berlaku — kebohongan diam-diam
 * yang jauh lebih buruk daripada tidak menyediakan penyuntingannya sama sekali.
 *
 * Sumbernya tabel `plans`, bukan tabel CMS tersendiri. Tabel itu sudah direferensikan
 * `subscriptions.plan_code` lewat FOREIGN KEY: katalog kedua akan membuat penagihan dan
 * halaman depan membaca dua daftar berbeda, dan perbedaannya baru ketahuan saat menagih.
 * `PLAN_CATALOG` di kode tetap menjadi BENIH — ditanam sekali, lalu boleh disunting.
 *
 * Arah ketergantungan tetap terjaga: layanan bergantung pada kernel, tidak sebaliknya.
 */
import type { Db } from './db.ts';
import {
  MODULE_KEYS,
  PLAN_CATALOG,
  QUOTA_KEYS,
  type ModuleKey,
  type PlanDefinition,
  type QuotaKey,
} from './featureFlags.ts';

export interface PlanRow {
  code: string;
  name: string;
  monthly_price: number;
  annual_price: number;
  features_json: string;
  quotas_json: string;
  description: string | null;
  sort_order: number;
  published: number;
}

const FALLBACK = PLAN_CATALOG[0]!;

/** Baris tabel → definisi paket, dengan bawaan sebagai jaring pengaman per medan. */
export function definitionFromRow(row: PlanRow): PlanDefinition {
  const seed = PLAN_CATALOG.find((plan) => plan.code === row.code);

  let features: Record<string, boolean> = {};
  let blob: { quotas?: Record<string, number>; overBehaviour?: Record<string, 'block' | 'overage'> } = {};
  try {
    features = JSON.parse(row.features_json) as Record<string, boolean>;
    blob = JSON.parse(row.quotas_json) as typeof blob;
  } catch {
    // JSON rusak pada satu baris tidak boleh menjatuhkan seluruh katalog —
    // paket itu jatuh ke bawaan, sisanya tetap terbaca.
    features = {};
    blob = {};
  }

  const resolvedFeatures = {} as Record<ModuleKey, boolean>;
  for (const key of MODULE_KEYS) resolvedFeatures[key] = features[key] === true;

  const resolvedQuotas = {} as Record<QuotaKey, number>;
  const over = {} as Record<QuotaKey, 'block' | 'overage'>;
  for (const key of QUOTA_KEYS) {
    const value = blob.quotas?.[key];
    resolvedQuotas[key] = typeof value === 'number' ? value : (seed?.quotas[key] ?? 0);
    // Perilaku saat kuota terlampaui TIDAK disunting lewat CMS: itu keputusan yang
    // berdampak pada penagihan, bukan konten.
    over[key] = blob.overBehaviour?.[key] ?? seed?.overBehaviour[key] ?? FALLBACK.overBehaviour[key];
  }

  return {
    code: row.code,
    name: row.name,
    monthlyPrice: row.monthly_price,
    annualPrice: row.annual_price,
    features: resolvedFeatures,
    quotas: resolvedQuotas,
    overBehaviour: over,
    sortOrder: row.sort_order,
  };
}

/**
 * Katalog efektif.
 *
 * `includeUnpublished` memisahkan dua pertanyaan berbeda: "apa yang ditawarkan kepada
 * pengunjung?" dan "paket apa yang masih perlu dihitung?". Paket yang berhenti dijual
 * tetap harus menjawab pertanyaan kedua.
 */
export function resolveCatalog(db: Db, includeUnpublished = false): PlanDefinition[] {
  const rows = db.prepare('SELECT * FROM plans').all() as PlanRow[];
  if (rows.length === 0) return [...PLAN_CATALOG];
  return rows
    .filter((row) => includeUnpublished || row.published !== 0)
    .map(definitionFromRow)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
}

/** Satu paket menurut katalog efektif; `undefined` bila kodenya tidak dikenal. */
export function resolvePlan(db: Db, code: string): PlanDefinition | undefined {
  const row = db.prepare('SELECT * FROM plans WHERE code = ?').get(code) as PlanRow | undefined;
  if (row) return definitionFromRow(row);
  return PLAN_CATALOG.find((plan) => plan.code === code);
}
