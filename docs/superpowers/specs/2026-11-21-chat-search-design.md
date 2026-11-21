# Design — chat search (Phase 2.8)

Status: written after section-by-section approval on 2026-11-21; awaiting written-spec review.

## 1. Context and intent

Phase 2.7 (caller-private per-chat mute) is complete. The next roadmap item in
`plan.md` is Phase 2.8: “Chat search (keyword search within chats) — PostgreSQL
FTS”. `Features Document Telegram.docx` states “Search within chats for messages
(by keyword).” The E2EE spec explicitly requires this phase to exclude
`type = 'secret'` (§ “Out of scope” and § “Security invariants”).

Success means:

- a chat member can search one cloud chat by keyword and get matching messages
  newest-first, with keyset pagination identical to message history;
- keyword matches include both message bodies and media captions, case-insensitively
  and with English stemming;
- deleted, expired, secret-chat, and other-chat rows are never returned;
- a secret chat is rejected with the existing `403 E2EE_NOT_ALLOWED`;
- no existing auth, E2EE, privacy, media, error-code, or configuration invariant
  regresses.

## 2. Goals

- Add one Drizzle-declared GIN expression index over message body and caption,
  plus a reviewed Drizzle migration.
- Add a `search` method to `MessageRepository` and implement it in
  `PostgresMessageRepository` with bound parameters and partition pruning.
- Add a focused `SearchService` in the messages logic layer for membership and
  secret-chat checks.
- Add `GET /api/chats/:chatId/messages/search` with a shared Zod query schema and
  a `DocumentedRouter` contract.
- Reuse the existing message view presenter, cursor envelope, and error codes.
- Cover the index plan, query semantics, authorization, validation, and HTTP
  behavior with unit/integration tests and a live smoke; document in `README.md`.

## 3. Confirmed decisions

1. **Per-chat scope only.** The endpoint searches one chat identified by
   `chatId`. A cross-chat or global search belongs to Phase 7 and is not built
   here.
2. **Newest-first with an id cursor.** Results use the same ordering and
   `meta.pagination.nextCursor` contract as `GET /:chatId/messages`; ids are
   uuidv7, so the cursor is the last message id. No relevance ranking in this
   phase.
3. **Body + media caption.** Both are user-authored message text. Media-type
   filtering remains Phase 7.3; secret ciphertext is never indexed.
4. **Expression GIN index, no generated column.** One `to_tsvector` expression
   is shared as a declarative SQL fragment by the schema index and the query, so
   they cannot drift. No new columns, triggers, or backfill task.
5. **`websearch_to_tsquery('english', q)`.** Users get quoted phrases,
   `-exclusion`, and `or` without a custom parser; PostgreSQL handles unusual
   punctuation safely. The config is fixed to `english` for this phase.
6. **Rate-limited read.** The endpoint uses the shared `rl:messages:` bucket
   because a full-text query is more expensive than a keyset history read.
7. **No new public surface requirements.** No new error codes, auth schemes,
   configuration values, or `.env.example` changes.

## 4. Non-goals

- Cross-chat, global, or public message search (Phase 7).
- Relevance ranking, snippets/highlighting, fuzzy/typo tolerance, or
  language-specific configurations beyond `english`.
- Media-type filters and search over media binary content (Phase 7.3).
- Searching secret-chat ciphertext, drafts, pinned-message metadata, or chat
  titles.
- New error codes, config values, or changes to the response envelope.

## 5. Architecture overview

```text
GET /api/chats/:chatId/messages/search?q=...&limit=...&cursor=...
  -> MessagesRouter (request scope, bearer auth, verified email, rate limit)
  -> MessageController.search (shared Zod query schema, ApiResponse.cursor)
       -> SearchService.search(userId, chatId, query)
            -> MessagingPolicy.requireMember
            -> ChatRepository.findById -> reject chat.type === 'secret'
            -> MessageRepository.search(chatId, query)
                 -> messageSearchVector @@ websearch_to_tsquery('english', q)
                 -> order by id desc, limit
       -> MessagePresenter + ReadReceiptService + PinService + MentionService
```

`SearchService` and the repository port live in the messages logic layer;
Express types and HTTP statuses stay in `web/`. Drizzle types never leave
`data/`. The new binding is `MESSAGES_TYPES.SearchService` in `MessagesContainer`.

## 6. Index and query expression

Add a named index in `src/core/database/schema/messaging.schema.ts` on the
hash-partitioned `messages` table:

```ts
index('messages_search_index').using('gin', messageSearchVector)
```

where `messageSearchVector` is an exported declarative `sql` fragment equivalent
to:

```sql
to_tsvector(
  'english',
  coalesce("body", '') || ' ' || coalesce("caption", '')
)
```

`coalesce` is required because text rows have a body and media rows may have only
a caption; both can be null on scrubbed tombstones. The fragment is imported by
`PostgresMessageRepository` so the index and predicate use identical text,
configuration, and expression shape. Drizzle Kit 0.31 / drizzle-orm 0.45 support
expression indexes via `index(...).using('gin', sql...)`; the generated migration
must be reviewed to confirm `CREATE INDEX ... USING gin (...)` propagates to every
partition.

Add no columns. The generated migration should contain only the index DDL plus
Drizzle metadata changes. Review the SQL, then apply with `npm run db:migrate`.

## 7. Query semantics

`MessageRepository.search(chatId, query)` accepts:

```ts
interface SearchMessagesQuery {
  q: string;
  limit: number;
  beforeId?: string | undefined;
}
```

`PostgresMessageRepository.search` builds one query with `and(...)`:

- `eq(messages.chatId, chatId)` — always present, so PostgreSQL prunes to one
  hash partition;
- the shared expression matched against a bound parameter:
  ```sql
  messageSearchVector @@ websearch_to_tsquery('english', $q)
  ```
- `inArray(messages.type, ['text', 'media'])` — excludes secret and system rows;
- `isNull(messages.deletedAt)` and the existing `notExpired()` predicate;
- `lt(messages.id, beforeId)` when a cursor is supplied.

Ordering is `desc(messages.id)`, limit is `query.limit`, and rows are mapped with
the existing `messageSelection` and `MessageMapper`. Failures are wrapped in
`PersistenceException`. No count query: the controller fetches `limit + 1` and
derives `nextCursor` exactly as `MessageController.list` does.

## 8. Service and authorization

`SearchService.search(userId, chatId, query)`:

1. `await policy.requireMember(chatId, userId)` — non-members and unknown chats
   get `403 NOT_CHAT_MEMBER` before any text query runs.
2. Load the chat with `ChatRepository.findById`; if `chat?.type === 'secret'`,
   throw `E2eeNotAllowedException` (the same exception `MessageService` uses for
   plaintext operations on secret chats).
3. Delegate to `MessageRepository.search` and return the records unchanged.

The service owns no HTTP types or status codes. It is bound once in the messages
container; the controller is request-scoped.

## 9. HTTP contract

`GET /api/chats/:chatId/messages/search`, operationId `chats.searchMessages`,
tags `['Messages']`, request `chatParamsSchema` plus:

| Param | Rule |
| --- | --- |
| `q` | required; trimmed to 1–200 characters; whitespace-only rejected |
| `limit` | `z.coerce.number().int().min(1).max(100).default(30)` |
| `cursor` | optional uuid; the last message id from the previous page |

A query with no searchable tokens (for example punctuation only) passes Zod and
returns no rows; it is not an error and never raises a PostgreSQL syntax error.

The OpenAPI request schema is the same Zod object the controller parses. The 200
response reuses `messageListResponse` (`successEnvelope(z.array(messageSchema))`)
and is sent via `ApiResponse.cursor`, so `data` is `MessageView[]` and
`meta.pagination.nextCursor` is the last id or `null`. No `total` count.

`MessageController` gains a `search` handler. To avoid duplicating history
presentation, its existing `list` handler and the new handler share one private
method that turns a page of `MessageRecord`s into views (receipts, pins,
mentions, presenter). Route registration uses bearer auth, verified email, the
shared messages rate limiter, and a `DocumentedRouter` contract.

## 10. Errors

Only existing codes are used:

| Situation | Status / code |
| --- | --- |
| No or invalid bearer token | `401 UNAUTHORIZED` |
| Unverified caller | `403 EMAIL_NOT_VERIFIED` |
| Non-member or unknown chat | `403 NOT_CHAT_MEMBER` |
| Secret chat | `403 E2EE_NOT_ALLOWED` |
| Missing/blank/overlong `q`, bad cursor, out-of-range limit | `400 VALIDATION_ERROR` |
| Shared bucket exhausted | `429 RATE_LIMITED` |

No new error classes or `ErrorMapper` entries are needed; `websearch_to_tsquery`
receives a safe bound string and does not raise user-facing syntax errors.

## 11. Tests

1. **Index and migration.** Integration test asserts the named GIN index exists
   on `messages` and its partitions; run `EXPLAIN` on a chat-scoped search and
   confirm an index scan rather than a sequential scan; `npm run db:check` clean.
2. **Repository.** Integration test covers: body and caption matches, case
   insensitivity and stemming, newest-first order, two-page cursor traversal
   with no duplicates or skips, isolation from another chat, and exclusion of
   soft-deleted, expired, and `type='secret'` rows.
3. **Service.** Unit test covers membership enforcement, secret-chat rejection,
   and unchanged delegation of query parameters.
4. **API.** Integration test covers success, empty result, envelope/cursor
   shape, validation failures, `401`/`403` paths, and a secret-chat `403`; then a
   live HTTP smoke with temporary users, a direct chat, text + caption matches,
   pagination, and error paths, followed by full cleanup.

Do not run multiple Vitest processes concurrently: they share the test database.

## 12. Documentation and handoff

- `README.md`: one route-table row for `GET /api/chats/:chatId/messages/search`
  and a short note that search covers body + captions, returns newest-first
  pages, and rejects secret chats.
- `plan.md`: refresh the stale Phase 2.7 handoff to record Phase 2.7 completion
  and the Phase 2.8 plan. Keep `plan.md` untracked/gitignored; never commit it.
- No `.env.example`, config, migration backfill, or error-code documentation
  changes beyond the generated index migration.

## 13. Review Focus

- The planner uses the GIN index for a chat-scoped query; no sequential scan.
- Index and query use the exact same `to_tsvector('english', coalesce(body,'') ||
  ' ' || coalesce(caption,''))` expression; a future edit cannot update one and
  forget the other.
- Secret-chat ciphertext is never searchable, and the endpoint rejects a secret
  chat with the existing `E2EE_NOT_ALLOWED` code.
- Deleted, scrubbed, and expired rows never appear in results.
- Pagination is newest-first with no duplicates or skips, and `nextCursor` is
  null on the last page.
- Cross-chat isolation and membership checks hold; no new error codes or config.
