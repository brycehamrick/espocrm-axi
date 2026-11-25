import { readFileSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import type { AxiRenderable } from "../lib/output.js";
import { renderResult, withHelp } from "../lib/output.js";
import { asRecord, asRecordArray, asString, compact, type Json } from "../lib/coerce.js";
import { forbidExtraPositionals, optionalInt, parseFlags, requireConfirm, requirePositional, requireString, splitCsv, stringList, type FlagDefinition } from "../lib/args.js";
import { requireAuth } from "../lib/auth.js";
import { normalizeType, validId } from "../lib/records.js";
import { snippet } from "../lib/truncate.js";
import { readUploadFile, uploadAttachment } from "../lib/attachment.js";
import type { CommandContext } from "../context.js";

/**
 * Stream = the activity feed. Posts are Note records of type Post; status
 * changes and field updates are system notes created automatically.
 */

export const STREAM_HELP = `espocrm-axi stream - activity feeds and posts

  stream [--limit n] [--offset n]            the authenticated user's global stream
  espocrm-axi record stream <Type> <id>      one record's stream (posts + changes)

posts (Note records of type Post; --confirm required):
  post create <Type> <id> (--text "..." | --text-file f) [--attach file ...] [--attach-id id,...]
  post pin|unpin <noteId>
  post react <noteId> --type Like            reactions: Like, Love, Care, Haha, Wow, Sad, Angry (instance dependent)
  post unreact <noteId> --type Like
  post reactors <noteId> --type Like         who reacted

examples:
  espocrm-axi stream --limit 10
  espocrm-axi post create Case <id> --text "Called the customer, pending callback." --confirm`;

const LIST_FLAGS: Record<string, FlagDefinition> = { limit: { type: "string" }, offset: { type: "string" }, json: { type: "boolean" } };
const CREATE_FLAGS: Record<string, FlagDefinition> = {
  text: { type: "string" }, "text-file": { type: "string" }, attach: { type: "string", multiple: true }, "attach-id": { type: "string" }, confirm: { type: "boolean" }, json: { type: "boolean" },
};
const REACT_FLAGS: Record<string, FlagDefinition> = { type: { type: "string" }, json: { type: "boolean" } };
const PIN_FLAGS: Record<string, FlagDefinition> = { json: { type: "boolean" } };

function noteRow(row: Json): Json {
  const data = asRecord(row["data"]);
  return compact({
    id: asString(row["id"]),
    type: asString(row["type"]),
    by: asString(row["createdByName"]),
    at: asString(row["createdAt"]),
    parent: asString(row["parentType"]) ? `${asString(row["parentType"])}:${asString(row["parentName"]) ?? asString(row["parentId"])}` : undefined,
    post: typeof row["post"] === "string" && row["post"] ? snippet(row["post"], 160) : undefined,
    change: data ? Object.entries(data).filter(([, v]) => v !== null && v !== "" && v !== undefined).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ").slice(0, 160) || undefined : undefined,
  });
}

export async function streamCommand(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "espocrm-axi stream";
  const { values } = parseFlags(args, commandPath, LIST_FLAGS);
  requireAuth(ctx, commandPath);
  const limit = optionalInt(values, "limit", { min: 1, max: 200 }) ?? 20;
  const offset = optionalInt(values, "offset", { min: 0, max: 100_000 }) ?? 0;
  const payload = await ctx.client.request("GET", "Stream", { query: { maxSize: limit, offset } });
  const rows = asRecordArray(asRecord(payload)?.["list"]);
  const out: Json = { count: rows.length };
  if (rows.length === 0) out["result"] = "0 stream entries";
  else out["notes"] = rows.map(noteRow);
  return withHelp(out, [
    `Run \`espocrm-axi record stream <Type> <id>\` for one record, or \`post create <Type> <id> --text "..." --confirm\``,
    ...(rows.length === limit ? [`Older entries: --offset ${offset + rows.length}`] : []),
  ], values["json"] === true);
}

export async function postCommand(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === undefined || sub === "--help" || sub === "help") return STREAM_HELP;
  const commandPath = `espocrm-axi post ${sub}`;
  requireAuth(ctx, commandPath);

  if (sub === "create") {
    const { values, positionals } = parseFlags(rest, commandPath, CREATE_FLAGS);
    const type = normalizeType(requirePositional(positionals, 0, "Type", commandPath));
    const id = validId(requirePositional(positionals, 1, "id", commandPath));
    forbidExtraPositionals(positionals, 2, commandPath);
    const text = requireString(values, "text", commandPath);
    const textFile = requireString(values, "text-file", commandPath);
    if ((text ? 1 : 0) + (textFile ? 1 : 0) !== 1) throw new AxiError("post create needs exactly one of --text or --text-file", "VALIDATION_ERROR");
    const post = textFile ? readFileSync(textFile, "utf8") : text!;
    requireConfirm(values, commandPath, `post to ${type} ${id}: "${post.replace(/\s+/g, " ").slice(0, 80)}"`);
    const attachments = [...splitCsv(values["attach-id"] as string | undefined)];
    for (const path of stringList(values, "attach") ?? []) {
      attachments.push((await uploadAttachment(ctx, readUploadFile(path, commandPath), { field: "attachments", parentType: "Note" })).id);
    }
    const record = asRecord(await ctx.client.request("POST", "Note", { body: compact({ type: "Post", parentType: type, parentId: id, post, attachmentsIds: attachments.length ? attachments : undefined }) }));
    return renderResult({ posted: compact({ id: asString(record?.["id"]), parentType: type, parentId: id, attachments: attachments.length || undefined }) , help: [`Run \`espocrm-axi record stream ${type} ${id}\` to see it`] }, values["json"] === true);
  }

  if (sub === "pin" || sub === "unpin") {
    const { values, positionals } = parseFlags(rest, commandPath, PIN_FLAGS);
    const noteId = validId(requirePositional(positionals, 0, "noteId", commandPath));
    forbidExtraPositionals(positionals, 1, commandPath);
    await ctx.client.request(sub === "pin" ? "POST" : "DELETE", `Note/${encodeURIComponent(noteId)}/pin`);
    return renderResult({ [sub === "pin" ? "pinned" : "unpinned"]: { noteId } }, values["json"] === true);
  }

  if (sub === "react" || sub === "unreact" || sub === "reactors") {
    const { values, positionals } = parseFlags(rest, commandPath, REACT_FLAGS);
    const noteId = validId(requirePositional(positionals, 0, "noteId", commandPath));
    forbidExtraPositionals(positionals, 1, commandPath);
    const type = requireString(values, "type", commandPath);
    if (!type) throw new AxiError("--type <reaction> is required (e.g. Like)", "VALIDATION_ERROR");
    if (sub === "reactors") {
      const payload = await ctx.client.request("GET", `Note/${encodeURIComponent(noteId)}/reactors/${encodeURIComponent(type)}`);
      const rows = Array.isArray(payload) ? payload.filter((r): r is Json => typeof r === "object" && r !== null) : asRecordArray(asRecord(payload)?.["list"] ?? payload);
      return withHelp({ note: noteId, reaction: type, count: rows.length, users: rows.map((r) => compact({ id: asString(r["id"]), name: asString(r["name"]) })) }, [], values["json"] === true);
    }
    await ctx.client.request(sub === "react" ? "POST" : "DELETE", `Note/${encodeURIComponent(noteId)}/myReactions/${encodeURIComponent(type)}`);
    return renderResult({ [sub === "react" ? "reacted" : "unreacted"]: { noteId, type } }, values["json"] === true);
  }

  throw new AxiError(`unknown post subcommand: ${sub}`, "VALIDATION_ERROR", ["Run `espocrm-axi post --help`"]);
}
