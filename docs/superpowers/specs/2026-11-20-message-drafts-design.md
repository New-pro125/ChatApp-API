# Design — message drafts

Status: written after section-by-section approval on 2026-11-20; awaiting written-spec review.

## 1. Context and intent

Phase 2.6 has already delivered read receipts, private pinned messages, caller-defined
pin expiry, and per-sender self-destructing presets. The remaining advanced-messaging
item from the feature document is: “Draft unsent messages and sync across devices.”

The chosen behavior is a small, durable per-chat draft that any of the author's
devices can read or overwrite. There is one draft per `(chat, author)`, the most
recent save wins, and a successful send or explicit delete removes it. Drafts are
private to the author and are never visible to the peer.

Success means:

- a user can save, read, overwrite, and delete a draft for a cloud chat over HTTP;
- the latest save from any device is authoritative, with a server-set `updatedAt`;
- a draft is readable only by its author and never appears in chat lists, message
  history, unread counts, or peer responses;
- a successful send in that chat clears the author's draft without touching the
  peer's;
- secret chats are rejected because the server must never hold their plaintext;
- no existing E2EE, privacy, media-GC, error-code, or message-flow invariant
  regresses.

## 2. Goals

- Add a `message_drafts` table, Drizzle schema definition, and reviewed migration
  `0021`.
- Add a `MessageDraftRecord` entity, a `MessageDraftRepository` port and Postgres
  implementation, and a `DraftService` in the messages module.
- Add `PUT`, `GET`, and `DELETE /api/chats/:chatId/draft` with shared Zod schemas,
  OpenAPI contracts via `DocumentedRouter`, and responses through `ApiResponse`.
- Clear the author's draft after a successful message send in that chat.
- Document the endpoints in `README.md`.
- Cover save/read/overwrite/delete, privacy, send-clear, validation, auth, and
  membership behavior with integration tests.

## 3. Confirmed decisions

1. **Cloud text only.** Drafts are supported for `direct` chats. A draft request
   for a `secret` chat is rejected with the existing `403 E2EE_NOT_ALLOWED`
   because secret-chat plaintext must never reach the server. Media, reply, and
   forward context are not drafted.
2. **Same body rule as messages.** `body` is required, non-empty, and at most
   4096 characters, enforced by both Zod and a named database check.
3. **One row per `(chat, author)`.** Saving again overwrites the body and refreshes
   `updated_at`; the last write wins. There is no version field, no optimistic
   concurrency check, and no per-device draft storage.
4. **Cleared on send or explicit delete.** A successful send in the chat removes
   the author's draft in the same request. There is no TTL and no cleanup worker.
5. **Private to the author.** The author id always comes from `req.user.id`; the
   peer can neither read nor overwrite it. Drafts never appear in chat or message
   projections.
6. **No new public surface.** Reuse `VALIDATION_ERROR`, `UNAUTHORIZED`,
   `EMAIL_NOT_VERIFIED`, `NOT_CHAT_MEMBER`, and `E2EE_NOT_ALLOWED`. No new error
   codes, auth schemes, or configuration values are introduced.

## 4. Non-goals

- Secret-chat drafts, including client-encrypted draft blobs.
- Drafts with media attachments, captions, reply targets, or forward metadata.
- Per-device draft lists, conflict prompts, or version-based optimistic locking.
- A `draft` field on `GET /api/chats` or on message views.
- A TTL or BullMQ cleanup job for abandoned drafts.
- Group or channel drafts; those chat types are not implemented yet.

## 5. Architecture overview

```text
PUT/GET/DELETE /api/chats/:chatId/draft
  -> MessagesRouter (request scope, bearer auth, verified email, rate limiter)
  -> DraftController (request-scoped, Zod-validated, ApiResponse)
  -> DraftService
       -> ChatRepository.findById          (reject secret chats)
       -> ChatMemberRepository.find        (membership)
       -> MessageDraftRepository port      (find/upsert/delete)
  -> PostgresMessageDraftRepository        (data layer only)
  -> message_drafts table

Successful message send
  -> MessageService
  -> DraftService.clearOnSend(chatId, authorId)
  -> MessageDraftRepository.delete
```

`DraftService` depends only on ports from `logic/ports` and domain errors. Express
types and HTTP status codes stay in the web layer. Bindings are added to
`MESSAGES_TYPES` and `MessagesContainer`.

## 6. Data model and migration

Table `message_drafts`, owned by the messages module and exported from the schema
barrel:

| Column      | Type                    | Constraints                                      |
| ----------- | ----------------------- | ------------------------------------------------ |
| `chat_id`   | `uuid`                  | not null, references `chats.id` `ON DELETE CASCADE` |
| `user_id`   | `uuid`                  | not null, references `users.id` `ON DELETE CASCADE` |
| `body`      | `text`                  | not null                                         |
| `created_at`| `timestamptz`           | not null, default `now()`                         |
| `updated_at`| `timestamptz`           | not null, default `now()`                         |

- Primary key: `(chat_id, user_id)`, named `message_drafts_pkey` by convention.
- Named check `message_drafts_body_check`: `char_length(body) between 1 and 4096`.
- No additional indexes: every planned query uses the primary key, and there is no
  list-by-user endpoint.
- Both foreign keys use `CASCADE` because the draft is owned by its chat and its
  author.

Migration `0021` is generated with `npm run db:generate`, reviewed as SQL, applied
with `npm run db:migrate`, and verified with `npm run db:check`. Unlike the
hash-partitioned `messages` table, `message_drafts` is a normal table.

## 7. Domain, repository, and service behavior

`MessageDraftRecord` is a domain record: `chatId`, `userId`, `body`, `createdAt`,
`updatedAt`. Drizzle row types never leave `data/`.

`MessageDraftRepository` exposes:

- `find(chatId, userId): Promise<MessageDraftRecord | null>`
- `upsert(chatId, userId, body, now): Promise<MessageDraftRecord>` — insert, or on
  conflict of `(chat_id, user_id)` update `body` and `updated_at`; `created_at`
  stays unchanged. `DraftService` supplies `new Date()` as `now` for both fields
  on insert and for `updated_at` on conflict.
- `delete(chatId, userId): Promise<boolean>`

`PostgresMessageDraftRepository` injects `CORE_TYPES.Db`, imports the table from
the schema barrel, maps rows through a mapper class, and wraps persistence errors
with the existing repository exception pattern. It never uses the raw pool.

`DraftService` exposes:

- `get(chatId, userId): Promise<MessageDraftRecord | null>`
- `save(chatId, userId, body): Promise<MessageDraftRecord>`
- `delete(chatId, userId): Promise<boolean>`
- `clearOnSend(chatId, userId): Promise<void>` — calls `repository.delete`
  directly without repeating access checks, since the send path already
  authorized the sender.

A private access check runs for `get`, `save`, and `delete`: load the chat with
`ChatRepository.findById`; a missing chat, a non-member caller, or a chat of any
type other than `direct` is rejected. `secret` chats throw
`E2eeNotAllowedException`; missing chat/membership throws `NotChatMemberException`.
Both are existing `403` errors.

When `clearOnSend` fails, `MessageService` logs a warning but does not fail the
already-created message. A stale draft is recoverable by the client; a lost sent
message is not.

## 8. HTTP contract

All three routes are registered in `MessagesRouter` under `/api/chats` with
`DocumentedRouter` contracts, bearer auth, verified-email middleware, the
messages rate limiter, and request-scoped controller resolution.

| Method   | Path                             | Request        | Success                              |
| -------- | -------------------------------- | -------------- | ------------------------------------ |
| `PUT`    | `/api/chats/:chatId/draft`       | `{ body }`     | `200` `{ body, updatedAt }`          |
| `GET`    | `/api/chats/:chatId/draft`       | —              | `200` draft, or `data: null`         |
| `DELETE` | `/api/chats/:chatId/draft`       | —              | `204` no content                     |

- `operationId`s: `chats.saveDraft`, `chats.getDraft`, `chats.deleteDraft`.
- `saveDraftSchema` requires `body` as a trimmed string of 1–4096 characters and
  is the single source for both Zod validation and the OpenAPI request schema.
- `draftResponseSchema` has `body` (string) and `updatedAt` (ISO timestamp) and is
  wrapped with `successEnvelope`.
- `PUT` always returns `200` because it is an idempotent upsert. Repeating the same
  body refreshes `updatedAt`.
- Empty bodies are invalid; clearing a draft is done with `DELETE`.
- `DELETE` is idempotent: deleting a missing draft still returns `204`.

## 9. Error handling

No new error codes or mapper entries are needed.

| Condition                         | Result                            |
| --------------------------------- | --------------------------------- |
| Missing bearer token              | `401 UNAUTHORIZED`                |
| Unverified caller                 | `403 EMAIL_NOT_VERIFIED`          |
| Unknown chat or non-member        | `403 NOT_CHAT_MEMBER`             |
| Secret chat                       | `403 E2EE_NOT_ALLOWED`            |
| Missing/empty/over-length body    | `400 VALIDATION_ERROR`            |
| Database failure                  | wrapped repository exception, `500` via existing mapping |

Zod validation happens in the controller before any repository call. Input from
`req.body` other than `body` is ignored by the schema.

## 10. Testing strategy

Tests are written first and driven to green per task.

- **Schema/migration**: column presence, primary key, named check constraint, and
  cascade behavior; `npm run db:check` clean.
- **Repository**: `find` on a missing row, `upsert` creates then updates without
  changing `created_at`, and `delete` reports whether a row existed.
- **Service**: secret-chat rejection, non-member rejection, and `clearOnSend`
  removing only the named author's draft.
- **HTTP integration**: save then read; overwrite with last-write-wins and a
  newer `updatedAt`; `GET` with no draft returns `data: null`; `DELETE` is
  idempotent; each participant has an independent private draft; sending a
  message clears only the sender's draft; invalid, unauthenticated, unverified,
  non-member, and secret-chat requests return the mapped errors above.
- **Full gate**: `npm run verify` and `npm run db:check` green in the isolated
  worktree; live HTTP smoke with at least one success path and one error path;
  temporary users and started processes cleaned up.

## 11. Documentation

`README.md` gains the three endpoints in the messaging route table and a short
note that drafts are private, per-chat, overwritten on save, and cleared on send.
No `.env.example` changes are needed because no configuration is added. `plan.md`
is updated only as an untracked handoff.

## 12. Risks and mitigations

- **Plaintext at rest for cloud drafts.** This matches cloud messages, which are
  already server-visible; secret chats are rejected so no E2E plaintext is stored.
  Mitigation: access checks key off `req.user.id`, and no draft is projected into
  peer-visible responses.
- **Silent overwrite across devices.** Accepted by decision 3; clients can read
  the current draft before overwriting if they need to. This avoids version
  plumbing and matches typical messenger behavior.
- **Send-clear coupling.** `MessageService` gains one best-effort call. Mitigation:
  failures are logged and never discard a successfully sent message; the test
  suite pins the send-then-clear order and the peer's draft isolation.
- **Migration drift.** Generated SQL must be reviewed before apply; `db:check`
  and a fresh baseline test run guard against drift.

## 13. Acceptance criteria

- `PUT`, `GET`, and `DELETE /api/chats/:chatId/draft` exist, are documented, and
  use the standard response envelope.
- A draft is private to its author, survives process restarts, and is overwritten
  by the latest save.
- Sending a message in the chat clears only that author's draft.
- Secret-chat draft requests return `403 E2EE_NOT_ALLOWED`; no secret plaintext is
  ever stored as a draft.
- `npm run verify` and `npm run db:check` pass, live HTTP smoke succeeds, and the
  worktree is clean before handoff.
