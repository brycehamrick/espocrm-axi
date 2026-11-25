import { AxiError } from "axi-sdk-js";
import type { AxiRenderable } from "../lib/output.js";
import { withHelp } from "../lib/output.js";
import { asRecord, asRecordArray, asString, compact, type Json } from "../lib/coerce.js";
import { forbidExtraPositionals, optionalInt, parseFlags, requireString, splitCsv, type FlagDefinition } from "../lib/args.js";
import { requireAuth } from "../lib/auth.js";
import { normalizeType, validId } from "../lib/records.js";
import { resolveUser } from "../lib/resolve.js";
import { toEspoDateTime } from "../lib/time.js";
import type { CommandContext } from "../context.js";

/**
 * Activities = meetings, calls, tasks (and anything the admin added under
 * activitiesEntityList). Endpoints: /Activities/upcoming, /Activities (calendar
 * range), /Activities/{parentType}/{id}/{type}.
 */

export const ACTIVITIES_HELP = `espocrm-axi activities - meetings, calls, and tasks across parents

  activities upcoming [--user <id|name>] [--days n] [--types Meeting,Call,Task] [--limit n]
                                 what is due next for a user (default: you)
  activities calendar --from <date> [--to <date>] [--agenda] [--users a,b] [--teams a,b] [--types ...]
                                 calendar range (JSON events with dateStart/dateEnd; dates as YYYY-MM-DD)
  activities meetings|calls|tasks --parent-type <Type> --parent-id <id>   one record's activity list

examples:
  espocrm-axi activities upcoming --days 14
  espocrm-axi activities calendar --from 2026-12-01 --to 2026-12-07 --agenda
  espocrm-axi activities calls --parent-type Lead --parent-id <id>`;

const UPCOMING_FLAGS: Record<string, FlagDefinition> = { user: { type: "string" }, days: { type: "string" }, types: { type: "string" }, limit: { type: "string" }, json: { type: "boolean" } };
const CALENDAR_FLAGS: Record<string, FlagDefinition> = { from: { type: "string" }, to: { type: "string" }, agenda: { type: "boolean" }, users: { type: "string" }, teams: { type: "string" }, types: { type: "string" }, json: { type: "boolean" } };
const PARENT_FLAGS: Record<string, FlagDefinition> = { "parent-type": { type: "string" }, "parent-id": { type: "string" }, "target-type": { type: "string" }, json: { type: "boolean" } };

function eventRow(row: Json): Json {
  return compact({
    type: asString(row["_scope"]) ?? asString(row["entityType"]),
    id: asString(row["id"]),
    name: asString(row["name"]) ?? asString(row["subject"]),
    start: asString(row["dateStart"]),
    end: asString(row["dateEnd"]) ?? asString(row["dateEndDate"]),
    status: asString(row["status"]),
    assigned: asString(row["assignedUserName"]),
    parent: asString(row["parentType"]) ? `${asString(row["parentType"])}:${asString(row["parentName"]) ?? asString(row["parentId"])}` : undefined,
  });
}

function rowsOf(payload: unknown): Json[] {
  const record = asRecord(payload);
  return asRecordArray(record?.["list"] ?? payload);
}

export async function activitiesCommand(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === undefined || sub === "--help" || sub === "help") return ACTIVITIES_HELP;
  const commandPath = `espocrm-axi activities ${sub}`;
  requireAuth(ctx, commandPath);

  if (sub === "upcoming") {
    const { values } = parseFlags(rest, commandPath, UPCOMING_FLAGS);
    const limit = optionalInt(values, "limit", { min: 1, max: 200 }) ?? 20;
    const query: Record<string, string> = { maxSize: String(limit) };
    const user = requireString(values, "user", commandPath);
    if (user) query["userId"] = await resolveUser(ctx, user, commandPath);
    const days = optionalInt(values, "days", { min: 1, max: 365 });
    if (days) query["futureDays"] = String(days);
    const types = splitCsv(values["types"] as string | undefined);
    types.forEach((t, i) => (query[`entityTypeList[${i}]`] = t));
    const payload = await ctx.client.request("GET", "Activities/upcoming", { query });
    const rows = rowsOf(payload).map(eventRow);
    const out: Json = { count: rows.length };
    if (rows.length === 0) out["result"] = "0 upcoming activities";
    else out["activities"] = rows;
    return withHelp(out, ["Run `espocrm-axi record get <Type> <id>` for details, or `task list --since today` for tasks only"], values["json"] === true);
  }

  if (sub === "calendar") {
    const { values } = parseFlags(rest, commandPath, CALENDAR_FLAGS);
    const from = requireString(values, "from", commandPath);
    const to = requireString(values, "to", commandPath);
    if (!from) throw new AxiError(`${commandPath}: --from <date> is required`, "VALIDATION_ERROR");
    const query: Record<string, string> = {};
    try {
      query["from"] = toEspoDateTime(from);
      if (to) query["to"] = toEspoDateTime(to);
    } catch (error) {
      throw new AxiError(error instanceof Error ? error.message : String(error), "VALIDATION_ERROR");
    }
    if (values["agenda"] === true) query["agenda"] = "true";
    splitCsv(values["users"] as string | undefined).forEach((u, i) => (query[`userIdList[${i}]`] = u));
    splitCsv(values["teams"] as string | undefined).forEach((t, i) => (query[`teamIdList[${i}]`] = t));
    splitCsv(values["types"] as string | undefined).forEach((t, i) => (query[`scopeList[${i}]`] = t));
    const payload = await ctx.client.request("GET", "Activities", { query });
    const rows = rowsOf(payload).map(eventRow);
    const out: Json = { count: rows.length, from: query["from"], ...(query["to"] ? { to: query["to"] } : {}) };
    if (rows.length === 0) out["result"] = "0 activities in range";
    else out["activities"] = rows;
    return withHelp(out, ["Raw events (with dateStart/dateEnd fields): rerun with --json"], values["json"] === true);
  }

  if (sub === "meetings" || sub === "calls" || sub === "tasks") {
    const { values, positionals } = parseFlags(rest, commandPath, PARENT_FLAGS);
    forbidExtraPositionals(positionals, 0, commandPath);
    const parentType = normalizeType(requireString(values, "parent-type", commandPath) ?? "");
    const parentId = validId(requireString(values, "parent-id", commandPath) ?? "");
    const targetType = requireString(values, "target-type", commandPath);
    const path = `Activities/${encodeURIComponent(parentType)}/${encodeURIComponent(parentId)}/${sub}${targetType ? `/list/${encodeURIComponent(targetType)}` : ""}`;
    const payload = await ctx.client.request("GET", path);
    const rows = rowsOf(payload).map(eventRow);
    const out: Json = { parent: `${parentType}:${parentId}`, count: rows.length };
    if (rows.length === 0) out["result"] = `0 ${sub} for this record`;
    else out[sub] = rows;
    return withHelp(out, [`Run \`espocrm-axi ${sub === "meetings" ? "meeting" : sub === "calls" ? "call" : "task"} create --set parentType=${parentType} --set parentId=${parentId} --set name="..." --confirm\``], values["json"] === true);
  }

  throw new AxiError(`unknown activities subcommand: ${sub}`, "VALIDATION_ERROR", ["Run `espocrm-axi activities --help`"]);
}

