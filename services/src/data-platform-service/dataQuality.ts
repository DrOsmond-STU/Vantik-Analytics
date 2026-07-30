/**
 * Data Quality Center — PRD 6.14.
 *
 * TESTING.md Bagian 5 menuntut deteksi yang PERSIS: dataset uji sintetis dengan
 * kesalahan yang disengaja dalam proporsi diketahui harus menghasilkan deteksi
 * proporsi tersebut — bukan under/over-detect. Karena itu setiap pemeriksaan di sini
 * menghitung jumlah absolut, bukan estimasi.
 */
import type { DetectedColumn } from './csv.ts';
import { looksLikeDate, looksLikeNumber } from './csv.ts';

export type DatasetRow = Record<string, string | number | boolean | null>;

export interface QualityFinding {
  /** Kunci i18n; pesan ditampilkan lewat kamus (DESIGN.md 8.2). */
  messageKey: string;
  column?: string;
  count: number;
  severity: 'info' | 'warning' | 'critical';
}

export interface QualityReport {
  score: number;
  rowsChecked: number;
  duplicateRows: number;
  missingCells: number;
  invalidCells: number;
  findings: QualityFinding[];
  /** Ambang minimum untuk dapat disertifikasi (PRD 6.14). */
  certifiable: boolean;
}

/** Dataset dengan skor di bawah ambang ini ditandai dan TIDAK dapat disertifikasi. */
export const CERTIFICATION_THRESHOLD = 70;

/** Bobot pengurang skor. Dijaga stabil agar uji regresi TESTING.md Bagian 5 bermakna. */
const WEIGHTS = {
  missing: 35,
  duplicate: 30,
  invalid: 35,
} as const;

function canonicalRow(row: DatasetRow, columns: string[]): string {
  return columns.map((c) => String(row[c] ?? '')).join('');
}

/** Menghitung baris duplikat: setiap kemunculan setelah yang pertama dihitung satu. */
export function countDuplicateRows(rows: DatasetRow[], columns: string[]): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const row of rows) {
    const key = canonicalRow(row, columns);
    if (seen.has(key)) duplicates++;
    else seen.add(key);
  }
  return duplicates;
}

/** Sel kosong (null / string kosong). */
export function countMissingCells(rows: DatasetRow[], columns: string[]): { total: number; byColumn: Map<string, number> } {
  const byColumn = new Map<string, number>();
  let total = 0;
  for (const row of rows) {
    for (const col of columns) {
      const v = row[col];
      if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
        total++;
        byColumn.set(col, (byColumn.get(col) ?? 0) + 1);
      }
    }
  }
  return { total, byColumn };
}

/**
 * Sel tidak valid: nilai yang ADA tetapi tidak sesuai tipe kolomnya
 * (mis. "dua puluh" di kolom angka, "32/13/2026" di kolom tanggal).
 * Sel kosong TIDAK dihitung di sini agar tidak terhitung ganda dengan `missing`.
 */
export function countInvalidCells(
  rows: DatasetRow[],
  columns: DetectedColumn[],
): { total: number; byColumn: Map<string, number> } {
  const byColumn = new Map<string, number>();
  let total = 0;
  for (const row of rows) {
    for (const col of columns) {
      const v = row[col.name];
      if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) continue;

      let invalid = false;
      if (col.type === 'number') {
        invalid = typeof v === 'number' ? !Number.isFinite(v) : !looksLikeNumber(String(v));
      } else if (col.type === 'date') {
        invalid = !looksLikeDate(String(v));
      } else if (col.type === 'boolean') {
        invalid =
          typeof v !== 'boolean' &&
          !['true', 'false', 'ya', 'tidak', 'yes', 'no', '1', '0'].includes(String(v).toLowerCase());
      }

      if (invalid) {
        total++;
        byColumn.set(col.name, (byColumn.get(col.name) ?? 0) + 1);
      }
    }
  }
  return { total, byColumn };
}

/**
 * Menghitung Quality Score 0–100.
 *
 * Skor = 100 dikurangi penalti proporsional per kategori. Proporsi dihitung terhadap
 * jumlah sel (untuk missing/invalid) atau jumlah baris (untuk duplikat), sehingga
 * dataset besar dan kecil dinilai dengan ukuran yang sama.
 */
export function assessQuality(rows: DatasetRow[], columns: DetectedColumn[]): QualityReport {
  const columnNames = columns.map((c) => c.name);
  const rowsChecked = rows.length;
  const cellCount = Math.max(1, rowsChecked * Math.max(1, columnNames.length));

  const duplicateRows = countDuplicateRows(rows, columnNames);
  const missing = countMissingCells(rows, columnNames);
  const invalid = countInvalidCells(rows, columns);

  const missingRatio = missing.total / cellCount;
  const invalidRatio = invalid.total / cellCount;
  const duplicateRatio = rowsChecked === 0 ? 0 : duplicateRows / rowsChecked;

  const penalty =
    missingRatio * WEIGHTS.missing + invalidRatio * WEIGHTS.invalid + duplicateRatio * WEIGHTS.duplicate;

  const score = Math.max(0, Math.min(100, Number((100 - penalty).toFixed(2))));

  const findings: QualityFinding[] = [];
  if (duplicateRows > 0) {
    findings.push({
      messageKey: 'dq.duplicate_rows',
      count: duplicateRows,
      severity: duplicateRatio > 0.05 ? 'critical' : 'warning',
    });
  }
  for (const [column, count] of missing.byColumn) {
    const ratio = count / Math.max(1, rowsChecked);
    findings.push({
      messageKey: 'dq.missing_values',
      column,
      count,
      severity: ratio > 0.2 ? 'critical' : ratio > 0.05 ? 'warning' : 'info',
    });
  }
  for (const [column, count] of invalid.byColumn) {
    findings.push({
      messageKey: 'dq.invalid_values',
      column,
      count,
      severity: 'critical',
    });
  }
  if (findings.length === 0) {
    findings.push({ messageKey: 'dq.no_issues', count: 0, severity: 'info' });
  }

  findings.sort((a, b) => {
    const rank = { critical: 0, warning: 1, info: 2 } as const;
    return rank[a.severity] - rank[b.severity] || b.count - a.count;
  });

  return {
    score,
    rowsChecked,
    duplicateRows,
    missingCells: missing.total,
    invalidCells: invalid.total,
    findings,
    certifiable: score >= CERTIFICATION_THRESHOLD,
  };
}
