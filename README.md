# espocrm-axi

AXI-compliant CLI for EspoCRM — agent-ergonomic access to every record type, the
inbox, email sending with delivery verification, the activity stream, activities,
pipelines, admin settings, mass actions, and exports over the EspoCRM REST API.
Built on the [AXI](https://axi.md/) principles.

```
$ espocrm-axi
bin: ~/.local/bin/espocrm-axi
description: "EspoCRM for agents - records for any entity type, inbox and email sending, ..."
auth: basic (ada)
instance: "https://crm.example.com"
user: Ada Lovelace
leads: "42"
contacts: "310"
accounts: "87"
opportunities: "12"
open_cases: "3"
open_tasks: "7"
inbox_unread: 5
help[4]:
  Run `espocrm-axi email inbox --unread` to see unread mail
  Run `espocrm-axi record list <Type> --where status=New` for any entity
  ...
```

## Install

```
npm install -g espocrm-axi
```

Or run on demand: `npx -y espocrm-axi@latest <command>`. Install the agent skill:

```
npx -y skills@latest add brycehamrick/espocrm-axi --skill espocrm-axi -g
```

## Authentication

Environment variables only (or a `./.env`; real env vars win):

| Variable | Purpose |
| --- | --- |
| `ESPO_CRM_DOMAIN` | Hostname or URL of the instance (`crm.example.com`) |
| `ESPO_CRM_AUTH_MODE` | `api-key` \| `basic` \| `hmac` \| `auto` (default: basic when a username is set) |
| `ESPO_CRM_API_KEY` | API User key (`X-Api-Key`), or an optional stored user token in basic mode |
| `ESPO_CRM_AUTH_USER` / `ESPO_CRM_AUTH_PASSWORD` | Live user credential: bootstraps a token per run (`ESPO_CRM_USERNAME`/`ESPO_CRM_PASSWORD` work as aliases) |
| `ESPO_CRM_SECRET_KEY` | For `hmac` (API User with HMAC auth) |
| `ESPO_CRM_WHERE_STYLE` | `auto` \| `where` \| `whereGroup` (WAF workaround) |

Two ways to authenticate - pick explicitly with `ESPO_CRM_AUTH_MODE`:

- **`api-key`** - an API User (Administration > API Users, auth method *API Key*).
  Good for records, stream, admin - but API users **have no inbox**.
- **`basic`** - a live user credential (`ESPO_CRM_AUTH_USER` + `ESPO_CRM_AUTH_PASSWORD`),
  the way the CRM UI authenticates. The CLI bootstraps a fresh token every run it
  needs one (tokens expire after ~48h idle) and re-bootstraps on a stale stored
  token. This is the only mode with inbox/team-folder access and per-user state,
  and the one to use for sending. `auth refresh --write-env` persists a token.

Keys are redacted from every error; `apiKey`/`password`/`token` attributes returned by
the server are masked in all output, including `--json`.

## Commands

| Group | What it covers |
| --- | --- |
| `record types\|fields\|links\|list\|get\|count\|create\|update\|delete\|link\|unlink\|related\|stream\|followers\|follow\|star` | Generic engine for **any** entity type incl. custom ones |
| `lead`, `contact`, `account`, `opportunity`, `case`, `task`, `meeting`, `call`, `note`, `campaign`, `target-list`, `document`, `user`, `team`, `email-template`, `role`, `webhook`, `job`, `scheduled-job`, `product` | Shortcuts with convenience filters (`--status`, `--assigned <name>`, `--email`, `--account`); `lead convert` |
| `email inbox\|sent\|archive\|drafts\|important\|trash\|all`, `get`, `thread`, `send`, `reply`, `draft`, `schedule`, `read\|unread\|important\|archive\|trash\|move`, `folders`, `accounts`, `templates`, `address-search`, `import-eml`, `send-test` | Mail with delivery verification and per-user mailbox state |
| `stream`, `post create\|pin\|react\|reactors` | Activity feed and comments |
| `search "<text>"` | Global full-text search |
| `activities upcoming\|calendar\|meetings\|calls\|tasks` | Calendar |
| `attachment upload\|download\|get\|delete\|list` | Files |
| `mass update\|delete\|follow\|unfollow\|remove-from-team\|convert-currency\|run`, `export create\|status\|download` | Bulk operations |
| `pipelines`, `pipeline-stages`, `pipeline move`, `pipeline-stage move`, `kanban <Type>` | Deal pipelines |
| `settings list\|get\|set`, `metadata <key>`, `i18n`, `currency`, `openapi --out`, `admin rebuild\|clear-cache\|jobs`, `notification list\|groups\|mark-read` | Administration |
| `me`, `auth status\|refresh` | Identity and tokens |
| `api get\|post\|put\|patch\|delete <path>` | Raw REST escape hatch (see [docs/api-coverage.md](docs/api-coverage.md)) |
| `setup hooks\|status\|remove` | Ambient session context for Claude Code / Codex / OpenCode |

Every command supports `--help`; data commands support `--json` and `--full`.

## Examples

```
# Browse (no side effects) and read one (marks read)
espocrm-axi email inbox --unread --since 2d --limit 10
espocrm-axi email get 6b06...

# Send and verify; send as a shared team mailbox; reply with threading (dry-run first)
espocrm-axi email send --to ada@example.com --subject "Welcome" --text "Hello Ada" --confirm
espocrm-axi email send --from collabs@example.com --to ada@example.com --subject "Hi" --text "..." --dry-run
espocrm-axi email reply 6b06... --text "Thanks, looping in Ada." --attach brief.pdf --confirm

# Team / group inbox folder by name
espocrm-axi email folder Collabs --unread --since 7d

# Records: generic engine + filters
espocrm-axi record list Opportunity --where "amount>1000" --where stage=in:New,Prospecting --since 30d
espocrm-axi lead list --status New --assigned bryce --limit 5
espocrm-axi record create Note --set parentType=Lead --set parentId=<id> --set type=Post --set post="Called, voicemail" --confirm
espocrm-axi lead convert <id> --account "Acme" --amount 5000 --stage Prospecting --confirm

# Bulk + admin
espocrm-axi mass update --type Lead --where status=New --set source=Webinar --confirm
espocrm-axi export create --type Contact --format csv --confirm && espocrm-axi export download <id> --out contacts.csv
espocrm-axi admin clear-cache --confirm
```

## Safety

- **Every mutation requires `--confirm`**, verified before any network request; the
  gate error previews exactly what would happen. Reversible per-user mailbox flags
  (`read`, `important`, `archive`, `trash`) are the documented exception.
- Email never claims delivery it cannot prove: `delivered: true` only once the server
  stamps `dateSent`; SMTP failures come back as the kept Draft id. See
  [docs/email.md](docs/email.md).
- Writes never prompt; unknown flags fail with exit 2; nothing is written to disk
  except where you say (`--out`, `auth refresh --write-env`).

## Output and exit codes

Compact [TOON](https://toonformat.dev/) by default; `--json` opt-in. Empty results
are explicit (`0 emails in drafts`). Exit codes: `0` success, `2`
usage/validation/missing `--confirm`, `1` runtime or API failure.

| AxiError code | EspoCRM signal |
| --- | --- |
| `VALIDATION_ERROR` | 400 (`Empty To address.`...), bad flags, missing `--confirm` |
| `AUTH_REQUIRED` | 401 (bad/expired credential), 403 (role lacks scope, WAF) |
| `NOT_FOUND` | 404 |
| `CONFLICT` | 409 (locked record, duplicate) |
| `RATE_LIMITED` | 429 |
| `TIMEOUT` / `NETWORK_ERROR` | transport |
| `API_ERROR` | other 5xx incl. `sendingFail` |

## Development

```
npm install
npm run check         # typecheck + secret scan + tests (builds dist first) + skill check
npm run build         # tsc -> dist/ (committed; rebuild on change)
```

Tests pass with no credentials; the smoke test runs the built binary with
`ESPO_CRM_*` stripped. Live smoke testing should stay read-only (home, one list,
one detail) - never run mutation commands against a real account from CI.

## License

MIT
