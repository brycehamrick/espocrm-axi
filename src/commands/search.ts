import type { AxiRenderable } from "../lib/output.js";
import { withHelp } from "../lib/output.js";
import { asRecord, asRecordArray, asString, compact, type Json } from "../lib/coerce.js";
import { forbidExtraPositionals, optionalInt, parseFlags, requirePositional, type FlagDefinition } from "../lib/args.js";
import { requireAuth } from "../lib/auth.js";
import type { CommandContext } from "../context.js";

/**
 * Global (cross-entity) text search. Needs the full-text search index built
 * (Administration > Rebuild); results carry a `_scope` with the entity type.
 */

export const SEARCH_HELP = `espocrm-axi search - global full-text search across entity types

  search "<query>" [--size n] [--json]      results grouped by entity type (_scope)

Uses GlobalSearch (full-text index). For one entity type prefer
\`espocrm-axi record list <Type> --text "<query>"\`, which filters server-side.`;

const SEARCH_FLAGS: Record<string, FlagDefinition> = { size: { type: "string" }, json: { type: "boolean" } };

export async function searchCommand(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "espocrm-axi search";
  const { values, positionals } = parseFlags(args, commandPath, SEARCH_FLAGS);
  const query = requirePositional(positionals, 0, "query", commandPath);
  forbidExtraPositionals(positionals, 1, commandPath);
  requireAuth(ctx, commandPath);
  const size = optionalInt(values, "size", { min: 1, max: 50 }) ?? 10;
  const payload = asRecord(await ctx.client.request("GET", "GlobalSearch", { query: { q: query, maxSize: size } }));
  const rows = asRecordArray(payload?.["list"]);
  const grouped: Record<string, Json[]> = {};
  for (const row of rows) {
    const scope = asString(row["_scope"]) ?? "Unknown";
    (grouped[scope] ??= []).push(compact({ id: asString(row["id"]), name: asString(row["name"]), status: asString(row["status"]), emailAddress: asString(row["emailAddress"]), accountName: asString(row["accountName"]) }));
  }
  const out: Json = { query, count: rows.length, by_type: Object.fromEntries(Object.entries(grouped).map(([k, v]) => [k, v.length])) };
  if (rows.length === 0) out["result"] = `0 results for "${query}" (full-text index may need a rebuild, or try record list <Type> --text)`;
  else for (const [scope, items] of Object.entries(grouped)) out[scope] = items;
  return withHelp(out, ["Run `espocrm-axi record get <Type> <id>` on any result"], values["json"] === true);
}
