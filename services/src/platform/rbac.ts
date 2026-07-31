/**
 * RBAC — 13 peran standar (PRD Bagian 3 & 8, SECURITY.md Bagian 5).
 *
 * Aturan resolusi multi-peran (SECURITY.md Bagian 5):
 *   "Kombinasi banyak peran pada satu pengguna diselesaikan dengan aturan eksplisit
 *    (union hak akses, dengan pengecualian eksplisit yang selalu menang atas izin —
 *    DENY OVERRIDES ALLOW)."
 */

/** Izin berformat `<modul>:<aksi>`; `*` sebagai wildcard aksi. */
export type Permission = string;

export const ROLE_CODES = [
  'executive',
  'manager',
  'supervisor',
  'business_analyst',
  'dashboard_designer',
  'data_engineer',
  'data_steward',
  'ai_analyst',
  'auditor',
  'system_admin',
  'super_admin',
  'external_stakeholder',
  'platform_operator',
] as const;

export type RoleCode = (typeof ROLE_CODES)[number];

export interface StandardRole {
  code: RoleCode;
  nameId: string;
  nameEn: string;
  permissions: Permission[];
  /** Pengecualian eksplisit — selalu menang atas izin apa pun (deny overrides allow). */
  denials: Permission[];
  /** MFA wajib untuk peran ini (SECURITY.md Bagian 4). */
  mfaRequired: boolean;
}

const READ_ANALYTICS: Permission[] = [
  'executive_cockpit:read',
  'operational_cockpit:read',
  'balanced_scorecard:read',
  'dashboard:read',
  'report:read',
  'visualization:read',
  'kpi:read',
  'alert:read',
];

/**
 * Definisi 13 peran standar. Peran kustom tambahan dikelola per tenant lewat modul
 * Pengelolaan Otorisasi User (PRD 6.19) dan disimpan di tabel `roles`.
 */
export const STANDARD_ROLES: readonly StandardRole[] = [
  {
    code: 'executive',
    nameId: 'Executive',
    nameEn: 'Executive',
    permissions: [...READ_ANALYTICS, 'ai_analytics:ask', 'narrative:read', 'forecast:read'],
    denials: [],
    mfaRequired: false,
  },
  {
    code: 'manager',
    nameId: 'Manager',
    nameEn: 'Manager',
    permissions: [
      ...READ_ANALYTICS,
      'ai_analytics:ask',
      'narrative:read',
      'forecast:read',
      'kpi:write',
      'alert:write',
      'rca:read',
    ],
    denials: [],
    mfaRequired: false,
  },
  {
    code: 'supervisor',
    nameId: 'Supervisor',
    nameEn: 'Supervisor',
    permissions: [
      'operational_cockpit:read',
      'dashboard:read',
      'kpi:read',
      'alert:read',
      'alert:acknowledge',
      'rca:read',
      'rca:write',
      'twin:read',
      'twin:ticket',
    ],
    // Uji negatif TESTING.md Bagian 4: Supervisor mencoba akses Otorisasi User via API
    // langsung harus 403 dan tercatat sebagai percobaan akses ditolak.
    denials: ['authorization:*', 'audit:*'],
    mfaRequired: false,
  },
  {
    code: 'business_analyst',
    nameId: 'Business Analyst',
    nameEn: 'Business Analyst',
    permissions: [
      ...READ_ANALYTICS,
      'dashboard:write',
      'report:write',
      'report:export',
      'visualization:write',
      'dataset:read',
      'datamodel:read',
      'stats:run',
      'forecast:run',
      'discovery:run',
      'ai_analytics:ask',
      'rca:read',
    ],
    denials: [],
    mfaRequired: false,
  },
  {
    code: 'dashboard_designer',
    nameId: 'Dashboard Designer',
    nameEn: 'Dashboard Designer',
    permissions: [
      'dashboard:read',
      'dashboard:write',
      'dashboard:publish',
      'visualization:read',
      'visualization:write',
      'report:read',
      'report:write',
      'embed:read',
      'embed:write',
      'kpi:read',
      'dataset:read',
    ],
    denials: [],
    mfaRequired: false,
  },
  {
    code: 'data_engineer',
    nameId: 'Data Engineer',
    nameEn: 'Data Engineer',
    permissions: [
      'dataset:read',
      'dataset:write',
      'dataset:upload',
      'connection:read',
      'connection:write',
      'connection:test',
      'connection:sync',
      'datamodel:read',
      'datamodel:write',
      'dataquality:read',
      'kpi:read',
      'dashboard:read',
    ],
    denials: ['dataquality:certify'], // sertifikasi adalah kewenangan Data Steward (PRD 6.14)
    mfaRequired: true,
  },
  {
    code: 'data_steward',
    nameId: 'Data Steward',
    nameEn: 'Data Steward',
    permissions: [
      'dataset:read',
      'dataquality:read',
      'dataquality:write',
      'dataquality:certify',
      'datamodel:read',
      'datamodel:write',
      'dictionary:write',
      'export:approve_restricted', // SECURITY.md Bagian 3
      'kpi:read',
    ],
    denials: [],
    mfaRequired: true,
  },
  {
    code: 'ai_analyst',
    nameId: 'AI Analyst',
    nameEn: 'AI Analyst',
    permissions: [
      'ai_analytics:ask',
      'ai_analytics:configure',
      'forecast:read',
      'forecast:run',
      'rca:read',
      'rca:write',
      'rca:validate',
      'discovery:run',
      'narrative:read',
      'narrative:generate',
      'stats:run',
      'dataset:read',
      'kpi:read',
    ],
    denials: [],
    mfaRequired: false,
  },
  {
    code: 'auditor',
    nameId: 'Auditor',
    nameEn: 'Auditor',
    // Akses BACA-SAJA penuh terhadap Log Aktivitas tanpa dapat memengaruhi data
    // operasional (PRD 6.20, SECURITY.md Bagian 9).
    permissions: ['audit:read', 'audit:export', 'device:read', 'authorization:read', 'dataset:read'],
    denials: [
      'dataset:write',
      'dashboard:write',
      'report:write',
      'kpi:write',
      'connection:write',
      'authorization:write',
      'employee:write',
      'dataquality:certify',
    ],
    mfaRequired: false,
  },
  {
    code: 'system_admin',
    nameId: 'System Admin',
    nameEn: 'System Admin',
    permissions: [
      'employee:read',
      'employee:write',
      'employee:import',
      'connection:read',
      'connection:write',
      'device:read',
      'device:unbind',
      'device:approve_transfer',
      'tenant:read',
      'tenant:configure',
      // Kredensial jembatan MQTT: menerbitkan dan mencabutnya adalah pekerjaan
      // administrasi sistem, bukan pekerjaan orang yang membaca dasbor.
      'twin:ingest',
      'twin:ingest_manage',
    ],
    // Tidak dapat mengubah hak akses (itu kewenangan Super Admin) — SECURITY.md Bagian 5.
    denials: ['authorization:write'],
    mfaRequired: true,
  },
  {
    code: 'super_admin',
    nameId: 'Super Admin',
    nameEn: 'Super Admin',
    permissions: [
      '*:*',
      'authorization:read',
      'authorization:write',
      'billing:read',
      'billing:write',
      'subscription:read',
      'subscription:write',
      'usage:read',
    ],
    /**
     * Log Aktivitas immutable bahkan bagi Super Admin (SECURITY.md Bagian 9).
     *
     * `billing:settle` juga ditolak, dan itu bukan pengetatan kecil: `*:*` di atas akan
     * memberikannya, dan tanpa penolakan ini pemilik ruang kerja dapat menyatakan
     * fakturnya sendiri lunas lalu memperpanjang masa berlakunya tanpa uang yang pernah
     * masuk. Wewenang menyatakan pembayaran ada di sisi platform — pihak yang berutang
     * tidak boleh menjadi pihak yang menyatakan utangnya lunas. Penolakan mengalahkan
     * pemberian, jadi pemisahan ini tidak dapat dilanggar tanpa menyunting berkas ini.
     */
    denials: ['audit:write', 'audit:delete', 'billing:settle'],
    mfaRequired: true,
  },
  {
    code: 'external_stakeholder',
    nameId: 'Mitra Eksternal',
    nameEn: 'External Stakeholder',
    // Portal berbagi terbatas tanpa akun penuh (PRD Bagian 8).
    permissions: ['dashboard:read_shared'],
    denials: ['dataset:*', 'report:export', 'audit:*', 'authorization:*', 'employee:*'],
    mfaRequired: false,
  },
  {
    code: 'platform_operator',
    nameId: 'Platform Operator',
    nameEn: 'Platform Operator',
    // SECURITY.md 16.2: akses lintas tenant HANYA untuk fungsi administratif —
    // bukan akses baca terhadap data analitik pelanggan secara default.
    permissions: [
      'tenant:provision',
      'tenant:suspend',
      'tenant:read',
      'subscription:read',
      'billing:read',
      /**
       * Menyatakan sebuah faktur benar-benar DIBAYAR.
       *
       * Dipegang sisi platform, dan SENGAJA ditolak untuk Super Admin tenant: pihak yang
       * berutang tidak boleh menjadi pihak yang menyatakan utangnya lunas. Tanpa pemisahan
       * itu, pemegang `subscription:write` dapat memperpanjang ruang kerjanya sendiri tanpa
       * uang yang pernah masuk — dan tidak ada satu pun kesalahan yang tercatat.
       */
      'billing:settle',
      'platform:health',
    ],
    denials: [
      'dataset:read',
      'dataset:write',
      'dashboard:read',
      'report:read',
      'kpi:read',
      'executive_cockpit:read',
      'operational_cockpit:read',
      'ai_analytics:ask',
    ],
    mfaRequired: true,
  },
];

export const STANDARD_ROLE_BY_CODE = new Map<RoleCode, StandardRole>(
  STANDARD_ROLES.map((r) => [r.code, r]),
);

/** Peran efektif seorang pengguna: gabungan izin dikurangi seluruh pengecualian. */
export interface EffectivePermissions {
  readonly granted: ReadonlySet<Permission>;
  readonly denied: ReadonlySet<Permission>;
}

export interface RoleLike {
  permissions: Permission[];
  denials: Permission[];
}

/**
 * Union izin lintas peran, lalu pengecualian eksplisit diterapkan terakhir.
 * Deny SELALU menang — termasuk ketika peran lain memberi `*:*`.
 */
export function resolvePermissions(roles: readonly RoleLike[]): EffectivePermissions {
  const granted = new Set<Permission>();
  const denied = new Set<Permission>();
  for (const role of roles) {
    for (const p of role.permissions) granted.add(p);
    for (const d of role.denials) denied.add(d);
  }
  return { granted, denied };
}

function matches(pattern: Permission, permission: Permission): boolean {
  if (pattern === permission) return true;
  const [pMod, pAct] = pattern.split(':');
  const [mod, act] = permission.split(':');
  if (pMod === '*' && pAct === '*') return true;
  if (pMod === mod && pAct === '*') return true;
  if (pMod === '*' && pAct === act) return true;
  return false;
}

/** Keputusan otorisasi tunggal. Fail secure: tanpa izin yang cocok → ditolak. */
export function can(effective: EffectivePermissions, permission: Permission): boolean {
  for (const d of effective.denied) {
    if (matches(d, permission)) return false; // deny overrides allow
  }
  for (const g of effective.granted) {
    if (matches(g, permission)) return true;
  }
  return false;
}

/** Apakah salah satu peran pengguna mensyaratkan MFA (SECURITY.md Bagian 4)? */
export function requiresMfa(roleCodes: readonly string[]): boolean {
  return roleCodes.some((c) => STANDARD_ROLE_BY_CODE.get(c as RoleCode)?.mfaRequired === true);
}
