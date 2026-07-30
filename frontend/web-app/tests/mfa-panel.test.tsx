/**
 * Panel pendaftaran MFA — SECURITY.md Bagian 4.
 *
 * Titik paling rawan di seluruh alur MFA bukan kriptografinya, melainkan satu momen di
 * antarmuka: kode pemulihan hanya ditampilkan SEKALI karena server hanya menyimpan
 * hash-nya. Bila panel gagal menampilkannya — atau menampilkannya tanpa peringatan bahwa
 * ini satu-satunya kesempatan — pengguna kehilangan satu-satunya jalan masuk ketika
 * ponsel autentikatornya hilang, dan tenant kehilangan administratornya.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '../src/app/AppContext.tsx';
import { MfaPanel } from '../src/views/remaining.tsx';
import { ApiError, api, type MfaStatus } from '../src/lib/api.ts';
import { translate } from '../src/i18n/dictionary.ts';

function id(key: string): string {
  const text = translate(key, 'id');
  if (text === key) throw new Error(`kunci tidak ada di kamus: ${key}`);
  return text;
}

const BELUM: MfaStatus = {
  enrolled: false,
  activatedAt: null,
  secretPending: false,
  remainingRecoveryCodes: 0,
  requiredByRole: true,
  enrolmentPending: true,
};

const AKTIF_WAJIB: MfaStatus = {
  enrolled: true,
  activatedAt: '2026-07-27T10:00:00.000Z',
  secretPending: false,
  remainingRecoveryCodes: 7,
  requiredByRole: true,
  enrolmentPending: false,
};

const AKTIF_OPSIONAL: MfaStatus = { ...AKTIF_WAJIB, requiredByRole: false };

const KODE_PEMULIHAN = ['K7M9QW2R', 'P4X8TS3V', 'B9YR6HL2'];

function pasang(status: MfaStatus): void {
  vi.mocked(api.get).mockResolvedValue(status as never);
  render(
    <AppProvider>
      <MfaPanel />
    </AppProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(api, 'get');
  vi.spyOn(api, 'post');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Pendaftaran MFA', () => {
  it('TC-WEB-16 — peran wajib yang belum mendaftar melihat peringatan, bukan ajakan opsional', async () => {
    pasang(BELUM);

    // Pesan yang sama dengan yang ditolak server saat akses dicoba — pengguna melihat
    // sebab penolakannya, bukan dua kalimat berbeda untuk keadaan yang sama.
    await waitFor(() => expect(screen.getByText(id('error.mfa_enrolment_required'))).toBeTruthy());
    expect(screen.getByRole('button', { name: id('action.mfa_enroll') })).toBeTruthy();
  });

  it('TC-WEB-17 — rahasia dan URI otpauth tampil agar autentikator dapat diisi manual', async () => {
    pasang(BELUM);
    vi.mocked(api.post).mockResolvedValue({
      secret: 'JBSWY3DPEHPK3PXP',
      otpauthUri: 'otpauth://totp/Vantik:sari@demo.vantik.id?secret=JBSWY3DPEHPK3PXP&issuer=Vantik',
    } as never);

    await waitFor(() => screen.getByRole('button', { name: id('action.mfa_enroll') }));
    fireEvent.click(screen.getByRole('button', { name: id('action.mfa_enroll') }));

    // Tanpa QR, satu-satunya jalan adalah entri manual — jadi rahasianya WAJIB terbaca.
    await waitFor(() => expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeTruthy());
    expect(screen.getByText(/^otpauth:\/\/totp\/Vantik:/)).toBeTruthy();
    expect(screen.getByLabelText(id('ui.mfa_code'))).toBeTruthy();
  });

  it('TC-WEB-18 — tombol aktivasi tetap mati sampai ada kode yang diketik', async () => {
    pasang(BELUM);
    vi.mocked(api.post).mockResolvedValue({ secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://x' } as never);

    await waitFor(() => screen.getByRole('button', { name: id('action.mfa_enroll') }));
    fireEvent.click(screen.getByRole('button', { name: id('action.mfa_enroll') }));
    const tombol = await waitFor(
      () => screen.getByRole('button', { name: id('action.mfa_activate') }) as HTMLButtonElement,
    );

    // Mengirim kode kosong menghabiskan satu percobaan di penghitung anti-brute-force
    // server tanpa kemungkinan berhasil.
    expect(tombol.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(id('ui.mfa_code')), { target: { value: '123456' } });
    expect(tombol.disabled).toBe(false);
  });

  it('TC-WEB-19 — kode pemulihan tampil SELURUHNYA disertai peringatan sekali-tampil', async () => {
    pasang(BELUM);
    vi.mocked(api.post)
      .mockResolvedValueOnce({ secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://x' } as never)
      .mockResolvedValueOnce({ activated: true, recoveryCodes: KODE_PEMULIHAN } as never);

    await waitFor(() => screen.getByRole('button', { name: id('action.mfa_enroll') }));
    fireEvent.click(screen.getByRole('button', { name: id('action.mfa_enroll') }));
    await waitFor(() => screen.getByLabelText(id('ui.mfa_code')));
    fireEvent.change(screen.getByLabelText(id('ui.mfa_code')), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: id('action.mfa_activate') }));

    // Server hanya menyimpan hash-nya; yang tidak tersalin sekarang hilang selamanya.
    await waitFor(() => expect(screen.getByText(id('ui.mfa_recovery_once'))).toBeTruthy());
    for (const kode of KODE_PEMULIHAN) {
      expect(screen.getByText(kode)).toBeTruthy();
    }
  });

  it('TC-WEB-20 — kode aktivasi salah: pesan tampil dan rahasia TETAP di layar', async () => {
    pasang(BELUM);
    vi.mocked(api.post)
      .mockResolvedValueOnce({ secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://x' } as never)
      .mockRejectedValueOnce(new ApiError(400, 'error.mfa_code_invalid', null, null));

    await waitFor(() => screen.getByRole('button', { name: id('action.mfa_enroll') }));
    fireEvent.click(screen.getByRole('button', { name: id('action.mfa_enroll') }));
    await waitFor(() => screen.getByLabelText(id('ui.mfa_code')));
    fireEvent.change(screen.getByLabelText(id('ui.mfa_code')), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: id('action.mfa_activate') }));

    await waitFor(() => expect(screen.getByText(id('error.mfa_code_invalid'))).toBeTruthy());
    // Menghapus rahasia setelah satu kode salah memaksa pengguna mendaftar ulang dari
    // awal — termasuk menghapus entri yang sudah dibuat di aplikasi autentikatornya.
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeTruthy();
  });
});

describe('MFA yang sudah aktif', () => {
  it('TC-WEB-21 — sisa kode pemulihan ditampilkan sebagai angka, bukan disembunyikan', async () => {
    pasang(AKTIF_WAJIB);

    await waitFor(() => expect(screen.getByText(id('ui.mfa_active'))).toBeTruthy());
    // Pengguna perlu tahu kapan harus membuat kode baru SEBELUM habis.
    expect(screen.getByText('7')).toBeTruthy();
  });

  it('TC-WEB-22 — peran yang mewajibkan MFA tidak diberi tombol matikan', async () => {
    pasang(AKTIF_WAJIB);

    await waitFor(() => screen.getByText(id('ui.mfa_active')));
    // Tombol yang pasti ditolak server hanya mengajarkan pengguna bahwa antarmuka
    // tidak dapat dipercaya.
    expect(screen.queryByRole('button', { name: id('action.mfa_disable') })).toBeNull();
    expect(screen.getByRole('button', { name: id('action.mfa_new_recovery_codes') })).toBeTruthy();
  });

  it('TC-WEB-23 — peran yang tidak mewajibkan MFA boleh mematikannya', async () => {
    pasang(AKTIF_OPSIONAL);

    await waitFor(() => screen.getByText(id('ui.mfa_active')));
    const matikan = screen.getByRole('button', { name: id('action.mfa_disable') }) as HTMLButtonElement;
    // Tetap menuntut kode: mematikan MFA adalah aksi sensitif, bukan sakelar biasa.
    expect(matikan.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(id('ui.mfa_code')), { target: { value: '123456' } });
    expect(matikan.disabled).toBe(false);
  });

  it('TC-WEB-24 — kode pemulihan baru menuntut kode TOTP dan mengosongkan medannya', async () => {
    pasang(AKTIF_WAJIB);
    vi.mocked(api.post).mockResolvedValue({ recoveryCodes: KODE_PEMULIHAN } as never);

    await waitFor(() => screen.getByText(id('ui.mfa_active')));
    const medan = screen.getByLabelText(id('ui.mfa_code')) as HTMLInputElement;
    fireEvent.change(medan, { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: id('action.mfa_new_recovery_codes') }));

    await waitFor(() =>
      expect(vi.mocked(api.post).mock.calls[0]).toEqual(['/mfa/recovery-codes', { code: '654321' }]),
    );
    // Kode sekali pakai yang tertinggal di medan akan dikirim ulang pada klik berikutnya
    // dan ditolak server sebagai pemakaian ganda.
    await waitFor(() => expect((screen.getByLabelText(id('ui.mfa_code')) as HTMLInputElement).value).toBe(''));
    expect(screen.getByText(KODE_PEMULIHAN[0]!)).toBeTruthy();
  });
});
