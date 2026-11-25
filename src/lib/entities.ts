/**
 * Curated defaults per entity type. Every entity (including custom ones) works
 * with the generic `record` engine; presets only decide which 3-5 columns a
 * list shows, which date field `--since/--until` filters, and which field the
 * status breakdown is computed on.
 */

export interface EntityPreset {
  type: string;
  label: string;
  columns: string[];
  dateField?: string;
  orderBy?: string;
  order?: "asc" | "desc";
  statusField?: string;
}

export const ENTITY_PRESETS: Record<string, EntityPreset> = {
  Lead: { type: "Lead", label: "Leads", columns: ["id", "name", "status", "emailAddress", "accountName", "assignedUserName"], dateField: "createdAt", orderBy: "createdAt", order: "desc", statusField: "status" },
  Contact: { type: "Contact", label: "Contacts", columns: ["id", "name", "title", "accountName", "emailAddress", "assignedUserName"], dateField: "createdAt", orderBy: "createdAt", order: "desc", statusField: "type" },
  Account: { type: "Account", label: "Accounts", columns: ["id", "name", "type", "industry", "emailAddress", "assignedUserName"], dateField: "createdAt", orderBy: "createdAt", order: "desc", statusField: "type" },
  Opportunity: { type: "Opportunity", label: "Opportunities", columns: ["id", "name", "accountName", "stage", "amount", "closeDate", "assignedUserName"], dateField: "createdAt", orderBy: "createdAt", order: "desc", statusField: "stage" },
  Case: { type: "Case", label: "Cases", columns: ["id", "name", "status", "priority", "type", "contactName", "assignedUserName"], dateField: "createdAt", orderBy: "createdAt", order: "desc", statusField: "status" },
  Task: { type: "Task", label: "Tasks", columns: ["id", "name", "status", "dateStart", "dateDue", "parentName", "assignedUserName"], dateField: "dateStart", orderBy: "dateStart", order: "asc", statusField: "status" },
  Meeting: { type: "Meeting", label: "Meetings", columns: ["id", "name", "dateStart", "dateEnd", "parentName", "assignedUserName"], dateField: "dateStart", orderBy: "dateStart", order: "asc", statusField: "status" },
  Call: { type: "Call", label: "Calls", columns: ["id", "name", "dateStart", "direction", "parentName", "assignedUserName"], dateField: "dateStart", orderBy: "dateStart", order: "asc", statusField: "status" },
  Note: { type: "Note", label: "Notes", columns: ["id", "type", "post", "parentType", "parentName", "createdByName", "createdAt"], dateField: "createdAt", orderBy: "createdAt", order: "desc", statusField: "type" },
  Campaign: { type: "Campaign", label: "Campaigns", columns: ["id", "name", "type", "status", "startDate", "endDate"], dateField: "createdAt", orderBy: "createdAt", order: "desc", statusField: "status" },
  TargetList: { type: "TargetList", label: "Target lists", columns: ["id", "name", "createdAt"], dateField: "createdAt", orderBy: "createdAt", order: "desc" },
  EmailTemplate: { type: "EmailTemplate", label: "Email templates", columns: ["id", "name", "subject"], dateField: "createdAt", orderBy: "name", order: "asc", statusField: "type" },
  EmailFolder: { type: "EmailFolder", label: "Email folders", columns: ["id", "name"], orderBy: "order", order: "asc" },
  GroupEmailFolder: { type: "GroupEmailFolder", label: "Group email folders", columns: ["id", "name"], orderBy: "order", order: "asc" },
  EmailAccount: { type: "EmailAccount", label: "Email accounts", columns: ["id", "name", "emailAddress", "status"], orderBy: "name", order: "asc", statusField: "status" },
  InboundEmail: { type: "InboundEmail", label: "Inbound (group) email accounts", columns: ["id", "name", "emailAddress", "status"], orderBy: "name", order: "asc", statusField: "status" },
  Document: { type: "Document", label: "Documents", columns: ["id", "name", "type", "size", "createdAt"], dateField: "createdAt", orderBy: "createdAt", order: "desc", statusField: "type" },
  User: { type: "User", label: "Users", columns: ["id", "userName", "name", "type", "isActive"], orderBy: "name", order: "asc", statusField: "type" },
  Team: { type: "Team", label: "Teams", columns: ["id", "name"], orderBy: "name", order: "asc" },
  Role: { type: "Role", label: "Roles", columns: ["id", "name"], orderBy: "name", order: "asc" },
  Pipeline: { type: "Pipeline", label: "Pipelines", columns: ["id", "name", "entityType"], orderBy: "order", order: "asc", statusField: "entityType" },
  PipelineStage: { type: "PipelineStage", label: "Pipeline stages", columns: ["id", "name", "pipelineName", "order"], orderBy: "order", order: "asc" },
  ScheduledJob: { type: "ScheduledJob", label: "Scheduled jobs", columns: ["id", "name", "status", "job"], orderBy: "name", order: "asc", statusField: "status" },
  Job: { type: "Job", label: "Jobs", columns: ["id", "name", "status", "executeTime", "attempts"], dateField: "executeTime", orderBy: "executeTime", order: "desc", statusField: "status" },
  Webhook: { type: "Webhook", label: "Webhooks", columns: ["id", "name", "event", "isActive"], orderBy: "name", order: "asc", statusField: "event" },
  Notification: { type: "Notification", label: "Notifications", columns: ["id", "type", "message", "read", "createdAt"], dateField: "createdAt", orderBy: "createdAt", order: "desc", statusField: "type" },
  Attachment: { type: "Attachment", label: "Attachments", columns: ["id", "name", "size", "type", "role"], dateField: "createdAt", orderBy: "createdAt", order: "desc", statusField: "role" },
  Product: { type: "Product", label: "Products", columns: ["id", "name", "type", "unitPrice", "isActive"], orderBy: "name", order: "asc", statusField: "type" },
  KnowledgeBaseArticle: { type: "KnowledgeBaseArticle", label: "Knowledge base articles", columns: ["id", "name", "status", "type"], orderBy: "name", order: "asc", statusField: "status" },
  LeadCapture: { type: "LeadCapture", label: "Lead capture forms", columns: ["id", "name", "isActive", "leadType"], orderBy: "name", order: "asc", statusField: "leadType" },
};

export const FALLBACK_COLUMNS = ["id", "name"];
export const FALLBACK_EXTRA_COLUMNS = ["status", "emailAddress", "assignedUserName", "createdAt", "dateStart", "dateSent", "stage", "type"];

export function presetFor(type: string): EntityPreset {
  return ENTITY_PRESETS[type] ?? { type, label: `${type} records`, columns: FALLBACK_COLUMNS, dateField: "createdAt", orderBy: "createdAt", order: "desc", statusField: "status" };
}

/** Output columns for a list: explicit --fields, else preset columns, else id/name plus up to two extras present in the data. */
export function columnsFor(type: string, explicit: string[] | undefined, sample: Json | undefined): string[] {
  if (explicit && explicit.length > 0) return explicit;
  const preset = ENTITY_PRESETS[type];
  if (preset) return preset.columns;
  if (!sample) return FALLBACK_COLUMNS;
  const extras = FALLBACK_EXTRA_COLUMNS.filter((c) => sample[c] !== undefined && sample[c] !== null).slice(0, 2);
  return [...FALLBACK_COLUMNS, ...extras];
}

export function entityTypeArg(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Z][A-Za-z0-9]*$/.test(trimmed)) {
    throw new Error(`entity type must be a CamelCase EspoCRM scope name (e.g. Lead), got: ${value}`);
  }
  return trimmed;
}

type Json = Record<string, unknown>;
