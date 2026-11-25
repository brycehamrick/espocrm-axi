/**
 * Narrowing helpers shared by every command. EspoCRM payloads are loosely
 * typed (custom entities, optional attributes), so everything flows through
 * these and unknown shapes degrade to omitted fields instead of crashes.
 */

export type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Json | undefined {
  return isRecord(value) ? value : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export function asRecordArray(value: unknown): Json[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is Json => isRecord(row));
}

/** Drop undefined values from a record so TOON output stays clean. */
export function compact(record: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Pick a subset of keys from a record, dropping missing ones. */
export function pick(record: Json, keys: readonly string[]): Json {
  const out: Json = {};
  for (const key of keys) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  return out;
}

/**
 * Render an attribute value for a compact single-line field: nested
 * objects/arrays are JSON-serialized, strings pass through, null is dropped.
 */
export function displayValue(value: unknown): string | number | boolean | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    if (value.every((item) => typeof item === "string")) return value.join(", ");
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}

const SECRET_KEY_RE = /^(api[-_]?key|.*password|.*secret|.*token|.*privatekey|secretkey)$/i;

/**
 * Mask values of secret-looking attribute names (User.apiKey, EmailAccount.smtpPassword,
 * Webhook.secret, ...). Server responses can carry them; transcripts never should.
 */
export function redactSecrets(record: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = SECRET_KEY_RE.test(key) && value !== null && value !== false && value !== "" && value !== undefined ? "<redacted>" : value;
  }
  return out;
}
