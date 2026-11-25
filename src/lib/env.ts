import { readFileSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import { loadDotEnv } from "./dotenv.js";

/**
 * Configuration is read from the environment only - never from flags, files
 * the user did not opt into, or prompts. A `./.env` in the working directory
 * is consulted as a convenience (without overriding real env vars), mirroring
 * how many EspoCRM automations already store `ESPO_CRM_*` values.
 *
 * Two variables are required for every data command:
 *   ESPO_CRM_DOMAIN   hostname or URL of the EspoCRM instance
 *   ESPO_CRM_API_KEY  the credential (an API User key, or a user auth token)
 *
 * Auth modes (ESPO_CRM_AUTH_MODE = auto | api-key | basic | hmac):
 *   api-key  X-Api-Key header - API Users created under Administration > API Users.
 *   basic    Authorization: Basic base64(<user>:<token>) - a regular user's
 *            auth token. Requires ESPO_CRM_USERNAME. This is the only mode with
 *            per-user inbox access (inbox/archive/read state lives in email_user).
 *   hmac     X-Hmac-Authorization - API User with HMAC auth + ESPO_CRM_SECRET_KEY.
 *   auto     basic when ESPO_CRM_USERNAME is set, otherwise api-key.
 */

export type AuthMode = "api-key" | "basic" | "hmac";
export type WhereStyle = "auto" | "where" | "whereGroup";

export interface EspoConfig {
  /** Base URL of the instance, e.g. https://crm.example.com (no trailing slash). Undefined until configured. */
  domain?: string;
  apiKey?: string;
  username?: string;
  password?: string;
  secretKey?: string;
  authMode: AuthMode;
  whereStyle: WhereStyle;
  timeoutMs: number;
  userAgent: string;
}

export const ENV_VARS = {
  domain: "ESPO_CRM_DOMAIN",
  apiKey: "ESPO_CRM_API_KEY",
  username: "ESPO_CRM_USERNAME",
  password: "ESPO_CRM_PASSWORD",
  secretKey: "ESPO_CRM_SECRET_KEY",
  authMode: "ESPO_CRM_AUTH_MODE",
  whereStyle: "ESPO_CRM_WHERE_STYLE",
  timeout: "ESPO_CRM_TIMEOUT_MS",
  userAgent: "ESPO_CRM_USER_AGENT",
} as const;

/** Accepts hermes-style ESPO_CRM_AUTH_* names as aliases for the username/password. */
function envValue(env: NodeJS.ProcessEnv, name: string, alias?: string): string | undefined {
  const direct = env[name]?.trim();
  if (direct) return direct;
  const aliased = alias ? env[alias]?.trim() : undefined;
  return aliased || undefined;
}

/**
 * Normalize an EspoCRM domain: bare hostnames get https://, trailing slashes
 * are dropped, sub-path installs are preserved. Plain http is allowed only for
 * loopback (local dev instances); everything else must be https.
 */
export function normalizeDomain(raw: string): string {
  let value = raw.trim().replace(/\/+$/, "");
  if (value.length === 0) {
    throw new AxiError(`${ENV_VARS.domain} is set but empty`, "VALIDATION_ERROR", [
      "Set it to the hostname you open EspoCRM in, e.g. crm.example.com",
    ]);
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AxiError(`${ENV_VARS.domain} is not a valid host or URL: ${redact(raw)}`, "VALIDATION_ERROR", [
      "Use a bare hostname (crm.example.com) or a full URL (https://crm.example.com)",
    ]);
  }
  if (parsed.username || parsed.password) {
    throw new AxiError(`${ENV_VARS.domain} must not contain embedded credentials`, "VALIDATION_ERROR", [
      `Pass the credential via ${ENV_VARS.apiKey} instead`,
    ]);
  }
  if (parsed.search || parsed.hash) {
    throw new AxiError(`${ENV_VARS.domain} must not contain query parameters or fragments`, "VALIDATION_ERROR");
  }
  const isLoopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    throw new AxiError(`${ENV_VARS.domain} must use https (got ${parsed.protocol}//)`, "VALIDATION_ERROR", [
      "Plain http is only allowed for localhost development instances",
    ]);
  }
  return parsed.toString().replace(/\/+$/, "");
}

/** Remove anything that looks like a credential from text before it reaches output. */
export function redact(text: string, secrets: Array<string | undefined> = []): string {
  let out = text.replace(/(X-Api-Key|X-Hmac-Authorization|Espo-Authorization)\s*[:=]\s*["']?[A-Za-z0-9+/_=.-]{12,}/gi, "$1: ***");
  out = out.replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/_=.-]{16,}/g, "$1 ***");
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("***");
  }
  return out;
}

function resolveAuthMode(raw: string | undefined, hasUsername: boolean): AuthMode {
  switch ((raw ?? "auto").toLowerCase()) {
    case "auto":
    case "":
      return hasUsername ? "basic" : "api-key";
    case "api-key":
    case "apikey":
    case "api_key":
    case "x-api-key":
      return "api-key";
    case "basic":
    case "token":
    case "user-token":
      return "basic";
    case "hmac":
      return "hmac";
    default:
      throw new AxiError(`${ENV_VARS.authMode} must be one of: auto, api-key, basic, hmac (got: ${raw})`, "VALIDATION_ERROR");
  }
}

function resolveWhereStyle(raw: string | undefined): WhereStyle {
  switch ((raw ?? "auto").toLowerCase()) {
    case "auto":
    case "":
      return "auto";
    case "where":
    case "wheregroup":
    case "where-group":
      return raw!.toLowerCase().startsWith("whereg") || raw === "where-group" ? "whereGroup" : "where";
    default:
      throw new AxiError(`${ENV_VARS.whereStyle} must be one of: auto, where, whereGroup (got: ${raw})`, "VALIDATION_ERROR");
  }
}

function resolveTimeout(raw: string | undefined): number {
  if (!raw) return 60_000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1_000 || n > 600_000) {
    throw new AxiError(`${ENV_VARS.timeout} must be an integer between 1000 and 600000 (got: ${raw})`, "VALIDATION_ERROR");
  }
  return n;
}

export function resolveConfig(env: NodeJS.ProcessEnv = loadDotEnv(process.env)): EspoConfig {
  const rawDomain = envValue(env, ENV_VARS.domain);
  const apiKey = envValue(env, ENV_VARS.apiKey);
  const username = envValue(env, ENV_VARS.username, "ESPO_CRM_AUTH_USER");
  const password = envValue(env, ENV_VARS.password, "ESPO_CRM_AUTH_PASSWORD");

  if (apiKey !== undefined && apiKey.length === 0) {
    throw new AxiError(`${ENV_VARS.apiKey} is set but empty`, "VALIDATION_ERROR", [
      "Export an API User key (Administration > API Users) or a user auth token",
    ]);
  }

  return {
    domain: rawDomain ? normalizeDomain(rawDomain) : undefined,
    apiKey: apiKey || undefined,
    username,
    password,
    secretKey: envValue(env, ENV_VARS.secretKey),
    authMode: resolveAuthMode(envValue(env, ENV_VARS.authMode), Boolean(username)),
    whereStyle: resolveWhereStyle(envValue(env, ENV_VARS.whereStyle)),
    timeoutMs: resolveTimeout(envValue(env, ENV_VARS.timeout)),
    userAgent: envValue(env, ENV_VARS.userAgent) ?? "espocrm-axi/0.1 (+https://github.com/brycehamrick/espocrm-axi)",
  };
}

/** Secrets that must never appear in output, in priority order for redaction. */
export function secretsOf(config: EspoConfig): Array<string | undefined> {
  return [config.apiKey, config.password, config.secretKey];
}
