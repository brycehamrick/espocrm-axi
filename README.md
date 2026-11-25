# espocrm-axi

AXI-compliant CLI for [EspoCRM](https://www.espocrm.com/) — built for AI agents and
shell users who want every record type, the inbox, verified email sending, the
activity stream, activities, pipelines, admin settings, bulk actions, and exports
from one token-efficient command line over the EspoCRM REST API (`/api/v1`).
Built on the [AXI](https://axi.md/) principles: TOON output, 3–6 column lists,
truncation with `--full`, pre-computed counts, explicit empty states, structured
errors, `help[]` next steps with real ids, and `--confirm`-gated mutations.

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
open_cases: "3"
open_tasks: "7"
inbox_unread: 5
help[4]:
  Run `espocrm-axi email inbox --unread` to see unread mail
  Run `espocrm-axi record list <Type> --where status=New` for any entity (custom types included)
  ...
```

## Install

```
npm install -g espocrm-axi          # or run on demand: npx -y espocrm-axi@latest <command>
```

Install the agent skill so your agent knows when and how to use it:

```
npx -y skills@latest add brycehamrick/espocrm-axi --skill espocrm-axi -g
```

Optional ambient context (a dashboard at the start of every Claude Code / Codex /
OpenCode session): `espocrm-axi setup hooks`.

## Authentication

Everything comes from environment variables (a `./.env` in the working directory
also works; real env vars win). Pick the mode explicitly with `ESPO_CRM_AUTH_MODE`:

| Variable | Purpose |
| --- | --- |
| `ESPO_CRM_DOMAIN` | **Required.** Hostname or URL of the instance, e.g. `crm.example.com` |
| `ESPO_CRM_AUTH_MODE` | `api-key` \| `basic` \| `hmac` \| `auto` (default: `basic` when a username is set, else `api-key`) |
| `ESPO_CRM_API_KEY` | **`api-key`:** the API User key (Administration > API Users, auth method *API Key*). **`basic`:** optional stored auth token |
| `ESPO_CRM_AUTH_USER` / `ESPO_CRM_AUTH_PASSWORD` | **`basic`:** a live user's username and password — a token is bootstrapped on demand (aliases: `ESPO_CRM_USERNAME` / `ESPO_CRM_PASSWORD`) |
| `ESPO_CRM_SECRET_KEY` | `hmac` only: the API User's secret key |
| `ESPO_CRM_WHERE_STYLE` | `auto` \| `where` \| `whereGroup` — pin the query encoding if a WAF blocks `where[...]` |
| `ESPO_CRM_TIMEOUT_MS` | Request timeout (default 60000) |

### Which mode do I need?

**`api-key` — an API User.** Best for integrations and record work: leads,
contacts, opportunities, cases, notes, stream, settings, exports. Create it under
*Administration > API Users* with the *API Key* method and a Role that grants the
scopes you need. Limitation: an API user **has no inbox** and cannot send email —
inbox, sent, drafts, read/archive flags and sending all belong to real users.

```sh
export ESPO_CRM_DOMAIN=crm.example.com
export ESPO_CRM_AUTH_MODE=api-key
export ESPO_CRM_API_KEY=<32-character key from the API User record>
espocrm-axi me                # shows the API user and its scope access
```

**`basic` — a live user.** The way the web UI authenticates, and the only mode that
can read a user's inbox (including team/group folders), send as that user or as a
shared team mailbox, and see per-user read/archive state. You do not need to manage
tokens: the CLI bootstraps one from the password whenever it is missing or expired
(EspoCRM expires them after ~48h idle) and refreshes it in-process on a stale one.

```sh
export ESPO_CRM_DOMAIN=crm.example.com
export ESPO_CRM_AUTH_MODE=basic
export ESPO_CRM_AUTH_USER=ada
export ESPO_CRM_AUTH_PASSWORD='...'
espocrm-axi me                # shows the user, teams, and scope access
```

`espocrm-axi auth status` checks the credential; `espocrm-axi auth refresh --write-env`
bootstraps a fresh token and stores it in `ESPO_CRM_API_KEY` inside `.env` (saves one
request per run; useful for cron-style consumers). Repeated wrong credentials make
EspoCRM answer `403` for a few minutes — wait instead of retrying.

## Usage

Every command supports `--help` (run `espocrm-axi <command> --help`), `--json` for the
raw API payload and `--full` to disable truncation. Flags go **after** the command.

### 1. Discover the instance

```
espocrm-axi                                   # live dashboard: who you are, counts, unread mail
espocrm-axi record types                      # every entity type (81 on a stock instance), incl. custom ones
espocrm-axi record fields Lead                # attributes, types, required flags, enum options
espocrm-axi record fields Lead email          # ...filtered by substring
espocrm-axi record links Contact              # relationship names for link/unlink/related
```

### 2. List and read records (any type)

```
espocrm-axi record list Lead --limit 10
espocrm-axi record list Opportunity --where "amount>1000" --where "stage=in:New,Prospecting" --since 30d
espocrm-axi record list Case --text "refund" --order-by createdAt --fields id,name,status,priority
espocrm-axi record list MyCustomEntity --where status=Open       # custom entity types work the same way
espocrm-axi record get Lead 6ac6b8a0ec72ec96d
espocrm-axi record get Lead 6ac6b8a0ec72ec96d --fields name,status,emailAddress,description
espocrm-axi record count Lead --where status=New
espocrm-axi search "Brighten"                                     # global full-text search across types
espocrm-axi record related Lead 6ac6b8a0ec72ec96d emails         # emails linked to a record
espocrm-axi record stream Lead 6ac6b8a0ec72ec96d                  # posts + field changes
```

**Filter DSL** (`--where`, repeatable; `--where-json` for raw items):

| Clause | Meaning |
| --- | --- |
| `status=New` · `status!=New` | equals / not equals |
| `amount>1000` `>=` `<` `<=` | comparisons (numbers are coerced) |
| `name~=Brighten` · `name^=Dr` · `name$=Inc` | contains / starts with / ends with |
| `assignedUserId=null` · `!=null` | is null / is not null |
| `doNotCall=true` · `=false` | boolean |
| `status=in:New,Assigned` · `=notIn:...` | lists |
| `teams=linkedWith:<teamId>` | relationship membership |
| `createdAt=lastXDays:7` · `=today` · `=currentMonth` | dated operators |
| `"status=New OR status=Assigned"` | OR group (AND between clauses) |

Other list flags: `--text "<q>"` (full text), `--since`/`--until` (`now`, `today`,
`7d`, `24h`, `2026-11-01`, ISO 8601; `--date-field` picks the attribute, default
`createdAt`), `--limit` (default 20, max 200), `--offset`, `--order-by`, `--order`,
`--primary-filter`, `--bool-filter onlyMy`, `--select` (server-side projection),
`--fields` (output columns).

### 3. Shortcuts for the core CRM types

`lead`, `contact`, `account`, `opportunity`, `case`, `task`, `meeting`, `call`,
`note`, `campaign`, `target-list`, `document`, `user`, `team`, `email-template`,
`role`, `webhook`, `job`, `scheduled-job`, `product` — each is the generic engine with
the type pre-bound, plus convenience filters that accept names or ids:

```
espocrm-axi lead list --status New --assigned bryce --since 7d
espocrm-axi contact list --email ada@example.com
espocrm-axi opportunity list --account "Acme" --stage Prospecting
espocrm-axi task list --limit 10                   # tasks due first
espocrm-axi lead get 6ac6b8a0ec72ec96d
```

### 4. Create, update, delete, relate (all need `--confirm`)

Attributes are set with `--set key=value` (numbers/booleans/arrays/`null` are
coerced; quote values with spaces) or `--attr '{json}'`. Without `--confirm` nothing
happens — the error previews what would be done.

```
espocrm-axi record create Lead --set firstName=Ada --set lastName=Lovelace --set emailAddress=ada@example.com \
    --set accountName="Analytical Engines" --set status=New --assignee bryce --teams collabs --confirm
espocrm-axi lead update 6ac6b8a0ec72ec96d --set status=Assigned --set "description=Called, interested." --confirm
espocrm-axi record create Note --set parentType=Lead --set parentId=<id> --set type=Post --set post="Left a voicemail" --confirm
espocrm-axi record link Contact <id> opportunities <oppId> --confirm
espocrm-axi record unlink Contact <id> opportunities <oppId> --confirm
espocrm-axi record delete Task <id> --confirm
espocrm-axi record follow Lead <id>        # follow/unfollow/star/unstar are per-user, reversible, ungated
```

`lead convert` mirrors the UI's conversion (creates Account + Contact + Opportunity,
then marks the lead converted):

```
espocrm-axi lead convert <id> --account "Acme" --opportunity "Analytics pilot" --amount 5000 --stage Prospecting --close-date 2026-12-31 --confirm
espocrm-axi lead convert <id> --skip-opportunity --confirm
```

### 5. Email — read

Per-user folders need `basic` mode (see Authentication). Browsing never marks mail as
read; `email get` does (that is EspoCRM's read hook — restore with `email unread`).

```
espocrm-axi email inbox --unread --since 2d --limit 10
espocrm-axi email inbox --from notifications@example.com
espocrm-axi email sent --limit 5
espocrm-axi email archive | drafts | important | trash | all
espocrm-axi email folders                                  # personal + team folders, unread counts, filter ids
espocrm-axi email folder Collabs --unread                  # a team/group inbox folder by name (or id)
espocrm-axi email get 6b06208f8804960ff                     # headers + body (marks read); --html for raw HTML, --full for all
espocrm-axi email thread 6b06208f8804960ff                  # the message and its replies, oldest first
espocrm-axi email read 6b06... 6b07...                     # read / unread / important / unimportant <ids...>
espocrm-axi email archive 6b06...                          # archive / unarchive / trash / untrash <ids...>
espocrm-axi email move 6b06... --folder group:03adfc...    # or a personal folder id
```

`email inbox` carries `unread_inbox`; lists with counting disabled report `more: true`
and suggest `--offset`. `email address-search --q ada@example.com --type Lead` finds
who owns an address; `email templates`, `email template prepare <id> --parent-type
Lead --parent-id <id>` render a template for a record; `email accounts` / `email
inbound` list personal and group mailboxes (passwords are masked).

### 6. Email — send, reply, schedule

Sending creates the record with `status=Sending`; EspoCRM transmits it through the
account's SMTP and stamps `dateSent`. The CLI only reports `delivered: true` once that
stamp exists (older instances send via cron — `--wait` extends the verification
window). An SMTP failure comes back as the kept Draft id. **Never create an Email with
`status=Sent` directly — it is never transmitted.** Add `--dry-run` to print the exact
payload without uploading or sending.

```
# Send (from defaults to your own address)
espocrm-axi email send --to ada@example.com --subject "Welcome" --text "Hello Ada,\n\n..." --confirm
espocrm-axi email send --to ada@example.com,grace@example.com --cc bob@example.com --subject "Spec" \
    --html-file body.html --attach brief.pdf --attach-id <existingAttachmentId> --confirm
espocrm-axi email send --to ada@example.com --subject "Hi" --text "..." --parent-type Lead --parent-id <id> --confirm

# Send as a shared team mailbox (the account must be shared with you and have SMTP)
espocrm-axi email send --from collabs@example.com --to ada@example.com --subject "Hi" --text "..." --dry-run
espocrm-axi email send --from collabs@example.com --to ada@example.com --subject "Hi" --text "..." --confirm

# Reply: derives Re:, recipient (reply-to, else sender), parent record; threads via In-Reply-To;
# inside a team folder it sends from that mailbox by default
espocrm-axi email reply <emailId> --text "Thanks, looping in Ada." --confirm
espocrm-axi email reply <emailId> --text "..." --all --confirm          # --all keeps the original cc

# Drafts and scheduling
espocrm-axi email draft --to ada@example.com --subject "Later" --text "..." --confirm
espocrm-axi email send <draftId> --confirm                              # queue an existing draft now
espocrm-axi email schedule <draftId> --at "2026-12-01 09:00" --confirm  # UTC; sent by the cron job
```

### 7. Stream, activities, files

```
espocrm-axi stream --limit 10
espocrm-axi post create Case <id> --text "Called the customer, pending callback." --attach notes.txt --confirm
espocrm-axi post react <noteId> --type Like          # also unreact / reactors / pin / unpin
espocrm-axi activities upcoming --days 14
espocrm-axi activities calendar --from 2026-12-01 --to 2026-12-07 --agenda
espocrm-axi attachment upload --file report.pdf                      # prints an id for attachmentsIds / fileId
espocrm-axi attachment download <id> --out ~/Downloads/
```

### 8. Bulk work, pipelines, admin

```
espocrm-axi mass update --type Lead --where status=New --set source=Webinar --confirm
espocrm-axi mass delete --type Task --ids a,b,c --confirm             # also follow/unfollow/remove-from-team/convert-currency/run
espocrm-axi export create --type Contact --where "createdAt=lastXDays:30" --format csv --confirm
espocrm-axi export status <id> && espocrm-axi export download <id> --out contacts.csv

espocrm-axi pipelines --type Opportunity
espocrm-axi pipeline-stages --pipeline <id>
espocrm-axi kanban Lead --max 5
espocrm-axi notification list --unread

espocrm-axi settings get outboundEmailIsShared
espocrm-axi settings set outboundEmailFromName '"No Reply"' --confirm
espocrm-axi metadata entityDefs.Lead.links --scope Lead
espocrm-axi i18n --locale de_DE
espocrm-axi currency rates
espocrm-axi openapi --out openapi.json          # the instance's OpenAPI 3.1 spec (v9.3+)
espocrm-axi admin jobs
espocrm-axi admin rebuild --confirm              # after Entity Manager / extension changes
espocrm-axi admin clear-cache --confirm
```

### 9. Anything else: the raw escape hatch

Paths are relative to `/api/v1`; reads are free, writes need `--confirm`;
[docs/api-coverage.md](docs/api-coverage.md) maps every EspoCRM route to a command.

```
espocrm-axi api get Lead/<id>/followers
espocrm-axi api get Metadata --query key=scopes
espocrm-axi api put Preferences/<userId> --body '{"timezone":"UTC"}' --confirm
espocrm-axi api post Team/<id>/userPosition --body '{"id":"<userId>","position":"Manager"}' --confirm
```

## Output and exit codes

Compact [TOON](https://toonformat.dev/) by default (lists render one line per row when
all rows share columns; a `summary` line gives the status breakdown); `--json` opts
into raw payloads; `--full` disables truncation. Empty results are explicit
(`0 emails in drafts`). Errors are structured on stdout: `error`, `code`, `help[]`.

| Exit code | Meaning |
| --- | --- |
| `0` | success |
| `2` | usage / validation / missing `--confirm` (`VALIDATION_ERROR`) — nothing was sent to the server |
| `1` | runtime or API failure |

| `code` | EspoCRM signal |
| --- | --- |
| `AUTH_REQUIRED` | 401 (bad or expired credential), 403 (role lacks the scope, or WAF) |
| `NOT_FOUND` | 404 |
| `CONFLICT` | 409 (locked record, duplicate) |
| `RATE_LIMITED` | 429 |
| `TIMEOUT` / `NETWORK_ERROR` | transport problems |
| `API_ERROR` | other 5xx, including SMTP `sendingFail` |

## Safety

- **Every mutation requires `--confirm`**, validated before any network request; the
  gate error previews recipients/attributes/ids. Reversible per-user flags (`read`,
  `important`, `archive`, `trash`, `follow`, `star`) are the documented exceptions.
- **Email never claims delivery it cannot prove** — see [docs/email.md](docs/email.md)
  for how EspoCRM sends and receives and why the inbox is per-user.
- **Secrets stay out of transcripts**: the key, password, and token are redacted from
  errors, and attributes named `apiKey`/`password`/`token`/`secret` returned by the
  server are masked in every output path, including `--json`.
- Nothing is written to disk except where you say (`--out`, `auth refresh --write-env`).

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `401` then `403` on every call | Wrong mode or credential; EspoCRM locks out repeated failures for a few minutes. A user **token** must be sent in `basic` mode, an API User key in `api-key` mode. |
| `AUTH_REQUIRED ... needs ESPO_CRM_AUTH_PASSWORD` | `basic` mode with a stale stored token and no password to refresh it |
| `email inbox` is empty but the UI shows mail | You are in `api-key` mode (API users have no inbox) — switch to `basic` |
| `HTTP 500` with an empty body on list filters | A WAF is blocking `where[...]`; the client retries once with `whereGroup` — pin it with `ESPO_CRM_WHERE_STYLE=whereGroup` |
| ` EspoCRM ... failed: <smtp message>` after a send | The SMTP account refused the message; the record was kept as a Draft — fix the account and `email send <id> --confirm` |
| Fresh sends from a team mailbox are not in the team folder | EspoCRM puts them in your Sent view; only replies inherit the folder, and the folder listing hides your own sent mail (use `email sent` / `email thread`) |

## Development

```
npm install
npm run check          # typecheck + secret scan + tests (builds dist/ first) + skill check
npm run build          # tsc -> dist/ (committed; rebuild on change)
node bin/espocrm-axi.js <command>   # run the built CLI locally
```

Tests pass with no credentials (scripted HTTP in `test/helpers.ts`; the smoke test
runs the binary with `ESPO_CRM_*` stripped). Live smoke tests stay read-only unless
you have been asked to send something. See `AGENTS.md` for the rules and
`catalog-contribution/README.md` for publishing and the AXI catalog entry.

## License

MIT
