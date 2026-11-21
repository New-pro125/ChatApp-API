# Chat Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-chat keyword search over message bodies and media captions with PostgreSQL full-text search, a GIN expression index, and newest-first cursor pagination.

**Architecture:** One shared `to_tsvector('english', body || caption)` SQL fragment backs both a Drizzle GIN expression index and a new `MessageRepository.search` query. A request-scoped `SearchService` checks membership and rejects secret chats before delegating to the repository; `MessageController.search` reuses the history page presenter and `ApiResponse.cursor`.

**Tech Stack:** Node 24, TypeScript 7, Express 5, Inversify 8, Drizzle ORM / PostgreSQL 18 full-text search, Zod, OpenAPI 3.1, Vitest/Supertest, Biome.

**Spec:** `docs/superpowers/specs/2026-11-21-chat-search-design.md`

---

## Global Constraints

- Per-chat search only: `GET /api/chats/:chatId/messages/search`. No cross-chat or global endpoint.
- Newest-first by uuidv7 `id`; pagination uses the existing `meta.pagination.nextCursor` contract. No relevance ranking, count query, snippets, or offset pages.
- Indexed text is `body` + `caption` only. Secret ciphertext, drafts, chat titles, and media binaries are never indexed.
- One exported `sql` fragment is used by both the schema index and the repository predicate. It must use **unqualified** identifiers (`sql.identifier('body')`, `sql.identifier('caption')`) so PostgreSQL propagates the expression index to all 16 hash partitions.
- No new columns, triggers, or backfill. The generated migration must contain only `CREATE INDEX ... USING gin` plus Drizzle metadata.
- Secret chats are rejected with the existing `E2eeNotAllowedException` → `403 E2EE_NOT_ALLOWED`. No new error codes, auth schemes, config values, or `.env.example` changes.
- Keep the standard `ApiResponse` envelope and the shared message view shape identical to history.
- Bearer auth, verified email, and the shared `rl:messages:` limiter apply to the new route.
- `plan.md` stays untracked/gitignored. Never commit `.env`, secrets, tokens, or credentials.
- Do not run multiple Vitest processes concurrently; they share the test database and `clearDatabase()` causes false 401 failures.
- The whole-repo `npm run verify` has one pre-existing unrelated failure in `tests/unit/is-prime.test.ts`. Use `npm run typecheck`, `npm run lint`, `npm run build`, and the targeted Vitest files listed below as the authoritative gates; do not "fix" `is-prime.test.ts`.

## Review Focus

- The planner chooses `messages_search_index` for a chat-scoped FTS query — pinned by the `EXPLAIN` assertion in Task 1, Step 1.
- Index and query use the exact same `to_tsvector('english', coalesce("body",'') || ' ' || coalesce("caption",''))` expression through one shared fragment — pinned by Task 1 Step 3 and Task 2 Step 3.
- Secret-chat ciphertext is never searchable and the endpoint returns `403 E2EE_NOT_ALLOWED` — pinned by Task 2 Step 1, Task 3 Step 2, and Task 5 Step 1.
- Deleted, scrubbed, and expired rows never appear in results — pinned by Task 2 Step 1.
- Pagination is newest-first with no duplicates or skips, and `nextCursor` is null on the last page — pinned by Task 2 Step 1 and Task 5 Step 1.
- Cross-chat isolation and membership checks hold; no new error codes or config — pinned by Task 2 Step 1 and Task 5 Step 1.

---

## File Structure

```text
src/core/database/schema/messaging.schema.ts          shared FTS sql fragment + GIN expression index
drizzle/0024_*.sql (generated)                        reviewed index migration
src/modules/messages/logic/ports/message.repository.ts  SearchMessagesQuery + search port
src/modules/messages/data/postgres-message.repository.ts  FTS query implementation
src/modules/messages/logic/search.service.ts          membership + secret-chat guard + delegation
src/modules/messages/messages.types.ts                SearchService symbol
src/modules/messages/messages.container.ts            SearchService binding
src/modules/messages/web/dto/message.schemas.ts       searchMessagesQuerySchema
src/modules/messages/web/dto/message.openapi.ts       chats.searchMessages contract
src/modules/messages/web/message.controller.ts        search handler + shared page presenter
src/modules/messages/web/routes/messages.router.ts    GET /:chatId/messages/search
README.md                                              route row + behavior note
plan.md                                                stale handoff refresh (untracked)
tests/integration/messages/messaging-schema.test.ts   modify: index + EXPLAIN assertions
tests/integration/messages/message-search.test.ts     repository behavior
tests/unit/search.service.test.ts                     service guard/delegation
tests/unit/search-query-schema.test.ts                Zod validation
tests/integration/messages/search-api.test.ts         HTTP behavior
```

---

### Task 1: Shared FTS expression, GIN index, and migration

**Files:**
- Modify: `src/core/database/schema/messaging.schema.ts:1` and `:258-265`
- Modify: `tests/integration/messages/messaging-schema.test.ts`
- Generate: `drizzle/0024_*.sql`, `drizzle/meta/0024_snapshot.json`, `drizzle/meta/_journal.json`

**Interfaces:**
- Consumes: existing `messages` Drizzle table (hash partitioned by `chat_id`).
- Produces:
  - `messageSearchVector: SQL` — exported from the schema barrel via `messaging.schema.ts`.
  - named index `messages_search_index` on `messages`, method `gin`.

- [ ] **Step 1: Write the failing schema test**

Append before the final `});` in `tests/integration/messages/messaging-schema.test.ts`:

```ts
  it('creates a GIN search index on every messages partition', async () => {
    const parent = await app.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'messages'
         AND indexname = 'messages_search_index'`,
    );
    expect(parent.rows).toHaveLength(1);
    expect(parent.rows[0]?.indexdef).toContain('USING gin');
    expect(parent.rows[0]?.indexdef).toContain('to_tsvector');

    const children = await app.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_inherits
       WHERE inhparent = 'public.messages_search_index'::regclass`,
    );
    expect(children.rows[0]?.count).toBe(16);
  });

  it('uses the search index for a chat-scoped full-text query', async () => {
    const sender = await auth.createUser();
    const recipient = await auth.createUser();
    const chatId = await createDirectChat(sender.id, recipient.id);

    // Only one row matches, so the planner prefers the selective GIN index
    // over walking the (chat_id, id) primary key and filtering every row.
    await app.pool.query(
      `INSERT INTO messages (chat_id, sender_id, body)
       SELECT $1, $2,
         CASE WHEN n = 1 THEN 'needle message' ELSE 'ordinary filler ' || n END
       FROM generate_series(1, 500) AS n`,
      [chatId, sender.id],
    );
    await app.pool.query('ANALYZE messages');

    const client = await app.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const explained = await client.query<{ 'QUERY PLAN': string[] }>(
        `EXPLAIN SELECT id FROM messages
         WHERE chat_id = $1
           AND to_tsvector('english',
                 coalesce("body", '') || ' ' || coalesce("caption", ''))
               @@ websearch_to_tsquery('english', $2)
         ORDER BY id DESC LIMIT 30`,
        [chatId, 'needle'],
      );
      await client.query('COMMIT');

      expect(explained.rows.map((row) => row['QUERY PLAN']).join('\n')).toMatch(
        /messages_search_index/,
      );
    } finally {
      client.release();
    }
  });
```

- [ ] **Step 2: Run the tests and confirm RED**

Run: `npx vitest run tests/integration/messages/messaging-schema.test.ts -t 'search index'`

Expected: FAIL — the index does not exist yet. The `EXPLAIN` assertion is pinned against a hand-written copy of the expression so it also fails if index and query drift.

- [ ] **Step 3: Add the shared fragment and the index**

In `src/core/database/schema/messaging.schema.ts`, after the imports and before the `chats` table, add:

```ts
/**
 * Full-text document shared by the GIN index and the search predicate.
 * Identifiers stay unqualified so PostgreSQL can propagate the expression
 * index from the partitioned parent to every hash partition.
 */
export const messageSearchVector = sql`to_tsvector(
  'english',
  coalesce(${sql.identifier('body')}, '') || ' ' || coalesce(${sql.identifier('caption')}, '')
)`;
```

In the `messages` table config array, after `index('messages_recipient_device_id_index').on(...)`, add:

```ts
    index('messages_search_index').using('gin', messageSearchVector),
```

The barrel `src/core/database/schema/index.ts` already re-exports everything from `messaging.schema.js`, so no barrel change is needed.

- [ ] **Step 4: Generate, review, and apply the migration**

Run: `npm run db:generate`

Inspect the generated `drizzle/0024_*.sql`. It must contain one `CREATE INDEX "messages_search_index" ON "messages" USING gin (to_tsvector('english'::regconfig, coalesce("body", ''::text) || ' '::text || coalesce("caption", ''::text)))` statement and no destructive DDL. Then run: `npm run db:migrate`.

Expected: migration applies cleanly; `npm run db:check` prints `Everything's fine 🐶🔥`.

- [ ] **Step 5: Run the schema tests and confirm GREEN**

Run: `npx vitest run tests/integration/messages/messaging-schema.test.ts`

Expected: PASS, including both new search-index tests.

- [ ] **Step 6: Commit**

```bash
git add src/core/database/schema/messaging.schema.ts \
  tests/integration/messages/messaging-schema.test.ts \
  drizzle/0024_*.sql drizzle/meta/0024_snapshot.json drizzle/meta/_journal.json
git commit -m "feat(messaging): add GIN expression index for message search"
```

---

### Task 2: Search repository port and PostgreSQL implementation

**Files:**
- Modify: `src/modules/messages/logic/ports/message.repository.ts`
- Modify: `src/modules/messages/data/postgres-message.repository.ts:1-14` and after `:175`
- Test: `tests/integration/messages/message-search.test.ts`

**Interfaces:**
- Consumes: `messageSearchVector` from Task 1; `messageSelection`/`MessageMapper`; `notExpired()`.
- Produces:
  - `interface SearchMessagesQuery { q: string; limit: number; beforeId?: string | undefined }`
  - `MessageRepository.search(chatId: string, query: SearchMessagesQuery): Promise<MessageRecord[]>`

- [ ] **Step 1: Write the failing repository test**

Create `tests/integration/messages/message-search.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { Container } from 'inversify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatRepository } from '@/modules/messages/logic/ports/chat.repository.js';
import type { ChatMemberRepository } from '@/modules/messages/logic/ports/chat-member.repository.js';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import { MessagesContainer } from '@/modules/messages/messages.container.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { TestApp } from '../../helpers/test-app.js';

describe('message search repository', () => {
  let app: TestApp;
  let auth: AuthFixture;
  let chats: ChatRepository;
  let members: ChatMemberRepository;
  let messages: MessageRepository;

  beforeAll(async () => {
    app = await TestApp.create();
    auth = new AuthFixture(app);
    const container = new MessagesContainer(new Container({ parent: app.container }));
    chats = container.get<ChatRepository>(MESSAGES_TYPES.ChatRepository);
    members = container.get<ChatMemberRepository>(MESSAGES_TYPES.ChatMemberRepository);
    messages = container.get<MessageRepository>(MESSAGES_TYPES.MessageRepository);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
    auth.emails.clear();
  });

  async function setup() {
    const alice = await auth.createUser();
    const bob = await auth.createUser();
    const chat = await chats.create({
      type: 'direct',
      title: null,
      directKey: [alice.id, bob.id].sort().join(':'),
      createdBy: alice.id,
    });
    await members.add(chat.id, alice.id);
    await members.add(chat.id, bob.id);
    return { alice, bob, chat };
  }

  async function insertMediaMessage(
    chatId: string,
    senderId: string,
    caption: string,
  ): Promise<string> {
    const media = await app.pool.query<{ id: string }>(
      `INSERT INTO media_objects (owner_user_id, object_key, content_type, size_bytes, status)
       VALUES ($1, $2, 'image/png', 11, 'ready') RETURNING id`,
      [senderId, `media/${senderId}/${randomUUID()}.png`],
    );
    const mediaId = media.rows[0]?.id as string;
    const inserted = await app.pool.query<{ id: string }>(
      `INSERT INTO messages (chat_id, sender_id, type, media_id, media_kind, caption)
       VALUES ($1, $2, 'media', $3, 'image', $4) RETURNING id`,
      [chatId, senderId, mediaId, caption],
    );

    return inserted.rows[0]?.id as string;
  }

  async function insertSecretMessage(chatId: string, senderId: string): Promise<string> {
    const inserted = await app.pool.query<{ id: string }>(
      `INSERT INTO messages (
         chat_id, sender_id, type, ciphertext, nonce, ephemeral_public_key,
         sender_device_id, recipient_device_id
       ) VALUES ($1, $2, 'secret', 'opaque', 'nonce', 'ephemeral', $3, $4) RETURNING id`,
      [chatId, senderId, randomUUID(), randomUUID()],
    );

    return inserted.rows[0]?.id as string;
  }

  it('matches bodies and captions case-insensitively with English stemming', async () => {
    const { alice, chat } = await setup();
    await messages.create({ chatId: chat.id, senderId: alice.id, body: 'The quick brown fox' });
    const captionId = await insertMediaMessage(chat.id, alice.id, 'Running through the park');

    const byBody = await messages.search(chat.id, { q: 'QUICK', limit: 10 });
    expect(byBody.map((message) => message.body)).toEqual(['The quick brown fox']);

    const byCaption = await messages.search(chat.id, { q: 'runs', limit: 10 });
    expect(byCaption.map((message) => message.id)).toEqual([captionId]);
  });

  it('returns newest-first pages with no duplicates or skips', async () => {
    const { alice, chat } = await setup();
    const first = await messages.create({
      chatId: chat.id,
      senderId: alice.id,
      body: 'running one',
    });
    const second = await messages.create({
      chatId: chat.id,
      senderId: alice.id,
      body: 'running two',
    });
    const third = await messages.create({
      chatId: chat.id,
      senderId: alice.id,
      body: 'running three',
    });

    const pageOne = await messages.search(chat.id, { q: 'running', limit: 2 });
    expect(pageOne.map((message) => message.id)).toEqual([third.id, second.id]);

    const pageTwo = await messages.search(chat.id, {
      q: 'running',
      limit: 2,
      beforeId: pageOne[1]?.id,
    });
    expect(pageTwo.map((message) => message.id)).toEqual([first.id]);
  });

  it('excludes other chats, tombstones, expired rows, and secret ciphertext', async () => {
    const { alice, chat } = await setup();
    const live = await messages.create({
      chatId: chat.id,
      senderId: alice.id,
      body: 'running live',
    });
    const deleted = await messages.create({
      chatId: chat.id,
      senderId: alice.id,
      body: 'running deleted',
    });
    await messages.markDeleted(chat.id, deleted.id, new Date());

    await app.pool.query(
      `INSERT INTO messages (chat_id, sender_id, body, created_at, expires_at)
       VALUES ($1, $2, 'running expired', now() - interval '2 seconds', now() - interval '1 second')`,
      [chat.id, alice.id],
    );
    const secretId = await insertSecretMessage(chat.id, alice.id);

    const other = await chats.create({
      type: 'group',
      title: 'Other chat',
      directKey: null,
      createdBy: alice.id,
    });
    await members.add(other.id, alice.id);
    const otherMessage = await messages.create({
      chatId: other.id,
      senderId: alice.id,
      body: 'running elsewhere',
    });

    const ids = (await messages.search(chat.id, { q: 'running', limit: 50 })).map(
      (message) => message.id,
    );
    expect(ids).toEqual([live.id]);
    expect(ids).not.toContain(deleted.id);
    expect(ids).not.toContain(secretId);
    expect(ids).not.toContain(otherMessage.id);
  });
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npx vitest run tests/integration/messages/message-search.test.ts`

Expected: FAIL — `MessageRepository` has no `search` method.

- [ ] **Step 3: Add the port and implement the query**

In `src/modules/messages/logic/ports/message.repository.ts`, after `ListMessagesQuery`, add:

```ts
/** Input accepted when searching a chat's visible message text. */
export interface SearchMessagesQuery {
  q: string;
  limit: number;
  /** Return matches strictly older than this message id. */
  beforeId?: string | undefined;
}
```

In the `MessageRepository` interface, after `listByChat`, add:

```ts
  /** Newest-first keyword matches over body and caption, optionally before a cursor. */
  search(chatId: string, query: SearchMessagesQuery): Promise<MessageRecord[]>;
```

In `src/modules/messages/data/postgres-message.repository.ts`, extend the schema import to include the fragment and the port import to include the query type:

```ts
import { chatMembers, chats, messageSearchVector, messages } from '@/core/database/schema/index.js';
import type {
  CreateMessageInput,
  CreateSecretMessageInput,
  ListMessagesQuery,
  MessageRepository,
  SearchMessagesQuery,
} from '@/modules/messages/logic/ports/message.repository.js';
```

After `listByChat`, add:

```ts
  async search(chatId: string, query: SearchMessagesQuery): Promise<MessageRecord[]> {
    try {
      const conditions = [
        eq(messages.chatId, chatId),
        inArray(messages.type, ['text', 'media']),
        isNull(messages.deletedAt),
        this.notExpired(),
        sql`${messageSearchVector} @@ websearch_to_tsquery('english', ${query.q})`,
      ];

      if (query.beforeId) {
        conditions.push(lt(messages.id, query.beforeId));
      }

      const rows = await this.db
        .select(messageSelection)
        .from(messages)
        .where(and(...conditions))
        .orderBy(desc(messages.id))
        .limit(query.limit);

      return rows.map((row) => this.mapper.toRecord(row));
    } catch (error) {
      throw new PersistenceException('Failed to search messages', { cause: error });
    }
  }
```

`q` is a bound parameter, never interpolated. `eq(messages.chatId, chatId)` is always present so PostgreSQL prunes to one hash partition.

- [ ] **Step 4: Run the test and confirm GREEN**

Run: `npx vitest run tests/integration/messages/message-search.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/messages/logic/ports/message.repository.ts \
  src/modules/messages/data/postgres-message.repository.ts \
  tests/integration/messages/message-search.test.ts
git commit -m "feat(messaging): add FTS message search repository"
```

---

### Task 3: SearchService and dependency injection

**Files:**
- Create: `src/modules/messages/logic/search.service.ts`
- Modify: `src/modules/messages/messages.types.ts`
- Modify: `src/modules/messages/messages.container.ts`
- Test: `tests/unit/search.service.test.ts`

**Interfaces:**
- Consumes: `MessagingPolicy.requireMember`, `ChatRepository.findById`, `MessageRepository.search` from Task 2.
- Produces: `SearchService.search(userId: string, chatId: string, query: SearchMessagesQuery): Promise<MessageRecord[]>`

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/search.service.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  E2eeNotAllowedException,
  NotChatMemberException,
} from '@/core/errors/domain.error.js';
import type { MessagingPolicy } from '@/modules/messages/logic/messaging-policy.service.js';
import type { ChatRepository } from '@/modules/messages/logic/ports/chat.repository.js';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import { SearchService } from '@/modules/messages/logic/search.service.js';

describe('SearchService', () => {
  const query = { q: 'running', limit: 31, beforeId: 'cursor-id' };

  function makeService(chatType: 'direct' | 'secret' = 'direct') {
    const policy = { requireMember: vi.fn(async () => undefined) };
    const chats = { findById: vi.fn(async () => ({ type: chatType })) };
    const messages = { search: vi.fn(async () => []) };

    return {
      policy,
      messages,
      service: new SearchService(
        policy as unknown as MessagingPolicy,
        chats as unknown as ChatRepository,
        messages as unknown as MessageRepository,
      ),
    };
  }

  it('checks membership then delegates the unchanged query', async () => {
    const { policy, messages, service } = makeService();

    await service.search('user-1', 'chat-1', query);

    expect(policy.requireMember).toHaveBeenCalledWith('chat-1', 'user-1');
    expect(messages.search).toHaveBeenCalledWith('chat-1', query);
  });

  it('rejects a secret chat before querying messages', async () => {
    const { messages, service } = makeService('secret');

    await expect(service.search('user-1', 'chat-1', query)).rejects.toBeInstanceOf(
      E2eeNotAllowedException,
    );
    expect(messages.search).not.toHaveBeenCalled();
  });

  it('does not query messages when the caller is not a member', async () => {
    const { messages } = makeService();
    const policy = { requireMember: vi.fn(async () => {
      throw new NotChatMemberException();
    }) };
    const rejecting = new SearchService(
      policy as unknown as MessagingPolicy,
      { findById: vi.fn() } as unknown as ChatRepository,
      messages as unknown as MessageRepository,
    );

    await expect(rejecting.search('user-1', 'chat-1', query)).rejects.toBeInstanceOf(
      NotChatMemberException,
    );
    expect(messages.search).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npx vitest run tests/unit/search.service.test.ts`

Expected: FAIL — `search.service.ts` does not exist.

- [ ] **Step 3: Implement the service**

Create `src/modules/messages/logic/search.service.ts`:

```ts
import { inject, injectable } from 'inversify';
import { E2eeNotAllowedException } from '@/core/errors/domain.error.js';
import type { MessageRecord } from '@/modules/messages/logic/entities/message-record.js';
import { MessagingPolicy } from '@/modules/messages/logic/messaging-policy.service.js';
import type { ChatRepository } from '@/modules/messages/logic/ports/chat.repository.js';
import type {
  MessageRepository,
  SearchMessagesQuery,
} from '@/modules/messages/logic/ports/message.repository.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';

/** Authorizes and scopes keyword search over one chat's message text. */
@injectable()
export class SearchService {
  constructor(
    @inject(MESSAGES_TYPES.MessagingPolicy) private readonly policy: MessagingPolicy,
    @inject(MESSAGES_TYPES.ChatRepository) private readonly chats: ChatRepository,
    @inject(MESSAGES_TYPES.MessageRepository) private readonly messages: MessageRepository,
  ) {}

  async search(
    userId: string,
    chatId: string,
    query: SearchMessagesQuery,
  ): Promise<MessageRecord[]> {
    await this.policy.requireMember(chatId, userId);

    const chat = await this.chats.findById(chatId);

    if (chat?.type === 'secret') {
      throw new E2eeNotAllowedException();
    }

    return this.messages.search(chatId, query);
  }
}
```

- [ ] **Step 4: Bind the service**

In `src/modules/messages/messages.types.ts`, after `MessageService`, add:

```ts
  SearchService: Symbol.for('Messages.SearchService'),
```

In `src/modules/messages/messages.container.ts`, add the import:

```ts
import { SearchService } from '@/modules/messages/logic/search.service.js';
```

and, after the `MessageService` binding, add:

```ts
    this.bind<SearchService>(MESSAGES_TYPES.SearchService).to(SearchService).inSingletonScope();
```

- [ ] **Step 5: Run the test and confirm GREEN**

Run: `npx vitest run tests/unit/search.service.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/modules/messages/logic/search.service.ts \
  src/modules/messages/messages.types.ts \
  src/modules/messages/messages.container.ts \
  tests/unit/search.service.test.ts
git commit -m "feat(messaging): add search service and DI bindings"
```

---

### Task 4: Query schema and OpenAPI contract

**Files:**
- Modify: `src/modules/messages/web/dto/message.schemas.ts`
- Modify: `src/modules/messages/web/dto/message.openapi.ts`
- Test: `tests/unit/search-query-schema.test.ts`

**Interfaces:**
- Consumes: `chatParamsSchema`, `messageListResponse`, `commonErrorResponses`, `bearerSecurity`.
- Produces:
  - `searchMessagesQuerySchema` (and inferred `SearchMessagesQuerySchema`).
  - `messageContracts.searchMessages` with operationId `chats.searchMessages`.

- [ ] **Step 1: Write the failing schema test**

Create `tests/unit/search-query-schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { searchMessagesQuerySchema } from '@/modules/messages/web/dto/message.schemas.js';

describe('searchMessagesQuerySchema', () => {
  it('trims q and applies the default limit', () => {
    expect(searchMessagesQuerySchema.parse({ q: '  running  ' })).toEqual({
      q: 'running',
      limit: 30,
    });
  });

  it('accepts a cursor and a valid limit', () => {
    expect(
      searchMessagesQuerySchema.parse({
        q: 'running',
        limit: 100,
        cursor: '018f7c3e-4f1a-7c30-8000-000000000000',
      }),
    ).toEqual({
      q: 'running',
      limit: 100,
      cursor: '018f7c3e-4f1a-7c30-8000-000000000000',
    });
  });

  it('rejects a missing or blank q', () => {
    expect(() => searchMessagesQuerySchema.parse({})).toThrow();
    expect(() => searchMessagesQuerySchema.parse({ q: '   ' })).toThrow();
  });

  it('rejects an overlong q', () => {
    expect(() => searchMessagesQuerySchema.parse({ q: 'a'.repeat(201) })).toThrow();
  });

  it('rejects a bad cursor or out-of-range limit', () => {
    expect(() => searchMessagesQuerySchema.parse({ q: 'x', cursor: 'not-a-uuid' })).toThrow();
    expect(() => searchMessagesQuerySchema.parse({ q: 'x', limit: 0 })).toThrow();
    expect(() => searchMessagesQuerySchema.parse({ q: 'x', limit: 101 })).toThrow();
  });
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npx vitest run tests/unit/search-query-schema.test.ts`

Expected: FAIL — the schema is not exported.

- [ ] **Step 3: Add the Zod schema**

In `src/modules/messages/web/dto/message.schemas.ts`, after `listMessagesQuerySchema`, add:

```ts
/** Keyset page of keyword matches within one chat. */
export const searchMessagesQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.uuid().optional(),
});
```

In the inferred-type exports near the end of the file, add:

```ts
export type SearchMessagesQuerySchema = z.infer<typeof searchMessagesQuerySchema>;
```

- [ ] **Step 4: Add the OpenAPI contract**

In `src/modules/messages/web/dto/message.openapi.ts`, add `searchMessagesQuerySchema` to the import from `message.schemas.js`, then add this entry to `messageContracts`, immediately after `listMessages`:

```ts
  searchMessages: {
    operationId: 'chats.searchMessages',
    tags: ['Messages'],
    summary: 'Search messages in a chat by keyword',
    description:
      'Returns matching messages newest first, searching body and media caption text with English full-text search. Pass `meta.pagination.nextCursor` as `cursor` to continue. Secret chats return 403 E2EE_NOT_ALLOWED. Punctuation-only queries return an empty page.',
    security: bearerSecurity,
    request: { params: chatParamsSchema, query: searchMessagesQuerySchema },
    responses: {
      200: { description: 'A page of matching messages', schema: messageListResponse },
      ...commonErrorResponses,
    },
  },
```

- [ ] **Step 5: Run the test and confirm GREEN**

Run: `npx vitest run tests/unit/search-query-schema.test.ts`

Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add src/modules/messages/web/dto/message.schemas.ts \
  src/modules/messages/web/dto/message.openapi.ts \
  tests/unit/search-query-schema.test.ts
git commit -m "feat(messaging): add message search query schema and contract"
```

---

### Task 5: Controller handler and route wiring

**Files:**
- Modify: `src/modules/messages/web/message.controller.ts`
- Modify: `src/modules/messages/web/routes/messages.router.ts`
- Test: `tests/integration/messages/search-api.test.ts`

**Interfaces:**
- Consumes: `SearchService` from Task 3, `searchMessagesQuerySchema` and `messageContracts.searchMessages` from Task 4.
- Produces: `MessageController.search` and `GET /api/chats/:chatId/messages/search`.

- [ ] **Step 1: Write the failing API test**

Create `tests/integration/messages/search-api.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectError, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';
import { MessagingApiFixture } from './messaging-api.fixture.js';

describe('chat message search API', () => {
  let app: TestApp;
  let fixture: MessagingApiFixture;

  beforeAll(async () => {
    app = await TestApp.create();
    fixture = new MessagingApiFixture(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
    fixture.auth.emails.clear();
  });

  async function send(chatId: string, headers: Record<string, string>, body: string) {
    const response = await app.request
      .post(`/api/chats/${chatId}/messages`)
      .set(headers)
      .send({ body });

    return expectSuccess<{ id: string; body: string }>(response, 201);
  }

  it('returns newest-first matches with a standard cursor envelope', async () => {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    const chatId = await fixture.openDirectChat(bob.id, alice.headers);
    const first = await send(chatId, alice.headers, 'first running note');
    await send(chatId, alice.headers, 'unrelated note');
    const second = await send(chatId, alice.headers, 'second running note');

    const pageOne = await app.request
      .get(`/api/chats/${chatId}/messages/search?q=running&limit=1`)
      .set(alice.headers);
    const data = expectSuccess<Array<{ id: string; body: string }>>(pageOne);
    expect(data.map((message) => message.id)).toEqual([second.id]);
    expect(data[0]?.body).toBe('second running note');
    expect(pageOne.body.meta.pagination.nextCursor).toBe(second.id);

    const nextCursor = pageOne.body.meta.pagination.nextCursor as string;
    const pageTwo = await app.request
      .get(`/api/chats/${chatId}/messages/search?q=running&limit=1&cursor=${nextCursor}`)
      .set(alice.headers);
    const dataTwo = expectSuccess<Array<{ id: string; body: string }>>(pageTwo);
    expect(dataTwo.map((message) => message.id)).toEqual([first.id]);
    expect(pageTwo.body.meta.pagination.nextCursor).toBeNull();
  });

  it('returns an empty page for a query with no matches', async () => {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    const chatId = await fixture.openDirectChat(bob.id, alice.headers);
    await send(chatId, alice.headers, 'a normal message');

    const response = await app.request
      .get(`/api/chats/${chatId}/messages/search?q=zzzznotfound`)
      .set(alice.headers);
    const data = expectSuccess<unknown[]>(response);

    expect(data).toEqual([]);
    expect(response.body.meta.pagination.nextCursor).toBeNull();
  });

  it('rejects invalid query parameters with VALIDATION_ERROR', async () => {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    const chatId = await fixture.openDirectChat(bob.id, alice.headers);

    const cases = [
      `/api/chats/${chatId}/messages/search`,
      `/api/chats/${chatId}/messages/search?q=%20%20`,
      `/api/chats/${chatId}/messages/search?q=${'a'.repeat(201)}`,
      `/api/chats/${chatId}/messages/search?q=x&cursor=not-a-uuid`,
      `/api/chats/${chatId}/messages/search?q=x&limit=0`,
      `/api/chats/${chatId}/messages/search?q=x&limit=101`,
    ];

    for (const path of cases) {
      const response = await app.request.get(path).set(alice.headers);
      expectError(response, 400, 'VALIDATION_ERROR');
    }
  });

  it('enforces auth, verification, and membership', async () => {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    const outsider = await fixture.verifiedUser('Outsider');
    const unverified = await fixture.unverifiedUser('Unverified');
    const chatId = await fixture.openDirectChat(bob.id, alice.headers);

    const anonymous = await app.request.get(
      `/api/chats/${chatId}/messages/search?q=running`,
    );
    expectError(anonymous, 401, 'UNAUTHORIZED');

    const unverifiedResponse = await app.request
      .get(`/api/chats/${chatId}/messages/search?q=running`)
      .set(unverified.headers);
    expectError(unverifiedResponse, 403, 'EMAIL_NOT_VERIFIED');

    const outsiderResponse = await app.request
      .get(`/api/chats/${chatId}/messages/search?q=running`)
      .set(outsider.headers);
    expectError(outsiderResponse, 403, 'NOT_CHAT_MEMBER');
  });

  it('rejects secret chats with E2EE_NOT_ALLOWED', async () => {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    await fixture.registerDevice(alice);
    await fixture.registerDevice(bob);
    const secretChatId = await fixture.openSecretChat(bob.id, alice.headers);

    const response = await app.request
      .get(`/api/chats/${secretChatId}/messages/search?q=anything`)
      .set(alice.headers);
    expectError(response, 403, 'E2EE_NOT_ALLOWED');
  });
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npx vitest run tests/integration/messages/search-api.test.ts`

Expected: FAIL — the route does not exist (404).

- [ ] **Step 3: Extract the shared page presenter and add the handler**

In `src/modules/messages/web/message.controller.ts`:

1. Add the `SearchService` type import after the `ReadReceiptService` import:

```ts
import type { SearchService } from '@/modules/messages/logic/search.service.js';
```

2. Replace the DTO import block (lines 14-23) with:

```ts
import {
  chatParamsSchema,
  editMessageSchema,
  forwardMessageSchema,
  listMessagesQuerySchema,
  messageParamsSchema,
  searchMessagesQuerySchema,
  sendMediaMessageSchema,
  sendMessageSchema,
  sendSecretMessageSchema,
} from '@/modules/messages/web/dto/message.schemas.js';
```

`MESSAGES_TYPES` is already imported at line 13; no change is needed there.

3. Add the constructor parameter after `MessageService`:

```ts
    @inject(MESSAGES_TYPES.SearchService) private readonly search: SearchService,
```

4. Replace the body of `list` (lines 91-126) with:

```ts
  list: RequestHandler = async (req, res) => {
    const { userId } = this.requireAuth(req);
    const { chatId } = chatParamsSchema.parse(req.params);
    const query = listMessagesQuerySchema.parse(req.query);

    // Fetch one extra row so the cursor is null only when the page is truly
    // the last one, without running a separate count query.
    const rows = await this.messages.list(userId, chatId, {
      limit: query.limit + 1,
      beforeId: query.cursor,
    });
    const page = await this.presentPage(chatId, userId, rows, query.limit);

    this.response.cursor(res, page.views, page.nextCursor);
  };

  search: RequestHandler = async (req, res) => {
    const { userId } = this.requireAuth(req);
    const { chatId } = chatParamsSchema.parse(req.params);
    const query = searchMessagesQuerySchema.parse(req.query);

    const rows = await this.search.search(userId, chatId, {
      q: query.q,
      limit: query.limit + 1,
      beforeId: query.cursor,
    });
    const page = await this.presentPage(chatId, userId, rows, query.limit);

    this.response.cursor(res, page.views, page.nextCursor);
  };
```

5. Add the shared helper immediately before the existing private `present` method:

```ts
  private async presentPage(
    chatId: string,
    userId: string,
    rows: MessageRecord[],
    limit: number,
  ): Promise<{ views: Record<string, unknown>[]; nextCursor: string | null }> {
    const receipts = await this.receipts.contextFor(chatId, userId);
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? (page.at(-1)?.id ?? null) : null;
    const pinnedAtById = await this.pins.listPinnedFor(
      chatId,
      userId,
      page.map((message) => message.id),
    );
    const mentionViews = await this.mentionViews(chatId, page);

    return {
      views: await Promise.all(
        page.map((message) =>
          this.presenter.present(
            message,
            receipts,
            pinnedAtById,
            mentionViews.get(message.id) ?? [],
          ),
        ),
      ),
      nextCursor,
    };
  }
```

- [ ] **Step 4: Register the route**

In `src/modules/messages/web/routes/messages.router.ts`, add this block immediately after the `routes.get('/:chatId/messages', messageContracts.listMessages, ...)` block:

```ts
    routes.get(
      '/:chatId/messages/search',
      messageContracts.searchMessages,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container.get<MessageController>(MESSAGES_TYPES.MessageController).search(req, res, next),
    );
```

The literal `search` path must be registered after `/:chatId/messages` and before `/:chatId/messages/:messageId` so Express does not treat `search` as a message id. The existing router already orders `/:chatId/messages/media` before the `:messageId` routes for the same reason.

- [ ] **Step 5: Run the new test and confirm GREEN**

Run: `npx vitest run tests/integration/messages/search-api.test.ts`

Expected: PASS, 5 tests.

- [ ] **Step 6: Guard against history regressions**

Run: `npx vitest run tests/integration/messages/message-api.test.ts tests/integration/messages/read-receipts.test.ts tests/integration/messages/pins.test.ts tests/integration/messages/mentions-api.test.ts`

Expected: PASS — the extracted `presentPage` helper must produce the same history envelope, receipts, pins, and mentions as before.

- [ ] **Step 7: Commit**

```bash
git add src/modules/messages/web/message.controller.ts \
  src/modules/messages/web/routes/messages.router.ts \
  tests/integration/messages/search-api.test.ts
git commit -m "feat(messaging): expose per-chat message search endpoint"
```

---

### Task 6: Documentation, verification, and live smoke

**Files:**
- Modify: `README.md`
- Modify: `plan.md` (untracked/gitignored)

- [ ] **Step 1: Document the endpoint**

In the README route table (after the `GET /api/chats/:chatId/messages` row near line 294), add:

```markdown
| `GET`    | `/api/chats/:chatId/messages/search`            | Search message text by keyword                |
```

After the history paragraph (the one ending "never skipped." near line 319), add:

```markdown
`GET /api/chats/:chatId/messages/search` accepts `q` (required, 1–200
characters), `limit` (1–100, default 30), and the same opaque `cursor` as
history. It matches message bodies and media captions case-insensitively using
English full-text search, returns newest-first pages in the same message-view
envelope, and supports quoted phrases, `-exclusion`, and `or` in `q`. A
punctuation-only query returns an empty page. Secret chats are rejected with
`403 E2EE_NOT_ALLOWED`; non-members receive `403 NOT_CHAT_MEMBER`.
```

- [ ] **Step 2: Refresh the handoff document**

In `plan.md`, update the stale header/last-updated line to record Phase 2.7 completion (spec `893a293`, plan `677dd79`, six TDD commits `5987da4`..`32792d9`, local merge to `main`, nothing pushed) and the new Phase 2.8 handoff: spec `009520a`, this plan, implementation not yet executed. Keep the file untracked.

- [ ] **Step 3: Run the full verification suite**

Run: `npm run typecheck && npm run lint && npm run build`

Expected: all three commands succeed. Then run the complete messaging test set serially:

Run: `npx vitest run tests/integration/messages tests/unit/search.service.test.ts tests/unit/search-query-schema.test.ts`

Expected: PASS. Do not run another Vitest process in parallel.

Note: `npm run verify` will still report the pre-existing, unrelated `tests/unit/is-prime.test.ts` failure. Record it as known and do not modify that test.

- [ ] **Step 4: Live HTTP smoke test**

Start the dependencies (they are stopped after previous work):

```bash
docker compose up -d postgres redis minio storage-init
npm run db:migrate
```

Start the API in the background using the repository's normal development environment (see `.env.example` and the README setup section), then confirm with `curl` (substitute real ids/tokens from a temporary verified user):

1. `GET /api/chats/:chatId/messages/search?q=<keyword>` → `200`, `{ "success": true, "data": [...], "meta": { "pagination": { "nextCursor": null } } }`.
2. Follow `nextCursor` with `&cursor=<id>` → the next older match, then `null`.
3. `GET /api/chats/:chatId/messages/search` (missing `q`) → `400 VALIDATION_ERROR`.
4. `GET /api/chats/:chatId/messages/search?q=x` without a bearer token → `401 UNAUTHORIZED`.
5. A search on a secret chat → `403 E2EE_NOT_ALLOWED`.

- [ ] **Step 5: Clean up and commit docs**

Remove every temporary user/chat created during the smoke test, stop the API process you started, and stop the containers you started (`docker compose stop postgres redis minio storage-init`). Then:

```bash
git add README.md
git commit -m "docs(messaging): document per-chat message search"
```

Expected: `git status --short` shows no tracked changes; `plan.md` remains untracked.

---

## Final Checklist

- [ ] `npm run typecheck`, `npm run lint`, `npm run build` all pass.
- [ ] All six new/modified test files pass serially; no Vitest processes overlap.
- [ ] `npm run db:check` clean and the reviewed `0024` migration applied.
- [ ] Live smoke covers one success path and the `400` / `401` / `403` error paths; temporary data and processes removed.
- [ ] README updated; `plan.md` refreshed but untracked; no secrets committed.
- [ ] Report exactly what changed, how it was verified, and any remaining risk.
