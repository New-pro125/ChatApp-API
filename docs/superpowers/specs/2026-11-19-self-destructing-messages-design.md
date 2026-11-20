# Design — per-sender self-destructing message presets

Status: written after section-by-section approval on 2026-11-19; awaiting written-spec review.

## 1. Context and intent

Phase 2.6 has already delivered read receipts, private pinned messages, and
caller-defined pin expiry. The remaining advanced-messaging requirement from the
feature document is: “Self-destructing messages (messages that disappear after a
set time)” and, under security features, “Self-destruct timers for messages and
media.”

The chosen behavior is a per-chat, per-sender timer modelled on the way the
human partner described WhatsApp: either participant can control their own
timer for that chat, and that timer affects only messages that participant sends
later. It is not a shared chat-wide switch, it is not retroactive, and it does
not expose a per-message countdown in the API.

Success means:

- a user can set, change, or clear their own timer for a chat using the presets
  `24h`, `7d`, and `90d`;
- each caller sees only their own current preset in `GET /api/chats`;
- later messages sent by that user in that chat—cloud text, cloud media, and
  secret-chat ciphertext—receive a server-computed expiry;
- elapsed messages are immediately invisible on every read and target lookup,
  without waiting for a worker;
- a repeatable job scrubs elapsed rows, clears their content, removes pins, and
  releases shared media after the last live reference is gone;
- secret-chat ciphertext is never decrypted or exposed, and no existing E2EE,
  privacy, media-GC, read-receipt, or error-code invariant regresses.

## 2. Goals

- Add a nullable self-destruct preset to chat membership and a nullable expiry
  timestamp to messages, with a reviewed Drizzle migration.
- Add `PATCH /api/chats/:chatId/self-destruct` accepting
  `{ preset: '24h' | '7d' | '90d' | null }`.
- Add `selfDestructPreset` to each chat item returned by `GET /api/chats`.
- Resolve the sender's preset on every message creation path and store
  `expiresAt = server now + preset duration` on the new row.
- Filter every message read, lookup, unread count, and media-reference check so
  elapsed messages are treated as absent.
- Add a BullMQ repeatable cleanup worker that scrubs elapsed rows in bounded
  batches and releases media safely.
- Add configuration for the cleanup interval and update `.env.example` and
  `README.md`.
- Cover the behavior with schema, repository, service, controller, worker,
  secret-chat, media, pin, and read-receipt tests.

## 3. Confirmed decisions

1. **Per-chat, per-sender setting.** Timer state is keyed by `(chat, user)`.
   Either participant may set, change, or clear only their own row.
2. **Presets only.** Accepted values are `24h`, `7d`, `90d`, and `null` (off).
   There is no arbitrary custom duration and no environment-configured preset
   list.
3. **Not retroactive.** Changing or clearing a preset affects only messages sent
   afterwards. Messages that already have an expiry keep their original
   deadline.
4. **Applies to all send paths in scope.** Cloud text, cloud media attachments,
   combined media uploads, secret-ciphertext messages, and forwarded messages
   created in a chat all inherit the sender's current preset for that target
   chat.
5. **Server-computed deadline.** The request never carries an expiry. The server
   computes `expiresAt` from its own clock when the row is created.
6. **Only the setting is visible.** Individual message responses do not expose
   `expiresAt`, remaining time, or a timer flag. Each caller sees only their own
   `selfDestructPreset` in the chat list; the peer's preset is never returned.
7. **Hide now, scrub later.** Reads and lookups filter elapsed rows immediately.
   A BullMQ job physically scrubs them; a Redis or worker outage never makes an
   elapsed message visible.
8. **Content cleared, metadata retained.** Scrubbing sets `deletedAt`, clears
   body/ciphertext/E2EE/media fields, removes pins, and keeps the id, chat,
   sender, timestamps, and reply/forward metadata as a tombstone.
9. **Shared media is released last.** The expiring row's media columns are
   cleared and `releaseIfUnreferenced` uses an expiry-aware live-reference check,
   so the S3 object is deleted only when no live message still references it.
10. **Expired targets are gone.** Edit, delete, forward, pin, mark-read, and
    reply-target lookups filter elapsed messages and return the existing `404`
    behavior.
11. **No new public error codes.** Invalid presets produce the existing
    `400 VALIDATION_ERROR`; auth, membership, and not-found behavior is
    unchanged.
12. **No E2EE behavior change.** Secret messages remain ciphertext-only and
    immutable; the cleanup worker never reads plaintext or decrypts anything.

## 4. Non-goals

- A shared chat-wide disappearing-messages switch.
- Custom second-based durations, server-defined duration configuration, or
  per-message expiry overrides.
- Exposing expiry timestamps, countdowns, or timer flags on message views.
- Retroactively changing existing messages when a preset changes or clears.
- Notifications, client countdown rendering, or a dedicated `GET` setting
  endpoint.
- New error codes, a generic job framework in `core`, or a separate worker
  process.
- Group or channel semantics; only today's direct and secret one-to-one chats
  are exercised, though the data model is membership-based.
- Hard-deleting message rows. Expired non-media and secret messages become
  tombstones; media objects are deleted when unreferenced.

## 5. Architecture overview

```
PATCH /api/chats/:chatId/self-destruct { preset | null }
  -> Zod validation + bearer auth + verified email + membership + rate limit
  -> ChatMemberRepository.setSelfDestructPreset(chatId, userId, preset)
  -> only the caller's chat_members row is updated

GET /api/chats
  -> ChatService.listForUser already loads caller memberships
  -> ChatView gains selfDestructPreset from the caller's membership

Send paths (text, media attach/upload, secret, forward)
  -> MessageService resolves the sender's preset for the target chat
  -> expiresAt = now + presetSeconds (or null)
  -> CreateMessageInput/CreateSecretMessageInput carry expiresAt
  -> messages row stores expires_at; no response field is added

Reads and target lookups
  -> every message query filters deleted_at is null AND
     (expires_at is null OR expires_at > now())
  -> elapsed rows are absent from history, unread counts, and lookups

Cleanup
  -> MessagesModule.configure() starts SelfDestructCleanupWorker
  -> repeatable BullMQ job lists a bounded batch of expired live rows
  -> for each row: remove pins, release media (expiry-aware), scrub content
  -> MessagesModule.dispose() closes the worker/queue
```

## 6. Data model and migration

- Generate a new migration after `0016`; never edit an applied migration.
- `chat_members` gains:
  - `self_destruct_preset text`, nullable, default `null`;
  - named check `chat_members_self_destruct_preset_check` allowing
    `('24h', '7d', '90d')` or `null`.
- `messages` gains:
  - `expires_at timestamptz`, nullable, default `null`;
  - named check `messages_expires_at_check` requiring
    `expires_at is null or expires_at > created_at`;
  - named non-unique index `messages_expires_at_index` on `expires_at` so the
    partition-wide cleanup scan is indexed.
- No backfill: existing memberships and messages get `null`, which means “no
  timer”. This preserves all current data.
- Because `messages` is hash-partitioned by `chat_id`, Drizzle Kit emits an
  `ALTER TABLE` that PostgreSQL propagates to all sixteen partitions. Review the
  generated SQL and verify propagation with `npm run db:check` and schema tests.
- Keep the composite `(chat_id, id)` primary key and the existing no-FK rule for
  cross-partition references. Add no FK involving `expires_at`.
- Drizzle types remain in the data layer. `ChatMemberRecord` and `ChatView` gain
  `selfDestructPreset: SelfDestructPreset | null`. `MessageRecord` gains
  `expiresAt: Date | null` for internal use and tests, but the presenter/OpenAPI
  schema deliberately omit it.
- Define `SelfDestructPreset` and its seconds map as domain values in the
  messages module; the web layer uses the same string literals in Zod.

## 7. Domain, repository, and service behavior

### Setting

- `ChatMemberRepository.setSelfDestructPreset(chatId, userId, preset)` updates
  only the caller's membership row and returns the updated `ChatMemberRecord`.
- `ChatMemberMapper` and the explicit membership selection include the new
  column. `ChatService.listForUser` maps the caller's membership into `ChatView`
  without an extra query.
- The setting is accepted for any chat the caller can access. Validation of
  chat type, membership, and verified email follows existing message routes.

### Sending

- `CreateMessageInput` and `CreateSecretMessageInput` gain
  `expiresAt?: Date | null`; the repository treats an omitted or null value as
  no timer. All `MessageService` send paths always pass the resolved value
  explicitly, so production behavior is unambiguous while existing direct
  repository test helpers keep working.
- A small domain helper maps preset to seconds:
  `24h = 86400`, `7d = 604800`, `90d = 7776000`.
- `MessageService` resolves the sender's membership once per send path and
  computes the deadline before calling the repository. The same resolution is
  used by forwarded messages in the target chat.
- If the sender has no preset, `expiresAt` is `null` and behavior is unchanged.
- If the sender changes or clears the preset afterwards, stored message
  deadlines are untouched.

### Read-time filtering

Add the expiry predicate to every message read or lookup query:

- `findById`
- `listByChat`
- `listByIds`
- `maxIdByChat`
- `countUnread`
- `countUnreadByChats`
- `hasLiveMediaReferences`
- the message join used by `MessagePinRepository.list` and `listPinnedFor`

The predicate is `expires_at is null or expires_at > now()`. It is added to each
query's **existing** conditions; it does not change how manually deleted
tombstones are treated. In particular, `listByChat` still returns manual
delete tombstones with a null body, while `countUnread` and
`hasLiveMediaReferences` keep their existing `deleted_at is null` requirement.
This keeps pagination, unread counts, read watermarks, pins, and media GC
consistent without waiting for the worker. `markRead` therefore cannot advance
to an elapsed id, and an elapsed message cannot be used as a reply target.

### Scrub repository operations

- `listExpired(now, limit): Promise<MessageRecord[]>` returns at most `limit`
  live rows whose `expires_at <= now()`, using `FOR UPDATE SKIP LOCKED` where
  practical. It includes `mediaId` through the existing `MessageRecord.media`
  shape.
- `scrubExpired(chatId, id, deletedAt): Promise<boolean>` conditionally updates
  only a still-live expired row: it sets `deleted_at`, nulls `body`, `ciphertext`,
  `nonce`, `ephemeral_public_key`, `sender_device_id`, `recipient_device_id`,
  `media_id`, `media_kind`, `caption`, `duration_ms`, `width`, and `height`, and
  leaves `expires_at`, reply/forward ids, sender, and timestamps intact. The
  update returns false when another worker already scrubbed the row.
- The worker processes in this order per row: remove pins, release media, then
  scrub. Because `hasLiveMediaReferences` already ignores expired rows, media
  release succeeds even while the expiring row still exists. If release fails,
  the job fails before scrubbing, so a retry sees the same row and retries the
  release. Scrub is conditional and idempotent, so overlapping replicas are
  harmless.

## 8. HTTP contract

### Change setting

- `PATCH /api/chats/:chatId/self-destruct`
- Middleware chain matches other authenticated message writes: bearer auth,
  verified email, request scope, chat membership, and the messages rate limiter.
- Body schema:
  `{ preset: z.enum(['24h', '7d', '90d']).nullable() }`. The field is required;
  omitting it is a validation error, while `null` explicitly clears the timer.
- Success: `200` with `{ preset: SelfDestructPreset | null }` through
  `ApiResponse.ok`.
- The chat id must belong to a chat the caller is a member of; existing
  authorization errors are reused.

### Read setting

- No new endpoint. `ChatView` and its OpenAPI schema gain
  `selfDestructPreset: z.enum(['24h', '7d', '90d']).nullable()`.
- The value is the caller's own setting. The peer's setting is not derivable from
  the response.

### Message responses

- No message schema, presenter, or contract changes. Do not add `expiresAt`,
  `selfDestruct`, or a preset field to message views.

### Expired targets

- Because all target lookups use the filtered `findById`, edit, delete, forward,
  pin, unpin, mark-read, and reply targets return the existing `404 NOT_FOUND`
  for an elapsed message.
- Unknown chat, non-member, blocked peer, unverified account, and invalid body
  continue to use their existing codes and ordering.

## 9. Cleanup worker

- `SelfDestructCleanupWorker` is a request-independent service in the messages
  container, injected with the message repository, pin repository, core
  `MediaAccess`, Redis, config, and logger.
- `MessagesModule.configure()` starts it alongside `PinCleanupWorker`;
  `MessagesModule.dispose()` closes it before container disposal.
- It owns one BullMQ `Queue` named `self-destruct-cleanup` and one `Worker` with
  concurrency 1. A stable scheduler key registers a repeatable job with
  `every: SELF_DESTRUCT_CLEANUP_INTERVAL_MINUTES * 60_000`.
- Each tick lists up to `100` expired rows, processes them, and repeats up to a
  safety cap of `100` batches. Missing rows or already-scrubbed rows are no-ops.
- It logs the number of rows scrubbed and any media-release failure. Worker and
  queue are closed worker-first.
- Read-time filtering remains authoritative; the worker is privacy/storage
  hygiene.

## 10. Configuration

- Add `SELF_DESTRUCT_CLEANUP_INTERVAL_MINUTES` to `AppConfig` through
  `EnvironmentReader` only, default `5`, validated as a positive integer.
- Document it in `.env.example` and `README.md`.
- Preset values are static domain constants and are not environment configured.

## 11. Error handling

- No changes to `ErrorMapper` or shared OpenAPI error components.
- Invalid or missing preset: existing Zod path → `400 VALIDATION_ERROR`.
- Elapsed message target: existing `NotFoundException` → `404 NOT_FOUND`.
- Auth, email-verification, membership, and blocked-user errors keep their
  current status and codes.
- Repository failures remain wrapped in `PersistenceException`; raw `pg` errors
  are never exposed.

## 12. Testing strategy

- **Schema tests:** new columns, check constraints, and index; verify partition
  propagation.
- **Repository/service tests:** preset round-trip on membership; exact deadline
  computation for all three presets; no expiry when preset is null; changing or
  clearing preset does not alter old messages; filtered find/list/count/max/lookup
  after expiry; scrub clears content but keeps metadata; scrub is idempotent.
- **HTTP tests:** `PATCH` success for all presets and `null`; missing/invalid
  preset `400`; unauthenticated/unverified/non-member/unknown-chat errors;
  `GET /api/chats` exposes only the caller's preset; no expiry field appears in
  any message response.
- **Integration interaction tests:** expired messages are `404` for edit,
  delete, forward, pin, mark-read, and reply targets; unread counts ignore them;
  read receipts still work for visible messages; existing manual delete before
  expiry behaves as today.
- **Secret-chat tests:** ciphertext messages get expiries; elapsed ciphertext is
  hidden and scrubbed without decryption; all `E2EE_NOT_ALLOWED` rules remain.
- **Media tests:** an expiring media message releases its object only after the
  last live forward expires; forwarded copies keep working until their own
  deadline; pins on the expiring message are removed.
- **Worker tests:** scheduler registration, bounded batches, pin removal, media
  release, scrub, retry after media-release failure, and clean shutdown.
- **Time control:** tests move `expires_at` into the past with controlled DB
  updates instead of sleeping.
- Full gate: `npm run verify`, `npm run db:check`, and a live HTTP smoke with at
  least one success and one error path, temporary users removed, and started
  processes stopped.

## 13. Documentation

- `README.md`: document the presets, per-sender and non-retroactive semantics,
  `PATCH` body and response, the `selfDestructPreset` chat-list field, the fact
  that message responses do not expose expiry, expiry as `404`, the scrub worker,
  and the new config variable.
- `.env.example`: add `SELF_DESTRUCT_CLEANUP_INTERVAL_MINUTES=5` with a short
  comment.
- Migration and Drizzle schema are the source of truth for storage; no schema
  drift is acceptable.

## 14. Risks and mitigations

- **Watermarks may point at hidden or scrubbed ids.** Mitigation: read watermarks
  remain monotonic id comparisons, and counts filter expired rows; no FK to the
  partitioned `messages` table exists.
- **Reply/forward stubs may reference a tombstone.** Mitigation: this already
  happens for manually deleted messages; metadata is retained and target lookups
  return `404`.
- **Media object leak.** Mitigation: expiry-aware `hasLiveMediaReferences`,
  release before scrub, job retry before scrub on release failure, and existing
  reference-counted GC.
- **Concurrent workers or replicas.** Mitigation: stable scheduler key, bounded
  `SKIP LOCKED` listing, conditional idempotent scrub, and idempotent pin/media
  cleanup.
- **Redis/worker outage.** Mitigation: read-time filtering is authoritative, so
  elapsed messages remain invisible and data is eventually scrubbed when the job
  recovers.
- **E2EE regression.** Mitigation: the worker only nulls ciphertext metadata
  columns; no send, read, or cleanup path decrypts or validates plaintext.
- **Privacy surprise: setting visibility.** Mitigation: only the caller's own
  preset is returned in chat lists; no per-message timer metadata is exposed.

## 15. Acceptance criteria

- All goals in section 2 are implemented and covered by tests.
- `npm run verify` and `npm run db:check` pass on the final tree.
- Live HTTP smoke covers setting, clearing, sending with a timer, elapsed-message
  hiding, `404` on an expired target, invalid preset, and secret/media
  interaction, with all temporary users removed.
- No new public error codes, no per-message expiry response fields, no ciphertext
  reads in cleanup code, and no uncommitted plan or secret files.
