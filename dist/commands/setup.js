import { installSessionStartHooks, sessionStartHookStatus, uninstallSessionStartHooks } from "axi-sdk-js";
import { oneOf, parseFlags } from "../lib/args.js";
import { renderResult } from "../lib/output.js";
export const SETUP_HELP = `espocrm-axi setup - install ambient context and inspect installation

subcommands:
  setup hooks    install or repair Claude Code / Codex / OpenCode session-start hooks
  setup status   report hook installation without writing anything
  setup remove   remove espocrm-axi managed hooks, leaving unrelated entries alone

flags:
  --scope user|project   target home-directory config (default) or this repo's config

The hook injects the espocrm-axi home view (auth state, record counts, unread
inbox, command list) as ambient context at the start of every session, so the
agent knows the tool exists before you mention it.

examples:
  espocrm-axi setup hooks
  espocrm-axi setup hooks --scope project
  espocrm-axi setup status`;
const SETUP_FLAGS = { scope: { type: "string" } };
const HOOK_OPTIONS = { marker: "espocrm-axi", binaryNames: ["espocrm-axi"] };
export async function setupCommand(args) {
    const sub = args[0];
    if (sub !== "hooks" && sub !== "status" && sub !== "remove" && sub !== "uninstall") {
        return SETUP_HELP;
    }
    const commandPath = `espocrm-axi setup ${sub}`;
    const { values } = parseFlags(args.slice(1), commandPath, SETUP_FLAGS);
    const scope = oneOf(values, "scope", ["user", "project"]) ?? "user";
    if (sub === "status") {
        const status = sessionStartHookStatus({ ...HOOK_OPTIONS, scope });
        return {
            hooks: {
                scope,
                claude_code: { installed: status.claude.installed, path: status.claude.path },
                codex: { installed: status.codex.installed, path: status.codex.path, user_feature_enabled: status.codex.userFeatureEnabled },
                opencode: { installed: status.opencode.installed, path: status.opencode.path },
            },
            help: ["Run `espocrm-axi setup hooks` to install or repair missing hooks", "Run `espocrm-axi setup hooks --scope project` for repo-local ambient context"],
        };
    }
    if (sub === "remove" || sub === "uninstall") {
        uninstallSessionStartHooks({ ...HOOK_OPTIONS, scope });
        return { hooks: { scope, removed: true }, help: ["Run `espocrm-axi setup hooks` to reinstall"] };
    }
    const messages = [];
    installSessionStartHooks({ ...HOOK_OPTIONS, scope, onError: (message) => messages.push(message) });
    const status = sessionStartHookStatus({ ...HOOK_OPTIONS, scope });
    return renderResult({
        hooks: {
            scope,
            claude_code: status.claude.installed,
            codex: status.codex.installed,
            opencode: status.opencode.installed,
            ...(messages.length > 0 ? { warnings: messages } : {}),
        },
        help: ["New sessions now start with the espocrm-axi dashboard as ambient context", "Run `espocrm-axi setup status` anytime to verify"],
    }, false);
}
