import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AxiError } from "axi-sdk-js";
import type { AxiRenderable } from "../lib/output.js";
import { withHelp } from "../lib/output.js";
import { asRecord, asString, compact, type Json } from "../lib/coerce.js";
import { forbidExtraPositionals, parseAssignments, parseFlags, parseJsonFlag, requireConfirm, requirePositional, requireString, splitCsv, type FlagDefinition, type FlagValues } from "../lib/args.js";
import { requireAuth } from "../lib/auth.js";
import { normalizeType, validId } from "../lib/records.js";
import { LIST_FLAGS, parseListFlags, type ParsedList } from "../lib/params.js";
import type { CommandContext } from "../context.js";

/**
 * Mass actions (POST /MassAction {entityType, action, params:{ids|searchParams},
 * data}) and exports (POST /Export). Both return a job record whose progress is
 * polled via /{type}/{id}/status; exports end with an attachment id to download.
 */

export const MASS_HELP = `espocrm-axi mass - bulk operations across many records (--confirm required)

  mass update --type <T> (--ids a,b | filters) --set k=v ... [--attr '{json}']
  mass delete --type <T> (--ids a,b | filters)
  mass follow|unfollow --type <T> (--ids a,b | filters)
  mass remove-from-team --type <T> --team <id> (--ids a,b | filters)
  mass convert-currency --type <T> --field <f> --currency EUR (--ids a,b | filters)
  mass run <action> --type <T> --data '{json}' (--ids a,b | filters)   any other action
  mass status <jobId>

filters are the record-list flags: --where, --text, --since, --primary-filter, --bool-filter
(the server applies them when no --ids is given). Dry run first with \`record list <T> <filters>\`.

examples:
  espocrm-axi mass update --type Lead --where status=New --set source=Webinar --confirm
  espocrm-axi mass delete --type Task --ids a,b,c --confirm
  espocrm-axi mass status 6b0...`;

export const EXPORT_HELP = `espocrm-axi export - export records to CSV/XLSX (admin/export permission)

  export create --type <T> [--format csv|xlsx] [--ids a,b | filters] [--select a,b] --confirm
  export status <id>                      poll progress
  export download <id> [--out file]       fetch the finished file (needs status Success)

examples:
  espocrm-axi export create --type Contact --where createdAt=lastXDays:30 --format csv --confirm
  espocrm-axi export download <id> --out contacts.csv`;

const MASS_FLAGS: Record<string, FlagDefinition> = {
  ...LIST_FLAGS,
  type: { type: "string" },
  ids: { type: "string" },
  set: { type: "string", multiple: true },
  attr: { type: "string" },
  team: { type: "string" },
  field: { type: "string" },
  currency: { type: "string" },
  data: { type: "string" },
  confirm: { type: "boolean" },
};
const STATUS_FLAGS: Record<string, FlagDefinition> = { json: { type: "boolean" } };
const EXPORT_FLAGS: Record<string, FlagDefinition> = { type: { type: "string" }, format: { type: "string" }, ids: { type: "string" }, ...LIST_FLAGS, confirm: { type: "boolean" } };
const DOWNLOAD_FLAGS: Record<string, FlagDefinition> = { out: { type: "string" } };

const ACTIONS = ["update", "delete", "follow", "unfollow", "remove-from-team", "convert-currency"] as const;

function targetType(values: FlagValues, commandPath: string): string {
  const raw = requireString(values, "type", commandPath);
  if (!raw) throw new AxiError("--type <EntityType> is required", "VALIDATION_ERROR");
  return normalizeType(raw);
}

function selection(values: FlagValues, parsed: ParsedList, commandPath: string): Json {
  const ids = splitCsv(values["ids"] as string | undefined).map(validId);
  if (ids.length > 0) return { ids };
  const hasFilter = (parsed.params.where && parsed.params.where.length > 0) || parsed.params.textFilter || parsed.params.primaryFilter || parsed.params.boolFilterList;
  if (!hasFilter) throw new AxiError(`${commandPath}: pass --ids or a filter (--where/--text/--primary-filter/--bool-filter) to select records`, "VALIDATION_ERROR");
  const searchParams: Json = {};
  if (parsed.params.where && parsed.params.where.length > 0) searchParams["where"] = parsed.params.where;
  if (parsed.params.textFilter) searchParams["textFilter"] = parsed.params.textFilter;
  if (parsed.params.primaryFilter) searchParams["primaryFilter"] = parsed.params.primaryFilter;
  if (parsed.params.boolFilterList) searchParams["boolFilterList"] = parsed.params.boolFilterList;
  return { searchParams };
}

async function runMass(ctx: CommandContext, type: string, action: string, params: Json, data: Json, commandPath: string, json: boolean): Promise<AxiRenderable> {
  const payload = asRecord(await ctx.client.request("POST", "MassAction", { body: { entityType: type, action, params, data }, timeoutMs: 300_000 }));
  const id = asString(payload?.["id"]);
  const count = payload?.["count"];
  const out: Json = { action, type, ...(id ? { job: id } : {}), ...(count !== undefined ? { affected: count } : {}), selection: params["ids"] ? `${(params["ids"] as string[]).length} ids` : "filter" };
  if (payload?.["status"] && payload["status"] !== "Success") out["status"] = payload["status"];
  return withHelp(out, id ? [`Progress: \`espocrm-axi mass status ${id}\``] : [], json);
}

export async function massCommand(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === undefined || sub === "--help" || sub === "help") return MASS_HELP;
  const commandPath = `espocrm-axi mass ${sub}`;
  requireAuth(ctx, commandPath);

  if (sub === "status") {
    const { values, positionals } = parseFlags(rest, commandPath, STATUS_FLAGS);
    const id = validId(requirePositional(positionals, 0, "jobId", commandPath));
    const payload = await ctx.client.request("GET", `MassAction/${encodeURIComponent(id)}/status`);
    return withHelp({ job: id, status: asRecord(payload)?.["status"] ?? payload }, [], values["json"] === true);
  }

  const action = sub === "run" ? null : (ACTIONS as readonly string[]).includes(sub!) ? sub : undefined;
  if (action === undefined) throw new AxiError(`unknown mass subcommand: ${sub}`, "VALIDATION_ERROR", ["Run `espocrm-axi mass --help`"]);

  const { values } = parseFlags(rest, commandPath, MASS_FLAGS);
  const type = targetType(values, commandPath);
  const parsed = parseListFlags(values, { dateField: "createdAt", orderBy: "createdAt", order: "desc" }, commandPath);
  const params = selection(values, parsed, commandPath);
  let data: Json = {};
  let name = action ?? "custom";
  if (sub === "run") {
    name = requirePositional(rest, 0, "action", commandPath);
    data = parseJsonFlag(values, "data") ?? {};
  } else if (action === "update") {
    data = { attributes: { ...(parseAssignments(values, "set") ?? {}), ...(parseJsonFlag(values, "attr") ?? {}) } };
    if (Object.keys(data["attributes"] as Json).length === 0) throw new AxiError("mass update needs --set key=value or --attr '{json}'", "VALIDATION_ERROR");
  } else if (action === "remove-from-team") {
    const team = requireString(values, "team", commandPath);
    if (!team) throw new AxiError("mass remove-from-team needs --team <teamId>", "VALIDATION_ERROR");
    data = { teamId: validId(team) };
  } else if (action === "convert-currency") {
    const field = requireString(values, "field", commandPath);
    const currency = requireString(values, "currency", commandPath);
    if (!field || !currency) throw new AxiError("mass convert-currency needs --field and --currency", "VALIDATION_ERROR");
    data = { field, currency };
  }
  requireConfirm(values, commandPath, `${name} ${type} records selected by ${params["ids"] ? `${(params["ids"] as string[]).length} ids` : "filter"}${Object.keys(data).length ? ` with ${JSON.stringify(data).slice(0, 160)}` : ""}`);
  return runMass(ctx, type, name, params, data, commandPath, values["json"] === true);
}

export async function exportCommand(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === undefined || sub === "--help" || sub === "help") return EXPORT_HELP;
  const commandPath = `espocrm-axi export ${sub}`;
  requireAuth(ctx, commandPath);

  if (sub === "create") {
    const { values } = parseFlags(rest, commandPath, EXPORT_FLAGS);
    const type = targetType(values, commandPath);
    const parsed = parseListFlags(values, { dateField: "createdAt", orderBy: "createdAt", order: "desc" }, commandPath);
    const params = selection(values, parsed, commandPath);
    const format = requireString(values, "format", commandPath);
    if (format && !["csv", "xlsx"].includes(format)) throw new AxiError("--format must be csv or xlsx", "VALIDATION_ERROR");
    const select = splitCsv(values["select"] as string | undefined);
    requireConfirm(values, commandPath, `export ${type} records selected by ${params["ids"] ? `${(params["ids"] as string[]).length} ids` : "filter"}${format ? ` as ${format}` : ""}`);
    const payload = asRecord(await ctx.client.request("POST", "Export", { body: { entityType: type, ...(format ? { format } : {}), ...(select.length ? { attributeList: select } : {}), ...(params["ids"] ? { ids: params["ids"] } : { searchParams: params["searchParams"] }) }, timeoutMs: 120_000 }));
    const id = asString(payload?.["id"]);
    return withHelp(compact({ export: id, type, status: asString(payload?.["status"]) }), id ? [`Run \`espocrm-axi export status ${id}\` then \`export download ${id} --out ${type.toLowerCase()}.${format ?? "csv"}\``] : [], values["json"] === true);
  }

  if (sub === "status") {
    const { values, positionals } = parseFlags(rest, commandPath, STATUS_FLAGS);
    const id = validId(requirePositional(positionals, 0, "id", commandPath));
    const payload = await ctx.client.request("GET", `Export/${encodeURIComponent(id)}/status`);
    const record = asRecord(payload);
    return withHelp({ export: id, status: record?.["status"], ...(record?.["count"] !== undefined ? { count: record["count"] } : {}) }, [`Done? \`espocrm-axi export download ${id} --out <file>\``], values["json"] === true);
  }

  if (sub === "download") {
    const { values, positionals } = parseFlags(rest, commandPath, DOWNLOAD_FLAGS);
    const id = validId(requirePositional(positionals, 0, "id", commandPath));
    forbidExtraPositionals(positionals, 1, commandPath);
    const record = asRecord(await ctx.client.request("GET", `Export/${encodeURIComponent(id)}`));
    const attachmentId = asString(record?.["attachmentId"]) ?? asString(record?.["fileId"]);
    const status = asString(record?.["status"]);
    if (!attachmentId || status !== "Success") {
      throw new AxiError(`export ${id} is not downloadable yet (status: ${status ?? "unknown"})`, "VALIDATION_ERROR", [`Poll with \`espocrm-axi export status ${id}\``]);
    }
    const file = await ctx.client.download(`Attachment/file/${encodeURIComponent(attachmentId)}`);
    const out = requireString(values, "out", commandPath) ?? file.filename ?? `${id}.${asString(record?.["format"])?.toLowerCase() ?? "csv"}`;
    const target = resolve(out);
    writeFileSync(target, file.bytes);
    return withHelp({ downloaded: { export: id, path: target, bytes: file.bytes.length, type: file.contentType } }, [], false);
  }

  throw new AxiError(`unknown export subcommand: ${sub}`, "VALIDATION_ERROR", ["Run `espocrm-axi export --help`"]);
}

