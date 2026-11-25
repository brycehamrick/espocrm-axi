# AGENTS.md

Guidance for AI agents working in this repository.

## What this is

`espocrm-axi` is an AXI-compliant CLI over the EspoCRM REST API (`/api/v1`). It is
meant for the [AXI catalog](https://axi.md/). Keep the AXI principles in mind for
every change:

1. TOON output by default, `--json` opt-in
2. 3-6 column list schemas by default (`--fields` to change)
3. Truncate with size hints, `--full` escape hatch
4. Pre-computed aggregates (counts, status breakdowns, unread counts)
5. Definitive empty states ("0 results")
6. Structured errors on stdout; exit 2 usage / 1 runtime; unknown flags fail loud;
   never prompt
7. Ambient context via `setup hooks`, opt-in only
8. No-args home view is live content, not help
9. `help[]` next steps with concrete ids after output
10. Every command has a concise `--help` returned as a bare string

## Hard rules

- **Never commit or print secrets.** `ESPO_CRM_*` stay in the environment (or an
  ignored `./.env`). `npm run secrets:check` scans before every commit (print file
  names only). Tests must pass with no credentials; the smoke test strips
  `ESPO_CRM_*`. Never echo a key, token, password, real domain, or real record data
  into tests, docs, examples, README, or memory notes.
- **Server responses can carry secrets** (`User.apiKey`, `EmailAccount.smtpPassword`).
  Every render path goes through `redactSecrets()` / `displayRecord()` / `projectRows()`;
  raw `--json` paths use `scrub()`. Add a test when you add an output path.
- **Network access lives in `src/api/client.ts` only.** Commands receive a client
  via `CommandContext`; tests use `test/helpers.ts` (`contextFor`) with scripted
  responses. No `fetch` in command code (the one exception is `auth refresh`, which
  must bootstrap a token with the password header the client never stores).
- **Mutations require `--confirm`, verified before any network call** - including
  lookups the mutation needs. A test must exist for each gate proving zero requests
  without it. Reversible per-user mailbox flags (read/important/archive/trash) and
  follow/star are the documented exceptions.
- **Validate flags before credentials**: `parseFlags` + flag validation first,
  `requireAuth(ctx)` second, network last - so `--help` and usage errors never need a
  configured instance.
- **Exit codes:** only `AxiError` with `VALIDATION_ERROR` maps to exit 2 (the SDK's
  `exitCodeForError` owns this). Always throw `AxiError`, never a plain `Error`.
- **The SDK strips the top-level command word.** A handler bound to several names
  (`kanban`, `pipeline`, `currency`, `openapi`, `i18n`) must be wrapped with
  `reinsert()` in `src/index.ts` so it still sees its own word.
- **Commit `dist/` with every source change** (`npm run build`; `npm test` rebuilds
  first via `pretest`). The build output ships in the repo so clone-and-run works.
- **Help is a bare string**; `{ help_text }` renders as an escaped one-liner.
- **Uniform row keys**: build list rows with `projectRows()` (null for missing
  columns) so TOON keeps the tabular form; use plain array keys (`leads`), never a
  hand-rolled `leads[3]{...}` key.
- **Credentials in basic mode are short-lived user tokens.** Env names: `ESPO_CRM_AUTH_USER` /
  `ESPO_CRM_AUTH_PASSWORD` (primary), `ESPO_CRM_USERNAME` / `ESPO_CRM_PASSWORD` (aliases),
  `ESPO_CRM_API_KEY` optional stored token. The client bootstraps a token in-process when
  none is stored and again on 401 when the password is set, retries once, and never writes
  it anywhere except `auth refresh --write-env`. Never retry auth more than once: the
  server escalates 401 to a 403 lockout after a handful of failures.

## Layout

```
bin/espocrm-axi.js     entrypoint; fast-path version probe, then dist/
src/index.ts           runAxiCli registration (COMMAND_HELP from command-help.ts)
src/command-help.ts    COMMAND_NAMES + COMMAND_HELP: --help, home view, skill check
src/lib/               args (strict parseArgs, --set DSL), where (where DSL + encoding),
                       params (list flags), records (list rendering), resolve (names -> ids),
                       entities (per-type presets + shortcuts), env (config + redaction),
                       dotenv, output, truncate, coerce, time, attachment, auth
src/api/client.ts      REST client: auth modes, token bootstrap, X-Status-Reason errors,
                       WAF where->whereGroup fallback, downloads
src/commands/          one file per family: home, me, auth, record, entities (shortcuts),
                       email, stream, search, attachment, activities, tools, mass, api, setup
test/                  vitest; helpers.ts scripted-fetch harness; smoke.test.ts runs the binary
skills/espocrm-axi/    installable agent skill (SKILL.md) - every command must appear
scripts/               check-skill.mjs, scan-secrets.mjs
docs/                  api-coverage.md (every route -> command), email.md (send/receive gotchas)
catalog-contribution/  catalog.yaml entry + no-mistakes runbook (no PR until Bryce says so)
```

## Commands

```
npm run typecheck
npm run secrets:check
npm test              # pretest builds dist/
npm run skill:check
npm run check         # all of the above
```

Run locally with `node bin/espocrm-axi.js` (after `npm run build`). Live smoke tests
stay read-only (home, one list, one detail) and only against an instance Bryce
pointed you at; never run mutation commands against a real account from CI or agent
sessions without an explicit ask.

## EspoCRM behaviours to respect

- Sending = `status: "Sending"` (create or PUT); never `status: "Sent"`. Verify
  `dateSent`; failures return HTTP 500 `{id, message}` and leave a Draft.
- Inbox membership is per user (`email_user`), so inbox/sent/drafts/archive/read
  flags require a live user credential (`ESPO_CRM_AUTH_MODE=basic`), not an API key.
- Team/group folders are listed with `inFolder` = `group:<GroupEmailFolder id>`
  (`email folder <name>`); their unread counts are keyed `group:<id>`. Replying to a
  group-folder email sends from that mailbox by default; fresh sends from the group
  address land in the user's Sent view, not the folder, and the folder listing hides
  the user's own sent replies (server rule) - point agents at `email sent`/`thread`.
- `email send|reply|draft --dry-run` resolves everything and prints the payload
  without uploading or sending - use it for live verification of derived fields.
- `GET /Email/{id}` marks read. Email lists have counting disabled (`total` -1/-2).
- Error messages travel in the `X-Status-Reason` header; bodies are often empty.
- Datetimes are UTC `YYYY-MM-DD HH:mm:ss`; compare after normalizing.

## Conventions

- New commands: add the module under `src/commands/`, register it in `src/index.ts`
  and `src/command-help.ts` (names + help), mention `espocrm-axi <command>` in
  `skills/espocrm-axi/SKILL.md` (`skill:check` fails otherwise), extend README +
  `docs/api-coverage.md`, and add tests (gate + payload + empty state).
