import { AxiError } from "axi-sdk-js";
/** Fail fast with actionable guidance when the instance is not configured. */
export function requireAuth(ctx, commandPath) {
    const missing = [];
    if (!ctx.config.domain)
        missing.push("ESPO_CRM_DOMAIN");
    if (!ctx.config.apiKey)
        missing.push("ESPO_CRM_API_KEY");
    if (missing.length > 0) {
        throw new AxiError(`${commandPath} requires ${missing.join(" and ")}`, "AUTH_REQUIRED", [
            "export ESPO_CRM_DOMAIN=crm.example.com  (the hostname you open EspoCRM in)",
            "export ESPO_CRM_API_KEY=...             (Administration > API Users > API Key)",
            "For per-user inbox access use a user's auth token: ESPO_CRM_USERNAME=<user> ESPO_CRM_API_KEY=<token>",
        ]);
    }
    if (ctx.config.authMode === "basic" && !ctx.config.username) {
        throw new AxiError(`${commandPath}: basic auth requires ESPO_CRM_USERNAME`, "VALIDATION_ERROR", [
            "Set the user the token belongs to, or ESPO_CRM_AUTH_MODE=api-key",
        ]);
    }
    if (ctx.config.authMode === "hmac" && !ctx.config.secretKey) {
        throw new AxiError(`${commandPath}: hmac auth requires ESPO_CRM_SECRET_KEY`, "VALIDATION_ERROR");
    }
}
/** Hint appended when the client refreshed an expired token in-process. */
export function refreshedHint(ctx) {
    return ctx.client.auth.refreshed
        ? ["Auth token had expired and was refreshed from ESPO_CRM_PASSWORD for this run only; run `espocrm-axi auth refresh --write-env` to store it"]
        : [];
}
