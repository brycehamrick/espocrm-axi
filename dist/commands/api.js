import { readFileSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import { renderResult } from "../lib/output.js";
import { isRecord, redactSecrets } from "../lib/coerce.js";
import { forbidExtraPositionals, parseFlags, requireConfirm, requirePositional, requireString } from "../lib/args.js";
import { requireAuth } from "../lib/auth.js";
import { LIST_FLAGS, parseListFlags } from "../lib/params.js";
/**
 * Raw REST escape hatch for anything without a first-class command. Reads are
 * free; every other method needs --confirm. Paths are relative to api/v1.
 */
export const API_HELP = `espocrm-axi api - raw EspoCRM REST escape hatch (paths relative to /api/v1)

usage:
  api get <path> [--query k=v ...] [--where ...] [--select a,b] [--limit n] [--offset n] [--order-by a] [--order asc|desc] [--text q] [--full] [--json]
  api post|put|patch|delete <path> [--body <json|@file>] [--confirm] [--full] [--json]

<path> examples: Lead, Lead/<id>, Lead/<id>/emails, Email/inbox/notReadCounts, Metadata?key=scopes (use --query key=scopes),
  App/user, Settings, CurrencyRate, OpenApi, Jobs, Notification/group, Pipeline/<id>/move/up, Team/<id>/userPosition

Writes require --confirm. --query takes k=v pairs (repeatable). --where uses the same DSL as record list.
Docs: https://docs.espocrm.com/development/api/ - routes: application/Espo/Resources/routes.json in espocrm/espocrm.

examples:
  espocrm-axi api get Metadata --query key=scopes
  espocrm-axi api get Lead/<id>/followers
  espocrm-axi api put Preferences/<userId> --body '{"timezone":"UTC"}' --confirm
  espocrm-axi api post Team/<id>/userPosition --body '{"userId":"<id>","position":10}' --confirm`;
const GET_FLAGS = { ...LIST_FLAGS, query: { type: "string", multiple: true } };
const WRITE_FLAGS = { body: { type: "string" }, confirm: { type: "boolean" }, full: { type: "boolean" }, json: { type: "boolean" } };
const METHODS = ["get", "post", "put", "patch", "delete"];
function validPath(path) {
    const clean = path.startsWith("/") ? path.slice(1) : path;
    if (!/^[A-Za-z0-9/_\-.:~%]+$/.test(clean) || clean.includes("..") || clean.includes("?")) {
        throw new AxiError(`path must be relative to api/v1 (letters, digits, /, -, _, ., ~, %), got: ${path}`, "VALIDATION_ERROR", [
            "Pass query parameters with --query k=v instead of in the path",
        ]);
    }
    return clean;
}
export async function apiCommand(args, ctx) {
    const method = args[0]?.toLowerCase();
    if (!method || !METHODS.includes(method) || args[0] === "--help")
        return API_HELP;
    const rest = args.slice(1);
    const commandPath = `espocrm-axi api ${method}`;
    const write = method !== "get";
    if (!write) {
        const { values, positionals } = parseFlags(rest, commandPath, GET_FLAGS);
        const path = validPath(requirePositional(positionals, 0, "path", commandPath));
        forbidExtraPositionals(positionals, 1, commandPath);
        requireAuth(ctx, commandPath);
        const parsed = parseListFlags(values, { dateField: "createdAt", orderBy: "createdAt", order: "desc" }, commandPath);
        const query = {};
        for (const pair of (Array.isArray(values["query"]) ? values["query"] : values["query"] ? [values["query"]] : [])) {
            const eq = pair.indexOf("=");
            if (eq <= 0)
                throw new AxiError(`--query entries must be key=value, got: ${pair}`, "VALIDATION_ERROR");
            query[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
        const hasList = parsed.params.where || parsed.params.textFilter || parsed.params.select || values["limit"] !== undefined || values["offset"] !== undefined || values["order-by"] !== undefined;
        const payload = await ctx.client.request("GET", path, { query, list: hasList ? parsed.params : undefined });
        if (values["json"] === true)
            return JSON.stringify(scrub(payload), null, 2);
        return renderResult({ request: `GET /${path}`, response: shrink(payload, values["full"] === true) }, false);
    }
    const { values, positionals } = parseFlags(rest, commandPath, WRITE_FLAGS);
    const path = validPath(requirePositional(positionals, 0, "path", commandPath));
    forbidExtraPositionals(positionals, 1, commandPath);
    requireAuth(ctx, commandPath);
    const raw = requireString(values, "body", commandPath);
    let body;
    if (raw?.startsWith("@")) {
        try {
            body = JSON.parse(readFileSync(raw.slice(1), "utf8"));
        }
        catch (error) {
            throw new AxiError(`--body @${raw.slice(1)} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`, "VALIDATION_ERROR");
        }
    }
    else if (raw !== undefined) {
        try {
            body = JSON.parse(raw);
        }
        catch {
            throw new AxiError(`--body must be valid JSON (or @file), got: ${raw.slice(0, 120)}`, "VALIDATION_ERROR");
        }
    }
    else if (method !== "delete") {
        throw new AxiError(`api ${method} requires --body <json>`, "VALIDATION_ERROR");
    }
    requireConfirm(values, commandPath, `${method.toUpperCase()} /${path}${body !== undefined ? ` with ${JSON.stringify(body).slice(0, 160)}` : ""}`);
    const payload = await ctx.client.request(method.toUpperCase(), path, { body });
    if (values["json"] === true)
        return JSON.stringify(scrub(payload), null, 2);
    return renderResult({ request: `${method.toUpperCase()} /${path}`, response: payload === null ? "(empty response)" : shrink(payload, values["full"] === true) }, false);
}
/** Keep responses readable: cap string lengths and long arrays unless --full. Secrets are masked either way. */
function shrink(payload, full) {
    if (payload === null || typeof payload !== "object")
        return payload;
    if (Array.isArray(payload))
        return payload.length > 50 && !full ? [...payload.slice(0, 50).map((p) => shrink(p, false)), `... ${payload.length - 50} more`] : payload.map((p) => shrink(p, full));
    if (full)
        return scrub(payload);
    const out = {};
    for (const [key, value] of Object.entries(redactSecrets(payload))) {
        if (typeof value === "string" && value.length > 500)
            out[key] = `${value.slice(0, 500)}\u2026(${value.length} chars \u2014 use --full)`;
        else if (value && typeof value === "object")
            out[key] = shrink(value, false);
        else
            out[key] = value;
    }
    return out;
}
/** Deep secret masking for raw JSON output. */
function scrub(payload) {
    if (Array.isArray(payload))
        return payload.map(scrub);
    if (isRecord(payload)) {
        const out = {};
        for (const [key, value] of Object.entries(redactSecrets(payload)))
            out[key] = scrub(value);
        return out;
    }
    return payload;
}
