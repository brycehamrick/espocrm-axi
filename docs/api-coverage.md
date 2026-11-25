# API coverage

Every route in EspoCRM's `application/Espo/Resources/routes.json` and
`application/Espo/Modules/Crm/Resources/routes.json` (master, verified against a
10.0.11 instance), mapped to the `espocrm-axi` command that exercises it. Anything
without a first-class command is reachable through `espocrm-axi api <method> <path>`.

Legend: **R** read · **W** write (`--confirm`) · **U** per-user, reversible, ungated.

## Generic record routes (`/:controller` = any entity type, custom ones included)

| Route | Command | |
| --- | --- | --- |
| `GET /{Type}` | `record list <Type>` / `<shortcut> list` (where, select, text, paging) | R |
| `POST /{Type}` | `record create <Type> --set k=v --confirm` | W |
| `GET /{Type}/{id}` | `record get <Type> <id> [--fields] [--full] [--json]` | R |
| `PUT`/`PATCH /{Type}/{id}` | `record update <Type> <id> --set k=v --confirm` | W |
| `DELETE /{Type}/{id}` | `record delete <Type> <id> --confirm` | W |
| `GET /{Type}/{id}/{link}` | `record related <Type> <id> <link>` | R |
| `POST /{Type}/{id}/{link}` | `record link <Type> <id> <link> <ids> --confirm` | W |
| `DELETE /{Type}/{id}/{link}` | `record unlink ...` | W |
| `GET /{Type}/{id}/stream` · `/posts` · `/updateStream` | `record stream <Type> <id>` (posts/updateStream via `api get`) | R |
| `PUT`/`DELETE /{Type}/{id}/subscription` | `record follow` / `record unfollow <Type> <id>` | U |
| `GET`/`POST`/`DELETE /{Type}/{id}/followers` | `record followers` (add/remove via `api`) | R/W |
| `PUT`/`DELETE /{Type}/{id}/starSubscription` | `record star` / `record unstar` | U |
| `GET /{Type}/{id}/streamAttachments` | `api get <Type>/<id>/streamAttachments` | R |
| `GET /{Type}/{id}/usersAccess` | `api get <Type>/<id>/usersAccess` | R |
| `GET`/`PUT /{Type}/layout/{name}[/{setId}]` | `api get|put <Type>/layout/detail` (admin) | R/W |
| `/{Type}/action/{action}` (GET/POST/PUT) | `api get|post <Type>/action/<action>` | R/W |

## Discovery, identity, auth

| Route | Command |
| --- | --- |
| `GET /Metadata?key=…` | `record types` (scopes), `record fields <Type>`, `record links <Type>`, `metadata <key> [--scope]` |
| `GET /I18n` | `i18n [--locale]` |
| `GET /App/user` | `me`, `auth status`; `me preferences` |
| `GET /App/about` · `/App/appParams` | `api get App/about`, `api get App/appParams` |
| `POST /App/destroyAuthToken` | `api post App/destroyAuthToken --confirm` |
| `GET`/`PUT`/`PATCH`/`DELETE /Preferences/{userId}` | `me preferences`; `api put Preferences/<userId> --body '{...}' --confirm` |
| `GET /OpenApi` | `openapi --out openapi.json` |
| `POST /UserSecurity/apiKey/generate` · `PUT /UserSecurity/password` · `POST /UserSecurity/password/generate` | `api post|put UserSecurity/... --confirm` (self-service) |
| `POST /User/passwordChangeRequest` · `/User/changePasswordByRequest` | `api post` (noAuth) |
| `GET /User/{id}/acl` · `GET /User/{id}/stream/own` | `user acl <id>`; `api get User/<id>/stream/own` |
| `GET /User/{id}/connectedApps` (+DELETE), `POST /User/{id}/revokeAllAuthenticationTokens` | `api` (regular-user auth only) |
| `PUT /Team/{id}/userPosition` | `team position <teamId> --user <userId> --position "<name>" --confirm` |
| OAuth/OIDC server routes (`/OAuth/*`, `/OAuthServer/*`, `/Oidc/*`) | not applicable to API-key/user-token clients |

## Email

| Route | Command |
| --- | --- |
| `GET /Email` with `inFolder` where | `email inbox|sent|archive|drafts|important|trash|all` (per-user) |
| `GET /Email` with other filters | `record list Email --where status=Sent --since 7d` |
| `GET /Email/{id}` | `email get <id>` (marks read) |
| `GET /Email/{id}/replies` · `/attachments` | `email thread <id>`; `record related Email <id> attachments` |
| `POST /Email` (status `Sending`/`Draft`) | `email send`, `email reply`, `email draft` (attachments via `attachment upload` + `attachmentsIds`) |
| `PUT /Email/{id}` (`status: Sending`) | `email send <draftId> --confirm` |
| `PUT /Email/{id}` (`sendAt`) | `email schedule <draftId> --at "..." --confirm` |
| `POST`/`DELETE /Email/inbox/read` | `email read|unread <ids>` / `email read --all` |
| `POST`/`DELETE /Email/inbox/important` | `email important|unimportant <ids>` |
| `POST`/`DELETE /Email/inbox/inTrash` | `email trash|untrash <ids>` |
| `POST /Email/inbox/folders/{folderId}` | `email move <ids> --folder <id|group:id>`, `email archive` (= `archive`), `email unarchive` (= `inbox`) |
| `GET /Email/inbox/notReadCounts` | `email count`, folded into `email inbox`/`folders` |
| `POST /Email/{id}/users` | `api post Email/<id>/users --body '{"ids":["<userId>"]}' --confirm` (share inbox email) |
| `POST /Email/{id}/attachments/copy` | `api post Email/<id>/attachments/copy --body '{"field":"attachments",...}' --confirm` |
| `POST /Email/importEml` | `email import-eml --file msg.eml` |
| `POST /Email/sendTest` | `email send-test --server --port --email-address --to --confirm` |
| `GET /Email/insertFieldData` | `api get Email/insertFieldData` (composer helpers) |
| `GET /EmailAddress/search` | `email address-search --q x [--type Lead]` |
| `EmailAccount` · `InboundEmail` CRUD + `/resetFetchData` | `email accounts`, `email inbound`, `email account|inbound reset-fetch <id> --confirm` |
| `EmailFolder` · `GroupEmailFolder` | `email folders`, `email folder create|delete` |
| `EmailTemplate` CRUD · `POST /EmailTemplate/{id}/prepare` | `email templates`, `email template get <id>`, `email template prepare <id> --parent-type T --parent-id id` |
| `EmailFilter` · `EmailQueueItem` | `record list EmailFilter|EmailQueueItem` |

## Stream, notes, search, notifications

| Route | Command |
| --- | --- |
| `GET /Stream` · `GET /GlobalStream` | `stream`; `api get GlobalStream` |
| `POST /Note` (type `Post`) | `post create <Type> <id> --text "..." --confirm` |
| `POST`/`DELETE /Note/{id}/pin` | `post pin|unpin <noteId>` |
| `POST`/`DELETE /Note/{id}/myReactions/{type}` · `GET /Note/{id}/reactors/{type}` | `post react|unreact|reactors <noteId> --type Like` |
| `GET /GlobalSearch?q=` | `search "<text>"` |
| `GET /Notification` · `/Notification/group` · `/Notification/{id}/group` | `notification list`, `notification groups`, `notification group <id>` |
| `POST /Notification/group/{id}/markRead` · `DELETE /Notification/group/{id}` | `notification mark-read <id>`, `notification mark-all-read`; `api delete` |

## Activities and calendar

| Route | Command |
| --- | --- |
| `GET /Activities/upcoming` | `activities upcoming [--user] [--days] [--types]` |
| `GET /Activities?from&to` | `activities calendar --from --to [--agenda] [--users] [--teams] [--types]` |
| `GET /Timeline` · `/Timeline/busyRanges` | `api get Timeline?...` |
| `GET /Activities/{parentType}/{id}/{type}[/list/{targetType}]` | `activities meetings|calls|tasks --parent-type T --parent-id id` |
| `GET /Meeting/{id}/attendees` · `/Call/{id}/attendees` | `api get Meeting/<id>/attendees` |
| `Meeting`/`Call`/`Task` CRUD | `meeting`, `call`, `task` shortcuts |

## CRM module tools

| Route | Command |
| --- | --- |
| `POST /Lead/{id}/convert` (client-side composite) | `lead convert <id> [--account] [--skip-opportunity] --confirm` |
| `POST /Campaign/{id}/generateMailMerge` | `api post Campaign/<id>/generateMailMerge --confirm` |
| `GET /TargetList/{id}/optedOut` | `api get TargetList/<id>/optedOut` |
| `POST`/`DELETE /Campaign/unsubscribe/...` | not applicable (public noAuth endpoints) |
| `GET /Kanban/{entityType}` | `kanban <Type>` |
| `Pipeline`/`PipelineStage` CRUD · `POST /{type}/{id}/move/{dir}` | `pipelines`, `pipeline-stages`, `pipeline move`, `pipeline-stage move` |
| `Product`, `Quote`, `Invoice`, `SalesOrder`, `PurchaseOrder`, `Bill`, `Payment`, `Supplier`... (Sales Pack) | `record <Type>` (products also via `product`) |

## Bulk, import/export, jobs

| Route | Command |
| --- | --- |
| `POST /MassAction` · `GET /MassAction/{id}/status` | `mass update|delete|follow|unfollow|remove-from-team|convert-currency|run`, `mass status` |
| `POST /Export` · `GET /Export/{id}/status` | `export create --type T --format csv --confirm`, `export status <id>`, `export download <id>` |
| `POST /Import/file` · `POST /Import` · `/Import/{id}/revert|removeDuplicates|unmarkDuplicates|exportErrors` | `api post Import/file --body ... --confirm` (multipart metadata is complex; prefer the UI or `api`) |
| `GET /Job` · `GET /ScheduledJob` · `GET /Admin/jobs` | `job`, `scheduled-job`, `admin jobs` |
| `GET /CurrencyRate` · `PUT /CurrencyRate` | `currency rates`, `currency set --rates EUR=1.11 --confirm` |

## Administration

| Route | Command |
| --- | --- |
| `GET`/`PUT`/`PATCH /Settings` | `settings list|get|set` |
| `POST /Admin/rebuild` · `POST /Admin/clearCache` | `admin rebuild --confirm`, `admin clear-cache --confirm` |
| `/Admin/fieldManager/{scope}[/{name}]` | `api get|post|put|delete Admin/fieldManager/<Scope>[/<field>] --confirm` (custom fields) |
| `User`, `Team`, `Role`, `Portal`, `PortalRole`, `AuthenticationProvider`, `AuthProvider`... | `user`, `team`, `role`, `record <Type>` |
| `Webhook`, `WebhookQueueItem`, `WebhookEventQueueItem` | `webhook`, `record <Type>` |
| `LeadCapture` CRUD · `POST /LeadCapture/{apiKey}` | `record LeadCapture`; the capture endpoint is for public forms |
| `Attachment` CRUD · `POST /Attachment/chunk/{id}` · `/copy/{id}` · `/fromImageUrl` | `attachment upload|get|delete`, `record Attachment`; chunked/copy/image via `api` |
| `GET /Attachment/file/{id}` | `attachment download <id> --out <path>` |
| `Template`, `TemplateManager`, `LayoutSet`, `DashboardTemplate`, `WorkingTimeCalendar`... | `record <Type>` |
| `AppSecret`, `Extension`, `Integration`, `Job` audits (`AuthLogRecord`, `ActionHistoryRecord`, `AppLogRecord`) | `record list <Type>` |
| `POST /Action` (BPM/workflow action runner) | `api post Action --confirm` |
