# Design — Phase 2.6 pinned messages

Status: written after section-by-section approval on 2026-11-19; awaiting written-spec review.

## 1. Context and intent

Phase 2.6 sub-project 1 delivered read receipts and caller-private unread counts
for direct and secret chats. Messaging now supports send/edit/delete/reply/
forward with keyset pagination over UUIDv7 message ids, an explicit mark-read
endpoint, a mutual sender-only `readAt`, and a watermarking approach that keeps
server-side metadata out of secret-chat ciphertext.

The Features Document asks to "Pin important messages in chats". Today a user
has no way to bookmark a message: once it scrolls out of a history page it can
only be found again by paging through the whole chat. This sub-project adds
private, per-user bookmarks to both cloud and secret chats.

Success means:

- a chat member can pin and unpin any live message in a chat;
- the caller can list their own pinned messages for a chat, newest pin first;
- message history shows a caller-specific pin indicator (`pinnedAt`) without an
  extra request per message;
- pins are private: the other participant cannot see, list, or infer them;
- pinning a message in a secret chat stores only ids and a timestamp — never
  ciphertext, nonce, or device identifiers;
- the number of pins per chat is bounded and concurrent pin attempts cannot
  exceed the bound.

## 2. Goals

- Add a `message_pins` table and a generated migration (`0015`).
- Add a `MessagePinRepository` port and PostgreSQL implementation with cap
  enforcement, batched indicator lookup, and unpin-on-delete.
- Add a `PinService` for membership, message, and cap checks.
- Add `POST`/`DELETE /api/chats/:chatId/messages/:messageId/pin` and
  `GET /api/chats/:chatId/pins`, documented through `DocumentedRouter`.
- Add `pinnedAt: string | null` to message responses, resolved in one batched
  query per list request.
- Reuse existing error codes, envelopes, Zod validation, OpenAPI components,
  middleware chain, and rate limiting.
- Extend schema, ports, services, repositories, controllers, DTOs, OpenAPI,
  README, and integration tests consistently.

## 3. Confirmed decisions

1. **Per-user, private pins.** Each participant pins independently; a pin is
   visible only to the user who created it. Group-wide/admin pins do not apply
   because group chats are out of scope.
2. **Both chat types.** `direct` cloud chats and `secret` chats support pins.
   Pin state is metadata only and never touches secret-chat ciphertext.
3. **Full API surface.** Pin, unpin, list the caller's pins, and a caller-
   specific `pinnedAt` indicator on message history.
4. **Cap of 10 pins per `(chat, user)`.** An 11th pin returns `409 CONFLICT`;
   the cap is serialized so concurrent requests cannot exceed it.
5. **Dedicated table.** `message_pins(chat_id, message_id, user_id, pinned_at)`
   with no FK to the partitioned `messages` table, following the read-watermark
   precedent.
6. **Unpin on delete.** Soft-deleting a cloud message removes its pin rows; the
   pins list also excludes deleted messages as a guard.
7. **Idempotent unpin.** `DELETE` of a pin that does not exist still returns
   `204 No Content`.
8. **No new public error codes or environment variables.**

## 4. Non-goals

- Shared or admin-controlled pins, pinned-message reordering by the user, or a
  client-supplied sort order. Pins are ordered by `pinned_at DESC`.
- Pin count or a pinned preview on chat rows (`ChatView` is unchanged).
- Group chats and channels.
- Notifications for pin/unpin, BullMQ jobs, or push delivery.
- Changes to the existing privacy settings; pins ignore `readReceiptsEnabled`.
- Automatic pinning, unpinning on mark-read, or any scheduled expiry.
- Storing secret-chat plaintext, keys, ciphertext, or device ids in pin rows.
- A per-message `message_reads` table or changes to read receipts and unread
  counts.
- New response envelope fields, a second pagination scheme, or new config.
- Backfilling pin rows; there is no existing pin data.

## 5. Architecture

### 5.1 Schema and migration `0015`

Add `messagePins` to `src/core/database/schema/messaging.schema.ts`:

- `chatId: uuid('chat_id').notNull().references(() => chats.id, { onDelete:
  'cascade' })`
- `messageId: uuid('message_id').notNull()` — deliberately **no FK**: `messages`
  is hash-partitioned and pinned rows must not restrict message deletion.
- `userId: uuid('user_id').notNull().references(() => users.id, { onDelete:
  'cascade' })`
- `pinnedAt: timestamp('pinned_at', { withTimezone: true }).notNull().defaultNow()`
- `primaryKey({ columns: [chatId, userId, messageId], name: 'message_pins_pkey' })`
- `index('message_pins_chat_user_pinned_at_index').on(chatId, userId,
  pinnedAt.desc())` for ordered listing.

Generate migration `0015` with `npm run db:generate`, review the SQL, and apply
it with `npm run db:migrate`. Never edit an applied migration. The composite PK
also makes a repeated pin a no-op at the storage level.

### 5.2 Repository port

Add `src/modules/messages/logic/ports/message-pin.repository.ts`:

```ts
export interface PinRecord {
  readonly messageId: string;
  readonly pinnedAt: Date;
}

export interface MessagePinRepository {
  /** Returns the pin, or null when the caller already has 10 pins.
   *  A duplicate pin returns its original pinnedAt. */
  pin(chatId: string, userId: string, messageId: string): Promise<PinRecord | null>;

  /** True when a pin was removed; false when none existed. */
  unpin(chatId: string, userId: string, messageId: string): Promise<boolean>;

  /** Caller's pins in this chat, newest pin first. */
  list(chatId: string, userId: string): Promise<PinRecord[]>;

  /** Batched indicator lookup: message id to pinnedAt, for one page. */
  listPinnedFor(
    chatId: string,
    userId: string,
    messageIds: readonly string[],
  ): Promise<Map<string, Date>>;

  /** Removes every user's pin of one message (unpin-on-delete). */
  removeForMessage(chatId: string, messageId: string): Promise<void>;
}
```

Implement `PostgresMessagePinRepository` in `data/`, injecting `CORE_TYPES.Db`,
importing tables from the schema barrel, mapping rows to `PinRecord` through a
mapper class, and wrapping database failures in the existing repository
exception types. Raw `pg` errors never reach services.

Cap enforcement in `pin()`: run `this.db.transaction(...)`, lock the caller's
`chat_members` row with `.for('update')` (a transaction-scoped row lock, which
is safe under PgBouncer transaction pooling), count the caller's pins for the
chat, return `null` when the count is already 10, otherwise insert. The
composite PK makes duplicates idempotent. Membership is guaranteed by the
service before the repository is called; if the lock finds no membership row,
count and insert without a lock rather than throwing from the data layer.

Add `listByIds(chatId, ids)` to `MessageRepository`: a single query scoped by
`chatId` for partition pruning, returning only live (`deleted_at is null`)
messages. `PinService` uses it to load at most 10 pinned messages in one query
and reorders results to match `pinned_at DESC`.

### 5.3 Service and dependency injection

Add `src/modules/messages/logic/pin.service.ts`, `@injectable()` and
constructor-injected with `MessagingPolicy`, `MessageRepository`,
`MessagePinRepository`:

- `pin(userId, chatId, messageId)`: `policy.requireMember(chatId, userId)`;
  load the message with `messages.findById(chatId, messageId)`; reject with
  `NotFoundException` when it is missing or `deletedAt !== null`; delegate to
  `pins.pin(...)`; throw `ConflictException('Pin limit reached')` when the
  repository signals the cap; return the `PinRecord`.
- `unpin(userId, chatId, messageId)`: `policy.requireMember(...)`; call
  `pins.unpin(...)`; return void (idempotent).
- `list(userId, chatId)`: `policy.requireMember(...)`; call `pins.list(...)`;
  load the messages with `messages.listByIds(chatId, ids)`; return an ordered
  array of `{ message, pinnedAt }` for messages that still exist, preserving
  `pinned_at DESC` order.

Add `MESSAGES_TYPES.MessagePinRepository` and `MESSAGES_TYPES.PinService`, bind
both in `MessagesContainer` in singleton scope, and add the new controller and
router bindings there. Keep all pin logic inside the module; no core port or
cross-module import is needed for this sub-project.

### 5.4 HTTP surface

Add three handlers to a request-scoped `PinController` (resolved from
`req.container` like the existing controllers):

| Method | Path | Success | Notes |
| --- | --- | --- | --- |
| `POST` | `/api/chats/:chatId/messages/:messageId/pin` | `201` with `{ messageId, pinnedAt }` | Duplicate pin returns `201` with the original timestamp |
| `DELETE` | `/api/chats/:chatId/messages/:messageId/pin` | `204` | Idempotent |
| `GET` | `/api/chats/:chatId/pins` | `200` list of message views with `pinnedAt` | Newest pin first |

Register all three through `DocumentedRouter` with `messageContracts` entries
(`operationId` `messages.pinMessage`, `messages.unpinMessage`,
`messages.listPinned`), tags, summaries, and request/response schemas. The same
Zod schemas document and validate params. The middleware chain is identical to
the other message mutations: request scope, `RequireAuth`,
`RequireVerifiedEmail`, and the messages rate limiter for writes; the `GET`
follows the existing `GET /messages` pattern (no rate limiter).

`MessagePresenter.present(message, context, pinnedAtById?)` gains an optional
`ReadonlyMap<string, Date>` defaulting to empty; it adds
`pinnedAt: pinnedAtById?.get(message.id)?.toISOString() ?? null`. The default
empty map keeps send/edit/forward responses correct (`pinnedAt: null`) without
an extra query. `MessageController.list` calls
`pins.listPinnedFor(chatId, userId, page.map(m => m.id))` once per request and
passes the resulting map to every `present` call. `GET /pins` builds its map
from the `PinRecord`s it already loaded, so it needs no extra lookup.

## 6. Behavior

### 6.1 Pinning and unpinning

- Only a member of the chat may pin or unpin. Membership is checked before the
  message lookup so a non-member cannot probe message ids.
- The target message must belong to the given chat and must not be soft-deleted.
  Both failures are `404 NOT_FOUND`; the message id is never treated as global.
- Pinning an already-pinned message is idempotent: it returns `201` with the
  original `pinnedAt` and does not reset the timestamp.
- A user may have at most 10 pins per chat. The 11th pin returns `409 CONFLICT`
  with the code `CONFLICT`; the existing pin set is unchanged.
- Unpinning a message that is not pinned returns `204 No Content`.
- Pinning works identically in `direct` and `secret` chats. In a secret chat the
  stored row contains only `chat_id`, `message_id`, `user_id`, and `pinned_at`.

### 6.2 Listing pins and history indicator

- `GET /pins` returns the caller's pinned messages as full message views using
  the same presenter as history (including `readAt` and media fields), ordered
  by `pinned_at DESC`. Messages that were deleted are omitted.
- Message history includes `pinnedAt` for the caller only. Alice's pin never
  changes Bob's `pinnedAt` or Bob's pins list.
- The indicator lookup is one query per history page, not one query per
  message. Single-message responses (send/edit/forward) report `pinnedAt: null`
  because a newly created or just-edited message cannot already be pinned by
  the caller.

### 6.3 Deletion interaction

`MessageService.remove` calls `pins.removeForMessage(chatId, messageId)` after
`messages.markDeleted(...)` succeeds and before media release. `GET /pins`
additionally filters soft-deleted messages so a racing read cannot expose a
message that is being deleted. No change to the existing 403
`E2EE_NOT_ALLOWED` behavior for secret-message deletion.

## 7. Error handling

All errors use the existing layered hierarchy and `ErrorMapper`; no new codes.

| Situation | Result |
| --- | --- |
| Missing or invalid bearer token | `401 UNAUTHORIZED` (existing middleware) |
| Unverified caller | `403 EMAIL_NOT_VERIFIED` (existing middleware) |
| Caller is not a chat member | `403 NOT_CHAT_MEMBER` |
| Message missing, in another chat, or soft-deleted | `404 NOT_FOUND` |
| Already at 10 pins in the chat | `409 CONFLICT` |
| Invalid UUID params | `400 VALIDATION_ERROR` (Zod) |
| Unpin of a non-existent pin | `204 No Content` |

Unexpected database failures are wrapped by the repository layer and sanitized
by the global error handler. Success and error responses keep the shared
envelope and `requestId`.

## 8. Testing

TDD at every layer; each task is implemented and independently reviewed.

- **Schema:** assert the new table's columns, composite PK, index, FKs, and the
  absence of a `messages` FK; run `npm run db:check` after migration generation.
- **Repository:** pin/unpin/list round trip; duplicate pin keeps its timestamp;
  cap of 10; two concurrent pins from the same caller yield exactly 10 rows and
  one `null` result; `listPinnedFor` returns timestamps only for the requested
  pinned ids;
  `removeForMessage` clears every user's pin; chat/user cascade deletes pin
  rows; database errors are wrapped.
- **Service:** non-member rejection; foreign-chat and soft-deleted message
  rejection; cap translation to `ConflictException`; ordering by pinnedAt;
  deleted pinned messages omitted from the list.
- **HTTP (integration):** pin 201; duplicate 201 with unchanged `pinnedAt`;
  11th pin 409 `CONFLICT`; unpin 204 and idempotent unpin 204; list order;
  `pinnedAt` present in history for the pinner and null for the peer; secret-
  chat pin/list with ciphertext unchanged; soft-deleted message 404; non-member
  403; unverified 403; missing bearer 401; malformed UUID 400; rate limiter on
  write paths where already configured.
- **Final gate:** `npm run verify && npm run db:check`; live HTTP smoke over
  `npm run dev` with at least one success and each applicable error path;
  remove all temporary users, chats, messages, and pin rows, then stop the API.

## 9. Migration and deployment

- Migration `0015` creates one new table; it is additive and needs no backfill.
- No changes to existing tables or applied migrations.
- The FK from `message_pins.chat_id` to `chats` uses `ON DELETE CASCADE`, so
  deleting a chat removes its pins. The FK to `users` uses `CASCADE` as well.
- The absence of an FK to `messages` means a hard delete of a message cannot be
  blocked by a pin row; `removeForMessage` plus the list filter keep reads
  consistent.
- Drizzle Kit connects via `DATABASE_URL` directly to PostgreSQL, never
  PgBouncer. No session-level PostgreSQL features are used in request paths.

## 10. Documentation

- Update the README messaging section with the three new routes, the per-user
  privacy rule, the 10-pin cap, the `409 CONFLICT` behavior, and the
  `pinnedAt` field.
- Register request/response schemas once in `message.openapi.ts` so OpenAPI and
  runtime validation stay identical.
- No `.env.example` changes; no new configuration.

## 11. Risks and mitigations

- **Concurrent cap bypass:** two pin requests could both count 9 and insert.
  Mitigated by the `FOR UPDATE` row lock on the caller's `chat_members` row
  inside the transaction.
- **Orphan pin rows:** pins have no FK to `messages`. Mitigated by
  `removeForMessage` on soft delete, chat/user cascade FKs, and filtering
  deleted messages in `GET /pins`.
- **N+1 on history:** indicator lookup is batched once per page; a default empty
  map avoids queries for single-message responses.
- **Privacy leak:** pins are keyed by `user_id` and every read is scoped to the
  caller. Tests assert that the peer sees no pin state.
- **Secret-chat scope creep:** pins store only ids and a timestamp; tests assert
  ciphertext and device fields are unchanged after pinning.
- **Migration drift:** generated SQL is reviewed and `npm run db:check` is run
  before handoff.
