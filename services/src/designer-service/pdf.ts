/**
 * Penulis PDF tanpa dependensi.
 *
 * `renderDocument()` mengembalikan struktur dokumen dan render PDF-nya diserahkan ke
 * peramban. Itu cukup selama manusia yang menekan tombol — tetapi laporan TERJADWAL tidak
 * punya peramban. Tanpa berkas di sisi server, laporan bulanan tidak dapat dilampirkan ke
 * email, dan janji "laporan dikirim otomatis" berhenti di antrean notifikasi.
 *
 * PDF adalah format **teks** dengan tabel offset di akhirnya. Dokumen yang dibutuhkan di
 * sini — judul, paragraf, tabel, tanda tangan, footer — dapat ditulis langsung tanpa pustaka
 * apa pun, dan tanpa modul native yang dapat gagal terpasang di shared hosting.
 *
 * Batas yang dinyatakan, bukan disembunyikan:
 *
 *  - **Font bawaan PDF saja** (Helvetica). Tidak ada font yang ditanam, jadi tidak ada
 *    dukungan aksara di luar Latin-1: teks Jawa, Arab, atau Tionghoa akan hilang alih-alih
 *    tampil rusak — lihat `toLatin1()`.
 *  - **Grafik tidak digambar.** Blok `chart` menjadi kotak berjudul yang menyebutkan bahwa
 *    grafiknya ada di versi layar. Menggambar grafik memerlukan mesin render, dan kotak
 *    yang jujur lebih baik daripada halaman yang diam-diam kehilangan isi.
 */

/** Ukuran halaman dalam titik (1/72 inci). */
export const PAGE_SIZES: Record<string, { width: number; height: number }> = {
  A4: { width: 595.28, height: 841.89 },
  Letter: { width: 612, height: 792 },
  Legal: { width: 612, height: 1008 },
};

const MARGIN = 56;
const LINE = 14;

export interface PdfBlock {
  type: 'heading' | 'text' | 'table' | 'chart' | 'pagebreak' | 'signature';
  content?: string;
  config?: Record<string, unknown>;
}

export interface PdfDocument {
  title: string;
  pageSize: string;
  orientation: string;
  /** Teks samar melintang di setiap halaman, mis. klasifikasi dokumen. */
  watermark?: string | null;
  blocks: PdfBlock[];
  /** Baris footer, mis. atribusi merek. */
  footer?: string;
}

/**
 * Teks ke Latin-1, aksara di luar itu DIBUANG.
 *
 * Font bawaan PDF hanya mengenal Latin-1. Menuliskan byte UTF-8 apa adanya menghasilkan
 * karakter acak yang tampak seperti kerusakan berkas; menghilangkannya membuat kekurangannya
 * terlihat sebagai kekurangan. Yang paling sering terkena adalah tanda kutip melengkung dan
 * tanda pisah panjang, jadi keduanya dipetakan ke padanan ASCII lebih dulu.
 */
export function toLatin1(text: string): string {
  const folded = text
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ');
  let out = '';
  for (const ch of folded) if (ch.codePointAt(0)! <= 0xff) out += ch;
  return out;
}

/** Melarikan karakter yang punya arti khusus di dalam string PDF. */
export function escapePdfText(text: string): string {
  return toLatin1(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Lebar teks Helvetica, diperkirakan dari lebar rata-rata.
 *
 * Cukup untuk memutuskan kapan baris harus dipatahkan. Perkiraan yang meleset sedikit hanya
 * membuat baris sedikit lebih pendek dari yang muat — tidak ada yang rusak, dan menanam
 * tabel lebar seluruh glif hanya untuk itu bukan pertukaran yang sepadan.
 */
function textWidth(text: string, size: number): number {
  return text.length * size * 0.5;
}

/** Memecah paragraf menjadi baris yang muat pada lebar tertentu. */
export function wrapText(text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of toLatin1(text).split(/\r?\n/)) {
    if (paragraph.trim() === '') {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = current ? `${current} ${word}` : word;
      if (textWidth(candidate, size) > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

/* ================= Penyusun halaman ================= */

interface PageState {
  streams: string[];
  current: string[];
  y: number;
}

class Layout {
  private readonly pages: string[] = [];
  private current: string[] = [];
  private y: number;

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly watermark: string | null,
    private readonly footer: string,
  ) {
    this.y = height - MARGIN;
    this.startPage();
  }

  private get usableWidth(): number {
    return this.width - MARGIN * 2;
  }

  private startPage(): void {
    this.y = this.height - MARGIN;
    if (this.watermark) {
      // Diagonal, abu-abu terang, DI BAWAH isi: tanda air yang menutupi teks membuat
      // laporan sulit dibaca, dan yang dibutuhkan hanyalah penanda klasifikasi.
      const text = escapePdfText(this.watermark);
      this.current.push(
        'q 0.85 0.85 0.85 rg BT /F1 52 Tf 0.7071 0.7071 -0.7071 0.7071 ' +
          `${(this.width / 2 - 180).toFixed(2)} ${(this.height / 2 - 260).toFixed(2)} Tm (${text}) Tj ET Q`,
      );
    }
  }

  /** Menyiapkan ruang untuk `needed` titik; membuka halaman baru bila tidak cukup. */
  private ensure(needed: number): void {
    if (this.y - needed >= MARGIN + LINE) return;
    this.endPage();
    this.current = [];
    this.startPage();
  }

  private endPage(): void {
    if (this.footer) {
      const text = escapePdfText(this.footer);
      this.current.push(
        `q 0.45 0.45 0.45 rg BT /F1 8 Tf ${MARGIN} ${MARGIN - 24} Td (${text}) Tj ET Q`,
      );
    }
    this.pages.push(this.current.join('\n'));
  }

  heading(text: string, level = 1): void {
    const size = level === 1 ? 18 : 14;
    this.ensure(size + 10);
    this.y -= size + 4;
    this.current.push(`BT /F2 ${size} Tf ${MARGIN} ${this.y.toFixed(2)} Td (${escapePdfText(text)}) Tj ET`);
    this.y -= 6;
  }

  paragraph(text: string): void {
    for (const line of wrapText(text, 10, this.usableWidth)) {
      this.ensure(LINE);
      this.y -= LINE;
      if (line !== '') {
        this.current.push(`BT /F1 10 Tf ${MARGIN} ${this.y.toFixed(2)} Td (${escapePdfText(line)}) Tj ET`);
      }
    }
    this.y -= 4;
  }

  /**
   * Tabel dengan lebar kolom merata dan garis di bawah judul.
   *
   * Baris judul DIULANG pada setiap halaman baru: tabel yang menyeberang halaman tanpa judul
   * memaksa pembaca membalik halaman untuk tahu kolom mana yang sedang ia baca.
   */
  table(headers: string[], rows: string[][]): void {
    if (headers.length === 0) return;
    const columnWidth = this.usableWidth / headers.length;

    const drawHeader = (): void => {
      this.ensure(LINE * 2);
      this.y -= LINE;
      headers.forEach((h, i) => {
        const x = MARGIN + i * columnWidth;
        this.current.push(`BT /F2 9 Tf ${x.toFixed(2)} ${this.y.toFixed(2)} Td (${escapePdfText(h)}) Tj ET`);
      });
      this.y -= 4;
      this.current.push(
        `q 0.7 0.7 0.7 RG 0.5 w ${MARGIN} ${this.y.toFixed(2)} m ${(this.width - MARGIN).toFixed(2)} ${this.y.toFixed(2)} l S Q`,
      );
    };

    drawHeader();
    for (const row of rows) {
      const before = this.y;
      this.ensure(LINE);
      if (this.y > before) drawHeader(); // halaman baru dibuka: ulangi judulnya
      this.y -= LINE;
      row.slice(0, headers.length).forEach((cell, i) => {
        const x = MARGIN + i * columnWidth;
        const fitted = wrapText(cell, 9, columnWidth - 6)[0] ?? '';
        this.current.push(`BT /F1 9 Tf ${x.toFixed(2)} ${this.y.toFixed(2)} Td (${escapePdfText(fitted)}) Tj ET`);
      });
    }
    this.y -= 8;
  }

  /** Kotak berjudul untuk blok yang tidak digambar di PDF. */
  placeholder(title: string, note: string): void {
    this.ensure(72);
    this.y -= 66;
    this.current.push(
      `q 0.85 0.85 0.85 RG 0.5 w ${MARGIN} ${this.y.toFixed(2)} ${this.usableWidth.toFixed(2)} 60 re S Q`,
    );
    this.current.push(`BT /F2 10 Tf ${MARGIN + 10} ${(this.y + 38).toFixed(2)} Td (${escapePdfText(title)}) Tj ET`);
    this.current.push(`q 0.45 0.45 0.45 rg BT /F1 9 Tf ${MARGIN + 10} ${(this.y + 20).toFixed(2)} Td (${escapePdfText(note)}) Tj ET Q`);
    this.y -= 8;
  }

  pageBreak(): void {
    this.endPage();
    this.current = [];
    this.startPage();
  }

  finish(): string[] {
    this.endPage();
    return this.pages;
  }
}

/* ================= Perakitan berkas ================= */

/**
 * Menyusun berkas PDF dari daftar aliran halaman.
 *
 * Tabel xref di akhir berkas memuat offset byte setiap objek. Offset yang meleset satu byte
 * membuat berkasnya ditolak pembaca PDF — jadi offset dihitung dari byte yang benar-benar
 * ditulis, bukan dari perkiraan panjang.
 */
function assemble(pages: string[], width: number, height: number, title: string): Buffer {
  const objects: string[] = [];
  const pageCount = Math.max(1, pages.length);

  // 1 = katalog, 2 = pohon halaman, 3..(2+n) = halaman, lalu aliran isinya, lalu dua font.
  const firstPageObj = 3;
  const firstContentObj = firstPageObj + pageCount;
  const fontRegular = firstContentObj + pageCount;
  const fontBold = fontRegular + 1;

  objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);
  const kids = Array.from({ length: pageCount }, (_, i) => `${firstPageObj + i} 0 R`).join(' ');
  objects.push(`<< /Type /Pages /Count ${pageCount} /Kids [${kids}] >>`);

  for (let i = 0; i < pageCount; i++) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width.toFixed(2)} ${height.toFixed(2)}] ` +
        `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> ` +
        `/Contents ${firstContentObj + i} 0 R >>`,
    );
  }
  for (let i = 0; i < pageCount; i++) {
    const stream = pages[i] ?? '';
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  }
  objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
  objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`);
  objects.push(`<< /Title (${escapePdfText(title)}) /Producer (Vantik Analytics) >>`);

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let offset = chunks[0]!.length;
  const offsets: number[] = [];

  objects.forEach((body, index) => {
    offsets.push(offset);
    const chunk = Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, 'latin1');
    chunks.push(chunk);
    offset += chunk.length;
  });

  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const value of offsets) xref += `${String(value).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));

  return Buffer.concat(chunks);
}

/**
 * Dokumen laporan menjadi berkas PDF.
 *
 * Nilai baliknya `Buffer`, bukan berkas di disk: laporan terjadwal melampirkannya ke email,
 * dan menulis berkas sementara di shared hosting berarti sampah yang tidak ada yang
 * membersihkan.
 */
export function renderPdf(doc: PdfDocument): Buffer {
  const base = PAGE_SIZES[doc.pageSize] ?? PAGE_SIZES.A4!;
  const landscape = doc.orientation === 'landscape';
  const width = landscape ? base.height : base.width;
  const height = landscape ? base.width : base.height;

  const layout = new Layout(width, height, doc.watermark ?? null, doc.footer ?? '');
  layout.heading(doc.title, 1);

  for (const block of doc.blocks) {
    switch (block.type) {
      case 'heading':
        layout.heading(block.content ?? '', 2);
        break;
      case 'text':
        layout.paragraph(block.content ?? '');
        break;
      case 'table': {
        const config = block.config ?? {};
        const headers = Array.isArray(config.headers) ? (config.headers as unknown[]).map(String) : [];
        const rawRows = Array.isArray(config.rows) ? (config.rows as unknown[]) : [];
        const rows = rawRows.map((r) => (Array.isArray(r) ? r.map((c) => (c === null || c === undefined ? '' : String(c))) : []));
        if (headers.length > 0) layout.table(headers, rows);
        else layout.placeholder(block.content ?? 'Tabel', 'Tabel ini tidak memuat kolom.');
        break;
      }
      case 'chart':
        // Kotak jujur alih-alih halaman yang diam-diam kehilangan isinya.
        layout.placeholder(block.content ?? 'Grafik', 'Grafik ditampilkan pada versi layar laporan ini.');
        break;
      case 'signature':
        layout.heading('Tanda tangan', 2);
        layout.paragraph(block.content ?? '');
        break;
      case 'pagebreak':
        layout.pageBreak();
        break;
    }
  }

  return assemble(layout.finish(), width, height, doc.title);
}
