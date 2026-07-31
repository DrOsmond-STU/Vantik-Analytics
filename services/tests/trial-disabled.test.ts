/**
 * Uji coba gratis MATI secara bawaan.
 *
 * Keputusan komersialnya: pendaftaran mandiri tidak lagi menghadiahkan masa pakai penuh,
 * karena satu orang dapat mengulangnya dengan alamat email baru dan memakai platform tanpa
 * pernah membayar. Yang diuji di sini adalah bahwa penutupan itu benar-benar mengikat, dan
 * bahwa cara ia mengikat tidak merusak hal lain:
 *
 *  1. **Ruang kerja baru tidak dapat menulis** (TC-TRL-03), dan blokirnya berlaku sejak
 *     permintaan pertama tanpa menunggu penjadwal — sama seperti blokir kedaluwarsa.
 *  2. **Masih dapat DIBACA dan dimasuki** (TC-TRL-04). Sengaja bukan suspensi: pelanggan
 *     yang sudah transfer perlu bisa masuk dan menyelesaikan pembayarannya sendiri.
 *  3. **Pesannya "belum aktif", bukan "masa berlaku habis"** (TC-TRL-05). Menyuruh
 *     pelanggan baru "memperpanjang" sesuatu yang belum pernah berjalan membuat ia mencari
 *     riwayat yang tidak ada.
 *  4. **Pelanggan lama tidak ikut terkunci** (TC-TRL-09). Migrasi yang diam-diam menonaktifkan
 *     langganan yang sudah berjalan adalah kerusakan, bukan pengetatan.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, contextFor, provisionTenant, TEST_PASSWORD, type Harness } from './helpers.ts';
import { DEFAULT_TRIAL_DAYS, resolveTrialDays } from '../src/platform/featureFlags.ts';
import { loadFeatureFlags, subscriptionNeverActivated } from '../src/platform/context.ts';
import { ForbiddenError } from '../src/platform/errors.ts';

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

afterEach(() => harness.cleanup());

/** Tenant seperti yang dibuat produksi: tanpa `trialDays` eksplisit. */
function daftarTanpaUjiCoba(slug = 'barux'): string {
  const { tenantId } = harness.tenants.provision(
    {
      name: `Organisasi ${slug}`,
      slug,
      planCode: 'professional',
      billingCycle: 'monthly',
      requiresApproval: true,
      admin: {
        fullName: 'Pendaftar Baru',
        nik: `NIK-${slug}`,
        email: `admin@${slug}.test`,
        password: TEST_PASSWORD,
      },
    },
    'test',
  );
  return tenantId;
}

function langganan(tenantId: string): {
  status: string;
  trial_ends_at: string | null;
  current_period_end: string;
  activated_at: string | null;
} {
  return harness.db
    .prepare(
      'SELECT status, trial_ends_at, current_period_end, activated_at FROM subscriptions WHERE tenant_id = ?',
    )
    .get(tenantId) as {
    status: string;
    trial_ends_at: string | null;
    current_period_end: string;
    activated_at: string | null;
  };
}

function tenantStatus(tenantId: string): string {
  return (harness.db.prepare('SELECT status FROM tenants WHERE id = ?').get(tenantId) as { status: string }).status;
}

/* ================= Konfigurasi ================= */

describe('Konfigurasi lama uji coba', () => {
  it('TC-TRL-01 — bawaannya nol hari: tidak ada uji coba gratis', () => {
    expect(DEFAULT_TRIAL_DAYS).toBe(0);
    expect(resolveTrialDays({})).toBe(0);
    expect(resolveTrialDays({ VANTIK_TRIAL_DAYS: '' })).toBe(0);
  });

  it('TC-TRL-02 — dapat dinyalakan lewat variabel lingkungan; nilai rusak diabaikan', () => {
    expect(resolveTrialDays({ VANTIK_TRIAL_DAYS: '14' })).toBe(14);
    expect(resolveTrialDays({ VANTIK_TRIAL_DAYS: ' 7 ' })).toBe(7);
    // Salah ketik tidak boleh berarti "uji coba selama NaN hari" — bawaannya tetap dipakai.
    expect(resolveTrialDays({ VANTIK_TRIAL_DAYS: 'dua minggu' })).toBe(0);
    expect(resolveTrialDays({ VANTIK_TRIAL_DAYS: '-5' })).toBe(0);
    expect(resolveTrialDays({ VANTIK_TRIAL_DAYS: '30.9' })).toBe(30);
  });
});

/* ================= Tenant baru ================= */

describe('Ruang kerja baru tanpa uji coba', () => {
  it('TC-TRL-03 — langganan lahir belum dibayar dan masa berlakunya sudah lewat', () => {
    const tenantId = daftarTanpaUjiCoba();
    const sub = langganan(tenantId);

    expect(sub.status).toBe('past_due');
    expect(sub.trial_ends_at).toBeNull();
    expect(sub.activated_at).toBeNull();
    // Berakhir pada saat pembuatan: blokirnya dihitung dari tanggal pada setiap permintaan,
    // jadi berlaku sejak permintaan pertama — tidak menunggu penjadwal.
    expect(Date.parse(sub.current_period_end)).toBeLessThanOrEqual(Date.now());
    expect(subscriptionNeverActivated(sub)).toBe(true);
  });

  it('TC-TRL-04 — ruang kerjanya baca-saja, BUKAN disuspensi', () => {
    const tenantId = daftarTanpaUjiCoba();
    const flags = loadFeatureFlags(harness.db, tenantId, tenantStatus(tenantId));

    expect(flags.readOnly).toBe(true);
    // Status tenant tidak disentuh: pelanggan yang sudah transfer harus tetap dapat masuk
    // dan menyelesaikan pembayarannya sendiri.
    expect(tenantStatus(tenantId)).not.toBe('suspended');
    // Modul paketnya tetap terbuka untuk dibaca — memblokir penulisan bukan mencabut akses.
    expect(flags.isEnabled('dataset')).toBe(true);
  });

  it('TC-TRL-05 — alasannya "belum aktif", bukan "masa berlaku habis"', () => {
    const tenantId = daftarTanpaUjiCoba();
    const flags = loadFeatureFlags(harness.db, tenantId, tenantStatus(tenantId));

    expect(flags.readOnlyReason).toBe('subscription_unpaid');
    expect(flags.toJSON().readOnlyReason).toBe('subscription_unpaid');
  });

  it('TC-TRL-06 — penulisan ditolak dengan langkah pemulihan menuju aktivasi', () => {
    const tenantId = daftarTanpaUjiCoba();
    const ctx = contextFor(harness, tenantId, ['super_admin']);

    let error: unknown;
    try {
      ctx.requireWritable();
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ForbiddenError);
    const forbidden = error as ForbiddenError & { detail?: Record<string, unknown> };
    expect(forbidden.messageKey).toBe('error.subscription_unpaid');
    // Langkah pemulihannya menunjuk aktivasi, bukan perpanjangan sesuatu yang belum ada.
    expect(forbidden.detail?.recoveryKey).toBe('recovery.activate_subscription');
  });

  it('TC-TRL-07 — pendaftaran mandiri tetap butuh persetujuan admin', () => {
    const tenantId = daftarTanpaUjiCoba();
    const approval = harness.db
      .prepare('SELECT approval_status FROM tenants WHERE id = ?')
      .get(tenantId) as { approval_status: string };

    // Dua gerbang berdiri sendiri: tanpa persetujuan tidak bisa masuk sama sekali, dan
    // setelah disetujui pun belum bisa menulis sampai dibayar.
    expect(approval.approval_status).toBe('pending');
  });
});

/* ================= Yang tidak boleh berubah ================= */

describe('Batas perubahan', () => {
  it('TC-TRL-08 — pemanggil yang menyebut trialDays eksplisit tidak terpengaruh', () => {
    const { tenantId } = provisionTenant(harness, { slug: 'ujicobax', trialDays: 7 });
    const sub = langganan(tenantId);

    // Data contoh dan alat operator tetap dapat memberi uji coba bila memang diinginkan.
    expect(sub.status).toBe('trialing');
    expect(sub.trial_ends_at).not.toBeNull();
    expect(loadFeatureFlags(harness.db, tenantId, tenantStatus(tenantId)).readOnly).toBe(false);
  });

  it('TC-TRL-09 — langganan yang sudah aktif tidak dianggap belum dibayar', () => {
    const { tenantId } = provisionTenant(harness, { slug: 'lamax', trialDays: 30 });
    // Seperti pelanggan lama setelah migrasi: status aktif, dan `activated_at` terisi.
    harness.db
      .prepare("UPDATE subscriptions SET status = 'active', activated_at = ? WHERE tenant_id = ?")
      .run(new Date(Date.now() - 90 * 86_400_000).toISOString(), tenantId);

    const sub = langganan(tenantId);
    expect(subscriptionNeverActivated(sub)).toBe(false);
    expect(loadFeatureFlags(harness.db, tenantId, tenantStatus(tenantId)).readOnly).toBe(false);
  });

  it('TC-TRL-10 — langganan aktif yang kedaluwarsa disebut kedaluwarsa, bukan belum aktif', () => {
    const { tenantId } = provisionTenant(harness, { slug: 'habisx', trialDays: 30 });
    const lewat = new Date(Date.now() - 3 * 86_400_000).toISOString();
    harness.db
      .prepare(
        `UPDATE subscriptions
            SET status = 'past_due', trial_ends_at = NULL, current_period_end = ?, activated_at = ?
          WHERE tenant_id = ?`,
      )
      .run(lewat, new Date(Date.now() - 400 * 86_400_000).toISOString(), tenantId);

    const flags = loadFeatureFlags(harness.db, tenantId, tenantStatus(tenantId));
    expect(flags.readOnly).toBe(true);
    // Pernah dibayar → pesan perpanjangan. Inilah beda yang dijaga kolom `activated_at`.
    expect(flags.readOnlyReason).toBe('subscription_expired');
  });

  it('TC-TRL-11 — uji coba yang berakhir tetap disebut kedaluwarsa', () => {
    const { tenantId } = provisionTenant(harness, { slug: 'cobax', trialDays: 1 });
    harness.db
      .prepare("UPDATE subscriptions SET trial_ends_at = ? WHERE tenant_id = ?")
      .run(new Date(Date.now() - 86_400_000).toISOString(), tenantId);

    const flags = loadFeatureFlags(harness.db, tenantId, tenantStatus(tenantId));
    expect(flags.readOnly).toBe(true);
    // Uji coba memang belum pernah dibayar, tetapi masa pakainya sah — pesannya harus
    // berbunyi "uji coba berakhir", bukan "belum aktif".
    expect(flags.readOnlyReason).toBe('subscription_expired');
  });
});
