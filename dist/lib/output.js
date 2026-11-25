/**
 * Output helpers shared by commands: the --json escape hatch and definitive
 * empty states (AXI principles 1 and 5).
 */
import { compact } from "./coerce.js";
export function renderResult(output, json) {
    if (json)
        return JSON.stringify(output, null, 2);
    return compact(output);
}
export function withHelp(output, help, json) {
    if (help.length > 0)
        output["help"] = help;
    return renderResult(output, json);
}
/** Convert a raw payload for display: drop empty containers, stringify nested values. */
export function displayRecord(record, limit, full) {
    const out = {};
    for (const [key, value] of Object.entries(record)) {
        const shown = display(key, value, limit, full);
        if (shown !== undefined)
            out[key] = shown;
    }
    return out;
}
function display(key, value, limit, full) {
    if (value === null || value === undefined)
        return undefined;
    if (typeof value === "string") {
        if (value.length === 0)
            return undefined;
        if (full || value.length <= limit)
            return value;
        return `${Array.from(value).slice(0, limit).join("")}\u2026(${value.length} chars \u2014 use --full)`;
    }
    if (typeof value === "number" || typeof value === "boolean")
        return value;
    if (Array.isArray(value)) {
        if (value.length === 0)
            return undefined;
        if (value.every((item) => typeof item === "string" || typeof item === "number"))
            return value.join(", ");
        return JSON.stringify(value);
    }
    if (typeof value === "object") {
        const entries = Object.entries(value);
        if (entries.length === 0)
            return undefined;
        const text = JSON.stringify(value);
        if (full || text.length <= limit)
            return text;
        return `${text.slice(0, limit)}\u2026(${text.length} chars \u2014 use --full)`;
    }
    return String(value);
}
