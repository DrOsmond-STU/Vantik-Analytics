/**
 * Skema data inti — ARCHITECTURE.md Bagian 5.
 *
 * Migrasi bersifat aditif dan backward-compatible (DEPLOYMENT.md Bagian 6): setiap
 * migrasi hanya menambah tabel/kolom/indeks, tidak pernah menghapus atau mengubah tipe
 * kolom yang sudah dipakai versi sebelumnya.
 *
 * Catatan multi-tenancy (ARCHITECTURE.md 5.1): SETIAP tabel data pelanggan membawa
 * kolom `tenant_id`. Penegakannya ada di lapisan akses data terpusat (`tenancy.ts`),
 * bukan diserahkan ke tiap pengembang untuk mengingat menambah filter.
 */

export interface Migration {
  readonly id: string;
  readonly sql: string;
}

const CORE_MIGRATIONS: readonly Migration[] = [
  {
    id: '0001_tenancy_and_billing',
    sql: `
      -- Paket langganan: mendefinisikan kuota & feature flag per paket (PRD 2.1, 6.27).
      CREATE TABLE plans (
        code            TEXT PRIMARY KEY,          -- starter | professional | enterprise
        name            TEXT NOT NULL,
        monthly_price   INTEGER NOT NULL,          -- minor units (rupiah), 0 = trial
        annual_price    INTEGER NOT NULL,
        features_json   TEXT NOT NULL,             -- feature flag per modul
        quotas_json     TEXT NOT NULL,             -- kuota: users, datasets, connections, embed tokens, ai calls, storage
        sort_order      INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE tenants (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        slug            TEXT NOT NULL UNIQUE,
        -- active | trial | past_due | read_only | suspended  (SECURITY.md 16.4 — urutan penurunan akses)
        status          TEXT NOT NULL DEFAULT 'trial',
        isolation_level TEXT NOT NULL DEFAULT 'shared_schema', -- shared_schema | separate_schema | separate_db
        accent_color    TEXT,                      -- identitas visual tenant (PRD 6.26)
        logo_text       TEXT,
        white_label     INTEGER NOT NULL DEFAULT 0,
        default_locale  TEXT NOT NULL DEFAULT 'id',
        max_devices_per_user INTEGER NOT NULL DEFAULT 1,  -- PRD 6.30, dikonfigurasi Admin
        created_at      TEXT NOT NULL,
        suspended_at    TEXT,
        deleted_at      TEXT,                      -- soft delete; penghapusan permanen setelah retensi (SECURITY.md 16.4)
        retention_until TEXT
      );

      CREATE TABLE subscriptions (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        plan_code       TEXT NOT NULL REFERENCES plans(code),
        billing_cycle   TEXT NOT NULL,             -- monthly | annual
        status          TEXT NOT NULL,             -- trialing | active | past_due | canceled
        trial_ends_at   TEXT,
        current_period_start TEXT NOT NULL,
        current_period_end   TEXT NOT NULL,
        cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
        -- downgrade berlaku awal siklus berikutnya (PRD 6.27)
        pending_plan_code    TEXT REFERENCES plans(code),
        created_at      TEXT NOT NULL
      );
      CREATE INDEX idx_subscriptions_tenant ON subscriptions(tenant_id);

      CREATE TABLE invoices (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        number          TEXT NOT NULL,
        period_start    TEXT NOT NULL,
        period_end      TEXT NOT NULL,
        subtotal        INTEGER NOT NULL,
        tax_rate        REAL NOT NULL DEFAULT 0.11,   -- PPN; nilai final ditetapkan tim bisnis
        tax_amount      INTEGER NOT NULL,
        total           INTEGER NOT NULL,
        currency        TEXT NOT NULL DEFAULT 'IDR',
        status          TEXT NOT NULL,             -- draft | open | paid | failed | void
        due_at          TEXT NOT NULL,
        paid_at         TEXT,
        -- Hanya token referensi & metadata; data kartu TIDAK PERNAH masuk sistem (SECURITY.md 16.3)
        gateway_ref     TEXT,
        payment_method_label TEXT,
        lines_json      TEXT NOT NULL,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX idx_invoices_tenant ON invoices(tenant_id);

      -- Append-only: dasar tagihan yang dapat diaudit tenant (PRD 6.29, SECURITY.md 16.3)
      CREATE TABLE usage_events (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        metric          TEXT NOT NULL,             -- active_users | storage_mb | connections | embed_tokens | ai_calls
        quantity        REAL NOT NULL,
        occurred_at     TEXT NOT NULL,
        source          TEXT NOT NULL,
        meta_json       TEXT
      );
      CREATE INDEX idx_usage_tenant_metric ON usage_events(tenant_id, metric, occurred_at);

      CREATE TRIGGER usage_events_no_update
        BEFORE UPDATE ON usage_events
        BEGIN SELECT RAISE(ABORT, 'usage_events is append-only (SECURITY.md 16.3)'); END;
      CREATE TRIGGER usage_events_no_delete
        BEFORE DELETE ON usage_events
        BEGIN SELECT RAISE(ABORT, 'usage_events is append-only (SECURITY.md 16.3)'); END;
    `,
  },

  {
    id: '0002_identity_and_access',
    sql: `
      -- Master Pegawai (PRD 6.18). Data pribadi = klasifikasi Restricted (SECURITY.md 3).
      CREATE TABLE employee_master (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        full_name       TEXT NOT NULL,
        nik             TEXT NOT NULL,             -- dimaskirkan pada tampilan non-esensial (SECURITY.md 6)
        division        TEXT NOT NULL,
        position        TEXT NOT NULL,
        email           TEXT NOT NULL,
        phone           TEXT,
        -- active | inactive | resigned | transferred  (perubahan memicu peninjauan akses, PRD 6.18)
        status          TEXT NOT NULL DEFAULT 'active',
        status_changed_at TEXT,
        access_review_due_at TEXT,                 -- SLA 1x24 jam (SECURITY.md 5)
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_employee_tenant_nik ON employee_master(tenant_id, nik);
      CREATE INDEX idx_employee_tenant_status ON employee_master(tenant_id, status);

      -- Akun sistem. Selalu mereferensikan employee_master — tidak ada akun "mengambang"
      -- tanpa identitas organisasi (SECURITY.md Bagian 5, PRD Bagian 8).
      CREATE TABLE system_user (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        employee_id     TEXT NOT NULL REFERENCES employee_master(id),
        email           TEXT NOT NULL,
        password_hash   TEXT,                      -- NULL bila hanya SSO
        auth_provider   TEXT NOT NULL DEFAULT 'local',  -- local | saml | oidc
        mfa_enrolled    INTEGER NOT NULL DEFAULT 0,
        status          TEXT NOT NULL DEFAULT 'active', -- active | disabled | locked
        locale          TEXT NOT NULL DEFAULT 'id',
        theme           TEXT NOT NULL DEFAULT 'light',  -- preferensi server-side (DESIGN.md 7.2)
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until    TEXT,
        last_login_at   TEXT,
        password_history_json TEXT NOT NULL DEFAULT '[]', -- 5 kata sandi terakhir (SECURITY.md 4)
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        disabled_at     TEXT
      );
      CREATE UNIQUE INDEX idx_user_tenant_email ON system_user(tenant_id, email);
      CREATE INDEX idx_user_employee ON system_user(employee_id);

      -- Peran: 13 peran standar + peran kustom per tenant (PRD 6.19).
      CREATE TABLE roles (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT,                      -- NULL = peran standar bawaan sistem
        code            TEXT NOT NULL,
        name_id         TEXT NOT NULL,
        name_en         TEXT NOT NULL,
        is_standard     INTEGER NOT NULL DEFAULT 0,
        permissions_json TEXT NOT NULL,            -- izin yang diberikan
        denials_json    TEXT NOT NULL DEFAULT '[]',-- pengecualian eksplisit; deny overrides allow (SECURITY.md 5)
        created_at      TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_roles_scope_code ON roles(IFNULL(tenant_id,'*'), code);

      CREATE TABLE role_assignment (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        user_id         TEXT NOT NULL REFERENCES system_user(id),
        role_id         TEXT NOT NULL REFERENCES roles(id),
        assigned_at     TEXT NOT NULL,
        assigned_by     TEXT
      );
      CREATE UNIQUE INDEX idx_role_assignment_unique ON role_assignment(user_id, role_id);
      CREATE INDEX idx_role_assignment_tenant ON role_assignment(tenant_id);

      -- Row-Level Security per pengguna ATAU per peran (PRD 6.19).
      -- Diterapkan pada level query, bukan disembunyikan di UI (SECURITY.md 5).
      CREATE TABLE rls_rules (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        subject_type    TEXT NOT NULL,             -- user | role
        subject_id      TEXT NOT NULL,
        dimension       TEXT NOT NULL,             -- mis. region | division | site
        operator        TEXT NOT NULL DEFAULT 'in',-- in | not_in
        values_json     TEXT NOT NULL,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX idx_rls_subject ON rls_rules(tenant_id, subject_type, subject_id);
    `,
  },

  {
    id: '0003_reserved_audit_moved_to_separate_store',
    // Log Aktivitas TIDAK berada di basis data operasional — lihat AUDIT_MIGRATIONS.
    // SECURITY.md Bagian 9 & ARCHITECTURE.md Bagian 11 menuntut penyimpanan terpisah
    // secara fisik agar tidak dapat dimanipulasi meski basis data operasional disusupi.
    sql: `SELECT 1;`,
  },
];

/**
 * Basis data audit TERPISAH (di-attach sebagai skema `auditdb`).
 *
 * SECURITY.md Bagian 9: "Log disimpan terpisah dari basis data operasional (mis. append-only
 * store) untuk mencegah manipulasi bahkan oleh administrator basis data."
 */
export const AUDIT_MIGRATIONS: readonly Migration[] = [
  {
    id: 'audit_0001_append_only',
    sql: `
      -- Log Aktivitas (PRD 6.20). Tulang punggung akuntabilitas platform.
      -- SECURITY.md Bagian 9: immutable — tidak dapat diedit/dihapus oleh peran manapun,
      -- termasuk Super Admin. Ditegakkan oleh TRIGGER basis data, bukan hanya disiplin kode.
      CREATE TABLE auditdb.audit_log (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT,                      -- NULL untuk aksi lintas-tenant Platform Operator
        occurred_at     TEXT NOT NULL,             -- ISO 8601 UTC, tersinkron NTP
        actor_user_id   TEXT,
        actor_label     TEXT NOT NULL,             -- disalin agar log tetap terbaca bila user dihapus
        actor_ip        TEXT,
        action          TEXT NOT NULL,             -- mis. dataset.upload, auth.login, access.denied
        module          TEXT NOT NULL,             -- nama modul PRD Bagian 6
        object_type     TEXT,
        object_id       TEXT,
        object_label    TEXT,
        severity        TEXT NOT NULL DEFAULT 'info', -- info | notice | warning | critical
        outcome         TEXT NOT NULL DEFAULT 'success', -- success | denied | failure
        detail_json     TEXT,
        -- Jalur audit terpisah untuk aktivitas Platform Operator lintas tenant (SECURITY.md 16.2);
        -- tercatat sedemikian rupa sehingga tenant terkait dapat melihatnya.
        operator_access INTEGER NOT NULL DEFAULT 0,
        partition_month TEXT NOT NULL              -- YYYY-MM, partisi untuk retensi panjang (ARCHITECTURE.md 5)
      );
      CREATE INDEX auditdb.idx_audit_tenant_time ON audit_log(tenant_id, occurred_at DESC);
      CREATE INDEX auditdb.idx_audit_actor ON audit_log(tenant_id, actor_user_id, occurred_at DESC);
      CREATE INDEX auditdb.idx_audit_module ON audit_log(tenant_id, module, occurred_at DESC);
      CREATE INDEX auditdb.idx_audit_partition ON audit_log(partition_month);

      CREATE TRIGGER auditdb.audit_log_no_update
        BEFORE UPDATE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit_log is immutable (SECURITY.md Bagian 9)'); END;
      CREATE TRIGGER auditdb.audit_log_no_delete
        BEFORE DELETE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit_log is immutable (SECURITY.md Bagian 9)'); END;

      -- Arsip retensi: entri dipindahkan ke sini sebelum dihapus (PRD 6.20 — retensi ≥24 bulan).
      -- Pemindahan dilakukan proses arsip di luar antarmuka aplikasi.
      CREATE TABLE auditdb.audit_log_archive (
        id              TEXT PRIMARY KEY,
        archived_at     TEXT NOT NULL,
        payload_json    TEXT NOT NULL
      );
    `,
  },
];

/**
 * Secrets vault TERPISAH (di-attach sebagai skema `vault`).
 *
 * SECURITY.md Bagian 6 & ARCHITECTURE.md Bagian 11: kredensial Koneksi Eksternal disimpan
 * terpisah agar kebocoran tidak ikut ter-backup bersama basis data aplikasi biasa.
 */
export const VAULT_MIGRATIONS: readonly Migration[] = [
  {
    id: 'vault_0001_connection_secrets',
    sql: `
      CREATE TABLE vault.connection_secrets (
        connection_id   TEXT NOT NULL,
        tenant_id       TEXT NOT NULL,
        field           TEXT NOT NULL,             -- password | api_key | service_account_json
        key_version     INTEGER NOT NULL,
        iv              TEXT NOT NULL,
        tag             TEXT NOT NULL,
        ciphertext      TEXT NOT NULL,
        rotated_at      TEXT NOT NULL,
        PRIMARY KEY (connection_id, field)
      );
      CREATE INDEX vault.idx_secret_tenant ON connection_secrets(tenant_id);
    `,
  },
];

const REMAINING_MAIN_MIGRATIONS: readonly Migration[] = [
  {
    id: '0004_sessions_and_devices',
    sql: `
      -- Perangkat & Sesi (PRD 6.30, SECURITY.md 17).
      CREATE TABLE device_bindings (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        user_id         TEXT NOT NULL REFERENCES system_user(id),
        -- Disimpan sebagai hash, bukan atribut mentah (SECURITY.md 17.2)
        fingerprint_hash TEXT NOT NULL,
        -- Komponen stabil disimpan terhash terpisah untuk toleransi kemiripan
        -- (mis. pembaruan browser tidak boleh mengunci pengguna sah — SECURITY.md 17.2)
        component_hashes_json TEXT NOT NULL,
        label           TEXT,
        status          TEXT NOT NULL DEFAULT 'active', -- active | unbound | blocked
        first_seen      TEXT NOT NULL,
        last_seen       TEXT NOT NULL,
        last_ip         TEXT,
        unbound_at      TEXT,
        unbound_by      TEXT
      );
      CREATE INDEX idx_device_user ON device_bindings(tenant_id, user_id, status);

      CREATE TABLE active_sessions (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        user_id         TEXT NOT NULL REFERENCES system_user(id),
        token_hash      TEXT NOT NULL UNIQUE,
        device_id       TEXT REFERENCES device_bindings(id),
        issued_at       TEXT NOT NULL,
        expires_at      TEXT NOT NULL,
        last_seen_at    TEXT NOT NULL,
        ip              TEXT,
        geo_lat         REAL,                      -- untuk deteksi impossible travel (PRD 6.30)
        geo_lon         REAL,
        geo_label       TEXT,
        -- Aksi sensitif menuntut re-autentikasi (SECURITY.md 4)
        reauth_at       TEXT,
        revoked_at      TEXT,
        revoked_reason  TEXT
      );
      CREATE INDEX idx_session_user ON active_sessions(tenant_id, user_id);

      CREATE TABLE login_attempts (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT,
        email           TEXT NOT NULL,
        attempted_at    TEXT NOT NULL,
        ip              TEXT,
        outcome         TEXT NOT NULL,             -- success | bad_credentials | locked | device_rejected | impossible_travel
        geo_lat         REAL,
        geo_lon         REAL
      );
      CREATE INDEX idx_login_attempts_email ON login_attempts(email, attempted_at DESC);

      -- Permintaan pemindahan perangkat — memerlukan persetujuan Admin + verifikasi
      -- tambahan (PRD 6.30, SECURITY.md 17.2: titik lemah paling mungkin disalahgunakan).
      CREATE TABLE device_transfer_requests (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        user_id         TEXT NOT NULL REFERENCES system_user(id),
        new_fingerprint_hash TEXT NOT NULL,
        components_json TEXT NOT NULL,
        reason          TEXT,
        otp_hash        TEXT NOT NULL,
        otp_verified    INTEGER NOT NULL DEFAULT 0,
        status          TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | expired
        requested_at    TEXT NOT NULL,
        expires_at      TEXT NOT NULL,
        decided_at      TEXT,
        decided_by      TEXT
      );
      CREATE INDEX idx_transfer_tenant_status ON device_transfer_requests(tenant_id, status);
    `,
  },

  {
    id: '0005_data_platform',
    sql: `
      -- Dataset (PRD 6.11) & Koneksi Eksternal (PRD 6.12).
      CREATE TABLE dataset_catalog (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        name            TEXT NOT NULL,
        source_type     TEXT NOT NULL,             -- upload | connection
        source_ref      TEXT,                      -- connection_id bila source_type=connection
        original_filename TEXT,
        size_bytes      INTEGER NOT NULL DEFAULT 0,
        row_count       INTEGER NOT NULL DEFAULT 0,
        -- processing | ready | failed | quarantined
        status          TEXT NOT NULL DEFAULT 'processing',
        failure_reason_key TEXT,                   -- alasan kegagalan yang jelas & dapat ditelusuri (PRD 6.11)
        failure_detail  TEXT,
        -- public | internal | confidential | restricted (SECURITY.md Bagian 3)
        classification  TEXT NOT NULL DEFAULT 'internal',
        -- draft | reviewing | certified | rejected (PRD 6.14)
        certification   TEXT NOT NULL DEFAULT 'draft',
        certified_by    TEXT,
        certified_at    TEXT,
        quality_score   REAL,
        uploaded_by     TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX idx_dataset_tenant ON dataset_catalog(tenant_id, status);

      CREATE TABLE dataset_columns (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        dataset_id      TEXT NOT NULL REFERENCES dataset_catalog(id),
        position        INTEGER NOT NULL,
        name            TEXT NOT NULL,
        detected_type   TEXT NOT NULL,             -- text | number | date | boolean
        confirmed_type  TEXT,                      -- dikonfirmasi pengguna (PRD 6.11)
        null_count      INTEGER NOT NULL DEFAULT 0,
        distinct_count  INTEGER NOT NULL DEFAULT 0,
        sample_json     TEXT,
        -- pemetaan ke model data (PRD 6.11 / 6.13)
        mapped_table    TEXT,
        mapped_field    TEXT,
        mapped_role     TEXT                       -- measure | dimension | time | key
      );
      CREATE INDEX idx_dscol_dataset ON dataset_columns(tenant_id, dataset_id, position);

      -- Baris data tersimpan sebagai JSON per baris: platform bersifat domain-agnostic
      -- (PRD 3.1) sehingga skema kolom tidak dapat ditetapkan di muka.
      CREATE TABLE dataset_rows (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        dataset_id      TEXT NOT NULL REFERENCES dataset_catalog(id),
        row_index       INTEGER NOT NULL,
        data_json       TEXT NOT NULL
      );
      CREATE INDEX idx_dsrow_dataset ON dataset_rows(tenant_id, dataset_id, row_index);

      CREATE TABLE external_connections (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        name            TEXT NOT NULL,
        kind            TEXT NOT NULL,             -- rest_api | postgresql | mysql | oracle | google_sheets
        host            TEXT,
        port            INTEGER,
        database_name   TEXT,
        username        TEXT,
        options_json    TEXT,
        -- connected | auth_failed | sync_pending | never_tested | locked
        status          TEXT NOT NULL DEFAULT 'never_tested',
        read_only       INTEGER NOT NULL DEFAULT 1,-- least privilege (SECURITY.md 8)
        schedule        TEXT,                      -- manual | 15m | hourly | daily
        last_sync_at    TEXT,
        last_sync_outcome TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        locked_until    TEXT,                      -- penguncian sementara setelah gagal berulang (SECURITY.md 8)
        created_by      TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX idx_conn_tenant ON external_connections(tenant_id);

      -- Secrets vault TERPISAH dari basis data aplikasi biasa (SECURITY.md 6, ARCHITECTURE.md 11).
      -- Tabel ini di-attach dari berkas basis data lain; lihat db.ts.
      CREATE TABLE connection_sync_runs (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        connection_id   TEXT NOT NULL REFERENCES external_connections(id),
        started_at      TEXT NOT NULL,
        finished_at     TEXT,
        outcome         TEXT NOT NULL,             -- success | auth_failed | unreachable | partial
        rows_ingested   INTEGER NOT NULL DEFAULT 0,
        message_key     TEXT
      );
      CREATE INDEX idx_syncrun_conn ON connection_sync_runs(tenant_id, connection_id, started_at DESC);

      -- Data Modeling (PRD 6.13)
      CREATE TABLE model_tables (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        name            TEXT NOT NULL,
        kind            TEXT NOT NULL,             -- fact | dimension
        grain           TEXT,                      -- grain eksplisit per tabel (ARCHITECTURE.md 5)
        scd_type        INTEGER,                   -- SCD tipe 2 untuk atribut yang berubah
        description     TEXT,
        created_at      TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_modeltable_tenant_name ON model_tables(tenant_id, name);

      CREATE TABLE model_fields (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        table_id        TEXT NOT NULL REFERENCES model_tables(id),
        name            TEXT NOT NULL,
        data_type       TEXT NOT NULL,
        role            TEXT NOT NULL,             -- measure | dimension | time | key
        formula         TEXT,                      -- Formula Builder tanpa SQL (PRD 6.13)
        description     TEXT
      );
      CREATE INDEX idx_modelfield_table ON model_fields(tenant_id, table_id);

      -- Lineage tercatat otomatis dari sumber hingga dashboard/laporan (PRD 6.13)
      CREATE TABLE data_lineage (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        from_type       TEXT NOT NULL,             -- dataset | connection | model_table | kpi | dashboard | report
        from_id         TEXT NOT NULL,
        to_type         TEXT NOT NULL,
        to_id           TEXT NOT NULL,
        relation        TEXT NOT NULL,             -- feeds | derives | publishes
        created_at      TEXT NOT NULL
      );
      CREATE INDEX idx_lineage_from ON data_lineage(tenant_id, from_type, from_id);
      CREATE INDEX idx_lineage_to ON data_lineage(tenant_id, to_type, to_id);

      CREATE TABLE business_dictionary (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        term            TEXT NOT NULL,
        definition_id   TEXT NOT NULL,
        definition_en   TEXT,
        owner_employee_id TEXT,
        related_field_id  TEXT,
        updated_at      TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_dict_tenant_term ON business_dictionary(tenant_id, term);

      -- Data Quality Center (PRD 6.14)
      CREATE TABLE dq_runs (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        dataset_id      TEXT NOT NULL REFERENCES dataset_catalog(id),
        ran_at          TEXT NOT NULL,
        score           REAL NOT NULL,
        rows_checked    INTEGER NOT NULL,
        duplicate_rows  INTEGER NOT NULL DEFAULT 0,
        missing_cells   INTEGER NOT NULL DEFAULT 0,
        invalid_cells   INTEGER NOT NULL DEFAULT 0,
        findings_json   TEXT NOT NULL
      );
      CREATE INDEX idx_dqrun_dataset ON dq_runs(tenant_id, dataset_id, ran_at DESC);
    `,
  },

  {
    id: '0006_kpi_and_alerting',
    sql: `
      -- KPI Center (PRD 6.15)
      CREATE TABLE kpi_definition (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        code            TEXT NOT NULL,
        name            TEXT NOT NULL,
        description     TEXT,
        formula         TEXT NOT NULL,
        unit            TEXT,
        direction       TEXT NOT NULL DEFAULT 'higher_better', -- higher_better | lower_better
        owner_employee_id TEXT,
        weight          REAL NOT NULL DEFAULT 1,
        target          REAL,
        dataset_id      TEXT,
        measure_field   TEXT,
        dimension_field TEXT,
        -- draft | pending_approval | approved | archived  (approval workflow, PRD 6.15)
        state           TEXT NOT NULL DEFAULT 'draft',
        pending_change_json TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_kpi_tenant_code ON kpi_definition(tenant_id, code);

      CREATE TABLE kpi_threshold (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        kpi_id          TEXT NOT NULL REFERENCES kpi_definition(id),
        level           TEXT NOT NULL,             -- on_track | at_risk | critical
        comparator      TEXT NOT NULL,             -- gte | lte
        value           REAL NOT NULL
      );
      CREATE INDEX idx_threshold_kpi ON kpi_threshold(tenant_id, kpi_id);

      -- Di-snapshot berkala, bukan dihitung ulang mundur, agar tren historis stabil
      -- (ARCHITECTURE.md Bagian 5).
      CREATE TABLE kpi_score_history (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        kpi_id          TEXT NOT NULL REFERENCES kpi_definition(id),
        period          TEXT NOT NULL,             -- YYYY-MM
        value           REAL NOT NULL,
        score           REAL NOT NULL,             -- 0..100
        status          TEXT NOT NULL,
        dimension_key   TEXT,                      -- untuk RLS per wilayah/divisi
        captured_at     TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_kpihist_unique
        ON kpi_score_history(tenant_id, kpi_id, period, IFNULL(dimension_key,'*'));

      CREATE TABLE kpi_approvals (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        kpi_id          TEXT NOT NULL REFERENCES kpi_definition(id),
        requested_by    TEXT NOT NULL,
        requested_at    TEXT NOT NULL,
        decided_by      TEXT,
        decided_at      TEXT,
        decision        TEXT,                      -- approved | rejected
        note            TEXT,
        change_json     TEXT NOT NULL
      );
      CREATE INDEX idx_kpiappr_kpi ON kpi_approvals(tenant_id, kpi_id);

      -- Alert Center (PRD 6.16)
      CREATE TABLE alert_rules (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        name            TEXT NOT NULL,
        kpi_id          TEXT REFERENCES kpi_definition(id),
        asset_id        TEXT,                      -- Digital Twin memakai jalur notifikasi yang sama (PRD 6.17)
        sensor_code     TEXT,
        comparator      TEXT NOT NULL,             -- gt | lt | gte | lte
        threshold       REAL NOT NULL,
        channels_json   TEXT NOT NULL,             -- email | whatsapp | telegram | sms | teams | slack
        recipients_json TEXT NOT NULL,
        enabled         INTEGER NOT NULL DEFAULT 1,
        cooldown_minutes INTEGER NOT NULL DEFAULT 60, -- mencegah notifikasi ganda (TESTING.md 2)
        created_at      TEXT NOT NULL
      );
      CREATE INDEX idx_alertrule_tenant ON alert_rules(tenant_id, enabled);

      CREATE TABLE alert_events (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        rule_id         TEXT NOT NULL REFERENCES alert_rules(id),
        detected_at     TEXT NOT NULL,
        observed_value  REAL NOT NULL,
        severity        TEXT NOT NULL,
        message_key     TEXT NOT NULL,
        context_json    TEXT,
        acknowledged_by TEXT,
        acknowledged_at TEXT,
        follow_up_note  TEXT
      );
      CREATE INDEX idx_alertevent_tenant ON alert_events(tenant_id, detected_at DESC);

      CREATE TABLE alert_deliveries (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        event_id        TEXT NOT NULL REFERENCES alert_events(id),
        channel         TEXT NOT NULL,
        recipient       TEXT NOT NULL,
        queued_at       TEXT NOT NULL,
        delivered_at    TEXT,
        attempts        INTEGER NOT NULL DEFAULT 0,
        outcome         TEXT NOT NULL DEFAULT 'queued', -- queued | delivered | failed
        failure_reason  TEXT
      );
      CREATE INDEX idx_delivery_event ON alert_deliveries(tenant_id, event_id);
    `,
  },

  {
    id: '0007_designer_and_embed',
    sql: `
      CREATE TABLE dashboards (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        name            TEXT NOT NULL,
        description     TEXT,
        owner_user_id   TEXT,
        classification  TEXT NOT NULL DEFAULT 'internal',
        theme           TEXT NOT NULL DEFAULT 'system',
        accent_override TEXT,
        template_code   TEXT,
        -- versioning dasar: draft disimpan terpisah dari versi terbit (PRD 6.3)
        draft_layout_json    TEXT NOT NULL DEFAULT '[]',
        published_layout_json TEXT,
        published_at    TEXT,
        published_by    TEXT,
        version         INTEGER NOT NULL DEFAULT 1,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX idx_dashboard_tenant ON dashboards(tenant_id);

      CREATE TABLE dashboard_versions (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        dashboard_id    TEXT NOT NULL REFERENCES dashboards(id),
        version         INTEGER NOT NULL,
        layout_json     TEXT NOT NULL,
        published_at    TEXT NOT NULL,
        published_by    TEXT
      );
      CREATE INDEX idx_dashver ON dashboard_versions(tenant_id, dashboard_id, version DESC);

      CREATE TABLE reports (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        name            TEXT NOT NULL,
        classification  TEXT NOT NULL DEFAULT 'internal',
        page_size       TEXT NOT NULL DEFAULT 'A4',
        orientation     TEXT NOT NULL DEFAULT 'portrait',
        header_json     TEXT,
        footer_json     TEXT,
        watermark       TEXT,                      -- draft | confidential | none
        signature_json  TEXT,                      -- tanda tangan digital (PRD 6.4)
        blocks_json     TEXT NOT NULL DEFAULT '[]',
        schedule_cron   TEXT,                      -- penjadwalan pengiriman otomatis (PRD 6.4)
        schedule_recipients_json TEXT,
        owner_user_id   TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX idx_report_tenant ON reports(tenant_id);

      -- Embed Dashboard (PRD 6.21). Tabel terpisah dari dashboards utama
      -- (ARCHITECTURE.md Bagian 5 — embed_tokens_db).
      CREATE TABLE embed_tokens (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        dashboard_id    TEXT NOT NULL REFERENCES dashboards(id),
        token_hash      TEXT NOT NULL UNIQUE,
        label           TEXT,
        -- Cakupan RLS ditetapkan saat pembuatan, dievaluasi ULANG di server tiap
        -- permintaan — bukan parameter yang bisa diubah klien (SECURITY.md 15).
        rls_scope_json  TEXT NOT NULL DEFAULT '[]',
        domain_whitelist_json TEXT NOT NULL,
        mode            TEXT NOT NULL DEFAULT 'interactive', -- interactive | static
        show_attribution INTEGER NOT NULL DEFAULT 1,         -- BRAND.md Bagian 8
        expires_at      TEXT NOT NULL,
        revoked_at      TEXT,                      -- diperiksa SETIAP permintaan (ARCHITECTURE.md 5)
        created_by      TEXT,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX idx_embed_dashboard ON embed_tokens(tenant_id, dashboard_id);

      CREATE TABLE embed_requests (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id       TEXT,
        token_id        TEXT,
        requested_at    TEXT NOT NULL,
        origin          TEXT,
        outcome         TEXT NOT NULL,             -- allowed | denied_domain | denied_expired | denied_revoked | rate_limited
        ip              TEXT
      );
      CREATE INDEX idx_embedreq_token ON embed_requests(token_id, requested_at DESC);
    `,
  },

  {
    id: '0008_ai_stats_and_twin',
    sql: `
      -- Jejak modul AI. Jawaban selalu mencantumkan sumber data & periode (SECURITY.md 11).
      CREATE TABLE ai_queries (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        user_id         TEXT NOT NULL,
        asked_at        TEXT NOT NULL,
        question        TEXT NOT NULL,
        locale          TEXT NOT NULL,             -- narasi mengikuti bahasa pertanyaan (DESIGN.md 8.4)
        intent_json     TEXT,
        answer_text     TEXT,
        sources_json    TEXT,                      -- dataset + periode yang dipakai
        provider        TEXT NOT NULL,             -- deterministic | llm:<name>
        breakdown_json  TEXT
      );
      CREATE INDEX idx_aiq_tenant ON ai_queries(tenant_id, asked_at DESC);

      CREATE TABLE forecast_runs (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        kpi_id          TEXT,
        dataset_id      TEXT,
        method          TEXT NOT NULL,             -- linear_regression | arima | prophet
        horizon         INTEGER NOT NULL,
        created_at      TEXT NOT NULL,
        points_json     TEXT NOT NULL,             -- termasuk confidence interval
        mape            REAL,                      -- metrik akurasi (PRD 6.7)
        holdout_json    TEXT
      );
      CREATE INDEX idx_forecast_tenant ON forecast_runs(tenant_id, created_at DESC);

      -- RCA selalu berstatus draf sampai divalidasi manusia (PRD 6.8, SECURITY.md 11).
      CREATE TABLE rca_records (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        kpi_id          TEXT,
        title           TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        created_by      TEXT,
        status          TEXT NOT NULL DEFAULT 'draft', -- draft | validated
        validated_by    TEXT,
        validated_at    TEXT,
        fishbone_json   TEXT NOT NULL,
        five_why_json   TEXT NOT NULL,
        pareto_json     TEXT NOT NULL,
        evidence_json   TEXT
      );
      CREATE INDEX idx_rca_tenant ON rca_records(tenant_id, created_at DESC);

      CREATE TABLE narrative_reports (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        period          TEXT NOT NULL,
        compare_period  TEXT NOT NULL,
        locale          TEXT NOT NULL,
        generated_at    TEXT NOT NULL,
        body_json       TEXT NOT NULL,
        recipients_json TEXT,
        sent_at         TEXT
      );
      CREATE INDEX idx_narrative_tenant ON narrative_reports(tenant_id, generated_at DESC);

      -- Hasil analisis statistik di-cache; deterministik sehingga aman di-cache
      -- (ARCHITECTURE.md Bagian 3 — alasan stats-service dipisah).
      CREATE TABLE stat_analyses (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        dataset_id      TEXT NOT NULL,
        kind            TEXT NOT NULL,             -- descriptive | hypothesis | regression | correlation
        spec_json       TEXT NOT NULL,
        spec_hash       TEXT NOT NULL,
        result_json     TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        created_by      TEXT
      );
      CREATE UNIQUE INDEX idx_stat_cache ON stat_analyses(tenant_id, spec_hash);

      -- Digital Twin (PRD 6.17). Definisi aset & sensor DIKONFIGURASI PENGGUNA,
      -- bukan ditanam di kode — inilah yang membuat modul dapat dipakai lintas sektor.
      CREATE TABLE asset_zones (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        name            TEXT NOT NULL,
        parent_id       TEXT,
        layout_json     TEXT
      );
      CREATE INDEX idx_zone_tenant ON asset_zones(tenant_id);

      CREATE TABLE assets (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        zone_id         TEXT REFERENCES asset_zones(id),
        code            TEXT NOT NULL,
        name            TEXT NOT NULL,
        category        TEXT NOT NULL,             -- bebas: hvac | vehicle | transformer | incubator | ...
        status          TEXT NOT NULL DEFAULT 'normal', -- normal | attention | critical | offline
        health_score    REAL NOT NULL DEFAULT 100,
        pos_x           REAL,
        pos_y           REAL,
        commissioned_at TEXT,
        operating_hours REAL NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_asset_tenant_code ON assets(tenant_id, code);

      CREATE TABLE sensor_definitions (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        asset_id        TEXT NOT NULL REFERENCES assets(id),
        code            TEXT NOT NULL,
        label           TEXT NOT NULL,
        unit            TEXT NOT NULL,
        warn_min        REAL, warn_max REAL,
        crit_min        REAL, crit_max REAL,
        weight          REAL NOT NULL DEFAULT 1
      );
      CREATE INDEX idx_sensordef_asset ON sensor_definitions(tenant_id, asset_id);

      CREATE TABLE sensor_readings (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        asset_id        TEXT NOT NULL,
        sensor_code     TEXT NOT NULL,
        observed_at     TEXT NOT NULL,
        value           REAL NOT NULL
      );
      CREATE INDEX idx_reading_lookup ON sensor_readings(tenant_id, asset_id, sensor_code, observed_at DESC);

      -- Prediksi selalu RENTANG + tingkat keyakinan, bukan angka tunggal (PRD 6.17).
      CREATE TABLE failure_predictions (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        asset_id        TEXT NOT NULL REFERENCES assets(id),
        predicted_at    TEXT NOT NULL,
        window_start    TEXT NOT NULL,
        window_end      TEXT NOT NULL,
        confidence      REAL NOT NULL,             -- 0..1; rendah ditandai jelas di UI
        basis_json      TEXT NOT NULL,
        impact_score    REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_prediction_asset ON failure_predictions(tenant_id, asset_id, predicted_at DESC);

      CREATE TABLE maintenance_tickets (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        asset_id        TEXT NOT NULL REFERENCES assets(id),
        title           TEXT NOT NULL,
        priority        TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'open',
        created_by      TEXT,
        created_at      TEXT NOT NULL,
        external_ref    TEXT
      );
      CREATE INDEX idx_ticket_tenant ON maintenance_tickets(tenant_id, status);

      -- Balanced Scorecard (PRD 6.25). KPI ditarik dari KPI Center — tidak ada definisi ganda.
      CREATE TABLE bsc_perspectives (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        code            TEXT NOT NULL,             -- financial | customer | internal_process | learning_growth | custom
        name            TEXT NOT NULL,
        weight          REAL NOT NULL DEFAULT 0.25,
        sort_order      INTEGER NOT NULL DEFAULT 0,
        scorecard_level TEXT NOT NULL DEFAULT 'corporate', -- corporate | division
        parent_scorecard TEXT
      );
      CREATE INDEX idx_bscp_tenant ON bsc_perspectives(tenant_id);

      CREATE TABLE bsc_objectives (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id),
        perspective_id  TEXT NOT NULL REFERENCES bsc_perspectives(id),
        name            TEXT NOT NULL,
        owner_employee_id TEXT,
        target          REAL,
        kpi_id          TEXT REFERENCES kpi_definition(id),
        initiatives_json TEXT,
        -- Strategy Map: hubungan sebab-akibat antar-sasaran lintas perspektif
        causes_json     TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX idx_bsco_perspective ON bsc_objectives(tenant_id, perspective_id);
    `,
  },
  {
    // MFA berbasis TOTP (SECURITY.md Bagian 4). `mfa_enrolled` sudah ada sejak migrasi
    // 0002 tetapi tidak pernah punya penyimpanan pendukung; ini melengkapinya.
    //
    // Ditambahkan sebagai migrasi TERSENDIRI, bukan dengan menyunting 0002, karena
    // basis data yang sudah terpasang tidak menjalankan ulang migrasi yang sudah
    // tercatat — menyunting migrasi lama hanya akan bekerja di basis data baru dan
    // gagal senyap di basis data yang sudah berjalan (DEPLOYMENT.md Bagian 6).
    id: '0009_mfa_totp',
    sql: `
      -- Rahasia disimpan terpisah dari flag mfa_enrolled supaya ada keadaan
      -- "sudah menyiapkan rahasia tetapi BELUM diaktifkan": rahasia yang dibuat lalu
      -- ditinggalkan tidak boleh membuat akun tiba-tiba menuntut kode.
      ALTER TABLE system_user ADD COLUMN mfa_secret TEXT;
      ALTER TABLE system_user ADD COLUMN mfa_activated_at TEXT;
      -- Langkah waktu TOTP terakhir yang berhasil dipakai. Tanpa ini, kode yang
      -- tertangkap masih dapat dipakai ulang selama jendela 30 detiknya belum lewat.
      ALTER TABLE system_user ADD COLUMN mfa_last_counter INTEGER;
      ALTER TABLE system_user ADD COLUMN mfa_failed_attempts INTEGER NOT NULL DEFAULT 0;

      -- Kode pemulihan sekali pakai, disimpan sebagai HASH.
      -- Kebocoran basis data tidak boleh langsung menghasilkan jalur masuk yang dapat
      -- dipakai, sama seperti perlakuan terhadap token sesi.
      CREATE TABLE mfa_recovery_codes (
        id           TEXT PRIMARY KEY,
        tenant_id    TEXT NOT NULL REFERENCES tenants(id),
        user_id      TEXT NOT NULL REFERENCES system_user(id),
        code_hash    TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        used_at      TEXT,
        used_ip      TEXT
      );
      CREATE INDEX idx_mfa_recovery_user ON mfa_recovery_codes(tenant_id, user_id);
      CREATE UNIQUE INDEX idx_mfa_recovery_hash ON mfa_recovery_codes(user_id, code_hash);

      -- Tantangan MFA: keadaan antara "kata sandi & perangkat sudah lolos" dan
      -- "sesi diterbitkan".
      --
      -- Ada sebagai tabel, bukan di memori, karena Passenger di shared hosting
      -- menjalankan beberapa proses dan me-recycle-nya saat idle: tantangan yang
      -- disimpan di memori akan hilang atau tidak terlihat oleh proses yang menerima
      -- permintaan verifikasi. Token tantangan disimpan ter-hash dan terikat pada
      -- perangkat serta IP yang memulainya.
      CREATE TABLE mfa_challenges (
        id               TEXT PRIMARY KEY,
        tenant_id        TEXT NOT NULL REFERENCES tenants(id),
        user_id          TEXT NOT NULL REFERENCES system_user(id),
        token_hash       TEXT NOT NULL,
        device_id        TEXT,
        fingerprint_hash TEXT,
        ip               TEXT,
        geo_json         TEXT,
        attempts         INTEGER NOT NULL DEFAULT 0,
        issued_at        TEXT NOT NULL,
        expires_at       TEXT NOT NULL,
        consumed_at      TEXT
      );
      CREATE UNIQUE INDEX idx_mfa_challenge_token ON mfa_challenges(token_hash);
      CREATE INDEX idx_mfa_challenge_user ON mfa_challenges(tenant_id, user_id);
    `,
  },
];

/**
 * Migrasi basis data operasional utama, terurut.
 * Runner mencatat migrasi yang sudah dijalankan; menambah entri baru di akhir daftar
 * adalah satu-satunya cara mengubah skema (DEPLOYMENT.md Bagian 6).
 */
export const MIGRATIONS: readonly Migration[] = [...CORE_MIGRATIONS, ...REMAINING_MAIN_MIGRATIONS];
