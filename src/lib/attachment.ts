import { statSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { AxiError } from "axi-sdk-js";
import type { CommandContext } from "../context.js";
import { asRecord, asString } from "./coerce.js";

/**
 * Attachment upload (POST /Attachment with a base64 data URL). Attachments are
 * created detached and then referenced by id from the parent record's
 * attachment-multiple field (e.g. Email.attachmentsIds).
 */

const MIME: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", csv: "text/csv", html: "text/html", htm: "text/html",
  json: "application/json", xml: "application/xml", pdf: "application/pdf", zip: "application/zip",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  eml: "message/rfc822", ics: "text/calendar", mp3: "audio/mpeg", mp4: "video/mp4", wav: "audio/wav",
};

export function mimeOf(path: string): string {
  return MIME[extname(path).slice(1).toLowerCase()] ?? "application/octet-stream";
}

export interface UploadedAttachment {
  id: string;
  name: string;
  size: number;
  type: string;
}

export function readUploadFile(path: string, commandPath: string): { name: string; type: string; bytes: Buffer } {
  let bytes: Buffer;
  let size: number;
  try {
    bytes = readFileSync(path);
    size = statSync(path).size;
  } catch (error) {
    throw new AxiError(`${commandPath}: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`, "VALIDATION_ERROR");
  }
  if (size === 0) throw new AxiError(`${commandPath}: ${path} is empty`, "VALIDATION_ERROR");
  if (size > 50 * 1024 * 1024) {
    throw new AxiError(`${commandPath}: ${path} is ${(size / 1024 / 1024).toFixed(1)}MB; EspoCRM's upload limit (Administration > Attachments) is usually lower`, "VALIDATION_ERROR");
  }
  return { name: basename(path), type: mimeOf(path), bytes };
}

export async function uploadAttachment(
  ctx: CommandContext,
  file: { name: string; type: string; bytes: Buffer },
  target: { field: string; parentType?: string; relatedType?: string; relatedId?: string },
  timeoutMs?: number,
): Promise<UploadedAttachment> {
  const record = asRecord(await ctx.client.request("POST", "Attachment", {
    timeoutMs,
    body: {
      name: file.name,
      type: file.type,
      role: "Attachment",
      field: target.field,
      ...(target.parentType ? { parentType: target.parentType } : {}),
      ...(target.relatedType ? { relatedType: target.relatedType } : {}),
      ...(target.relatedId ? { relatedId: target.relatedId } : {}),
      file: `data:${file.type};base64,${file.bytes.toString("base64")}`,
    },
  }));
  const id = asString(record?.["id"]);
  if (!id) throw new AxiError("attachment upload returned no id", "API_ERROR");
  return { id, name: file.name, size: file.bytes.length, type: file.type };
}
