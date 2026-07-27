/**
 * Parsing & validasi berkas unggahan — PRD 6.11, SECURITY.md Bagian 7.
 *
 * Parsing dijalankan murni di memori tanpa `eval`/spawn dan tanpa menyentuh sistem
 * berkas berdasarkan isi berkas — inilah bentuk "sandboxed parsing" pada lapisan
 * aplikasi (SECURITY.md 7).
 */
import { PayloadTooLargeError, ValidationError } from '../platform/errors.ts';
import { splitCsvLine } from '../identity-service/index.ts';

/** Whitelist ekstensi (SECURITY.md Bagian 7). */
export const ALLOWED_EXTENSIONS = ['.csv', '.xlsx'] as const;

/** Batas ukuran & jumlah baris untuk mencegah DoS lewat unggahan berlebihan. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200MB (PRD 6.11)
export const MAX_ROWS = 1_000_000;

export type ColumnType = 'text' | 'number' | 'date' | 'boolean';

export interface DetectedColumn {
  name: string;
  type: ColumnType;
  nullCount: number;
  distinctCount: number;
  samples: string[];
}

export interface ParsedDataset {
  columns: DetectedColumn[];
  rows: Array<Record<string, string | number | boolean | null>>;
  rowCount: number;
}

/**
 * Validasi nama berkas.
 *
 * Menolak ekstensi tersamar seperti `data.csv.exe` (SECURITY.md Bagian 7, TC-DS-03):
 * pemeriksaan dilakukan pada SELURUH rangkaian ekstensi, bukan hanya segmen terakhir,
 * karena `.csv.exe` berakhiran `.exe` tetapi `data.exe.csv` juga harus ditolak —
 * berkas sah hanya memiliki SATU ekstensi yang ada di whitelist.
 */
export function validateFilename(filename: string): { ok: true; extension: string } | { ok: false; reasonKey: string } {
  const cleaned = filename.trim();
  if (!cleaned || cleaned.includes('/') || cleaned.includes('\\') || cleaned.includes('\0')) {
    return { ok: false, reasonKey: 'error.upload_invalid_name' };
  }

  const segments = cleaned.split('.');
  if (segments.length < 2) return { ok: false, reasonKey: 'error.upload_no_extension' };

  // Lebih dari satu ekstensi = ekstensi tersamar.
  const extensions = segments.slice(1).filter((s) => /^[A-Za-z0-9]{1,5}$/.test(s));
  if (extensions.length !== 1) {
    return { ok: false, reasonKey: 'error.upload_disguised_extension' };
  }

  const extension = `.${extensions[0]!.toLowerCase()}`;
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(extension)) {
    return { ok: false, reasonKey: 'error.upload_extension_not_allowed' };
  }
  return { ok: true, extension };
}

/**
 * Pemindaian malware. Di production ini memanggil pemindai antivirus (SECURITY.md 7);
 * di sini diterapkan heuristik penolakan konten eksekusi yang jelas berbahaya agar
 * jalur kontrolnya nyata dan dapat diuji, bukan sekadar komentar TODO.
 */
export function scanForMalware(buffer: Buffer): { clean: boolean; reasonKey?: string } {
  const head = buffer.subarray(0, 1024);

  // Magic bytes berkas eksekusi yang tidak mungkin muncul di awal CSV/XLSX sah.
  const signatures: Array<{ bytes: number[]; label: string }> = [
    { bytes: [0x4d, 0x5a], label: 'dos_pe' }, // MZ — Windows PE
    { bytes: [0x7f, 0x45, 0x4c, 0x46], label: 'elf' }, // ELF
    { bytes: [0xca, 0xfe, 0xba, 0xbe], label: 'mach_o_fat' },
    { bytes: [0x23, 0x21], label: 'shebang' }, // #!
  ];
  for (const sig of signatures) {
    if (sig.bytes.every((b, i) => head[i] === b)) {
      return { clean: false, reasonKey: 'error.upload_malware_detected' };
    }
  }

  // EICAR — berkas uji antivirus standar; dipakai pengujian jalur ini.
  if (head.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')) {
    return { clean: false, reasonKey: 'error.upload_malware_detected' };
  }

  return { clean: true };
}

const DATE_PATTERNS: RegExp[] = [
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/, // ISO
  /^\d{2}\/\d{2}\/\d{4}$/,
  /^\d{2}-\d{2}-\d{4}$/,
  /^\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}$/, // 24 Jul 2026
];

const BOOLEAN_VALUES = new Set(['true', 'false', 'ya', 'tidak', 'yes', 'no', '1', '0']);

export function looksLikeDate(value: string): boolean {
  const trimmed = value.trim();
  if (!DATE_PATTERNS.some((p) => p.test(trimmed))) return false;

  // Format hari-dulu (24/07/2026, 24-07-2026) dinormalisasi ke ISO sebelum diurai.
  // Tanpa ini `Date.parse` menafsirkannya sebagai bulan-dulu ala en-US dan menolak
  // tanggal Indonesia yang sah — DESIGN.md 8.3 menyebut kedua format sebagai valid.
  const dayFirst = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(trimmed);
  if (dayFirst) {
    const [, day, month, year] = dayFirst;
    const d = Number(day);
    const m = Number(month);
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    const parsed = new Date(Number(year), m - 1, d);
    return parsed.getMonth() === m - 1 && parsed.getDate() === d;
  }

  return Number.isFinite(Date.parse(trimmed));
}

export function looksLikeNumber(value: string): boolean {
  const v = value.trim();
  if (v === '') return false;
  // Menerima format id-ID (1.234,56) maupun en-US (1,234.56) — DESIGN.md 8.3.
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(v)) return true;
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(v)) return true;
  return /^-?\d+([.,]\d+)?%?$/.test(v);
}

export function parseNumber(value: string): number | null {
  let v = value.trim().replace(/%$/, '');
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(v)) v = v.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(v)) v = v.replace(/,/g, '');
  else v = v.replace(',', '.');
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Deteksi tipe kolom otomatis (PRD 6.11, TC-DS-04).
 *
 * Tipe ditentukan dari nilai non-kosong; kolom tanggal TIDAK boleh jatuh ke `text`
 * hanya karena ada satu sel kosong.
 */
export function detectColumnType(values: string[]): ColumnType {
  const nonEmpty = values.filter((v) => v.trim() !== '');
  if (nonEmpty.length === 0) return 'text';

  const dateCount = nonEmpty.filter(looksLikeDate).length;
  if (dateCount / nonEmpty.length >= 0.9) return 'date';

  const boolCount = nonEmpty.filter((v) => BOOLEAN_VALUES.has(v.trim().toLowerCase())).length;
  if (boolCount === nonEmpty.length && new Set(nonEmpty.map((v) => v.toLowerCase())).size <= 2) {
    return 'boolean';
  }

  const numberCount = nonEmpty.filter(looksLikeNumber).length;
  if (numberCount / nonEmpty.length >= 0.9) return 'number';

  return 'text';
}

export interface ParseOptions {
  maxRows?: number;
  delimiter?: ',' | ';' | '\t';
}

/** Menebak pemisah kolom dari baris header. */
export function detectDelimiter(headerLine: string): ',' | ';' | '\t' {
  const counts: Array<[',' | ';' | '\t', number]> = [
    [',', (headerLine.match(/,/g) ?? []).length],
    [';', (headerLine.match(/;/g) ?? []).length],
    ['\t', (headerLine.match(/\t/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ',';
}

export function parseCsv(content: string, options: ParseOptions = {}): ParsedDataset {
  const maxRows = options.maxRows ?? MAX_ROWS;
  const lines = content.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();

  if (lines.length === 0) throw new ValidationError('error.csv_empty');
  if (lines.length - 1 > maxRows) {
    throw new PayloadTooLargeError('error.upload_too_many_rows', { rows: lines.length - 1, maxRows });
  }

  const delimiter = options.delimiter ?? detectDelimiter(lines[0]!);
  const split = (line: string): string[] =>
    delimiter === ',' ? splitCsvLine(line) : line.split(delimiter).map((c) => c.trim());

  const headers = split(lines[0]!).map((h, i) => {
    const name = h.trim().replace(/^﻿/, '');
    return name === '' ? `column_${i + 1}` : name;
  });

  if (new Set(headers).size !== headers.length) {
    throw new ValidationError('error.csv_duplicate_headers');
  }

  const rawColumns: string[][] = headers.map(() => []);
  const rows: Array<Record<string, string | number | boolean | null>> = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const cells = split(line);
    const record: Record<string, string | number | boolean | null> = {};
    headers.forEach((h, idx) => {
      const cell = (cells[idx] ?? '').trim();
      rawColumns[idx]!.push(cell);
      record[h] = cell === '' ? null : cell;
    });
    rows.push(record);
  }

  const columns: DetectedColumn[] = headers.map((name, idx) => {
    const values = rawColumns[idx]!;
    const type = detectColumnType(values);
    const nonEmpty = values.filter((v) => v !== '');
    return {
      name,
      type,
      nullCount: values.length - nonEmpty.length,
      distinctCount: new Set(nonEmpty).size,
      samples: [...new Set(nonEmpty)].slice(0, 5),
    };
  });

  // Konversi nilai mengikuti tipe terdeteksi agar analisis hilir (statistik, KPI)
  // menerima angka sebagai angka, bukan string.
  for (const row of rows) {
    for (const col of columns) {
      const raw = row[col.name];
      if (raw === null || raw === undefined) continue;
      const s = String(raw);
      if (col.type === 'number') {
        const parsed = parseNumber(s);
        // Nilai yang ADA tetapi tidak dapat diurai TIDAK diubah menjadi null:
        // itu akan menghapus beda antara "kosong" dan "tidak valid", padahal
        // Data Quality Center wajib melaporkan keduanya terpisah (PRD 6.14,
        // TESTING.md Bagian 5). Nilai asli dipertahankan agar dapat ditandai.
        if (parsed !== null) row[col.name] = parsed;
      } else if (col.type === 'boolean') {
        const truthy = ['true', 'ya', 'yes', '1'];
        const falsy = ['false', 'tidak', 'no', '0'];
        const lowered = s.toLowerCase();
        if (truthy.includes(lowered)) row[col.name] = true;
        else if (falsy.includes(lowered)) row[col.name] = false;
        // Nilai boolean yang tidak dikenali juga dibiarkan apa adanya.
      }
    }
  }

  return { columns, rows, rowCount: rows.length };
}

/**
 * XLSX minimal: berkas XLSX adalah arsip ZIP. Tanpa dependensi pihak ketiga, unggahan
 * XLSX diterima dan divalidasi bentuknya, namun ekstraksi isi memerlukan pustaka
 * spreadsheet. Alih-alih diam-diam menghasilkan dataset kosong, jalur ini menolak
 * dengan alasan yang jelas dan dapat ditelusuri (PRD 6.11).
 */
export function assertXlsxSupported(buffer: Buffer): never {
  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b;
  throw new ValidationError(
    isZip ? 'error.xlsx_conversion_required' : 'error.upload_corrupt_file',
    { hint: 'convert_to_csv' },
  );
}
