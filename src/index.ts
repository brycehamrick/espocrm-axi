import { runAxiCli, type AxiCliCommand } from "axi-sdk-js";
import { VERSION } from "./version.js";
import { createCommandContext, type CommandContext } from "./context.js";
import { homeCommand } from "./commands/home.js";
import { meCommand, ME_HELP } from "./commands/me.js";
import { authCommand, AUTH_HELP } from "./commands/auth.js";
import { recordCommand, RECORD_HELP } from "./commands/record.js";
import { shortcutCommand, SHORTCUTS } from "./commands/entities.js";
import { emailCommand, EMAIL_HELP } from "./commands/email.js";

export const DESCRIPTION =
  "EspoCRM for agents - records for any entity type, inbox and email sending, stream, activities, admin tools over the EspoCRM REST API";

const COMMAND_HELP: Record<string, string> = {
  me: ME_HELP,
  auth: AUTH_HELP,
  record: RECORD_HELP,
  email: EMAIL_HELP,
  ...Object.fromEntries(Object.entries(SHORTCUTS).map(([name, s]) => [name, `espocrm-axi ${name} - ${s.label} (shortcut for \`record ... ${s.type}\`)\n\nRun \`espocrm-axi record --help\` for all subcommands and list flags.`])),
};

const COMMAND_NAMES = ["me", "auth", "record", "email", ...Object.keys(SHORTCUTS)];

const TOP_LEVEL_HELP = `espocrm-axi - ${DESCRIPTION}

commands:
${COMMAND_NAMES.map((c) => `  ${c}`).join("\n")}

global flags: --help, -v/--version, update (self-update)

auth: ESPO_CRM_DOMAIN and ESPO_CRM_API_KEY env vars (or ./.env). With
ESPO_CRM_USERNAME set, the key is treated as that user's auth token (Basic
auth) - required for per-user inbox access. API Users use X-Api-Key.

all writes require --confirm. run \`espocrm-axi <command> --help\` for details.`;

function bind(handler: (args: string[], ctx: CommandContext) => Promise<unknown>): AxiCliCommand<CommandContext> {
  return handler as AxiCliCommand<CommandContext>;
}

const commands: Record<string, AxiCliCommand<CommandContext>> = {
  me: bind(meCommand),
  auth: bind(authCommand),
  record: bind(recordCommand),
  email: bind(emailCommand),
  ...Object.fromEntries(Object.entries(SHORTCUTS).map(([name]) => [name, bind(shortcutCommand(name))])),
};

export async function main(): Promise<void> {
  await runAxiCli<CommandContext>({
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_LEVEL_HELP,
    getCommandHelp: (command: string) => COMMAND_HELP[command] ?? null,
    resolveContext: () => createCommandContext(),
    home: bind(homeCommand),
    commands,
  });
}

if (process.argv[1]?.endsWith("index.js")) {
  await main();
}
