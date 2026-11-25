import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AxiError } from "axi-sdk-js";
import { renderResult } from "../lib/output.js";
import { asRecord, asString, compact } from "../lib/coerce.js";
import { requireAuth } from "../lib/auth.js";
import { parseFlags, requireConfirm } from "../lib/args.js";
export const AUTH_HELP = `espocrm-axi auth - verify credentials and refresh expiring user tokens

subcommands:
  auth status             which instance, mode, and user the credentials resolve to
  auth refresh [--write-env] [--env-file <path>]
                          bootstrap a fresh user auth token from ESPO_CRM_AUTH_PASSWORD.
                          Without --write-env it only proves the refresh works;
                          with --write-env the new token replaces ESPO_CRM_API_KEY
                          in ./.env (or --env-file). The token is never printed.

why: in basic mode ESPO_CRM_API_KEY is a user auth token that expires after
authTokenMaxIdleTime (48h by default) without use. Every command already
re-bootstraps a stale token in-process when ESPO_CRM_AUTH_PASSWORD is set; use
auth refresh --write-env from cron to persist it for tools that read .env.

examples:
  espocrm-axi auth status
  espocrm-axi auth refresh --write-env
  espocrm-axi auth refresh --write-env --env-file ~/.hermes/profiles/pr-agent/.env`;
const STATUS_FLAGS = { json: { type: "boolean" } };
const REFRESH_FLAGS = {
    "write-env": { type: "boolean" },
    "env-file": { type: "string" },
    confirm: { type: "boolean" },
};
export async function authCommand(args, ctx) {
    const sub = args[0];
    if (sub !== "status" && sub !== "refresh")
        return AUTH_HELP;
    const commandPath = `espocrm-axi auth ${sub}`;
    requireAuth(ctx, commandPath);
    if (sub === "status") {
        const { values } = parseFlags(args.slice(1), commandPath, STATUS_FLAGS);
        const payload = asRecord(await ctx.client.request("GET", "App/user"));
        const user = asRecord(payload?.["user"]);
        const out = {
            auth: "ok",
            mode: ctx.config.authMode,
            instance: ctx.config.domain,
            user: asString(user?.["userName"]) ?? asString(user?.["name"]),
            name: asString(user?.["name"]),
            type: asString(user?.["type"]),
            user_id: asString(user?.["id"]),
        };
        return renderResult({ ...out, help: refreshedHelp(ctx) }, values["json"] === true);
    }
    const { values } = parseFlags(args.slice(1), commandPath, REFRESH_FLAGS);
    if (ctx.config.authMode !== "basic") {
        throw new AxiError("auth refresh only applies to user tokens (ESPO_CRM_AUTH_MODE=basic); API keys do not expire", "VALIDATION_ERROR", [
            "Set ESPO_CRM_AUTH_USER so the mode resolves to basic",
        ]);
    }
    if (!ctx.config.password) {
        throw new AxiError("auth refresh requires ESPO_CRM_AUTH_PASSWORD", "VALIDATION_ERROR", [
            "Export the account password (or ESPO_CRM_AUTH_PASSWORD) so a fresh token can be bootstrapped",
        ]);
    }
    const writeEnv = values["write-env"] === true;
    const envFile = typeof values["env-file"] === "string" && values["env-file"] ? values["env-file"] : resolve(process.cwd(), ".env");
    if (writeEnv) {
        requireConfirm(values, commandPath, `replace ESPO_CRM_API_KEY in ${envFile} with a freshly bootstrapped token`);
    }
    // Force a bootstrap by talking to App/user with the password directly.
    const token = await bootstrap(ctx);
    if (writeEnv) {
        if (existsSync(envFile)) {
            const before = readFileSync(envFile, "utf8");
            const lines = before.split(/\r?\n/);
            const index = lines.findIndex((line) => line.startsWith("ESPO_CRM_API_KEY=") || line.startsWith("export ESPO_CRM_API_KEY="));
            if (index >= 0)
                lines[index] = `ESPO_CRM_API_KEY=${token}`;
            else
                lines.push(`ESPO_CRM_API_KEY=${token}`);
            writeFileSync(envFile, `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}${before.endsWith("\n") ? "\n" : ""}`);
        }
        else {
            writeFileSync(envFile, `ESPO_CRM_DOMAIN=${ctx.config.domain}\nESPO_CRM_AUTH_USER=${ctx.config.username ?? ""}\nESPO_CRM_API_KEY=${token}\n`);
        }
    }
    return renderResult(compact({
        refreshed: true,
        mode: "basic",
        instance: ctx.config.domain,
        user: ctx.config.username,
        stored: writeEnv ? envFile : false,
        help: [
            writeEnv ? "New sessions pick the token up from the env file automatically" : "Token was validated but not stored; rerun with --write-env to persist it",
            "The token is never printed; rotate ESPO_CRM_AUTH_PASSWORD if the env file is shared",
        ],
    }), false);
}
async function bootstrap(ctx) {
    const header = Buffer.from(`${ctx.config.username}:${ctx.config.password}`).toString("base64");
    const response = await fetch(`${ctx.config.domain}/api/v1/App/user`, {
        method: "GET",
        headers: { accept: "application/json", "user-agent": ctx.config.userAgent, "Espo-Authorization": header },
        signal: AbortSignal.timeout(ctx.config.timeoutMs),
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
        const reason = response.headers.get("x-status-reason") ?? text.slice(0, 160) ?? "(no message)";
        throw new AxiError(`token bootstrap failed (HTTP ${response.status}): ${reason}`, "AUTH_REQUIRED", [
            "Check ESPO_CRM_AUTH_USER / ESPO_CRM_AUTH_PASSWORD",
        ]);
    }
    const token = asString(asRecord(JSON.parse(text))?.["token"]);
    if (!token)
        throw new AxiError("App/user returned no token", "AUTH_REQUIRED");
    return token;
}
function refreshedHelp(ctx) {
    return ctx.config.authMode === "basic" && !ctx.config.password
        ? ["Set ESPO_CRM_AUTH_PASSWORD so expired tokens refresh automatically (48h idle expiry)"]
        : ["Run `espocrm-axi email inbox` or `espocrm-axi record list Lead` to start"];
}
