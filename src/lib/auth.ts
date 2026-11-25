import { AxiError } from "axi-sdk-js";

export { hasCredential } from "./env.js";
import type { CommandContext } from "../context.js";

/**
 * Fail fast with actionable guidance when the instance is not configured.
 * Order matters: flag validation happens before this, network after.
 */
export function requireAuth(ctx: CommandContext, commandPath: string): void {
  const { config } = ctx;
  if (!config.domain) {
    throw new AxiError(`${commandPath} requires ESPO_CRM_DOMAIN`, "AUTH_REQUIRED", [
      "export ESPO_CRM_DOMAIN=crm.example.com  (the hostname you open EspoCRM in, or add it to ./.env)",
    ]);
  }
  if (config.authMode === "basic") {
    if (!config.username) {
      throw new AxiError(`${commandPath}: basic auth requires ESPO_CRM_AUTH_USER`, "VALIDATION_ERROR", [
        "Set ESPO_CRM_AUTH_USER=<username> (the account the token/password belongs to)",
        "Or ESPO_CRM_AUTH_MODE=api-key to use an API User key instead",
      ]);
    }
    if (!config.apiKey && !config.password) {
      throw new AxiError(`${commandPath}: basic auth needs ESPO_CRM_AUTH_PASSWORD (bootstraps a token) or a stored token in ESPO_CRM_API_KEY`, "AUTH_REQUIRED", [
        "export ESPO_CRM_AUTH_USER=<username> ESPO_CRM_AUTH_PASSWORD=<password>  - a fresh token is bootstrapped per run",
        "Or store a current token: ESPO_CRM_API_KEY=<token> (run `espocrm-axi auth refresh --write-env` to persist one)",
      ]);
    }
    return;
  }
  if (!config.apiKey) {
    throw new AxiError(`${commandPath} requires ESPO_CRM_API_KEY`, "AUTH_REQUIRED", [
      "API User: export ESPO_CRM_API_KEY=<key>  (Administration > API Users > API Key)",
      "Live user: export ESPO_CRM_AUTH_MODE=basic ESPO_CRM_AUTH_USER=<user> ESPO_CRM_AUTH_PASSWORD=<password>",
    ]);
  }
  if (config.authMode === "hmac" && !config.secretKey) {
    throw new AxiError(`${commandPath}: hmac auth requires ESPO_CRM_SECRET_KEY`, "VALIDATION_ERROR");
  }
}

/** Hint appended when the client bootstrapped a token in-process. */
export function refreshedHint(ctx: CommandContext): string[] {
  return ctx.client.auth.refreshed
    ? ["Auth token was bootstrapped from ESPO_CRM_AUTH_PASSWORD for this run only; run `espocrm-axi auth refresh --write-env` to store one"]
    : [];
}
