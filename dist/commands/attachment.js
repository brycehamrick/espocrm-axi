import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AxiError } from "axi-sdk-js";
import { displayRecord, renderResult, withHelp } from "../lib/output.js";
import { asRecord, compact } from "../lib/coerce.js";
import { forbidExtraPositionals, oneOf, parseFlags, requireConfirm, requirePositional, requireString } from "../lib/args.js";
import { requireAuth } from "../lib/auth.js";
import { validId } from "../lib/records.js";
import { readUploadFile, uploadAttachment } from "../lib/attachment.js";
/**
 * Attachments are uploaded as detached records and then referenced by a
 * parent record (Email.attachmentsIds, Document.fileId, Note.attachmentsIds).
 */
export const ATTACHMENT_HELP = `espocrm-axi attachment - upload, download, and inspect files

  attachment upload --file <path> [--field attachments] [--parent-type Note --parent-id <id> | --related-type Email --related-id <id>] [--role Attachment]
                         prints the new attachment id (use it as attachmentsIds / fileId on the parent)
  attachment download <id> [--out <path or dir>]     saves the file (default: server filename in cwd; prints the path)
  attachment get <id> [--json]                        attachment record
  attachment list [list flags]                        Attachment records (shortcut for record list Attachment)
  attachment delete <id> --confirm

examples:
  espocrm-axi attachment upload --file report.pdf
  espocrm-axi attachment upload --file logo.png --field file --related-type Document
  espocrm-axi attachment download 6b0... --out ~/Downloads/`;
const UPLOAD_FLAGS = {
    file: { type: "string" }, field: { type: "string" }, "parent-type": { type: "string" }, "parent-id": { type: "string" }, "related-type": { type: "string" }, "related-id": { type: "string" }, role: { type: "string" }, json: { type: "boolean" },
};
const DOWNLOAD_FLAGS = { out: { type: "string" } };
const GET_FLAGS = { full: { type: "boolean" }, json: { type: "boolean" } };
const DELETE_FLAGS = { confirm: { type: "boolean" } };
const ROLES = ["Attachment", "Attachment File", "Export File", "Import File", "Mail Merge", "Template File"];
export async function attachmentCommand(args, ctx) {
    const sub = args[0];
    const rest = args.slice(1);
    if (sub === undefined || sub === "--help" || sub === "help")
        return ATTACHMENT_HELP;
    const commandPath = `espocrm-axi attachment ${sub}`;
    requireAuth(ctx, commandPath);
    if (sub === "upload") {
        const { values } = parseFlags(rest, commandPath, UPLOAD_FLAGS);
        const file = requireString(values, "file", commandPath);
        if (!file)
            throw new AxiError("--file <path> is required", "VALIDATION_ERROR");
        const parentType = requireString(values, "parent-type", commandPath);
        const parentId = requireString(values, "parent-id", commandPath);
        const relatedType = requireString(values, "related-type", commandPath);
        const relatedId = requireString(values, "related-id", commandPath);
        if ((parentType && !parentId) || (!parentType && parentId) || (relatedType && !relatedId) || (!relatedType && relatedId)) {
            throw new AxiError("--parent-type/--parent-id and --related-type/--related-id go together", "VALIDATION_ERROR");
        }
        const uploaded = await uploadAttachment(ctx, readUploadFile(file, commandPath), {
            field: requireString(values, "field", commandPath) ?? "attachments",
            role: oneOf(values, "role", ROLES) ?? "Attachment",
            parentType, parentId, relatedType, relatedId,
        }, 120_000);
        return withHelp({ uploaded }, [
            "Reference it from a parent record: `record update <Type> <id> --set attachmentsIds=[\"" + uploaded.id + "\"] --confirm` (attachmentsIds replaces the list; include existing ids)",
        ], values["json"] === true);
    }
    if (sub === "download") {
        const { values, positionals } = parseFlags(rest, commandPath, DOWNLOAD_FLAGS);
        const id = validId(requirePositional(positionals, 0, "id", commandPath));
        forbidExtraPositionals(positionals, 1, commandPath);
        const file = await ctx.client.download(`Attachment/file/${encodeURIComponent(id)}`);
        const out = requireString(values, "out", commandPath);
        let target;
        if (out) {
            const { statSync } = await import("node:fs");
            const isDir = (() => { try {
                return statSync(out).isDirectory();
            }
            catch {
                return false;
            } })();
            target = isDir ? resolve(out, file.filename ?? id) : resolve(out);
        }
        else {
            target = resolve(file.filename ?? `${id}.bin`);
        }
        writeFileSync(target, file.bytes);
        return withHelp({ downloaded: compact({ id, path: target, bytes: file.bytes.length, type: file.contentType, filename: file.filename }) }, [], false);
    }
    if (sub === "get") {
        const { values, positionals } = parseFlags(rest, commandPath, GET_FLAGS);
        const id = validId(requirePositional(positionals, 0, "id", commandPath));
        forbidExtraPositionals(positionals, 1, commandPath);
        const record = asRecord(await ctx.client.request("GET", `Attachment/${encodeURIComponent(id)}`));
        if (!record)
            throw new AxiError(`Attachment ${id} not found`, "NOT_FOUND");
        if (values["json"] === true)
            return JSON.stringify(record, null, 2);
        return withHelp({ attachment: displayRecord(record, 400, values["full"] === true) }, ["Run `espocrm-axi attachment download " + id + " --out <path>`"], false);
    }
    if (sub === "delete") {
        const { values, positionals } = parseFlags(rest, commandPath, DELETE_FLAGS);
        const id = validId(requirePositional(positionals, 0, "id", commandPath));
        forbidExtraPositionals(positionals, 1, commandPath);
        requireConfirm(values, commandPath, `delete attachment ${id}`);
        await ctx.client.request("DELETE", `Attachment/${encodeURIComponent(id)}`);
        return renderResult({ deleted: { id } }, false);
    }
    if (sub === "list") {
        const { recordCommand } = await import("./record.js");
        return recordCommand(["list", "Attachment", ...rest], ctx);
    }
    throw new AxiError(`unknown attachment subcommand: ${sub}`, "VALIDATION_ERROR", ["Run `espocrm-axi attachment --help`"]);
}
