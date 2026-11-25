import { AxiError } from "axi-sdk-js";
import type { AxiRenderable } from "../lib/output.js";
import { displayRecord, renderResult, withHelp } from "../lib/output.js";
import { asRecord, asRecordArray, asString, compact, displayValue, redactSecrets, type Json } from "../lib/coerce.js";
import { forbidExtraPositionals, optionalInt, parseAssignments, parseFlags, parseJsonFlag, requireConfirm, requirePositional, splitCsv, type FlagDefinition, type FlagValues } from "../lib/args.js";
import { requireAuth } from "../lib/auth.js";
import { LIST_FLAGS, MAX_LIMIT, parseListFlags, type ListDefaults } from "../lib/params.js";
import { presetFor } from "../lib/entities.js";
import { fetchRecords, listOutput, normalizeType, projectRows, validId } from "../lib/records.js";
import { resolveUser } from "../lib/resolve.js";
import type { CommandContext } from "../context.js";

export const RECORD_HELP = `espocrm-axi record - generic engine for ANY entity type (custom entities included)

discovery:
  record types                               every entity type on the instance
  record fields <Type> [filter]              attributes, types, required, enum options
  record links <Type>                        relationships (link names for link/unlink/related)

reading:
  record list <Type> [flags]                 list with filters (see flags below)
  record get <Type> <id> [--fields a,b] [--full]
  record count <Type> [where flags]          total only
  record related <Type> <id> <link> [flags]  records linked through a relationship
  record stream <Type> <id>                  stream notes (posts, status changes)
  record followers <Type> <id>

writing (all need --confirm):
  record create <Type> --set name=Acme --set status=Customer [--attr '{json}'] [--assignee <user>] [--teams a,b]
  record update <Type> <id> --set status=New [--attr '{json}']
  record delete <Type> <id>
  record link <Type> <id> <link> <ids...> | record unlink ...

per-user flags (reversible, no --confirm): follow, unfollow, star, unstar

list flags:
  --limit <n> (default 20, max ${MAX_LIMIT})  --offset <n>  --order-by <attr>  --order asc|desc
  --where <clause> (repeat)   compact DSL: status=New  status!=New  amount>1000  name~=Brighten
                              assignedUserId=null  doNotCall=true  status=in:New,Assigned
                              createdAt=lastXDays:7  teams=linkedWith:<id>  "a=1 OR b=2"
  --where-json <json>         raw where items for OR/AND groups
  --text <q>                  full-text filter
  --since <date> --until <date>   --date-field <attr> (default createdAt; now|today|7d|24h|YYYY-MM-DD)
  --primary-filter <name> --bool-filter <name>
  --select <attrs>            API-side projection; --fields <attrs>  output columns
  --full                      no truncation; --json raw payload

examples:
  espocrm-axi record list Lead --where status=New --since 7d --limit 5
  espocrm-axi record get Opportunity 6a9f1b5b1c2020905 --fields name,stage,amount
  espocrm-axi record create Note --set parentType=Lead --set parentId=<id> --set type=Post --set post="Called, left voicemail" --confirm
  espocrm-axi record link Contact <id> opportunities <oppId> --confirm`;

const ID_FLAGS: Record<string, FlagDefinition> = { fields: { type: "string" }, full: { type: "boolean" }, json: { type: "boolean" } };
const WRITE_FLAGS: Record<string, FlagDefinition> = {
  set: { type: "string", multiple: true },
  attr: { type: "string" },
  assignee: { type: "string" },
  teams: { type: "string" },
  confirm: { type: "boolean" },
  json: { type: "boolean" },
};
const LINK_FLAGS: Record<string, FlagDefinition> = { confirm: { type: "boolean" }, json: { type: "boolean" } };
const STREAM_FLAGS: Record<string, FlagDefinition> = { limit: { type: "string" }, offset: { type: "string" }, json: { type: "boolean" } };
const TYPES_FLAGS: Record<string, FlagDefinition> = { json: { type: "boolean" } };
const FIELDS_FLAGS: Record<string, FlagDefinition> = { json: { type: "boolean" } };
const SIMPLE_FLAGS: Record<string, FlagDefinition> = { json: { type: "boolean" } };

export async function recordCommand(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "types":
      return recordTypes(rest, ctx);
    case "fields":
      return recordFields(rest, ctx, "fields");
    case "links":
      return recordFields(rest, ctx, "links");
    case "list":
      return recordList(rest, ctx);
    case "get":
      return recordGet(rest, ctx);
    case "count":
      return recordCount(rest, ctx);
    case "create":
      return recordCreate(rest, ctx);
    case "update":
      return recordUpdate(rest, ctx);
    case "delete":
      return recordDelete(rest, ctx);
    case "link":
    case "unlink":
      return recordLink(rest, ctx, sub === "link");
    case "related":
      return recordRelated(rest, ctx);
    case "stream":
      return recordStream(rest, ctx);
    case "followers":
      return recordFollowers(rest, ctx);
    case "follow":
    case "unfollow":
    case "star":
    case "unstar":
      return recordSubscription(rest, ctx, sub);
    case undefined:
    case "--help":
    case "help":
      return RECORD_HELP;
    default:
      throw new AxiError(`unknown record subcommand: ${sub}`, "VALIDATION_ERROR", [
        "Run `espocrm-axi record --help` for types, fields, links, list, get, count, create, update, delete, link, unlink, related, stream, follow, star",
      ]);
  }
}

// ---------- discovery ----------

async function recordTypes(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "espocrm-axi record types";
  const { values } = parseFlags(args, commandPath, TYPES_FLAGS);
  requireAuth(ctx, commandPath);
  const scopes = asRecord(await ctx.client.request("GET", "Metadata", { query: { key: "scopes" } }));
  if (!scopes) return { result: "no scopes returned" };
  if (values["json"] === true) return JSON.stringify(scopes, null, 2);
  const byModule: Record<string, string[]> = {};
  let total = 0;
  for (const [name, raw] of Object.entries(scopes)) {
    const scope = asRecord(raw);
    if (!scope?.["entity"]) continue;
    total += 1;
    const module = asString(scope["module"]) ?? "Core";
    (byModule[module] ??= []).push(name);
  }
  const out: Json = { count: total };
  for (const [module, names] of Object.entries(byModule).sort((a, b) => a[0].localeCompare(b[0]))) {
    out[lower(module)] = names.sort().join(", ");
  }
  return withHelp(out, [
    "Run `espocrm-axi record fields <Type>` to see attributes and enum options",
    "Run `espocrm-axi record list <Type>` to browse any of these",
  ], false);
}

async function recordFields(args: string[], ctx: CommandContext, kind: "fields" | "links"): Promise<AxiRenderable> {
  const commandPath = `espocrm-axi record ${kind}`;
  const { values, positionals } = parseFlags(args, commandPath, FIELDS_FLAGS);
  const type = normalizeType(requirePositional(positionals, 0, "Type", commandPath));
  const filter = positionals[1]?.trim().toLowerCase();
  forbidExtraPositionals(positionals, 2, commandPath);
  requireAuth(ctx, commandPath);
  const defs = asRecord(await ctx.client.request("GET", "Metadata", { query: { scope: type, key: `entityDefs.${type}.${kind}` } }));
  if (!defs) throw new AxiError(`${type}: no ${kind} found (check the entity type with \`record types\`)`, "NOT_FOUND");
  if (values["json"] === true) return JSON.stringify(defs, null, 2);
  let entries = Object.entries(defs).sort(([a], [b]) => a.localeCompare(b));
  if (filter) entries = entries.filter(([name]) => name.toLowerCase().includes(filter));
  const rows = entries.map(([name, raw]) => {
    const def = asRecord(raw) ?? {};
    if (kind === "fields") {
      const options = Array.isArray(def["options"]) ? (def["options"] as unknown[]).join(" | ") : undefined;
      return compact({
        name,
        type: asString(def["type"]),
        required: def["required"] === true ? true : undefined,
        readOnly: def["readOnly"] === true || def["directAccessDisabled"] === true ? true : undefined,
        default: displayValue(def["default"]),
        options,
      });
    }
    return compact({ link: name, type: asString(def["type"]), entity: asString(def["entity"]) ?? asString(def["foreign"]) });
  });
  const out: Json = { count: rows.length, [kind]: rows };
  return withHelp(out, [
    kind === "fields"
      ? `Run \`espocrm-axi record list ${type} --where <field>=<value>\` or \`record create ${type} --set <field>=<value>\``
      : `Run \`espocrm-axi record related ${type} <id> <link>\` or \`record link ${type} <id> <link> <ids>\``,
  ], false);
}

// ---------- reading ----------

export function listDefaultsFor(type: string): ListDefaults {
  const preset = presetFor(type);
  return { dateField: preset.dateField ?? "createdAt", orderBy: preset.orderBy ?? "createdAt", order: preset.order ?? "desc" };
}

async function recordList(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const { values, positionals } = parseFlags(args, "espocrm-axi record list", LIST_FLAGS);
  const type = normalizeType(requirePositional(positionals, 0, "Type", "espocrm-axi record list"));
  forbidExtraPositionals(positionals, 1, "espocrm-axi record list");
  const commandPath = `espocrm-axi record list ${type}`;
  requireAuth(ctx, commandPath);
  const parsed = parseListFlags(values, listDefaultsFor(type), commandPath);
  const outcome = await fetchRecords(ctx, type, parsed.params);
  const preset = presetFor(type);
  const columns = parsed.fields ?? preset.columns;
  const out = listOutput(type, outcome, columns, preset, parsed.limit, parsed.offset, parsed.full, {
    help: (rows) => {
      const hints = [`Run \`espocrm-axi record fields ${type}\` to see every filterable attribute`];
      if (rows[0]?.["parentType"]) hints.push("Related emails: `espocrm-axi record related Email <id> <parentType> <parentId>` via `--where parentType=<T> --where parentId=<id>`");
      return hints;
    },
  });
  if (parsed.json) return JSON.stringify({ total: outcome.total, list: outcome.rows.map(redactSecrets) }, null, 2);
  return out;
}

async function recordGet(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "espocrm-axi record get";
  const { values, positionals } = parseFlags(args, commandPath, ID_FLAGS);
  const type = normalizeType(requirePositional(positionals, 0, "Type", commandPath));
  const id = validId(requirePositional(positionals, 1, "id", commandPath));
  forbidExtraPositionals(positionals, 2, commandPath);
  requireAuth(ctx, commandPath);
  const fields = splitCsv(values["fields"] as string | undefined);
  const record = asRecord(await ctx.client.request("GET", `${type}/${encodeURIComponent(id)}`));
  if (!record) throw new AxiError(`${type} ${id} returned no data`, "NOT_FOUND");
  if (values["json"] === true) return JSON.stringify(redactSecrets(record), null, 2);
  const full = values["full"] === true;
  let shown = displayRecord(record, 400, full);
  if (fields.length > 0) {
    const picked: Json = { id: record["id"] };
    for (const field of fields) if (record[field] !== undefined) picked[field] = shown[field] ?? record[field];
    shown = picked;
  }
  const name = asString(record["name"]);
  const parentId = asString(record["parentId"]);
  const parentType = asString(record["parentType"]);
  const help = [
    `Run \`espocrm-axi record update ${type} ${id} --set <field>=<value> --confirm\` to change it`,
    `Run \`espocrm-axi record stream ${type} ${id}\` for activity${presetFor(type).statusField ? ` or \`record list ${type} --where ${presetFor(type).statusField}=${asString(record[presetFor(type).statusField!]) ?? "x"}\`` : ""}`,
  ];
  if (parentType && parentId) help.push(`Parent: \`espocrm-axi record get ${parentType} ${parentId}\``);
  return withHelp({ [lower(type)]: shown, ...(name ? { name } : {}) }, help.filter(Boolean), false);
}

async function recordCount(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const { values, positionals } = parseFlags(args, "espocrm-axi record count", LIST_FLAGS);
  const type = normalizeType(requirePositional(positionals, 0, "Type", "espocrm-axi record count"));
  forbidExtraPositionals(positionals, 1, "espocrm-axi record count");
  const commandPath = `espocrm-axi record count ${type}`;
  requireAuth(ctx, commandPath);
  const parsed = parseListFlags(values, listDefaultsFor(type), commandPath);
  const outcome = await fetchRecords(ctx, type, { ...parsed.params, maxSize: 1, select: ["id"] });
  const out: Json = { type };
  if (outcome.total === undefined || outcome.total < 0) {
    out["count"] = outcome.rows.length > 0 ? "1+" : "0";
    out["note"] = "counting is disabled for this entity type; use `record list` to page through";
  } else {
    out["count"] = outcome.total;
  }
  return withHelp(out, [`Run \`espocrm-axi record list ${type}\` to see the records`], parsed.json);
}

async function recordRelated(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const { values, positionals } = parseFlags(args, "espocrm-axi record related", LIST_FLAGS);
  const type = normalizeType(requirePositional(positionals, 0, "Type", "espocrm-axi record related"));
  const id = validId(requirePositional(positionals, 1, "id", "espocrm-axi record related"));
  const link = requirePositional(positionals, 2, "link", "espocrm-axi record related");
  forbidExtraPositionals(positionals, 3, "espocrm-axi record related");
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(link)) throw new AxiError(`link must be a relationship name (see \`record links ${type}\`), got: ${link}`, "VALIDATION_ERROR");
  const commandPath = `espocrm-axi record related ${type} ${id} ${link}`;
  requireAuth(ctx, commandPath);
  const parsed = parseListFlags(values, { dateField: "createdAt", orderBy: "createdAt", order: "desc" }, commandPath);
  const payload = await ctx.client.request("GET", `${type}/${encodeURIComponent(id)}/${link}`, { list: parsed.params });
  const record = asRecord(payload);
  const rows = asRecordArray(record?.["list"]);
  const total = typeof record?.["total"] === "number" ? record["total"] : undefined;
  const columns = parsed.fields ?? ["id", "name", "status", "createdAt"];
  const out: Json = { count: rows.length, ...(total !== undefined && total >= 0 ? { total } : {}) };
  if (rows.length === 0) out["result"] = `0 records linked via ${link}`;
  else out[`${link}[${rows.length}]`] = projectRows(rows, columns, parsed.full);
  return withHelp(out, [
    `Run \`espocrm-axi record get <Type> <id>\` on any row`,
    `Link more: \`espocrm-axi record link ${type} ${id} ${link} <ids> --confirm\``,
  ], parsed.json);
}

// ---------- writing ----------

async function recordCreate(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "espocrm-axi record create";
  const { values, positionals } = parseFlags(args, commandPath, WRITE_FLAGS);
  const type = normalizeType(requirePositional(positionals, 0, "Type", commandPath));
  forbidExtraPositionals(positionals, 1, commandPath);
  requireAuth(ctx, commandPath);
  const attributes = collectAttributes(values);
  if (Object.keys(attributes).length === 0) {
    throw new AxiError(`record create ${type} needs at least one attribute (--set key=value or --attr '{json}')`, "VALIDATION_ERROR", [
      `Run \`espocrm-axi record fields ${type}\` to see attributes; most types require \`name\``,
    ]);
  }
  await applyAssignment(ctx, values, attributes, commandPath);
  requireConfirm(values, commandPath, `create ${type} with ${preview(attributes)}`);
  const record = asRecord(await ctx.client.request("POST", type, { body: attributes }));
  return mutationResult("created", type, record, values["json"] === true, [
    `Run \`espocrm-axi record update ${type} ${asString(record?.["id"]) ?? "<id>"} --set <field>=<value> --confirm\` to change it`,
    `Run \`espocrm-axi record link ${type} ${asString(record?.["id"]) ?? "<id>"} <link> <ids> --confirm\` to relate records`,
  ]);
}

async function recordUpdate(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "espocrm-axi record update";
  const { values, positionals } = parseFlags(args, commandPath, WRITE_FLAGS);
  const type = normalizeType(requirePositional(positionals, 0, "Type", commandPath));
  const id = validId(requirePositional(positionals, 1, "id", commandPath));
  forbidExtraPositionals(positionals, 2, commandPath);
  requireAuth(ctx, commandPath);
  const attributes = collectAttributes(values);
  if (Object.keys(attributes).length === 0) {
    throw new AxiError("record update needs at least one change (--set key=value or --attr '{json}')", "VALIDATION_ERROR");
  }
  await applyAssignment(ctx, values, attributes, commandPath);
  requireConfirm(values, commandPath, `update ${type} ${id} with ${preview(attributes)}`);
  const record = redactSecrets(asRecord(await ctx.client.request("PUT", `${type}/${encodeURIComponent(id)}`, { body: attributes })) ?? {});
  return mutationResult("updated", type, record, values["json"] === true, [
    `Run \`espocrm-axi record get ${type} ${id}\` to verify`,
  ]);
}

async function recordDelete(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "espocrm-axi record delete";
  const { values, positionals } = parseFlags(args, commandPath, LINK_FLAGS);
  const type = normalizeType(requirePositional(positionals, 0, "Type", commandPath));
  const id = validId(requirePositional(positionals, 1, "id", commandPath));
  forbidExtraPositionals(positionals, 2, commandPath);
  requireAuth(ctx, commandPath);
  requireConfirm(values, commandPath, `permanently delete ${type} ${id}`);
  const result = await ctx.client.request("DELETE", `${type}/${encodeURIComponent(id)}`);
  return renderResult({ deleted: { type, id }, ...(result === false ? { note: "server returned false" } : {}), help: ["Deletion is permanent; re-create with `record create` if this was a mistake"] }, values["json"] === true);
}

async function recordLink(args: string[], ctx: CommandContext, link: boolean): Promise<AxiRenderable> {
  const verb = link ? "link" : "unlink";
  const commandPath = `espocrm-axi record ${verb}`;
  const { values, positionals } = parseFlags(args, commandPath, LINK_FLAGS);
  const type = normalizeType(requirePositional(positionals, 0, "Type", commandPath));
  const id = validId(requirePositional(positionals, 1, "id", commandPath));
  const linkName = requirePositional(positionals, 2, "link", commandPath);
  const ids = positionals.slice(3).map(validId);
  if (ids.length === 0) throw new AxiError(`${commandPath} needs at least one related record id`, "VALIDATION_ERROR");
  requireAuth(ctx, commandPath);
  requireConfirm(values, commandPath, `${verb} ${type} ${id} ${linkName} ${ids.join(", ")}`);
  const result = await ctx.client.request(link ? "POST" : "DELETE", `${type}/${encodeURIComponent(id)}/${linkName}`, { body: { ids } });
  return renderResult(
    { [verb === "link" ? "linked" : "unlinked"]: { type, id, link: linkName, ids }, ...(result === false ? { note: "server returned false" } : {}), help: [`Run \`espocrm-axi record related ${type} ${id} ${linkName}\` to verify`] },
    values["json"] === true,
  );
}

function collectAttributes(values: FlagValues): Json {
  const set = parseAssignments(values, "set") ?? {};
  const attr = parseJsonFlag(values, "attr") ?? {};
  return { ...set, ...attr };
}

async function applyAssignment(ctx: CommandContext, values: FlagValues, attributes: Json, commandPath: string): Promise<void> {
  const assignee = typeof values["assignee"] === "string" && values["assignee"] ? values["assignee"] : undefined;
  if (assignee) attributes["assignedUserId"] = await resolveUser(ctx, assignee, commandPath);
  const teams = splitCsv(values["teams"] as string | undefined);
  if (teams.length > 0) attributes["teamsIds"] = teams;
}

function preview(attributes: Json): string {
  const text = JSON.stringify(attributes);
  return text.length > 200 ? `${text.slice(0, 200)}\u2026` : text;
}

function mutationResult(verb: string, type: string, record: Json | undefined, json: boolean, help: string[]): AxiRenderable {
  if (json) return JSON.stringify(record ?? {}, null, 2);
  const shown = record ? displayRecord(record, 200, false) : {};
  return withHelp({ [verb]: compact({ type, id: asString(record?.["id"]), name: asString(record?.["name"]) }), ...(Object.keys(shown).length > 0 ? { record: shown } : {}) }, help, false);
}

// ---------- stream & subscriptions ----------

async function recordStream(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "espocrm-axi record stream";
  const { values, positionals } = parseFlags(args, commandPath, STREAM_FLAGS);
  const type = normalizeType(requirePositional(positionals, 0, "Type", commandPath));
  const id = validId(requirePositional(positionals, 1, "id", commandPath));
  forbidExtraPositionals(positionals, 2, commandPath);
  requireAuth(ctx, commandPath);
  const limit = optionalInt(values, "limit", { min: 1, max: 200 }) ?? 20;
  const offset = optionalInt(values, "offset", { min: 0, max: 100_000 }) ?? 0;
  const payload = await ctx.client.request("GET", `${type}/${encodeURIComponent(id)}/stream`, { query: { maxSize: limit, offset } });
  const record = asRecord(payload);
  const rows = asRecordArray(record?.["list"]);
  if (values["json"] === true) return JSON.stringify(payload, null, 2);
  const out: Json = { count: rows.length };
  if (rows.length === 0) out["result"] = `0 stream entries for ${type} ${id}`;
  else {
    out[`notes[${rows.length}]`] = rows.map((row) => {
      const data = asRecord(row["data"]);
      return compact({
        id: asString(row["id"]),
        type: asString(row["type"]),
        by: asString(row["createdByName"]),
        at: asString(row["createdAt"]),
        post: typeof row["post"] === "string" && row["post"] ? snippetOf(row["post"]) : undefined,
        change: data ? summarizeData(data) : undefined,
      });
    });
  }
  return withHelp(out, [
    `Run \`espocrm-axi post create ${type} ${id} --text "..." --confirm\` to add a note`,
    ...(rows.length === limit ? [`Older entries: --offset ${offset + rows.length}`] : []),
  ], false);
}

function summarizeData(data: Json): string | undefined {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined || value === "") continue;
    parts.push(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  return parts.length > 0 ? parts.join(", ").slice(0, 160) : undefined;
}

function snippetOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}\u2026` : flat;
}

async function recordFollowers(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "espocrm-axi record followers";
  const { values, positionals } = parseFlags(args, commandPath, SIMPLE_FLAGS);
  const type = normalizeType(requirePositional(positionals, 0, "Type", commandPath));
  const id = validId(requirePositional(positionals, 1, "id", commandPath));
  forbidExtraPositionals(positionals, 2, commandPath);
  requireAuth(ctx, commandPath);
  const payload = await ctx.client.request("GET", `${type}/${encodeURIComponent(id)}/followers`);
  const rows = asRecordArray(asRecord(payload)?.["list"] ?? payload);
  const out: Json = { count: rows.length, followers: rows.map((r) => compact({ id: asString(r["id"]), name: asString(r["name"]), userName: asString(r["userName"]) })) };
  if (rows.length === 0) out["result"] = `0 followers of ${type} ${id}`;
  return withHelp(out, [`Run \`espocrm-axi record follow ${type} ${id}\` to follow it`], values["json"] === true);
}

async function recordSubscription(args: string[], ctx: CommandContext, action: "follow" | "unfollow" | "star" | "unstar"): Promise<AxiRenderable> {
  const commandPath = `espocrm-axi record ${action}`;
  const { values, positionals } = parseFlags(args, commandPath, SIMPLE_FLAGS);
  const type = normalizeType(requirePositional(positionals, 0, "Type", commandPath));
  const id = validId(requirePositional(positionals, 1, "id", commandPath));
  forbidExtraPositionals(positionals, 2, commandPath);
  requireAuth(ctx, commandPath);
  const star = action === "star" || action === "unstar";
  const path = `${type}/${encodeURIComponent(id)}/${star ? "starSubscription" : "subscription"}`;
  const result = await ctx.client.request(action === "follow" || action === "star" ? "PUT" : "DELETE", path);
  return renderResult(
    { [action]: { type, id, ok: result !== false }, help: [`Run \`espocrm-axi record get ${type} ${id}\` (isFollowed / isStarred reflects the change)`] },
    values["json"] === true,
  );
}

function lower(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}
