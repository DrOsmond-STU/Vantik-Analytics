/**
 * Layar masuk dua langkah — SECURITY.md Bagian 4 & 17.4.
 *
 * Uji backend membuktikan server MENOLAK dengan benar. Uji di sini membuktikan pengguna
 * dapat MELIHAT penolakan itu dan tahu langkah berikutnya. Keduanya bukan hal yang sama:
 * server yang menolak dengan sempurna tetap mengunci pengguna sah bila layar tidak pernah
 * menampilkan jalan pemulihannya.
 *
 * Yang dijaga di sini adalah kelas cacat yang tidak melempar kesalahan apa pun:
 * formulir kode yang bertahan setelah tantangannya mati (pengguna mengetik kode ke ruang
 * hampa), pesan galat yang hilang, dan tombol kirim yang dapat ditekan dua kali.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '../src/app/AppContext.tsx';
import { LoginView } from '../src/views/login.tsx';
import { ApiError, api } from '../src/lib/api.ts';
import { translate } from '../src/i18n/dictionary.ts';

/**
 * Teks Bahasa Indonesia untuk sebuah kunci — bahasa default sistem (DESIGN.md 8.1).
 *
 * Memakai `translate()` yang sama dengan aplikasi, bukan membaca kamus langsung, supaya
 * uji ini gagal bila perakitan teksnya berubah. `translate()` mengembalikan kunci apa
 * adanya bila tidak ada di kamus, jadi salah tulis kunci diperiksa di sini.
 */
function id(key: string): string {
  const text = translate(key, 'id');
  if (text === key) throw new Error(`kunci tidak ada di kamus: ${key}`);
  return text;
}

function pasang(): void {
  render(
    <AppProvider>
      <LoginView />
    </AppProvider>,
  );
}

/** Mengisi langkah pertama lalu menekan Masuk. */
async function masuk(): Promise<void> {
  const email = screen.getByLabelText(id('ui.login_email'));
  const sandi = screen.getByLabelText(id('ui.login_password'));
  email.setAttribute('value', 'sari@demo.vantik.id');
  // React mengabaikan perubahan atribut; gunakan peristiwa yang sama dengan pengguna.
  const { fireEvent } = await import('@testing-library/react');
  fireEvent.change(email, { target: { value: 'sari@demo.vantik.id' } });
  fireEvent.change(sandi, { target: { value: 'VantikDemo#2026' } });
  fireEvent.click(screen.getByRole('button', { name: id('action.login') }));
}

async function kirimKode(kode: string): Promise<void> {
  const { fireEvent } = await import('@testing-library/react');
  fireEvent.change(screen.getByLabelText(id('ui.mfa_code')), { target: { value: kode } });
  fireEvent.click(screen.getByRole('button', { name: id('action.verify') }));
}

const TANTANGAN = {
  mfaRequired: true as const,
  challengeToken: 'chal-uji-123',
  expiresAt: '2026-07-28T00:05:00.000Z',
  recoveryAccepted: true,
};

beforeEach(() => {
  localStorage.clear();
  // AppProvider memanggil /me hanya bila ada token; tanpa token tidak ada jaringan.
  vi.spyOn(api, 'login');
  vi.spyOn(api, 'verifyMfa');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Langkah pertama: kata sandi', () => {
  it('TC-WEB-01 — menampilkan medan organisasi, email, kata sandi — dan BUKAN medan kode', () => {
    pasang();

    expect(screen.getByLabelText(id('ui.login_tenant'))).toBeTruthy();
    expect(screen.getByLabelText(id('ui.login_email'))).toBeTruthy();
    expect(screen.getByLabelText(id('ui.login_password'))).toBeTruthy();
    // Medan kode sebelum ada tantangan akan mengajak pengguna mengetik kode yang belum
    // diminta siapa pun.
    expect(screen.queryByLabelText(id('ui.mfa_code'))).toBeNull();
  });

  it('TC-WEB-02 — label tertaut ke kontrolnya, bukan sekadar teks di atasnya', () => {
    pasang();
    const sandi = screen.getByLabelText(id('ui.login_password'));

    // getByLabelText hanya menemukan medan bila label benar-benar tertaut; tanpa tautan,
    // pembaca layar tidak dapat menyebutkan medan mana yang sedang diisi.
    expect(sandi.getAttribute('type')).toBe('password');
    expect(sandi.getAttribute('autocomplete')).toBe('current-password');
  });

  it('TC-WEB-03 — perangkat belum terikat: alasan DAN langkah pemulihan keduanya tampil', async () => {
    vi.mocked(api.login).mockRejectedValue(
      new ApiError(401, 'error.device_not_bound', null, 'recovery.request_device_transfer'),
    );
    pasang();
    await masuk();

    // SECURITY.md 17.4 menuntut alasan + langkah pemulihan, bukan "akses ditolak".
    await waitFor(() => expect(screen.getByText(id('error.device_not_bound'))).toBeTruthy());
    expect(screen.getByText(id('recovery.request_device_transfer'))).toBeTruthy();
  });

  it('TC-WEB-04 — kegagalan tak terduga tidak membocorkan detail teknis', async () => {
    vi.mocked(api.login).mockRejectedValue(new TypeError('fetch failed: ECONNREFUSED 10.0.0.5:4000'));
    pasang();
    await masuk();

    await waitFor(() => expect(screen.getByText(id('error.internal'))).toBeTruthy());
    expect(screen.queryByText(/ECONNREFUSED/)).toBeNull();
    expect(screen.queryByText(/10\.0\.0\.5/)).toBeNull();
  });
});

describe('Langkah kedua: kode verifikasi', () => {
  it('TC-WEB-05 — server meminta faktor kedua: formulir berganti dan kata sandi hilang dari DOM', async () => {
    vi.mocked(api.login).mockResolvedValue(TANTANGAN);
    pasang();
    await masuk();

    await waitFor(() => expect(screen.getByLabelText(id('ui.mfa_code'))).toBeTruthy());
    expect(screen.getByText(id('ui.mfa_step_title'))).toBeTruthy();
    // Kata sandi tidak boleh tertinggal di halaman setelah dipakai.
    expect(screen.queryByLabelText(id('ui.login_password'))).toBeNull();
  });

  it('TC-WEB-06 — medan kode disiapkan untuk kode sekali pakai di ponsel', async () => {
    vi.mocked(api.login).mockResolvedValue(TANTANGAN);
    pasang();
    await masuk();

    const kode = await waitFor(() => screen.getByLabelText(id('ui.mfa_code')));
    // `one-time-code` membuat peramban & iOS menawarkan kodenya; `numeric` memunculkan
    // papan tuts angka. Keduanya keputusan sengaja, jadi dijaga uji.
    expect(kode.getAttribute('autocomplete')).toBe('one-time-code');
    expect(kode.getAttribute('inputmode')).toBe('numeric');
    expect(kode.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText(id('ui.mfa_code_hint'))).toBeTruthy();
  });

  it('TC-WEB-07 — kode salah: pesan tampil dan formulir kode TETAP terbuka', async () => {
    vi.mocked(api.login).mockResolvedValue(TANTANGAN);
    vi.mocked(api.verifyMfa).mockRejectedValue(new ApiError(401, 'error.mfa_code_invalid', null, null));
    pasang();
    await masuk();
    await waitFor(() => screen.getByLabelText(id('ui.mfa_code')));
    await kirimKode('000000');

    // Salah ketik satu digit tidak boleh memaksa pengguna mengulang kata sandi.
    await waitFor(() => expect(screen.getByText(id('error.mfa_code_invalid'))).toBeTruthy());
    expect(screen.getByLabelText(id('ui.mfa_code'))).toBeTruthy();
  });

  it('TC-WEB-08 — tantangan kedaluwarsa: pengguna dikembalikan ke langkah kata sandi', async () => {
    vi.mocked(api.login).mockResolvedValue(TANTANGAN);
    vi.mocked(api.verifyMfa).mockRejectedValue(new ApiError(401, 'error.mfa_challenge_invalid', null, null));
    pasang();
    await masuk();
    await waitFor(() => screen.getByLabelText(id('ui.mfa_code')));
    await kirimKode('123456');

    // Membiarkan formulir kode terbuka setelah tantangannya mati berarti pengguna
    // mengetik kode yang tidak akan pernah diterima, tanpa tahu sebabnya.
    await waitFor(() => expect(screen.getByLabelText(id('ui.login_password'))).toBeTruthy());
    expect(screen.queryByLabelText(id('ui.mfa_code'))).toBeNull();
    expect(screen.getByText(id('error.mfa_challenge_invalid'))).toBeTruthy();
  });

  it('TC-WEB-09 — percobaan kode habis: juga dikembalikan ke langkah kata sandi', async () => {
    vi.mocked(api.login).mockResolvedValue(TANTANGAN);
    vi.mocked(api.verifyMfa).mockRejectedValue(new ApiError(429, 'error.mfa_too_many_attempts', null, null));
    pasang();
    await masuk();
    await waitFor(() => screen.getByLabelText(id('ui.mfa_code')));
    await kirimKode('999999');

    await waitFor(() => expect(screen.getByLabelText(id('ui.login_password'))).toBeTruthy());
    expect(screen.getByText(id('error.mfa_too_many_attempts'))).toBeTruthy();
  });

  it('TC-WEB-10 — tombol kembali membatalkan tantangan dan mengosongkan kode', async () => {
    const { fireEvent } = await import('@testing-library/react');
    vi.mocked(api.login).mockResolvedValue(TANTANGAN);
    pasang();
    await masuk();

    const kode = await waitFor(() => screen.getByLabelText(id('ui.mfa_code')));
    fireEvent.change(kode, { target: { value: '424242' } });
    fireEvent.click(screen.getByRole('button', { name: id('action.back') }));

    await waitFor(() => expect(screen.getByLabelText(id('ui.login_password'))).toBeTruthy());
    // Kembali lagi ke langkah kode harus mulai dari medan kosong, bukan kode lama yang
    // sudah tidak berlaku.
    vi.mocked(api.login).mockResolvedValue(TANTANGAN);
    await masuk();
    const lagi = await waitFor(() => screen.getByLabelText(id('ui.mfa_code')) as HTMLInputElement);
    expect(lagi.value).toBe('');
  });

  it('TC-WEB-11 — kode pemulihan diterima lewat medan yang sama', async () => {
    vi.mocked(api.login).mockResolvedValue(TANTANGAN);
    vi.mocked(api.verifyMfa).mockResolvedValue({
      token: 'tok-uji',
      expiresAt: '2026-07-28T08:00:00.000Z',
      deviceRegistered: true,
    });
    pasang();
    await masuk();
    await waitFor(() => screen.getByLabelText(id('ui.mfa_code')));
    // Kode pemulihan berhuruf; medan yang menolak huruf akan membuat jalur pemulihan
    // mustahil dipakai justru ketika ponsel autentikator hilang.
    await kirimKode('K7M9-QW2R');

    await waitFor(() =>
      expect(vi.mocked(api.verifyMfa).mock.calls[0]![0]).toMatchObject({
        challengeToken: TANTANGAN.challengeToken,
        code: 'K7M9-QW2R',
      }),
    );
  });

  it('TC-WEB-12 — selama permintaan berjalan, tombol kirim tidak dapat ditekan lagi', async () => {
    const { fireEvent } = await import('@testing-library/react');
    let selesaikan: (value: typeof TANTANGAN) => void = () => undefined;
    vi.mocked(api.login).mockReturnValue(
      new Promise((resolve) => {
        selesaikan = resolve;
      }),
    );
    pasang();
    await masuk();

    // Klik ganda pada formulir masuk berarti dua percobaan terhadap penghitung
    // pembatas laju — pengguna dapat mengunci dirinya sendiri dua kali lebih cepat.
    const tombol = await waitFor(() => screen.getByRole('button', { name: id('ui.loading') }));
    expect((tombol as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(tombol);
    expect(vi.mocked(api.login)).toHaveBeenCalledTimes(1);

    selesaikan(TANTANGAN);
    await waitFor(() => expect(screen.getByLabelText(id('ui.mfa_code'))).toBeTruthy());
  });
});
