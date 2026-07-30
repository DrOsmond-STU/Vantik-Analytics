/**
 * Row-Level Security.
 *
 * SECURITY.md Bagian 5: "RLS diterapkan pada level query, bukan hanya disembunyikan di
 * antarmuka (UI hiding bukan kontrol keamanan yang sah)."
 *
 * TESTING.md Bagian 4: pengguna dengan RLS "Wilayah Timur saja" yang mengubah parameter
 * query untuk melihat "Wilayah Barat" tidak boleh mendapat data itu di RESPONS API —
 * bukan sekadar disembunyikan di UI.
 */
import type { TenantScopedDb } from './tenancy.ts';

export interface RlsRule {
  dimension: string;
  operator: 'in' | 'not_in';
  values: string[];
}

/** Cakupan RLS efektif seorang subjek (pengguna + seluruh perannya). */
export class RlsScope {
  constructor(private readonly rules: readonly RlsRule[]) {}

  static empty(): RlsScope {
    return new RlsScope([]);
  }

  get isUnrestricted(): boolean {
    return this.rules.length === 0;
  }

  dimensions(): string[] {
    return [...new Set(this.rules.map((r) => r.dimension))];
  }

  /** Aturan untuk satu dimensi; beberapa aturan pada dimensi sama bersifat AND (paling ketat menang). */
  rulesFor(dimension: string): RlsRule[] {
    return this.rules.filter((r) => r.dimension === dimension);
  }

  /**
   * Menguji satu baris data. `row` adalah objek hasil parsing dataset —
   * kunci dimensi dicocokkan case-insensitive karena nama kolom berasal dari
   * berkas unggahan pengguna, bukan skema yang kita kendalikan.
   */
  permits(row: Record<string, unknown>): boolean {
    if (this.isUnrestricted) return true;
    const lookup = new Map<string, unknown>();
    for (const [k, v] of Object.entries(row)) lookup.set(k.toLowerCase(), v);

    for (const rule of this.rules) {
      const raw = lookup.get(rule.dimension.toLowerCase());
      // Fail secure (SECURITY.md Bagian 2): baris yang tidak memuat kolom dimensi
      // pembatas TIDAK dianggap lolos — akses default ditolak, bukan diizinkan.
      if (raw === undefined || raw === null) return false;
      const value = String(raw);
      const inList = rule.values.some((v) => v.toLowerCase() === value.toLowerCase());
      if (rule.operator === 'in' && !inList) return false;
      if (rule.operator === 'not_in' && inList) return false;
    }
    return true;
  }

  /** Memfilter kumpulan baris. Selalu dipanggil di sisi server sebelum respons dibentuk. */
  filter<T extends Record<string, unknown>>(rows: T[]): T[] {
    if (this.isUnrestricted) return rows;
    return rows.filter((r) => this.permits(r));
  }

  /**
   * Fragmen SQL untuk kolom dimensi yang tersimpan sebagai kolom nyata
   * (mis. `kpi_score_history.dimension_key`).
   */
  sqlFragment(column: string): { sql: string; params: string[] } | null {
    if (this.isUnrestricted) return null;
    const clauses: string[] = [];
    const params: string[] = [];
    for (const rule of this.rules) {
      if (rule.values.length === 0) {
        clauses.push('0 = 1');
        continue;
      }
      const placeholders = rule.values.map(() => '?').join(', ');
      clauses.push(
        rule.operator === 'in'
          ? `(${column} IN (${placeholders}))`
          : `(${column} IS NULL OR ${column} NOT IN (${placeholders}))`,
      );
      params.push(...rule.values);
    }
    return { sql: clauses.join(' AND '), params };
  }

  toJSON(): RlsRule[] {
    return [...this.rules];
  }
}

interface RlsRuleRow {
  dimension: string;
  operator: string;
  values_json: string;
}

/**
 * Memuat cakupan RLS efektif: aturan yang melekat pada pengguna DAN pada seluruh
 * perannya digabung. Beberapa aturan bersifat AND — pembatasan paling ketat menang,
 * konsisten dengan prinsip least privilege (SECURITY.md Bagian 2).
 */
export function loadRlsScope(
  db: TenantScopedDb,
  userId: string,
  roleIds: readonly string[],
): RlsScope {
  const subjects: Array<[string, string]> = [['user', userId]];
  for (const roleId of roleIds) subjects.push(['role', roleId]);

  const rules: RlsRule[] = [];
  for (const [type, id] of subjects) {
    const rows = db.all<RlsRuleRow>('rls_rules', { subject_type: type, subject_id: id });
    for (const row of rows) {
      rules.push({
        dimension: row.dimension,
        operator: row.operator === 'not_in' ? 'not_in' : 'in',
        values: JSON.parse(row.values_json) as string[],
      });
    }
  }
  return new RlsScope(rules);
}

/**
 * Cakupan RLS yang diwariskan token sematan (PRD 6.21, SECURITY.md Bagian 15).
 * Dievaluasi ULANG di server tiap permintaan, tidak pernah diambil dari query string.
 */
export function scopeFromEmbedToken(rlsScopeJson: string): RlsScope {
  const parsed = JSON.parse(rlsScopeJson) as RlsRule[];
  return new RlsScope(
    parsed.map((r) => ({
      dimension: r.dimension,
      operator: r.operator === 'not_in' ? 'not_in' : 'in',
      values: r.values ?? [],
    })),
  );
}
