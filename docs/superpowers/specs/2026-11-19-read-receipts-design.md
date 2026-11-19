# Design — Phase 2.6 read receipts

Status: written after section-by-section approval on 2026-11-19; awaiting written-spec review.

## 1. Context and intent

Phase 2.5 delivered cloud-chat media messages. Messaging today supports
send/edit/delete/reply/forward with keyset pagination over UUIDv7 message ids,
and `user_privacy_settings.read_receipts_enabled` already exists but is not read
by the messaging module. `chat_members` carries membership role and timestamps
but no read state, and `GET /api/chats` returns conversation rows with no unread
indicator.

Phase 2.6 sub-project 1 adds read receipts to both cloud and secret chats. Read
state is server-side metadata only: it never reads, decrypts, or modifies secret
chat ciphertext. A client explicitly reports what it has read; history reads are
side-effect free.

Success means:

- a chat member can mark a chat read, optionally up to a specific message;
- each sent message can show a read timestamp to the sender, but only when both
  peers have opted in;
- each chat row carries a caller-private unread count that works for both chat
  types;
- read state advances monotonically and cannot be rewound by a stale client;
- the messaging module learns about the privacy setting only through a narrow
  core port, never by importing auth internals.

## 2. Goals

- Add a per-membership watermark to `chat_members` and a migration (`0014`).
- Expose `POST /api/chats/:chatId/read` with optional `{ messageId }`.
- Add `readAt` to message DTOs and `unreadCount` to chat DTOs.
- Honor the existing `readReceiptsEnabled` setting with strictly mutual
  semantics.
- Keep secret-chat behavior unchanged apart from the new metadata columns and
  routes; no ciphertext or E2EE payload changes.
- Reuse existing error codes, response envelopes, Zod validation, OpenAPI
  contracts, and rate limiting.
- Extend schema, ports, services, repositories, controllers, DTOs, OpenAPI,
  README, and integration tests consistently.

## 3. Confirmed decisions

1. **Scope:** per-message read status *and* per-chat unread counts in this
   sub-project.
2. **Both chat types:** mark-read and unread counts work for `direct` and
   `secret` chats; no ciphertext is touched.
3. **Strictly mutual receipts:** the sender sees `readAt` only when both peers
   have `readReceiptsEnabled`. A single opt-out hides receipts in both
   directions.
4. **Explicit mark-read:** clients call `POST /api/chats/:chatId/read` with an
   optional `messageId`. `GET /api/chats/:chatId/messages` never mutates read
   state.
5. **Watermark data model:** nullable `last_read_message_id` and `last_read_at`
   on `chat_members`; no FK to the partitioned `messages` table.
6. **Monotonic advancement:** the watermark only moves forward, compared by
   UUIDv7 id (aligned with the existing `ORDER BY id DESC` keyset ordering).
7. **Private unread counts:** `unreadCount` is computed for the caller from
   their own watermark and is independent of the mutual privacy setting.
8. **Core port for privacy:** messaging resolves a new core
   `ReadReceiptPreferenceReader`; the auth module implements and root-binds it,
   following the `UserBlockReader` / `UserPrivacyReader` pattern.
9. **No new public error codes or environment variables.**

## 4. Non-goals

- A per-message `message_reads` table or exact per-message read timestamps.
- Group chats; the unread query assumes the current two-member direct/secret
  chats and counts messages from "the other participant".
- Push notifications, read-by badge aggregation, or a notification service.
- Changing the existing privacy-settings endpoints; `readReceiptsEnabled` is
  already writable and keeps its default of `true`.
- Automatic mark-read on delivery, on send, or on any GET request.
- Allowing a client to rewind read state or to mark another user's messages
  read.
- Background workers, scheduled expiry, or self-destruct timers (later
  sub-project).
- Changes to secret-chat ciphertext storage, E2EE devices, or key exchange.
- New configuration, new response envelope fields, or a second pagination
  scheme.

## 5. Architecture

### 5.1 Module boundaries and core port

`src/modules/messages` must not import from `src/modules/auth`. A new core port
is added:

- `src/core/privacy/read-receipt-preference.reader.ts` —
  `ReadReceiptPreferenceReader`:

  ```ts
  areEnabledForPair(firstUserId: string, secondUserId: string): Promise<boolean>;
  ```

- `CORE_TYPES.ReadReceiptPreferenceReader` is added to
  `src/core/container/core.types.ts`.

The auth module owns the `user_privacy_settings` table and provides the adapter,
for example `src/modules/auth/logic/read-receipt-preference.service.ts`, which
reads both users' settings through the existing `PrivacyService` (so missing
rows fall back to defaults) and returns the logical AND. The adapter is
root-bound in `AuthContainer.publishToRoot()` alongside `UserPrivacyReader`,
`UserBlockReader`, and `UserSummaryReader`. No messages-module file imports an
auth type.

A dedicated narrow port is preferred over widening `UserPrivacyReader` so the
mutual policy stays in auth and messaging depends on exactly one question.

### 5.2 Schema and migration `0014`

`src/core/database/schema/messaging.schema.ts`, `chat_members` gains:

- `lastReadMessageId: uuid('last_read_message_id')` — nullable, no FK (the
  `messages` table is partitioned and hard-deletes must not be restricted by a
  watermark).
- `lastReadAt: timestamp('last_read_at', { withTimezone: true })` — nullable.

Both are nullable: `NULL` means "nothing has been read yet" and is equivalent
to zero unread filtering. No backfill is required; existing conversations show
all their inbound history as unread until a client marks them read.

Generate migration `0014` with `npm run db:generate`, review the SQL, then apply
with `npm run db:migrate`. The unread predicate is served by the existing
`messages_pkey` on `(chat_id, id)`, so no new index is expected; confirm with a
query plan before finalizing and add a named index only if the plan shows a
sequential scan.

### 5.3 Repositories and services

- `ChatMemberRepository.markRead(chatId, userId, messageId, at): Promise<void>`
  performs a single conditional `UPDATE`, setting both watermark columns only
  when the supplied id is greater than the stored one (PostgreSQL `GREATEST`
  semantics with `NULL` treated as "unset"). The timestamp is the database
  clock, not a client value.
- `ChatMemberRepository.find(chatId, userId)` returns the record including the
  new fields, so existing memberships expose the watermark.
- `MessageRepository.maxIdByChat(chatId): Promise<string | null>` resolves the
  current newest message id when the client omits `messageId`.
- `MessageRepository.findById(chatId, messageId)` already exists and is reused
  to validate a client-supplied watermark target; a missing row yields `404
  NOT_FOUND`.
- `MessageRepository.countUnread(chatId, readerId, watermarkId): Promise<number>`
  counts non-deleted messages not sent by the reader, with `id > watermarkId`
  when a watermark exists. For batched chat lists, add
  `countUnreadByChats(readerId, chatIds): Promise<Map<string, number>>` using one
  `GROUP BY chat_id` query.
- A new `ReadReceiptService` (`MESSAGES_TYPES.ReadReceiptService`) coordinates
  membership validation through `MessagingPolicy.requireMember`, target
  resolution, and `markRead`. It returns the resulting watermark record.
- `ChatService.listForUser` fetches all unread counts in one query and joins
  them in memory when building `ChatView`s, avoiding an N+1. `ChatView` gains
  `unreadCount`; chats created by `openDirect`/`openSecret` start at `0`.
- `MessagePresenter.present(message, context?)` gains an optional context
  carrying `{ viewerId, mutual, peerLastReadMessageId, peerLastReadAt }`. When
  absent, `readAt` is `null`. The list handler resolves chat memberships and the
  pair preference once per request and passes the same context to each message.

### 5.4 HTTP surface

`POST /api/chats/:chatId/read` is registered through `DocumentedRouter` with
`messageContracts.markRead`, using the same Zod schema for validation and the
OpenAPI request body. Middleware order matches other message writes: bearer
auth, verified email, messages rate limiter, then the request-scoped
`ChatController` handler. Params use `chatParamsSchema`.

Request body: `{ "messageId"?: uuid }` (optional, defaults to the chat's current
newest message). Response: `200` with
`{ chatId, lastReadMessageId, lastReadAt }`, all through `ApiResponse`.

`GET /api/chats` chat rows gain `unreadCount: number`.
`GET /api/chats/:chatId/messages` and single-message responses gain
`readAt: string | null`.

## 6. Behavior

### 6.1 Marking read

1. Authenticate and require a verified email.
2. Require membership in the chat (`403 NOT_CHAT_MEMBER` otherwise). Works for
   both chat types.
3. If `messageId` is supplied, verify it belongs to this chat via
   `findById(chatId, messageId)`; otherwise resolve the chat's maximum id.
   A foreign or missing id is `404 NOT_FOUND`. An empty chat returns a `200`
   with `null` watermark values.
4. Advance the caller's watermark only if the target id is newer than the
   stored one. Stale clients cannot rewind it.
5. Always record the caller's own watermark, even when receipts are not mutual;
   the unread count is caller-private. Mutuality only gates `readAt` visibility
   on outgoing messages.

Marking read never reads or decrypts secret-chat ciphertext; only the watermark
columns are written.

### 6.2 Per-message `readAt`

For each message in a list or single-message response, `readAt` is a non-null
ISO timestamp only when all of these hold:

- the message is not soft-deleted;
- the viewer is the message sender;
- `ReadReceiptPreferenceReader.areEnabledForPair(viewerId, peerId)` is `true`;
- the message id is less than or equal to the peer's `last_read_message_id`.

Otherwise `readAt` is `null`. Incoming messages never carry their own `readAt`
for the viewer. The timestamp shown is the peer's current `last_read_at` (see
§11).

### 6.3 Unread counts

`unreadCount` on a chat row is the number of non-deleted messages from other
participants whose id is greater than the caller's `last_read_message_id`
(or all such messages when the watermark is `NULL`). It is always available to
the caller regardless of the mutual setting. It counts rows only, so it works
identically for secret chats without touching ciphertext.

## 7. Error handling

All errors reuse existing codes and the shared `ErrorMapper`; no new public
code is introduced.

| Condition | Status | Code |
| --- | --- | --- |
| Unauthenticated | 401 | `UNAUTHORIZED` |
| Unverified email | 403 | `EMAIL_NOT_VERIFIED` |
| Not a chat member | 403 | `NOT_CHAT_MEMBER` |
| `messageId` missing from this chat | 404 | `NOT_FOUND` |
| Malformed params/body | 400 | `VALIDATION_ERROR` |

Domain errors carry no HTTP status. Persistence failures are wrapped in
repository exceptions. All responses use `ApiResponse`.

## 8. Testing

- **Repository:** `markRead` advances only forward (stale id leaves the row
  unchanged), sets `last_read_at` from the database clock, and tolerates a
  `NULL` starting watermark; `countUnread` excludes the reader's own and
  soft-deleted messages and respects the watermark; batched counts return one
  entry per requested chat.
- **Service:** `ReadReceiptService` rejects non-members and foreign message ids;
  resolves "no messageId" to the chat maximum; records a watermark even when
  the preference is off.
- **Preference:** mutual gating returns `true` only when both settings are on;
  defaults apply when a settings row is absent; a change takes effect on the
  next read (no stale cache).
- **Presenter:** `readAt` is non-null only for the sender's own messages at or
  below the peer watermark with both peers opted in; `null` for incoming
  messages, for one-sided opt-out, and for messages newer than the watermark.
- **HTTP integration:** mark-read success with and without `messageId`; stale
  watermark is ignored; `400`, `401`, `403 EMAIL_NOT_VERIFIED`,
  `403 NOT_CHAT_MEMBER`, and `404` paths; secret-chat mark-read and unread
  counts work and never alter ciphertext; `readAt` visibility matrix;
  `unreadCount` across multiple chats in a single `GET /api/chats` call (assert
  one count query, no N+1); `GET` history does not change unread counts.
- **Migration:** generated SQL reviewed, applied with `npm run db:migrate`, and
  `npm run db:check` reports no drift.

## 9. Migration and deployment

- Generate `0014` with `npm run db:generate`; review the SQL, apply with
  `npm run db:migrate`, and confirm `npm run db:check`.
- No data backfill: `NULL` watermarks mean "nothing read yet". Existing
  conversations show inbound history as unread until marked.
- No new environment variables; `.env.example` is unchanged.
- Rollout is additive and backward compatible: old clients ignore the new
  fields, and new clients receive `null`/`0` until they mark a chat read.

## 10. Documentation

- README: document the mark-read endpoint, its optional `messageId`, monotonic
  semantics, `readAt` and `unreadCount` fields, and the strictly mutual privacy
  behavior (including that unread counts remain caller-private).
- OpenAPI: extend `messageContracts` with `markRead` and add the new response
  fields to the existing chat/message response schemas. No change to
  `openapi.schemas.ts` because no new public error code is introduced.
- No config changes, so `.env.example` remains untouched.

## 11. Risks and mitigations

- **UUIDv7 ordering assumption.** The watermark compares message ids
  lexicographically, matching `ORDER BY id DESC` pagination. This holds for
  UUIDv7; a future id-scheme change would break read ordering. Mitigation: keep
  the comparison in one repository method and cover it with a monotonicity
  test.
- **Soft-deleted messages keep their ids.** A watermark can pass a deleted
  message. Mitigation: `countUnread` filters `deleted_at IS NULL`, and the
  presenter must suppress `readAt` for deleted messages (§6.2).
- **Approximate read time.** `readAt` uses the peer's *current* `last_read_at`,
  so a later mark-read overwrites the displayed time for earlier messages. This
  is inherent to the watermark model accepted in §3; exact per-message times
  would require a `message_reads` table and are a non-goal.
- **Preference freshness.** A cached or stale preference would leak receipts
  after an opt-out. Mitigation: read preferences through the auth-owned service
  on each presentation path and test that a change takes effect immediately.
- **Secret-chat metadata.** The server stores a message id and timestamp for
  secret chats. This is metadata only and permitted by the E2EE spec; no
  ciphertext, nonce, or key material is read or changed.
- **Batched count cost.** Counting unread for many chats could degrade to an
  N+1. Mitigation: one `GROUP BY chat_id` query joined in memory, with a test
  asserting query count.
