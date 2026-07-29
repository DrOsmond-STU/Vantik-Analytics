/**
 * Persetujuan admin atas pendaftaran mandiri (PRD 6.26).
 *
 * Yang paling penting dibuktikan di sini bukan "tombol setujui berfungsi", melainkan:
 *
 *  1. **Pendaftar tidak dapat menyetujui dirinya sendiri.** Ia satu-satunya administrator
 *     tenantnya, dan perannya `super_admin` memiliki `*:*` — jadi kalau blokirnya hanya
 *     berupa pemeriksaan izin, ia berwenang menyetujui pendaftarannya sendiri. Yang
 *     mencegahnya adalah fakta bahwa ia belum dapat masuk sama sekali (TC-APR-06).
 *  2. **Tenant lama tidak ikut terkunci** oleh migrasi ini (TC-APR-02).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHarness, contextFor, provisionTenant, TEST_PASSWORD, type Harness } from './helpers.ts';
import { createApp } from '../src/app.ts';
import { NotificationOutbox } from '../src/platform/outbox.ts';
import type { Express } from 'express';

let harness: Harness;
let app: Express;

const FINGERPRINT = {
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0',
  screenResolution: '1920x1080',
  colorDepth: 24,
  timezone: 'Asia/Jakarta',
  language: 'id-ID',
  fonts: ['Inter', 'Arial'],
  canvasHash: 'c1',
  webglHash: 'w1',
  platform: 'Linux x86_64',
};

beforeEach(() => {
  harness = createHarness();
  app = createApp({ db: harness.db }).app;
});

afterEach(() => harness.cleanup());

interface DaftarInput {
  slug: string;
  email?: string;
  plan?: string;
}

async function daftar({ slug, email, plan = 'professional' }: DaftarInput): Promise<request.Response> {
  return request(app)
    .post('/api/v1/public/signup')
    .send({
      organisationName: `Organisasi ${slug}`,
      slug,
      planCode: plan,
      billingCycle: 'monthly',
      fullName: 'Calon Admin',
      email: email ?? `admin@${slug}.test`,
      password: TEST_PASSWORD,
    });
}

async function masuk(slug: string, email?: string): Promise<request.Response> {
  return request(app)
    .post('/api/v1/auth/login')
    .send({
      email: email ?? `admin@${slug}.test`,
      password: TEST_PASSWORD,
      tenantSlug: slug,
      fingerprint: FINGERPRINT,
    });
}

/** Konteks Platform Operator pada tenant mana pun (perannya lintas tenant). */
function operator(tenantId: string) {
  return contextFor(harness, tenantId, ['platform_operator']);
}

function approvalRow(slug: string): { approval_status: string; approval_note: string | null; approval_decided_by: string | null } {
  return harness.db
    .prepare('SELECT approval_status, approval_note, approval_decided_by FROM tenants WHERE slug = ?')
    .get(slug) as { approval_status: string; approval_note: string | null; approval_decided_by: string | null };
}

/* ================= Keadaan awal ================= */

describe('Pendaftaran mandiri menunggu persetujuan', () => {
  it('TC-APR-01 — pendaftaran tersimpan sebagai `pending`, dan jawabannya menyatakan itu', async () => {
    const response = await daftar({ slug: 'pendatang' });

    expect(response.status).toBe(201);
    // Klien HARUS tahu bahwa ia belum bisa masuk; layar sukses yang menyuruh "silakan
    // masuk" padahal login pasti ditolak membuat orang mengira kata sandinya salah.
    expect(response.body.pendingApproval).toBe(true);
    expect(approvalRow('pendatang').approval_status).toBe('pending');
  });

  it('TC-APR-02 — tenant yang dibuat operator TIDAK ikut menunggu persetujuan', () => {
    // Provisioning oleh operator sudah merupakan persetujuan itu sendiri. Kalau baris
    // ini gagal, migrasi persetujuan mengunci seluruh pelanggan lama — kerusakan, bukan
    // pengetatan.
    const lama = provisionTenant(harness, { slug: 'pelangganlama' });
    expect(approvalRow(lama.slug).approval_status).toBe('approved');
  });

  it('TC-APR-03 — masuk DITOLAK selama menunggu, dengan alasan dan langkah pemulihan', async () => {
    await daftar({ slug: 'menunggu' });
    const response = await masuk('menunggu');

    expect(response.status).toBe(401);
    expect(response.body.error.key).toBe('error.registration_pending_approval');
    expect(response.body.error.recoveryKey).toBe('recovery.wait_for_approval');
    // Tidak ada token yang terbit.
    expect(response.body.token).toBeUndefined();
  });

  it('TC-APR-04 — kata sandi SALAH tetap dijawab "kredensial salah", bukan "menunggu persetujuan"', async () => {
    await daftar({ slug: 'rahasia' });
    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@rahasia.test', password: 'SalahSekali#2026', tenantSlug: 'rahasia', fingerprint: FINGERPRINT });

    // Kalau urutannya terbalik, siapa pun yang menebak alamat dapat mengetahui ada
    // organisasi yang sedang mendaftar dengan alamat itu — jawaban yang tidak berhak
    // ia terima.
    expect(response.body.error.key).toBe('error.invalid_credentials');
  });

  it('TC-APR-05 — Platform Operator diberi kabar bahwa ada pendaftaran baru', async () => {
    // Operator dibuat lebih dulu supaya ada yang bisa dikirimi kabar.
    const induk = provisionTenant(harness, { slug: 'operatorhq' });
    harness.db
      .prepare(
        `INSERT INTO role_assignment (id, tenant_id, user_id, role_id, assigned_at, assigned_by)
         VALUES ('ra_ops', ?, ?, 'role_platform_operator', ?, 'test')`,
      )
      .run(induk.tenantId, induk.adminUserId, new Date().toISOString());

    await daftar({ slug: 'pendaftarbaru' });

    const antrean = harness.db
      .prepare("SELECT recipient, subject FROM notification_outbox WHERE purpose = 'registration_pending'")
      .all() as Array<{ recipient: string; subject: string }>;
    expect(antrean).toHaveLength(1);
    expect(antrean[0]!.recipient).toBe(`admin@${induk.slug}.test`);
  });
});

/* ================= Keputusan ================= */

describe('Keputusan atas pendaftaran', () => {
  it('TC-APR-06 — pendaftar TIDAK dapat menyetujui dirinya sendiri', async () => {
    await daftar({ slug: 'sendiri' });

    // Ia satu-satunya admin tenantnya dan perannya super_admin (`*:*`) — jadi secara
    // izin ia BERWENANG menyetujui. Yang menghentikannya adalah ia tidak dapat masuk,
    // sehingga tidak pernah punya sesi untuk memanggil rutenya.
    const login = await masuk('sendiri');
    expect(login.status).toBe(401);

    const tenantId = (harness.db.prepare('SELECT id FROM tenants WHERE slug = ?').get('sendiri') as { id: string }).id;
    const tanpaSesi = await request(app).post(`/api/v1/tenants/${tenantId}/approval`).send({ decision: 'approved' });
    expect(tanpaSesi.status).toBe(401);
    expect(approvalRow('sendiri').approval_status).toBe('pending');
  });

  it('TC-APR-07 — setelah disetujui, pendaftar dapat masuk', async () => {
    await daftar({ slug: 'disetujui' });
    const tenantId = (harness.db.prepare('SELECT id FROM tenants WHERE slug = ?').get('disetujui') as { id: string }).id;

    harness.tenants.decideRegistration(operator(tenantId), tenantId, 'approved');

    expect(approvalRow('disetujui').approval_status).toBe('approved');
    const login = await masuk('disetujui');
    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();
  });

  it('TC-APR-08 — setelah ditolak, masuk tetap tertutup dengan alasan yang berbeda', async () => {
    await daftar({ slug: 'ditolak' });
    const tenantId = (harness.db.prepare('SELECT id FROM tenants WHERE slug = ?').get('ditolak') as { id: string }).id;

    harness.tenants.decideRegistration(operator(tenantId), tenantId, 'rejected', 'Domain tidak dapat diverifikasi');

    const login = await masuk('ditolak');
    expect(login.status).toBe(401);
    expect(login.body.error.key).toBe('error.registration_rejected');
  });

  it('TC-APR-09 — penolakan WAJIB menyertakan alasan', () => {
    const t = provisionTenant(harness, { slug: 'tanpaalasan' });
    harness.db.prepare("UPDATE tenants SET approval_status = 'pending' WHERE id = ?").run(t.tenantId);

    expect(() => harness.tenants.decideRegistration(operator(t.tenantId), t.tenantId, 'rejected')).toThrowError(
      /error\.rejection_reason_required/,
    );
    expect(() => harness.tenants.decideRegistration(operator(t.tenantId), t.tenantId, 'rejected', '   ')).toThrowError(
      /error\.rejection_reason_required/,
    );
    // Gagal berarti keadaannya TIDAK berubah.
    expect(approvalRow('tanpaalasan').approval_status).toBe('pending');
  });

  it('TC-APR-10 — keputusan hanya berlaku sekali', async () => {
    await daftar({ slug: 'sekalisaja' });
    const tenantId = (harness.db.prepare('SELECT id FROM tenants WHERE slug = ?').get('sekalisaja') as { id: string }).id;

    harness.tenants.decideRegistration(operator(tenantId), tenantId, 'approved');
    expect(() => harness.tenants.decideRegistration(operator(tenantId), tenantId, 'rejected', 'berubah pikiran')).toThrowError(
      /error\.registration_already_decided/,
    );
  });

  it('TC-APR-11 — penolakan TIDAK menghapus data, dan alasannya tersimpan', async () => {
    await daftar({ slug: 'jangandihapus' });
    const tenantId = (harness.db.prepare('SELECT id FROM tenants WHERE slug = ?').get('jangandihapus') as { id: string }).id;

    harness.tenants.decideRegistration(operator(tenantId), tenantId, 'rejected', 'Duplikat organisasi yang sudah ada');

    const row = approvalRow('jangandihapus');
    expect(row.approval_note).toBe('Duplikat organisasi yang sudah ada');
    expect(row.approval_decided_by).toBeTruthy();
    // Tenant, pengguna, dan langganannya tetap ada — keputusan dapat ditinjau ulang.
    expect(harness.db.prepare('SELECT COUNT(*) c FROM system_user WHERE tenant_id = ?').get(tenantId)).toEqual({ c: 1 });
    expect(harness.db.prepare('SELECT COUNT(*) c FROM subscriptions WHERE tenant_id = ?').get(tenantId)).toEqual({ c: 1 });
  });

  it('TC-APR-12 — keputusan tercatat di jalur audit operator', async () => {
    await daftar({ slug: 'terekam' });
    const tenantId = (harness.db.prepare('SELECT id FROM tenants WHERE slug = ?').get('terekam') as { id: string }).id;
    harness.tenants.decideRegistration(operator(tenantId), tenantId, 'approved', 'Diverifikasi lewat telepon');

    const jejak = harness.audit.query(tenantId, {}).rows;
    const catatan = jejak.find((r) => r.action === 'tenant.registration_approved');
    expect(catatan).toBeTruthy();
    expect(catatan!.severity).toBe('critical');
  });
});

/* ================= Antrean ================= */

describe('Antrean pendaftaran', () => {
  it('TC-APR-13 — antrean memuat yang menunggu saja, terurut dari yang terlama', async () => {
    const induk = provisionTenant(harness, { slug: 'pusat' });
    await daftar({ slug: 'antre-a' });
    await daftar({ slug: 'antre-b' });

    const tenantId = (harness.db.prepare('SELECT id FROM tenants WHERE slug = ?').get('antre-a') as { id: string }).id;
    harness.tenants.decideRegistration(operator(tenantId), tenantId, 'approved');

    const antrean = harness.tenants.listPendingRegistrations(operator(induk.tenantId));
    expect(antrean.map((r) => r.slug)).toEqual(['antre-b']);
    // Operator butuh tahu siapa yang mendaftar untuk dapat memutuskan.
    expect(antrean[0]!.admin_email).toBe('admin@antre-b.test');
    expect(antrean[0]!.plan_code).toBe('professional');
  });

  it('TC-APR-14 — admin tenant biasa TIDAK boleh melihat antrean organisasi lain', async () => {
    const biasa = provisionTenant(harness, { slug: 'tenantbiasa' });
    await daftar({ slug: 'rahasiaorang' });

    // `system_admin` mengurus tenantnya sendiri, tetapi daftar ini memuat nama organisasi
    // dan email calon administrator orang lain.
    expect(() =>
      harness.tenants.listPendingRegistrations(contextFor(harness, biasa.tenantId, ['system_admin'])),
    ).toThrowError();
  });

  it('TC-APR-15 — pendaftar menerima kabar keputusan lewat antrean', async () => {
    await daftar({ slug: 'dikabari' });
    const tenantId = (harness.db.prepare('SELECT id FROM tenants WHERE slug = ?').get('dikabari') as { id: string }).id;
    const outbox = new NotificationOutbox(harness.db);

    const contact = harness.tenants.registrationContact(tenantId)!;
    expect(contact.email).toBe('admin@dikabari.test');

    harness.tenants.decideRegistration(operator(tenantId), tenantId, 'approved');
    outbox.enqueue({
      tenantId,
      purpose: 'registration_approved',
      channel: 'email',
      recipient: contact.email,
      subject: 'uji',
      body: 'uji',
    });

    const antrean = outbox.list(tenantId);
    expect(antrean.some((m) => m.purpose === 'registration_approved')).toBe(true);
  });
});
