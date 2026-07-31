/**
 * Modul Dataset (PRD 6.11) & Data Quality Center (PRD 6.14).
 *
 * Alur mengikuti ARCHITECTURE.md 4.1:
 *   Upload → validasi & scan → Data Quality Center → pemetaan Data Modeling
 */
import { newId, nowIso } from '../platform/db.ts';
import { ConflictError, NotFoundError, PayloadTooLargeError, ValidationError } from '../platform/errors.ts';
import type { RequestContext } from '../platform/context.ts';
import type { WhereClause } from '../platform/tenancy.ts';
import type { MeteringService } from '../metering-service/index.ts';
import {
  MAX_UPLOAD_BYTES,
  parseCsv,
  scanForMalware,
  validateFilename,
  type DetectedColumn,
} from './csv.ts';
import { xlsxToCsv } from './xlsx.ts';
import { assessQuality, CERTIFICATION_THRESHOLD, type DatasetRow, type QualityReport } from './dataQuality.ts';

export type DataClassification = 'public' | 'internal' | 'confidential' | 'restricted';

export interface DatasetSummary {
  id: string;
  name: string;
  source_type: string;
  status: string;
  classification: string;
  certification: string;
  quality_score: number | null;
  row_count: number;
  size_bytes: number;
  original_filename: string | null;
  failure_reason_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface UploadInput {
  filename: string;
  content: Buffer;
  name?: string;
  classification?: DataClassification;
}

export interface UploadResult {
  dataset: DatasetSummary;
  quality: QualityReport;
  columns: DetectedColumn[];
}

export class DatasetService {
  constructor(
    private readonly ctx: RequestContext,
    private readonly metering?: MeteringService,
  ) {}

  list(filter: { status?: string; certification?: string } = {}): DatasetSummary[] {
    this.ctx.require('dataset:read', { module: 'Dataset' });
    this.ctx.requireModule('dataset');
    const where: WhereClause = {};
    if (filter.status) where.status = filter.status;
    if (filter.certification) where.certification = filter.certification;
    return this.ctx.db.all<DatasetSummary>('dataset_catalog', where, { orderBy: 'created_at DESC' });
  }

  get(datasetId: string): { dataset: DatasetSummary; columns: DetectedColumn[]; latestRun: QualityReport | null } {
    this.ctx.require('dataset:read', { module: 'Dataset', objectId: datasetId });
    const dataset = this.ctx.db.get<DatasetSummary>('dataset_catalog', { id: datasetId });
    if (!dataset) throw new NotFoundError();

    // Akses ke dataset Confidential/Restricted dicatat individual (SECURITY.md Bagian 3 & 9).
    if (dataset.classification === 'confidential' || dataset.classification === 'restricted') {
      this.ctx.log({
        action: 'dataset.sensitive_access',
        module: 'Dataset',
        objectType: 'dataset',
        objectId: datasetId,
        objectLabel: dataset.name,
        severity: 'notice',
        detail: { classification: dataset.classification },
      });
    }

    const columnRows = this.ctx.db.all<{
      name: string;
      detected_type: string;
      confirmed_type: string | null;
      null_count: number;
      distinct_count: number;
      sample_json: string | null;
      mapped_table: string | null;
      mapped_field: string | null;
      mapped_role: string | null;
    }>('dataset_columns', { dataset_id: datasetId }, { orderBy: 'position' });

    const columns = columnRows.map((c) => ({
      name: c.name,
      type: (c.confirmed_type ?? c.detected_type) as DetectedColumn['type'],
      nullCount: c.null_count,
      distinctCount: c.distinct_count,
      samples: c.sample_json ? (JSON.parse(c.sample_json) as string[]) : [],
      mapping: c.mapped_table ? { table: c.mapped_table, field: c.mapped_field, role: c.mapped_role } : null,
    })) as DetectedColumn[];

    const run = this.ctx.db.all<{
      score: number;
      rows_checked: number;
      duplicate_rows: number;
      missing_cells: number;
      invalid_cells: number;
      findings_json: string;
    }>('dq_runs', { dataset_id: datasetId }, { orderBy: 'ran_at DESC', limit: 1 })[0];

    const latestRun: QualityReport | null = run
      ? {
          score: run.score,
          rowsChecked: run.rows_checked,
          duplicateRows: run.duplicate_rows,
          missingCells: run.missing_cells,
          invalidCells: run.invalid_cells,
          findings: JSON.parse(run.findings_json),
          certifiable: run.score >= CERTIFICATION_THRESHOLD,
        }
      : null;

    return { dataset, columns, latestRun };
  }

  /**
   * Unggah berkas. Urutan kontrol keamanan mengikuti SECURITY.md Bagian 7:
   * validasi tipe → batas ukuran → pemindaian malware → parsing terisolasi → audit.
   */
  upload(input: UploadInput): UploadResult {
    this.ctx.require('dataset:upload', { module: 'Dataset' });
    this.ctx.requireModule('dataset');
    this.ctx.requireWritable();

    const nameCheck = validateFilename(input.filename);
    if (!nameCheck.ok) {
      this.recordFailedUpload(input.filename, nameCheck.reasonKey, input.content.length);
      throw new ValidationError(nameCheck.reasonKey, { filename: input.filename });
    }

    if (input.content.length > MAX_UPLOAD_BYTES) {
      this.recordFailedUpload(input.filename, 'error.upload_failed', input.content.length);
      throw new PayloadTooLargeError('error.upload_failed', {
        size: input.content.length,
        max: MAX_UPLOAD_BYTES,
      });
    }

    const scan = scanForMalware(input.content);
    if (!scan.clean) {
      this.recordFailedUpload(input.filename, scan.reasonKey!, input.content.length);
      // Malware = potensi insiden keamanan, bukan sekadar unggahan gagal.
      this.ctx.log({
        action: 'dataset.malware_blocked',
        module: 'Dataset',
        objectType: 'upload',
        objectLabel: input.filename,
        severity: 'critical',
        outcome: 'denied',
      });
      throw new ValidationError(scan.reasonKey!);
    }

    // Kuota dataset (PRD 6.29).
    this.metering?.assertWithinQuota('datasets', 1);

    /**
     * XLSX dibaca lalu dialirkan lewat jalur CSV yang sama.
     *
     * Sengaja tidak punya jalur pembentukan dataset sendiri: deteksi tipe kolom, penanganan
     * sel kosong, dan batas jumlah baris sudah teruji di jalur CSV. Dua jalur berarti dua
     * tempat yang harus sepakat — dan diam-diam menyimpang.
     */
    const text =
      nameCheck.extension === '.xlsx' ? xlsxToCsv(input.content) : input.content.toString('utf8');

    const parsed = parseCsv(text);
    const quality = assessQuality(parsed.rows as DatasetRow[], parsed.columns);

    const at = nowIso();
    const datasetId = newId('ds');
    const name = input.name?.trim() || input.filename.replace(/\.[^.]+$/, '');

    this.ctx.db.transaction(() => {
      this.ctx.db.insert('dataset_catalog', {
        id: datasetId,
        name,
        source_type: 'upload',
        source_ref: null,
        original_filename: input.filename,
        size_bytes: input.content.length,
        row_count: parsed.rowCount,
        // Dataset masuk antrean pemeriksaan DQ sebelum dapat dipakai di dashboard (PRD 6.11)
        status: 'ready',
        failure_reason_key: null,
        failure_detail: null,
        classification: input.classification ?? 'internal',
        certification: 'draft',
        certified_by: null,
        certified_at: null,
        quality_score: quality.score,
        uploaded_by: this.ctx.actor.userId,
        created_at: at,
        updated_at: at,
      });

      parsed.columns.forEach((col, index) => {
        this.ctx.db.insert('dataset_columns', {
          id: newId('dc'),
          dataset_id: datasetId,
          position: index,
          name: col.name,
          detected_type: col.type,
          confirmed_type: null,
          null_count: col.nullCount,
          distinct_count: col.distinctCount,
          sample_json: JSON.stringify(col.samples),
          mapped_table: null,
          mapped_field: null,
          mapped_role: null,
        });
      });

      parsed.rows.forEach((row, index) => {
        this.ctx.db.insert('dataset_rows', {
          id: null as unknown as number,
          dataset_id: datasetId,
          row_index: index,
          data_json: JSON.stringify(row),
        });
      });

      this.ctx.db.insert('dq_runs', {
        id: newId('dq'),
        dataset_id: datasetId,
        ran_at: at,
        score: quality.score,
        rows_checked: quality.rowsChecked,
        duplicate_rows: quality.duplicateRows,
        missing_cells: quality.missingCells,
        invalid_cells: quality.invalidCells,
        findings_json: JSON.stringify(quality.findings),
      });

      this.ctx.db.insert('data_lineage', {
        id: newId('lin'),
        from_type: 'dataset',
        from_id: datasetId,
        to_type: 'dq_run',
        to_id: datasetId,
        relation: 'feeds',
        created_at: at,
      });
    });

    this.metering?.record('datasets', 1, 'dataset.upload');
    this.metering?.record('storage_mb', input.content.length / (1024 * 1024), 'dataset.upload');

    // Riwayat unggahan tercatat & terhubung ke Log Aktivitas (PRD 6.11, TC-DS-05).
    this.ctx.log({
      action: 'dataset.upload',
      module: 'Dataset',
      objectType: 'dataset',
      objectId: datasetId,
      objectLabel: name,
      detail: {
        filename: input.filename,
        sizeBytes: input.content.length,
        rows: parsed.rowCount,
        qualityScore: quality.score,
      },
    });

    const dataset = this.ctx.db.get<DatasetSummary>('dataset_catalog', { id: datasetId })!;
    return { dataset, quality, columns: parsed.columns };
  }

  /** Dataset gagal validasi ditandai dengan alasan yang jelas & dapat ditelusuri (PRD 6.11). */
  private recordFailedUpload(filename: string, reasonKey: string, size: number): void {
    const at = nowIso();
    this.ctx.db.insert('dataset_catalog', {
      id: newId('ds'),
      name: filename,
      source_type: 'upload',
      source_ref: null,
      original_filename: filename,
      size_bytes: size,
      row_count: 0,
      status: 'failed',
      failure_reason_key: reasonKey,
      failure_detail: null,
      classification: 'internal',
      certification: 'draft',
      certified_by: null,
      certified_at: null,
      quality_score: null,
      uploaded_by: this.ctx.actor.userId,
      created_at: at,
      updated_at: at,
    });
    this.ctx.log({
      action: 'dataset.upload',
      module: 'Dataset',
      objectType: 'upload',
      objectLabel: filename,
      outcome: 'failure',
      severity: 'warning',
      detail: { reasonKey, sizeBytes: size },
    });
  }

  /** Membaca baris dataset dengan RLS diterapkan DI SISI SERVER (SECURITY.md Bagian 5). */
  rows(datasetId: string, options: { limit?: number; offset?: number } = {}): {
    rows: DatasetRow[];
    total: number;
    rlsFiltered: number;
  } {
    this.ctx.require('dataset:read', { module: 'Dataset', objectId: datasetId });
    const dataset = this.ctx.db.get<DatasetSummary>('dataset_catalog', { id: datasetId });
    if (!dataset) throw new NotFoundError();

    const raw = this.ctx.db.all<{ data_json: string }>(
      'dataset_rows',
      { dataset_id: datasetId },
      { orderBy: 'row_index' },
    );
    const all = raw.map((r) => JSON.parse(r.data_json) as DatasetRow);

    // Difilter SEBELUM paginasi agar jumlah total yang dilaporkan juga sudah sesuai
    // cakupan pengguna — data di luar cakupan tidak pernah keluar dari respons API.
    const permitted = this.ctx.rls.filter(all);
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 500;

    return {
      rows: permitted.slice(offset, offset + limit),
      total: permitted.length,
      rlsFiltered: all.length - permitted.length,
    };
  }

  /** Semua baris untuk pemakaian internal (statistik/KPI), tetap dengan RLS. */
  allRows(datasetId: string): DatasetRow[] {
    const raw = this.ctx.db.all<{ data_json: string }>(
      'dataset_rows',
      { dataset_id: datasetId },
      { orderBy: 'row_index' },
    );
    return this.ctx.rls.filter(raw.map((r) => JSON.parse(r.data_json) as DatasetRow));
  }

  /** Pengguna mengonfirmasi/mengoreksi tipe kolom hasil deteksi otomatis (PRD 6.11). */
  confirmColumnTypes(datasetId: string, types: Record<string, DetectedColumn['type']>): void {
    this.ctx.require('dataset:write', { module: 'Dataset', objectId: datasetId });
    this.ctx.requireWritable();
    for (const [column, type] of Object.entries(types)) {
      this.ctx.db.update('dataset_columns', { dataset_id: datasetId, name: column }, { confirmed_type: type });
    }
    this.ctx.log({
      action: 'dataset.columns_confirmed',
      module: 'Dataset',
      objectType: 'dataset',
      objectId: datasetId,
      detail: { types },
    });
  }

  /** Memetakan kolom sumber ke fact/dimension table di Data Modeling (PRD 6.11). */
  mapColumns(
    datasetId: string,
    mappings: Array<{ column: string; table: string; field: string; role: 'measure' | 'dimension' | 'time' | 'key' }>,
  ): void {
    this.ctx.require('datamodel:write', { module: 'Data Modeling', objectId: datasetId });
    this.ctx.requireWritable();

    const dataset = this.ctx.db.get<DatasetSummary>('dataset_catalog', { id: datasetId });
    if (!dataset) throw new NotFoundError();

    this.ctx.db.transaction(() => {
      for (const m of mappings) {
        const table = this.ctx.db.get<{ id: string }>('model_tables', { name: m.table });
        if (!table) throw new ValidationError('error.model_table_unknown', { table: m.table });
        this.ctx.db.update(
          'dataset_columns',
          { dataset_id: datasetId, name: m.column },
          { mapped_table: m.table, mapped_field: m.field, mapped_role: m.role },
        );
        // Data lineage tercatat OTOMATIS dari sumber hingga model (PRD 6.13).
        this.ctx.db.insert('data_lineage', {
          id: newId('lin'),
          from_type: 'dataset',
          from_id: datasetId,
          to_type: 'model_table',
          to_id: table.id,
          relation: 'feeds',
          created_at: nowIso(),
        });
      }
    });

    this.ctx.log({
      action: 'dataset.mapped',
      module: 'Data Modeling',
      objectType: 'dataset',
      objectId: datasetId,
      objectLabel: dataset.name,
      detail: { mappings },
    });
  }

  /** Menjalankan ulang pemeriksaan kualitas (PRD 6.14). */
  runQualityCheck(datasetId: string): QualityReport {
    this.ctx.require('dataquality:read', { module: 'Data Quality Center', objectId: datasetId });
    const dataset = this.ctx.db.get<DatasetSummary>('dataset_catalog', { id: datasetId });
    if (!dataset) throw new NotFoundError();

    const columnRows = this.ctx.db.all<{
      name: string;
      detected_type: string;
      confirmed_type: string | null;
      null_count: number;
      distinct_count: number;
    }>('dataset_columns', { dataset_id: datasetId }, { orderBy: 'position' });

    const columns: DetectedColumn[] = columnRows.map((c) => ({
      name: c.name,
      type: (c.confirmed_type ?? c.detected_type) as DetectedColumn['type'],
      nullCount: c.null_count,
      distinctCount: c.distinct_count,
      samples: [],
    }));

    const rows = this.ctx.db
      .all<{ data_json: string }>('dataset_rows', { dataset_id: datasetId }, { orderBy: 'row_index' })
      .map((r) => JSON.parse(r.data_json) as DatasetRow);

    const report = assessQuality(rows, columns);
    const at = nowIso();

    this.ctx.db.insert('dq_runs', {
      id: newId('dq'),
      dataset_id: datasetId,
      ran_at: at,
      score: report.score,
      rows_checked: report.rowsChecked,
      duplicate_rows: report.duplicateRows,
      missing_cells: report.missingCells,
      invalid_cells: report.invalidCells,
      findings_json: JSON.stringify(report.findings),
    });
    this.ctx.db.update('dataset_catalog', { id: datasetId }, { quality_score: report.score, updated_at: at });

    this.ctx.log({
      action: 'dataquality.run',
      module: 'Data Quality Center',
      objectType: 'dataset',
      objectId: datasetId,
      objectLabel: dataset.name,
      detail: { score: report.score, certifiable: report.certifiable },
    });

    return report;
  }

  /** Histori skor kualitas satu dataset (PRD 6.14 — "dapat dilihat historinya"). */
  qualityHistory(datasetId: string): Array<{ ran_at: string; score: number }> {
    this.ctx.require('dataquality:read', { module: 'Data Quality Center', objectId: datasetId });
    return this.ctx.db.all<{ ran_at: string; score: number }>(
      'dq_runs',
      { dataset_id: datasetId },
      { orderBy: 'ran_at DESC', limit: 50 },
    );
  }

  /**
   * Sertifikasi dataset — hanya Data Steward (PRD 6.14).
   * Dataset di bawah ambang skor TIDAK dapat disertifikasi.
   */
  certify(datasetId: string, decision: 'certified' | 'rejected', note?: string): DatasetSummary {
    this.ctx.require('dataquality:certify', { module: 'Data Quality Center', objectId: datasetId });
    this.ctx.requireWritable();

    const dataset = this.ctx.db.get<DatasetSummary>('dataset_catalog', { id: datasetId });
    if (!dataset) throw new NotFoundError();

    if (decision === 'certified') {
      if (dataset.quality_score === null) throw new ConflictError('error.dq_run_required');
      if (dataset.quality_score < CERTIFICATION_THRESHOLD) {
        throw new ConflictError('error.dq_below_threshold', {
          score: dataset.quality_score,
          threshold: CERTIFICATION_THRESHOLD,
        });
      }
    }

    const at = nowIso();
    this.ctx.db.update(
      'dataset_catalog',
      { id: datasetId },
      {
        certification: decision,
        certified_by: decision === 'certified' ? this.ctx.actor.userId : null,
        certified_at: decision === 'certified' ? at : null,
        updated_at: at,
      },
    );

    this.ctx.log({
      action: 'dataquality.certification',
      module: 'Data Quality Center',
      objectType: 'dataset',
      objectId: datasetId,
      objectLabel: dataset.name,
      severity: 'notice',
      detail: { decision, score: dataset.quality_score, note },
    });

    return this.ctx.db.get<DatasetSummary>('dataset_catalog', { id: datasetId })!;
  }

  /**
   * Ekspor dataset. SECURITY.md Bagian 3: dataset Restricted TIDAK BOLEH diekspor
   * tanpa persetujuan Data Steward.
   */
  exportCsv(datasetId: string): string {
    this.ctx.require('dataset:read', { module: 'Dataset', objectId: datasetId });
    const dataset = this.ctx.db.get<DatasetSummary>('dataset_catalog', { id: datasetId });
    if (!dataset) throw new NotFoundError();

    if (dataset.classification === 'restricted' && !this.ctx.can('export:approve_restricted')) {
      this.ctx.log({
        action: 'dataset.export',
        module: 'Dataset',
        objectType: 'dataset',
        objectId: datasetId,
        objectLabel: dataset.name,
        outcome: 'denied',
        severity: 'warning',
        detail: { reason: 'restricted_requires_steward_approval' },
      });
      throw new ConflictError('error.export_requires_steward_approval');
    }

    const columns = this.ctx.db.all<{ name: string }>(
      'dataset_columns',
      { dataset_id: datasetId },
      { orderBy: 'position' },
    );
    const { rows } = this.rows(datasetId, { limit: 1_000_000 });

    const escape = (v: unknown): string => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [columns.map((c) => escape(c.name)).join(',')];
    for (const row of rows) lines.push(columns.map((c) => escape(row[c.name])).join(','));

    // Ekspor laporan/data adalah aksi yang WAJIB tercatat (SECURITY.md Bagian 9).
    this.ctx.log({
      action: 'dataset.export',
      module: 'Dataset',
      objectType: 'dataset',
      objectId: datasetId,
      objectLabel: dataset.name,
      severity: 'notice',
      detail: { rows: rows.length, classification: dataset.classification },
    });

    return lines.join('\n');
  }
}
