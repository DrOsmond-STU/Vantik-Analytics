/**
 * Permukaan publik: katalog paket, pendaftaran mandiri, dan pemulihan kata sandi.
 *
 * Ketiganya berada DI LUAR `authenticate()`, jadi satu-satunya yang menjaganya adalah
 * batas laju, validasi masukan, dan keputusan sadar tentang apa yang boleh dibocorkan
 * jawabannya. Uji di berkas ini menguji tepat hal-hal itu — bukan bahwa jalurnya
 * "berfungsi", melainkan bahwa ia tidak memberi lebih dari yang seharusnya:
 *
 *  - formulir lupa sandi tidak dapat dipakai memetakan alamat mana yang punya akun;
 *  - token pemulihan tidak pernah kembali lewat HTTP, hanya lewat antrean berizin;
 *  - pendaftaran tidak dapat dipakai membuat ruang kerja tanpa batas;
 *  - kebijakan kata sandi berlaku sama di jalur pemulihan.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import type { Db } from '../src/platform/db.ts';
import { NotificationOutbox } from '../src/platform/outbox.ts';
import { TEST_PASSWORD } from './helpers.ts';

const SANDI_BARU = 'SandiPemulihan#2026';

let app: Express;
let db: Db;
let dir: string;
let outbox: NotificationOutbox;
let sebelumnya: string | undefined;

beforeEach(() => {
  sebelumnya = process.env.VANTIK_SELF_SIGNUP;
  delete process.env.VANTIK_SELF_SIGNUP;
  dir = mkdtempSync(join(tmpdir(), 'vantik-public-'));
  const created = createApp({
    paths: { main: join(dir, 'm.db'), audit: join(dir, 'a.db'), vault: join(dir, 'v.db') },
  });
  app = created.app;
  db = created.db;
  outbox = new NotificationOutbox(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  if (sebelumnya === undefined) delete process.env.VANTIK_SELF_SIGNUP;
  else process.env.VANTIK_SELF_SIGNUP = sebelumnya;
});

/** Mendaftarkan satu organisasi lewat jalur publik dan mengembalikan slug-nya. */
async function daftar(slug: string, email = `admin@${slug}.test`): Promise<number> {
  const response = await request(app).post('/api/v1/public/signup').send({
    organisationName: `Organisasi ${slug}`,
    slug,
    planCode: 'professional',
    billingCycle: 'monthly',
    fullName: 'Calon Pelanggan',
    email,
    password: TEST_PASSWORD,
  });
  return response.status;
}

/**
 * Menyetujui pendaftaran langsung di basis data.
 *
 * Jalur persetujuan lewat HTTP diuji tersendiri di `registration-approval.test.ts`;
 * di sini ia hanya prasyarat, jadi memakainya lewat rute akan menambah kebisingan
 * (butuh operator, sesi, MFA) tanpa menguji apa pun yang belum diuji di sana.
 */
function setujui(slug: string): void {
  db.prepare("UPDATE tenants SET approval_status = 'approved' WHERE slug = ?").run(slug);
}

async function masukSebagai(slug: string, email = `admin@${slug}.test`, password = TEST_PASSWORD) {
  return request(app)
    .post('/api/v1/auth/login')
    .send({
      email,
      password,
      tenantSlug: slug,
      fingerprint: {
        userAgent: 'Mozilla/5.0 Daftar',
        screenResolution: '1920x1080',
        colorDepth: 24,
        timezone: 'Asia/Jakarta',
        language: 'id',
        fonts: ['Inter'],
        canvasHash: 'c-daftar',
        webglHash: 'w-daftar',
        platform: 'Linux x86_64',
      },
    });
}

describe('Katalog paket publik', () => {
  it('TC-PUB-01 — paket dapat dibaca tanpa sesi, untuk halaman depan', async () => {
    const response = await request(app).get('/api/v1/public/plans');

    expect(response.status).toBe(200);
    expect(response.body.plans.length).toBeGreaterThanOrEqual(3);
    const starter = response.body.plans.find((p: { code: string }) => p.code === 'starter');
    expect(starter.monthlyPrice).toBe(0);
    expect(starter.moduleCount).toBeGreaterThan(0);
  });

  it('TC-PUB-02 — katalog TIDAK membocorkan apa pun tentang instalasi ini', async () => {
    await daftar('rahasiaorg');
    const response = await request(app).get('/api/v1/public/plans');

    // Halaman depan hanya perlu tahu apa yang dijual. Jumlah pelanggan, nama tenant, atau
    // statistik pemakaian adalah informasi kompetitif milik operator, bukan pengunjung.
    const payload = JSON.stringify(response.body);
    expect(payload).not.toContain('rahasiaorg');
    expect(payload).not.toContain('tenant_id');
    // Daftar ini sengaja TERTUTUP: menambah medan di sini menuntut keputusan sadar
    // bahwa medan itu memang boleh dilihat siapa saja di internet.
    expect(Object.keys(response.body).sort()).toEqual(['currency', 'cycles', 'plans', 'signupEnabled']);
  });

  it('TC-PUB-03 — katalog menyatakan apakah pendaftaran mandiri dibuka', async () => {
    process.env.VANTIK_SELF_SIGNUP = 'off';
    const mati = await request(app).get('/api/v1/public/plans');
    // Halaman depan memakai penanda ini untuk menyembunyikan ajakan mendaftar, sehingga
    // tidak ada tombol yang mengarah ke penolakan.
    expect(mati.body.signupEnabled).toBe(false);

    process.env.VANTIK_SELF_SIGNUP = 'on';
    const hidup = await request(app).get('/api/v1/public/plans');
    expect(hidup.body.signupEnabled).toBe(true);
  });
});

describe('Pendaftaran mandiri', () => {
  it('TC-PUB-04 — pengunjung berlangganan, lalu MENUNGGU persetujuan sebelum dapat masuk', async () => {
    expect(await daftar('pelangganbaru')).toBe(201);

    const ditolak = await masukSebagai('pelangganbaru');
    expect(ditolak.status).toBe(401);
    expect(ditolak.body.error.key).toBe('error.registration_pending_approval');

    // Persetujuan admin membuka pintunya — dan hanya itu yang membukanya.
    setujui('pelangganbaru');

    const login = await masukSebagai('pelangganbaru');
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect(login.body.token).toBeTruthy();
  });

  it('TC-PUB-05 — slug yang sudah dipakai ditolak 409, bukan menimpa tenant lain', async () => {
    expect(await daftar('bentrok')).toBe(201);
    expect(await daftar('bentrok', 'orang.lain@bentrok.test')).toBe(409);
  });

  it('TC-PUB-06 — kebijakan kata sandi berlaku di pendaftaran', async () => {
    const response = await request(app).post('/api/v1/public/signup').send({
      organisationName: 'Sandi Lemah',
      slug: 'sandilemah',
      planCode: 'professional',
      billingCycle: 'monthly',
      fullName: 'Calon',
      email: 'calon@sandilemah.test',
      password: 'pendek',
    });
    expect(response.status).toBe(400);
    expect(response.body.error.key).toBe('error.password_too_short');
  });

  it('TC-PUB-07 — paket yang tidak ada ditolak, tidak diam-diam jatuh ke paket termurah', async () => {
    const response = await request(app).post('/api/v1/public/signup').send({
      organisationName: 'Paket Karangan',
      slug: 'paketkarangan',
      planCode: 'unlimited-gratis-selamanya',
      billingCycle: 'monthly',
      fullName: 'Calon',
      email: 'calon@paketkarangan.test',
      password: TEST_PASSWORD,
    });
    expect(response.status).toBe(400);
    expect(response.body.error.key).toBe('error.plan_unknown');
  });

  it('TC-PUB-08 — pendaftaran beruntun dibatasi laju', async () => {
    // Setiap pendaftaran yang BERHASIL membuat tenant beserta seluruh baris awalnya.
    // Tanpa batas, satu skrip dapat memenuhi berkas SQLite di shared hosting.
    let ditolak = 0;
    for (let i = 0; i < 6; i++) {
      if ((await daftar(`banjir${i}`)) === 429) ditolak++;
    }
    expect(ditolak).toBeGreaterThan(0);
  });

  it('TC-PUB-09 — pendaftaran dapat dimatikan untuk pemasangan internal', async () => {
    process.env.VANTIK_SELF_SIGNUP = 'off';
    const response = await request(app).post('/api/v1/public/signup').send({
      organisationName: 'Ditolak',
      slug: 'ditolak',
      planCode: 'professional',
      billingCycle: 'monthly',
      fullName: 'Calon',
      email: 'calon@ditolak.test',
      password: TEST_PASSWORD,
    });
    expect(response.status).toBe(403);
    expect(response.body.error.key).toBe('error.signup_disabled');
  });
});

describe('Pemulihan kata sandi', () => {
  /** Membaca token dari antrean — satu-satunya tempat ia ada dalam bentuk terbaca. */
  function tokenDariOutbox(tenantId: string): string {
    const entry = outbox.pending(tenantId).find((e) => e.purpose === 'password_reset');
    expect(entry, 'pesan pemulihan tidak masuk antrean').toBeTruthy();
    const match = /Kode pemulihan kata sandi Anda: (\S+)/.exec(entry!.body);
    expect(match, 'badan pesan tidak memuat token').toBeTruthy();
    return match![1]!;
  }

  function tenantIdOf(slug: string): string {
    return (db.prepare('SELECT id FROM tenants WHERE slug = ?').get(slug) as { id: string }).id;
  }

  it('TC-PUB-10 — perjalanan lengkap: lupa → token dari antrean → sandi baru berlaku', async () => {
    await daftar('pulih');
    setujui('pulih'); // pemulihan kata sandi diuji pada ruang kerja yang sudah aktif

    const minta = await request(app)
      .post('/api/v1/auth/password-reset/request')
      .send({ email: 'admin@pulih.test', tenantSlug: 'pulih' });
    expect(minta.status).toBe(200);

    const token = tokenDariOutbox(tenantIdOf('pulih'));
    const konfirmasi = await request(app)
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token, newPassword: SANDI_BARU });
    expect(konfirmasi.status, JSON.stringify(konfirmasi.body)).toBe(200);

    const fingerprint = {
      userAgent: 'Mozilla/5.0 Pulih',
      screenResolution: '1920x1080',
      colorDepth: 24,
      timezone: 'Asia/Jakarta',
      language: 'id',
      fonts: ['Inter'],
      canvasHash: 'c-pulih',
      webglHash: 'w-pulih',
      platform: 'Linux x86_64',
    };
    const lama = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@pulih.test', password: TEST_PASSWORD, tenantSlug: 'pulih', fingerprint });
    expect(lama.status).toBe(401);

    const baru = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@pulih.test', password: SANDI_BARU, tenantSlug: 'pulih', fingerprint });
    expect(baru.body.token).toBeTruthy();
  });

  it('TC-PUB-11 — jawaban SAMA untuk alamat terdaftar dan tidak terdaftar', async () => {
    await daftar('enumerasi');

    const ada = await request(app)
      .post('/api/v1/auth/password-reset/request')
      .send({ email: 'admin@enumerasi.test', tenantSlug: 'enumerasi' });
    const tidakAda = await request(app)
      .post('/api/v1/auth/password-reset/request')
      .send({ email: 'tidak.pernah.ada@enumerasi.test', tenantSlug: 'enumerasi' });

    // Formulir yang menjawab berbeda adalah alat pemetaan gratis: siapa pun dapat menguji
    // daftar alamat dan tahu mana yang punya akun di organisasi ini.
    expect(tidakAda.status).toBe(ada.status);
    expect(JSON.stringify(tidakAda.body)).toBe(JSON.stringify(ada.body));
  });

  it('TC-PUB-12 — token TIDAK pernah dikembalikan lewat HTTP', async () => {
    await daftar('bocor');
    const response = await request(app)
      .post('/api/v1/auth/password-reset/request')
      .send({ email: 'admin@bocor.test', tenantSlug: 'bocor' });

    const token = tokenDariOutbox(tenantIdOf('bocor'));
    // Kalau token ikut di respons, formulir ini menjadi cara merebut akun orang lain
    // hanya dengan mengetahui alamat emailnya.
    expect(JSON.stringify(response.body)).not.toContain(token);
    expect(Object.keys(response.body).sort()).toEqual(['accepted', 'transportConfigured']);
  });

  it('TC-PUB-13 — token hanya dapat dipakai sekali', async () => {
    await daftar('sekalipakai');
    await request(app)
      .post('/api/v1/auth/password-reset/request')
      .send({ email: 'admin@sekalipakai.test', tenantSlug: 'sekalipakai' });
    const token = tokenDariOutbox(tenantIdOf('sekalipakai'));

    expect((await request(app).post('/api/v1/auth/password-reset/confirm').send({ token, newPassword: SANDI_BARU })).status).toBe(200);
    const kedua = await request(app)
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token, newPassword: 'SandiKetiga#2026' });
    expect(kedua.status).toBe(400);
    expect(kedua.body.error.key).toBe('error.reset_token_invalid');
  });

  it('TC-PUB-14 — permintaan baru mematikan token lama', async () => {
    await daftar('tokenlama');
    const tenantId = tenantIdOf('tokenlama');
    await request(app)
      .post('/api/v1/auth/password-reset/request')
      .send({ email: 'admin@tokenlama.test', tenantSlug: 'tokenlama' });
    const pertama = tokenDariOutbox(tenantId);

    await request(app)
      .post('/api/v1/auth/password-reset/request')
      .send({ email: 'admin@tokenlama.test', tenantSlug: 'tokenlama' });

    // Setiap permintaan baru yang menambah token hidup memperbesar permukaan: cukup satu
    // yang bocor untuk merebut akun.
    const gagal = await request(app)
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token: pertama, newPassword: SANDI_BARU });
    expect(gagal.status).toBe(400);
  });

  it('TC-PUB-15 — token kedaluwarsa ditolak', async () => {
    await daftar('kedaluwarsa');
    await request(app)
      .post('/api/v1/auth/password-reset/request')
      .send({ email: 'admin@kedaluwarsa.test', tenantSlug: 'kedaluwarsa' });
    const token = tokenDariOutbox(tenantIdOf('kedaluwarsa'));

    db.prepare("UPDATE password_reset_requests SET expires_at = ?")
      .run(new Date(Date.now() - 1000).toISOString());

    const response = await request(app)
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token, newPassword: SANDI_BARU });
    expect(response.status).toBe(400);
  });

  it('TC-PUB-16 — token karangan ditolak tanpa membocorkan apakah ia pernah ada', async () => {
    const response = await request(app)
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token: 'token-yang-tidak-pernah-diterbitkan', newPassword: SANDI_BARU });
    expect(response.status).toBe(400);
    expect(response.body.error.key).toBe('error.reset_token_invalid');
  });

  it('TC-PUB-17 — kebijakan kata sandi berlaku juga di jalur pemulihan', async () => {
    await daftar('sandipulih');
    await request(app)
      .post('/api/v1/auth/password-reset/request')
      .send({ email: 'admin@sandipulih.test', tenantSlug: 'sandipulih' });
    const token = tokenDariOutbox(tenantIdOf('sandipulih'));

    const lemah = await request(app)
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token, newPassword: 'pendek' });
    expect(lemah.status).toBe(400);
    expect(lemah.body.error.key).toBe('error.password_too_short');

    // Token TIDAK ikut terbakar oleh percobaan yang ditolak kebijakan: pengguna harus
    // dapat mencoba lagi dengan kata sandi yang memenuhi syarat, bukan mengulang seluruh
    // alur dari awal karena salah ketik.
    const benar = await request(app)
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token, newPassword: SANDI_BARU });
    expect(benar.status).toBe(200);
  });

  it('TC-PUB-18 — pemulihan mencabut sesi yang sedang berjalan', async () => {
    await daftar('cabutsesi');
    setujui('cabutsesi'); // butuh sesi yang benar-benar hidup untuk dapat dicabut
    const fingerprint = {
      userAgent: 'Mozilla/5.0 Cabut',
      screenResolution: '1920x1080',
      colorDepth: 24,
      timezone: 'Asia/Jakarta',
      language: 'id',
      fonts: ['Inter'],
      canvasHash: 'c-cabut',
      webglHash: 'w-cabut',
      platform: 'Linux x86_64',
    };
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@cabutsesi.test', password: TEST_PASSWORD, tenantSlug: 'cabutsesi', fingerprint });
    const token = login.body.token as string;
    expect((await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`)).status).toBe(200);

    await request(app)
      .post('/api/v1/auth/password-reset/request')
      .send({ email: 'admin@cabutsesi.test', tenantSlug: 'cabutsesi' });
    await request(app)
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token: tokenDariOutbox(tenantIdOf('cabutsesi')), newPassword: SANDI_BARU });

    // Pemulihan dipakai justru ketika pemilik akun kehilangan kendali; sesi lama yang
    // tetap hidup menyisakan pintu bagi siapa pun yang sudah masuk lebih dulu.
    expect((await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });
});
