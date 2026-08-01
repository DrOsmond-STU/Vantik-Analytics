"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmbedRenderer = exports.EmbedService = exports.EMBED_RATE_LIMIT_PER_MINUTE = exports.ReportService = exports.DashboardService = exports.DASHBOARD_TEMPLATES = void 0;
/**
 * designer-service — Dashboard Designer (6.3), Report Designer (6.4),
 * Interactive Visualization (6.5), Embed Dashboard (6.21).
 *
 * Embed Dashboard adalah sub-modul dengan endpoint publik TERISOLASI (ARCHITECTURE.md
 * 3 & 4.5): kompromi terhadap endpoint sematan tidak boleh memberi jalan ke
 * designer-service internal atau layanan lain.
 */
const db_ts_1 = require("../platform/db.js");
const crypto_ts_1 = require("../platform/crypto.js");
const errors_ts_1 = require("../platform/errors.js");
const rls_ts_1 = require("../platform/rls.js");
const visualizations_ts_1 = require("./visualizations.js");
__exportStar(require("./visualizations.js"), exports);
/**
 * Template dashboard siap pakai LINTAS BIDANG (PRD 6.3 mensyaratkan minimal 10).
 * DESIGN.md Bagian 1: contoh wajib mewakili beragam sektor, bukan didominasi satu industri.
 */
exports.DASHBOARD_TEMPLATES = [
    { code: 'sales_performance', nameId: 'Kinerja Penjualan', nameEn: 'Sales Performance', sector: 'sales' },
    { code: 'finance_budget', nameId: 'Realisasi vs Anggaran', nameEn: 'Budget vs Actual', sector: 'finance' },
    { code: 'hr_workforce', nameId: 'Ketenagakerjaan', nameEn: 'Workforce', sector: 'hr' },
    { code: 'customer_service', nameId: 'Layanan Pelanggan', nameEn: 'Customer Service', sector: 'service' },
    { code: 'research_survey', nameId: 'Riset & Survei', nameEn: 'Research & Survey', sector: 'research' },
    { code: 'public_service', nameId: 'Layanan Publik', nameEn: 'Public Service', sector: 'government' },
    { code: 'education_outcomes', nameId: 'Capaian Pendidikan', nameEn: 'Education Outcomes', sector: 'education' },
    { code: 'health_services', nameId: 'Layanan Kesehatan', nameEn: 'Health Services', sector: 'health' },
    { code: 'logistics_supply', nameId: 'Logistik & Rantai Pasok', nameEn: 'Logistics & Supply Chain', sector: 'logistics' },
    { code: 'operations_quality', nameId: 'Operasional & Mutu', nameEn: 'Operations & Quality', sector: 'operations' },
    { code: 'esg_sustainability', nameId: 'ESG & Keberlanjutan', nameEn: 'ESG & Sustainability', sector: 'esg' },
    { code: 'blank', nameId: 'Kosong', nameEn: 'Blank', sector: 'any' },
];
class DashboardService {
    ctx;
    metering;
    constructor(ctx, metering) {
        this.ctx = ctx;
        this.metering = metering;
    }
    templates() {
        return exports.DASHBOARD_TEMPLATES;
    }
    visualizationCatalog() {
        this.ctx.require('visualization:read', { module: 'Interactive Visualization' });
        this.ctx.requireModule('interactive_visualization');
        return visualizations_ts_1.VISUALIZATION_CATALOG;
    }
    list() {
        this.ctx.require('dashboard:read', { module: 'Dashboard Designer' });
        this.ctx.requireModule('dashboard_designer');
        return this.ctx.db
            .all('dashboards', undefined, { orderBy: 'updated_at DESC' })
            .map((d) => ({
            ...d,
            widgets: JSON.parse(d.draft_layout_json).length,
            published: d.published_at !== null,
        }));
    }
    get(dashboardId) {
        this.ctx.require('dashboard:read', { module: 'Dashboard Designer', objectId: dashboardId });
        const row = this.ctx.db.get('dashboards', { id: dashboardId });
        if (!row)
            throw new errors_ts_1.NotFoundError();
        return {
            ...row,
            draft: JSON.parse(row.draft_layout_json),
            published: row.published_layout_json ? JSON.parse(row.published_layout_json) : null,
        };
    }
    create(input) {
        this.ctx.require('dashboard:write', { module: 'Dashboard Designer' });
        this.ctx.requireModule('dashboard_designer');
        this.ctx.requireWritable();
        const at = (0, db_ts_1.nowIso)();
        const row = {
            id: (0, db_ts_1.newId)('dsh'),
            name: input.name,
            description: input.description ?? null,
            owner_user_id: this.ctx.actor.userId,
            classification: input.classification ?? 'internal',
            theme: 'system',
            accent_override: null,
            template_code: input.templateCode ?? 'blank',
            draft_layout_json: '[]',
            published_layout_json: null,
            published_at: null,
            version: 1,
            created_at: at,
            updated_at: at,
        };
        this.ctx.db.insert('dashboards', { ...row, published_by: null });
        this.ctx.log({
            action: 'dashboard.create',
            module: 'Dashboard Designer',
            objectType: 'dashboard',
            objectId: row.id,
            objectLabel: row.name,
            detail: { template: row.template_code },
        });
        return row;
    }
    /** Perubahan tersimpan sebagai DRAFT sebelum dipublikasikan (PRD 6.3 — versioning dasar). */
    saveDraft(dashboardId, widgets) {
        this.ctx.require('dashboard:write', { module: 'Dashboard Designer', objectId: dashboardId });
        this.ctx.requireWritable();
        if (!this.ctx.db.get('dashboards', { id: dashboardId }))
            throw new errors_ts_1.NotFoundError();
        for (const widget of widgets) {
            if (!visualizations_ts_1.VISUALIZATION_CATALOG.some((v) => v.code === widget.type) && widget.type !== 'text') {
                throw new errors_ts_1.ValidationError('error.unknown_visual_type', { type: widget.type });
            }
        }
        this.ctx.db.update('dashboards', { id: dashboardId }, { draft_layout_json: JSON.stringify(widgets), updated_at: (0, db_ts_1.nowIso)() });
    }
    publish(dashboardId) {
        this.ctx.require('dashboard:publish', { module: 'Dashboard Designer', objectId: dashboardId });
        this.ctx.requireWritable();
        const dashboard = this.ctx.db.get('dashboards', { id: dashboardId });
        if (!dashboard)
            throw new errors_ts_1.NotFoundError();
        const at = (0, db_ts_1.nowIso)();
        const version = dashboard.version + 1;
        this.ctx.db.transaction(() => {
            this.ctx.db.insert('dashboard_versions', {
                id: (0, db_ts_1.newId)('dvr'),
                dashboard_id: dashboardId,
                version,
                layout_json: dashboard.draft_layout_json,
                published_at: at,
                published_by: this.ctx.actor.userId,
            });
            this.ctx.db.update('dashboards', { id: dashboardId }, {
                published_layout_json: dashboard.draft_layout_json,
                published_at: at,
                published_by: this.ctx.actor.userId,
                version,
                updated_at: at,
            });
        });
        this.ctx.log({
            action: 'dashboard.publish',
            module: 'Dashboard Designer',
            objectType: 'dashboard',
            objectId: dashboardId,
            objectLabel: dashboard.name,
            severity: 'notice',
            detail: { version },
        });
        return { version };
    }
    versions(dashboardId) {
        this.ctx.require('dashboard:read', { module: 'Dashboard Designer', objectId: dashboardId });
        return this.ctx.db.all('dashboard_versions', { dashboard_id: dashboardId }, { orderBy: 'version DESC' });
    }
}
exports.DashboardService = DashboardService;
class ReportService {
    ctx;
    constructor(ctx) {
        this.ctx = ctx;
    }
    list() {
        this.ctx.require('report:read', { module: 'Report Designer' });
        this.ctx.requireModule('report_designer');
        return this.ctx.db.all('reports', undefined, { orderBy: 'updated_at DESC' });
    }
    create(input) {
        this.ctx.require('report:write', { module: 'Report Designer' });
        this.ctx.requireModule('report_designer');
        this.ctx.requireWritable();
        const at = (0, db_ts_1.nowIso)();
        const id = (0, db_ts_1.newId)('rpt');
        this.ctx.db.insert('reports', {
            id,
            name: input.name,
            classification: input.classification ?? 'internal',
            page_size: input.pageSize ?? 'A4',
            orientation: input.orientation ?? 'portrait',
            header_json: null,
            footer_json: null,
            watermark: input.watermark ?? 'none',
            signature_json: null,
            blocks_json: '[]',
            schedule_cron: null,
            schedule_recipients_json: null,
            owner_user_id: this.ctx.actor.userId,
            created_at: at,
            updated_at: at,
        });
        this.ctx.log({
            action: 'report.create',
            module: 'Report Designer',
            objectType: 'report',
            objectId: id,
            objectLabel: input.name,
        });
        return { id };
    }
    saveBlocks(reportId, blocks) {
        this.ctx.require('report:write', { module: 'Report Designer', objectId: reportId });
        this.ctx.requireWritable();
        if (!this.ctx.db.get('reports', { id: reportId }))
            throw new errors_ts_1.NotFoundError();
        this.ctx.db.update('reports', { id: reportId }, { blocks_json: JSON.stringify(blocks), updated_at: (0, db_ts_1.nowIso)() });
    }
    /** Tanda tangan digital pada laporan resmi (PRD 6.4, SECURITY.md 18). */
    setSignature(reportId, signature) {
        this.ctx.require('report:write', { module: 'Report Designer', objectId: reportId });
        this.ctx.requireWritable();
        this.ctx.db.update('reports', { id: reportId }, { signature_json: JSON.stringify({ ...signature, signedAt: (0, db_ts_1.nowIso)() }), updated_at: (0, db_ts_1.nowIso)() });
        this.ctx.log({
            action: 'report.signature_set',
            module: 'Report Designer',
            objectType: 'report',
            objectId: reportId,
            severity: 'notice',
            detail: signature,
        });
    }
    /** Penjadwalan pengiriman laporan otomatis ke email penerima (PRD 6.4). */
    schedule(reportId, cron, recipients) {
        this.ctx.require('report:write', { module: 'Report Designer', objectId: reportId });
        this.ctx.requireWritable();
        if (!/^[\d*,\-/ ]+$/.test(cron))
            throw new errors_ts_1.ValidationError('error.invalid_cron');
        this.ctx.db.update('reports', { id: reportId }, { schedule_cron: cron, schedule_recipients_json: JSON.stringify(recipients), updated_at: (0, db_ts_1.nowIso)() });
        this.ctx.log({
            action: 'report.scheduled',
            module: 'Report Designer',
            objectType: 'report',
            objectId: reportId,
            detail: { cron, recipients: recipients.length },
        });
    }
    /**
     * Menyiapkan dokumen untuk ekspor. Hasil layar dan hasil cetak dibangun dari
     * struktur yang SAMA agar identik (PRD 6.4).
     */
    renderDocument(reportId) {
        this.ctx.require('report:export', { module: 'Report Designer', objectId: reportId });
        const report = this.ctx.db.get('reports', { id: reportId });
        if (!report)
            throw new errors_ts_1.NotFoundError();
        if (report.classification === 'restricted' && !this.ctx.can('export:approve_restricted')) {
            this.ctx.log({
                action: 'report.export',
                module: 'Report Designer',
                objectType: 'report',
                objectId: reportId,
                outcome: 'denied',
                severity: 'warning',
                detail: { reason: 'restricted_requires_steward_approval' },
            });
            throw new errors_ts_1.ConflictError('error.export_requires_steward_approval');
        }
        // Ekspor laporan WAJIB tercatat (SECURITY.md Bagian 9).
        this.ctx.log({
            action: 'report.export',
            module: 'Report Designer',
            objectType: 'report',
            objectId: reportId,
            objectLabel: report.name,
            severity: 'notice',
            detail: { classification: report.classification },
        });
        return {
            report,
            blocks: JSON.parse(report.blocks_json),
            signature: report.signature_json ? JSON.parse(report.signature_json) : null,
            // BRAND.md Bagian 8: logo Vantik kecil di FOOTER, bukan header — laporan adalah
            // milik dan identitas organisasi klien.
            attribution: { show: !this.ctx.tenant.whiteLabel, text: 'Dibuat dengan Vantik Analytics' },
        };
    }
}
exports.ReportService = ReportService;
/** Batas laju per token untuk mencegah scraping massal (SECURITY.md 15). */
exports.EMBED_RATE_LIMIT_PER_MINUTE = 60;
class EmbedService {
    ctx;
    metering;
    constructor(ctx, metering) {
        this.ctx = ctx;
        this.metering = metering;
    }
    list(dashboardId) {
        this.ctx.require('embed:read', { module: 'Embed Dashboard', objectId: dashboardId });
        this.ctx.requireModule('embed_dashboard');
        return this.ctx.db
            .all('embed_tokens', { dashboard_id: dashboardId }, { orderBy: 'created_at DESC' })
            .map((t) => ({
            id: t.id,
            label: t.label,
            mode: t.mode,
            expires_at: t.expires_at,
            revoked_at: t.revoked_at,
            domains: JSON.parse(t.domain_whitelist_json),
            views: this.viewCount(t.id),
        }));
    }
    viewCount(tokenId) {
        const row = this.ctx.db.unsafeHandle('audit-writer')
            .prepare("SELECT COUNT(*) AS n FROM embed_requests WHERE token_id = ? AND outcome = 'allowed'")
            .get(tokenId);
        return row.n;
    }
    /** Statistik penggunaan untuk panel ringkas di Dashboard Designer (PRD 6.21). */
    usageStats(dashboardId) {
        this.ctx.require('embed:read', { module: 'Embed Dashboard', objectId: dashboardId });
        const tokens = this.ctx.db.all('embed_tokens', { dashboard_id: dashboardId });
        if (tokens.length === 0)
            return { totalViews: 0, byDomain: [], denials: 0 };
        const handle = this.ctx.db.unsafeHandle('audit-writer');
        const placeholders = tokens.map(() => '?').join(',');
        const ids = tokens.map((t) => t.id);
        const totalViews = handle
            .prepare(`SELECT COUNT(*) AS n FROM embed_requests WHERE token_id IN (${placeholders}) AND outcome = 'allowed'`)
            .get(...ids).n;
        const denials = handle
            .prepare(`SELECT COUNT(*) AS n FROM embed_requests WHERE token_id IN (${placeholders}) AND outcome <> 'allowed'`)
            .get(...ids).n;
        const byDomain = handle
            .prepare(`SELECT origin, COUNT(*) AS n FROM embed_requests
          WHERE token_id IN (${placeholders}) AND outcome = 'allowed'
          GROUP BY origin ORDER BY n DESC LIMIT 20`)
            .all(...ids);
        return { totalViews, byDomain, denials };
    }
    /**
     * Menerbitkan token sematan.
     *
     * Token adalah kredensial BERTINGKAT RENDAH tersendiri, sama sekali terpisah dari
     * sesi login pengguna (PRD 6.21, SECURITY.md 15) — nilai penuh hanya dikembalikan
     * sekali di sini; basis data menyimpan hash-nya.
     */
    issue(input) {
        this.ctx.require('embed:write', { module: 'Embed Dashboard', objectId: input.dashboardId });
        this.ctx.requireModule('embed_dashboard');
        this.ctx.requireWritable();
        const dashboard = this.ctx.db.get('dashboards', { id: input.dashboardId });
        if (!dashboard)
            throw new errors_ts_1.NotFoundError();
        // Kontrol di level KLASIFIKASI DATA, tidak dapat di-override pemilik dashboard
        // (SECURITY.md 15).
        if (dashboard.classification === 'restricted') {
            this.ctx.log({
                action: 'embed.issue',
                module: 'Embed Dashboard',
                objectType: 'dashboard',
                objectId: input.dashboardId,
                outcome: 'denied',
                severity: 'critical',
                detail: { reason: 'restricted_dashboards_cannot_be_embedded' },
            });
            throw new errors_ts_1.ForbiddenError('error.restricted_cannot_embed');
        }
        // Hanya dashboard yang sudah dipublikasikan (permukaan API paling minimal).
        if (!dashboard.published_at)
            throw new errors_ts_1.ConflictError('error.dashboard_not_published');
        if (input.domainWhitelist.length === 0)
            throw new errors_ts_1.ValidationError('error.domain_whitelist_required');
        for (const domain of input.domainWhitelist) {
            if (!/^https?:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(domain)) {
                throw new errors_ts_1.ValidationError('error.invalid_domain', { domain });
            }
        }
        this.metering?.assertWithinQuota('embed_tokens', 1);
        const token = (0, crypto_ts_1.generateToken)(32);
        const tokenId = (0, db_ts_1.newId)('emb');
        const at = (0, db_ts_1.nowIso)();
        const expiresAt = new Date(Date.now() + (input.expiresInDays ?? 30) * 86_400_000).toISOString();
        this.ctx.db.insert('embed_tokens', {
            id: tokenId,
            dashboard_id: input.dashboardId,
            token_hash: (0, crypto_ts_1.hashToken)(token),
            label: input.label ?? null,
            rls_scope_json: JSON.stringify(input.rlsScope ?? this.ctx.rls.toJSON()),
            domain_whitelist_json: JSON.stringify(input.domainWhitelist),
            mode: input.mode ?? 'interactive',
            show_attribution: input.showAttribution === false ? 0 : 1,
            expires_at: expiresAt,
            revoked_at: null,
            created_by: this.ctx.actor.userId,
            created_at: at,
        });
        this.metering?.record('embed_tokens', 1, 'embed.issue');
        this.ctx.log({
            action: 'embed.issue',
            module: 'Embed Dashboard',
            objectType: 'embed_token',
            objectId: tokenId,
            objectLabel: dashboard.name,
            severity: 'notice',
            detail: {
                dashboardId: input.dashboardId,
                domains: input.domainWhitelist,
                mode: input.mode ?? 'interactive',
                expiresAt,
                rlsDimensions: (input.rlsScope ?? this.ctx.rls.toJSON()).map((r) => r.dimension),
            },
        });
        const base = `/embed/v1/dashboard?token=${token}`;
        return {
            tokenId,
            token,
            iframeSnippet: `<iframe src="${base}" width="100%" height="640" frameborder="0" title="${dashboard.name}"></iframe>`,
            sdkSnippet: `<div id="vantik-embed"></div>\n` +
                `<script src="/embed/v1/sdk.js"></script>\n` +
                `<script>Vantik.render('#vantik-embed', { token: '${token}' });</script>`,
        };
    }
    /** Pencabutan berlaku pada permintaan BERIKUTNYA, bukan menunggu cache (SECURITY.md 15). */
    revoke(tokenId) {
        this.ctx.require('embed:write', { module: 'Embed Dashboard', objectId: tokenId });
        this.ctx.requireWritable();
        const changed = this.ctx.db.update('embed_tokens', { id: tokenId }, { revoked_at: (0, db_ts_1.nowIso)() });
        if (changed === 0)
            throw new errors_ts_1.NotFoundError();
        this.ctx.log({
            action: 'embed.revoke',
            module: 'Embed Dashboard',
            objectType: 'embed_token',
            objectId: tokenId,
            severity: 'critical',
        });
    }
}
exports.EmbedService = EmbedService;
/**
 * Penyaji sematan — berjalan pada jalur publik terpisah (`EDGE` di ARCHITECTURE.md 4.5).
 *
 * Sengaja TIDAK memakai `RequestContext`: tidak ada sesi pengguna, tidak ada RBAC
 * pengguna, dan permukaan API-nya hanya baca untuk satu dashboard.
 */
class EmbedRenderer {
    db;
    audit;
    constructor(db, audit) {
        this.db = db;
        this.audit = audit;
    }
    render(request) {
        const tokenRow = this.db
            .prepare('SELECT * FROM embed_tokens WHERE token_hash = ?')
            .get((0, crypto_ts_1.hashToken)(request.token));
        if (!tokenRow) {
            this.recordRequest(null, null, request, 'denied_revoked');
            return { ok: false, status: 403, reasonKey: 'error.embed_token_invalid' };
        }
        // `revoked_at` diperiksa SETIAP permintaan (ARCHITECTURE.md Bagian 5).
        if (tokenRow.revoked_at) {
            this.recordRequest(tokenRow.tenant_id, tokenRow.id, request, 'denied_revoked');
            return { ok: false, status: 403, reasonKey: 'error.embed_token_revoked' };
        }
        if (Date.parse(tokenRow.expires_at) <= Date.now()) {
            this.recordRequest(tokenRow.tenant_id, tokenRow.id, request, 'denied_expired');
            return { ok: false, status: 403, reasonKey: 'error.embed_token_expired' };
        }
        // Domain whitelist ditegakkan DI SERVER, bukan validasi JavaScript sisi klien.
        const whitelist = JSON.parse(tokenRow.domain_whitelist_json);
        const origin = request.origin?.replace(/\/$/, '').toLowerCase() ?? null;
        if (!origin || !whitelist.some((d) => d.replace(/\/$/, '').toLowerCase() === origin)) {
            this.recordRequest(tokenRow.tenant_id, tokenRow.id, request, 'denied_domain');
            return { ok: false, status: 403, reasonKey: 'error.embed_domain_not_allowed' };
        }
        // Rate limiting per token.
        const since = new Date(Date.now() - 60_000).toISOString();
        const recent = this.db
            .prepare('SELECT COUNT(*) AS n FROM embed_requests WHERE token_id = ? AND requested_at >= ?')
            .get(tokenRow.id, since).n;
        if (recent >= exports.EMBED_RATE_LIMIT_PER_MINUTE) {
            this.recordRequest(tokenRow.tenant_id, tokenRow.id, request, 'rate_limited');
            throw new errors_ts_1.RateLimitedError('error.rate_limited', { tokenId: tokenRow.id });
        }
        const dashboard = this.db
            .prepare('SELECT id, name, published_layout_json FROM dashboards WHERE id = ? AND tenant_id = ?')
            .get(tokenRow.dashboard_id, tokenRow.tenant_id);
        if (!dashboard?.published_layout_json) {
            this.recordRequest(tokenRow.tenant_id, tokenRow.id, request, 'denied_revoked');
            return { ok: false, status: 404, reasonKey: 'error.not_found' };
        }
        this.recordRequest(tokenRow.tenant_id, tokenRow.id, request, 'allowed');
        // Cakupan RLS dievaluasi ULANG di server dari token, bukan dari parameter klien.
        const scope = (0, rls_ts_1.scopeFromEmbedToken)(tokenRow.rls_scope_json);
        return {
            ok: true,
            dashboard: { id: dashboard.id, name: dashboard.name, layout: JSON.parse(dashboard.published_layout_json) },
            mode: tokenRow.mode,
            showAttribution: tokenRow.show_attribution === 1,
            frameAncestors: `frame-ancestors ${whitelist.join(' ')}`,
            rlsScope: scope.toJSON(),
            // Ekspor/duplikasi TIDAK diizinkan pada mode sematan (PRD 6.21).
            canExport: false,
        };
    }
    /** Setiap permintaan tercatat — termasuk yang DITOLAK (PRD 6.21, SECURITY.md 15). */
    recordRequest(tenantId, tokenId, request, outcome) {
        this.db
            .prepare('INSERT INTO embed_requests (tenant_id, token_id, requested_at, origin, outcome, ip) VALUES (?,?,?,?,?,?)')
            .run(tenantId, tokenId, (0, db_ts_1.nowIso)(), request.origin, outcome, request.ip);
        this.audit.record({
            tenantId,
            actorLabel: `embed:${request.origin ?? 'unknown-origin'}`,
            actorIp: request.ip,
            action: 'embed.request',
            module: 'Embed Dashboard',
            objectType: 'embed_token',
            objectId: tokenId,
            outcome: outcome === 'allowed' ? 'success' : 'denied',
            // Pola penolakan berulang dari domain yang sama = potensi insiden (SECURITY.md 14).
            severity: outcome === 'allowed' ? 'info' : 'warning',
            detail: { origin: request.origin, outcome },
        });
    }
}
exports.EmbedRenderer = EmbedRenderer;
//# sourceMappingURL=index.js.map