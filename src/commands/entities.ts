import { AxiError } from "axi-sdk-js";
import type { AxiRenderable } from "../lib/output.js";
import { withHelp } from "../lib/output.js";
import { asRecord, asString, compact } from "../lib/coerce.js";
import { forbidExtraPositionals, parseFlags, requireConfirm, requirePositional, requireString, type FlagDefinition } from "../lib/args.js";
import { requireAuth } from "../lib/auth.js";
import { validId } from "../lib/records.js";
import { resolveRecord, resolveUser } from "../lib/resolve.js";
import { formatEspoDateTime } from "../lib/time.js";
import { recordCommand } from "./record.js";
import type { CommandContext } from "../context.js";

/**
 * Per-entity shortcuts. Every shortcut is the generic `record` engine with the
 * entity type pre-bound, a couple of convenience filters translated into
 * `--where` clauses, and a tailored help text. Anything the generic engine can
 * do (fields, links, related, stream, follow...) works here too.
 */

export interface Shortcut {
  type: string;
  label: string;
  /** Convenience filters: flag -> where attribute. */
  filters: Record<string, string | { attribute: string; resolve: "user" | `record:${string}` }>;
  /** Common create/update flags worth mentioning in help. */
  commonFields: string[];
}

export const SHORTCUTS: Record<string, Shortcut> = {
  lead: { type: "Lead", label: "Leads", filters: { status: "status", email: "emailAddress", assigned: { attribute: "assignedUserId", resolve: "user" }, source: "source", industry: "industry" }, commonFields: ["firstName", "lastName", "emailAddress", "phoneNumber", "accountName", "status", "source", "industry", "assignedUserId", "teamsIds"] },
  contact: { type: "Contact", label: "Contacts", filters: { status: "type", email: "emailAddress", assigned: { attribute: "assignedUserId", resolve: "user" }, account: { attribute: "accountId", resolve: "record:Account" }, title: "title" }, commonFields: ["firstName", "lastName", "emailAddress", "phoneNumber", "title", "accountId", "assignedUserId", "teamsIds"] },
  account: { type: "Account", label: "Accounts", filters: { type: "type", email: "emailAddress", assigned: { attribute: "assignedUserId", resolve: "user" }, industry: "industry" }, commonFields: ["name", "type", "industry", "emailAddress", "phoneNumber", "website", "billingAddressCity", "assignedUserId", "teamsIds"] },
  opportunity: { type: "Opportunity", label: "Opportunities", filters: { stage: "stage", account: { attribute: "accountId", resolve: "record:Account" }, assigned: { attribute: "assignedUserId", resolve: "user" }, "close-date": "closeDate" }, commonFields: ["name", "accountId", "contactId", "stage", "amount", "closeDate", "leadSource", "assignedUserId", "teamsIds"] },
  case: { type: "Case", label: "Cases", filters: { status: "status", priority: "priority", type: "type", account: { attribute: "accountId", resolve: "record:Account" }, assigned: { attribute: "assignedUserId", resolve: "user" } }, commonFields: ["name", "status", "priority", "type", "accountId", "contactId", "description", "assignedUserId", "teamsIds"] },
  task: { type: "Task", label: "Tasks", filters: { status: "status", assigned: { attribute: "assignedUserId", resolve: "user" }, parent: "parentType" }, commonFields: ["name", "status", "dateStart", "dateDue", "dateEndDate", "parentType", "parentId", "assignedUserId", "teamsIds"] },
  meeting: { type: "Meeting", label: "Meetings", filters: { status: "status", assigned: { attribute: "assignedUserId", resolve: "user" }, parent: "parentType" }, commonFields: ["name", "dateStart", "dateEnd", "duration", "parentType", "parentId", "assignedUserId", "usersIds", "contactsIds", "leadsIds"] },
  call: { type: "Call", label: "Calls", filters: { status: "status", direction: "direction", assigned: { attribute: "assignedUserId", resolve: "user" }, parent: "parentType" }, commonFields: ["name", "status", "direction", "dateStart", "duration", "parentType", "parentId", "assignedUserId", "contactsIds", "leadsIds"] },
  note: { type: "Note", label: "Notes (type Post/Attachment/Image; posts are stream comments)", filters: { type: "type", parent: "parentType" }, commonFields: ["type", "post", "parentType", "parentId", "attachmentsIds"] },
  campaign: { type: "Campaign", label: "Campaigns", filters: { status: "status", type: "type" }, commonFields: ["name", "type", "status", "startDate", "endDate", "budget", "targetListsIds", "assignedUserId", "teamsIds"] },
  "target-list": { type: "TargetList", label: "Target lists", filters: {}, commonFields: ["name", "description", "entryCount", "optedOutCount", "assignedUserId", "teamsIds"] },
  document: { type: "Document", label: "Documents", filters: { type: "type" }, commonFields: ["name", "type", "fileId", "publication", "expirationDate", "assignedUserId", "teamsIds"] },
  user: { type: "User", label: "Users", filters: { type: "type" }, commonFields: ["userName", "firstName", "lastName", "emailAddress", "type", "isActive", "rolesIds", "teamsIds", "title"] },
  team: { type: "Team", label: "Teams", filters: {}, commonFields: ["name"] },
  "email-template": { type: "EmailTemplate", label: "Email templates", filters: { type: "type" }, commonFields: ["name", "subject", "body", "isHtml", "type", "entityType", "assignedUserId", "teamsIds"] },
  role: { type: "Role", label: "Roles (permission tables)", filters: {}, commonFields: ["name", "table"] },
  webhook: { type: "Webhook", label: "Webhooks (admin)", filters: { event: "event" }, commonFields: ["name", "event", "url", "isActive", "secret"] },
  job: { type: "Job", label: "Jobs (queue entries)", filters: { status: "status", "scheduled-job": "scheduledJobId" }, commonFields: ["name", "status", "executeTime", "attempts", "scheduledJobId"] },
  "scheduled-job": { type: "ScheduledJob", label: "Scheduled jobs (cron definitions)", filters: { status: "status" }, commonFields: ["name", "status", "job", "scheduling"] },
  product: { type: "Product", label: "Products (Sales Pack)", filters: { type: "type" }, commonFields: ["name", "type", "code", "unitPrice", "isActive", "taxRate", "teamsIds"] },
};

export function shortcutHelp(name: string): string {
  const s = SHORTCUTS[name]!;
  const filters = Object.entries(s.filters)
    .map(([flag, target]) => `--${flag} <${typeof target === "string" ? target : target.attribute}>`)
    .join("  ");
  return `espocrm-axi ${name} - ${s.label} (shortcut for \`record ... ${s.type}\`)

subcommands: list, get, create, update, delete, count, related, link, unlink, stream, followers, follow, unfollow, star, unstar
  (identical to \`espocrm-axi record --help\`, with ${s.type} pre-bound)
${name === "lead" ? "  convert <id> [--account <id|name>] [--skip-opportunity] [--opportunity <name>] [--amount n] [--stage s] [--close-date d]   create Account/Contact/Opportunity and mark the lead converted\n" : ""}
convenience filters (translated to --where): ${filters || "(none)"}
other list flags: --where, --text, --since, --limit, --fields, --json ... (see \`espocrm-axi record --help\`)

common fields: ${s.commonFields.join(", ")}

examples:
  espocrm-axi ${name} list --limit 10
  espocrm-axi ${name} get <id>
  espocrm-axi ${name} create --set ${s.commonFields[0]}=... --confirm
  espocrm-axi ${name} update <id> --set ${s.commonFields[0]}=... --confirm`;
}

export function shortcutCommand(name: string): (args: string[], ctx: CommandContext) => Promise<AxiRenderable> {
  const s = SHORTCUTS[name]!;
  return async (args: string[], ctx: CommandContext) => {
    const sub = args[0];
    if (sub === undefined || sub === "--help" || sub === "help") return shortcutHelp(name);
    if (name === "lead" && (sub === "convert" || sub === "action/convert")) return leadConvert(args.slice(1), ctx);
    const translated = await translateFilters(s, args.slice(1), ctx);
    return recordCommand([sub, s.type, ...translated], ctx);
  };
}

async function translateFilters(s: Shortcut, argv: string[], ctx: CommandContext): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      out.push(token);
      continue;
    }
    const flag = token.slice(2);
    const target = s.filters[flag];
    if (target === undefined) {
      out.push(token);
      continue;
    }
    const raw = argv[i + 1];
    if (raw === undefined || raw.startsWith("--")) {
      throw new AxiError(`--${flag} requires a value`, "VALIDATION_ERROR", [`Run \`espocrm-axi ${lowerFirst(s.type)} --help\``]);
    }
    i += 1;
    let attribute: string;
    let value = raw;
    if (typeof target === "string") {
      attribute = target;
    } else {
      attribute = target.attribute;
      if (target.resolve === "user") value = await resolveUser(ctx, raw, `espocrm-axi ${lowerFirst(s.type)}`);
      else {
        const related = target.resolve.slice("record:".length);
        value = await resolveRecord(ctx, related, raw, `espocrm-axi ${lowerFirst(s.type)}`);
      }
    }
    out.push("--where", `${attribute}=${value}`);
  }
  return out;
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

// ---------- lead convert ----------

const CONVERT_FLAGS: Record<string, FlagDefinition> = {
  account: { type: "string" },
  "skip-opportunity": { type: "boolean" },
  opportunity: { type: "string" },
  amount: { type: "string" },
  stage: { type: "string" },
  "close-date": { type: "string" },
  confirm: { type: "boolean" },
  json: { type: "boolean" },
};

async function leadConvert(args: string[], ctx: CommandContext): Promise<AxiRenderable> {
  const commandPath = "espocrm-axi lead convert";
  const { values, positionals } = parseFlags(args, commandPath, CONVERT_FLAGS);
  const id = validId(requirePositional(positionals, 0, "id", commandPath));
  forbidExtraPositionals(positionals, 1, commandPath);
  requireAuth(ctx, commandPath);
  requireConfirm(values, commandPath, `convert Lead ${id} into ${values["skip-opportunity"] === true ? "Account + Contact" : "Account + Contact + Opportunity"} and mark it converted`);

  const lead = asRecord(await ctx.client.request("GET", `Lead/${encodeURIComponent(id)}`));
  if (!lead) throw new AxiError(`Lead ${id} not found`, "NOT_FOUND");
  if (lead["convertedAt"]) {
    throw new AxiError(`Lead ${id} was already converted at ${String(lead["convertedAt"])}`, "VALIDATION_ERROR", [
      `Existing records: account=${String(lead["createdAccountId"] ?? "-")} contact=${String(lead["createdContactId"] ?? "-")} opportunity=${String(lead["createdOpportunityId"] ?? "-")}`,
    ]);
  }

  const assignedUserId = asString(lead["assignedUserId"]);
  const teamsIds = Array.isArray(lead["teamsIds"]) ? (lead["teamsIds"] as string[]) : [];
  const fullName = [asString(lead["firstName"]), asString(lead["lastName"])].filter(Boolean).join(" ") || asString(lead["name"]) || "Contact";
  const shared = compact({
    emailAddress: asString(lead["emailAddress"]),
    phoneNumber: asString(lead["phoneNumber"]),
    assignedUserId,
    teamsIds: teamsIds.length > 0 ? teamsIds : undefined,
    title: asString(lead["title"]),
    description: asString(lead["description"]),
  });
  const address = compact({
    addressStreet: asString(lead["addressStreet"]),
    addressCity: asString(lead["addressCity"]),
    addressState: asString(lead["addressState"]),
    addressCountry: asString(lead["addressCountry"]),
    addressPostalCode: asString(lead["addressPostalCode"]),
  });

  let accountId: string | undefined;
  const accountRef = requireString(values, "account", commandPath);
  if (accountRef) {
    accountId = await resolveRecord(ctx, "Account", accountRef, commandPath);
  } else {
    const account = asRecord(await ctx.client.request("POST", "Account", {
      body: compact({
        name: asString(lead["accountName"]) || fullName,
        industry: asString(lead["industry"]),
        website: asString(lead["website"]),
        billingAddressStreet: address["addressStreet"],
        billingAddressCity: address["addressCity"],
        billingAddressState: address["addressState"],
        billingAddressCountry: address["addressCountry"],
        billingAddressPostalCode: address["addressPostalCode"],
        ...shared,
      }),
    }));
    accountId = asString(account?.["id"]);
  }
  if (!accountId) throw new AxiError("account creation returned no id", "API_ERROR");

  const contact = asRecord(await ctx.client.request("POST", "Contact", {
    body: compact({
      firstName: asString(lead["firstName"]),
      lastName: asString(lead["lastName"]) ?? fullName,
      accountId,
      ...address,
      ...shared,
    }),
  }));
  const contactId = asString(contact?.["id"]);
  if (!contactId) throw new AxiError("contact creation returned no id", "API_ERROR");

  let opportunityId: string | undefined;
  if (values["skip-opportunity"] !== true) {
    let stage = requireString(values, "stage", commandPath);
    if (!stage) {
      const stages = await ctx.client.list("PipelineStage", { maxSize: 1, select: ["id", "name"], orderBy: "order", order: "asc", where: [{ type: "equals", attribute: "entityType", value: "Opportunity" }] });
      stage = asString(stages.list[0]?.["name"]);
    }
    const amountRaw = requireString(values, "amount", commandPath);
    const closeDate = requireString(values, "close-date", commandPath);
    const opportunity = asRecord(await ctx.client.request("POST", "Opportunity", {
      body: compact({
        name: requireString(values, "opportunity", commandPath) ?? fullName,
        accountId,
        contactId,
        stage,
        amount: amountRaw !== undefined ? Number(amountRaw) : undefined,
        closeDate: closeDate ?? undefined,
        leadSource: asString(lead["source"]),
        ...shared,
      }),
    }));
    opportunityId = asString(opportunity?.["id"]);
  }

  const converted = asRecord(await ctx.client.request("PUT", `Lead/${encodeURIComponent(id)}`, {
    body: compact({ convertedAt: formatEspoDateTime(new Date()), createdAccountId: accountId, createdContactId: contactId, createdOpportunityId: opportunityId }),
  }));

  const result = compact({ lead: id, account: accountId, contact: contactId, opportunity: opportunityId, convertedAt: asString(converted?.["convertedAt"]) });
  return withHelp({ converted: result }, [
    "Run `espocrm-axi account get " + accountId + "` / `contact get " + contactId + "` to review the new records",
    opportunityId ? `Run \`espocrm-axi opportunity update ${opportunityId} --set amount=<n> --confirm\` to refine the deal` : "Run `espocrm-axi opportunity create --set name=... --set accountId=" + accountId + " --confirm` to add a deal later",
  ], values["json"] === true);
}
