/**
 * EspoCRM stores every datetime in UTC using MySQL format
 * (`YYYY-MM-DD HH:mm:ss`). Accept several human/agent-friendly inputs and
 * always emit that canonical form; compare values after normalizing.
 */

const MYSQL = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const ISO_T = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MYSQL_NO_SECONDS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatEspoDateTime(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/**
 * Parse a datetime expression into EspoCRM UTC format. Supported:
 *   now | today | yesterday
 *   YYYY-MM-DD            (midnight UTC)
 *   YYYY-MM-DD HH:mm[:ss]
 *   ISO 8601 with T, optional zone (defaults to UTC)
 *   <N>m | <N>h | <N>d    relative: N minutes/hours/days ago
 * Throws Error on anything else.
 */
export function toEspoDateTime(input: string, now: Date = new Date()): string {
  const text = input.trim();
  if (text === "now") return formatEspoDateTime(now);
  if (text === "today" || text === "yesterday") {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (text === "yesterday") d.setUTCDate(d.getUTCDate() - 1);
    return formatEspoDateTime(d);
  }
  const relative = /^-(\d+)(m|h|d)$/.exec(text) ?? /^(\d+)(m|h|d)$/.exec(text);
  if (relative) {
    const n = Number(relative[1]);
    const unit = relative[2];
    const ms = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return formatEspoDateTime(new Date(now.getTime() - n * ms));
  }
  if (MYSQL.test(text)) return text;
  if (MYSQL_NO_SECONDS.test(text)) return `${text}:00`;
  if (DATE_ONLY.test(text)) return `${text} 00:00:00`;
  if (ISO_T.test(text)) {
    const iso = text.includes("Z") || /[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text}Z`;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) throw new Error(`unparseable datetime: ${input}`);
    return formatEspoDateTime(d);
  }
  throw new Error(`unparseable datetime: ${input}`);
}

/** Normalize an EspoCRM/ISO timestamp for lexical comparison (ISO-8601 UTC, seconds precision). */
export function normalizeEspoTime(value: string | undefined): string {
  if (!value) return "";
  let text = value.trim().replace(" ", "T");
  if (text.includes("+")) text = text.split("+")[0] ?? text;
  if (text.endsWith("Z")) text = text.slice(0, -1);
  if (ISO_T.test(text) && !text.includes(":00:00") && /^.*T\d{2}:\d{2}$/.test(text)) text = `${text}:00`;
  return text;
}

export function isAfter(value: string | undefined, thresholdEspo: string): boolean {
  const v = normalizeEspoTime(value);
  return v.length > 0 && v > normalizeEspoTime(thresholdEspo);
}

/** Plain-text fallback for an email body: strip tags, collapse whitespace, keep punctuation attached. */
export function htmlToText(html: string): string {
  const withoutTags = html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|table|blockquote)>/gi, "\n")
    .replace(/<\/(a|b|i|strong|em|span|u|small|sup|sub|font|code)>/gi, "")
    .replace(/<[^>]+>/g, " ");
  const decoded = withoutTags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return decoded
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
