import { createHmac } from "node:crypto";
import { AxiError } from "axi-sdk-js";
import { redact, secretsOf } from "../lib/env.js";
import { encodeListParams } from "../lib/where.js";
const PATH_RE = /^[a-zA-Z0-9/_{}%:.~-]*$/;
function isAbort(error) {
    return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"));
}
function cleanPath(path) {
    const trimmed = path.startsWith("/") ? path.slice(1) : path;
    if (trimmed.length === 0 || !PATH_RE.test(trimmed) || trimmed.includes("..")) {
        throw new AxiError(`invalid API path: ${path}`, "VALIDATION_ERROR", [
            "Paths are relative to api/v1 and use letters, digits, /, -, _, ., ~ (encode other characters)",
        ]);
    }
    return trimmed;
}
export function createEspoClient(config, deps = {}) {
    const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
    const auth = { refreshed: false, whereStyle: undefined };
    let freshToken;
    let bootstrapped = false;
    const base = () => {
        if (!config.domain) {
            throw new AxiError("ESPO_CRM_DOMAIN is not set", "AUTH_REQUIRED", [
                "Export ESPO_CRM_DOMAIN=crm.example.com (or add it to ./.env)",
            ]);
        }
        return `${config.domain}/api/v1/`;
    };
    function authHeaders(method, pathname) {
        if (!config.apiKey && config.authMode !== "basic") {
            throw new AxiError("ESPO_CRM_API_KEY is not set", "AUTH_REQUIRED", [
                "Create an API User under Administration > API Users and export its key as ESPO_CRM_API_KEY",
                "Or use a live user credential: ESPO_CRM_AUTH_MODE=basic ESPO_CRM_AUTH_USER=<user> ESPO_CRM_AUTH_PASSWORD=<password>",
            ]);
        }
        if (config.authMode === "basic") {
            if (!config.username) {
                throw new AxiError("basic auth requires ESPO_CRM_AUTH_USER", "VALIDATION_ERROR", [
                    "Set ESPO_CRM_AUTH_USER to the user the token belongs to, or ESPO_CRM_AUTH_MODE=api-key",
                ]);
            }
            const token = freshToken ?? config.apiKey;
            if (!token) {
                throw new AxiError("basic auth has no token: set ESPO_CRM_AUTH_PASSWORD (bootstraps one) or ESPO_CRM_API_KEY", "AUTH_REQUIRED");
            }
            return { Authorization: `Basic ${Buffer.from(`${config.username}:${token}`).toString("base64")}` };
        }
        if (config.authMode === "hmac") {
            if (!config.secretKey) {
                throw new AxiError("hmac auth requires ESPO_CRM_SECRET_KEY", "VALIDATION_ERROR", [
                    "Use the secret key shown on the API User record",
                ]);
            }
            const resource = pathname.startsWith("/") ? pathname : `/${pathname}`;
            const digest = createHmac("sha256", config.secretKey).update(`${method.toUpperCase()} ${resource}`).digest("hex");
            return { "X-Hmac-Authorization": Buffer.from(`${config.apiKey}:${digest}`).toString("base64") };
        }
        if (!config.apiKey) {
            throw new AxiError("ESPO_CRM_API_KEY is not set", "AUTH_REQUIRED", [
                "API User key: export ESPO_CRM_API_KEY=<key> (Administration > API Users)",
                "Live user: export ESPO_CRM_AUTH_MODE=basic ESPO_CRM_AUTH_USER=<user> ESPO_CRM_AUTH_PASSWORD=<password>",
            ]);
        }
        return { "X-Api-Key": config.apiKey };
    }
    async function bootstrapToken() {
        if (!config.username || !config.password) {
            throw new AxiError("EspoCRM rejected the user token and ESPO_CRM_AUTH_PASSWORD is not set, so it cannot be refreshed", "AUTH_REQUIRED", [
                "Export ESPO_CRM_AUTH_PASSWORD so expired tokens can be re-bootstrapped automatically, or paste a fresh token into ESPO_CRM_API_KEY",
                `Run \`${process.argv[1] ?? "espocrm-axi"} auth refresh --write-env\` once ESPO_CRM_AUTH_PASSWORD is set`,
            ]);
        }
        const url = `${base()}App/user`;
        const response = await fetchImpl(url, {
            method: "GET",
            headers: {
                accept: "application/json",
                "user-agent": config.userAgent,
                "Espo-Authorization": Buffer.from(`${config.username}:${config.password}`).toString("base64"),
            },
            signal: AbortSignal.timeout(config.timeoutMs),
        });
        const text = await response.text().catch(() => "");
        if (!response.ok) {
            throw new AxiError(`EspoCRM token refresh failed (GET App/user -> HTTP ${response.status}): ${reasonOf(response, text)}`, "AUTH_REQUIRED", ["Check ESPO_CRM_AUTH_USER / ESPO_CRM_AUTH_PASSWORD and that the account can log in"]);
        }
        const parsed = parseBody(text);
        const token = typeof parsed === "object" && parsed !== null ? parsed["token"] : undefined;
        if (typeof token !== "string" || token.length === 0) {
            throw new AxiError("EspoCRM /App/user returned no token", "AUTH_REQUIRED");
        }
        return token;
    }
    function reasonOf(response, bodyText) {
        const header = response.headers.get("x-status-reason") ?? undefined;
        const text = (header ?? "").trim();
        if (text)
            return redact(text.replace(/^Exposed:\s*/, ""), secretsOf(config));
        const trimmed = bodyText.trim();
        if (!trimmed)
            return "(no message)";
        try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === "object" && parsed !== null && "message" in parsed) {
                return redact(String(parsed.message), secretsOf(config));
            }
        }
        catch {
            // HTML/plain error pages fall through.
        }
        return redact(trimmed.slice(0, 200), secretsOf(config));
    }
    function looksLikeWaf(response, bodyText) {
        if (response.headers.get("x-status-reason"))
            return false;
        const status = response.status;
        if (status === 500 && bodyText.trim().length === 0)
            return true;
        if (status === 403 && /error code:\s*1010|cloudflare|imunify|access denied/i.test(bodyText))
            return true;
        return status === 501 || status === 503 ? bodyText.trim().length === 0 : false;
    }
    function httpError(response, bodyText, method, path) {
        const status = response.status;
        const reason = reasonOf(response, bodyText);
        const where = `${method.toUpperCase()} /${path}`;
        if (status === 400) {
            return new AxiError(`EspoCRM rejected ${where}: ${reason}`, "VALIDATION_ERROR", [
                "Check the flags against the entity's fields (`espocrm-axi record fields <Type>`)",
            ]);
        }
        if (status === 401) {
            return new AxiError(`EspoCRM rejected authentication (HTTP 401) for ${where}: ${reason}`, "AUTH_REQUIRED", [
                `Auth mode is ${config.authMode}; verify ESPO_CRM_API_KEY${config.authMode === "basic" ? " and ESPO_CRM_AUTH_USER" : ""}`,
                "If the key is a regular user's auth token it must be sent in basic mode (set ESPO_CRM_AUTH_USER)",
                "Repeated failures trigger a temporary lockout (403); wait a few minutes before retrying",
            ]);
        }
        if (status === 403) {
            return new AxiError(`EspoCRM forbade ${where}: ${reason}`, "AUTH_REQUIRED", [
                "The authenticated user's role lacks access to this scope/record, or a WAF blocked the request",
                "API Users need the scope enabled in their Role; inbox operations need the mailbox owner's token",
            ]);
        }
        if (status === 404) {
            return new AxiError(`EspoCRM resource not found (HTTP 404) for ${where}`, "NOT_FOUND", [
                "Check the id / entity type against list output; older instances may lack newer endpoints",
            ]);
        }
        if (status === 409) {
            return new AxiError(`EspoCRM conflict (HTTP 409) for ${where}: ${reason}`, "CONFLICT", [
                "The record may be locked, a duplicate, or modified concurrently; re-read and retry",
            ]);
        }
        if (status === 429) {
            return new AxiError(`EspoCRM rate limit hit (HTTP 429) for ${where}`, "RATE_LIMITED", ["Wait for the window to reset, then retry"]);
        }
        const silent = silentOf(bodyText) ?? silentOf(response.headers.get("x-status-reason") ?? "");
        if (silent) {
            return new AxiError(`EspoCRM ${where} failed: ${redact(silent.message, secretsOf(config))} (record ${silent.id} kept as Draft)`, "API_ERROR", [
                "Fix the cause and resend with `espocrm-axi email send <id> --confirm`",
            ]);
        }
        return new AxiError(`EspoCRM HTTP ${status} for ${where}: ${reason}`, "API_ERROR");
    }
    /** `ErrorSilent` bodies look like `{"id":"...","message":"..."}` (email sending failures). */
    function silentOf(bodyText) {
        const trimmed = bodyText.trim();
        if (!trimmed.startsWith("{"))
            return undefined;
        try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed.id === "string" && typeof parsed.message === "string")
                return { id: parsed.id, message: parsed.message };
        }
        catch {
            return undefined;
        }
        return undefined;
    }
    async function execute(method, rawPath, opts, attempt) {
        const path = cleanPath(rawPath);
        const url = new URL(`${base()}${path}`);
        for (const [key, value] of Object.entries(opts.query ?? {})) {
            if (value === undefined || value === "" || value === false)
                continue;
            url.searchParams.set(key, String(value));
        }
        let style = "where";
        if (opts.list) {
            style = auth.whereStyle ?? (config.whereStyle === "whereGroup" ? "whereGroup" : "where");
            const encoded = encodeListParams(opts.list, style);
            for (const [key, value] of encoded.entries())
                url.searchParams.set(key, value);
        }
        // basic mode with no stored token: bootstrap one from the password up front
        if (!opts.noAuth && config.authMode === "basic" && !freshToken && !config.apiKey) {
            freshToken = await bootstrapToken();
            auth.refreshed = true;
            bootstrapped = true;
        }
        const timeoutMs = opts.timeoutMs ?? config.timeoutMs;
        const headers = {
            accept: "application/json",
            "user-agent": config.userAgent,
        };
        if (opts.body !== undefined)
            headers["content-type"] = "application/json";
        if (!opts.noAuth)
            Object.assign(headers, authHeaders(method, resourcePath(url)));
        let response;
        try {
            response = await fetchImpl(url.toString(), {
                method,
                headers,
                body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
                signal: AbortSignal.timeout(timeoutMs),
            });
        }
        catch (error) {
            if (isAbort(error)) {
                throw new AxiError(`EspoCRM request timed out after ${timeoutMs}ms (${method} ${path})`, "TIMEOUT", [
                    "Retry, narrow the request, or raise ESPO_CRM_TIMEOUT_MS",
                ]);
            }
            throw new AxiError(`Network error reaching ${config.domain}: ${redact(String(error), secretsOf(config))}`, "NETWORK_ERROR", ["Check the hostname and your connection; a WAF may be blocking this client's IP or user agent"]);
        }
        const bodyText = await response.text().catch(() => "");
        if (!response.ok) {
            if (response.status === 401 && config.authMode === "basic" && !opts.noAuth && !bootstrapped) {
                bootstrapped = true;
                freshToken = await bootstrapToken();
                auth.refreshed = true;
                return execute(method, rawPath, opts, attempt + 1);
            }
            if (opts.list && looksLikeWaf(response, bodyText) && attempt === 0) {
                const next = style === "where" ? "whereGroup" : "where";
                if (config.whereStyle === "auto") {
                    auth.whereStyle = next;
                    return execute(method, rawPath, opts, attempt + 1);
                }
            }
            throw httpError(response, bodyText, method, path);
        }
        if (opts.list && auth.whereStyle === undefined && config.whereStyle === "auto")
            auth.whereStyle = style;
        return parseBody(bodyText);
    }
    async function request(method, path, opts = {}) {
        return execute(method, path, opts, 0);
    }
    async function download(path, opts = {}) {
        const clean = cleanPath(path);
        const url = new URL(`${base()}${clean}`);
        for (const [key, value] of Object.entries(opts.query ?? {})) {
            if (value === undefined || value === "")
                continue;
            url.searchParams.set(key, String(value));
        }
        const timeoutMs = opts.timeoutMs ?? config.timeoutMs;
        let response;
        try {
            response = await fetchImpl(url.toString(), {
                method: "GET",
                headers: { accept: "*/*", "user-agent": config.userAgent, ...authHeaders("GET", resourcePath(url)) },
                signal: AbortSignal.timeout(timeoutMs),
            });
        }
        catch (error) {
            if (isAbort(error))
                throw new AxiError(`EspoCRM download timed out after ${timeoutMs}ms`, "TIMEOUT");
            throw new AxiError(`Network error reaching ${config.domain}: ${redact(String(error), secretsOf(config))}`, "NETWORK_ERROR");
        }
        const bodyText = response.ok ? "" : await response.text().catch(() => "");
        if (!response.ok)
            throw httpError(response, bodyText, "GET", clean);
        const bytes = Buffer.from(await response.arrayBuffer());
        const disposition = response.headers.get("content-disposition") ?? undefined;
        const filename = disposition ? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1] : undefined;
        return {
            bytes,
            contentType: response.headers.get("content-type") ?? undefined,
            filename: filename ? decodeURIComponent(filename) : undefined,
        };
    }
    async function list(entityType, params = {}) {
        const payload = await request("GET", entityType, { list: params });
        if (payload === null || payload === undefined)
            return { list: [], total: 0 };
        if (typeof payload !== "object" || Array.isArray(payload)) {
            throw new AxiError(`unexpected list response for ${entityType}`, "API_ERROR");
        }
        const record = payload;
        const rows = Array.isArray(record["list"]) ? record["list"].filter((r) => typeof r === "object" && r !== null) : [];
        const total = typeof record["total"] === "number" ? record["total"] : undefined;
        return { list: rows, total };
    }
    return { config, request, download, list, auth };
}
/** Path relative to the API root, leading slash kept - what HMAC signs (`METHOD /Lead`). */
function resourcePath(url) {
    const baseLength = url.pathname.indexOf("/api/v1/");
    return baseLength >= 0 ? url.pathname.slice(baseLength + "/api/v1".length) : `/${url.pathname.replace(/^\/+/, "")}`;
}
function parseBody(text) {
    if (text.trim().length === 0)
        return null;
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
