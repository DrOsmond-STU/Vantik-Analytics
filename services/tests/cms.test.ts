/**
 * CMS — konten halaman publik dan katalog paket.
 *
 * Yang dibuktikan di sini adalah hal-hal yang "berfungsi" tanpa melempar kesalahan
 * apa pun bila salah — kelas kegagalan paling mahal untuk fitur seperti ini:
 *
 *  1. **Kuota yang disunting benar-benar BERLAKU**, bukan sekadar tampil di halaman
 *     depan. Katalog yang dapat disunting tetapi tidak mengubah hak akses adalah
 *     kebohongan diam-diam: operator menurunkan kuota, layar mengatakan berhasil,
 *     dan pelanggan tetap memakai kuota lama tanpa ada yang tahu.
 *  2. **Daftar-izin kunci konten ditegakkan**, sehingga CMS tidak dapat dipakai
 *     menimpa label tombol atau nama modul yang menurut BRAND.md tidak diterjemahkan.
 *  3. **Mengosongkan nilai berarti kembali ke bawaan**, bukan halaman depan kosong.
 *  4. **Paket yang masih dipakai langganan tidak dapat dihapus** — hak akses pelanggan
 *     berjalan tidak boleh menjadi tidak terhitung karena satu baris katalog dibuang.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, provisionTenant, type Harness } from './helpers.ts';
import {
  allContentOverrides,
  catalogForEditing,
  contentOverrides,
  deletePlan,
  setContent,
  upsertPlan,
} from '../src/cms-service/index.ts';
import { resolveCatalog, resolvePlan } from '../src/platform/planCatalog.ts';
import { loadFeatureFlags } from '../src/platform/context.ts';
import { PLAN_CATALOG } from '../src/platform/featureFlags.ts';

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});
afterEach(() => harness.cleanup());

describe('TC-CMS-01 konten halaman publik', () => {
  it('menyimpan penimpaan dan hanya mengembalikan yang disunting', () => {
    expect(contentOverrides(harness.db, 'id')).toEqual({});

    setContent(harness.db, 'ui.landing_headline', 'id', 'Judul baru', 'usr_1');

    expect(contentOverrides(harness.db, 'id')).toEqual({ 'ui.landing_headline': 'Judul baru' });
    // Bahasa lain TIDAK ikut berubah: menyunting satu bahasa bukan berarti
    // menerjemahkannya untuk bahasa yang lain.
    expect(contentOverrides(harness.db, 'en')).toEqual({});
  });

  it('menolak kunci di luar daftar-izin', () => {
    // `action.login` adalah label tombol yang diandalkan pengujian antarmuka.
    expect(() => setContent(harness.db, 'action.login', 'id', 'Masuk!!!', 'usr_1')).toThrow();
    expect(() => setContent(harness.db, 'ui.landing_headline', 'de', 'Hallo', 'usr_1')).toThrow();
  });

  it('mengosongkan nilai mengembalikan ke bawaan, bukan menyisakan teks kosong', () => {
    setContent(harness.db, 'ui.landing_sub', 'id', 'Sementara', 'usr_1');
    expect(contentOverrides(harness.db, 'id')['ui.landing_sub']).toBe('Sementara');

    setContent(harness.db, 'ui.landing_sub', 'id', '   ', 'usr_1');

    // Barisnya HILANG, bukan tersimpan sebagai string kosong — kalau tersimpan,
    // halaman depan akan menampilkan ruang kosong dan operator tidak punya salinan
    // teks aslinya untuk mengetik ulang.
    expect(contentOverrides(harness.db, 'id')['ui.landing_sub']).toBeUndefined();
  });

  it('menyajikan kedua bahasa terpisah untuk antarmuka penyuntingan', () => {
    setContent(harness.db, 'ui.landing_headline', 'id', 'Judul', 'usr_1');
    setContent(harness.db, 'ui.landing_headline', 'en', 'Headline', 'usr_1');
    expect(allContentOverrides(harness.db)).toEqual({
      id: { 'ui.landing_headline': 'Judul' },
      en: { 'ui.landing_headline': 'Headline' },
    });
  });
});

describe('TC-CMS-02 katalog paket', () => {
  it('tabel kosong berarti memakai katalog bawaan', () => {
    const resolved = resolveCatalog(harness.db);
    expect(resolved.map((p) => p.code)).toEqual(PLAN_CATALOG.map((p) => p.code));
  });

  it('baris basis data menimpa harga tanpa menghapus paket lain', () => {
    upsertPlan(
      harness.db,
      {
        code: 'professional',
        name: 'Professional',
        monthlyPrice: 7_000_000,
        annualPrice: 70_000_000,
        quotas: { users: 250 },
        modules: ['executive_cockpit', 'dataset'],
        sortOrder: 2,
      },
      'usr_1',
    );

    const resolved = resolveCatalog(harness.db);
    expect(resolved.find((p) => p.code === 'professional')!.monthlyPrice).toBe(7_000_000);
    // Tiga paket bawaan tetap ada: menambah satu penimpaan bukan berarti mengganti
    // seluruh katalog.
    expect(resolved.map((p) => p.code)).toContain('starter');
    expect(resolved.map((p) => p.code)).toContain('enterprise');
  });

  it('paket baru dapat ditambahkan dan langsung dapat dipakai mendaftar', () => {
    upsertPlan(
      harness.db,
      {
        code: 'komunitas',
        name: 'Komunitas',
        monthlyPrice: 1_000_000,
        annualPrice: 10_000_000,
        quotas: { users: 5 },
        modules: ['dataset'],
        sortOrder: 0,
      },
      'usr_1',
    );

    expect(resolvePlan(harness.db, 'komunitas')).toBeDefined();
    // Inilah yang membuat paket buatan operator bukan sekadar hiasan halaman depan:
    // provisioning memvalidasi terhadap katalog efektif yang sama.
    const fixture = provisionTenant(harness, { planCode: 'komunitas' });
    expect(fixture.tenantId).toBeTruthy();
  });

  it('paket tak-terbit hilang dari katalog publik tetapi tetap dapat dihitung', () => {
    upsertPlan(
      harness.db,
      {
        code: 'starter',
        name: 'Starter',
        monthlyPrice: 0,
        annualPrice: 0,
        quotas: { users: 10 },
        modules: ['dataset'],
        sortOrder: 1,
        published: false,
      },
      'usr_1',
    );

    expect(resolveCatalog(harness.db).map((p) => p.code)).not.toContain('starter');
    // Tetap terhitung: pelanggan yang sudah memakainya tidak boleh kehilangan hak akses
    // hanya karena paketnya berhenti dijual.
    expect(resolvePlan(harness.db, 'starter')).toBeDefined();
    expect(catalogForEditing(harness.db).find((p) => p.code === 'starter')!.published).toBe(false);
  });

  it('menolak kode dan modul yang tidak sah', () => {
    const base = { name: 'X', monthlyPrice: 0, annualPrice: 0, quotas: {}, modules: [] };
    expect(() => upsertPlan(harness.db, { ...base, code: 'Huruf Besar' }, 'usr_1')).toThrow();
    expect(() => upsertPlan(harness.db, { ...base, code: 'ok', monthlyPrice: -1 }, 'usr_1')).toThrow();
    expect(() =>
      upsertPlan(harness.db, { ...base, code: 'ok', modules: ['modul_yang_tidak_ada'] }, 'usr_1'),
    ).toThrow();
  });

  it('menolak menghapus paket yang masih dipakai langganan', () => {
    upsertPlan(
      harness.db,
      {
        code: 'terpakai',
        name: 'Terpakai',
        monthlyPrice: 100,
        annualPrice: 1_000,
        quotas: { users: 3 },
        modules: ['dataset'],
      },
      'usr_1',
    );
    provisionTenant(harness, { planCode: 'terpakai' });

    expect(() => deletePlan(harness.db, 'terpakai')).toThrow();
    // Masih ada setelah penolakan — penolakan bukan penghapusan sebagian.
    expect(resolvePlan(harness.db, 'terpakai')).toBeDefined();
  });
});

describe('TC-CMS-03 katalog tersunting benar-benar berlaku', () => {
  it('kuota dan modul yang diubah operator mengikat hak akses tenant', () => {
    upsertPlan(
      harness.db,
      {
        code: 'dibatasi',
        name: 'Dibatasi',
        monthlyPrice: 500_000,
        annualPrice: 5_000_000,
        quotas: { users: 3, datasets: 4 },
        // HANYA satu modul yang dinyalakan.
        modules: ['dataset'],
      },
      'usr_1',
    );

    const fixture = provisionTenant(harness, { planCode: 'dibatasi' });
    const flags = loadFeatureFlags(harness.db, fixture.tenantId, 'trial');

    // Inti pengujian ini: angka yang diketik operator adalah angka yang ditegakkan.
    expect(flags.quota('users')).toBe(3);
    expect(flags.quota('datasets')).toBe(4);
    expect(flags.isEnabled('dataset')).toBe(true);
    // Modul yang TIDAK dipilih benar-benar mati, bukan hanya hilang dari daftar harga.
    expect(flags.isEnabled('executive_cockpit')).toBe(false);
  });
});
