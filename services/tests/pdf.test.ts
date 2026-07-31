/**
 * Penulis PDF.
 *
 * Yang diperiksa di sini adalah **struktur berkasnya**, bukan tampilannya: PDF yang
 * offset-nya meleset satu byte akan ditolak pembaca PDF tanpa penjelasan apa pun, dan tidak
 * ada uji tampilan yang dapat menangkap itu.
 *
 * Empat hal yang paling mudah salah:
 *
 *  1. **Tabel xref** (TC-PDF-02). Offset dihitung dari byte yang benar-benar ditulis; salah
 *     sedikit berarti berkasnya rusak.
 *  2. **Aksara non-Latin** (TC-PDF-05). Font bawaan PDF hanya mengenal Latin-1; menuliskan
 *     UTF-8 apa adanya menghasilkan karakter acak yang tampak seperti berkas rusak.
 *  3. **Kurung dan garis miring terbalik** (TC-PDF-06) punya arti khusus di dalam string
 *     PDF — tidak dilarikan berarti berkasnya rusak oleh isi laporan itu sendiri.
 *  4. **Gerbang klasifikasi** (TC-PDF-10): jalur PDF tidak boleh menjadi pintu belakang yang
 *     melewati persetujuan Data Steward.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, contextFor, provisionTenant, type Harness, type TenantFixture } from './helpers.ts';
import { ReportService } from '../src/designer-service/index.ts';
import { escapePdfText, renderPdf, toLatin1, wrapText } from '../src/designer-service/pdf.ts';
import { ConflictError } from '../src/platform/errors.ts';

let harness: Harness;
let tenant: TenantFixture;

beforeEach(() => {
  harness = createHarness();
  tenant = provisionTenant(harness, { trialDays: 30 });
});

afterEach(() => harness.cleanup());

function pdfText(bytes: Buffer): string {
  return bytes.toString('latin1');
}

/* ================= Struktur berkas ================= */

describe('Struktur PDF', () => {
  it('TC-PDF-01 — berkas berawalan tanda PDF dan berakhir dengan EOF', () => {
    const bytes = renderPdf({ title: 'Laporan Bulanan', pageSize: 'A4', orientation: 'portrait', blocks: [] });

    expect(pdfText(bytes).startsWith('%PDF-1.4')).toBe(true);
    expect(pdfText(bytes).trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('TC-PDF-02 — tabel xref menunjuk ke posisi objek yang sebenarnya', () => {
    const bytes = renderPdf({
      title: 'Uji Offset',
      pageSize: 'A4',
      orientation: 'portrait',
      blocks: [{ type: 'text', content: 'satu' }],
    });
    const text = pdfText(bytes);

    // startxref harus menunjuk ke kata "xref".
    const startxref = Number(/startxref\s+(\d+)/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');

    // Setiap offset di tabel harus mendarat tepat di awal objeknya.
    const entries = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(entries.length).toBeGreaterThan(4);
    entries.forEach((offset, index) => {
      expect(text.slice(offset, offset + `${index + 1} 0 obj`.length)).toBe(`${index + 1} 0 obj`);
    });
  });

  it('TC-PDF-03 — ukuran halaman dan orientasi diterapkan', () => {
    const potret = pdfText(renderPdf({ title: 'P', pageSize: 'A4', orientation: 'portrait', blocks: [] }));
    expect(potret).toContain('/MediaBox [0 0 595.28 841.89]');

    const lanskap = pdfText(renderPdf({ title: 'L', pageSize: 'A4', orientation: 'landscape', blocks: [] }));
    expect(lanskap).toContain('/MediaBox [0 0 841.89 595.28]');

    // Ukuran yang tidak dikenal jatuh ke A4 alih-alih menghasilkan halaman berukuran NaN.
    const asing = pdfText(renderPdf({ title: 'X', pageSize: 'Foolscap', orientation: 'portrait', blocks: [] }));
    expect(asing).toContain('/MediaBox [0 0 595.28 841.89]');
  });

  it('TC-PDF-04 — pemisah halaman menghasilkan halaman baru', () => {
    const satu = pdfText(renderPdf({ title: 'A', pageSize: 'A4', orientation: 'portrait', blocks: [] }));
    expect(/\/Type \/Pages \/Count 1/.test(satu)).toBe(true);

    const dua = pdfText(
      renderPdf({
        title: 'A',
        pageSize: 'A4',
        orientation: 'portrait',
        blocks: [{ type: 'text', content: 'awal' }, { type: 'pagebreak' }, { type: 'text', content: 'akhir' }],
      }),
    );
    expect(/\/Type \/Pages \/Count 2/.test(dua)).toBe(true);
  });
});

/* ================= Teks ================= */

describe('Penanganan teks', () => {
  it('TC-PDF-05 — aksara di luar Latin-1 dibuang, bukan dijadikan karakter acak', () => {
    // Font bawaan PDF tidak mengenalnya; menuliskannya apa adanya membuat berkas tampak rusak.
    expect(toLatin1('Laporan 日本語 Bulanan')).toBe('Laporan  Bulanan');
    // Tanda baca tipografis dipetakan ke padanan ASCII lebih dulu, karena inilah yang paling
    // sering muncul di teks yang disalin dari Word.
    expect(toLatin1('“kutip” — tanda…')).toBe('"kutip" - tanda...');
    // Huruf beraksen Latin-1 TETAP ada.
    expect(toLatin1('Café Ekonomi')).toBe('Café Ekonomi');
  });

  it('TC-PDF-06 — kurung dan garis miring terbalik dilarikan', () => {
    // Tidak dilarikan berarti isi laporan sendiri yang merusak berkasnya.
    expect(escapePdfText('Laba (bersih) \\ pajak')).toBe('Laba \\(bersih\\) \\\\ pajak');
  });

  it('TC-PDF-07 — paragraf panjang dipecah menjadi beberapa baris', () => {
    const lines = wrapText('kata '.repeat(60).trim(), 10, 200);
    expect(lines.length).toBeGreaterThan(1);
    // Baris kosong pada paragraf kosong dipertahankan, supaya jarak antarparagraf tetap ada.
    expect(wrapText('satu\n\ndua', 10, 400)).toEqual(['satu', '', 'dua']);
  });

  it('TC-PDF-08 — isi laporan benar-benar muncul di aliran halaman', () => {
    const bytes = renderPdf({
      title: 'Kinerja Triwulan',
      pageSize: 'A4',
      orientation: 'portrait',
      watermark: 'RAHASIA',
      footer: 'Dibuat dengan Vantik Analytics',
      blocks: [
        { type: 'heading', content: 'Ringkasan' },
        { type: 'text', content: 'Pendapatan naik dibanding triwulan lalu.' },
        { type: 'table', config: { headers: ['Wilayah', 'Nilai'], rows: [['Jakarta', 1500], ['Bandung', 900]] } },
      ],
    });
    const text = pdfText(bytes);

    expect(text).toContain('(Kinerja Triwulan) Tj');
    expect(text).toContain('(Ringkasan) Tj');
    expect(text).toContain('(Jakarta) Tj');
    expect(text).toContain('(1500) Tj');
    expect(text).toContain('(RAHASIA) Tj');
    expect(text).toContain('(Dibuat dengan Vantik Analytics) Tj');
  });

  it('TC-PDF-09 — blok grafik menjadi kotak jujur, bukan halaman yang kehilangan isi', () => {
    const text = pdfText(
      renderPdf({
        title: 'A',
        pageSize: 'A4',
        orientation: 'portrait',
        blocks: [{ type: 'chart', content: 'Tren Penjualan' }],
      }),
    );

    expect(text).toContain('(Tren Penjualan) Tj');
    expect(text).toContain('Grafik ditampilkan pada versi layar');
  });
});

/* ================= Gerbang ================= */

describe('Gerbang ekspor', () => {
  function reports(roles: Array<'super_admin' | 'business_analyst'> = ['super_admin']): ReportService {
    return new ReportService(contextFor(harness, tenant.tenantId, roles, { mfaEnrolled: true }));
  }

  it('TC-PDF-10 — laporan restricted TIDAK dapat diekspor tanpa persetujuan steward', () => {
    // Sengaja Business Analyst, bukan Super Admin: yang terakhir memegang `*:*` sehingga
    // ikut memegang `export:approve_restricted` dan memang boleh. Yang perlu dibuktikan
    // adalah bahwa peran TANPA wewenang itu tetap tertahan di jalur PDF.
    const service = reports(['business_analyst']);
    const report = service.create({ name: 'Rencana Akuisisi', classification: 'restricted' } as never);
    expect(contextFor(harness, tenant.tenantId, ['business_analyst']).can('export:approve_restricted')).toBe(false);

    // Jalur PDF memakai renderDocument() yang sama, jadi gerbangnya berlaku persis sama —
    // rute baru tidak boleh menjadi pintu belakang yang tampak seperti fitur.
    expect(() => service.renderPdfDocument(report.id)).toThrow(ConflictError);
  });

  it('TC-PDF-11 — laporan biasa menghasilkan berkas dengan nama yang aman', () => {
    const service = reports();
    const report = service.create({ name: 'Laporan / Bulanan: Q1' } as never);

    const { filename, bytes } = service.renderPdfDocument(report.id);

    // Nama berkas tidak boleh membawa karakter lintasan atau pemisah header.
    expect(filename).toBe('Laporan-Bulanan-Q1.pdf');
    expect(filename).not.toMatch(/[/\\:"]/);
    expect(pdfText(bytes).startsWith('%PDF')).toBe(true);
  });

  it('TC-PDF-12 — ekspor PDF tercatat di Log Aktivitas', () => {
    const service = reports();
    const report = service.create({ name: 'Kinerja' } as never);
    service.renderPdfDocument(report.id);

    const entries = harness.db
      .prepare("SELECT COUNT(*) AS n FROM auditdb.audit_log WHERE tenant_id = ? AND action = 'report.export'")
      .get(tenant.tenantId) as { n: number };
    expect(entries.n).toBeGreaterThan(0);
  });
});
