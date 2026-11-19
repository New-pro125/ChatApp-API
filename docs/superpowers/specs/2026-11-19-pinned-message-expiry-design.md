# Design — expiring pinned messages

Status: written after section-by-section approval on 2026-11-19; awaiting written-spec review.

## 1. Context and intent

Phase 2.6 delivered private, per-user pinned messages for direct cloud chats and
secret chats. A pin is currently permanent: it exists until the owner unpins it
or the message is soft-deleted. The cap is ten pins per `(chat, user)`.

The next requirement is to make a pin time-bounded: the caller chooses a
duration when pinning, and the pin stops being a pin once that duration elapses.
Elapsed pins must disappear from the caller's pin list and from the `pinnedAt`
indicator on message history without a client refresh, must immediately free a
cap slot, and must eventually be deleted from storage by a scheduled job.

Success means:

- a pin carries a server-computed expiry derived from a caller-supplied duration;
- elapsed pins are invisible to their owner in `GET /pins` and message history;
- elapsed pins do not consume one of the ten cap slots;
- a scheduled job physically removes elapsed rows, independent of request traffic;
- re-pinning an active message stays idempotent with the original timestamps;
- all privacy, metadata-only, and error-code invariants from the pinned-messages
  design remain intact.

## 2. Goals

- Add an `expires_at` column to `message_pins` with a new migration and a backfill
  for rows created before this change.
- Filter all pin reads and the cap count on `expires_at > now()`.
- Accept a required `durationSeconds` on `POST /pin`, bounded to 60..604800
  (1 minute to 7 days), server-validated.
- Return `expiresAt` on pin responses and `pinExpiresAt` on message views.
- Add a BullMQ repeatable cleanup job that deletes elapsed pin rows in bounded
  batches, started and stopped with the messages module lifecycle.
- Add configuration for the cleanup interval, and update `.env.example` and
  `README.md`.
- Extend schema, migration, ports, repository, service, DTOs, OpenAPI contracts,
  presenter, module lifecycle, worker, and tests consistently.

## 3. Confirmed decisions

1. **Caller chooses the duration per pin.** `POST /pin` carries
   `durationSeconds`; the server enforces the bounds and computes the absolute
   `expiresAt`. The caller cannot supply an absolute timestamp.
2. **Required, bounded duration.** `durationSeconds` is a required integer in
   `60..604800`. There is no default and no configuration for the bounds.
3. **Filter on read plus scheduled physical delete.** Reads and the cap count
   filter `expires_at > now()`; a BullMQ repeatable job deletes elapsed rows.
   Read-time filtering is authoritative, so a Redis or job outage only leaves
   invisible rows behind — it never shows an expired pin.
4. **Active re-pin stays idempotent.** Pinning a message that already has an
   *active* pin returns that pin unchanged (`pinnedAt` and `expiresAt` preserved).
5. **Expired re-pin starts fresh.** If the stored pin is already elapsed, a new
   pin is written with a new `pinnedAt` and a new `expiresAt` from the supplied
   duration. The elapsed row is replaced inside the same transaction.
6. **Cleanup runs as a BullMQ repeatable job.** A `Queue` + `Worker` on the
   existing Redis, hosted by the messages module (approach A) — no new process
   and no changes to `Application`.
7. **Expose expiry everywhere.** `POST /pin` returns
   `{ messageId, pinnedAt, expiresAt }`; message views and `GET /pins` rows carry
   both `pinnedAt` and `pinExpiresAt`, each `null` when there is no active pin.
8. **Reuse existing error codes.** No new codes: invalid duration is
   `400 VALIDATION_ERROR`; all existing pin/auth/membership/404/409 behavior is
   unchanged.

## 4. Non-goals

- Extending or stacking the duration of an active pin by pinning again.
- Notifications or client-side countdown timers; the API only supplies the
  deadline.
- Changing the cap (still ten per `(chat, user)`), the pin ordering, the privacy
  model, or support for secret chats.
- Physically deleting the pinned *message*; cleanup only removes pin metadata.
- Group chats, channels, or a separate worker process.
- A generic job framework in `core`.

## 5. Architecture overview

```
POST /pin { durationSeconds }
  -> Zod bounds validation (web)
  -> PinService.pin(userId, chatId, messageId, durationSeconds)
       -> membership + live-message checks (unchanged)
       -> expiresAt = now + durationSeconds * 1000 (server clock)
  -> PostgresMessagePinRepository.pin(..., expiresAt)
       -> transaction + FOR UPDATE on chat_members row (unchanged)
       -> active existing pin? return it; expired? replace it
       -> count only expires_at > now(); insert when below cap

Reads (GET /pins, history)
  -> repository filters expires_at > now()
  -> PinService returns { pinnedAt, expiresAt }
  -> MessagePresenter emits pinnedAt + pinExpiresAt

Cleanup
  -> MessagesModule.configure() -> PinCleanupWorker.start()
  -> repeatable BullMQ job -> MessagePinRepository.deleteExpired(now, 100)
  -> MessagesModule.dispose() -> worker/queue closed
```

## 6. Data model and migration

- New migration `0016`, generated with `npm run db:generate` and reviewed as SQL.
- Add `expires_at timestamptz` to `message_pins`:
  1. `ADD COLUMN expires_at timestamptz` (nullable),
  2. `UPDATE message_pins SET expires_at = now() + interval '1 day'` (backfill
     every row that existed before the change),
  3. `ALTER COLUMN expires_at SET NOT NULL`.
  A single additive column with a backfill keeps the existing rows valid.
- Add index `message_pins_expires_at_index ON message_pins (expires_at)` so the
  bounded cleanup scan does not table-scan.
- Keep the existing composite primary key `(chat_id, user_id, message_id)` and
  `(chat_id, user_id, pinned_at DESC)` index.
- Keep **no FK** from `message_pins` to the partitioned `messages` table. The
  `chat_members` and `users` FKs remain as-is.
- The Drizzle schema adds `expiresAt: timestamp('expires_at', { withTimezone:
  true }).notNull()` to `messagePins`, plus the named index. The Drizzle Kit
  barrel is unchanged.
- `PinRecord` gains `readonly expiresAt: Date`; `MessagePinMapper`/`pinSelection`
  include the new column. Drizzle types stay inside the data layer.

## 7. Repository and service behavior

- `pin(chatId, userId, messageId, expiresAt)`:
  - keeps the `FOR UPDATE` lock on the caller's `chat_members` row;
  - loads any existing pin. If `expires_at > now()`, return it unchanged
    (idempotency); if it is elapsed, remove it as part of the transaction;
  - counts only rows with `expires_at > now()` toward `PIN_LIMIT = 10`;
  - inserts with `expiresAt` and returns the mapped record.
- `list` and `listPinnedFor` add `gt(messagePins.expiresAt, new Date())` to their
  `WHERE` clauses, so elapsed pins are never returned even before cleanup.
- `deleteExpired(now, limit): Promise<number>` deletes at most `limit` rows where
  `expires_at <= now()`, using a CTE with `FOR UPDATE SKIP LOCKED` on the candidate
  ids so concurrent cleanup jobs do not contend. Returns the deleted count.
- `unpin` and `removeForMessage` are unchanged: they delete all matching rows,
  active or elapsed, and remain idempotent.
- `PinService.pin(userId, chatId, messageId, durationSeconds)` computes the
  absolute expiry from the server clock and delegates; it keeps the existing
  `requireMember` and `requireLiveMessage` checks in the same order, so a
  non-member or a deleted/foreign message still yields the same errors before any
  write.
- `PinService.list` returns `PinnedMessage[]` where each item carries
  `{ message, pinnedAt, expiresAt }`.
- `PinService.listPinnedFor` returns
  `Map<string, { pinnedAt: Date; expiresAt: Date }>` for the batched history
  indicator lookup.
- No Express types or HTTP status codes enter the service or repository layers.

## 8. HTTP contract

- `pinMessageSchema` (web/DTO) adds a body:
  `{ durationSeconds: z.number().int().min(60).max(604800) }`, required.
  Non-integer, out-of-range, or missing values produce `400 VALIDATION_ERROR`
  through the existing Zod error path.
- `POST /api/chats/:chatId/messages/:messageId/pin` returns `201` with
  `{ messageId, pinnedAt, expiresAt }`; `expiresAt` uses `z.iso.datetime()`.
- `messageSchema` and the `GET /pins` response gain
  `pinExpiresAt: z.iso.datetime().nullable()`. `pinnedAt` remains nullable. Both
  are `null` when the caller has no active pin on that message.
- `MessagePresenter.present` takes a
  `ReadonlyMap<string, { pinnedAt: Date; expiresAt: Date }>` as its third argument
  and emits `pinnedAt` and `pinExpiresAt` from it.
- The same Zod schemas document requests and validate them in controllers; the
  OpenAPI document is generated from those schemas, so no second schema is
  maintained.
- `DELETE /pin` and `GET /pins` keep their current paths, methods, middleware
  chain, envelopes, and status codes.

## 9. Cleanup worker

- `PinCleanupWorker` is a request-independent service in the messages container,
  injected with the repository port, logger, config, and the root Redis client.
- `MessagesModule.configure()` starts it after the rate limiter is initialized;
  `MessagesModule.dispose()` closes it before unbinding the container.
- It creates one BullMQ `Queue` named `pin-cleanup` and one `Worker` on that
  queue with concurrency 1. Repeatable job: a stable job name with `every:
  PIN_CLEANUP_INTERVAL_MINUTES * 60_000`. `every` avoids cron divisors, and the
  repeatable job's stable key deduplicates registration across replicas.
- The processor calls `deleteExpired(new Date(), 100)` in a bounded loop until a
  batch deletes fewer than 100 rows (safety cap of 100 batches per tick), and
  logs the total. Each delete is idempotent, so overlapping ticks or replicas
  are harmless.
- On `close()`, the worker is closed before the queue so no in-flight job is
  lost mid-write. The app's shutdown timeout already bounds this.
- If Redis is unavailable, BullMQ retries per its own backoff; read-time
  filtering remains authoritative, so correctness does not depend on the job.

## 10. Configuration

- Add `PIN_CLEANUP_INTERVAL_MINUTES` to `AppConfig` through `EnvironmentReader`
  only; no other file reads `process.env`. Default `5`, positive integer,
  validated at construction like `StoryConfig`.
- Document the variable in `.env.example` and `README.md`.
- Pin duration bounds are static Zod constants, not environment configuration.

## 11. Error handling

- No new public error codes; no changes to `ErrorMapper` or the shared OpenAPI
  error components beyond the existing `VALIDATION_ERROR` body details.
- `403 NOT_CHAT_MEMBER`, `403 EMAIL_NOT_VERIFIED`, `401 UNAUTHORIZED`,
  `404 NOT_FOUND` for foreign/deleted messages, and `409 CONFLICT` at the cap
  keep their current behavior and ordering relative to validation.
- Repository failures continue to be wrapped in `PersistenceException`; raw
  `pg` errors are never exposed.

## 12. Testing strategy

- **Repository/service integration tests:** cap slot is freed after expiry;
  active re-pin preserves `pinnedAt`/`expiresAt`; expired re-pin creates a fresh
  pin; `list` and `listPinnedFor` exclude elapsed pins; `deleteExpired` only
  removes elapsed rows and respects the limit; `removeForMessage` still removes
  all pins for a deleted message.
- **HTTP tests:** missing/non-integer/out-of-range `durationSeconds` return
  `400 VALIDATION_ERROR`; `201` response contains `expiresAt`; history and
  `GET /pins` rows contain `pinExpiresAt` for the caller and `null` for the other
  participant; existing auth, membership, 404, and 409 paths still pass.
- **Worker test:** drive the processor directly (or enqueue and await one job)
  and assert elapsed rows are deleted while active rows remain; assert shutdown
  closes the worker/queue without leaving timers.
- **Time control:** tests move `expires_at` into the past with a controlled DB
  update instead of sleeping. No test depends on wall-clock waiting.
- **Expiry simulation for HTTP tests:** create with the minimum 60-second
  duration, then set `expires_at` to the past directly in the database.
- Full gate: `npm run verify` and `npm run db:check`, plus a live HTTP smoke that
  covers the new success and error paths and cleans up its users.

## 13. Documentation

- `README.md`: document the required `durationSeconds`, the 60..604800 bounds,
  idempotency rules, automatic expiry, the `expiresAt`/`pinExpiresAt` fields, the
  cleanup job, and the new config variable.
- `.env.example`: add `PIN_CLEANUP_INTERVAL_MINUTES=5` with a short comment.
- Migration and Drizzle schema are the source of truth for storage; no schema
  drift is acceptable (`npm run db:check`).

## 14. Risks and mitigations

- **Breaking request change.** `POST /pin` previously accepted no body; callers
  must now send `durationSeconds`. Mitigation: explicit documentation, a Zod
  `400 VALIDATION_ERROR` for missing values, and a live smoke assertion.
- **Backfilled pins expire in one day.** Existing pins get `now() + 1 day`.
  Mitigation: documented in the migration and README; no data loss beyond the
  intended expiry semantics.
- **Redis/job outage.** Mitigation: read-time filtering is authoritative, so
  expired pins stay hidden and cap slots stay free even if physical deletion is
  delayed.
- **Concurrent cleanup/replica overlap.** Mitigation: fixed repeatable-job id,
  `SKIP LOCKED`, bounded batches, and idempotent deletes.
- **Time-source skew.** Mitigation: the server computes `expiresAt` from its own
  clock; the client never supplies an absolute deadline.
- **Privacy regression.** Mitigation: all new fields are caller-scoped through
  the existing authenticated `userId`, and no ciphertext is read or written.

## 15. Acceptance criteria

- All goals in section 2 are implemented and covered by tests.
- `npm run verify` and `npm run db:check` pass on the final tree.
- Live HTTP smoke passes at least one success path and the new
  `400 VALIDATION_ERROR` path, plus the existing auth/membership/cap error paths,
  with temporary users removed and processes stopped.
- No new public error codes, no FK to `messages`, no ciphertext reads from pin
  code, and no uncommitted plan or secret files.
