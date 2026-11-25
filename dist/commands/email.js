import { AxiError } from "axi-sdk-js";
import { withHelp } from "../lib/output.js";
import { asRecord, asString, compact } from "../lib/coerce.js";
import { forbidExtraPositionals, parseFlags, requirePositional } from "../lib/args.js";
import { requireAuth } from "../lib/auth.js";
import { LIST_FLAGS, parseListFlags } from "../lib/params.js";
import { fetchRecords } from "../lib/records.js";
import { snippet } from "../lib/truncate.js";
import { htmlToText } from "../lib/time.js";
import { validId } from "../lib/records.js";
/**
 * Email - the slice under verification. Inbox lists use the per-user
 * `inFolder` filter; reading a single email marks it read (server hook).
 */
export const EMAIL_HELP = `espocrm-axi email - inbox and email records (more subcommands landing incrementally)

  email inbox [flags]       the authenticated user's inbox (basic auth only)
  email get <id> [--full]   one email; NOTE: reading marks it read for the user`;
const EMAIL_FOLDERS = ["inbox", "sent", "archive", "drafts", "important", "trash", "all"];
const FOLDER_FLAGS = { ...LIST_FLAGS, unread: { type: "boolean" } };
const GET_FLAGS = { full: { type: "boolean" }, html: { type: "boolean" }, json: { type: "boolean" } };
export async function emailCommand(args, ctx) {
    const sub = args[0];
    if (sub === undefined || sub === "--help" || sub === "help")
        return { help_text: EMAIL_HELP };
    if (sub === "get")
        return emailGet(args.slice(1), ctx);
    if (EMAIL_FOLDERS.includes(sub))
        return emailFolder(sub, args.slice(1), ctx);
    throw new AxiError(`unknown email subcommand: ${sub}`, "VALIDATION_ERROR", ["Run `espocrm-axi email --help`"]);
}
const EMAIL_SELECT = ["id", "name", "status", "fromEmailAddressName", "fromString", "toEmailAddressesNames", "dateSent", "createdAt", "isRead", "hasAttachment", "parentType", "parentId", "bodyPlain"];
function emailRow(row, show) {
    const toNames = asRecord(row["toEmailAddressesNames"]);
    return compact({
        id: asString(row["id"]),
        [show]: show === "from" ? asString(row["fromEmailAddressName"]) ?? snippet(asString(row["fromString"]) ?? undefined, 40) : Object.values(toNames ?? {}).map(String).join(", ") || undefined,
        subject: snippet(asString(row["name"]), 70),
        date: asString(row["dateSent"]) ?? asString(row["createdAt"]),
        isRead: row["isRead"] === false ? false : undefined,
        attachments: row["hasAttachment"] === true ? true : undefined,
        status: row["status"] === "Draft" ? "Draft" : undefined,
    });
}
async function emailFolder(folder, args, ctx) {
    const commandPath = `espocrm-axi email ${folder}`;
    const { values, positionals } = parseFlags(args, commandPath, FOLDER_FLAGS);
    forbidExtraPositionals(positionals, 0, commandPath);
    requireAuth(ctx, commandPath);
    const parsed = parseListFlags(values, { dateField: folder === "drafts" ? "createdAt" : "dateSent", orderBy: folder === "drafts" ? "createdAt" : "dateSent", order: "desc" }, commandPath);
    const extra = [{ type: "inFolder", attribute: "folderId", value: folder }];
    if (values["unread"] === true)
        extra.push({ type: "isFalse", attribute: "isRead" });
    const params = { ...parsed.params, select: parsed.params.select ?? EMAIL_SELECT };
    const outcome = await fetchRecords(ctx, "Email", params, extra);
    const show = folder === "sent" || folder === "drafts" ? "to" : "from";
    const rows = outcome.rows.map((r) => emailRow(r, show));
    const out = { folder, count: rows.length };
    if (outcome.total === -1)
        out["more"] = true;
    if (ctx.config.authMode !== "basic") {
        out["note"] = "per-user folders need a user token (ESPO_CRM_USERNAME); an API user has no inbox";
    }
    if (rows.length === 0)
        out["result"] = `0 emails in ${folder}`;
    else
        out["emails"] = rows;
    const help = [];
    const first = asString(outcome.rows[0]?.["id"]);
    if (first)
        help.push(`Run \`espocrm-axi email get ${first}\` to read it (marks as read)`);
    if (ctx.config.authMode === "basic" && folder === "inbox") {
        try {
            const counts = asRecord(await ctx.client.request("GET", "Email/inbox/notReadCounts"));
            out["unread_inbox"] = asRecord(counts)?.["inbox"] ?? 0;
        }
        catch {
            out["unread_inbox"] = "unknown";
        }
    }
    out["help"] = help;
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
    const html = values["html"] === true;
    const bodyHtml = asString(record["body"]) ?? "";
    const plain = asString(record["bodyPlain"]) ?? htmlToText(bodyHtml);
    const body = html ? bodyHtml : plain;
    const toNames = asRecord(record["toEmailAddressesNames"]);
    const ccNames = asRecord(record["ccEmailAddressesNames"]);
    const attNames = asRecord(record["attachmentsNames"]);
    const out = {
        email: compact({
            id,
            status: asString(record["status"]),
            from: asString(record["fromString"]) ?? asString(record["fromAddress"]),
            to: Object.values(toNames ?? {}).map(String).join(", ") || asString(record["to"]),
            cc: Object.values(ccNames ?? {}).map(String).join(", ") || undefined,
            reply_to: asString(record["replyToString"]),
            subject: asString(record["name"]),
            date: asString(record["dateSent"]) ?? asString(record["createdAt"]),
            parent: asString(record["parentType"]) ? `${asString(record["parentType"])}:${asString(record["parentId"])}` : undefined,
            isRead: record["isRead"],
            attachments: Object.values(attNames ?? {}).map(String).join(", ") || undefined,
        }),
        body: full ? body : snippet(body, 1500) ?? "",
    };
    return withHelp(out, [
        "Reading this email marked it as read for the authenticated user",
        full ? "Use --html to print the raw HTML body instead of plain text" : "Rerun with --full for the complete body, or --html for raw HTML",
    ], false);
}
