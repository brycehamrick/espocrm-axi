# Email: how EspoCRM sends and receives, and how this CLI wraps it

EspoCRM is not a mail API first - it is a CRM whose `Email` entity doubles as the
mailbox UI. Four behaviours surprise every integration; the CLI encodes all of them.

## 1. Sending is a status transition, not an endpoint

- `POST /Email` (or `PUT /Email/{id}`) with `status: "Sending"` makes the server
  transmit the message **synchronously** through the account's SMTP (`Services\Email`
  → `Tools\Email\SendService`). On success it saves the record with `status: Sent`
  and a `dateSent` stamp, links the SMTP account, and notes "email sent" on the
  parent's stream.
- Creating a record with `status: "Sent"` directly **never transmits** - the server
  treats it as already delivered. The hermes pr-agent lost 19 pitches this way.
- On SMTP failure the server resets the record to `Draft` and answers HTTP 500 with
  `{"id": "...", "message": "..."}` (`ErrorSilent`). The CLI surfaces that as an
  `API_ERROR` naming the draft id so it can be resent.
- Empty `to` → 400 `Empty To address.` and the record becomes a Draft.
- `from` must be an address the authenticated user can send as: one of their own
  email addresses (personal SMTP account), a shared group-account address, or the
  shared system outbound address. Admins bypass the check. The CLI defaults
  `--from` to the authenticated user's `emailAddress` from `App/user`.
- Older v7 instances queue `Sending` for the cron job instead. `email send` therefore
  polls `GET /Email/{id}` (every 3s, up to `--wait`, default 30s) until `dateSent`
  is set and only then reports `delivered: true`.

Replies: set `repliedId` to the original. The server adds `In-Reply-To`/`References`
headers from the original `messageId`, copies the group folder, and flags the
original `isReplied`. `email reply` derives `to` (`replyToAddress`, else sender),
`Re:` subject, and parent from the original.

Scheduling: only Drafts accept `sendAt`; the "Send Scheduled Emails" job transmits
them. `email schedule <draftId> --at "YYYY-MM-DD HH:mm"` (UTC).

Attachments are `Attachment` records uploaded first (`POST /Attachment` with a
base64 data URL, `relatedType: "Email"`, `field: "attachments"`), then referenced as
`attachmentsIds` on the Email.

## 2. The inbox is per user, not a status

- Inbox membership lives in the `email_user` table (`inArchive`, `inTrash`,
  `isRead`, `isImportant`, `folderId`) keyed by **the authenticated user**. Listing
  uses a `where` item `{type: "inFolder", attribute: "folderId", value: "inbox"}`,
  which joins that table for the current user.
- Inbound messages fetched by the IMAP job have `status: "Archived"` - the status is
  not the inbox indicator. Filtering `status=Inbox` returns nothing.
- Consequence: **an API User (`X-Api-Key`) has no inbox**. Inbox, sent, drafts,
  archive, read/important flags need a regular user's auth token
  (`ESPO_CRM_USERNAME` + `ESPO_CRM_API_KEY` sent as `Authorization: Basic
  base64(user:token)`), run as the mailbox owner. With an API key, use
  `record list Email --where ...` for entity-level access only.
- Unread counts come from `GET /Email/inbox/notReadCounts` (`inbox`, `drafts`,
  `group:<folderId>`); the CLI folds them into `email inbox` and `email folders`.

## 2b. Team / group inboxes

- A group mailbox (`InboundEmail`, e.g. `collabs@example.com`) delivers into a
  `GroupEmailFolder` ("Collabs") tied to a team. Users on the team list it with
  `inFolder` = `group:<folderId>` (`email folder Collabs`, or `group:` for all group
  mail); unread counts arrive as `group:<folderId>` keys.
- Sending **as** the team inbox is `--from collabs@example.com`: the server accepts it
  when the group account is shared with you and has SMTP. A fresh send lands in your
  Sent view (`groupFolderId` null). A **reply** to a group-folder message inherits the
  group folder and, in this CLI, defaults `--from` to that mailbox.
- `email send|reply --dry-run` prints the resolved payload (from/to/subject/parent/
  repliedId) without uploading or sending.

## 3. Reading marks as read

`GET /Email/{id}` runs a `MarkAsRead` before-read hook for the current user. There is
no server flag to skip it. Browse with `email inbox` (list endpoint, no hook) and
call `email get` only when you want the body (and the read receipt). `email unread
<id>` restores the flag.

## 4. Counting is disabled for Email lists

`total` is `-1` (more exist) or `-2` (no more) instead of a number. The CLI renders
`more: true` and suggests `--offset`.

## WAF note

Some Cloudflare-fronted instances answer `where[0][type]=...` with an empty 500.
v9.0 added the `whereGroup` alias for exactly this case; the client retries once with
it and remembers the working style (`ESPO_CRM_WHERE_STYLE=where|whereGroup` pins it).

## Token lifetime (basic mode)

User auth tokens expire after `authTokenMaxIdleTime` (48h by default) of inactivity.
Every command validates the token on first use and, when `ESPO_CRM_PASSWORD` is set,
re-bootstraps a fresh one from `GET /App/user` (`Espo-Authorization: base64(user:pass)`)
for the rest of that process. `espocrm-axi auth refresh --write-env` persists it to
`.env` for cron-style consumers. Repeated failed attempts trip a temporary 401→403
lockout on the server; the client never retries authentication more than once.
