"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KpiService = void 0;
exports.evaluateStatus = evaluateStatus;
exports.scoreAgainstTarget = scoreAgainstTarget;
/**
 * KPI Center — PRD 6.15.
 *
 * Satu pusat KPI dengan target dan ambang batas. Definisi KPI di sini adalah SATU-SATUNYA
 * sumber — Balanced Scorecard (PRD 6.25) menariknya dari sini, tidak mendefinisikan ulang.
 */
const db_ts_1 = require("../platform/db.js");
const errors_ts_1 = require("../platform/errors.js");
const modeling_ts_1 = require("./modeling.js");
/**
 * Menentukan status dari nilai terhadap ambang batas.
 *
 * Ambang dievaluasi dari yang paling ketat: critical dulu, lalu at_risk. Tanpa ambang
 * yang cocok → on_track.
 */
function evaluateStatus(value, thresholds) {
    const test = (t) => t.comparator === 'gte' ? value >= t.value : value <= t.value;
    const critical = thresholds.filter((t) => t.level === 'critical');
    if (critical.some(test))
        return 'critical';
    const atRisk = thresholds.filter((t) => t.level === 'at_risk');
    if (atRisk.some(test))
        return 'at_risk';
    return 'on_track';
}
/**
 * Skor 0–100 relatif terhadap target.
 * `lower_better` (mis. waktu tunggu, jumlah keluhan) dibalik agar 100 selalu berarti
 * "sebaik mungkin" — Threshold Ring memakai satu skala di seluruh modul (DESIGN.md 1).
 */
function scoreAgainstTarget(value, target, direction) {
    if (target === null || target === 0)
        return Math.max(0, Math.min(100, value));
    const ratio = direction === 'higher_better' ? value / target : target / value;
    return Number(Math.max(0, Math.min(100, ratio * 100)).toFixed(2));
}
class KpiService {
    ctx;
    constructor(ctx) {
        this.ctx = ctx;
    }
    list() {
        this.ctx.require('kpi:read', { module: 'KPI Center' });
        this.ctx.requireModule('kpi_center');
        const kpis = this.ctx.db.all('kpi_definition', undefined, { orderBy: 'name' });
        return kpis.map((kpi) => ({
            ...kpi,
            thresholds: this.ctx.db.all('kpi_threshold', { kpi_id: kpi.id }),
            latest: this.latestScore(kpi.id),
        }));
    }
    latestScore(kpiId) {
        const scoped = this.historyFor(kpiId, 1);
        return scoped[0] ?? null;
    }
    /**
     * Histori KPI, minimal 24 bulan ke belakang (PRD 6.15), dengan RLS diterapkan pada
     * kolom `dimension_key` di level query — bukan disaring setelah dikirim ke klien.
     */
    historyFor(kpiId, limit = 24) {
        const fragment = this.ctx.rls.sqlFragment('dimension_key');
        const rows = this.ctx.db.all('kpi_score_history', { kpi_id: kpiId }, { orderBy: 'period DESC', limit: 5000 });
        const filtered = fragment
            ? rows.filter((r) => {
                if (r.dimension_key === null) {
                    // Baris agregat lintas dimensi tidak boleh terlihat oleh pengguna yang
                    // dibatasi ke sebagian dimensi — fail secure (SECURITY.md Bagian 2).
                    return this.ctx.rls.isUnrestricted;
                }
                return this.ctx.rls.permits({ [this.ctx.rls.dimensions()[0] ?? 'dimension_key']: r.dimension_key });
            })
            : rows;
        return filtered.slice(0, limit);
    }
    create(input) {
        this.ctx.require('kpi:write', { module: 'KPI Center' });
        this.ctx.requireModule('kpi_center');
        this.ctx.requireWritable();
        if (this.ctx.db.get('kpi_definition', { code: input.code })) {
            throw new errors_ts_1.ConflictError('error.kpi_code_exists', { code: input.code });
        }
        const at = (0, db_ts_1.nowIso)();
        const kpi = {
            id: (0, db_ts_1.newId)('kpi'),
            code: input.code,
            name: input.name,
            description: null,
            formula: input.formula,
            unit: input.unit ?? null,
            direction: input.direction ?? 'higher_better',
            owner_employee_id: input.ownerEmployeeId ?? null,
            weight: input.weight ?? 1,
            target: input.target ?? null,
            dataset_id: input.datasetId ?? null,
            measure_field: input.measureField ?? null,
            dimension_field: input.dimensionField ?? null,
            // KPI baru mulai sebagai draft; perubahan definisi lewat approval workflow (PRD 6.15).
            state: 'draft',
            created_at: at,
            updated_at: at,
        };
        this.ctx.db.transaction(() => {
            this.ctx.db.insert('kpi_definition', { ...kpi, pending_change_json: null });
            for (const t of input.thresholds ?? []) {
                this.ctx.db.insert('kpi_threshold', {
                    id: (0, db_ts_1.newId)('kt'),
                    kpi_id: kpi.id,
                    level: t.level,
                    comparator: t.comparator,
                    value: t.value,
                });
            }
            if (input.datasetId) {
                this.ctx.db.insert('data_lineage', {
                    id: (0, db_ts_1.newId)('lin'),
                    from_type: 'dataset',
                    from_id: input.datasetId,
                    to_type: 'kpi',
                    to_id: kpi.id,
                    relation: 'feeds',
                    created_at: at,
                });
            }
        });
        this.ctx.log({
            action: 'kpi.create',
            module: 'KPI Center',
            objectType: 'kpi',
            objectId: kpi.id,
            objectLabel: kpi.name,
            detail: { code: kpi.code, target: kpi.target },
        });
        return kpi;
    }
    /**
     * Perubahan definisi KPI TIDAK langsung berlaku — masuk alur persetujuan (PRD 6.15).
     * Definisi lama tetap dipakai sampai perubahan disetujui, sehingga skor historis
     * tidak berubah diam-diam di bawah kaki pengguna.
     */
    proposeChange(kpiId, change) {
        this.ctx.require('kpi:write', { module: 'KPI Center', objectId: kpiId });
        this.ctx.requireWritable();
        const kpi = this.ctx.db.get('kpi_definition', { id: kpiId });
        if (!kpi)
            throw new errors_ts_1.NotFoundError();
        const approvalId = (0, db_ts_1.newId)('kap');
        const at = (0, db_ts_1.nowIso)();
        this.ctx.db.transaction(() => {
            this.ctx.db.update('kpi_definition', { id: kpiId }, { state: 'pending_approval', pending_change_json: JSON.stringify(change), updated_at: at });
            this.ctx.db.insert('kpi_approvals', {
                id: approvalId,
                kpi_id: kpiId,
                requested_by: this.ctx.actor.userId,
                requested_at: at,
                decided_by: null,
                decided_at: null,
                decision: null,
                note: null,
                change_json: JSON.stringify(change),
            });
        });
        this.ctx.log({
            action: 'kpi.change_proposed',
            module: 'KPI Center',
            objectType: 'kpi',
            objectId: kpiId,
            objectLabel: kpi.name,
            severity: 'notice',
            detail: { change },
        });
        return approvalId;
    }
    decideChange(approvalId, decision, note) {
        this.ctx.require('kpi:write', { module: 'KPI Center', objectId: approvalId });
        this.ctx.requireWritable();
        const approval = this.ctx.db.get('kpi_approvals', { id: approvalId });
        if (!approval)
            throw new errors_ts_1.NotFoundError();
        if (approval.decision)
            throw new errors_ts_1.ConflictError('error.approval_already_decided');
        // Pengaju tidak boleh menyetujui perubahannya sendiri — empat mata pada definisi
        // metrik yang dipakai seluruh organisasi.
        if (approval.requested_by === this.ctx.actor.userId) {
            throw new errors_ts_1.ConflictError('error.cannot_approve_own_change');
        }
        const at = (0, db_ts_1.nowIso)();
        const change = JSON.parse(approval.change_json);
        this.ctx.db.transaction(() => {
            this.ctx.db.update('kpi_approvals', { id: approvalId }, { decision, decided_at: at, decided_by: this.ctx.actor.userId, note: note ?? null });
            if (decision === 'approved') {
                this.ctx.db.update('kpi_definition', { id: approval.kpi_id }, { ...change, state: 'approved', pending_change_json: null, updated_at: at });
            }
            else {
                this.ctx.db.update('kpi_definition', { id: approval.kpi_id }, { state: 'approved', pending_change_json: null, updated_at: at });
            }
        });
        this.ctx.log({
            action: 'kpi.change_decided',
            module: 'KPI Center',
            objectType: 'kpi',
            objectId: approval.kpi_id,
            severity: 'notice',
            detail: { decision, change, note },
        });
    }
    setThresholds(kpiId, thresholds) {
        this.ctx.require('kpi:write', { module: 'KPI Center', objectId: kpiId });
        this.ctx.requireWritable();
        if (!this.ctx.db.get('kpi_definition', { id: kpiId }))
            throw new errors_ts_1.NotFoundError();
        this.ctx.db.transaction(() => {
            this.ctx.db.delete('kpi_threshold', { kpi_id: kpiId });
            for (const t of thresholds) {
                this.ctx.db.insert('kpi_threshold', {
                    id: (0, db_ts_1.newId)('kt'),
                    kpi_id: kpiId,
                    level: t.level,
                    comparator: t.comparator,
                    value: t.value,
                });
            }
        });
        this.ctx.log({
            action: 'kpi.thresholds_changed',
            module: 'KPI Center',
            objectType: 'kpi',
            objectId: kpiId,
            detail: { thresholds },
        });
    }
    /**
     * Snapshot skor untuk satu periode. Di-snapshot berkala dan TIDAK dihitung ulang
     * mundur, agar tren historis stabil (ARCHITECTURE.md Bagian 5).
     */
    captureScores(kpiId, period, rows) {
        this.ctx.require('kpi:write', { module: 'KPI Center', objectId: kpiId });
        const kpi = this.ctx.db.get('kpi_definition', { id: kpiId });
        if (!kpi)
            throw new errors_ts_1.NotFoundError();
        if (!/^\d{4}-\d{2}$/.test(period))
            throw new errors_ts_1.ValidationError('error.invalid_period');
        const thresholds = this.ctx.db.all('kpi_threshold', { kpi_id: kpiId });
        const groups = new Map();
        if (kpi.dimension_field) {
            for (const row of rows) {
                const key = row[kpi.dimension_field] === null || row[kpi.dimension_field] === undefined
                    ? null
                    : String(row[kpi.dimension_field]);
                if (!groups.has(key))
                    groups.set(key, []);
                groups.get(key).push(row);
            }
        }
        groups.set(null, rows); // agregat lintas dimensi
        const captured = [];
        const at = (0, db_ts_1.nowIso)();
        this.ctx.db.transaction(() => {
            for (const [dimensionKey, groupRows] of groups) {
                const value = (0, modeling_ts_1.evaluateFormula)(kpi.formula, groupRows);
                const score = scoreAgainstTarget(value, kpi.target, kpi.direction);
                const status = evaluateStatus(value, thresholds);
                this.ctx.db.rawRun(`INSERT INTO kpi_score_history
             (id, tenant_id, kpi_id, period, value, score, status, dimension_key, captured_at)
           VALUES (:id, :tenant_id, :kpi_id, :period, :value, :score, :status, :dimension_key, :captured_at)
           ON CONFLICT(tenant_id, kpi_id, period, IFNULL(dimension_key,'*')) DO UPDATE SET
             value = excluded.value, score = excluded.score,
             status = excluded.status, captured_at = excluded.captured_at`, {
                    id: (0, db_ts_1.newId)('ks'),
                    kpi_id: kpiId,
                    period,
                    value,
                    score,
                    status,
                    dimension_key: dimensionKey,
                    captured_at: at,
                });
                captured.push({ period, value, score, status, dimension_key: dimensionKey });
            }
        });
        this.ctx.log({
            action: 'kpi.scores_captured',
            module: 'KPI Center',
            objectType: 'kpi',
            objectId: kpiId,
            objectLabel: kpi.name,
            detail: { period, groups: captured.length },
        });
        return captured;
    }
    /** KPI yang menyimpang dari ambang — dipakai Alert Center (ARCHITECTURE.md 4.4). */
    breaching(period) {
        const out = [];
        for (const kpi of this.ctx.db.all('kpi_definition')) {
            const rows = this.ctx.db.all('kpi_score_history', {
                kpi_id: kpi.id,
                period,
                dimension_key: null,
            });
            for (const score of rows) {
                if (score.status !== 'on_track')
                    out.push({ kpi, score });
            }
        }
        return out;
    }
}
exports.KpiService = KpiService;
//# sourceMappingURL=kpi.js.map