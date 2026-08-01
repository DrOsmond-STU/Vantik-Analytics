"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DataModelingService = exports.MAX_FORMULA_LENGTH = void 0;
exports.tokenizeFormula = tokenizeFormula;
exports.formulaDependencies = formulaDependencies;
exports.evaluateFormula = evaluateFormula;
/**
 * Data Modeling — PRD 6.13.
 *
 * Star schema untuk semantic layer: satu sumber kebenaran definisi metrik lintas
 * dashboard, laporan, dan AI Copilot (ARCHITECTURE.md Bagian 11).
 */
const db_ts_1 = require("../platform/db.js");
const errors_ts_1 = require("../platform/errors.js");
const ALLOWED_FUNCTIONS = new Set(['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'ABS', 'ROUND']);
/** Batas panjang formula KPI. Formula nyata jauh di bawah ini. */
exports.MAX_FORMULA_LENGTH = 4_000;
/**
 * Tokeniser formula. Sengaja TIDAK memakai `eval`/`Function` — masukan pengguna
 * diperlakukan sebagai data, bukan instruksi (prinsip yang sama dengan mitigasi
 * prompt injection di SECURITY.md Bagian 11).
 */
function tokenizeFormula(formula) {
    // Formula yang tidak wajar panjangnya DITOLAK, bukan dipotong: memotong formula akan
    // mengubah artinya secara diam-diam, dan KPI yang dihitung dari formula terpotong
    // lebih buruk daripada KPI yang gagal dibuat dengan pesan jelas.
    if (formula.length > exports.MAX_FORMULA_LENGTH) {
        throw new errors_ts_1.ValidationError('error.formula_too_long', { max: exports.MAX_FORMULA_LENGTH });
    }
    const tokens = [];
    const pattern = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_.]*)\s*\(|([A-Za-z_][A-Za-z0-9_.]*)|([+\-*/])|([()]))/y;
    let index = 0;
    while (index < formula.length) {
        pattern.lastIndex = index;
        const match = pattern.exec(formula);
        if (!match) {
            if (formula.slice(index).trim() === '')
                break;
            throw new errors_ts_1.ValidationError('error.formula_invalid_token', { at: index });
        }
        index = pattern.lastIndex;
        if (match[1] !== undefined)
            tokens.push({ type: 'number', value: Number(match[1]) });
        else if (match[2] !== undefined) {
            const name = match[2].toUpperCase();
            if (!ALLOWED_FUNCTIONS.has(name))
                throw new errors_ts_1.ValidationError('error.formula_unknown_function', { name });
            tokens.push({ type: 'func', name });
            tokens.push({ type: 'paren', value: '(' });
        }
        else if (match[3] !== undefined)
            tokens.push({ type: 'field', name: match[3] });
        else if (match[4] !== undefined)
            tokens.push({ type: 'op', value: match[4] });
        else if (match[5] !== undefined)
            tokens.push({ type: 'paren', value: match[5] });
    }
    return tokens;
}
/** Nama field yang dirujuk sebuah formula — dipakai untuk mencatat lineage. */
function formulaDependencies(formula) {
    return [...new Set(tokenizeFormula(formula).filter((t) => t.type === 'field').map((t) => t.name))];
}
/**
 * Evaluator formula atas kumpulan baris. Fungsi agregat bekerja pada seluruh baris;
 * operator aritmetika bekerja pada hasil agregat.
 */
function evaluateFormula(formula, rows) {
    const tokens = tokenizeFormula(formula);
    let position = 0;
    const peek = () => tokens[position];
    const consume = () => tokens[position++];
    const aggregate = (fn, field) => {
        const values = rows
            .map((r) => r[field])
            .filter((v) => typeof v === 'number' && Number.isFinite(v));
        if (fn === 'COUNT')
            return rows.filter((r) => r[field] !== null && r[field] !== undefined).length;
        if (values.length === 0)
            return 0;
        switch (fn) {
            case 'SUM':
                return values.reduce((a, b) => a + b, 0);
            case 'AVG':
                return values.reduce((a, b) => a + b, 0) / values.length;
            case 'MIN':
                return Math.min(...values);
            case 'MAX':
                return Math.max(...values);
            default:
                throw new errors_ts_1.ValidationError('error.formula_unknown_function', { name: fn });
        }
    };
    function parseExpression() {
        let left = parseTerm();
        for (;;) {
            const token = peek();
            if (token?.type === 'op' && (token.value === '+' || token.value === '-')) {
                consume();
                const right = parseTerm();
                left = token.value === '+' ? left + right : left - right;
            }
            else
                return left;
        }
    }
    function parseTerm() {
        let left = parseFactor();
        for (;;) {
            const token = peek();
            if (token?.type === 'op' && (token.value === '*' || token.value === '/')) {
                consume();
                const right = parseFactor();
                // Pembagian nol menghasilkan 0, bukan Infinity — angka Infinity di dashboard
                // KPI lebih menyesatkan daripada nol yang jelas.
                left = token.value === '*' ? left * right : right === 0 ? 0 : left / right;
            }
            else
                return left;
        }
    }
    function parseFactor() {
        const token = consume();
        if (!token)
            throw new errors_ts_1.ValidationError('error.formula_unexpected_end');
        if (token.type === 'number')
            return token.value;
        if (token.type === 'field')
            return aggregate('SUM', token.name);
        if (token.type === 'op' && token.value === '-')
            return -parseFactor();
        if (token.type === 'func') {
            consume(); // '('
            const argument = peek();
            if (token.name === 'ABS' || token.name === 'ROUND') {
                const value = parseExpression();
                expectClose();
                return token.name === 'ABS' ? Math.abs(value) : Math.round(value);
            }
            if (argument?.type !== 'field')
                throw new errors_ts_1.ValidationError('error.formula_expects_field', { fn: token.name });
            consume();
            expectClose();
            return aggregate(token.name, argument.name);
        }
        if (token.type === 'paren' && token.value === '(') {
            const value = parseExpression();
            expectClose();
            return value;
        }
        throw new errors_ts_1.ValidationError('error.formula_invalid_token');
    }
    function expectClose() {
        const token = consume();
        if (token?.type !== 'paren' || token.value !== ')') {
            throw new errors_ts_1.ValidationError('error.formula_unbalanced_parens');
        }
    }
    const result = parseExpression();
    if (position !== tokens.length)
        throw new errors_ts_1.ValidationError('error.formula_trailing_tokens');
    return result;
}
/* ------------------------------------------------------------------ */
class DataModelingService {
    ctx;
    constructor(ctx) {
        this.ctx = ctx;
    }
    listTables() {
        this.ctx.require('datamodel:read', { module: 'Data Modeling' });
        this.ctx.requireModule('data_modeling');
        const tables = this.ctx.db.all('model_tables', undefined, { orderBy: 'name' });
        return tables.map((t) => ({
            ...t,
            fields: this.ctx.db.all('model_fields', { table_id: t.id }, { orderBy: 'name' }),
        }));
    }
    createTable(input) {
        this.ctx.require('datamodel:write', { module: 'Data Modeling' });
        this.ctx.requireWritable();
        if (this.ctx.db.get('model_tables', { name: input.name })) {
            throw new errors_ts_1.ConflictError('error.model_table_exists', { name: input.name });
        }
        // Grain didefinisikan EKSPLISIT per tabel fact (ARCHITECTURE.md Bagian 5).
        if (input.kind === 'fact' && !input.grain) {
            throw new errors_ts_1.ValidationError('error.fact_table_requires_grain');
        }
        const row = {
            id: (0, db_ts_1.newId)('mt'),
            name: input.name,
            kind: input.kind,
            grain: input.grain ?? null,
            scd_type: input.scdType ?? (input.kind === 'dimension' ? 2 : null),
            description: input.description ?? null,
            created_at: (0, db_ts_1.nowIso)(),
        };
        this.ctx.db.insert('model_tables', { ...row });
        this.ctx.log({
            action: 'datamodel.table_create',
            module: 'Data Modeling',
            objectType: 'model_table',
            objectId: row.id,
            objectLabel: row.name,
            detail: { kind: row.kind, grain: row.grain },
        });
        return row;
    }
    addField(input) {
        this.ctx.require('datamodel:write', { module: 'Data Modeling' });
        this.ctx.requireWritable();
        const table = this.ctx.db.get('model_tables', { name: input.tableName });
        if (!table)
            throw new errors_ts_1.NotFoundError('error.model_table_unknown');
        // Formula divalidasi saat disimpan, bukan saat pertama dipakai di dashboard.
        if (input.formula)
            tokenizeFormula(input.formula);
        const row = {
            id: (0, db_ts_1.newId)('mf'),
            table_id: table.id,
            name: input.name,
            data_type: input.dataType,
            role: input.role,
            formula: input.formula ?? null,
            description: input.description ?? null,
        };
        this.ctx.db.insert('model_fields', { ...row });
        if (input.formula) {
            for (const dependency of formulaDependencies(input.formula)) {
                this.ctx.db.insert('data_lineage', {
                    id: (0, db_ts_1.newId)('lin'),
                    from_type: 'model_field',
                    from_id: dependency,
                    to_type: 'model_field',
                    to_id: row.id,
                    relation: 'derives',
                    created_at: (0, db_ts_1.nowIso)(),
                });
            }
        }
        this.ctx.log({
            action: 'datamodel.field_add',
            module: 'Data Modeling',
            objectType: 'model_field',
            objectId: row.id,
            objectLabel: `${table.name}.${row.name}`,
            detail: { role: row.role, hasFormula: Boolean(input.formula) },
        });
        return row;
    }
    /** Lineage dari sumber (Dataset/Koneksi) hingga dashboard/laporan (PRD 6.13). */
    lineage(objectType, objectId, depth = 4) {
        this.ctx.require('datamodel:read', { module: 'Data Modeling' });
        const edges = [];
        const nodes = new Set([`${objectType}:${objectId}`]);
        let frontier = [{ type: objectType, id: objectId }];
        for (let level = 0; level < depth && frontier.length > 0; level++) {
            const next = [];
            for (const node of frontier) {
                const downstream = this.ctx.db.all('data_lineage', {
                    from_type: node.type,
                    from_id: node.id,
                });
                const upstream = this.ctx.db.all('data_lineage', {
                    to_type: node.type,
                    to_id: node.id,
                });
                for (const edge of [...downstream, ...upstream]) {
                    const key = `${edge.from_type}:${edge.from_id}→${edge.to_type}:${edge.to_id}`;
                    if (edges.some((e) => `${e.from_type}:${e.from_id}→${e.to_type}:${e.to_id}` === key))
                        continue;
                    edges.push(edge);
                    for (const side of [
                        { type: edge.from_type, id: edge.from_id },
                        { type: edge.to_type, id: edge.to_id },
                    ]) {
                        const tag = `${side.type}:${side.id}`;
                        if (!nodes.has(tag)) {
                            nodes.add(tag);
                            next.push(side);
                        }
                    }
                }
            }
            frontier = next;
        }
        return { nodes: [...nodes], edges };
    }
    /* ---------------- Business dictionary (PRD 6.13) ---------------- */
    listDictionary(search) {
        this.ctx.require('datamodel:read', { module: 'Data Modeling' });
        const rows = this.ctx.db.all('business_dictionary', undefined, { orderBy: 'term' });
        if (!search)
            return rows;
        const needle = search.toLowerCase();
        return rows.filter((r) => r.term.toLowerCase().includes(needle) || r.definition_id.toLowerCase().includes(needle));
    }
    upsertTerm(input) {
        this.ctx.require('dictionary:write', { module: 'Data Modeling' });
        this.ctx.requireWritable();
        const existing = this.ctx.db.get('business_dictionary', { term: input.term });
        const at = (0, db_ts_1.nowIso)();
        if (existing) {
            this.ctx.db.update('business_dictionary', { id: existing.id }, {
                definition_id: input.definitionId,
                definition_en: input.definitionEn ?? null,
                owner_employee_id: input.ownerEmployeeId ?? null,
                updated_at: at,
            });
        }
        else {
            this.ctx.db.insert('business_dictionary', {
                id: (0, db_ts_1.newId)('bd'),
                term: input.term,
                definition_id: input.definitionId,
                definition_en: input.definitionEn ?? null,
                owner_employee_id: input.ownerEmployeeId ?? null,
                related_field_id: null,
                updated_at: at,
            });
        }
        this.ctx.log({
            action: 'dictionary.upsert',
            module: 'Data Modeling',
            objectType: 'dictionary_term',
            objectLabel: input.term,
        });
    }
}
exports.DataModelingService = DataModelingService;
//# sourceMappingURL=modeling.js.map