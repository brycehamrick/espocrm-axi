import { AxiError } from "axi-sdk-js";
import { asString, displayValue } from "./coerce.js";
import { entityTypeArg } from "./entities.js";
import { snippet } from "./truncate.js";
/**
 * Shared record rendering: compact lists (3-6 columns, status breakdown,
 * honest totals) and readable single-record views.
 */
export function normalizeType(raw) {
    try {
        return entityTypeArg(raw);
    }
    catch (error) {
        throw new AxiError(error.message, "VALIDATION_ERROR", [
            "List available scopes: `espocrm-axi record types`",
        ]);
    }
}
export function validId(id) {
    const trimmed = id.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(trimmed)) {
        throw new AxiError(`record id must be alphanumeric (got: ${id})`, "VALIDATION_ERROR");
    }
    return trimmed;
}
export async function fetchRecords(ctx, type, params, extraWhere) {
    const where = [...(params.where ?? []), ...(extraWhere ?? [])];
    const result = await ctx.client.list(type, { ...params, where: where.length > 0 ? where : undefined });
    return { rows: result.list, total: result.total };
}
export function breakdown(rows, field) {
    const counts = new Map();
    for (const row of rows) {
        const value = displayValue(row[field]);
        if (value === undefined)
            continue;
        const key = String(value);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (counts.size === 0 || counts.size > 25)
        return undefined;
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([key, n]) => `${n} ${key}`)
        .join(", ");
}
/**
 * Project rows onto fixed columns. Every column is always present (null when
 * missing) so the TOON encoder emits one line per row instead of a list of
 * objects with varying keys.
 */
export function projectRows(rows, columns, full) {
    return rows.map((row) => {
        const out = {};
        for (const col of columns) {
            const value = displayValue(row[col]);
            out[col] = value === undefined ? null : typeof value === "string" && !full ? snippet(value, 80) : value;
        }
        if (row["id"] !== undefined)
            out["id"] = row["id"];
        return out;
    });
}
export function listOutput(type, outcome, columns, preset, limit, offset, full, opts, extraHelp = []) {
    const rows = outcome.rows;
    const out = { count: rows.length };
    if (outcome.total !== undefined && outcome.total >= 0)
        out["total"] = outcome.total;
    if (rows.length === 0) {
        out["result"] = `0 ${type} records matched`;
        out["help"] = [
            "Widen filters, drop --where, or check `espocrm-axi record fields <Type>` for valid attribute names",
            ...extraHelp,
        ];
        return out;
    }
    const summary = breakdown(rows, preset.statusField ?? "status");
    if (summary)
        out["summary"] = summary;
    out[plural(type)] = projectRows(rows, columns, full);
    const first = rows[0];
    const help = [];
    const firstId = first ? asString(first["id"]) : undefined;
    if (firstId)
        help.push(`Run \`espocrm-axi record get ${type} ${firstId}\` for full details`);
    if (outcome.total === -1 || (outcome.total !== undefined && outcome.total > offset + rows.length) || rows.length === limit) {
        help.push(`More may exist \u2014 page with --offset ${offset + rows.length} or raise --limit (max 200)`);
    }
    help.push(...(opts.help?.(rows, first) ?? []), ...extraHelp);
    out["help"] = help;
    return out;
}
export function lowerFirst(value) {
    return value.charAt(0).toLowerCase() + value.slice(1);
}
/** Simple plural for list keys: Lead -> leads, Opportunity -> opportunities. */
export function plural(type) {
    const lower = lowerFirst(type);
    if (lower.endsWith("y") && !/[aeiou]y$/.test(lower))
        return `${lower.slice(0, -1)}ies`;
    if (lower.endsWith("s") || lower.endsWith("x") || lower.endsWith("ch") || lower.endsWith("sh"))
        return `${lower}es`;
    return `${lower}s`;
}
export function firstIdOf(row) {
    return row ? asString(row["id"]) : undefined;
}
