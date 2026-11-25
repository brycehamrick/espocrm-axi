---
name: espocrm-axi
description: Use espocrm-axi for EspoCRM tasks - listing, searching, creating and updating any record type, reading the inbox and sending or replying to email with delivery verification, stream posts, activities, pipelines, admin settings, mass actions, exports, and raw REST calls - instead of calling the EspoCRM REST API directly.
---

# espocrm-axi

Agent-ergonomic CLI over the EspoCRM REST API (`/api/v1`). TOON output, pre-computed
counts and status breakdowns, truncation with `--full`, structured errors on stdout,
and `help[]` next steps with concrete ids on every result.

## When to use

- CRM records (any type, custom entities included) → `espocrm-axi record list <Type> --where status=New`,
  `espocrm-axi record get <Type> <id>`, `espocrm-axi record create|update <Type> ... --set k=v --confirm`,
  `espocrm-axi record fields <Type>` to discover attributes, `espocrm-axi record types`.
  Shortcuts with convenience filters: `espocrm-axi lead list --status New --since 7d`, plus
  `espocrm-axi contact`, `espocrm-axi account`, `espocrm-axi opportunity`, `espocrm-axi case`,
  `espocrm-axi task`, `espocrm-axi meeting`, `espocrm-axi call`, `espocrm-axi note`,
  `espocrm-axi campaign`, `espocrm-axi target-list`, `espocrm-axi document`, `espocrm-axi user`,
  `espocrm-axi team`, `espocrm-axi email-template`, `espocrm-axi role`, `espocrm-axi webhook`,
  `espocrm-axi job`, `espocrm-axi scheduled-job`, `espocrm-axi product`;
  `espocrm-axi lead convert <id> --confirm`.
- Read mail → `espocrm-axi email inbox --unread --since 2d`, `email sent|archive|drafts|important|trash|all`,
  `espocrm-axi email get <id>`, `espocrm-axi email thread <id>`, `espocrm-axi email folders`.
- Send mail → `espocrm-axi email send --to a@b.com --subject "..." --text "..." --confirm` (or `--html`),
  `espocrm-axi email reply <id> --text "..." --confirm` (threads via In-Reply-To),
  `email draft`, `email send <draftId>`, `email schedule <draftId> --at "..."`.
  Delivery is verified: `delivered: true` only once EspoCRM stamps `dateSent`.
- Mailbox state → `espocrm-axi email read|unread|important|archive|trash|move <ids...>`.
- Activity feed and comments → `espocrm-axi stream`, `espocrm-axi post create <Type> <id> --text "..." --confirm`.
- Cross-entity search → `espocrm-axi search "<text>"`.
- Calendar → `espocrm-axi activities upcoming --days 14`, `activities calendar --from ... --to ...`.
- Files → `espocrm-axi attachment upload --file f.pdf`, `attachment download <id> --out <path>`.
- Bulk work → `espocrm-axi mass update --type Lead --where status=New --set source=Web --confirm`,
  `espocrm-axi export create --type Contact --format csv --confirm`, `export download <id>`.
- Pipelines → `espocrm-axi pipelines`, `espocrm-axi pipeline-stages`, `espocrm-axi pipeline move <id> --direction up --confirm`,
  `espocrm-axi pipeline-stage move`, `espocrm-axi kanban Lead`.
- Admin/platform → `espocrm-axi settings get|set`, `espocrm-axi metadata <key>`, `espocrm-axi i18n`,
  `espocrm-axi currency rates`, `espocrm-axi openapi --out file`, `espocrm-axi admin rebuild|clear-cache|jobs`,
  `espocrm-axi notification list`.
- Identity and tokens → `espocrm-axi me`, `espocrm-axi auth status`, `auth refresh --write-env`.
- Anything else → `espocrm-axi api get|post|put|delete <path>` raw escape hatch.
- Ambient context → `espocrm-axi setup hooks` (SessionStart dashboard for Claude Code / Codex / OpenCode).

## Auth

Environment variables only (or a `./.env`): `ESPO_CRM_DOMAIN` (hostname or URL) and
`ESPO_CRM_API_KEY`. With `ESPO_CRM_USERNAME` set the key is treated as that user's
auth token (Basic auth) - this is the only mode with per-user inbox access. Without it
the key is sent as `X-Api-Key` (an API User from Administration > API Users).
`ESPO_CRM_PASSWORD` lets an expired user token be re-bootstrapped automatically
(tokens expire after ~48h idle). Never print the key; the CLI redacts it from errors.

## Invocation

You do not need espocrm-axi installed - invoke it with `npx -y espocrm-axi@latest <command>`.
If a help line suggests a follow-up `espocrm-axi ...` command, run it the same way.
A global install (`npm i -g espocrm-axi`) is only needed for `setup hooks`.

## Conventions

- Flags come after the command. Unknown flags fail with exit 2 (VALIDATION_ERROR);
  runtime/API failures exit 1 with `error`/`code`/`help[]`.
- Lists show 3-6 columns (`--fields a,b` to change, `--select` to project server-side),
  a `summary` breakdown, honest totals (`more: true` when counting is disabled), and
  `--json` for raw payloads. Long text truncates; `--full` disables truncation.
- Filters: `--where attr=value` (also `!=`, `>`, `>=`, `<`, `<=`, `~=` contains,
  `=in:a,b`, `=null`, `=true`, `=lastXDays:7`, `"a=1 OR b=2"`), `--where-json` for groups,
  `--text` full-text, `--since`/`--until` (now|today|7d|24h|YYYY-MM-DD), `--limit`/`--offset`.
- Every mutation needs `--confirm` and is gated before any network call; the gate error
  previews what would happen. Per-user mailbox flags (read/important/archive/trash) are
  reversible and ungated.
- `email get` marks the message read; use `email inbox` to browse without side effects.
  Never create an Email with `status=Sent` directly - it is never transmitted.
- Secret-named fields (apiKey, password, token) are masked in all output, including `--json`.
