/**
 * Halaman publik: depan, berlangganan, dan pemulihan kata sandi.
 *
 * Uji backend membuktikan server tidak membocorkan alamat mana yang punya akun. Uji di
 * sini membuktikan ANTARMUKA tidak menyiasatinya — layar yang menampilkan pesan berbeda
 * untuk alamat terdaftar dan tidak terdaftar akan membatalkan seluruh kehati-hatian di
 * server, dan kegagalan seperti itu tidak memunculkan kesalahan apa pun.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '../src/app/AppContext.tsx';
import {
  ForgotPasswordView,
  LandingView,
  ResetPasswordView,
  SignupView,
  publicRouteFromHash,
  slugify,
} from '../src/views/public.tsx';
import {
  ApiError,
  api,
  type BillingCycle,
  type BillingCycleOption,
  type PublicPlans,
} from '../src/lib/api.ts';
import { translate } from '../src/i18n/dictionary.ts';

function id(key: string): string {
  const text = translate(key, 'id');
  if (text === key) throw new Error(`kunci tidak ada di kamus: ${key}`);
  return text;
}

/** Harga per siklus datang dari server; di sini nilainya dipalsukan apa adanya. */
function harga(bulanan: number): Record<BillingCycle, number> {
  return {
    monthly: bulanan,
    quarterly: Math.round(bulanan * 3 * 0.95),
    semiannual: Math.round(bulanan * 6 * 0.9),
    annual: bulanan * 10,
  };
}

const SIKLUS: BillingCycleOption[] = [
  { code: 'monthly', months: 1, discount: 0, sortOrder: 1 },
  { code: 'quarterly', months: 3, discount: 0.05, sortOrder: 2 },
  { code: 'semiannual', months: 6, discount: 0.1, sortOrder: 3 },
  { code: 'annual', months: 12, discount: 1 / 6, sortOrder: 4 },
];

const KATALOG: PublicPlans = {
  currency: 'IDR',
  signupEnabled: true,
  cycles: SIKLUS,
  plans: [
    { code: 'starter', name: 'Starter', monthlyPrice: 0, annualPrice: 0, prices: harga(0), moduleCount: 12, quotas: { users: 10, datasets: 25, ai_calls_monthly: 0 }, sortOrder: 1 },
    { code: 'professional', name: 'Professional', monthlyPrice: 4_500_000, annualPrice: 45_000_000, prices: harga(4_500_000), moduleCount: 26, quotas: { users: 50, datasets: 200, ai_calls_monthly: 5000 }, sortOrder: 2 },
    { code: 'enterprise', name: 'Enterprise', monthlyPrice: 12_000_000, annualPrice: 120_000_000, prices: harga(12_000_000), moduleCount: 30, quotas: { users: -1, datasets: -1, ai_calls_monthly: 100_000 }, sortOrder: 3 },
  ],
};

function pasang(view: JSX.Element): void {
  render(<AppProvider>{view}</AppProvider>);
}

beforeEach(() => {
  localStorage.clear();
  window.location.hash = '';
  vi.spyOn(api, 'plans').mockResolvedValue(KATALOG);
  vi.spyOn(api, 'signup');
  vi.spyOn(api, 'requestPasswordReset');
  vi.spyOn(api, 'confirmPasswordReset');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Rute publik', () => {
  it('TC-WEB-25 — hash yang tidak dikenal mendarat di halaman depan, bukan halaman kosong', () => {
    expect(publicRouteFromHash('')).toBe('landing');
    expect(publicRouteFromHash('#/')).toBe('landing');
    expect(publicRouteFromHash('#/entah-apa')).toBe('landing');
    expect(publicRouteFromHash('#/masuk')).toBe('login');
    expect(publicRouteFromHash('#/daftar')).toBe('signup');
    expect(publicRouteFromHash('#/lupa-sandi')).toBe('forgot');
    // Token boleh menempel di hash; rutenya tetap dikenali.
    expect(publicRouteFromHash('#/atur-ulang?token=abc')).toBe('reset');
  });

  it('TC-WEB-26 — slug dibersihkan menjadi alamat yang sah', () => {
    expect(slugify('PT Maju Bersama')).toBe('pt-maju-bersama');
    expect(slugify('  Dinas   Kesehatan!! ')).toBe('dinas-kesehatan');
    // Server menolak slug yang diawali/diakhiri tanda hubung; membersihkannya di sini
    // mencegah penolakan yang membingungkan setelah formulir dikirim.
    expect(slugify('---abc---')).toBe('abc');
    expect(slugify('Ünïcode Ørg')).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('Halaman depan', () => {
  it('TC-WEB-27 — menjelaskan produk dan menampilkan paket beserta harganya', async () => {
    pasang(<LandingView />);

    expect(screen.getByText(id('ui.landing_headline'))).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Professional')).toBeTruthy());
    expect(screen.getByText('Starter')).toBeTruthy();
    expect(screen.getByText('Enterprise')).toBeTruthy();
    // Paket gratis ditulis "Gratis", bukan "Rp 0" — nol rupiah terbaca seperti harga
    // yang belum diisi.
    expect(screen.getByText('Gratis')).toBeTruthy();
  });

  it('TC-WEB-28 — daftar modul berasal dari navigasi aplikasi, bukan daftar terpisah', async () => {
    pasang(<LandingView />);
    // Kalau daftar fiturnya disalin manual, ia akan menua tanpa suara begitu modul
    // ditambah atau diganti nama. Ini memastikan sumbernya sama dengan aplikasi.
    await waitFor(() => expect(screen.getByText('Executive Cockpit')).toBeTruthy());
    expect(screen.getByText('Data Quality Center')).toBeTruthy();
    expect(screen.getByText('Digital Twin')).toBeTruthy();
  });

  it('TC-WEB-29 — ajakan berlangganan disembunyikan bila pendaftaran ditutup', async () => {
    vi.mocked(api.plans).mockResolvedValue({ ...KATALOG, signupEnabled: false });
    pasang(<LandingView />);

    await waitFor(() => expect(screen.getByText('Professional')).toBeTruthy());
    // Tombol yang mengarah ke penolakan lebih buruk daripada tidak ada tombol.
    expect(screen.queryByRole('button', { name: id('action.subscribe') })).toBeNull();
    expect(screen.queryByRole('button', { name: id('action.start_trial') })).toBeNull();
    // Jalur masuk tetap ada — pengguna yang sudah punya akun tidak ikut terkunci.
    expect(screen.getAllByRole('button', { name: id('action.login') }).length).toBeGreaterThan(0);
  });

  it('TC-WEB-30 — katalog gagal dimuat: penjelasan produk tetap tampil', async () => {
    vi.mocked(api.plans).mockRejectedValue(new Error('jaringan mati'));
    pasang(<LandingView />);

    await waitFor(() => expect(screen.getByText(id('ui.landing_why_1_title'))).toBeTruthy());
    // Hanya bagian harga yang absen; halaman tidak menjadi layar kosong.
    expect(screen.getByText(id('ui.landing_headline'))).toBeTruthy();
  });
});

describe('Berlangganan', () => {
  it('TC-WEB-31 — alamat ruang kerja mengikuti nama organisasi sampai disunting sendiri', async () => {
    pasang(<SignupView />);
    await waitFor(() => screen.getByLabelText(id('ui.signup_org')));

    const org = screen.getByLabelText(id('ui.signup_org'));
    const slug = screen.getByLabelText(id('ui.signup_slug')) as HTMLInputElement;
    fireEvent.change(org, { target: { value: 'PT Maju Bersama' } });
    expect(slug.value).toBe('pt-maju-bersama');

    // Setelah pengguna menyunting slug, ia berhenti mengikuti: alamat yang bergeser
    // saat mengetik nama membingungkan.
    fireEvent.change(slug, { target: { value: 'maju' } });
    fireEvent.change(org, { target: { value: 'PT Maju Bersama Sejahtera' } });
    expect(slug.value).toBe('maju');
  });

  it('TC-WEB-32 — pendaftaran berhasil menampilkan kode organisasi untuk masuk', async () => {
    vi.mocked(api.signup).mockResolvedValue({ slug: 'maju' });
    pasang(<SignupView />);
    await waitFor(() => screen.getByLabelText(id('ui.signup_org')));

    fireEvent.change(screen.getByLabelText(id('ui.signup_org')), { target: { value: 'PT Maju' } });
    fireEvent.change(screen.getByLabelText(id('ui.signup_name')), { target: { value: 'Budi' } });
    fireEvent.change(screen.getByLabelText(id('ui.login_email')), { target: { value: 'budi@maju.id' } });
    fireEvent.change(screen.getByLabelText(id('ui.login_password')), { target: { value: 'SandiKuat#2026' } });
    fireEvent.click(screen.getByRole('button', { name: id('action.subscribe') }));

    // Tanpa kode organisasi di layar ini, pengguna baru tidak tahu apa yang harus
    // diketik di kolom pertama halaman masuk.
    await waitFor(() => expect(screen.getByText(id('ui.signup_done_title'))).toBeTruthy());
    expect(screen.getByText(/maju/)).toBeTruthy();
  });

  it('TC-WEB-33 — slug yang sudah dipakai dijelaskan, bukan gagal diam-diam', async () => {
    vi.mocked(api.signup).mockRejectedValue(new ApiError(409, 'error.tenant_slug_taken', null, null));
    pasang(<SignupView />);
    await waitFor(() => screen.getByLabelText(id('ui.signup_org')));

    fireEvent.change(screen.getByLabelText(id('ui.signup_org')), { target: { value: 'Bentrok' } });
    fireEvent.change(screen.getByLabelText(id('ui.signup_name')), { target: { value: 'Budi' } });
    fireEvent.change(screen.getByLabelText(id('ui.login_email')), { target: { value: 'budi@bentrok.id' } });
    fireEvent.change(screen.getByLabelText(id('ui.login_password')), { target: { value: 'SandiKuat#2026' } });
    fireEvent.click(screen.getByRole('button', { name: id('action.subscribe') }));

    await waitFor(() => expect(screen.getByText(id('error.tenant_slug_taken'))).toBeTruthy());
    // Formulir tetap terisi supaya pengguna hanya perlu mengganti satu kolom.
    expect((screen.getByLabelText(id('ui.signup_org')) as HTMLInputElement).value).toBe('Bentrok');
  });

  it('TC-WEB-34 — pendaftaran yang ditutup dijelaskan alih-alih formulir yang pasti gagal', async () => {
    vi.mocked(api.plans).mockResolvedValue({ ...KATALOG, signupEnabled: false });
    pasang(<SignupView />);

    await waitFor(() => expect(screen.getByText(id('error.signup_disabled'))).toBeTruthy());
    expect(screen.queryByLabelText(id('ui.signup_org'))).toBeNull();
  });

  it('TC-WEB-42 — keempat jangka waktu dapat dipilih di formulir pendaftaran', async () => {
    pasang(<SignupView />);
    const pemilih = (await screen.findByLabelText(id('ui.signup_cycle'))) as HTMLSelectElement;

    expect([...pemilih.options].map((o) => o.value)).toEqual([
      'monthly',
      'quarterly',
      'semiannual',
      'annual',
    ]);
  });

  it('TC-WEB-43 — jangka waktu yang dipilih ikut terkirim ke server', async () => {
    vi.mocked(api.signup).mockResolvedValue({ slug: 'enambulan' });
    pasang(<SignupView />);
    await waitFor(() => screen.getByLabelText(id('ui.signup_org')));

    fireEvent.change(screen.getByLabelText(id('ui.signup_cycle')), { target: { value: 'semiannual' } });
    fireEvent.change(screen.getByLabelText(id('ui.signup_org')), { target: { value: 'Enam Bulan' } });
    fireEvent.change(screen.getByLabelText(id('ui.signup_name')), { target: { value: 'Budi' } });
    fireEvent.change(screen.getByLabelText(id('ui.login_email')), { target: { value: 'budi@enam.id' } });
    fireEvent.change(screen.getByLabelText(id('ui.login_password')), { target: { value: 'SandiKuat#2026' } });
    fireEvent.click(screen.getByRole('button', { name: id('action.subscribe') }));

    // Jangka waktu yang dipilih pengguna harus benar-benar sampai — bukan hanya berubah
    // di layar lalu terkirim sebagai bulanan.
    await waitFor(() => expect(vi.mocked(api.signup)).toHaveBeenCalled());
    expect(vi.mocked(api.signup).mock.calls[0]![0]!.billingCycle).toBe('semiannual');
  });

  it('TC-WEB-44 — biaya setelah uji coba dinyatakan sebelum data diri diisi', async () => {
    pasang(<SignupView />);
    const ringkasan = await screen.findByTestId('signup-summary');

    // Professional, 1 bulan: Rp 4.500.000.
    expect(ringkasan.textContent).toContain('4.500.000');
    expect(ringkasan.textContent).toContain(id('ui.cycle_monthly'));

    fireEvent.change(screen.getByLabelText(id('ui.signup_cycle')), { target: { value: 'annual' } });
    await waitFor(() => expect(screen.getByTestId('signup-summary').textContent).toContain('45.000.000'));
  });
});

describe('Pemilih jangka waktu di halaman depan', () => {
  it('TC-WEB-45 — empat pilihan ditawarkan, bulanan aktif secara bawaan', async () => {
    pasang(<LandingView />);
    await waitFor(() => expect(screen.getByText('Professional')).toBeTruthy());

    for (const kunci of ['ui.cycle_monthly', 'ui.cycle_quarterly', 'ui.cycle_semiannual', 'ui.cycle_annual']) {
      expect(screen.getByRole('button', { name: new RegExp(id(kunci)) })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: new RegExp(id('ui.cycle_monthly')) }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('TC-WEB-46 — mengganti jangka waktu mengganti harga yang dipajang', async () => {
    pasang(<LandingView />);
    await waitFor(() => expect(screen.getByText('Professional')).toBeTruthy());

    expect(screen.getByText(/4\.500\.000/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: new RegExp(id('ui.cycle_annual')) }));

    // Harga 12 bulan Professional = 45.000.000, dan setara 3.750.000 per bulan.
    await waitFor(() => expect(screen.getByText(/45\.000\.000/)).toBeTruthy());
    expect(screen.getByText(/3\.750\.000/)).toBeTruthy();
  });

  it('TC-WEB-47 — harga berasal dari server, tidak dihitung ulang di klien', async () => {
    // Server dipalsukan mengembalikan angka yang TIDAK cocok dengan rumus diskon mana
    // pun. Antarmuka harus memajang angka itu apa adanya: harga adalah keputusan
    // komersial, bukan sesuatu yang boleh ditebak ulang di peramban.
    vi.mocked(api.plans).mockResolvedValue({
      ...KATALOG,
      plans: KATALOG.plans.map((p) =>
        p.code === 'professional' ? { ...p, prices: { ...p.prices, annual: 33_333_000 } } : p,
      ),
    });
    pasang(<LandingView />);
    await waitFor(() => expect(screen.getByText('Professional')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: new RegExp(id('ui.cycle_annual')) }));
    await waitFor(() => expect(screen.getByText(/33\.333\.000/)).toBeTruthy());
  });
});

describe('Lupa kata sandi', () => {
  it('TC-WEB-35 — jawaban SAMA untuk alamat terdaftar dan tidak terdaftar', async () => {
    vi.mocked(api.requestPasswordReset).mockResolvedValue({ accepted: true, transportConfigured: true });
    pasang(<ForgotPasswordView />);

    fireEvent.change(screen.getByLabelText(id('ui.login_email')), { target: { value: 'ada@demo.test' } });
    fireEvent.click(screen.getByRole('button', { name: id('action.send_reset') }));
    await waitFor(() => screen.getByText(id('ui.forgot_sent_title')));
    const pertama = document.body.textContent;

    cleanup();
    pasang(<ForgotPasswordView />);
    fireEvent.change(screen.getByLabelText(id('ui.login_email')), { target: { value: 'tidak.ada@demo.test' } });
    fireEvent.click(screen.getByRole('button', { name: id('action.send_reset') }));
    await waitFor(() => screen.getByText(id('ui.forgot_sent_title')));

    // Layar yang membedakan keduanya membatalkan kehati-hatian server: siapa pun dapat
    // menguji daftar alamat dan tahu mana yang punya akun.
    expect(document.body.textContent).toBe(pertama);
  });

  it('TC-WEB-36 — kegagalan jaringan pun tidak menghasilkan layar berbeda', async () => {
    vi.mocked(api.requestPasswordReset).mockRejectedValue(new Error('jaringan mati'));
    pasang(<ForgotPasswordView />);

    fireEvent.change(screen.getByLabelText(id('ui.login_email')), { target: { value: 'ada@demo.test' } });
    fireEvent.click(screen.getByRole('button', { name: id('action.send_reset') }));

    // Pesan galat yang muncul hanya untuk sebagian alamat adalah kebocoran yang sama,
    // hanya lewat jalan lain.
    await waitFor(() => expect(screen.getByText(id('ui.forgot_sent_title'))).toBeTruthy());
  });

  it('TC-WEB-37 — tanpa transport email, pengguna diberi tahu ke mana harus meminta kodenya', async () => {
    vi.mocked(api.requestPasswordReset).mockResolvedValue({ accepted: true, transportConfigured: false });
    pasang(<ForgotPasswordView />);

    fireEvent.change(screen.getByLabelText(id('ui.login_email')), { target: { value: 'ada@demo.test' } });
    fireEvent.click(screen.getByRole('button', { name: id('action.send_reset') }));

    // Tanpa keterangan ini, pengguna menunggu email yang tidak akan pernah datang.
    await waitFor(() => expect(screen.getByText(id('ui.forgot_no_transport'))).toBeTruthy());
  });
});

describe('Atur ulang dengan token', () => {
  it('TC-WEB-38 — token dari tautan terisi otomatis', async () => {
    window.location.hash = '#/atur-ulang?token=TOKEN-DARI-TAUTAN';
    pasang(<ResetPasswordView />);

    expect((screen.getByLabelText(id('ui.reset_token')) as HTMLInputElement).value).toBe('TOKEN-DARI-TAUTAN');
  });

  it('TC-WEB-39 — konfirmasi yang tidak cocok ditahan sebelum menyentuh server', async () => {
    pasang(<ResetPasswordView />);

    fireEvent.change(screen.getByLabelText(id('ui.reset_token')), { target: { value: 'tok' } });
    fireEvent.change(screen.getByLabelText(id('ui.password_new')), { target: { value: 'SandiKuat#2026' } });
    fireEvent.change(screen.getByLabelText(id('ui.password_confirm')), { target: { value: 'SandiLain#2026' } });

    expect(screen.getByText(id('error.password_confirm_mismatch'))).toBeTruthy();
    // Salah ketik pada kolom konfirmasi tidak boleh menghabiskan jatah batas laju.
    expect((screen.getByRole('button', { name: id('action.reset_password') }) as HTMLButtonElement).disabled).toBe(true);
    expect(vi.mocked(api.confirmPasswordReset)).not.toHaveBeenCalled();
  });

  it('TC-WEB-40 — token kedaluwarsa dijelaskan beserta langkah berikutnya', async () => {
    vi.mocked(api.confirmPasswordReset).mockRejectedValue(new ApiError(400, 'error.reset_token_invalid', null, null));
    pasang(<ResetPasswordView />);

    fireEvent.change(screen.getByLabelText(id('ui.reset_token')), { target: { value: 'kedaluwarsa' } });
    fireEvent.change(screen.getByLabelText(id('ui.password_new')), { target: { value: 'SandiKuat#2026' } });
    fireEvent.change(screen.getByLabelText(id('ui.password_confirm')), { target: { value: 'SandiKuat#2026' } });
    fireEvent.click(screen.getByRole('button', { name: id('action.reset_password') }));

    await waitFor(() => expect(screen.getByText(id('error.reset_token_invalid'))).toBeTruthy());
  });

  it('TC-WEB-41 — berhasil: pengguna diberi tahu sesi lama sudah dikeluarkan', async () => {
    vi.mocked(api.confirmPasswordReset).mockResolvedValue({ ok: true });
    pasang(<ResetPasswordView />);

    fireEvent.change(screen.getByLabelText(id('ui.reset_token')), { target: { value: 'sah' } });
    fireEvent.change(screen.getByLabelText(id('ui.password_new')), { target: { value: 'SandiKuat#2026' } });
    fireEvent.change(screen.getByLabelText(id('ui.password_confirm')), { target: { value: 'SandiKuat#2026' } });
    fireEvent.click(screen.getByRole('button', { name: id('action.reset_password') }));

    // Pencabutan sesi adalah kejutan bila tidak diberitahukan: pengguna akan mengira
    // perangkat lain rusak.
    await waitFor(() => expect(screen.getByText(id('ui.reset_done'))).toBeTruthy());
  });
});
