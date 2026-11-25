import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AxiError } from "axi-sdk-js";
import { withHelp } from "../lib/output.js";
import { asRecord, asRecordArray, asString, compact, displayValue } from "../lib/coerce.js";
import { forbidExtraPositionals, optionalInt, parseFlags, parseJsonFlag, requireConfirm, requirePositional, requireString } from "../lib/args.js";
import { requireAuth } from "../lib/auth.js";
import { normalizeType, validId } from "../lib/records.js";
import { presetFor } from "../lib/entities.js";
import { breakdown } from "../lib/records.js";
/**
 * Administration and platform surfaces: Settings, Metadata, I18n, CurrencyRate,
 * Kanban, Pipelines, Jobs, Notifications, OpenApi, rebuild/clear-cache.
 * Most need an admin or API user with the matching scope.
 */
export const SETTINGS_HELP = `espocrm-axi settings - instance configuration (admin)

  settings list [--filter str]            all config keys (values truncated)
  settings get <key>                      one config value
  settings set <key> <json-value> --confirm   e.g. settings set outboundEmailFromName '"No Reply"' --confirm

example: espocrm-axi settings get outboundEmailIsShared`;
export const METADATA_HELP = `espocrm-axi metadata - application metadata (entity defs, scopes, layouts, languages...)

  metadata <key> [--scope <Type>] [--json]
     keys: scopes, entityDefs.<Type>.fields, entityDefs.<Type>.links, app.acl, clientDefs.<Type>, selectDefs.<Type>...
     (scoped keys like entityDefs.Lead.fields need --scope Lead; the full document is several MB)
  i18n [--locale en_US] [--default] [--json]      labels (scope names, field labels)

examples:
  espocrm-axi metadata app.acl
  espocrm-axi metadata entityDefs.Lead.links --scope Lead
  espocrm-axi i18n --locale de_DE`;
export const ADMIN_HELP = `espocrm-axi admin - instance operations (admin)

  admin rebuild --confirm          rebuild the database/metadata (after Entity Manager or extension changes)
  admin clear-cache --confirm      clear backend + frontend cache
  admin jobs                       currently running jobs
  openapi --out <file>             save the OpenAPI 3.1 spec for this instance (v9.3+)
  currency [rates] | currency set '{"EUR":1.11}' --confirm
  user acl <userId>                a user's effective access table
  team position <teamId> --user <userId> --position "<name>" --confirm   (position must exist on the team)

examples:
  espocrm-axi admin clear-cache --confirm
  espocrm-axi openapi --out openapi.json`;
export const PIPELINES_HELP = `espocrm-axi pipelines - sales pipelines and stages (kanban ordering)

  pipelines [--type Opportunity]                   pipelines for an entity type
  pipeline-stages [--pipeline <id>]                stages in display order
  pipeline move <id> --direction up|down|top|bottom --confirm
  pipeline-stage move <id> --direction up|down|top|bottom --confirm
  kanban <Type> [--max n]                          records grouped by status (or stage) with counts

examples:
  espocrm-axi pipelines --type Opportunity
  espocrm-axi kanban Lead --max 5`;
export const NOTIFICATION_HELP = `espocrm-axi notification - user notifications

  notification list [--unread] [--limit n]
  notification groups                          grouped notifications (per type/parent)
  notification group <id>                      one group's notifications
  notification mark-read <groupId> --confirm   mark a group read
  notification mark-all-read --confirm

Use \`espocrm-axi record list Notification\` for filters; Notification is a regular entity.`;
const LIST_FLAGS = { filter: { type: "string" }, json: { type: "boolean" } };
const KEY_FLAGS = { json: { type: "boolean" } };
const SET_FLAGS = { confirm: { type: "boolean" } };
const META_FLAGS = { scope: { type: "string" }, json: { type: "boolean" } };
const I18N_FLAGS = { locale: { type: "string" }, default: { type: "boolean" }, json: { type: "boolean" } };
const CURRENCY_FLAGS = { rates: { type: "string", multiple: true }, confirm: { type: "boolean" }, json: { type: "boolean" } };
const POSITION_FLAGS = { user: { type: "string" }, position: { type: "string" }, confirm: { type: "boolean" } };
const OPENAPI_FLAGS = { out: { type: "string" }, json: { type: "boolean" } };
const PIPELINE_FLAGS = { type: { type: "string" }, pipeline: { type: "string" }, direction: { type: "string" }, confirm: { type: "boolean" }, json: { type: "boolean" } };
const KANBAN_FLAGS = { max: { type: "string" }, json: { type: "boolean" } };
const NOTIF_FLAGS = { unread: { type: "boolean" }, limit: { type: "string" }, json: { type: "boolean" }, confirm: { type: "boolean" } };
// ---------- settings ----------
export async function settingsCommand(args, ctx) {
    const sub = args[0];
    const rest = args.slice(1);
    if (sub === undefined || sub === "--help" || sub === "help")
        return SETTINGS_HELP;
    const commandPath = `espocrm-axi settings ${sub}`;
    requireAuth(ctx, commandPath);
    if (sub === "list") {
        const { values } = parseFlags(rest, commandPath, LIST_FLAGS);
        const settings = asRecord(await ctx.client.request("GET", "Settings")) ?? {};
        const filter = requireString(values, "filter", commandPath)?.toLowerCase();
        let entries = Object.entries(settings).sort(([a], [b]) => a.localeCompare(b));
        if (filter)
            entries = entries.filter(([k]) => k.toLowerCase().includes(filter));
        if (values["json"] === true)
            return JSON.stringify(Object.fromEntries(entries), null, 2);
        const rows = entries.map(([key, value]) => compact({ key, value: displayValue(value) })).map((r) => ({ ...r, value: typeof r["value"] === "string" && String(r["value"]).length > 100 ? `${String(r["value"]).slice(0, 100)}\u2026` : r["value"] }));
        const out = { count: rows.length, settings: rows };
        return withHelp(out, ["Run `espocrm-axi settings get <key>` for a full value"], false);
    }
    if (sub === "get") {
        const { values, positionals } = parseFlags(rest, commandPath, KEY_FLAGS);
        const key = requirePositional(positionals, 0, "key", commandPath);
        forbidExtraPositionals(positionals, 1, commandPath);
        const settings = asRecord(await ctx.client.request("GET", "Settings")) ?? {};
        if (!(key in settings))
            throw new AxiError(`settings has no key "${key}"`, "NOT_FOUND", ["Run `espocrm-axi settings list --filter ${key.slice(0, 6)}`"]);
        return withHelp({ [key]: settings[key] }, ["Change it: `settings set " + key + " <json-value> --confirm`"], values["json"] === true);
    }
    if (sub === "set") {
        const { values, positionals } = parseFlags(rest, commandPath, SET_FLAGS);
        const key = requirePositional(positionals, 0, "key", commandPath);
        const raw = requirePositional(positionals, 1, "value", commandPath);
        forbidExtraPositionals(positionals, 2, commandPath);
        let value;
        try {
            value = JSON.parse(raw);
        }
        catch {
            value = raw;
        }
        requireConfirm(values, commandPath, `set ${key} = ${JSON.stringify(value)}`);
        await ctx.client.request("PUT", "Settings", { body: { [key]: value } });
        return withHelp({ updated: { key, value } }, ["Verify with `espocrm-axi settings get " + key + "`"], false);
    }
    throw new AxiError(`unknown settings subcommand: ${sub}`, "VALIDATION_ERROR", ["Run `espocrm-axi settings --help`"]);
}
// ---------- metadata / i18n ----------
export async function metadataCommand(args, ctx) {
    const sub = args[0];
    if (sub === "i18n")
        return i18nCommand(args.slice(1), ctx);
    const commandPath = "espocrm-axi metadata";
    const { values, positionals } = parseFlags(args, commandPath, META_FLAGS);
    const key = sub && !sub.startsWith("-") ? requirePositional(positionals, 0, "key", commandPath) : undefined;
    forbidExtraPositionals(positionals, key ? 1 : 0, commandPath);
    requireAuth(ctx, commandPath);
    const scope = requireString(values, "scope", commandPath);
    const payload = await ctx.client.request("GET", "Metadata", { query: { key, scope }, timeoutMs: 120_000 });
    if (values["json"] === true)
        return JSON.stringify(payload, null, 2);
    if (key === undefined) {
        const top = asRecord(payload);
        return withHelp({ keys: top ? Object.keys(top) : [], note: "full document; pass a key (see help) or --json", size_hint: `${JSON.stringify(payload).length} chars` }, ["Run `espocrm-axi metadata scopes` or `metadata entityDefs.Lead.fields --scope Lead`"], false);
    }
    const record = asRecord(payload);
    if (!record)
        return withHelp({ [key]: payload }, [], false);
    const entries = Object.entries(record);
    return withHelp({ key, count: entries.length, [key.split(".").pop() ?? key]: Object.fromEntries(entries.slice(0, 300)) }, entries.length > 300 ? ["Showing 300 entries; use --json for all"] : [], false);
}
async function i18nCommand(args, ctx) {
    const commandPath = "espocrm-axi i18n";
    const { values } = parseFlags(args, commandPath, I18N_FLAGS);
    requireAuth(ctx, commandPath);
    const payload = await ctx.client.request("GET", "I18n", { query: { locale: requireString(values, "locale", commandPath), default: values["default"] === true ? "true" : undefined } });
    if (values["json"] === true)
        return JSON.stringify(payload, null, 2);
    const i18n = asRecord(payload) ?? {};
    const global = asRecord(i18n["Global"]) ?? {};
    const scopeNames = asRecord(global["scopeNames"]) ?? {};
    return withHelp({ locale: requireString(values, "locale", commandPath) ?? "default", scope_names: scopeNames, note: "field labels: metadata i18n --json (per scope)" }, [], false);
}
// ---------- admin / currency / openapi / user / team ----------
export async function adminCommand(args, ctx) {
    const sub = args[0];
    const rest = args.slice(1);
    if (sub === undefined || sub === "--help" || sub === "help")
        return ADMIN_HELP;
    const commandPath = `espocrm-axi ${sub === "currency" || sub === "openapi" || sub === "user" || sub === "team" ? sub : `admin ${sub}`}`;
    requireAuth(ctx, commandPath);
    if (sub === "rebuild" || sub === "clear-cache") {
        const { values } = parseFlags(rest, commandPath, SET_FLAGS);
        requireConfirm(values, commandPath, sub === "rebuild" ? "rebuild the database schema and metadata" : "clear the application cache");
        const result = await ctx.client.request("POST", sub === "rebuild" ? "Admin/rebuild" : "Admin/clearCache", { timeoutMs: 300_000 });
        return withHelp({ [sub === "rebuild" ? "rebuilt" : "cache_cleared"]: result ?? true }, [], false);
    }
    if (sub === "jobs") {
        const { values } = parseFlags(rest, commandPath, KEY_FLAGS);
        const payload = await ctx.client.request("GET", "Admin/jobs");
        const rows = asRecordArray(asRecord(payload)?.["list"] ?? payload);
        return withHelp({ count: rows.length, running_jobs: rows.map((r) => compact({ id: asString(r["id"]), name: asString(r["name"]), status: asString(r["status"]), startedAt: asString(r["startedAt"]), pid: r["pid"] })) }, ["Pending/failed jobs: `espocrm-axi job list --where status=Failed`"], values["json"] === true);
    }
    if (sub === "openapi") {
        const { values } = parseFlags(rest, commandPath, OPENAPI_FLAGS);
        const payload = await ctx.client.request("GET", "OpenApi", { timeoutMs: 120_000 });
        if (values["json"] === true)
            return JSON.stringify(payload, null, 2);
        const out = requireString(values, "out", commandPath) ?? "openapi.json";
        writeFileSync(resolve(out), JSON.stringify(payload, null, 2));
        const info = asRecord(asRecord(payload)?.["info"]);
        return withHelp({ saved: resolve(out), title: info?.["title"], version: info?.["version"], paths: Object.keys(asRecord(asRecord(payload)?.["paths"]) ?? {}).length }, ["Inspect endpoints: `jq '.paths | keys' <file>`"], false);
    }
    if (sub === "currency") {
        const { values, positionals } = parseFlags(rest, commandPath, CURRENCY_FLAGS);
        forbidExtraPositionals(positionals, 1, commandPath);
        if (positionals[0] === "set") {
            const rawRates = Array.isArray(values["rates"]) ? values["rates"] : values["rates"] ? [values["rates"]] : [];
            const ratesList = rawRates.length === 1 && rawRates[0].trim().startsWith("{") ? rawRates : rawRates.flatMap((r) => r.split(","));
            let body;
            if (ratesList.length === 1 && ratesList[0].trim().startsWith("{"))
                body = parseJsonFlag({ rates: ratesList[0] }, "rates");
            else if (ratesList.length > 0) {
                body = {};
                for (const pair of ratesList) {
                    const [k, v] = pair.split("=");
                    if (!k || v === undefined || Number.isNaN(Number(v)))
                        throw new AxiError(`--rates entries must be CODE=number, got: ${pair}`, "VALIDATION_ERROR");
                    body[k.trim()] = Number(v);
                }
            }
            if (!body || Object.keys(body).length === 0)
                throw new AxiError("currency set needs --rates 'EUR=1.11,UAH=0.037' or --rates '{\"EUR\":1.11}'", "VALIDATION_ERROR");
            requireConfirm(values, commandPath, `update currency rates ${JSON.stringify(body)}`);
            await ctx.client.request("PUT", "CurrencyRate", { body });
            return withHelp({ updated: body }, ["Run `espocrm-axi currency rates`"], false);
        }
        const payload = await ctx.client.request("GET", "CurrencyRate");
        return withHelp({ base: asRecord(payload)?.["base"], rates: asRecord(payload)?.["rates"] ?? payload }, ["Update: `currency set --rates EUR=1.11 --confirm`"], values["json"] === true);
    }
    if (sub === "user") {
        const { values, positionals } = parseFlags(rest, commandPath, KEY_FLAGS);
        if (positionals[0] !== "acl")
            throw new AxiError("usage: user acl <userId>", "VALIDATION_ERROR");
        const id = validId(requirePositional(positionals, 1, "userId", commandPath));
        const payload = await ctx.client.request("GET", `User/${encodeURIComponent(id)}/acl`);
        const table = asRecord(asRecord(payload)?.["table"]) ?? {};
        const scopes = Object.entries(table).filter(([, p]) => asRecord(p)?.["read"]).map(([s]) => s);
        return withHelp({ user: id, readable_scopes: scopes, ...(values["json"] === true ? { acl: payload } : {}) }, ["Run `espocrm-axi me` for your own access"], false);
    }
    if (sub === "team") {
        const { values, positionals } = parseFlags(rest, commandPath, POSITION_FLAGS);
        if (positionals[0] !== "position")
            throw new AxiError("usage: team position <teamId> --user <userId> --position <name> --confirm", "VALIDATION_ERROR");
        const teamId = validId(requirePositional(positionals, 1, "teamId", commandPath));
        const userId = requireString(values, "user", commandPath);
        if (!userId)
            throw new AxiError("--user is required", "VALIDATION_ERROR");
        requireConfirm(values, commandPath, `set position of user ${userId} on team ${teamId} to ${values["position"] ?? "(none)"}`);
        const body = { id: userId, position: requireString(values, "position", commandPath) ?? null };
        await ctx.client.request("PUT", `Team/${encodeURIComponent(teamId)}/userPosition`, { body });
        return withHelp({ updated: { team: teamId, user: userId, position: body["position"] } }, [], false);
    }
    throw new AxiError(`unknown admin subcommand: ${sub}`, "VALIDATION_ERROR", ["Run `espocrm-axi admin --help`"]);
}
// ---------- pipelines / kanban ----------
export async function pipelinesCommand(args, ctx) {
    const sub = args[0];
    const rest = args.slice(1);
    if (sub === undefined || sub === "--help" || sub === "help")
        return PIPELINES_HELP;
    const commandPath = `espocrm-axi ${sub}`;
    requireAuth(ctx, commandPath);
    if (sub === "pipelines") {
        const { values } = parseFlags(rest, commandPath, PIPELINE_FLAGS);
        const result = await ctx.client.list("Pipeline", { maxSize: 100, select: ["id", "name", "entityType", "order", "isDefault"], orderBy: "order", order: "asc", where: requireString(values, "type", commandPath) ? [{ type: "equals", attribute: "entityType", value: requireString(values, "type", commandPath) }] : undefined });
        const rows = result.list.map((p) => compact({ id: asString(p["id"]), name: asString(p["name"]), entityType: asString(p["entityType"]), default: p["isDefault"] === true ? true : undefined }));
        return withHelp({ count: rows.length, ...(rows.length ? { pipelines: rows, by_type: breakdown(result.list, "entityType") } : { result: "0 pipelines (pipelines are only used when enabled for an entity type)" }) }, ["Stages: `pipeline-stages --pipeline <id>`"], values["json"] === true);
    }
    if (sub === "pipeline-stages") {
        const { values } = parseFlags(rest, commandPath, PIPELINE_FLAGS);
        const result = await ctx.client.list("PipelineStage", { maxSize: 200, select: ["id", "name", "pipelineName", "order", "color"], orderBy: "order", order: "asc", where: requireString(values, "pipeline", commandPath) ? [{ type: "equals", attribute: "pipelineId", value: requireString(values, "pipeline", commandPath) }] : undefined });
        const rows = result.list.map((s) => compact({ id: asString(s["id"]), name: asString(s["name"]), pipeline: asString(s["pipelineName"]), color: asString(s["color"]) }));
        return withHelp({ count: rows.length, ...(rows.length ? { stages: rows } : { result: "0 stages" }) }, ["Use a stage name in `opportunity update <id> --set stage=<name> --confirm`"], values["json"] === true);
    }
    if (sub === "pipeline" || sub === "pipeline-stage") {
        const { values, positionals } = parseFlags(rest, commandPath, PIPELINE_FLAGS);
        if (positionals[0] !== "move")
            throw new AxiError(`usage: ${sub} move <id> --direction up|down|top|bottom --confirm`, "VALIDATION_ERROR");
        const id = validId(requirePositional(positionals, 1, "id", commandPath));
        const direction = requireString(values, "direction", commandPath);
        if (!direction || !["up", "down", "top", "bottom"].includes(direction))
            throw new AxiError("--direction must be up, down, top, or bottom", "VALIDATION_ERROR");
        requireConfirm(values, commandPath, `move ${sub} ${id} ${direction}`);
        const type = sub === "pipeline" ? "Pipeline" : "PipelineStage";
        await ctx.client.request("POST", `${type}/${encodeURIComponent(id)}/move/${direction}`);
        return withHelp({ moved: { id, direction } }, [`Run \`espocrm-axi ${sub === "pipeline" ? "pipelines" : "pipeline-stages"}\` to verify`], values["json"] === true);
    }
    if (sub === "kanban") {
        const { values, positionals } = parseFlags(rest, commandPath, KANBAN_FLAGS);
        const type = normalizeType(requirePositional(positionals, 0, "Type", commandPath));
        forbidExtraPositionals(positionals, 1, commandPath);
        const max = optionalInt(values, "max", { min: 1, max: 50 }) ?? 5;
        const payload = await ctx.client.request("GET", `Kanban/${encodeURIComponent(type)}`, { query: { maxSize: 200 }, timeoutMs: 60_000 });
        const rows = asRecordArray(asRecord(payload)?.["list"] ?? payload);
        const groupField = type === "Opportunity" && rows[0]?.["stage"] !== undefined ? "stage" : asString(presetFor(type).statusField ?? "status") ?? "status";
        const groups = {};
        for (const row of rows)
            (groups[String(displayValue(row[groupField]) ?? "(none)")] ??= []).push(row);
        const out = { type, count: rows.length, group_by: groupField };
        for (const [group, items] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length)) {
            out[group] = { count: items.length, names: items.slice(0, max).map((r) => asString(r["name"])), ...(items.length > max ? { more: items.length - max } : {}) };
        }
        if (rows.length === 0)
            out["result"] = `0 ${type} records`;
        return withHelp(out, [`List a group: \`espocrm-axi record list ${type} --where ${groupField}=<value>\``], values["json"] === true);
    }
    throw new AxiError(`unknown pipelines subcommand: ${sub}`, "VALIDATION_ERROR", ["Run `espocrm-axi pipelines --help`"]);
}
// ---------- notifications ----------
export async function notificationCommand(args, ctx) {
    const sub = args[0];
    const rest = args.slice(1);
    if (sub === undefined || sub === "--help" || sub === "help")
        return NOTIFICATION_HELP;
    const commandPath = `espocrm-axi notification ${sub}`;
    requireAuth(ctx, commandPath);
    if (sub === "list") {
        const { values } = parseFlags(rest, commandPath, NOTIF_FLAGS);
        const limit = optionalInt(values, "limit", { min: 1, max: 200 }) ?? 20;
        const result = await ctx.client.list("Notification", { maxSize: limit, orderBy: "createdAt", order: "desc", select: ["id", "type", "message", "read", "createdAt", "relatedType", "relatedParentName", "number"], where: values["unread"] === true ? [{ type: "isFalse", attribute: "read" }] : undefined });
        const rows = result.list.map((n) => compact({ id: asString(n["id"]), type: asString(n["type"]), message: asString(n["message"]), read: n["read"], at: asString(n["createdAt"]), related: asString(n["relatedType"]) ? `${asString(n["relatedType"])}:${asString(n["relatedParentName"]) ?? ""}` : undefined }));
        const out = { count: rows.length };
        if (rows.length === 0)
            out["result"] = "0 notifications";
        else
            out["notifications"] = rows;
        return withHelp(out, ["Grouped view: `espocrm-axi notification groups`"], values["json"] === true);
    }
    if (sub === "groups") {
        const payload = await ctx.client.request("GET", "Notification/group");
        const rows = asRecordArray(asRecord(payload)?.["list"] ?? payload);
        return withHelp({ count: rows.length, groups: rows.map((g) => compact({ id: asString(g["id"]), type: asString(g["type"]), count: g["groupedCount"], unread: g["groupedUnreadCount"], message: asString(g["message"]), at: asString(g["createdAt"]) })) }, ["Open one: `notification group <id>`"], false);
    }
    if (sub === "group") {
        const { values, positionals } = parseFlags(rest, commandPath, NOTIF_FLAGS);
        const id = requirePositional(positionals, 0, "id", commandPath);
        const payload = await ctx.client.request("GET", `Notification/${encodeURIComponent(id)}/group`);
        const rows = asRecordArray(asRecord(payload)?.["list"] ?? payload);
        return withHelp({ group: id, count: rows.length, notifications: rows.map((n) => compact({ id: asString(n["id"]), type: asString(n["type"]), message: asString(n["message"]), read: n["read"], at: asString(n["createdAt"]) })) }, ["Mark read: `notification mark-read " + id + " --confirm`"], values["json"] === true);
    }
    if (sub === "mark-read" || sub === "mark-all-read") {
        const { values, positionals } = parseFlags(rest, commandPath, NOTIF_FLAGS);
        requireConfirm(values, commandPath, sub === "mark-all-read" ? "mark every notification read" : `mark notification group ${positionals[0] ?? ""} read`);
        if (sub === "mark-all-read") {
            const payload = await ctx.client.request("GET", "Notification/group");
            for (const g of asRecordArray(asRecord(payload)?.["list"] ?? payload)) {
                const id = asString(g["id"]);
                if (id && g["groupedUnreadCount"])
                    await ctx.client.request("POST", `Notification/group/${encodeURIComponent(id)}/markRead`);
            }
            return withHelp({ marked: "all groups" }, [], false);
        }
        const id = requirePositional(positionals, 0, "groupId", commandPath);
        await ctx.client.request("POST", `Notification/group/${encodeURIComponent(id)}/markRead`);
        return withHelp({ marked: { group: id } }, [], false);
    }
    throw new AxiError(`unknown notification subcommand: ${sub}`, "VALIDATION_ERROR", ["Run `espocrm-axi notification --help`"]);
}
