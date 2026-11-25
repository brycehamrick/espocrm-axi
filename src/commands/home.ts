import type { AxiRenderable } from "../lib/output.js";
import { asNumber, asRecord, asString, type Json } from "../lib/coerce.js";
import { requireAuth, refreshedHint } from "../lib/auth.js";
import type { CommandContext } from "../context.js";

export const COMMAND_NAMES =
  "record lead contact account opportunity case task meeting call note campaign document user team email stream post activities search attachment export mass settings admin pipelines kanban notification auth api setup";

interface CountCell {
  value: string;
}

async function count(ctx: CommandContext, type: string, where?: Json[]): Promise<CountCell> {
  try {
    const result = await ctx.client.list(type, { maxSize: 1, select: ["id"], where: where as never });
    const total = result.total;
    if (total === undefined || total < 0) return { value: `${result.list.length > 0 ? "1+" : 0}${total === -1 ? "+" : ""}` };
    return { value: String(total) };
  } catch {
    return { value: "unknown" };
  }
}

/**
 * AXI principles 7, 8, 9: the no-argument home view is live content, not
 * help. Unauthenticated runs make zero network calls; authenticated runs make
 * a handful of cheap calls in parallel and degrade gracefully when one fails.
 */
export async function homeCommand(_args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const configured = Boolean(ctx.config.domain && ctx.config.apiKey);
  const out: Json = { auth: configured ? ctx.config.authMode : "none" };

  if (!configured) {
    out["setup"] = "export ESPO_CRM_DOMAIN=crm.example.com ESPO_CRM_API_KEY=... (Administration > API Users)";
    out["commands"] = COMMAND_NAMES;
    out["help"] = [
      "Run `espocrm-axi --help` for the command list",
      "Export ESPO_CRM_DOMAIN and ESPO_CRM_API_KEY to unlock live data",
      "Run `espocrm-axi setup hooks` for ambient context in every session",
    ];
    return out;
  }

  let user: Json | undefined;
  try {
    const me = await ctx.client.request("GET", "App/user", { timeoutMs: 10_000 });
    user = asRecord(asRecord(me)?.["user"]);
    out["instance"] = ctx.config.domain;
    out["user"] = asString(user?.["name"]) ?? asString(user?.["userName"]) ?? "unknown";
    if (ctx.config.authMode === "basic") out["auth"] = `basic (${asString(user?.["userName"]) ?? ctx.config.username})`;
  } catch (error) {
    out["instance"] = ctx.config.domain;
    out["user"] = `unavailable (${error instanceof Error ? error.message.slice(0, 120) : "see espocrm-axi me"})`;
  }

  const [leads, contacts, accounts, opportunities, cases, tasks] = await Promise.all([
    count(ctx, "Lead"),
    count(ctx, "Contact"),
    count(ctx, "Account"),
    count(ctx, "Opportunity"),
    count(ctx, "Case", [{ type: "notIn", attribute: "status", value: ["Closed", "Rejected", "Duplicate"] }]),
    count(ctx, "Task", [{ type: "notIn", attribute: "status", value: ["Completed", "Canceled", "Derived"] }]),
  ]);
  out["leads"] = leads.value;
  out["contacts"] = contacts.value;
  out["accounts"] = accounts.value;
  out["opportunities"] = opportunities.value;
  out["open_cases"] = cases.value;
  out["open_tasks"] = tasks.value;

  if (ctx.config.authMode === "basic") {
    try {
      const unread = await ctx.client.request("GET", "Email/inbox/notReadCounts", { timeoutMs: 10_000 });
      out["inbox_unread"] = asNumber(asRecord(unread)?.["inbox"]) ?? 0;
    } catch {
      out["inbox_unread"] = "unknown";
    }
  } else {
    out["inbox_unread"] = "n/a (api-key users have no inbox; use ESPO_CRM_USERNAME for per-user access)";
  }

  out["commands"] = COMMAND_NAMES;
  out["help"] = [
    "Run `espocrm-axi email inbox --unread` to see unread mail",
    "Run `espocrm-axi record list <Type> --where status=New` for any entity (custom types included)",
    "Run `espocrm-axi record types` to list every entity type on this instance",
    "Run `espocrm-axi <command> --help` for any command reference",
    ...refreshedHint(ctx),
  ];
  return out;
}
