/**
 * Pembaca XLSX.
 *
 * Uji ini membangun berkas XLSX **sungguhan** — arsip ZIP berisi XML dengan bentuk yang
 * dihasilkan Excel — lalu membacanya kembali. Bukan mock: yang perlu dibuktikan justru
 * bahwa bentuk berkas nyata terbaca benar, dan mock hanya akan membuktikan bahwa uji ini
 * sepakat dengan dirinya sendiri.
 *
 * Lima hal yang paling mudah salah tanpa terlihat:
 *
 *  1. **Sel kosong menggeser kolom** (TC-XLS-04). Excel menghilangkan sel kosong dari XML;
 *     mengabaikannya membuat seluruh kolom di kanannya bergeser — data tampak benar tetapi
 *     berada di kolom yang salah.
 *  2. **Tanggal meleset dua hari** (TC-XLS-05). Epoch Excel adalah 1899-12-30 karena bug
 *     tahun kabisat Lotus 1-2-3; memakai epoch "yang benar" menggeser seluruh tanggal.
 *  3. **Formula terbaca sebagai rumus, bukan hasilnya** (TC-XLS-07).
 *  4. **Berkas terenkripsi dikira rusak** (TC-XLS-10), sehingga pengguna tidak tahu bahwa
 *     yang perlu ia lakukan adalah membuka proteksinya.
 *  5. **Zip bomb** (TC-XLS-12): arsip kecil yang membongkar menjadi ratusan megabyte.
 */
import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import {
  columnIndex,
  decodeXmlText,
  parseDateStyles,
  parseSharedStrings,
  readXlsxGrid,
  serialToIso,
  xlsxToCsv,
} from '../src/data-platform-service/xlsx.ts';
import { ValidationError } from '../src/platform/errors.ts';

/* ================= Pembangun XLSX ================= */

interface ZipFile {
  name: string;
  content: string;
  /** Ukuran yang DIAKUI di central directory; untuk menguji penjagaan zip bomb. */
  declaredSize?: number;
  encrypted?: boolean;
}

/** Membangun arsip ZIP sungguhan, lengkap dengan central directory. */
function buildZip(files: ZipFile[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const raw = Buffer.from(file.content, 'utf8');
    const deflated = deflateRawSync(raw);
    const flags = file.encrypted ? 0x0001 : 0;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x0403_4b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 14); // crc; tidak diperiksa pembaca
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, deflated);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x0201_4b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(file.declaredSize ?? raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + deflated.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x0605_4b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

const WORKBOOK = `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const RELS = `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;

/** Gaya: indeks 0 = umum, indeks 1 = tanggal bawaan (numFmtId 14). */
const STYLES = `<?xml version="1.0"?><styleSheet><cellXfs count="2"><xf numFmtId="0" xfId="0"/><xf numFmtId="14" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`;

function xlsx(sheetXml: string, shared: string[] = [], styles = STYLES): Buffer {
  const files: ZipFile[] = [
    { name: 'xl/workbook.xml', content: WORKBOOK },
    { name: 'xl/_rels/workbook.xml.rels', content: RELS },
    { name: 'xl/worksheets/sheet1.xml', content: `<?xml version="1.0"?><worksheet><sheetData>${sheetXml}</sheetData></worksheet>` },
    { name: 'xl/styles.xml', content: styles },
  ];
  if (shared.length > 0) {
    files.push({
      name: 'xl/sharedStrings.xml',
      content: `<?xml version="1.0"?><sst count="${shared.length}">${shared.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`,
    });
  }
  return buildZip(files);
}

/* ================= Bagian kecil ================= */

describe('Pembacaan bagian XLSX', () => {
  it('TC-XLS-01 — rujukan kolom diurai, termasuk dua huruf', () => {
    expect(columnIndex('A1')).toBe(0);
    expect(columnIndex('B2')).toBe(1);
    expect(columnIndex('Z9')).toBe(25);
    expect(columnIndex('AA1')).toBe(26);
    expect(columnIndex('AB7')).toBe(27);
  });

  it('TC-XLS-02 — entitas XML diurai, termasuk rujukan numerik', () => {
    expect(decodeXmlText('PT Maju &amp; Jaya')).toBe('PT Maju & Jaya');
    expect(decodeXmlText('&lt;tag&gt; &quot;kutip&quot; &apos;apos&apos;')).toBe('<tag> "kutip" \'apos\'');
    expect(decodeXmlText('&#82;&#x70;')).toBe('Rp');
  });

  it('TC-XLS-03 — string bersama: teks bergaya digabung, furigana diabaikan', () => {
    // Teks bergaya dipecah menjadi beberapa <t>; menggabungkannya salah akan memotong kata.
    const xml = `<sst><si><r><t>Total </t></r><r><t>Penjualan</t></r></si><si><t>Tokyo</t><rPh sb="0" eb="2"><t>とうきょう</t></rPh></si></sst>`;
    expect(parseSharedStrings(xml)).toEqual(['Total Penjualan', 'Tokyo']);
  });
});

/* ================= Kisi ================= */

describe('Pembacaan lembar', () => {
  it('TC-XLS-04 — sel kosong di tengah baris TIDAK menggeser kolom', () => {
    // Excel menghilangkan sel kosong dari XML. Baris kedua melompat dari A ke C.
    const sheet = `
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
      <row r="2"><c r="A2"><v>10</v></c><c r="C2"><v>30</v></c></row>`;
    const grid = readXlsxGrid(xlsx(sheet, ['wilayah', 'kuartal', 'nilai']));

    expect(grid.rows[0]).toEqual(['wilayah', 'kuartal', 'nilai']);
    // Nilai 30 HARUS berada di kolom ketiga, bukan kedua.
    expect(grid.rows[1]).toEqual(['10', '', '30']);
  });

  it('TC-XLS-05 — tanggal serial memakai epoch Excel 1899-12-30', () => {
    expect(serialToIso(45_672)).toBe('2025-01-15');
    // Batas bawah, tempat bug tahun kabisat 1900 menggigit: serial 1 adalah 1 Januari 1900,
    // dan rumus baku tanpa penyesuaian menghasilkan 31 Desember 1899.
    expect(serialToIso(1)).toBe('1900-01-01');
    expect(serialToIso(59)).toBe('1900-02-28');
    // Serial 60 adalah 29 Februari 1900 menurut Excel — hari yang tidak pernah ada.
    expect(serialToIso(60)).toBe('1900-02-28');
    expect(serialToIso(61)).toBe('1900-03-01');

    const sheet = `<row r="1"><c r="A1" s="1"><v>45672</v></c><c r="B1"><v>45672</v></c></row>`;
    const grid = readXlsxGrid(xlsx(sheet));
    // Kolom A bergaya tanggal → ISO. Kolom B tidak → tetap angka.
    expect(grid.rows[0]).toEqual(['2025-01-15', '45672']);
  });

  it('TC-XLS-06 — format tanggal KUSTOM juga dikenali', () => {
    const styles = `<styleSheet><numFmts><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="#,##0.00"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>`;
    const sheet = `<row r="1"><c r="A1" s="1"><v>45672</v></c><c r="B1" s="2"><v>45672</v></c></row>`;
    const grid = readXlsxGrid(xlsx(sheet, [], styles));

    expect(grid.rows[0]![0]).toBe('2025-01-15');
    // Format angka bukan tanggal, betapa pun mirip nomornya.
    expect(grid.rows[0]![1]).toBe('45672');
  });

  it('TC-XLS-07 — formula dibaca NILAI hasilnya, bukan rumusnya', () => {
    const sheet = `<row r="1"><c r="A1"><f>SUM(B1:C1)</f><v>150</v></c></row>`;
    const grid = readXlsxGrid(xlsx(sheet));

    expect(grid.rows[0]).toEqual(['150']);
    expect(grid.formulaWithoutValue).toBe(false);
  });

  it('TC-XLS-08 — formula TANPA nilai tersimpan ditandai, bukan diam-diam kosong', () => {
    const sheet = `<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2"><f>SUM(B:B)</f></c></row>`;
    const grid = readXlsxGrid(xlsx(sheet, ['jumlah']));

    expect(grid.formulaWithoutValue).toBe(true);
  });

  it('TC-XLS-09 — string inline, boolean, dan sel error terbaca', () => {
    const sheet = `<row r="1">
      <c r="A1" t="inlineStr"><is><t>Langsung</t></is></c>
      <c r="B1" t="b"><v>1</v></c>
      <c r="C1" t="b"><v>0</v></c>
      <c r="D1" t="e"><v>#N/A</v></c>
    </row>`;
    const grid = readXlsxGrid(xlsx(sheet));

    // Sel error dipertahankan: Data Quality Center wajib dapat melaporkannya, dan
    // mengubahnya menjadi kosong menghapus buktinya.
    expect(grid.rows[0]).toEqual(['Langsung', 'true', 'false', '#N/A']);
  });
});

/* ================= Penolakan yang jelas ================= */

describe('Berkas yang tidak dapat dibaca', () => {
  it('TC-XLS-10 — berkas terenkripsi dikatakan terenkripsi, bukan rusak', () => {
    const buffer = buildZip([{ name: 'xl/workbook.xml', content: WORKBOOK, encrypted: true }]);
    // Pengguna perlu tahu bahwa yang harus ia lakukan adalah membuka proteksinya.
    expect(() => readXlsxGrid(buffer)).toThrow(ValidationError);
    try {
      readXlsxGrid(buffer);
    } catch (e) {
      expect((e as ValidationError).messageKey).toBe('error.xlsx_encrypted');
    }
  });

  it('TC-XLS-10b — paket OOXML terproteksi kata sandi juga dikenali', () => {
    const buffer = buildZip([{ name: 'EncryptedPackage', content: 'biner' }]);
    try {
      readXlsxGrid(buffer);
      throw new Error('seharusnya ditolak');
    } catch (e) {
      expect((e as ValidationError).messageKey).toBe('error.xlsx_encrypted');
    }
  });

  it('TC-XLS-11 — berkas yang bukan ZIP ditolak sebagai berkas rusak', () => {
    try {
      readXlsxGrid(Buffer.from('ini bukan xlsx sama sekali, hanya teks biasa'));
      throw new Error('seharusnya ditolak');
    } catch (e) {
      expect((e as ValidationError).messageKey).toBe('error.upload_corrupt_file');
    }
  });

  it('TC-XLS-12 — entri yang mengaku sangat besar ditolak sebelum dibongkar', () => {
    // Zip bomb: arsip beberapa kilobyte yang mengaku membongkar menjadi 1 GB.
    const buffer = buildZip([
      { name: 'xl/workbook.xml', content: WORKBOOK, declaredSize: 1_000_000_000 },
    ]);
    try {
      readXlsxGrid(buffer);
      throw new Error('seharusnya ditolak');
    } catch (e) {
      expect((e as ValidationError).messageKey).toBe('error.upload_too_large');
    }
  });

  it('TC-XLS-13 — arsip tanpa lembar kerja ditolak dengan alasannya', () => {
    const buffer = buildZip([
      { name: 'xl/workbook.xml', content: `<workbook><sheets/></workbook>` },
      { name: 'xl/_rels/workbook.xml.rels', content: `<Relationships/>` },
    ]);
    try {
      readXlsxGrid(buffer);
      throw new Error('seharusnya ditolak');
    } catch (e) {
      expect((e as ValidationError).messageKey).toBe('error.xlsx_no_worksheet');
    }
  });
});

/* ================= Menjadi CSV ================= */

describe('XLSX menjadi CSV', () => {
  it('TC-XLS-14 — kisi menjadi CSV yang dapat dibaca jalur dataset', () => {
    const sheet = `
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
      <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1500</v></c></row>`;
    const csv = xlsxToCsv(xlsx(sheet, ['wilayah', 'nilai', 'Jakarta']));

    expect(csv).toBe('wilayah,nilai\nJakarta,1500');
  });

  it('TC-XLS-15 — koma dan tanda kutip di dalam sel dikutip dengan benar', () => {
    const sheet = `
      <row r="1"><c r="A1" t="s"><v>0</v></c></row>
      <row r="2"><c r="A2" t="s"><v>1</v></c></row>
      <row r="3"><c r="A3" t="s"><v>2</v></c></row>`;
    // Tanpa pengutipan yang benar, satu koma di dalam sel memecah baris menjadi dua kolom.
    const csv = xlsxToCsv(xlsx(sheet, ['catatan', 'Jakarta, Indonesia', 'dia bilang "ya"']));

    expect(csv.split('\n')[1]).toBe('"Jakarta, Indonesia"');
    expect(csv.split('\n')[2]).toBe('"dia bilang ""ya"""');
  });

  it('TC-XLS-16 — baris yang seluruhnya kosong dibuang', () => {
    const sheet = `
      <row r="1"><c r="A1" t="s"><v>0</v></c></row>
      <row r="2"/>
      <row r="3"><c r="A3" t="s"><v>1</v></c></row>`;
    expect(xlsxToCsv(xlsx(sheet, ['kolom', 'isi'])).split('\n')).toEqual(['kolom', 'isi']);
  });

  it('TC-XLS-17 — baris pendek dilengkapi agar setiap baris berkolom sama', () => {
    const sheet = `
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
      <row r="2"><c r="A2" t="s"><v>3</v></c></row>`;
    const csv = xlsxToCsv(xlsx(sheet, ['a', 'b', 'c', 'isi']));

    // Baris pendek tanpa pelengkapan membuat parser CSV melihat jumlah kolom berbeda.
    expect(csv.split('\n')[1]).toBe('isi,,');
  });

  it('TC-XLS-18 — lembar kosong ditolak, bukan menghasilkan dataset kosong', () => {
    try {
      xlsxToCsv(xlsx('<row r="1"/>'));
      throw new Error('seharusnya ditolak');
    } catch (e) {
      expect((e as ValidationError).messageKey).toBe('error.xlsx_empty_sheet');
    }
  });
});
