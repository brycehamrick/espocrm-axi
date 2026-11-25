/**
 * Narrowing helpers shared by every command. EspoCRM payloads are loosely
 * typed (custom entities, optional attributes), so everything flows through
 * these and unknown shapes degrade to omitted fields instead of crashes.
 */
export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function asRecord(value) {
    return isRecord(value) ? value : undefined;
}
export function asString(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
export function asNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
export function asBoolean(value) {
    return typeof value === "boolean" ? value : undefined;
}
export function asStringArray(value) {
    if (!Array.isArray(value))
        return undefined;
    return value.filter((item) => typeof item === "string" && item.length > 0);
}
export function asRecordArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((row) => isRecord(row));
}
/** Drop undefined values from a record so TOON output stays clean. */
export function compact(record) {
    const out = {};
    for (const [key, value] of Object.entries(record)) {
        if (value !== undefined)
            out[key] = value;
    }
    return out;
}
/** Pick a subset of keys from a record, dropping missing ones. */
export function pick(record, keys) {
    const out = {};
    for (const key of keys) {
        if (record[key] !== undefined)
            out[key] = record[key];
    }
    return out;
}
/**
 * Render an attribute value for a compact single-line field: nested
 * objects/arrays are JSON-serialized, strings pass through, null is dropped.
 */
export function displayValue(value) {
    if (value === null || value === undefined)
        return undefined;
    if (typeof value === "string")
        return value;
    if (typeof value === "number" || typeof value === "boolean")
        return value;
    if (Array.isArray(value)) {
        if (value.length === 0)
            return undefined;
        if (value.every((item) => typeof item === "string"))
            return value.join(", ");
        return JSON.stringify(value);
    }
    return JSON.stringify(value);
}
