/**
 * Kredensial mesin untuk jembatan MQTT.
 *
 * Jembatan berjalan tanpa orang di depannya. Memakai akun manusia berarti dua hal yang
 * sama-sama buruk: ia tidak dapat menjawab tantangan MFA, dan aturan sesi tunggal membuat
 * jembatan yang menyambung ulang menendang keluar orang yang sedang bekerja. Jadi jalur
 * ini punya kredensialnya sendiri — sempit, dapat dicabut, dan terikat pada satu tenant.
 *
 * Yang dapat dilakukan pemegang token HANYA satu: mengirim pembacaan sensor. Ia tidak
 * dapat membaca dasbor, tidak dapat melihat aset, tidak dapat membuat tiket. Jembatan
 * yang diletakkan di lantai pabrik adalah perangkat yang paling mudah diambil orang;
 * yang bocor darinya harus sedikit mungkin.
 */
import { AuditService } from '../audit-service/index.ts';
import { RequestContext, loadFeatureFlags, toTenantInfo, type TenantInfo } from '../platform/context.ts';
import { generateToken, hashToken } from '../platform/crypto.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../platform/errors.ts';
import { newId, nowIso, type Db } from '../platform/db.ts';

/** Awalan yang membuat token terkenali saat tidak sengaja tersalin ke tempat yang salah. */
const TOKEN_PREFIX = 'vtk_ing_';

export interface IngestTokenView {
  id: string;
  label: string;
  createdAt: string;
  createdBy: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface TokenRow {
  id: string;
  tenant_id: string;
  label: string;
  created_at: string;
  created_by: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

/**
 * Pengelolaan token — jalur administrator, memakai sesi biasa.
 */
export class IngestTokenService {
  constructor(private readonly ctx: RequestContext) {}

  /**
   * Menerbitkan token baru. Nilainya dikembalikan SEKALI dan tidak pernah lagi.
   *
   * Bukan kesulitan yang dibuat-buat: yang tersimpan hanya hash-nya, jadi memang tidak
   * ada yang dapat ditampilkan lagi. Token yang hilang diganti dengan menerbitkan yang
   * baru lalu mencabut yang lama — dan itu memang jalan yang benar.
   */
  create(input: { label?: string }): IngestTokenView & { token: string } {
    this.ctx.require('twin:ingest_manage', { module: 'Digital Twin' });

    const label = (input.label ?? '').trim();
    if (label === '') throw new ValidationError('error.ingest_token_label_required');

    const token = `${TOKEN_PREFIX}${generateToken(32)}`;
    const at = nowIso();
    const id = newId('ing');

    this.ctx.db.insert('ingest_tokens', {
      id,
      label,
      token_hash: hashToken(token),
      created_at: at,
      created_by: this.ctx.actor.userId,
      last_used_at: null,
      revoked_at: null,
      revoked_by: null,
    } as never);

    this.ctx.log({
      action: 'twin.ingest_token_created',
      module: 'Digital Twin',
      objectType: 'ingest_token',
      objectId: id,
      objectLabel: label,
      severity: 'notice',
      detail: { label },
    });

    return { ...this.toView({ id, tenant_id: this.ctx.tenant.id, label, created_at: at, created_by: this.ctx.actor.userId, last_used_at: null, revoked_at: null }), token };
  }

  /** Daftar token. TIDAK pernah memuat nilainya — hanya hash-nya yang tersimpan. */
  list(): IngestTokenView[] {
    this.ctx.require('twin:ingest_manage', { module: 'Digital Twin' });
    return this.ctx.db
      .all<TokenRow>('ingest_tokens', {})
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((row) => this.toView(row));
  }

  /**
   * Mencabut token. Berlaku seketika pada permintaan berikutnya.
   *
   * Barisnya TIDAK dihapus: siapa yang menerbitkan dan kapan terakhir dipakai adalah
   * jejak yang dibutuhkan bila kemudian ada pertanyaan tentang data sensor yang aneh.
   */
  revoke(id: string): IngestTokenView {
    this.ctx.require('twin:ingest_manage', { module: 'Digital Twin' });

    const row = this.ctx.db.get<TokenRow>('ingest_tokens', { id });
    if (!row) throw new NotFoundError();

    const at = nowIso();
    this.ctx.db.update('ingest_tokens', { id }, { revoked_at: at, revoked_by: this.ctx.actor.userId });

    this.ctx.log({
      action: 'twin.ingest_token_revoked',
      module: 'Digital Twin',
      objectType: 'ingest_token',
      objectId: id,
      objectLabel: row.label,
      severity: 'notice',
      detail: { label: row.label },
    });

    return { ...this.toView(row), revokedAt: at };
  }

  private toView(row: TokenRow): IngestTokenView {
    return {
      id: row.id,
      label: row.label,
      createdAt: row.created_at,
      createdBy: row.created_by,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
    };
  }
}

/* ================= Jalur jembatan (tanpa sesi) ================= */

/**
 * Menukar token menjadi konteks yang HANYA boleh mengirim pembacaan.
 *
 * Perhatikan daftar izinnya: satu entri. Bukan peran yang sudah ada — peran mana pun yang
 * cukup untuk ini juga cukup untuk hal lain, dan kredensial yang tertanam di perangkat di
 * lantai pabrik tidak boleh membawa apa pun selain yang ia perlukan.
 *
 * Melempar `ForbiddenError` untuk token yang tidak dikenal MAUPUN yang dicabut: keduanya
 * dijawab sama supaya jawabannya tidak dapat dipakai memilah tebakan.
 */
export function contextFromIngestToken(
  db: Db,
  audit: AuditService,
  token: string,
  ip: string | null,
): RequestContext {
  if (!token || !token.startsWith(TOKEN_PREFIX)) throw new ForbiddenError('error.ingest_token_invalid');

  const row = db
    .prepare('SELECT * FROM ingest_tokens WHERE token_hash = ? AND revoked_at IS NULL')
    .get(hashToken(token)) as TokenRow | undefined;
  if (!row) throw new ForbiddenError('error.ingest_token_invalid');

  const tenantRow = db.prepare('SELECT * FROM tenants WHERE id = ? AND deleted_at IS NULL').get(row.tenant_id) as
    | Parameters<typeof toTenantInfo>[0]
    | undefined;
  if (!tenantRow) throw new ForbiddenError('error.ingest_token_invalid');
  const tenant: TenantInfo = toTenantInfo(tenantRow);

  db.prepare('UPDATE ingest_tokens SET last_used_at = ? WHERE id = ?').run(nowIso(), row.id);

  return new RequestContext(
    db,
    tenant,
    {
      userId: row.id,
      employeeId: row.id,
      email: `${row.label} (ingest)`,
      // Muncul apa adanya di Log Aktivitas: peninjau harus dapat membedakan pembacaan
      // yang datang dari jembatan dari yang diketik orang.
      displayName: `Jembatan MQTT · ${row.label}`,
      locale: 'id',
      theme: 'light',
      roleIds: [],
      roleCodes: [],
      sessionId: `ingest-${row.id}`,
      // Tidak pernah dianggap baru diautentikasi: aksi sensitif menuntut re-autentikasi,
      // dan jembatan tidak dapat melakukannya. Itu memang yang diinginkan.
      reauthAt: null,
      // Tidak ada peran yang mewajibkan MFA di sini, jadi ini tidak membuka apa pun —
      // ia hanya mencegah gerbang pendaftaran MFA menahan jalur yang tidak berperan.
      mfaEnrolled: true,
    },
    [{ permissions: ['twin:ingest'], denials: [] }],
    loadFeatureFlags(db, tenant.id, tenant.status),
    audit,
    ip,
  );
}
