/**
 * Pembaca XLSX tanpa dependensi.
 *
 * Alasan keberadaannya praktis: data bisnis di Indonesia hampir seluruhnya berbentuk Excel.
 * Sebelum berkas ini ada, unggahan `.xlsx` ditolak dengan pesan "konversikan ke CSV dulu" —
 * jujur, tetapi memindahkan pekerjaan ke pengguna pada langkah pertama mereka memakai
 * produk ini.
 *
 * XLSX adalah arsip **ZIP** berisi **XML**. Node sudah punya keduanya: `zlib` untuk
 * inflate, dan XML-nya cukup sederhana untuk diurai dengan pemindaian tag — bukan XML
 * umum, melainkan bentuk yang sangat terbatas dan dihasilkan mesin. Jadi tidak ada
 * pustaka spreadsheet yang perlu dipasang, dan tidak ada modul native yang dapat gagal
 * terpasang di shared hosting.
 *
 * Yang SENGAJA tidak dikerjakan, dan ditolak dengan jelas alih-alih dikira-kira:
 *
 *  - Berkas terenkripsi (ZIP ber-kata sandi / OOXML terproteksi) — tidak dapat dibaca.
 *  - Formula: yang dibaca adalah NILAI hasil hitung (`<v>`) yang disimpan Excel, bukan
 *    rumusnya. Berkas yang disimpan tanpa nilai hasil (jarang, dari beberapa generator)
 *    akan tampak kosong pada kolom itu — dinyatakan lewat `error.xlsx_no_cached_values`.
 *  - Beberapa lembar: HANYA lembar pertama yang dibaca. Menggabungkan lembar diam-diam
 *    akan mencampur data yang bentuknya berbeda.
 */
import { inflateRawSync } from 'node:zlib';
import { ValidationError } from '../platform/errors.ts';

/** Batas aman saat membongkar arsip; melindungi dari zip bomb. */
export const MAX_ENTRY_BYTES = 300 * 1024 * 1024;

/* ================= ZIP ================= */

interface ZipEntry {
  name: string;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/**
 * Membaca daftar isi arsip dari *central directory*.
 *
 * Dibaca dari akhir berkas, bukan dari awal: header lokal tiap entri boleh menyatakan
 * ukuran 0 dan menaruh angka sebenarnya di *data descriptor* setelah datanya — bentuk yang
 * dipakai penulis yang menghasilkan arsip secara mengalir. Central directory selalu memuat
 * angka yang benar, jadi hanya itu yang dipercaya.
 */
function readCentralDirectory(buffer: Buffer): ZipEntry[] {
  // End of central directory: cari mundur dari ujung; komentar arsip maksimal 65535 byte.
  const minEocd = 22;
  let eocd = -1;
  for (let i = buffer.length - minEocd; i >= Math.max(0, buffer.length - 65_557); i--) {
    if (buffer.readUInt32LE(i) === 0x0605_4b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ValidationError('error.upload_corrupt_file', { hint: 'zip_no_eocd' });

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x0201_4b50) {
      throw new ValidationError('error.upload_corrupt_file', { hint: 'zip_bad_central_header' });
    }
    const flags = buffer.readUInt16LE(offset + 8);
    // Bit 0 = terenkripsi. Kami tidak dapat membacanya, dan menebak isinya lebih buruk
    // daripada mengatakannya.
    if (flags & 0x0001) throw new ValidationError('error.xlsx_encrypted');

    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    entries.push({ name, compression, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Mengambil isi satu entri sebagai teks UTF-8. */
function readEntry(buffer: Buffer, entry: ZipEntry): string {
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
    // Arsip kecil yang membongkar menjadi ratusan megabyte adalah bentuk serangan, bukan
    // berkas yang tidak sengaja besar.
    throw new ValidationError('error.upload_too_large', { hint: 'zip_entry_too_large' });
  }
  const header = entry.localHeaderOffset;
  if (header + 30 > buffer.length || buffer.readUInt32LE(header) !== 0x0403_4b50) {
    throw new ValidationError('error.upload_corrupt_file', { hint: 'zip_bad_local_header' });
  }
  const nameLength = buffer.readUInt16LE(header + 26);
  const extraLength = buffer.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedSize);

  if (entry.compression === 0) return raw.toString('utf8');
  if (entry.compression !== 8) {
    throw new ValidationError('error.upload_corrupt_file', { hint: `zip_compression_${entry.compression}` });
  }
  try {
    return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }).toString('utf8');
  } catch {
    throw new ValidationError('error.upload_corrupt_file', { hint: 'zip_inflate_failed' });
  }
}

/* ================= XML ================= */

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Mengurai entitas XML, termasuk rujukan numerik. */
export function decodeXmlText(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return XML_ENTITIES[body] ?? match;
  });
}

/**
 * Mengumpulkan teks di dalam seluruh elemen `<t>`, mengabaikan `<rPh>`.
 *
 * `<rPh>` memuat furigana Jepang — teks bantu baca yang BUKAN isi sel. Menyertakannya akan
 * menggandakan sebagian teks pada berkas yang dibuat di Excel berbahasa Jepang.
 */
function collectSharedString(xml: string): string {
  const withoutPhonetics = xml.replace(/<rPh[\s\S]*?<\/rPh>/g, '');
  let text = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(withoutPhonetics)) !== null) text += decodeXmlText(m[1] ?? '');
  return text;
}

/** Tabel string bersama; sel bertipe `s` merujuk ke indeksnya. */
export function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si\s*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1] === undefined ? '' : collectSharedString(m[1]));
  return out;
}

/* ================= Sel ================= */

/** Kolom dari rujukan sel: `A1` → 0, `AB7` → 27. */
export function columnIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref.toUpperCase());
  if (!letters) return 0;
  let n = 0;
  for (const ch of letters[1]!) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Tanggal serial Excel → ISO.
 *
 * Salah di sini adalah kesalahan yang tidak terlihat sampai seseorang membandingkan
 * laporan: tanggalnya tetap tampak seperti tanggal, hanya harinya yang keliru.
 */
export function serialToIso(serial: number): string {
  /**
   * Serial di bawah 60 digeser satu hari.
   *
   * Excel menganggap 1900 tahun kabisat, sehingga serial 60 adalah 29 Februari 1900 — hari
   * yang tidak pernah ada. Rumus baku `(serial - 25569)` mengikuti kalender sungguhan dan
   * karenanya benar untuk serial 61 ke atas, tetapi meleset satu hari untuk Januari–Februari
   * 1900. Jarang muncul di data bisnis, tetapi salah satu hari tetap salah — dan yang paling
   * mungkin terkena justru nilai kecil yang tidak sengaja diformat sebagai tanggal.
   *
   * Serial 60 sendiri tidak punya padanan nyata; ia dipetakan ke 28 Februari 1900, tanggal
   * sungguhan yang terdekat.
   */
  const adjusted = serial < 60 ? serial + 1 : serial;
  const ms = Math.round((adjusted - 25_569) * 86_400_000);
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Nomor format bawaan Excel yang berarti tanggal.
 *
 * Hanya format bawaan yang dikenali dari nomornya; format kustom dikenali dari kodenya di
 * `numFmts`. Tanpa ini, kolom tanggal terbaca sebagai angka lima digit dan pengguna melihat
 * "45678" di tempat "2025-01-15".
 */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

/** Gaya sel: memetakan indeks gaya → apakah gayanya tanggal. */
export function parseDateStyles(stylesXml: string): Set<number> {
  const dateFormatIds = new Set<number>(BUILTIN_DATE_FORMATS);

  // Format kustom: dianggap tanggal bila kodenya memuat penanda tanggal/waktu di luar
  // tanda kutip. Tanda kutip dibuang lebih dulu supaya teks literal seperti "hari" tidak
  // membuat format angka biasa disalahartikan.
  const numFmts = /<numFmt\s[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = numFmts.exec(stylesXml)) !== null) {
    const code = decodeXmlText(m[2] ?? '').replace(/"[^"]*"/g, '');
    if (/[dmyhs]/i.test(code) && !/^[^dmyhs]*$/i.test(code)) dateFormatIds.add(Number(m[1]));
  }

  const styles = new Set<number>();
  const cellXfs = /<cellXfs[\s\S]*?<\/cellXfs>/.exec(stylesXml)?.[0] ?? '';
  const xfRe = /<xf\s[^>]*\/>|<xf\s[^>]*>[\s\S]*?<\/xf>/g;
  let index = 0;
  let xf: RegExpExecArray | null;
  while ((xf = xfRe.exec(cellXfs)) !== null) {
    const id = /numFmtId="(\d+)"/.exec(xf[0])?.[1];
    if (id !== undefined && dateFormatIds.has(Number(id))) styles.add(index);
    index += 1;
  }
  return styles;
}

export interface SheetGrid {
  rows: string[][];
  /** Benar bila ada sel berformula yang tidak menyimpan nilai hasil hitung. */
  formulaWithoutValue: boolean;
}

/**
 * Mengurai satu lembar menjadi kisi teks.
 *
 * Sel yang KOSONG di tengah baris tetap menghasilkan kolom kosong pada posisinya: Excel
 * menghilangkan sel kosong dari XML, dan mengabaikannya akan menggeser seluruh kolom di
 * kanannya — data yang tampak benar tetapi salah kolom.
 */
export function parseSheet(
  sheetXml: string,
  sharedStrings: string[],
  dateStyles: Set<number>,
): SheetGrid {
  const rows: string[][] = [];
  let formulaWithoutValue = false;

  const rowRe = /<row(?:\s[^>]*)?>([\s\S]*?)<\/row>|<row\s[^>]*\/>/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(sheetXml)) !== null) {
    const inner = rowMatch[1] ?? '';
    const cells: string[] = [];

    const cellRe = /<c(\s[^>]*)?(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(inner)) !== null) {
      const attrs = cellMatch[1] ?? '';
      const body = cellMatch[2] ?? '';
      const ref = /r="([A-Z]+\d+)"/i.exec(attrs)?.[1];
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
      const styleIndex = Number(/s="(\d+)"/.exec(attrs)?.[1] ?? NaN);

      const at = ref ? columnIndex(ref) : cells.length;
      while (cells.length < at) cells.push('');

      let value = '';
      if (type === 'inlineStr') {
        value = collectSharedString(body);
      } else {
        const raw = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (raw === undefined) {
          // Sel berformula tanpa `<v>`: Excel biasanya menyimpan hasil hitungnya, tetapi
          // sebagian generator tidak. Dicatat supaya dapat dikatakan, bukan diam-diam
          // menghasilkan kolom kosong.
          if (/<f[\s>]/.test(body)) formulaWithoutValue = true;
        } else if (type === 's') {
          value = sharedStrings[Number(decodeXmlText(raw))] ?? '';
        } else if (type === 'b') {
          value = decodeXmlText(raw) === '1' ? 'true' : 'false';
        } else if (type === 'e') {
          // Sel error (#N/A, #DIV/0!) dipertahankan apa adanya: Data Quality Center wajib
          // dapat melaporkannya, dan mengubahnya menjadi kosong menghapus buktinya.
          value = decodeXmlText(raw);
        } else {
          const text = decodeXmlText(raw);
          const numeric = Number(text);
          value =
            Number.isFinite(numeric) && Number.isFinite(styleIndex) && dateStyles.has(styleIndex)
              ? serialToIso(numeric)
              : text;
        }
      }
      cells.push(value);
    }
    rows.push(cells);
  }

  return { rows, formulaWithoutValue };
}

/* ================= Berkas ================= */

/** Nama entri lembar pertama menurut urutan di `workbook.xml`, bukan urutan berkas di ZIP. */
function firstSheetPath(workbookXml: string, relsXml: string, names: string[]): string {
  const firstRid = /<sheet\s[^>]*r:id="([^"]+)"/.exec(workbookXml)?.[1];
  if (firstRid) {
    const target = new RegExp(`<Relationship[^>]*Id="${firstRid}"[^>]*Target="([^"]+)"`).exec(relsXml)?.[1];
    if (target) {
      const clean = target.replace(/^\/?(xl\/)?/, '');
      const candidate = `xl/${clean}`;
      if (names.includes(candidate)) return candidate;
    }
  }
  // Cadangan: lembar bernomor terkecil. Urutan entri ZIP tidak dijamin, jadi diurutkan.
  const sheets = names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
  if (sheets.length === 0) throw new ValidationError('error.xlsx_no_worksheet');
  return sheets[0]!;
}

/**
 * Membaca lembar PERTAMA sebuah berkas XLSX menjadi kisi teks.
 *
 * Hasilnya sengaja berupa teks, bukan tipe yang sudah ditebak: deteksi tipe kolom sudah ada
 * di jalur CSV dan telah teruji. Menduplikasinya di sini berarti dua tempat yang harus
 * sepakat — dan diam-diam menyimpang.
 */
export function readXlsxGrid(buffer: Buffer): SheetGrid {
  if (buffer.length < 22 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new ValidationError('error.upload_corrupt_file', { hint: 'not_zip' });
  }

  const entries = readCentralDirectory(buffer);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const names = entries.map((e) => e.name);

  // Penanda berkas Excel yang diproteksi kata sandi: isinya arsip OLE, bukan XML.
  if (byName.has('EncryptedPackage')) throw new ValidationError('error.xlsx_encrypted');

  const workbook = byName.get('xl/workbook.xml');
  if (!workbook) throw new ValidationError('error.upload_corrupt_file', { hint: 'no_workbook' });

  const workbookXml = readEntry(buffer, workbook);
  const relsEntry = byName.get('xl/_rels/workbook.xml.rels');
  const relsXml = relsEntry ? readEntry(buffer, relsEntry) : '';
  const sheetPath = firstSheetPath(workbookXml, relsXml, names);

  const sheetEntry = byName.get(sheetPath);
  if (!sheetEntry) throw new ValidationError('error.xlsx_no_worksheet');

  const sharedEntry = byName.get('xl/sharedStrings.xml');
  const sharedStrings = sharedEntry ? parseSharedStrings(readEntry(buffer, sharedEntry)) : [];
  const stylesEntry = byName.get('xl/styles.xml');
  const dateStyles = stylesEntry ? parseDateStyles(readEntry(buffer, stylesEntry)) : new Set<number>();

  return parseSheet(readEntry(buffer, sheetEntry), sharedStrings, dateStyles);
}

/**
 * XLSX → CSV, supaya jalur dataset yang sudah ada dipakai apa adanya.
 *
 * Sengaja melewati CSV alih-alih memanggil pembentuk dataset langsung: deteksi tipe,
 * penanganan sel kosong, dan batas jumlah baris sudah teruji di sana, dan satu jalur yang
 * sama untuk kedua bentuk berkas berarti tidak ada perilaku yang hanya benar di salah
 * satunya.
 */
export function xlsxToCsv(buffer: Buffer): string {
  const grid = readXlsxGrid(buffer);
  const rows = grid.rows.filter((r) => r.some((c) => c !== ''));
  if (rows.length === 0) throw new ValidationError('error.xlsx_empty_sheet');
  if (grid.formulaWithoutValue && rows.length === 1) {
    // Hanya baris judul yang terbaca, dan ada formula tanpa nilai tersimpan: berkasnya
    // memang tidak memuat hasil hitung. Mengatakannya lebih berguna daripada menghasilkan
    // dataset berisi judul saja.
    throw new ValidationError('error.xlsx_no_cached_values');
  }

  const width = Math.max(...rows.map((r) => r.length));
  return rows
    .map((row) => {
      const padded = [...row];
      while (padded.length < width) padded.push('');
      return padded
        .map((cell) => (/[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
        .join(',');
    })
    .join('\n');
}
