/**
 * Jalur masuk pembacaan sensor: token ingest dan jembatan MQTT.
 *
 * Yang diperiksa di sini sebagian besar adalah hal-hal yang TIDAK BOLEH bisa dilakukan
 * pemegang token. Kredensial jembatan tertanam di perangkat yang berdiri di lantai pabrik
 * atau di lemari panel — perangkat paling mudah diambil orang di seluruh pemasangan ini.
 * Yang bocor darinya harus sesedikit mungkin:
 *
 *  1. **Hanya boleh mengirim** (TC-ING-05..07). Tidak dapat membaca dasbor, tidak dapat
 *     melihat aset, tidak dapat membuat tiket.
 *  2. **Terikat satu tenant** (TC-ING-08). Token satu pelanggan tidak boleh menulis ke
 *     ruang kerja pelanggan lain.
 *  3. **Pencabutan berlaku seketika** (TC-ING-04).
 *  4. **Nilainya tidak pernah dapat dibaca ulang** (TC-ING-02) — yang tersimpan hash.
 *
 * Ditambah satu perubahan yang berdiri sendiri: `ingestReading` dulu TIDAK memeriksa izin
 * sama sekali, sehingga siapa pun yang punya sesi di tenant itu dapat menyuntik pembacaan
 * sensor — membuat alarm palsu, atau menenggelamkan alarm yang benar (TC-ING-09).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, contextFor, provisionTenant, type Harness, type TenantFixture } from './helpers.ts';
import { DigitalTwinService } from '../src/iot-gateway-service/index.ts';
import { IngestTokenService, contextFromIngestToken } from '../src/iot-gateway-service/ingest.ts';
import { ForbiddenError, ValidationError } from '../src/platform/errors.ts';

let harness: Harness;
let tenant: TenantFixture;

function tokens(roles: Array<'super_admin' | 'system_admin' | 'supervisor'> = ['system_admin']): IngestTokenService {
  return new IngestTokenService(contextFor(harness, tenant.tenantId, roles, { mfaEnrolled: true }));
}

/** Aset dengan satu sensor, dibuat lewat jalur administrator biasa. */
function seedAsset(fixture: TenantFixture = tenant, code = 'PUMP-1'): void {
  const twin = new DigitalTwinService(contextFor(harness, fixture.tenantId, ['super_admin'], { mfaEnrolled: true }));
  twin.createAsset({
    code,
    name: 'Pompa Utama',
    category: 'pump',
    sensors: [{ code: 'vibration', label: 'Getaran', unit: 'mm/s', warnMax: 4.5, critMax: 7 }],
  } as never);
}

beforeEach(() => {
  harness = createHarness();
  tenant = provisionTenant(harness, { trialDays: 30 });
  seedAsset();
});

afterEach(() => harness.cleanup());

/* ================= Penerbitan token ================= */

describe('Penerbitan token ingest', () => {
  it('TC-ING-01 — hanya peran dengan twin:ingest_manage yang dapat menerbitkan', () => {
    // Supervisor melihat lantai pabrik dan membuat tiket; menerbitkan kredensial mesin
    // adalah pekerjaan yang lain.
    expect(() => tokens(['supervisor']).create({ label: 'Jembatan' })).toThrow(ForbiddenError);

    const issued = tokens().create({ label: 'Jembatan Pabrik 1' });
    expect(issued.token).toMatch(/^vtk_ing_/);
    expect(issued.label).toBe('Jembatan Pabrik 1');
  });

  it('TC-ING-02 — nilai token TIDAK pernah dapat dibaca ulang', () => {
    const service = tokens();
    const issued = service.create({ label: 'Jembatan' });

    const listed = service.list();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(issued.token);

    // Yang tersimpan hash-nya, bukan tokennya — jadi memang tidak ada yang dapat
    // ditampilkan lagi, bukan sekadar disembunyikan dari tampilan.
    const row = harness.db.prepare('SELECT token_hash FROM ingest_tokens').get() as { token_hash: string };
    expect(row.token_hash).not.toBe(issued.token);
    expect(row.token_hash).toHaveLength(64);
  });

  it('TC-ING-03 — label wajib diisi', () => {
    // Tanpa label, daftar token menjadi deretan id tanpa arti dan tidak ada yang berani
    // mencabut apa pun karena tidak tahu mana yang masih dipakai.
    expect(() => tokens().create({ label: '   ' })).toThrow(ValidationError);
  });

  it('TC-ING-04 — pencabutan berlaku pada permintaan berikutnya, dan jejaknya tetap ada', () => {
    const service = tokens();
    const issued = service.create({ label: 'Jembatan Lama' });

    // Sebelum dicabut: dapat dipakai.
    expect(contextFromIngestToken(harness.db, harness.audit, issued.token, null).tenant.id).toBe(tenant.tenantId);

    service.revoke(issued.id);

    expect(() => contextFromIngestToken(harness.db, harness.audit, issued.token, null)).toThrow(ForbiddenError);
    // Barisnya TIDAK dihapus: siapa yang menerbitkan dan kapan terakhir dipakai adalah
    // jejak yang dibutuhkan bila kemudian ada pertanyaan tentang data sensor yang aneh.
    expect(service.list()).toHaveLength(1);
    expect(service.list()[0]!.revokedAt).not.toBeNull();
  });
});

/* ================= Apa yang boleh dilakukan pemegang token ================= */

describe('Kewenangan token ingest', () => {
  function bridgeContext(): ReturnType<typeof contextFromIngestToken> {
    const issued = tokens().create({ label: 'Jembatan' });
    return contextFromIngestToken(harness.db, harness.audit, issued.token, '203.0.113.50');
  }

  it('TC-ING-05 — dapat mengirim pembacaan', async () => {
    const twin = new DigitalTwinService(bridgeContext());

    const result = await twin.ingestReading({ assetCode: 'PUMP-1', sensorCode: 'vibration', value: 2.4 });

    expect(result.healthScore).toBeGreaterThan(0);
    const rows = harness.db
      .prepare('SELECT COUNT(*) AS n FROM sensor_readings WHERE sensor_code = ?')
      .get('vibration') as { n: number };
    expect(rows.n).toBe(1);
  });

  it('TC-ING-06 — TIDAK dapat membaca apa pun', () => {
    const twin = new DigitalTwinService(bridgeContext());

    // Denah lantai memperlihatkan seluruh aset dan zona pelanggan; token yang tertanam di
    // perangkat tidak berhak atasnya.
    expect(() => twin.floorPlan()).toThrow(ForbiddenError);
    expect(() => twin.maintenanceQueue()).toThrow(ForbiddenError);
  });

  it('TC-ING-07 — izinnya persis satu, bukan sebuah peran', () => {
    const ctx = bridgeContext();

    expect(ctx.can('twin:ingest')).toBe(true);
    // Semua yang lain tertutup — termasuk yang terdengar berdekatan.
    for (const permission of ['twin:read', 'twin:ticket', 'twin:ingest_manage', 'dashboard:read', 'dataset:read']) {
      expect(ctx.can(permission), permission).toBe(false);
    }
    expect(ctx.actor.roleCodes).toEqual([]);
  });

  it('TC-ING-08 — token satu tenant tidak dapat menulis ke tenant lain', async () => {
    const lain = provisionTenant(harness, { trialDays: 30 });
    seedAsset(lain, 'PUMP-LAIN');

    const twin = new DigitalTwinService(bridgeContext());

    // Aset milik tenant lain terlihat seperti tidak ada — bukan "terlarang", karena
    // membedakan keduanya memberi tahu bahwa aset itu memang ada di suatu tempat.
    await expect(twin.ingestReading({ assetCode: 'PUMP-LAIN', sensorCode: 'vibration', value: 1 })).rejects.toThrow();
    const rows = harness.db
      .prepare('SELECT COUNT(*) AS n FROM sensor_readings')
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('TC-ING-09 — pengguna biasa TIDAK dapat menyuntik pembacaan sensor', async () => {
    // Sebelumnya `ingestReading` tidak memeriksa izin sama sekali: siapa pun yang punya
    // sesi dapat membuat alarm palsu, atau menenggelamkan alarm yang benar di antara
    // pembacaan karangan.
    const supervisor = new DigitalTwinService(contextFor(harness, tenant.tenantId, ['supervisor']));

    await expect(
      supervisor.ingestReading({ assetCode: 'PUMP-1', sensorCode: 'vibration', value: 99 }),
    ).rejects.toThrow(ForbiddenError);

    // Dan penolakannya tercatat, bukan hanya dibalas.
    const denials = harness.db
      .prepare(
        `SELECT COUNT(*) AS n FROM auditdb.audit_log
          WHERE tenant_id = ? AND action = 'access.denied' AND object_id = 'twin:ingest'`,
      )
      .get(tenant.tenantId) as { n: number };
    expect(denials.n).toBeGreaterThan(0);
  });

  it('TC-ING-10 — token tidak dikenal dan token yang salah bentuk dijawab sama', () => {
    for (const bad of ['', 'bukan-token', 'vtk_ing_tidakada', 'Bearer sesuatu']) {
      expect(() => contextFromIngestToken(harness.db, harness.audit, bad, null), bad).toThrow(ForbiddenError);
    }
  });

  it('TC-ING-11 — pemakaian terakhir dicatat supaya token menganggur dapat dikenali', () => {
    const service = tokens();
    const issued = service.create({ label: 'Jembatan' });
    expect(service.list()[0]!.lastUsedAt).toBeNull();

    contextFromIngestToken(harness.db, harness.audit, issued.token, null);

    // Tanpa ini, tidak ada cara membedakan token yang masih dipakai dari token yang
    // ditinggalkan bersama perangkat yang sudah dibuang.
    expect(service.list()[0]!.lastUsedAt).not.toBeNull();
  });

  it('TC-ING-12 — ruang kerja yang belum aktif tetap tidak dapat ditulisi', async () => {
    // Jalur mesin tidak boleh menjadi celah yang melewati mode baca-saja: pelanggan yang
    // langganannya berhenti akan tetap mengalirkan data lewat jembatan yang sudah
    // terpasang, dan tagihannya tidak pernah menyusul.
    harness.db.prepare("UPDATE tenants SET status = 'read_only' WHERE id = ?").run(tenant.tenantId);
    const twin = new DigitalTwinService(bridgeContext());

    await expect(twin.ingestReading({ assetCode: 'PUMP-1', sensorCode: 'vibration', value: 2 })).rejects.toThrow(
      ForbiddenError,
    );
  });
});
