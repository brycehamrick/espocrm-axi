import { readFileSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import { displayRecord, renderResult, withHelp } from "../lib/output.js";
import { asRecord, asRecordArray, asString, compact, redactSecrets } from "../lib/coerce.js";
import { forbidExtraPositionals, optionalInt, parseFlags, requireConfirm, requirePositional, requireString, splitCsv, stringList } from "../lib/args.js";
import { requireAuth } from "../lib/auth.js";
import { LIST_FLAGS, parseListFlags } from "../lib/params.js";
import { fetchRecords, validId } from "../lib/records.js";
import { snippet, truncateText } from "../lib/truncate.js";
import { htmlToText, toEspoDateTime } from "../lib/time.js";
import { readUploadFile, uploadAttachment } from "../lib/attachment.js";
/**
 * Email - EspoCRM's most quirk-rich scope. Facts that shape this module:
 *  - Inbox membership is per-user (email_user rows); `inFolder` where items
 *    join the authenticated user, so folders need a user token, not an API key.
 *  - Sending: create with status=Sending (or PUT a Draft to Sending). Modern
 *    instances transmit synchronously and stamp dateSent; failures come back
 *    as HTTP 500 {id,message} and leave the record as a Draft. Older v7
 *    instances queue "Sending" for a cron job, hence --wait polling.
 *  - Creating with status=Sent NEVER transmits.
 *  - Reading one email (GET) marks it read for the user (server hook).
 *  - Listing has counting disabled: total is -1 (more) / -2 (no more).
 */
export const EMAIL_HELP = `espocrm-axi email - inbox, sending, and mailbox management

reading (per-user folders need a live user credential: ESPO_CRM_AUTH_MODE=basic):
  email inbox|sent|archive|drafts|important|trash|all [flags]   --unread --since 7d --from a@b --text q --limit
  email folder <name|id> [flags]           a personal or team/group folder by name or id (e.g. email folder Collabs)
  email get <id> [--full] [--html] [--json]     NOTE: reading marks it read
  email thread <id>                              an email plus its replies, oldest first
  email folders                                  personal + group (team) folders with unread counts and their filter ids
  email count                                    unread counts per folder

sending (--confirm required; delivery is verified via dateSent; --dry-run prints the payload and sends nothing):
  email send --to a@b,c@d --subject "..." (--text "..." | --text-file f | --html "..." | --html-file f)
             [--cc] [--bcc] [--from addr] [--parent-type Lead --parent-id <id>] [--attach file ...]
             --from defaults to your own address; pass a shared group mailbox address
             (e.g. --from collabs@example.com) to send as the team inbox
             [--attach-id id,...] [--teams a,b] [--signature-file f] [--wait 30]
  email reply <emailId> (--text ... | --html ...) [--all] [--cc] [--attach ...]   Re: + threading;
             replies inside a group folder send from that mailbox by default
  email draft <...same content flags as send>    create a Draft (no send)
  email send <draftId>                           queue an existing draft (PUT status=Sending)
  email schedule <draftId> --at "YYYY-MM-DD HH:mm"  send later via the cron job

mailbox state (per-user, reversible, no --confirm):
  email read|unread <ids...> | email read --all
  email important|unimportant <ids...>
  email archive|unarchive <ids...>          archive = inbox/folders/archive; unarchive = back to inbox
  email trash|untrash <ids...>
  email move <ids...> --folder <folderId|group:<id>>

accounts & templates:
  email accounts | email inbound                personal SMTP/IMAP accounts, group mailboxes (passwords redacted)
  email account reset-fetch <id> --confirm | email inbound reset-fetch <id> --confirm
  email templates | email template get <id> | email template prepare <id> --parent-type T --parent-id <id>
  email address-search --q x [--type Lead]      who owns an address (across entity types)
  email import-eml --file msg.eml               upload + import an .eml as an Email record
  email send-test --server host --port 587 --email-address from --to a@b   SMTP diagnostic

examples:
  espocrm-axi email inbox --unread --since 2d --limit 10
  espocrm-axi email reply <id> --text "Thanks, looping in Ada." --confirm
  espocrm-axi email send --to ada@example.com --subject "Hi" --text "Hello" --from you@example.com --confirm`;
const EMAIL_FOLDERS = ["inbox", "sent", "archive", "drafts", "important", "trash", "all"];
const FOLDER_FLAGS = { ...LIST_FLAGS, unread: { type: "boolean" }, from: { type: "string" } };
const GET_FLAGS = { full: { type: "boolean" }, html: { type: "boolean" }, json: { type: "boolean" } };
const IDS_FLAGS = { all: { type: "boolean" }, json: { type: "boolean" } };
const MOVE_FLAGS = { folder: { type: "string" }, json: { type: "boolean" } };
const CONTENT_FLAGS = {
    to: { type: "string" },
    cc: { type: "string" },
    bcc: { type: "string" },
    subject: { type: "string" },
    text: { type: "string" },
    "text-file": { type: "string" },
    html: { type: "string" },
    "html-file": { type: "string" },
    from: { type: "string" },
    "parent-type": { type: "string" },
    "parent-id": { type: "string" },
    teams: { type: "string" },
    attach: { type: "string", multiple: true },
    "attach-id": { type: "string" },
    "signature-file": { type: "string" },
    wait: { type: "string" },
    all: { type: "boolean" },
    "dry-run": { type: "boolean" },
    confirm: { type: "boolean" },
    json: { type: "boolean" },
};
const SEND_DRAFT_FLAGS = { wait: { type: "string" }, confirm: { type: "boolean" }, json: { type: "boolean" } };
const SCHEDULE_FLAGS = { at: { type: "string" }, confirm: { type: "boolean" }, json: { type: "boolean" } };
const FOLDER_CREATE_FLAGS = { name: { type: "string" }, confirm: { type: "boolean" } };
const CONFIRM_FLAGS = { confirm: { type: "boolean" } };
const PREPARE_FLAGS = {
    "parent-type": { type: "string" }, "parent-id": { type: "string" }, "related-type": { type: "string" }, "related-id": { type: "string" }, email: { type: "string" }, json: { type: "boolean" },
};
const ADDRESS_SEARCH_FLAGS = { q: { type: "string" }, type: { type: "string" }, limit: { type: "string" }, json: { type: "boolean" } };
const IMPORT_FLAGS = { file: { type: "string" }, json: { type: "boolean" } };
const SEND_TEST_FLAGS = {
    server: { type: "string" }, port: { type: "string" }, "email-address": { type: "string" }, to: { type: "string" },
    username: { type: "string" }, password: { type: "string" }, auth: { type: "string" }, security: { type: "string" },
    "from-name": { type: "string" }, confirm: { type: "boolean" },
};
const EMAIL_SELECT = ["id", "name", "status", "fromEmailAddressName", "fromString", "toEmailAddressesNames", "dateSent", "createdAt", "isRead", "hasAttachment", "parentType", "parentId", "groupFolderId", "groupFolderName", "bodyPlain"];
const DEFAULT_WAIT_SECONDS = 30;
const POLL_INTERVAL_MS = 3_000;
export async function emailCommand(args, ctx) {
    const sub = args[0];
    const rest = args.slice(1);
    if (sub === undefined || sub === "--help" || sub === "help")
        return EMAIL_HELP;
    // `archive`/`important`/`trash` are both folder views (no ids) and actions (with ids).
    const hasIds = rest.some((a) => !a.startsWith("-"));
    if (EMAIL_FOLDERS.includes(sub) && !(hasIds && (sub === "archive" || sub === "important" || sub === "trash"))) {
        return emailFolder(sub, rest, ctx);
    }
    switch (sub) {
        case "get": return emailGet(rest, ctx);
        case "thread": return emailThread(rest, ctx);
        case "send": return rest[0] !== undefined && !rest[0].startsWith("-") && rest[0] !== "--help" ? emailSendExisting(rest, ctx) : emailSend(rest, ctx, "Sending");
        case "reply": return emailReply(rest, ctx);
        case "draft": return emailDraft(rest, ctx);
        case "schedule": return emailSchedule(rest, ctx);
        case "read":
        case "unread": return mailboxState(sub, rest, ctx, "read");
        case "unimportant": return mailboxState(sub, rest, ctx, "important");
        case "untrash": return mailboxState(sub, rest, ctx, "inTrash");
        case "important": return hasIds ? mailboxState(sub, rest, ctx, "important") : emailFolder("important", rest, ctx);
        case "trash": return hasIds ? mailboxState(sub, rest, ctx, "inTrash") : emailFolder("trash", rest, ctx);
        case "archive": return hasIds ? moveToFolder(rest, ctx, "archive", "archive") : emailFolder("archive", rest, ctx);
        case "unarchive": return moveToFolder(rest, ctx, "inbox", "unarchive");
        case "move": return emailMove(rest, ctx);
        case "folders": return emailFolders(rest, ctx);
        case "folder": return rest[0] === "create" || rest[0] === "delete" ? emailFolderManage(rest, ctx) : emailFolderBySelector(rest, ctx);
        case "count": return emailCount(rest, ctx);
        case "accounts": return recordListRedacted(rest, ctx, "EmailAccount", "email accounts");
        case "account": return emailAccountAction(rest, ctx);
        case "inbound": return rest[0] === "reset-fetch" ? resetFetch(rest.slice(1), ctx, "InboundEmail") : recordListRedacted(rest, ctx, "InboundEmail", "inbound (group) email accounts");
        case "templates": return recordListRedacted(rest, ctx, "EmailTemplate", "email templates");
        case "template": return emailTemplate(rest, ctx);
        case "address-search": return emailAddressSearch(rest, ctx);
        case "import-eml": return emailImportEml(rest, ctx);
        case "send-test": return emailSendTest(rest, ctx);
        default:
            throw new AxiError(`unknown email subcommand: ${sub}`, "VALIDATION_ERROR", ["Run `espocrm-axi email --help`"]);
    }
}
// ---------- reading ----------
function emailRow(row, show) {
    const toNames = asRecord(row["toEmailAddressesNames"]);
    return compact({
        id: asString(row["id"]),
        [show]: show === "from"
            ? asString(row["fromEmailAddressName"]) ?? snippet(asString(row["fromString"]), 40)
            : Object.values(toNames ?? {}).map(String).join(", ") || asString(row["to"]),
        subject: snippet(asString(row["name"]), 70),
        date: asString(row["dateSent"]) ?? asString(row["createdAt"]),
        isRead: row["isRead"] === false ? false : undefined,
        attachments: row["hasAttachment"] === true ? true : undefined,
    });
}
async function emailFolder(folder, args, ctx, label = folder) {
    const commandPath = `espocrm-axi email ${label}`;
    const { values, positionals } = parseFlags(args, commandPath, FOLDER_FLAGS);
    forbidExtraPositionals(positionals, 0, commandPath);
    requireAuth(ctx, commandPath);
    const parsed = parseListFlags(values, { dateField: "dateSent", orderBy: "dateSent", order: "desc" }, commandPath);
    const extra = [{ type: "inFolder", attribute: "folderId", value: folder }];
    if (values["unread"] === true)
        extra.push({ type: "isFalse", attribute: "isRead" });
    const from = requireString(values, "from", commandPath);
    if (from)
        extra.push({ type: "equals", attribute: "from", value: from });
    const params = { ...parsed.params, select: parsed.params.select ?? EMAIL_SELECT };
    const outcome = await fetchRecords(ctx, "Email", params, extra);
    const show = folder === "sent" || folder === "drafts" ? "to" : "from";
    const rows = outcome.rows.map((r) => emailRow(r, show));
    const out = { folder: label, count: rows.length };
    if (outcome.total === -1)
        out["more"] = true;
    if (ctx.config.authMode !== "basic")
        out["note"] = "per-user folders need a live user credential (ESPO_CRM_AUTH_MODE=basic); an API user has no inbox";
    if (rows.length === 0)
        out["result"] = `0 emails in ${label}`;
    else
        out["emails"] = rows;
    const help = [];
    const first = asString(outcome.rows[0]?.["id"]);
    if (first)
        help.push(`Run \`espocrm-axi email get ${first}\` to read it (marks as read)`);
    if (folder === "inbox" && ctx.config.authMode === "basic") {
        try {
            out["unread_inbox"] = asRecord(await ctx.client.request("GET", "Email/inbox/notReadCounts"))?.["inbox"] ?? 0;
        }
        catch {
            out["unread_inbox"] = "unknown";
        }
    }
    if (rows.length === parsed.limit)
        help.push(`More may exist \u2014 page with --offset ${parsed.offset + rows.length}`);
    return parsed.json ? JSON.stringify({ total: outcome.total, list: outcome.rows }, null, 2) : withHelp(out, help, false);
}
async function emailGet(args, ctx) {
    const commandPath = "espocrm-axi email get";
    const { values, positionals } = parseFlags(args, commandPath, GET_FLAGS);
    const id = validId(requirePositional(positionals, 0, "id", commandPath));
    forbidExtraPositionals(positionals, 1, commandPath);
    requireAuth(ctx, commandPath);
    const record = asRecord(await ctx.client.request("GET", `Email/${encodeURIComponent(id)}`));
    if (!record)
        throw new AxiError(`Email ${id} not found`, "NOT_FOUND");
    if (values["json"] === true)
        return JSON.stringify(record, null, 2);
    const full = values["full"] === true;
    const bodyHtml = asString(record["body"]) ?? "";
    const plain = asString(record["bodyPlain"]) ?? htmlToText(bodyHtml);
    const body = values["html"] === true ? bodyHtml : plain;
    const names = (key) => Object.values(asRecord(record[key]) ?? {}).map(String).join(", ") || undefined;
    const attIds = Array.isArray(record["attachmentsIds"]) ? record["attachmentsIds"].length : 0;
    const out = {
        email: compact({
            id,
            status: asString(record["status"]),
            from: asString(record["fromString"]) ?? asString(record["fromAddress"]),
            to: names("toEmailAddressesNames") ?? asString(record["to"]),
            cc: names("ccEmailAddressesNames") ?? asString(record["cc"]),
            reply_to: asString(record["replyToString"]),
            subject: asString(record["name"]),
            date: asString(record["dateSent"]) ?? asString(record["createdAt"]),
            parent: asString(record["parentType"]) ? `${asString(record["parentType"])}:${asString(record["parentId"])}` : undefined,
            group_folder: asString(record["groupFolderName"]) ?? undefined,
            isRead: record["isRead"],
            attachments: attIds > 0 ? `${attIds}: ${names("attachmentsNames") ?? ""}`.trim() : undefined,
        }),
        body: full ? body : truncateText(body, 1500).value,
    };
    return withHelp(out, [
        `Reply: \`espocrm-axi email reply ${id} --text "..." --confirm\`  (reading this email marked it as read)`,
        full ? "Use --html to print the raw HTML body instead of plain text" : "Rerun with --full for the complete body, or --html for raw HTML",
    ], false);
}
async function emailThread(args, ctx) {
    const commandPath = "espocrm-axi email thread";
    const { values, positionals } = parseFlags(args, commandPath, GET_FLAGS);
    const id = validId(requirePositional(positionals, 0, "id", commandPath));
    forbidExtraPositionals(positionals, 1, commandPath);
    requireAuth(ctx, commandPath);
    // List-by-id avoids the read hook; the link list carries the replies.
    const self = await fetchRecords(ctx, "Email", { maxSize: 1, select: EMAIL_SELECT, where: [{ type: "equals", attribute: "id", value: id }] });
    const original = self.rows[0];
    if (!original)
        throw new AxiError(`Email ${id} not found`, "NOT_FOUND");
    const replies = await fetchRecords(ctx, `Email/${encodeURIComponent(id)}/replies`, { maxSize: 100, select: EMAIL_SELECT, orderBy: "dateSent", order: "asc" });
    const parentReplied = asString(original["repliedId"]);
    const parentRows = parentReplied ? (await fetchRecords(ctx, "Email", { maxSize: 1, select: EMAIL_SELECT, where: [{ type: "equals", attribute: "id", value: parentReplied }] })).rows : [];
    const ordered = [...parentRows, original, ...replies.rows].sort((a, b) => (asString(a["dateSent"]) ?? "").localeCompare(asString(b["dateSent"]) ?? ""));
    const rows = ordered.map((row) => compact({
        id: asString(row["id"]),
        date: asString(row["dateSent"]) ?? asString(row["createdAt"]),
        from: asString(row["fromEmailAddressName"]) ?? snippet(asString(row["fromString"]), 40),
        to: Object.values(asRecord(row["toEmailAddressesNames"]) ?? {}).map(String).join(", ") || undefined,
        subject: snippet(asString(row["name"]), 60),
        preview: snippet(asString(row["bodyPlain"]), 120),
    }));
    const out = { thread: id, count: rows.length, emails: rows };
    if (values["json"] === true)
        return JSON.stringify({ original, replies: replies.rows }, null, 2);
    return withHelp(out, [`Run \`espocrm-axi email get <id>\` for a full body, or \`email reply ${id} --text "..." --confirm\``], false);
}
async function emailFolders(args, ctx) {
    const commandPath = "espocrm-axi email folders";
    const { values } = parseFlags(args, commandPath, IDS_FLAGS);
    requireAuth(ctx, commandPath);
    const [personal, group, counts] = await Promise.all([
        ctx.client.list("EmailFolder", { maxSize: 200, select: ["id", "name", "order"], orderBy: "order", order: "asc" }),
        ctx.client.list("GroupEmailFolder", { maxSize: 200, select: ["id", "name", "order"], orderBy: "order", order: "asc" }),
        ctx.client.request("GET", "Email/inbox/notReadCounts").catch(() => null),
    ]);
    const unread = asRecord(counts) ?? {};
    const out = {
        unread_inbox: unread["inbox"] ?? 0,
        personal_folders: personal.list.map((f) => compact({ id: asString(f["id"]), name: asString(f["name"]), unread: unread[asString(f["id"]) ?? ""] })),
        group_folders: group.list.map((f) => compact({ id: asString(f["id"]), name: asString(f["name"]), unread: unread[`group:${asString(f["id"]) ?? ""}`], filter: `group:${asString(f["id"]) ?? ""}` })),
    };
    if (personal.list.length === 0 && group.list.length === 0)
        out["result"] = "0 folders (only the built-in inbox/archive/trash)";
    return withHelp(out, ["Open one: `espocrm-axi email folder <name>` (e.g. `email folder Collabs --unread`)", "Move mail: `espocrm-axi email move <ids...> --folder <id>` (or `archive` / `group:<id>`)"], values["json"] === true);
}
async function emailFolderManage(args, ctx) {
    const sub = args[0];
    const commandPath = `espocrm-axi email folder ${sub ?? ""}`.trim();
    if (sub === "create") {
        const { values } = parseFlags(args.slice(1), commandPath, FOLDER_CREATE_FLAGS);
        requireAuth(ctx, commandPath);
        const name = requireString(values, "name", commandPath);
        if (!name)
            throw new AxiError("--name is required", "VALIDATION_ERROR");
        requireConfirm(values, commandPath, `create email folder "${name}"`);
        const record = asRecord(await ctx.client.request("POST", "EmailFolder", { body: { name } }));
        return renderResult({ created: { id: asString(record?.["id"]), name } }, false);
    }
    if (sub === "delete") {
        const { values, positionals } = parseFlags(args.slice(1), commandPath, CONFIRM_FLAGS);
        const id = validId(requirePositional(positionals, 0, "id", commandPath));
        requireAuth(ctx, commandPath);
        requireConfirm(values, commandPath, `delete email folder ${id} (mail inside returns to the inbox)`);
        await ctx.client.request("DELETE", `EmailFolder/${encodeURIComponent(id)}`);
        return renderResult({ deleted: { id } }, false);
    }
    return "espocrm-axi email folder - personal folders\n\n  email folder create --name <name> --confirm\n  email folder delete <id> --confirm";
}
async function emailCount(args, ctx) {
    const commandPath = "espocrm-axi email count";
    const { values } = parseFlags(args, commandPath, IDS_FLAGS);
    requireAuth(ctx, commandPath);
    const counts = asRecord(await ctx.client.request("GET", "Email/inbox/notReadCounts")) ?? {};
    return renderResult({ unread: counts, help: ["Run `espocrm-axi email inbox --unread` to list them"] }, values["json"] === true);
}
async function loadFolders(ctx) {
    const [group, personal] = await Promise.all([
        ctx.client.list("GroupEmailFolder", { maxSize: 200, select: ["id", "name"], orderBy: "order", order: "asc" }),
        ctx.client.list("EmailFolder", { maxSize: 200, select: ["id", "name"], orderBy: "order", order: "asc" }),
    ]);
    const pack = (rows) => rows.map((r) => ({ id: asString(r["id"]) ?? "", name: asString(r["name"]) ?? "" })).filter((r) => r.id);
    return { group: pack(group.list), personal: pack(personal.list) };
}
/** Resolve a folder by id or name (case-insensitive) into the `inFolder` value the API expects. */
export async function resolveFolder(ctx, selector, commandPath) {
    if (selector.startsWith("group:"))
        return { value: selector, label: `group folder ${selector.slice(6) || "(all)"}`, kind: "group" };
    const folders = await loadFolders(ctx);
    const needle = selector.toLowerCase();
    const match = (rows) => rows.find((f) => f.id === selector || f.name.toLowerCase() === needle);
    const group = match(folders.group);
    if (group)
        return { value: `group:${group.id}`, label: group.name, kind: "group" };
    const personal = match(folders.personal);
    if (personal)
        return { value: personal.id, label: personal.name, kind: "personal" };
    const available = [...folders.group.map((f) => `${f.name} (group:${f.id})`), ...folders.personal.map((f) => `${f.name} (${f.id})`)];
    throw new AxiError(`${commandPath}: no folder named "${selector}"`, "NOT_FOUND", [
        available.length ? `Available: ${available.join(", ")}` : "No folders exist yet (only the built-in inbox/archive/trash)",
    ]);
}
async function emailFolderBySelector(args, ctx) {
    const commandPath = "espocrm-axi email folder";
    const selector = args[0];
    if (!selector || selector.startsWith("-"))
        return "espocrm-axi email folder - list a personal or group (team) folder\n\n  email folder <name|id> [list flags]     e.g. email folder Collabs --unread\n  email folder create --name <name> --confirm\n  email folder delete <id> --confirm\n\nGroup folders also accept group:<id>; `espocrm-axi email folders` lists them with unread counts.";
    requireAuth(ctx, commandPath);
    const target = await resolveFolder(ctx, selector, commandPath);
    return emailFolder(target.value, args.slice(1), ctx, target.label);
}
const EMAIL_RE = /^[^\s<>@,;]+@[^\s@<>]+\.[^\s@<>]+$/;
export function normalizeAddress(raw) {
    const angled = /<([^<>]+)>/.exec(raw);
    const address = (angled?.[1] ?? raw).trim().toLowerCase();
    if (!EMAIL_RE.test(address))
        throw new AxiError(`invalid email address: ${raw.trim()}`, "VALIDATION_ERROR");
    return address;
}
export function splitAddresses(value) {
    return splitCsv(value).flatMap((part) => part.split(/[;]/)).map((part) => part.trim()).filter(Boolean).map(normalizeAddress);
}
function readFlagFile(path, commandPath) {
    try {
        return readFileSync(path, "utf8");
    }
    catch (error) {
        throw new AxiError(`${commandPath}: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`, "VALIDATION_ERROR");
    }
}
function buildCompose(values, commandPath, opts) {
    const to = splitAddresses(values["to"]);
    const cc = splitAddresses(values["cc"]);
    const bcc = splitAddresses(values["bcc"]);
    const subject = requireString(values, "subject", commandPath);
    const text = requireString(values, "text", commandPath);
    const textFile = requireString(values, "text-file", commandPath);
    const html = requireString(values, "html", commandPath);
    const htmlFile = requireString(values, "html-file", commandPath);
    if (opts.requireTo && to.length === 0)
        throw new AxiError("--to is required", "VALIDATION_ERROR");
    if (opts.requireSubject && !subject)
        throw new AxiError("--subject is required", "VALIDATION_ERROR");
    const sources = [text, textFile, html, htmlFile].filter((v) => v !== undefined);
    if (sources.length > 1)
        throw new AxiError("use exactly one content source: --text, --text-file, --html, or --html-file", "VALIDATION_ERROR");
    if (opts.requireContent && sources.length === 0)
        throw new AxiError("provide content with --text, --text-file, --html, or --html-file", "VALIDATION_ERROR");
    const parentType = requireString(values, "parent-type", commandPath);
    const parentId = requireString(values, "parent-id", commandPath);
    if ((parentType && !parentId) || (!parentType && parentId))
        throw new AxiError("--parent-type and --parent-id go together", "VALIDATION_ERROR");
    return {
        to, cc, bcc, subject,
        html: htmlFile ? readFlagFile(htmlFile, commandPath) : html,
        text: textFile ? readFlagFile(textFile, commandPath) : text,
        from: requireString(values, "from", commandPath),
        parentType, parentId,
        teamsIds: splitCsv(values["teams"]),
        attachPaths: stringList(values, "attach") ?? [],
        attachIds: splitCsv(values["attach-id"]),
        signatureFile: requireString(values, "signature-file", commandPath),
        wait: optionalInt(values, "wait", { min: 0, max: 600 }) ?? DEFAULT_WAIT_SECONDS,
        json: values["json"] === true,
    };
}
async function resolveFrom(ctx, from) {
    if (from)
        return normalizeAddress(from);
    const me = asRecord(await ctx.client.request("GET", "App/user"));
    const address = asString(asRecord(me?.["user"])?.["emailAddress"]);
    if (!address) {
        throw new AxiError("no --from given and the authenticated user has no email address", "VALIDATION_ERROR", [
            "Pass --from <address you can send as>; API users must use the system outbound address or a shared account address",
        ]);
    }
    return address.toLowerCase();
}
function escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
}
/** Build the Email record body fields (body, bodyPlain, isHtml) with optional signature. */
export function buildBody(compose, commandPath) {
    let signature = "";
    if (compose.signatureFile)
        signature = readFlagFile(compose.signatureFile, commandPath).trim();
    if (compose.html !== undefined) {
        return { body: signature ? `${compose.html}<br><br>${signature}` : compose.html, isHtml: true };
    }
    const text = compose.text ?? "";
    if (signature && /<[a-z][\s\S]*>/i.test(signature)) {
        return { body: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222">${escapeHtml(text)}</div><br><br>${signature}`, bodyPlain: `${text}\n\n--\n${htmlToText(signature)}`, isHtml: true };
    }
    const plain = signature ? `${text}\n\n--\n${signature}` : text;
    return { body: plain, bodyPlain: plain, isHtml: false };
}
async function emailSend(args, ctx, status) {
    const commandPath = "espocrm-axi email send";
    const { values } = parseFlags(args, commandPath, CONTENT_FLAGS);
    requireAuth(ctx, commandPath);
    const compose = buildCompose(values, commandPath, { requireTo: true, requireSubject: true, requireContent: true });
    if (values["dry-run"] !== true)
        requireConfirm(values, commandPath, `send "${compose.subject}" to ${compose.to.join(", ")}${compose.cc.length ? ` (cc ${compose.cc.join(", ")})` : ""}`);
    return deliver(ctx, compose, { status, values, commandPath });
}
async function emailDraft(args, ctx) {
    const commandPath = "espocrm-axi email draft";
    const { values } = parseFlags(args, commandPath, CONTENT_FLAGS);
    requireAuth(ctx, commandPath);
    const compose = buildCompose(values, commandPath, { requireTo: false, requireSubject: false, requireContent: true });
    if (values["dry-run"] !== true)
        requireConfirm(values, commandPath, `create a draft${compose.subject ? ` "${compose.subject}"` : ""}${compose.to.length ? ` to ${compose.to.join(", ")}` : ""}`);
    return deliver(ctx, compose, { status: "Draft", values, commandPath });
}
/** Create the Email record (uploading attachments first) and verify transmission when sending. */
async function deliver(ctx, compose, opts) {
    const from = await resolveFrom(ctx, compose.from);
    const attachments = [...compose.attachIds];
    const dryRun = opts.values["dry-run"] === true;
    for (const path of compose.attachPaths) {
        const file = readUploadFile(path, opts.commandPath);
        if (dryRun) {
            attachments.push(`(would upload ${file.name}, ${file.bytes.length} bytes)`);
            continue;
        }
        const uploaded = await uploadAttachment(ctx, file, { field: "attachments", relatedType: "Email" });
        attachments.push(uploaded.id);
    }
    const body = buildBody(compose, opts.commandPath);
    const payload = compact({
        status: opts.status,
        from,
        to: compose.to.length ? compose.to.join(", ") : undefined,
        cc: compose.cc.length ? compose.cc.join(", ") : undefined,
        bcc: compose.bcc.length ? compose.bcc.join(", ") : undefined,
        name: opts.subject ?? compose.subject,
        ...body,
        parentType: compose.parentType,
        parentId: compose.parentId,
        teamsIds: compose.teamsIds.length ? compose.teamsIds : undefined,
        attachmentsIds: attachments.length ? attachments : undefined,
        repliedId: opts.repliedId,
    });
    if (dryRun) {
        return withHelp({ dry_run: compact({ would: opts.status === "Sending" ? "send" : "create draft", ...payload, attachments: compose.attachPaths.length || undefined, signature: compose.signatureFile ?? undefined }) }, [
            "Nothing was sent or uploaded; rerun without --dry-run and with --confirm to apply",
        ], opts.values["json"] === true);
    }
    const record = asRecord(await ctx.client.request("POST", "Email", { body: payload, timeoutMs: 120_000 }));
    const id = asString(record?.["id"]);
    if (!id)
        throw new AxiError("Email create returned no id", "API_ERROR");
    let final = record ?? {};
    let waited = 0;
    if (opts.status === "Sending" && !(final["status"] === "Sent" && final["dateSent"])) {
        while (waited < compose.wait) {
            const slept = Math.min(POLL_INTERVAL_MS / 1000, compose.wait - waited);
            await sleep(slept * 1000);
            waited += slept;
            final = asRecord(await ctx.client.request("GET", `Email/${encodeURIComponent(id)}`)) ?? final;
            if (final["status"] === "Sent" && final["dateSent"])
                break;
        }
    }
    const delivered = opts.status === "Sending" && final["status"] === "Sent" && Boolean(final["dateSent"]);
    const summary = compact({
        id,
        from,
        to: compose.to.join(", "),
        cc: compose.cc.join(", ") || undefined,
        subject: asString(payload["name"]),
        status: asString(final["status"]),
        dateSent: asString(final["dateSent"]),
        attachments: attachments.length || undefined,
        thread: opts.repliedId ? `${opts.repliedId} -> ${id}` : undefined,
        ...(opts.status === "Sending" ? { delivered, waited_seconds: waited } : {}),
    });
    const help = [];
    if (opts.status === "Sending" && !delivered) {
        help.push(final["status"] === "Draft" ? "NOT sent: EspoCRM reset the record to Draft (SMTP failure). Check the sending account and retry: `espocrm-axi email send <id> --confirm`" : `NOT confirmed within ${compose.wait}s (status ${String(final["status"])}); older instances send via cron - recheck with \`espocrm-axi email get ${id}\` or raise --wait`);
    }
    else if (opts.status === "Sending") {
        help.push(`Run \`espocrm-axi email thread ${id}\` later to see replies`);
    }
    else {
        help.push(`Send it: \`espocrm-axi email send ${id} --confirm\`, or schedule: \`email schedule ${id} --at "YYYY-MM-DD HH:mm" --confirm\``);
    }
    if (opts.repliedId)
        help.push("Original marked as replied (In-Reply-To/References headers set)");
    if (compose.json)
        return JSON.stringify({ ...summary, record: final }, null, 2);
    return withHelp({ [opts.status === "Sending" ? "sent" : "draft"]: summary }, help, false);
}
async function emailSendExisting(args, ctx) {
    const commandPath = "espocrm-axi email send";
    const { values, positionals } = parseFlags(args, commandPath, SEND_DRAFT_FLAGS);
    const id = validId(requirePositional(positionals, 0, "draftId", commandPath));
    forbidExtraPositionals(positionals, 1, commandPath);
    requireAuth(ctx, commandPath);
    const wait = optionalInt(values, "wait", { min: 0, max: 600 }) ?? DEFAULT_WAIT_SECONDS;
    requireConfirm(values, commandPath, `queue email ${id} for sending now`);
    let final = asRecord(await ctx.client.request("PUT", `Email/${encodeURIComponent(id)}`, { body: { status: "Sending" }, timeoutMs: 120_000 }));
    let waited = 0;
    while (waited < wait && !(final?.["status"] === "Sent" && final["dateSent"])) {
        const slept = Math.min(POLL_INTERVAL_MS / 1000, wait - waited);
        await sleep(slept * 1000);
        waited += slept;
        final = asRecord(await ctx.client.request("GET", `Email/${encodeURIComponent(id)}`)) ?? final;
    }
    const delivered = final?.["status"] === "Sent" && Boolean(final?.["dateSent"]);
    const out = {
        sent: compact({ id, status: asString(final?.["status"]), to: asString(final?.["to"]), subject: asString(final?.["name"]), dateSent: asString(final?.["dateSent"]), delivered, waited_seconds: waited }),
    };
    return withHelp(out, [delivered ? `Run \`espocrm-axi email thread ${id}\` later to see replies` : `NOT confirmed sent (status ${String(final?.["status"])}); recheck with \`espocrm-axi email get ${id}\``], values["json"] === true);
}
async function emailReply(args, ctx) {
    const commandPath = "espocrm-axi email reply";
    const { values, positionals } = parseFlags(args, commandPath, CONTENT_FLAGS);
    const id = validId(requirePositional(positionals, 0, "emailId", commandPath));
    forbidExtraPositionals(positionals, 1, commandPath);
    requireAuth(ctx, commandPath);
    if (values["dry-run"] !== true)
        requireConfirm(values, commandPath, `send a reply to email ${id}`);
    const original = (await fetchRecords(ctx, "Email", { maxSize: 1, select: [...EMAIL_SELECT, "replyToAddress", "replyToString", "fromAddress", "cc"], where: [{ type: "equals", attribute: "id", value: id }] })).rows[0];
    if (!original)
        throw new AxiError(`Email ${id} not found`, "NOT_FOUND");
    const subject = requireString(values, "subject", commandPath) ?? replySubject(asString(original["name"]));
    const valuesWithTo = { ...values, to: values["to"] ?? asString(original["replyToAddress"]) ?? asString(original["fromAddress"]) ?? asString(original["fromEmailAddressName"]) };
    if (values["from"] === undefined && asString(original["groupFolderId"])) {
        const groupFrom = await groupMailboxAddress(ctx, asString(original["groupFolderId"]));
        if (groupFrom)
            valuesWithTo.from = groupFrom;
    }
    if (typeof valuesWithTo.to !== "string")
        throw new AxiError("could not determine the reply address; pass --to", "VALIDATION_ERROR");
    if (values["all"] === true && values["cc"] === undefined) {
        const ccNames = Object.values(asRecord(original["ccEmailAddressesNames"]) ?? {}).map(String);
        valuesWithTo.cc = ccNames.length ? ccNames.join(",") : original["cc"];
    }
    const compose = buildCompose(valuesWithTo, commandPath, { requireTo: true, requireSubject: false, requireContent: true });
    compose.parentType = compose.parentType ?? asString(original["parentType"]);
    compose.parentId = compose.parentId ?? asString(original["parentId"]);
    return deliver(ctx, compose, { status: "Sending", values, commandPath, repliedId: id, subject });
}
/** Email address of the group mailbox (InboundEmail) feeding a group folder. */
export async function groupMailboxAddress(ctx, groupFolderId) {
    try {
        const result = await ctx.client.list("InboundEmail", { maxSize: 1, select: ["id", "emailAddress"], where: [{ type: "equals", attribute: "groupEmailFolderId", value: groupFolderId }] });
        return asString(result.list[0]?.["emailAddress"]);
    }
    catch (error) {
        if (error instanceof AxiError && error.code === "AUTH_REQUIRED")
            return undefined;
        throw error;
    }
}
export function replySubject(subject) {
    const base = subject?.trim() || "(no subject)";
    return /^(re|aw|sv):\s*/i.test(base) ? base : `Re: ${base}`;
}
async function emailSchedule(args, ctx) {
    const commandPath = "espocrm-axi email schedule";
    const { values, positionals } = parseFlags(args, commandPath, SCHEDULE_FLAGS);
    const id = validId(requirePositional(positionals, 0, "draftId", commandPath));
    forbidExtraPositionals(positionals, 1, commandPath);
    requireAuth(ctx, commandPath);
    const at = requireString(values, "at", commandPath);
    if (!at)
        throw new AxiError("--at is required", "VALIDATION_ERROR");
    let sendAt;
    try {
        sendAt = toEspoDateTime(at);
    }
    catch (error) {
        throw new AxiError(error instanceof Error ? error.message : String(error), "VALIDATION_ERROR");
    }
    requireConfirm(values, commandPath, `schedule email ${id} to send at ${sendAt} UTC`);
    const record = asRecord(await ctx.client.request("PUT", `Email/${encodeURIComponent(id)}`, { body: { status: "Draft", sendAt } }));
    return withHelp({ scheduled: compact({ id, sendAt: asString(record?.["sendAt"]) ?? sendAt, status: asString(record?.["status"]) }) }, [
        "The 'Send Scheduled Emails' cron job transmits it; cancel with `espocrm-axi email schedule <id> --at ...` or delete the draft",
    ], values["json"] === true);
}
// ---------- mailbox state ----------
function collectIds(positionals, values, commandPath) {
    const ids = positionals.map(validId);
    if (ids.length === 0 && values["all"] !== true) {
        throw new AxiError(`${commandPath} needs email ids (or --all for read)`, "VALIDATION_ERROR");
    }
    return ids;
}
async function mailboxState(sub, args, ctx, kind) {
    const on = sub === "read" || sub === "important" || sub === "trash";
    const commandPath = `espocrm-axi email ${sub}`;
    const { values, positionals } = parseFlags(args, commandPath, IDS_FLAGS);
    forbidExtraPositionals(positionals, 1_000, commandPath);
    requireAuth(ctx, commandPath);
    const ids = collectIds(positionals, values, commandPath);
    const body = values["all"] === true && kind === "read" && ids.length === 0 ? { all: true } : { ids };
    await ctx.client.request(on ? "POST" : "DELETE", `Email/inbox/${kind}`, { body });
    return withHelp({ [sub]: { count: ids.length || "all", ...(ids.length ? { ids } : {}) } }, ["Run `espocrm-axi email inbox` to verify"], values["json"] === true);
}
async function moveToFolder(args, ctx, folderId, verb) {
    const commandPath = `espocrm-axi email ${verb}`;
    const { values, positionals } = parseFlags(args, commandPath, IDS_FLAGS);
    forbidExtraPositionals(positionals, 1_000, commandPath);
    requireAuth(ctx, commandPath);
    const ids = collectIds(positionals, values, commandPath);
    await ctx.client.request("POST", `Email/inbox/folders/${encodeURIComponent(folderId)}`, { body: { ids } });
    return withHelp({ [verb]: { count: ids.length, ids } }, [`Run \`espocrm-axi email ${folderId === "archive" ? "archive" : "inbox"}\` to verify`], values["json"] === true);
}
async function emailMove(args, ctx) {
    const commandPath = "espocrm-axi email move";
    const { values, positionals } = parseFlags(args, commandPath, MOVE_FLAGS);
    forbidExtraPositionals(positionals, 1_000, commandPath);
    requireAuth(ctx, commandPath);
    const folder = requireString(values, "folder", commandPath);
    if (!folder)
        throw new AxiError("--folder is required (an EmailFolder id, group:<id>, inbox, or archive)", "VALIDATION_ERROR");
    const ids = collectIds(positionals, values, commandPath);
    await ctx.client.request("POST", `Email/inbox/folders/${encodeURIComponent(folder)}`, { body: { ids } });
    return withHelp({ moved: { count: ids.length, ids, folder } }, ["Run `espocrm-axi email folders` for folder ids"], values["json"] === true);
}
// ---------- accounts & templates ----------
async function recordListRedacted(args, ctx, type, label) {
    const commandPath = `espocrm-axi email ${type === "EmailAccount" ? "accounts" : type === "InboundEmail" ? "inbound" : "templates"}`;
    const { values } = parseFlags(args, commandPath, LIST_FLAGS);
    requireAuth(ctx, commandPath);
    const parsed = parseListFlags(values, { dateField: "createdAt", orderBy: "name", order: "asc" }, commandPath);
    const outcome = await fetchRecords(ctx, type, parsed.params);
    const out = { count: outcome.rows.length, [type === "EmailTemplate" ? "templates" : "accounts"]: outcome.rows.map((row) => displayRecord(redactSecrets(parsed.full ? row : compact({ id: row["id"], name: row["name"], emailAddress: row["emailAddress"], status: row["status"], subject: row["subject"], type: row["type"], isActive: row["isActive"] })), 200, parsed.full)) };
    if (outcome.rows.length === 0)
        out["result"] = `0 ${label}`;
    return withHelp(out, [`Run \`espocrm-axi record get ${type} <id> --json\` for everything (passwords are never returned in clear text)`], parsed.json);
}
async function emailAccountAction(args, ctx) {
    if (args[0] === "reset-fetch")
        return resetFetch(args.slice(1), ctx, "EmailAccount");
    return recordListRedacted(args, ctx, "EmailAccount", "email accounts");
}
async function resetFetch(args, ctx, type) {
    const commandPath = `espocrm-axi email ${type === "EmailAccount" ? "account" : "inbound"} reset-fetch`;
    const { values, positionals } = parseFlags(args, commandPath, CONFIRM_FLAGS);
    const id = validId(requirePositional(positionals, 0, "id", commandPath));
    forbidExtraPositionals(positionals, 1, commandPath);
    requireAuth(ctx, commandPath);
    requireConfirm(values, commandPath, `reset the IMAP fetch state of ${type} ${id} (all messages will be re-fetched)`);
    await ctx.client.request("POST", `${type}/${encodeURIComponent(id)}/resetFetchData`);
    return renderResult({ reset: { type, id } }, false);
}
async function emailTemplate(args, ctx) {
    const sub = args[0];
    if (sub === "prepare") {
        const commandPath = "espocrm-axi email template prepare";
        const { values, positionals } = parseFlags(args.slice(1), commandPath, PREPARE_FLAGS);
        const id = validId(requirePositional(positionals, 0, "templateId", commandPath));
        forbidExtraPositionals(positionals, 1, commandPath);
        requireAuth(ctx, commandPath);
        const result = asRecord(await ctx.client.request("POST", `EmailTemplate/${encodeURIComponent(id)}/prepare`, {
            body: compact({ parentType: requireString(values, "parent-type", commandPath), parentId: requireString(values, "parent-id", commandPath), relatedType: requireString(values, "related-type", commandPath), relatedId: requireString(values, "related-id", commandPath), emailAddress: requireString(values, "email", commandPath) }),
        }));
        if (values["json"] === true || !result)
            return JSON.stringify(result ?? {}, null, 2);
        return withHelp({ template: id, subject: asString(result["subject"]), isHtml: result["isHtml"], body: snippet(asString(result["body"]) ?? htmlToText(String(result["body"] ?? "")), 1500) }, ["Use it: pass the rendered text to `email send --text`/`--html`"], false);
    }
    if (sub === "get") {
        const commandPath = "espocrm-axi email template get";
        const { values, positionals } = parseFlags(args.slice(1), commandPath, GET_FLAGS);
        const id = validId(requirePositional(positionals, 0, "templateId", commandPath));
        requireAuth(ctx, commandPath);
        const record = asRecord(await ctx.client.request("GET", `EmailTemplate/${encodeURIComponent(id)}`));
        if (values["json"] === true)
            return JSON.stringify(record, null, 2);
        return withHelp({ template: displayRecord(redactSecrets(record ?? {}), values["full"] === true ? 1_000_000 : 1500, values["full"] === true) }, ["Render for a record: `email template prepare <id> --parent-type <T> --parent-id <id>`"], false);
    }
    return recordListRedacted(args, ctx, "EmailTemplate", "email templates");
}
async function emailAddressSearch(args, ctx) {
    const commandPath = "espocrm-axi email address-search";
    const { values } = parseFlags(args, commandPath, ADDRESS_SEARCH_FLAGS);
    requireAuth(ctx, commandPath);
    const q = requireString(values, "q", commandPath);
    if (!q)
        throw new AxiError("--q is required", "VALIDATION_ERROR");
    const result = await ctx.client.request("GET", "EmailAddress/search", { query: { q, entityType: requireString(values, "type", commandPath), maxSize: optionalInt(values, "limit", { min: 1, max: 50 }) ?? 10 } });
    const rows = asRecordArray(result);
    const out = { count: rows.length, matches: rows.map((r) => compact({ emailAddress: asString(r["emailAddress"]), entityType: asString(r["entityType"]), entityId: asString(r["entityId"]), name: asString(r["entityName"]) })) };
    if (rows.length === 0)
        out["result"] = `0 records with an address matching "${q}"${requireString(values, "type", commandPath) ? "" : " (unscoped search only covers the address book; retry with --type Lead|Contact|Account...)"}`;
    return withHelp(out, ["Run `espocrm-axi record get <entityType> <entityId>`"], values["json"] === true);
}
async function emailImportEml(args, ctx) {
    const commandPath = "espocrm-axi email import-eml";
    const { values } = parseFlags(args, commandPath, IMPORT_FLAGS);
    requireAuth(ctx, commandPath);
    const file = requireString(values, "file", commandPath);
    if (!file)
        throw new AxiError("--file <path.eml> is required", "VALIDATION_ERROR");
    const uploaded = await uploadAttachment(ctx, readUploadFile(file, commandPath), { field: "attachments" });
    const result = asRecord(await ctx.client.request("POST", "Email/importEml", { body: { fileId: uploaded.id } }));
    const id = asString(result?.["id"]);
    return withHelp(compact({ imported: compact({ id, file: uploaded.name }) }), id ? [`Run \`espocrm-axi email get ${id}\` to view it`] : [], values["json"] === true);
}
async function emailSendTest(args, ctx) {
    const commandPath = "espocrm-axi email send-test";
    const { values } = parseFlags(args, commandPath, SEND_TEST_FLAGS);
    requireAuth(ctx, commandPath);
    const server = requireString(values, "server", commandPath);
    const port = optionalInt(values, "port", { min: 1, max: 65535 });
    const emailAddress = requireString(values, "email-address", commandPath);
    const to = requireString(values, "to", commandPath);
    if (!server || !port || !emailAddress || !to)
        throw new AxiError("--server, --port, --email-address and --to are required", "VALIDATION_ERROR");
    requireConfirm(values, commandPath, `send a test email from ${emailAddress} to ${normalizeAddress(to)} via ${server}:${port}`);
    const security = requireString(values, "security", commandPath);
    const auth = values["auth"] === true || (typeof values["auth"] === "string" && values["auth"] !== "false");
    const body = compact({
        type: ctx.config.authMode === "basic" ? "personal" : "system",
        server, port, emailAddress,
        security: security && security !== "none" ? security : undefined,
        auth: auth || undefined,
        username: requireString(values, "username", commandPath),
        password: requireString(values, "password", commandPath),
        "from-name": requireString(values, "from-name", commandPath),
    });
    const result = await ctx.client.request("POST", "Email/sendTest", { body, timeoutMs: 60_000 });
    return renderResult({ sent_test: { server, port, emailAddress, to: normalizeAddress(to), ok: result !== false } }, values["json"] === true);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
