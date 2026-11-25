import { AxiError } from "axi-sdk-js";
import { renderResult } from "../lib/output.js";
import { asRecord, asString, compact } from "../lib/coerce.js";
import { requireAuth } from "../lib/auth.js";
import { parseFlags } from "../lib/args.js";
export const ME_HELP = `espocrm-axi me - who you are on this EspoCRM instance

subcommands:
  me                    authenticated user, teams, and per-scope access summary
  me preferences        the user's preferences (locale, timezone, defaults...)
  me --full | --json    complete / raw payload

auth: ESPO_CRM_DOMAIN + ESPO_CRM_API_KEY (+ ESPO_CRM_AUTH_USER for user tokens).
In basic mode the response also carries a fresh auth token, which is redacted here.`;
const ME_FLAGS = { full: { type: "boolean" }, json: { type: "boolean" } };
export async function meCommand(args, ctx) {
    const sub = args[0];
    if (sub === "--help" || sub === "help")
        return ME_HELP;
    const commandPath = "espocrm-axi me";
    const { values } = parseFlags(sub === "preferences" ? args.slice(1) : args, commandPath, ME_FLAGS);
    requireAuth(ctx, commandPath);
    const json = values["json"] === true;
    const full = values["full"] === true;
    const payload = asRecord(await ctx.client.request("GET", "App/user"));
    if (!payload)
        throw new AxiError("App/user returned no data", "API_ERROR");
    const user = asRecord(payload["user"]);
    const userId = asString(user?.["id"]);
    if (!userId || !user)
        throw new AxiError("App/user returned no user record", "API_ERROR");
    if (sub === "preferences") {
        const prefs = asRecord(await ctx.client.request("GET", `Preferences/${encodeURIComponent(userId)}`));
        return renderResult({ preferences: prefs ?? {} }, json);
    }
    if (json || full) {
        const safe = { ...payload };
        if (safe["token"])
            safe["token"] = "<redacted>";
        return json ? JSON.stringify(safe, null, 2) : safe;
    }
    const teams = asRecord(user["teamsNames"]);
    const out = {
        auth_mode: ctx.config.authMode,
        instance: ctx.config.domain,
        user: compact({
            id: userId,
            userName: asString(user["userName"]),
            name: asString(user["name"]),
            type: asString(user["type"]),
            emailAddress: asString(user["emailAddress"]),
            teams: teams ? Object.values(teams).filter((v) => typeof v === "string").join(", ") : undefined,
        }),
    };
    const acl = asRecord(asRecord(payload["acl"])?.["table"]);
    if (acl && asString(user["type"]) === "admin") {
        out["access"] = `admin - full access to all ${Object.keys(acl).length} scopes`;
    }
    else if (acl) {
        const scopes = { read: [], create: [], edit: [], delete: [] };
        for (const [scope, perms] of Object.entries(acl)) {
            const p = asRecord(perms);
            if (!p)
                continue;
            if (p["read"])
                scopes["read"].push(scope);
            if (p["create"])
                scopes["create"].push(scope);
            if (p["edit"])
                scopes["edit"].push(scope);
            if (p["delete"])
                scopes["delete"].push(scope);
        }
        const same = scopes["read"].join("|") === scopes["create"].join("|") && scopes["read"].join("|") === scopes["edit"].join("|") && scopes["read"].join("|") === scopes["delete"].join("|");
        out["access"] = same ? `read, create, edit, delete: ${scopes["read"].join(", ")}` : Object.fromEntries(Object.entries(scopes).map(([k, v]) => [k, v.join(", ")]));
    }
    out["help"] = [
        "Run `espocrm-axi email inbox` to read mail" + (ctx.config.authMode === "basic" ? "" : " (needs a user token: ESPO_CRM_AUTH_USER)"),
        "Run `espocrm-axi record list <Type>` for any scope listed under access.read",
        "Run `espocrm-axi me --full` for the complete payload",
    ];
    return renderResult(out, false);
}
