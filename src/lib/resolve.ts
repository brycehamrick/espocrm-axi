import { AxiError } from "axi-sdk-js";
import type { CommandContext } from "../context.js";
import { asRecordArray, asString } from "./coerce.js";

/**
 * Name -> id resolution for references agents usually have as names:
 * users (`--assignee Bryce`), accounts, teams, and generic records.
 * Plain ids pass through untouched; names need exactly one match.
 */

const ID_RE = /^[a-f0-9]{16,17}$/i;

export async function resolveUser(ctx: CommandContext, idOrName: string, commandPath: string): Promise<string> {
  if (ID_RE.test(idOrName)) return idOrName;
  const result = await ctx.client.list("User", {
    maxSize: 5,
    select: ["id", "userName", "name"],
    where: [{ type: "or", value: [
      { type: "equals", attribute: "userName", value: idOrName },
      { type: "equals", attribute: "name", value: idOrName },
      { type: "equals", attribute: "id", value: idOrName },
    ] }],
  });
  return pickUnique(result.list, idOrName, "user", commandPath);
}

export async function resolveRecord(
  ctx: CommandContext,
  type: string,
  idOrName: string,
  commandPath: string,
  nameField = "name",
): Promise<string> {
  if (ID_RE.test(idOrName)) return idOrName;
  const result = await ctx.client.list(type, {
    maxSize: 5,
    select: ["id", nameField],
    where: [{ type: "equals", attribute: nameField, value: idOrName }],
  });
  return pickUnique(result.list, idOrName, type, commandPath);
}

function pickUnique(rows: Record<string, unknown>[], needle: string, kind: string, commandPath: string): string {
  if (rows.length === 1) {
    const id = asString(rows[0]?.["id"]);
    if (id) return id;
  }
  if (rows.length > 1) {
    const names = rows.map((r) => asString(r["name"]) ?? asString(r["userName"]) ?? "?").join(", ");
    throw new AxiError(`${commandPath}: "${needle}" matches several ${kind} records (${names}); pass the id instead`, "VALIDATION_ERROR", [
      `Run \`espocrm-axi record list ${kind === "user" ? "User" : kind} --text ${needle}\` to see ids`,
    ]);
  }
  throw new AxiError(`${commandPath}: no ${kind} named "${needle}"`, "NOT_FOUND", [
    `Run \`espocrm-axi record list ${kind === "user" ? "User" : kind} --text ${needle}\` to list candidates`,
  ]);
}

export async function entityNames(ctx: CommandContext, type: string, ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (ids.length === 0) return out;
  const result = await ctx.client.list(type, { maxSize: 200, select: ["id", "name"], where: [{ type: "in", attribute: "id", value: ids }] });
  for (const row of asRecordArray(result.list)) {
    const id = asString(row["id"]);
    const name = asString(row["name"]);
    if (id && name) out[id] = name;
  }
  return out;
}
