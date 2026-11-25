import { runAxiCli, type AxiCliCommand } from "axi-sdk-js";
import { VERSION } from "./version.js";
import { createCommandContext, type CommandContext } from "./context.js";
import { COMMAND_HELP, COMMAND_NAMES } from "./command-help.js";
import { homeCommand } from "./commands/home.js";
import { meCommand } from "./commands/me.js";
import { authCommand } from "./commands/auth.js";
import { recordCommand } from "./commands/record.js";
import { shortcutCommand, SHORTCUTS } from "./commands/entities.js";
import { emailCommand } from "./commands/email.js";
import { streamCommand, postCommand } from "./commands/stream.js";
import { searchCommand } from "./commands/search.js";
import { attachmentCommand } from "./commands/attachment.js";
import { apiCommand } from "./commands/api.js";
import { setupCommand } from "./commands/setup.js";
import { activitiesCommand } from "./commands/activities.js";
import { settingsCommand, metadataCommand, adminCommand, pipelinesCommand, notificationCommand } from "./commands/tools.js";
import { massCommand, exportCommand } from "./commands/mass.js";

export const DESCRIPTION =
  "EspoCRM for agents - records for any entity type, inbox and email sending, stream, activities, admin tools over the EspoCRM REST API";

const TOP_LEVEL_HELP = `espocrm-axi - ${DESCRIPTION}

commands:
${COMMAND_NAMES.map((c) => `  ${c}`).join("\n")}

global flags: --help, -v/--version, update (self-update)

auth: ESPO_CRM_DOMAIN and ESPO_CRM_API_KEY env vars (or ./.env). With
ESPO_CRM_AUTH_USER set, the key is treated as that user's auth token (Basic
auth) - required for per-user inbox access. API Users use X-Api-Key.

all writes require --confirm. run \`espocrm-axi <command> --help\` for details.`;

function bind(handler: (args: string[], ctx: CommandContext) => Promise<unknown>): AxiCliCommand<CommandContext> {
  return handler as AxiCliCommand<CommandContext>;
}

/** The SDK strips the top-level command word; multi-word families need it re-inserted. */
function reinsert(word: string, handler: (args: string[], ctx: CommandContext) => Promise<unknown>): AxiCliCommand<CommandContext> {
  return ((args: string[], ctx: CommandContext) => handler([word, ...args], ctx)) as AxiCliCommand<CommandContext>;
}

const commands: Record<string, AxiCliCommand<CommandContext>> = {
  me: bind(meCommand),
  auth: bind(authCommand),
  record: bind(recordCommand),
  email: bind(emailCommand),
  stream: bind(streamCommand),
  post: bind(postCommand),
  search: bind(searchCommand),
  attachment: bind(attachmentCommand),
  api: bind(apiCommand),
  setup: ((args: string[]) => setupCommand(args)) as AxiCliCommand<CommandContext>,
  activities: bind(activitiesCommand),
  settings: bind(settingsCommand),
  metadata: bind(metadataCommand),
  admin: bind(adminCommand),
  currency: reinsert("currency", adminCommand),
  openapi: reinsert("openapi", adminCommand),
  i18n: reinsert("i18n", metadataCommand),
  pipelines: bind(pipelinesCommand),
  "pipeline-stages": bind(pipelinesCommand),
  pipeline: bind(pipelinesCommand),
  "pipeline-stage": bind(pipelinesCommand),
  kanban: reinsert("kanban", pipelinesCommand),
  notification: bind(notificationCommand),
  mass: bind(massCommand),
  export: bind(exportCommand),
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
