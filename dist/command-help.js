import { AUTH_HELP } from "./commands/auth.js";
import { ME_HELP } from "./commands/me.js";
import { RECORD_HELP } from "./commands/record.js";
import { shortcutHelp, SHORTCUTS } from "./commands/entities.js";
import { EMAIL_HELP } from "./commands/email.js";
import { STREAM_HELP } from "./commands/stream.js";
import { SEARCH_HELP } from "./commands/search.js";
import { ATTACHMENT_HELP } from "./commands/attachment.js";
import { API_HELP } from "./commands/api.js";
import { SETUP_HELP } from "./commands/setup.js";
/**
 * Single source of truth for the command surface: drives `--help`, the
 * top-level help, the home view's command list, and the skill drift check
 * (scripts/check-skill.mjs verifies every name here appears in SKILL.md).
 */
export const COMMAND_NAMES = [
    "me",
    "auth",
    "record",
    "email",
    "stream",
    "post",
    "search",
    "attachment",
    "api",
    "setup",
    ...Object.keys(SHORTCUTS),
];
export const COMMAND_HELP = {
    me: ME_HELP,
    auth: AUTH_HELP,
    record: RECORD_HELP,
    email: EMAIL_HELP,
    stream: STREAM_HELP,
    post: STREAM_HELP,
    search: SEARCH_HELP,
    attachment: ATTACHMENT_HELP,
    api: API_HELP,
    setup: SETUP_HELP,
    ...Object.fromEntries(Object.entries(SHORTCUTS).map(([name]) => [name, shortcutHelp(name)])),
};
