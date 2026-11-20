# Design — message mentions

Status: written after section-by-section approval on 2026-11-20; awaiting written-spec review.

## 1. Context and intent

Phase 2.6 has delivered read receipts, private pinned messages, caller-defined
pin expiry, per-sender self-destructing presets, and unsent draft syncing. The
remaining advanced-messaging item from the feature document is: “Mention (by
username) users within the text messages.” The same document places push
notifications for mentions in Module 6, which is a later phase.

This design delivers the parsing, persistence, visibility, and inbox layer for
cloud direct-chat text messages only. It does not deliver push or in-app
notifications. Success means:

- `@username` tokens in a text message resolve to users who are members of that
  chat, case-insensitively, without exposing whether a non-member name exists;
- mentions survive restarts, are recomputed on edit, and disappear from the
  inbox when the message is deleted or self-destructs;
- a mentioned user can list their mentions with a global unread count and mark
  one or many as read;
- message views identify who was mentioned without changing the message body;
- no existing auth, E2EE, privacy, media, error-code, or message-flow invariant
  regresses.

## 2. Goals

- Add a `message_mentions` table, Drizzle schema definition, and a reviewed
  migration (expected `0022`, following drafts at `0021`).
- Publish a core `UsernameReader` port from auth, backed by a new
  `UserRepository.findByUsername` method.
- Add a `MentionParser`, `MentionService`, `MentionRecord`, a
  `MentionRepository` port, and its Postgres implementation in the messages
  module.
- Hook mention sync into text send, edit, and forward; hook mention hiding into
  explicit delete and self-destruct expiry.
- Add `mentions` to message views and add the three mention-inbox HTTP routes
  with shared Zod schemas and `DocumentedRouter` contracts.
- Cover parsing, lifecycle, inbox, isolation, validation, and auth behavior
  with unit and integration tests; document the endpoints in `README.md`.

## 3. Confirmed decisions

1. **Persist + mention inbox.** Store mentions, resolve them in message views,
   and provide a per-user inbox with unread count and mark-read. Push stays in
   Phase 5.
2. **Chat members only.** Resolve `@username` case-insensitively against users
   who are members of that chat. Unknown names, names of non-members, and
   malformed tokens remain plain text: no error, no body rewrite, and no
   username-existence leak. Self-mentions are allowed because the sender is a
   chat member.
3. **Full lifecycle.** Recompute on edit, hide on delete or expiry, and support
   single and bulk mark-as-read. The inbox contains no message body; the client
   loads the message from chat history.
4. **Dedicated table and service.** One row per `(chat, message, mentioned
   user)`, with `read_at` and `deleted_at`, owned by a `MentionService` in the
   messages module. No array column and no read-time parsing.
5. **Cloud text messages only.** Parsing applies to `type: 'text'` bodies,
   including a forwarded text message in its target chat. Media captions,
   secret-chat ciphertext, and unsent drafts are never parsed.
6. **No new public errors or configuration.** Reuse existing codes and
   middleware; no `.env` changes.

## 4. Non-goals

- Push or in-app notifications, notification preferences, and Phase 5 delivery.
- Groups, channels, `@all`, role mentions, and any mention of a non-member.
- Message bodies, previews, or reply metadata in the inbox.
- Mention parsing in media captions, secret messages, or drafts.
- Highlighting markers or offsets in the message body; only resolved user
  summaries are projected.
- New error codes, auth schemes, configuration values, or username rules.

## 5. Architecture overview

```text
Text send / edit / forward
  -> MessageService
       -> MentionService.sync(chatId, messageId, body)
            -> MentionParser.parse(body)              unique lowercased names
            -> CORE_TYPES.UsernameReader.findByUsername  (auth-backed core port)
            -> ChatMemberRepository.listByChat         membership filter
            -> MentionRepository.sync                  one transaction

Explicit delete / self-destruct expiry
  -> MessageService.remove / SelfDestructCleanupWorker
       -> MentionService.hideForMessage(chatId, messageId)

GET /api/chats/mentions, POST .../read
  -> MessagesRouter (request scope, bearer auth, verified email)
  -> MentionController (Zod-validated, ApiResponse)
  -> MentionService -> MentionRepository

Message history / single-message responses
  -> MessageController batches MentionRepository.listForMessages
     and CORE_TYPES.UserSummaryReader.findSummaries
  -> MessagePresenter adds `mentions` to the message view
```

`MentionService` depends only on ports from `logic/ports`, the core username
port, and domain code. Express types and HTTP statuses stay in the web layer.
Drizzle types never leave `data/`. Bindings are added to `MESSAGES_TYPES` and
`MessagesContainer`; the auth module registers before messages in
`Application`, so `CORE_TYPES.UsernameReader` is available when the
self-destruct worker is constructed at boot.

## 6. Data model and migration

Table `message_mentions`, owned by the messages module and exported from the
schema barrel:

| Column             | Type          | Constraints                                          |
| ------------------ | ------------- | ---------------------------------------------------- |
| `id`               | `uuid`        | not null, default `uuidv7()`                         |
| `chat_id`          | `uuid`        | not null, references `chats.id` `ON DELETE CASCADE`  |
| `message_id`       | `uuid`        | not null                                             |
| `mentioned_user_id`| `uuid`        | not null, references `users.id` `ON DELETE CASCADE`  |
| `created_at`       | `timestamptz` | not null, default `now()`                            |
| `read_at`          | `timestamptz` | nullable                                             |
| `deleted_at`       | `timestamptz` | nullable                                             |

- Primary key: `id`.
- Named unique index `message_mentions_chat_message_user_unique` on
  `(chat_id, message_id, mentioned_user_id)`. `chat_id` is required because
  message ids are unique only within a chat.
- Composite foreign key on `(chat_id, message_id)` to the partitioned
  `messages` table `ON DELETE CASCADE`. Messages are currently soft-deleted and
  scrubbed to tombstones, so the explicit hide calls are authoritative; the FK
  also keeps the table consistent if a hard delete is introduced later.
- No body, username, or message text is stored on the row.
- Index `message_mentions_user_inbox_idx` on `(mentioned_user_id, id desc)`
  where `deleted_at is null`; index `message_mentions_user_unread_idx` on
  `(mentioned_user_id, id desc)` where `deleted_at is null and read_at is null`.
  This refines §1's `created_at` shorthand: keysets use uuidv7 `id` for the same
  microsecond-precision reason documented in `ListMessagesQuery`.

Migration is generated with `npm run db:generate`, reviewed as SQL, applied with
`npm run db:migrate`, and checked with `npm run db:check`. Never edit an applied
migration.

## 7. Parsing, ports, and service behavior

`MentionParser.parse(body): string[]` returns unique lowercased usernames. A
token is `@` followed by a letter and 4–31 further letters, digits, or
underscores, matching the `users.username` format `^[a-z][a-z0-9_]{4,31}$`. The
preceding character must be the start of the body or a non-word, non-`@`,
non-`/`, non-`.` character, so `alice@example.com` and `https://x/@alice` are
not mentions. A longer or shorter token is not extracted and stays text.

`CORE_TYPES.UsernameReader` lives in `src/core/users/username.reader.ts`:

```ts
interface UsernameReader {
  findByUsername(username: string): Promise<string | null>;
}
```

Auth's `UserRepository` implements it with a `lower(username)` lookup backed by
the existing `users_username_lower_unique` index, wraps persistence errors with
`PersistenceException`, and is bound to the root container in
`auth.container.ts` alongside `UserSummaryReader`.

`MentionRecord` is a domain record: `id`, `chatId`, `messageId`,
`mentionedUserId`, `createdAt`, `readAt`, `deletedAt`.

`MentionRepository` exposes:

- `sync(chatId, messageId, userIds, now): Promise<void>` — in one transaction,
  insert missing rows with `read_at = null`, hard-delete rows whose user is no
  longer desired, and leave retained rows untouched so `read_at` survives.
  Hard-delete on edit removal prevents the unique key from blocking a later
  re-mention; `deleted_at` is reserved for message delete/expiry.
- `hideForMessage(chatId, messageId, now): Promise<void>` — idempotently stamps
  `deleted_at` on visible rows for that message.
- `listForMessages(chatId, messageIds): Promise<Map<string, MentionRecord[]>>`
  — visible rows only, batched for a history page.
- `list(userId, { limit, beforeId }): Promise<MentionRecord[]>` — caller's
  visible rows, newest `id` first, keyset by `id`.
- `countUnread(userId): Promise<number>` — visible rows with `read_at is null`.
- `findById(userId, id): Promise<MentionRecord | null>` — caller's visible row.
- `markRead(userId, ids, now): Promise<number>` — stamps `read_at` only on
  caller-owned, visible, still-unread rows; returns the number changed.

`PostgresMessageMentionRepository` injects `CORE_TYPES.Db`, imports the table
from the schema barrel, maps rows through a mapper class, and wraps persistence
errors with the existing repository exception pattern. It never uses the raw
pool.

`MentionService` exposes:

- `sync(chatId, messageId, body): Promise<void>` — parse, resolve each name via
  `UsernameReader`, filter by `members.listByChat(chatId)` with `leftAt ===
  null`, then call `repository.sync`. A name that does not resolve or whose user
  is not a member is skipped without error.
- `hideForMessage(chatId, messageId): Promise<void>`.
- `listForMessages(chatId, messageIds)` — used by web projection only.
- `list(userId, query)` and `countUnread(userId)` — called together in one
  request. They are separate queries, so a mark-read racing with the list may
  shift the count by one; that is acceptable for an inbox indicator.
- `markOne(userId, id)` — throws `NotFoundException` when `findById` is null.
- `markMany(userId, ids)` — caps the id list at 100, never throws for unknown
  ids, and returns the number of rows changed.

`MessageService.send`, `edit`, and `forward` call `sync` after the resulting
text message row exists. `remove` calls `hideForMessage` next to `pins.removeForMessage`.
`SelfDestructCleanupWorker.process` calls `hideForMessage` before
`scrubExpired`, so a failed scrub retry cannot resurrect an inbox entry. A
mention-sync failure is logged and does not fail a message that was already
stored, matching the existing `clearDraftAfterSend` rule.

## 8. HTTP contract

All routes are registered in `MessagesRouter` under `/api/chats` **before**
`/:chatId/read`, so the static `mentions` segment cannot be captured as a
`chatId`. All use bearer auth, verified-email middleware, request-scoped
controllers, `DocumentedRouter` contracts, and `ApiResponse`.

| Method | Path                                   | Request                     | Success                                              |
| ------ | -------------------------------------- | --------------------------- | ---------------------------------------------------- |
| `GET`  | `/api/chats/mentions`                  | `?limit&cursor`             | `200` `{ unreadCount, mentions }`, `meta.pagination.nextCursor` |
| `POST` | `/api/chats/mentions/:mentionId/read`  | —                           | `200` `{ id, readAt }`                               |
| `POST` | `/api/chats/mentions/read`             | `{ mentionIds: uuid[] }`    | `200` `{ marked }`                                   |

- `operationId`s: `chats.listMentions`, `chats.readMention`,
  `chats.readMentions`.
- `listMentionsQuerySchema` allows `limit` 1–100 (default 30) and an optional
  uuid `cursor`; the same keyset convention as message history is used.
- `readMentionsSchema` requires an array of 1–100 uuids; duplicate ids are
  de-duplicated by the service rather than rejected as invalid input.
- `mentionSchema` carries `id`, `chatId`, `messageId`, `createdAt`, `readAt`, and
  `mentionedBy` (the existing public `participantSummarySchema`); no body.
- The inbox response data is an object so `unreadCount` sits beside `mentions`
  while `meta.pagination` keeps the standard envelope. `responseMetaSchema`
  already documents optional pagination.
- The GET route has no rate limiter, matching the pins list; the two POST routes
  use `MessagesRateLimiter` like other message writes.
- Message views gain `mentions: [{ userId, username, displayName }]`, batched
  per response through `MentionRepository.listForMessages` and
  `UserSummaryReader.findSummaries`; no per-message N+1 lookup.

## 9. Error handling

No new error codes or mapper entries are needed.

| Condition                              | Result                          |
| -------------------------------------- | ------------------------------- |
| Missing bearer token                   | `401 UNAUTHORIZED`              |
| Unverified caller                      | `403 EMAIL_NOT_VERIFIED`        |
| Malformed query, id, or bulk body      | `400 VALIDATION_ERROR`          |
| Unknown, foreign, or hidden mention id | `404 NOT_FOUND`                 |
| Rate limit on mark-read                | `429 RATE_LIMITED`              |
| Unresolvable / non-member `@username`  | no error; remains plain text    |
| Mention-sync failure on send/edit      | wrapped repository exception, logged; message still succeeds |
| Mention inbox or mark-read failure     | wrapped repository exception, `500` via existing mapping     |

`findById` and `markOne` always filter by the caller's user id, so another
user's mention is indistinguishable from a missing one. `markMany` silently
ignores ids that are not owned or visible and reports only rows it changed.

## 10. Testing strategy

Tests are written first and driven to green per task.

- **Parser unit tests:** dedupe, case-insensitivity, minimum/maximum length,
  email and URL boundaries, empty body, and repeated names.
- **Service unit tests:** member-only resolution, unknown-name skip,
  add/remove/retain with `read_at` preservation, idempotent hide, and bulk cap.
- **Repository integration tests:** unique constraint, sync transaction,
  keyset paging, unread count, caller isolation, and mark-read idempotency.
- **HTTP integration tests** (following `messaging-api.fixture.ts` and
  `message-drafts.test.ts`): member mention on send and case-insensitive
  resolution; unknown and non-member names remain text; edit adds/removes
  mentions and keeps read state for retained ones; delete and self-destruct
  expiry hide inbox entries; forwarded text resolves in the target chat;
  message views include `mentions`; inbox pagination and unread count; single
  and bulk mark-read including cross-user isolation and 404/400 paths.
- **Full gate:** `npm run verify` and `npm run db:check` green in the isolated
  worktree; live HTTP smoke with at least one success path (send → inbox →
  mark-read) and one error path; temporary users and started processes cleaned
  up.

## 11. Documentation

`README.md` gains the three endpoints and a short note that mentions are
member-only, resolve case-insensitively, follow the message lifecycle, and
carry no notification in this phase. `docs/superpowers/specs/` and
`docs/superpowers/plans/` carry the design and implementation plan. No
`.env.example` change is needed. `plan.md` is updated only as an untracked
handoff and is never committed.

## 12. Risks and mitigations

- **Username existence leak.** Only the caller's chat members are ever
  resolved, and unmatched names produce no error. Mitigation: tests pin the
  unknown and non-member paths to plain text with no inbox row.
- **Loss of mention index on failure.** Sync is a best-effort side effect of a
  stored message. Mitigation: repository `sync` is atomic; failures are logged
  and never discard the message, matching the draft-clear precedent.
- **False positives from plain text.** `@` tokens can appear in addresses and
  URLs. Mitigation: the parser boundary rule excludes those; an accidentally
  resolved name still only mentions a chat member.
- **Keyset precision.** `created_at` has microsecond precision that JS `Date`
  cannot represent. Mitigation: keysets and indexes use uuidv7 `id`, as in
  message history.
- **Future membership removal.** Removing a user from a chat is not
  implemented today. If it is added for groups, the inbox query must also
  filter by active membership so old mentions cannot expose chat activity.
- **Migration drift.** Generated SQL must be reviewed before apply; `db:check`
  and a fresh test run guard against drift.

## 13. Acceptance criteria

- `@username` mentions are stored for chat members only, resolve
  case-insensitively, and leave unmatched text unchanged.
- Editing recomputes mentions while preserving read state for retained users;
  deleting or expiring a message hides its mentions.
- `GET /api/chats/mentions` returns a caller-scoped inbox with a global unread
  count and cursor paging; single and bulk mark-read are idempotent and do not
  expose other users' mentions.
- Message views list resolved user summaries; neither the inbox nor the view
  rewrites the message body.
- All three routes are documented, use the standard envelope, and no new error
  codes or configuration are introduced.
- `npm run verify` and `npm run db:check` pass, live HTTP smoke succeeds, and
  temporary processes/users are cleaned up before handoff.
