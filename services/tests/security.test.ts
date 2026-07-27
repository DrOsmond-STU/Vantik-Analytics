/**
 * Pengujian keamanan yang MEMBLOKIR RILIS.
 *
 * SECURITY.md 16.1: "Pengujian otomatis lintas-tenant wajib ada di pipeline: mencoba
 * mengakses data tenant lain harus selalu gagal, dan pengujian ini memblokir rilis
 * bila gagal."
 *
 * TESTING.md Bagian 4: matriks pengujian negatif RBAC & Row-Level Security.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contextFor, createHarness, createUser, provisionTenant, syntheticCsv, type Harness } from './helpers.ts';
import { DatasetService } from '../src/data-platform-service/datasets.ts';
import { AuthorizationService } from '../src/identity-service/index.ts';
import { ForbiddenError, NotFoundError } from '../src/platform/errors.ts';
import { TenantScopedDb } from '../src/platform/tenancy.ts';
import { can, resolvePermissions, STANDARD_ROLES } from '../src/platform/rbac.ts';

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});
afterEach(() => harness.cleanup());

describe('Isolasi tenant (SECURITY.md 16.1) — memblokir rilis bila gagal', () => {
  it('TC-TEN-01 — kueri satu tenant tidak pernah mengembalikan data tenant lain', () => {
    const a = provisionTenant(harness, { slug: 'alpha1' });
    const b = provisionTenant(harness, { slug: 'bravo1' });

    const ctxA = contextFor(harness, a.tenantId, ['super_admin']);
    const ctxB = contextFor(harness, b.tenantId, ['super_admin']);

    new DatasetService(ctxA).upload({ filename: 'alpha.csv', content: Buffer.from(syntheticCsv({ rows: 5 })) });
    new DatasetService(ctxB).upload({ filename: 'bravo.csv', content: Buffer.from(syntheticCsv({ rows: 5 })) });

    const seenByA = new DatasetService(ctxA).list();
    const seenByB = new DatasetService(ctxB).list();

    expect(seenByA).toHaveLength(1);
    expect(seenByB).toHaveLength(1);
    expect(seenByA[0]!.name).toBe('alpha');
    expect(seenByB[0]!.name).toBe('bravo');
  });

  it('TC-TEN-02 — mengambil objek milik tenant lain dengan ID benar tetap gagal', () => {
    const a = provisionTenant(harness, { slug: 'alpha2' });
    const b = provisionTenant(harness, { slug: 'bravo2' });

    const ctxA = contextFor(harness, a.tenantId, ['super_admin']);
    const ctxB = contextFor(harness, b.tenantId, ['super_admin']);

    const uploaded = new DatasetService(ctxA).upload({
      filename: 'rahasia.csv',
      content: Buffer.from(syntheticCsv({ rows: 5 })),
    });

    // Tenant B mengetahui ID persisnya, namun tetap tidak boleh mendapatkannya.
    expect(() => new DatasetService(ctxB).get(uploaded.dataset.id)).toThrow(NotFoundError);
  });

  it('TC-TEN-03 — tenant_id yang dikirim pemanggil diabaikan; konteks sesi yang menang', () => {
    const a = provisionTenant(harness, { slug: 'alpha3' });
    const b = provisionTenant(harness, { slug: 'bravo3' });
    const ctxA = contextFor(harness, a.tenantId, ['super_admin']);

    // Mencoba menyuntikkan tenant_id tenant lain pada INSERT.
    ctxA.db.insert('employee_master', {
      id: 'emp_injected',
      tenant_id: b.tenantId,
      full_name: 'Penyusup',
      nik: 'NIK-INJ',
      division: 'X',
      position: 'Y',
      email: 'inj@test',
      phone: null,
      status: 'active',
      status_changed_at: null,
      access_review_due_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const stored = harness.db.prepare('SELECT tenant_id FROM employee_master WHERE id = ?').get('emp_injected') as {
      tenant_id: string;
    };
    expect(stored.tenant_id).toBe(a.tenantId);
    expect(stored.tenant_id).not.toBe(b.tenantId);
  });

  it('TC-TEN-04 — SQL mentah tanpa filter tenant ditolak sebelum dieksekusi', () => {
    const a = provisionTenant(harness, { slug: 'alpha4' });
    const ctx = contextFor(harness, a.tenantId, ['super_admin']);

    expect(() => ctx.db.raw('SELECT * FROM dataset_catalog')).toThrow(/tenant_id/i);
    expect(() => ctx.db.raw('SELECT * FROM dataset_catalog WHERE tenant_id = :tenant_id')).not.toThrow();
  });

  it('TC-TEN-05 — konteks tanpa tenant terverifikasi ditolak (fail secure)', () => {
    expect(() => new TenantScopedDb(harness.db, '')).toThrow(/verified tenant/i);
  });

  it('TC-TEN-06 — globalRead() menolak tabel yang memuat data tenant', () => {
    const a = provisionTenant(harness, { slug: 'alpha6' });
    const ctx = contextFor(harness, a.tenantId, ['super_admin']);
    expect(() => ctx.db.globalRead('dataset_catalog')).toThrow(/globalRead\(\) refused/);
    expect(() => ctx.db.globalRead('plans')).not.toThrow();
  });
});

describe('RBAC negatif (TESTING.md Bagian 4)', () => {
  it('TC-RBAC-01 — Supervisor mengakses Otorisasi User via API langsung ditolak 403 dan tercatat', () => {
    const tenant = provisionTenant(harness);
    const supervisorId = createUser(harness, tenant.tenantId, 'supervisor@test.id', 'supervisor');
    const ctx = contextFor(harness, tenant.tenantId, ['supervisor'], { userId: supervisorId });

    expect(() => new AuthorizationService(ctx).listUsers()).toThrow(ForbiddenError);

    // Percobaan akses ditolak WAJIB tercatat sebagai potensi insiden (SECURITY.md 9).
    const { rows } = harness.audit.query(tenant.tenantId, { outcome: 'denied' });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.action).toBe('access.denied');
    expect(rows[0]!.module).toBe('Otorisasi User');
  });

  it('TC-RBAC-02 — deny overrides allow diuji eksplisit, bukan diasumsikan', () => {
    // Super Admin punya `*:*` tetapi ditolak eksplisit untuk audit:write.
    const superAdmin = STANDARD_ROLES.find((r) => r.code === 'super_admin')!;
    const effective = resolvePermissions([superAdmin]);

    expect(can(effective, 'dataset:write')).toBe(true);
    expect(can(effective, 'audit:write')).toBe(false);
    expect(can(effective, 'audit:delete')).toBe(false);
  });

  it('TC-RBAC-03 — dua peran dengan hak bertentangan: penolakan menang', () => {
    const auditor = STANDARD_ROLES.find((r) => r.code === 'auditor')!;
    const analyst = STANDARD_ROLES.find((r) => r.code === 'business_analyst')!;

    // Business Analyst mengizinkan dashboard:write; Auditor menolaknya eksplisit.
    const effective = resolvePermissions([analyst, auditor]);
    expect(can(effective, 'dashboard:write')).toBe(false);
    expect(can(effective, 'dashboard:read')).toBe(true);
  });

  it('TC-RBAC-04 — Data Engineer tidak dapat menyertifikasi dataset (kewenangan Data Steward)', () => {
    const engineer = STANDARD_ROLES.find((r) => r.code === 'data_engineer')!;
    const effective = resolvePermissions([engineer]);
    expect(can(effective, 'dataset:upload')).toBe(true);
    expect(can(effective, 'dataquality:certify')).toBe(false);
  });

  it('TC-RBAC-05 — Platform Operator tidak punya akses baca data analitik pelanggan', () => {
    const operator = STANDARD_ROLES.find((r) => r.code === 'platform_operator')!;
    const effective = resolvePermissions([operator]);
    expect(can(effective, 'tenant:provision')).toBe(true);
    expect(can(effective, 'dataset:read')).toBe(false);
    expect(can(effective, 'executive_cockpit:read')).toBe(false);
  });

  it('TC-RBAC-06 — pengguna tidak dapat mengubah hak aksesnya sendiri', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin'], { userId: tenant.adminUserId });
    expect(() => new AuthorizationService(ctx).setRoles(tenant.adminUserId, ['auditor'])).toThrow(
      /cannot_change_own_access/,
    );
  });

  it('TC-RBAC-07 — aksi sensitif menuntut re-autentikasi segar', () => {
    const tenant = provisionTenant(harness);
    const other = createUser(harness, tenant.tenantId, 'other@test.id', 'business_analyst');
    // freshAuth: false → tidak ada re-autentikasi dalam jendela waktu.
    const stale = contextFor(harness, tenant.tenantId, ['super_admin'], {
      userId: tenant.adminUserId,
      freshAuth: false,
    });
    expect(() => new AuthorizationService(stale).setRoles(other, ['auditor'])).toThrow(/reauth_required/);
  });
});

describe('Row-Level Security (TESTING.md Bagian 4)', () => {
  it('TC-RLS-01 — pengguna "Wilayah Timur saja" tidak menerima data Wilayah Barat dari respons API', () => {
    const tenant = provisionTenant(harness);
    const admin = contextFor(harness, tenant.tenantId, ['super_admin']);
    const uploaded = new DatasetService(admin).upload({
      filename: 'wilayah.csv',
      content: Buffer.from(syntheticCsv({ rows: 30 })),
    });

    const restricted = contextFor(harness, tenant.tenantId, ['supervisor', 'business_analyst'], {
      rls: [{ dimension: 'wilayah', operator: 'in', values: ['Wilayah Timur'] }],
    });

    const result = new DatasetService(restricted).rows(uploaded.dataset.id, { limit: 1000 });

    expect(result.rows.length).toBeGreaterThan(0);
    // Data di luar cakupan TIDAK PERNAH keluar dari respons — bukan sekadar disembunyikan.
    expect(result.rows.every((row) => row.wilayah === 'Wilayah Timur')).toBe(true);
    expect(result.rlsFiltered).toBeGreaterThan(0);
  });

  it('TC-RLS-02 — total yang dilaporkan juga sudah difilter, bukan hanya halaman yang tampil', () => {
    const tenant = provisionTenant(harness);
    const admin = contextFor(harness, tenant.tenantId, ['super_admin']);
    const uploaded = new DatasetService(admin).upload({
      filename: 'wilayah2.csv',
      content: Buffer.from(syntheticCsv({ rows: 30 })),
    });

    const unrestrictedTotal = new DatasetService(admin).rows(uploaded.dataset.id, { limit: 5 }).total;
    const restricted = contextFor(harness, tenant.tenantId, ['business_analyst'], {
      rls: [{ dimension: 'wilayah', operator: 'in', values: ['Wilayah Timur'] }],
    });
    const restrictedTotal = new DatasetService(restricted).rows(uploaded.dataset.id, { limit: 5 }).total;

    expect(restrictedTotal).toBeLessThan(unrestrictedTotal);
  });

  it('TC-RLS-03 — fail secure: baris tanpa kolom dimensi pembatas tidak lolos', () => {
    const tenant = provisionTenant(harness);
    const admin = contextFor(harness, tenant.tenantId, ['super_admin']);
    const uploaded = new DatasetService(admin).upload({
      filename: 'tanpa-dimensi.csv',
      // Dataset ini TIDAK memiliki kolom `wilayah`.
      content: Buffer.from('kanal,jumlah\nChat,10\nEmail,20'),
    });

    const restricted = contextFor(harness, tenant.tenantId, ['business_analyst'], {
      rls: [{ dimension: 'wilayah', operator: 'in', values: ['Wilayah Timur'] }],
    });

    // Akses default DITOLAK, bukan diizinkan (SECURITY.md Bagian 2 — Fail Secure).
    expect(new DatasetService(restricted).rows(uploaded.dataset.id).rows).toHaveLength(0);
  });
});

describe('Log Aktivitas immutable (SECURITY.md Bagian 9)', () => {
  it('TC-AUD-01 — entri log tidak dapat diperbarui, bahkan lewat SQL langsung', () => {
    const tenant = provisionTenant(harness);
    const entry = harness.audit.record({
      tenantId: tenant.tenantId,
      actorLabel: 'uji',
      action: 'test.event',
      module: 'Log Aktivitas',
    });

    expect(() =>
      harness.db.prepare('UPDATE auditdb.audit_log SET action = ? WHERE id = ?').run('tampered', entry.id),
    ).toThrow(/immutable/i);
  });

  it('TC-AUD-02 — entri log tidak dapat dihapus, termasuk oleh administrator basis data', () => {
    const tenant = provisionTenant(harness);
    const entry = harness.audit.record({
      tenantId: tenant.tenantId,
      actorLabel: 'uji',
      action: 'test.event',
      module: 'Log Aktivitas',
    });

    expect(() => harness.db.prepare('DELETE FROM auditdb.audit_log WHERE id = ?').run(entry.id)).toThrow(/immutable/i);
  });

  it('TC-AUD-03 — log tersimpan di basis data terpisah dari data operasional', () => {
    const databases = harness.db.pragma('database_list') as Array<{ name: string; file: string }>;
    const main = databases.find((d) => d.name === 'main')!;
    const auditDb = databases.find((d) => d.name === 'auditdb')!;

    expect(auditDb).toBeDefined();
    expect(auditDb.file).not.toBe(main.file);
  });

  it('TC-AUD-04 — Auditor satu tenant tidak dapat membaca log tenant lain', () => {
    const a = provisionTenant(harness, { slug: 'audita' });
    const b = provisionTenant(harness, { slug: 'auditb' });

    harness.audit.record({ tenantId: a.tenantId, actorLabel: 'a', action: 'x', module: 'M' });
    harness.audit.record({ tenantId: b.tenantId, actorLabel: 'b', action: 'y', module: 'M' });

    const seenByA = harness.audit.query(a.tenantId);
    expect(seenByA.rows.every((row) => row.tenant_id === a.tenantId)).toBe(true);
  });

  it('TC-AUD-05 — usage_events bersifat append-only sebagai dasar tagihan yang dapat diaudit', () => {
    const tenant = provisionTenant(harness);
    const ctx = contextFor(harness, tenant.tenantId, ['super_admin']);
    ctx.db.insert('usage_events', {
      id: 'use_test',
      metric: 'ai_calls_monthly',
      quantity: 1,
      occurred_at: new Date().toISOString(),
      source: 'test',
      meta_json: null,
    });

    expect(() => harness.db.prepare('UPDATE usage_events SET quantity = 999 WHERE id = ?').run('use_test')).toThrow(
      /append-only/i,
    );
    expect(() => harness.db.prepare('DELETE FROM usage_events WHERE id = ?').run('use_test')).toThrow(/append-only/i);
  });
});
