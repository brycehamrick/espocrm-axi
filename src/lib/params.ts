import { AxiError } from "axi-sdk-js";
import { optionalInt, oneOf, splitCsv, stringList, type FlagDefinition, type FlagValues } from "./args.js";
import { toEspoDateTime } from "./time.js";
import { parseWhereClause, parseWhereJson, WhereError, type ListParams, type WhereClause } from "./where.js";

/**
 * Flags shared by every list-style command, and the code that turns them into
 * ListParams. Defaults: 20 rows, newest first (per preset).
 */

export const LIST_FLAGS: Record<string, FlagDefinition> = {
  limit: { type: "string" },
  offset: { type: "string" },
  "order-by": { type: "string" },
  order: { type: "string" },
  where: { type: "string", multiple: true },
  "where-json": { type: "string" },
  text: { type: "string", short: "q" },
  "primary-filter": { type: "string" },
  "bool-filter": { type: "string", multiple: true },
  since: { type: "string" },
  until: { type: "string" },
  "date-field": { type: "string" },
  select: { type: "string" },
  fields: { type: "string" },
  full: { type: "boolean" },
  json: { type: "boolean" },
};

export interface ListDefaults {
  dateField: string;
  orderBy: string;
  order: "asc" | "desc";
}

export interface ParsedList {
  params: ListParams;
  limit: number;
  offset: number;
  fields: string[] | undefined;
  full: boolean;
  json: boolean;
}

export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 20;

export function parseListFlags(values: FlagValues, defaults: ListDefaults, commandPath: string): ParsedList {
  const limit = optionalInt(values, "limit", { min: 1, max: MAX_LIMIT }) ?? DEFAULT_LIMIT;
  const offset = optionalInt(values, "offset", { min: 0, max: 1_000_000 }) ?? 0;
  const order = oneOf(values, "order", ["asc", "desc"]) ?? defaults.order;
  const orderBy = typeof values["order-by"] === "string" && values["order-by"].trim() ? values["order-by"].trim() : undefined;
  const fields = splitCsv(values["fields"] as string | string[] | undefined);
  const select = splitCsv(values["select"] as string | string[] | undefined);

  const where: WhereClause[] = [];
  try {
    for (const clause of stringList(values, "where") ?? []) where.push(...parseWhereClause(clause));
    const json = values["where-json"];
    if (typeof json === "string") where.push(...parseWhereJson(json));
  } catch (error) {
    if (error instanceof WhereError || error instanceof Error) {
      throw new AxiError(`${commandPath}: ${error.message}`, "VALIDATION_ERROR", [
        'Examples: --where status=New --where "amount>1000" --where "name~=Brighten"',
        'Complex filters: --where-json \'[{"type":"or","value":[{"type":"equals","attribute":"status","value":"New"}]}]\'',
      ]);
    }
    throw error;
  }

  const dateField = (typeof values["date-field"] === "string" && values["date-field"].trim()) || defaults.dateField;
  const since = typeof values["since"] === "string" ? values["since"] : undefined;
  const until = typeof values["until"] === "string" ? values["until"] : undefined;
  try {
    if (since) where.push({ type: "greaterThan", attribute: dateField, value: toEspoDateTime(since) });
    if (until) where.push({ type: "lessThan", attribute: dateField, value: toEspoDateTime(until) });
  } catch (error) {
    throw new AxiError(`${commandPath}: ${error instanceof Error ? error.message : String(error)}`, "VALIDATION_ERROR", [
      "Use YYYY-MM-DD, YYYY-MM-DD HH:mm, ISO 8601, now/today/yesterday, or relative like 7d, 24h, 30m",
    ]);
  }

  const params: ListParams = {
    maxSize: limit,
    offset,
    orderBy: orderBy || defaults.orderBy,
    order,
    where: where.length > 0 ? where : undefined,
    textFilter: typeof values["text"] === "string" && values["text"].trim() ? values["text"].trim() : undefined,
    primaryFilter: typeof values["primary-filter"] === "string" && values["primary-filter"] ? values["primary-filter"] : undefined,
    boolFilterList: stringList(values, "bool-filter") ?? undefined,
    select: select.length > 0 ? select : fields.length > 0 ? Array.from(new Set(["id", ...fields])) : undefined,
  };

  return {
    params,
    limit,
    offset,
    fields: fields.length > 0 ? fields : undefined,
    full: values["full"] === true,
    json: values["json"] === true,
  };
}
