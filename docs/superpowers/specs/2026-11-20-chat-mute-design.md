# Design — mute notifications per chat

Status: written after section-by-section approval on 2026-11-20; awaiting written-spec review.

## 1. Context and intent

Phase 2.6 is complete, including `@username` mentions. The next roadmap item is
Phase 2.7: “Mute notifications per chat.” Push notifications are not part of this
repository yet; they are explicitly Phase 5. This phase therefore delivers the
durable, caller-private mute setting and the API around it. Future notification
delivery will read the same state before sending a push.

Success means:

- a chat member can mute any existing chat for `8h`, `7d`, or forever, and can
  unmute with one idempotent request;
- the setting is stored per `(chat, user)`, survives restarts, and is visible
  only to the caller who set it;
- timed mutes expire without a background job, and expired values are reported
  as unmuted;
- chat responses expose the caller's current mute state without changing message
  delivery, unread counts, read receipts, or the mention inbox;
- no existing auth, E2EE, privacy, media, error-code, or configuration invariant
  regresses.

## 2. Goals

- Extend `chat_members` with nullable `muted_at` and `muted_until` columns and a
  reviewed Drizzle migration.
- Add a `MutePreset` domain value (`8h`, `7d`, `forever`) and a `MuteState`
  projection that computes active mute and expiry lazily.
- Add `setMute` to `ChatMemberRepository` and a focused `MuteService` in the
  messages logic layer.
- Add `PATCH /api/chats/:chatId/mute` with shared Zod schemas and a
  `DocumentedRouter` contract.
- Project `muted` and `muteExpiresAt` into caller-scoped chat views.
- Cover mapping, expiry, membership, isolation, validation, auth, and view
  projection with unit and integration tests; document behavior in `README.md`.

## 3. Confirmed decisions

1. **Setting only.** Store and expose the mute preference now. No push, in-app
   notification, or notification-dispatch abstraction is added in this phase.
2. **No delivery side effects.** Muting does not change message delivery, unread
   counts, read receipts, mention rows, or chat list ordering.
3. **Presets only.** The API accepts `8h`, `7d`, `forever`, or `null` to unmute.
   Clients cannot send arbitrary durations or timestamps.
4. **All existing chats.** Direct and secret chats support mute now. Group and
   channel chats will inherit the same `chat_members` columns when those phases
   are implemented.
5. **Single PATCH endpoint.** `PATCH /api/chats/:chatId/mute` sets a preset or
   clears it with `{ "preset": null }`, matching the existing
   `PATCH /:chatId/self-destruct` pattern.
6. **No new public surface requirements.** No new error codes, configuration
   values, auth schemes, or `.env.example` changes.

## 4. Non-goals

- Push or in-app notification delivery and any future Phase 5 transport.
- Suppressing unread counts, mention inbox entries, badges, message history, or
  message delivery.
- Arbitrary client-supplied durations, exact timestamps, or snooze semantics.
- Muting by group/channel admins on behalf of other users.
- New error codes, auth schemes, configuration values, or username rules.

## 5. Architecture overview

```text
PATCH /api/chats/:chatId/mute
  -> MessagesRouter (request scope, bearer auth, verified email, rate limit)
  -> MuteController (Zod-validated, ApiResponse)
       -> MuteService.setMute(userId, chatId, preset, now)
            -> MessagingPolicy.requireMember
            -> MutePreset.resolve(preset, now)
            -> ChatMemberRepository.setMute

GET /api/chats and single-chat responses
  -> ChatService -> ChatMemberRepository.find/listByChats
  -> MuteState.from(membership, now)
  -> ChatView(muted, muteExpiresAt)
  -> ChatController.present
```

`MuteService`, `MutePreset`, and `MuteState` live in the messages logic layer and
depend only on ports and domain values. Express types and HTTP statuses stay in
the web layer. Drizzle types never leave `data/`. Bindings are added to
`MESSAGES_TYPES` and `MessagesContainer`.

## 6. Data model and migration

Extend `chat_members`, owned by the messages module and exported from the schema
barrel:

| Column         | Type          | Constraints                                      |
| -------------- | ------------- | ------------------------------------------------ |
| `muted_at`     | `timestamptz` | nullable                                         |
| `muted_until`  | `timestamptz` | nullable                                         |

Semantics:

- `muted_at IS NULL` means the user has never muted this chat.
- `muted_at IS NOT NULL AND muted_until IS NULL` means muted forever.
- `muted_at IS NOT NULL AND muted_until > now()` means muted until that instant.
- `muted_until <= now()` means the mute has expired and is reported as unmuted.

Add a named check constraint:

```sql
muted_at is null and muted_until is null
or (muted_at is not null and (muted_until is null or muted_until > muted_at))
```

No new index is needed: `chat_members_pkey` covers `(chat_id, user_id)` and
`chat_members_user_id_index` already supports chat-list hydration. Generate the
next Drizzle migration after `0022` and review the SQL before applying it.

## 7. Domain values and expiry

Add `src/modules/messages/logic/entities/mute-preset.ts`:

- `MUTE_PRESETS = ['8h', '7d', 'forever'] as const`
- `MutePreset` union type derived from that tuple.
- `MutePreset.resolve(preset, now)` returns `{ mutedAt: now, mutedUntil: Date | null }`:
  - `8h` → now + 8 hours;
  - `7d` → now + 7 days;
  - `forever` → `null`.

Add `src/modules/messages/logic/entities/mute-state.ts`:

- `MuteState.from(membership, now)` returns `{ muted: boolean, expiresAt: Date | null }`.
- `muted` is true only when `mutedAt` is present and `mutedUntil` is either null
  or strictly after `now`.
- `expiresAt` is `mutedUntil` only for an active timed mute; otherwise it is null.
- Expired rows are not rewritten by reads. Setting or clearing a mute overwrites
  the stale values.

`MuteService.setMute(userId, chatId, preset, now = new Date())` accepts an
explicit `now` so tests are deterministic without adding a clock port. The
service is stateless and bound once in the messages container; only the
controller is request-scoped.

## 8. Repository and service

Extend `ChatMemberRepository` with:

```ts
setMute(
  chatId: string,
  userId: string,
  mutedAt: Date | null,
  mutedUntil: Date | null,
): Promise<ChatMemberRecord>;
```

The Postgres implementation updates only `(muted_at, muted_until)` for the
matching `(chat_id, user_id)` row and returns the refreshed record through the
existing mapper. Both `null` clears the setting. A missing membership updates no
rows; `MuteService` checks membership first through `MessagingPolicy.requireMember`
and therefore raises the existing `403 NOT_CHAT_MEMBER` error for non-members.

`MuteService` is stateless, injects `MessagingPolicy` and
`ChatMemberRepository`, and returns a `MuteState` plus `chatId`. It does not
check blocks: a private mute preference is like the existing self-destruct
preset, which also only requires membership.

## 9. HTTP contract

Add `PATCH /api/chats/:chatId/mute`:

- Middleware order: `RequestScopeMiddleware`, bearer auth,
  `RequireVerifiedEmailMiddleware`, `MessagesRateLimiter`.
- Params: `chatParamsSchema` (`chatId` UUID).
- Body: `{ preset: z.enum(MUTE_PRESETS).nullable() }`.
- Success `200` with `ApiResponse.ok`, data:

```json
{
  "chatId": "<uuid>",
  "muted": true,
  "muteExpiresAt": "2026-11-21T04:00:00.000Z"
}
```

`muteExpiresAt` is `null` for forever and for unmuted or expired state.

Add the same fields to chat list and single-chat responses as caller-private
fields next to `selfDestructPreset`:

```json
{ "muted": false, "muteExpiresAt": null }
```

Add an OpenAPI contract with operation id `messages.setMute`, the same Zod body
schema, and success/error envelopes. Invalid or missing presets return the
existing `400 VALIDATION_ERROR`; unauthenticated callers return `401
UNAUTHORIZED`; unverified callers return `403 EMAIL_NOT_VERIFIED`.

## 10. Testing

- Unit tests for `MutePreset.resolve` (`8h`, `7d`, `forever`) and
  `MuteState.from` (unmuted, forever, active timed, expired, stale expired row).
- Repository integration tests for set, update, and clear of both columns.
- API integration tests for:
  - set/clear round trips and idempotency;
  - caller-private visibility in chat views (peer's mute is never exposed);
  - membership enforcement (`403 NOT_CHAT_MEMBER`);
  - invalid preset and missing body (`400 VALIDATION_ERROR`);
  - auth and verified-email guards.
- Schema test that the generated table exposes the new columns and named check
  constraint.
- Live HTTP smoke with one success path and at least one error path. Use the
  local test database and clean up any temporary users and chats.

## 11. Documentation and operations

- Update `README.md` with the mute endpoint, preset values, response fields, and
  the note that muting does not stop message delivery or unread counting.
- No `.env.example` change and no deployment configuration change.
- Run `npm run typecheck`, `npm run build`, `npm run db:check`, changed-path
  Biome, and the full test suite. Whole-repo lint remains red only on the known
  pre-existing `tests/unit/is-prime.test.ts` issue; do not modify that file as
  part of this phase.

## 12. Risks and mitigations

- **Stale expired rows:** mitigated by computing state lazily and by overwriting
  stale values whenever the user sets or clears a mute.
- **Future notification mismatch:** mitigated by documenting that Phase 5 must
  reuse `MuteState.from`, not reimplement the predicate.
- **Privacy leak:** mitigated by deriving `muted`/`muteExpiresAt` only from the
  caller's own `chat_members` row.
- **Migration risk:** mitigated by adding nullable columns with a named check
  constraint and no backfill requirement.
