# Message Drafts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add private, per-chat, per-author plain-text message drafts with last-write-wins cross-device sync. `PUT`/`GET`/`DELETE /api/chats/:chatId/draft` manage a single draft row; a successful cloud send clears the caller's draft without touching the peer's. Secret chats are rejected so no E2E plaintext reaches the server.

**Architecture:** A normal (non-partitioned) `message_drafts` table keyed by `(chat_id, user_id)` holds the body and server-owned timestamps. A `MessageDraftRepository` port with a Drizzle/Postgres implementation is consumed by a `DraftService`, which reuses `MessagingPolicy` for membership and `ChatRepository` to reject non-direct chats. A request-scoped `DraftController` validates with shared Zod schemas, documents routes through `DocumentedRouter`, and replies through `ApiResponse`. `MessageService` calls `DraftService.clearOnSend` as a best-effort step after every successful cloud send.

**Tech Stack:** Node 24, TypeScript 7.0.2, ESM (`@/` aliases, explicit `.js` extensions), Express 5, Inversify 8 child containers, Drizzle ORM + PostgreSQL 18, Zod, Vitest + Supertest, Biome.

**Spec:** `docs/superpowers/specs/2026-11-20-message-drafts-design.md`

## Global Constraints

- Exactly one draft per `(chat_id, user_id)`. Saving again overwrites `body` and refreshes `updated_at`; `created_at` never changes. No version field, no optimistic locking, no per-device rows.
- The author id always comes from `req.user.id`, never from the request body. The peer can neither read nor overwrite another user's draft.
- Drafts are cloud direct chats only. Any non-`direct` chat (including `secret`) is rejected with the existing `403 E2EE_NOT_ALLOWED`; missing chat or non-membership is `403 NOT_CHAT_MEMBER`. Do not add error codes or `ErrorMapper` entries.
- Draft body is 1–4096 characters. `saveDraftSchema` trims before validating; the database check `message_drafts_body_check` enforces `char_length(body) between 1 and 4096`. Do not change the existing `messageBodySchema` or message send behavior.
- `GET` with no draft returns `200` with `data: null`. `DELETE` is idempotent and returns `204`. `PUT` is an idempotent upsert returning `200`.
- Drafts must never appear in `GET /api/chats`, message history, unread counts, or any peer-visible response.
- Service rules (chat type, membership, clear-on-send) are pinned end-to-end through the HTTP boundary instead of direct service unit tests; `DraftService` is never instantiated ad hoc in application code.
- Clear-on-send is best effort: a failure is logged and must never fail an already-created message. Send-clear applies to cloud text, media, upload, and forward sends; secret-chat sends are unaffected.
- All JSON goes through the injected `ApiResponse`; controllers never call `res.json` directly. Domain/data layers contain no Express types or HTTP status codes; services depend on ports.
- Every relative ESM import uses an explicit `.js` extension; use `@/...` aliases. Biome: single quotes, semicolons, trailing commas, 2-space indentation, 100-character lines, organized imports. Prefer `unknown` over `any`.
- Use migration `0021`; never edit an applied migration. Review generated SQL before applying and finish with `npm run db:check` reporting `Everything's fine 🐶🔥`.
- No `.env.example` change: no configuration is added. Tests require the gitignored local `.env`; if a fresh worktree lacks one, copy it from the original checkout and never commit it.
- Keep `plan.md` untracked and out of every commit. The spec and this plan are gitignored Markdown; force-add them. The spec is already committed as `e1bae14`.
- Definition of done: `npm run verify` and `npm run db:check` pass; live HTTP smoke covers success and error paths; temporary users removed; API stopped; PostgreSQL/Redis/MinIO left running.

## Review Focus

- **Peer can read/overwrite another user's draft** → Task 3 test `keeps drafts private to their author`, which saves as both participants and asserts each reads only its own body, plus an author id sourced from `req.user.id` in the controller snippet.
- **Secret plaintext stored on the server** → Task 3 test `rejects secret chats, non-members, and unknown chats` pins all three methods to `403 E2EE_NOT_ALLOWED`; the `DraftService.assertDraftable` snippet rejects every non-`direct` chat before touching the repository.
- **Stale draft after send / peer's draft cleared by mistake** → Task 4 tests `clears only the sender draft after a text send` and `clears the target draft after a forward`.
- **Last-write-wins and idempotency** → Task 2 repository test `creates, overwrites, and deletes one draft per chat and user` pins `created_at` stability; Task 3 HTTP test `saves, reads, overwrites, and deletes a draft` pins `updatedAt` refresh, `data: null`, and repeated `DELETE` → `204`.
- **Validation/auth/membership regressions** → Task 3 test `validates bodies and requires an authenticated, verified caller` and the secret/non-member test above.
- **Send failure after draft-clear error** → Task 4 `clearDraftAfterSend` snippet wraps the call in `try/catch` with `logger.warn`; the unit test stub in Task 4 keeps the media-service constructor tests green.

---

### Task 1: Schema, migration, and physical constraints

**Files:**
- Modify: `src/core/database/schema/messaging.schema.ts`
- Create: `drizzle/0021_<generated>.sql`, `drizzle/meta/0021_snapshot.json`; update `drizzle/meta/_journal.json`
- Test: `tests/integration/messages/messaging-schema.test.ts`

**Interfaces:**
- Consumes: existing `chats`, `users`, `primaryKey`, `check`, `sql`, `uuid`, `text`, `timestamp` imports.
- Produces: exported `messageDrafts` table with named primary key `message_drafts_pkey`, named check `message_drafts_body_check`, and two `ON DELETE CASCADE` foreign keys.

- [ ] **Step 1: Confirm the design docs are committed**

In the isolated worktree on `feat/message-drafts`, run:

```bash
git status --short
git log -2 --oneline
```

Expected: spec commit `e1bae14 docs(messaging): specify Phase 2.6 message drafts` is present. If this plan is not yet committed, run `git add -f docs/superpowers/plans/2026-11-20-message-drafts.md && git commit -m "docs(messaging): plan Phase 2.6 message drafts"`. Never add `plan.md` or `.env`.

- [ ] **Step 2: Write the failing schema test**

Append this `it` to `tests/integration/messages/messaging-schema.test.ts` inside the existing `describe('Messaging schema', ...)` block. The file already has `createDirectChat(firstUserId, secondUserId)`, `auth`, `app`, and `beforeEach(clearDatabase)`:

```ts
  it('stores one private, length-checked draft per chat and author', async () => {
    const user = await auth.createUser();
    const peer = await auth.createUser();
    const chatId = await createDirectChat(user.id, peer.id);

    const columns = await app.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'message_drafts' ORDER BY ordinal_position`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'chat_id',
      'user_id',
      'body',
      'created_at',
      'updated_at',
    ]);

    const constraints = await app.pool.query<{ constraint_name: string }>(
      `SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_name = 'message_drafts' ORDER BY constraint_name`,
    );
    const names = constraints.rows.map((row) => row.constraint_name);
    expect(names).toContain('message_drafts_pkey');
    expect(names).toContain('message_drafts_body_check');

    const foreignKeys = await app.pool.query<{ delete_rule: string }>(
      `SELECT rc.delete_rule FROM information_schema.referential_constraints rc
       JOIN information_schema.table_constraints tc ON tc.constraint_name = rc.constraint_name
       WHERE rc.constraint_schema = 'public' AND tc.table_schema = 'public'
         AND tc.table_name = 'message_drafts'`,
    );
    expect(foreignKeys.rows).toHaveLength(2);
    expect(foreignKeys.rows.every((row) => row.delete_rule === 'CASCADE')).toBe(true);

    await app.pool.query(
      `INSERT INTO message_drafts (chat_id, user_id, body) VALUES ($1, $2, $3)`,
      [chatId, user.id, 'hello'],
    );

    await expect(
      app.pool.query(`INSERT INTO message_drafts (chat_id, user_id, body) VALUES ($1, $2, '')`, [
        chatId,
        peer.id,
      ]),
    ).rejects.toThrow(/message_drafts_body_check/);

    await expect(
      app.pool.query(
        `INSERT INTO message_drafts (chat_id, user_id, body) VALUES ($1, $2, $3)`,
        [chatId, peer.id, 'x'.repeat(4097)],
      ),
    ).rejects.toThrow(/message_drafts_body_check/);

    await app.pool.query(`DELETE FROM chats WHERE id = $1`, [chatId]);
    const remaining = await app.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM message_drafts WHERE chat_id = $1`,
      [chatId],
    );
    expect(remaining.rows[0]?.count).toBe(0);
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/integration/messages/messaging-schema.test.ts 2>&1 | tail -30`
Expected: FAIL because `message_drafts` and its constraints do not exist.

- [ ] **Step 4: Add the Drizzle table**

In `src/core/database/schema/messaging.schema.ts`, insert this export after the `messagePins` table (before `export const messages`):

```ts
/**
 * Per-user unsent text drafts. One row per chat and author, keyed by the
 * composite primary key. Drafts are never read by the peer and are cleared on
 * send or explicit delete, so no cleanup worker or extra index is needed.
 */
export const messageDrafts = pgTable(
  'message_drafts',
  {
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.userId], name: 'message_drafts_pkey' }),
    check('message_drafts_body_check', sql`char_length(${table.body}) between 1 and 4096`),
  ],
);
```

`primaryKey`, `check`, and `sql` are already imported by this file. The barrel `src/core/database/schema/index.ts` already re-exports everything from `messaging.schema.js`, so no barrel edit is needed.

- [ ] **Step 5: Generate and review migration 0021**

Run: `npm run db:generate`

Open the generated `drizzle/0021_*.sql`. Expected shape (keep the exact generated type expressions if different):

```sql
CREATE TABLE "message_drafts" (
	"chat_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_drafts_body_check" CHECK (char_length("body") between 1 and 4096),
	CONSTRAINT "message_drafts_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "message_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "message_drafts_pkey" PRIMARY KEY ("chat_id","user_id")
);
```

Confirm there are no unrelated statements and no edits to earlier migrations. There is no backfill.

- [ ] **Step 6: Apply the migration and check for drift**

Run: `npm run db:migrate && npm run db:check`
Expected: migration applies; final line reports `Everything's fine 🐶🔥`.

- [ ] **Step 7: Re-run the schema test**

Run: `npx vitest run tests/integration/messages/messaging-schema.test.ts 2>&1 | tail -15`
Expected: PASS, including the new draft test and all pre-existing schema tests.

- [ ] **Step 8: Commit**

```bash
git add src/core/database/schema/messaging.schema.ts drizzle tests/integration/messages/messaging-schema.test.ts
git commit -m "feat(messaging): add message_drafts table and migration"
```

---

### Task 2: Domain record, port, mapper, Postgres repository, and bindings

**Files:**
- Create: `src/modules/messages/logic/entities/message-draft-record.ts`
- Create: `src/modules/messages/logic/ports/message-draft.repository.ts`
- Create: `src/modules/messages/data/message-draft.mapper.ts`
- Create: `src/modules/messages/data/postgres-message-draft.repository.ts`
- Modify: `src/modules/messages/messages.types.ts`
- Modify: `src/modules/messages/messages.container.ts`
- Test: `tests/integration/messages/message-draft-repository.test.ts`

**Interfaces:**
- Consumes: `messageDrafts`, `CORE_TYPES.Db`, `AppDatabase`, `PersistenceException`.
- Produces: `MessageDraftRecord`, `MessageDraftRepository` (`find`, `upsert`, `delete`), `PostgresMessageDraftRepository`, `MessageDraftMapper`, `MESSAGES_TYPES.MessageDraftRepository`.

- [ ] **Step 1: Write the failing repository test**

Create `tests/integration/messages/message-draft-repository.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MessageDraftRepository } from '@/modules/messages/logic/ports/message-draft.repository.js';
import { MessagesContainer } from '@/modules/messages/messages.container.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { TestApp } from '../../helpers/test-app.js';

describe('MessageDraftRepository', () => {
  let app: TestApp;
  let auth: AuthFixture;
  let drafts: MessageDraftRepository;

  beforeAll(async () => {
    app = await TestApp.create();
    auth = new AuthFixture(app);
    const container = new MessagesContainer(app.container);
    drafts = container.get<MessageDraftRepository>(MESSAGES_TYPES.MessageDraftRepository);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
    auth.emails.clear();
  });

  async function chatFor(userId: string): Promise<string> {
    const result = await app.pool.query<{ id: string }>(
      `INSERT INTO chats (type, direct_key) VALUES ('direct', $1) RETURNING id`,
      [randomUUID()],
    );
    const chatId = result.rows[0]?.id;

    if (!chatId) {
      throw new Error('Could not create a chat');
    }

    await app.pool.query(`INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)`, [
      chatId,
      userId,
    ]);

    return chatId;
  }

  it('creates, overwrites, and deletes one draft per chat and user', async () => {
    const user = await auth.createUser();
    const chatId = await chatFor(user.id);
    const first = new Date('2026-11-20T10:00:00.000Z');
    const second = new Date('2026-11-20T11:00:00.000Z');

    expect(await drafts.find(chatId, user.id)).toBeNull();

    const created = await drafts.upsert(chatId, user.id, 'first', first);
    expect(created).toMatchObject({ chatId, userId: user.id, body: 'first' });
    expect(created.createdAt.toISOString()).toBe(first.toISOString());
    expect(created.updatedAt.toISOString()).toBe(first.toISOString());

    const updated = await drafts.upsert(chatId, user.id, 'second', second);
    expect(updated.body).toBe('second');
    expect(updated.createdAt.toISOString()).toBe(first.toISOString());
    expect(updated.updatedAt.toISOString()).toBe(second.toISOString());
    expect((await drafts.find(chatId, user.id))?.body).toBe('second');

    expect(await drafts.delete(chatId, user.id)).toBe(true);
    expect(await drafts.delete(chatId, user.id)).toBe(false);
    expect(await drafts.find(chatId, user.id)).toBeNull();
  });

  it('keeps drafts of different users in the same chat separate', async () => {
    const first = await auth.createUser();
    const second = await auth.createUser();
    const chatId = await chatFor(first.id);
    await app.pool.query(`INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)`, [
      chatId,
      second.id,
    ]);

    const now = new Date();
    await drafts.upsert(chatId, first.id, 'mine', now);
    await drafts.upsert(chatId, second.id, 'theirs', now);

    expect((await drafts.find(chatId, first.id))?.body).toBe('mine');
    expect((await drafts.find(chatId, second.id))?.body).toBe('theirs');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/messages/message-draft-repository.test.ts 2>&1 | tail -20`
Expected: FAIL because `MessageDraftRepository` and its binding do not exist yet.

- [ ] **Step 3: Add the domain record**

Create `src/modules/messages/logic/entities/message-draft-record.ts`:

```ts
/** A caller's unsent text draft for one chat. Timestamps are server-owned. */
export class MessageDraftRecord {
  constructor(
    readonly chatId: string,
    readonly userId: string,
    readonly body: string,
    readonly createdAt: Date,
    readonly updatedAt: Date,
  ) {}
}
```

- [ ] **Step 4: Add the repository port**

Create `src/modules/messages/logic/ports/message-draft.repository.ts`:

```ts
import type { MessageDraftRecord } from '@/modules/messages/logic/entities/message-draft-record.js';

/** Private, one-per-(chat, caller) unsent text drafts. */
export interface MessageDraftRepository {
  /** Returns null when no draft exists. */
  find(chatId: string, userId: string): Promise<MessageDraftRecord | null>;

  /** Inserts or overwrites in place; `createdAt` survives a conflict. */
  upsert(chatId: string, userId: string, body: string, now: Date): Promise<MessageDraftRecord>;

  /** True when a row was removed, false when none existed. */
  delete(chatId: string, userId: string): Promise<boolean>;
}
```

- [ ] **Step 5: Add the mapper**

Create `src/modules/messages/data/message-draft.mapper.ts`:

```ts
import type { InferSelectModel } from 'drizzle-orm';
import { messageDrafts } from '@/core/database/schema/index.js';
import { MessageDraftRecord } from '@/modules/messages/logic/entities/message-draft-record.js';

/** Explicit column selection for the `message_drafts` table. */
export const draftSelection = {
  chatId: messageDrafts.chatId,
  userId: messageDrafts.userId,
  body: messageDrafts.body,
  createdAt: messageDrafts.createdAt,
  updatedAt: messageDrafts.updatedAt,
} as const;

export type DraftRow = Pick<InferSelectModel<typeof messageDrafts>, keyof typeof draftSelection>;

export class MessageDraftMapper {
  toRecord(row: DraftRow): MessageDraftRecord {
    return new MessageDraftRecord(
      row.chatId,
      row.userId,
      row.body,
      row.createdAt,
      row.updatedAt,
    );
  }
}
```

- [ ] **Step 6: Add the Postgres implementation**

Create `src/modules/messages/data/postgres-message-draft.repository.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { AppDatabase } from '@/core/database/database.provider.js';
import { messageDrafts } from '@/core/database/schema/index.js';
import { PersistenceException } from '@/core/errors/repository.error.js';
import { MessageDraftMapper, draftSelection } from '@/modules/messages/data/message-draft.mapper.js';
import { MessageDraftRecord } from '@/modules/messages/logic/entities/message-draft-record.js';
import type { MessageDraftRepository } from '@/modules/messages/logic/ports/message-draft.repository.js';

@injectable()
export class PostgresMessageDraftRepository implements MessageDraftRepository {
  private readonly mapper = new MessageDraftMapper();

  constructor(@inject(CORE_TYPES.Db) private readonly db: AppDatabase) {}

  async find(chatId: string, userId: string): Promise<MessageDraftRecord | null> {
    try {
      const rows = await this.db
        .select(draftSelection)
        .from(messageDrafts)
        .where(and(eq(messageDrafts.chatId, chatId), eq(messageDrafts.userId, userId)))
        .limit(1);
      const row = rows[0];

      return row === undefined ? null : this.mapper.toRecord(row);
    } catch (error) {
      throw new PersistenceException('Failed to read message draft', { cause: error });
    }
  }

  async upsert(
    chatId: string,
    userId: string,
    body: string,
    now: Date,
  ): Promise<MessageDraftRecord> {
    try {
      const rows = await this.db
        .insert(messageDrafts)
        .values({ chatId, userId, body, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: [messageDrafts.chatId, messageDrafts.userId],
          set: { body, updatedAt: now },
        })
        .returning(draftSelection);
      const row = rows[0];

      if (!row) {
        throw new PersistenceException('PostgreSQL did not return the saved draft');
      }

      return this.mapper.toRecord(row);
    } catch (error) {
      if (error instanceof PersistenceException) {
        throw error;
      }

      throw new PersistenceException('Failed to save message draft', { cause: error });
    }
  }

  async delete(chatId: string, userId: string): Promise<boolean> {
    try {
      const rows = await this.db
        .delete(messageDrafts)
        .where(and(eq(messageDrafts.chatId, chatId), eq(messageDrafts.userId, userId)))
        .returning({ chatId: messageDrafts.chatId });

      return rows.length > 0;
    } catch (error) {
      throw new PersistenceException('Failed to delete message draft', { cause: error });
    }
  }
}
```

- [ ] **Step 7: Bind the repository**

In `src/modules/messages/messages.types.ts`, add alongside the other repository symbols:

```ts
  MessageDraftRepository: Symbol.for('Messages.MessageDraftRepository'),
```

In `src/modules/messages/messages.container.ts`, add the imports:

```ts
import { PostgresMessageDraftRepository } from '@/modules/messages/data/postgres-message-draft.repository.js';
import type { MessageDraftRepository } from '@/modules/messages/logic/ports/message-draft.repository.js';
```

and add the binding after `MessagePinRepository`:

```ts
    this.bind<MessageDraftRepository>(MESSAGES_TYPES.MessageDraftRepository)
      .to(PostgresMessageDraftRepository)
      .inSingletonScope();
```

- [ ] **Step 8: Run typecheck and the repository test**

Run: `npm run typecheck 2>&1 | tail -20; npx vitest run tests/integration/messages/message-draft-repository.test.ts 2>&1 | tail -15`
Expected: typecheck clean; repository test PASS (2 tests).

- [ ] **Step 9: Commit**

```bash
git add src/modules/messages/logic/entities/message-draft-record.ts src/modules/messages/logic/ports/message-draft.repository.ts src/modules/messages/data/message-draft.mapper.ts src/modules/messages/data/postgres-message-draft.repository.ts src/modules/messages/messages.types.ts src/modules/messages/messages.container.ts tests/integration/messages/message-draft-repository.test.ts
git commit -m "feat(messaging): add message draft repository and domain record"
```

---

### Task 3: DraftService, HTTP surface, contracts, and README route rows

**Files:**
- Create: `src/modules/messages/logic/draft.service.ts`
- Create: `src/modules/messages/web/draft.controller.ts`
- Modify: `src/modules/messages/messages.types.ts`
- Modify: `src/modules/messages/messages.container.ts`
- Modify: `src/modules/messages/web/dto/message.schemas.ts`
- Modify: `src/modules/messages/web/dto/message.openapi.ts`
- Modify: `src/modules/messages/web/routes/messages.router.ts`
- Modify: `README.md`
- Test: `tests/integration/messages/message-drafts.test.ts`

**Interfaces:**
- Consumes: `ChatRepository.findById`, `MessagingPolicy.requireMember`, `MessageDraftRepository`, `chatParamsSchema`, `successEnvelope`, `noContentResponse`, `commonErrorResponses`, `MessagingApiFixture`.
- Produces: `DraftService` (`get`, `save`, `delete`, `clearOnSend`), `DraftController`, Zod `saveDraftSchema`, OpenAPI `draftSchema` plus `chats.saveDraft`/`chats.getDraft`/`chats.deleteDraft`, and the three documented routes.

- [ ] **Step 1: Write the failing HTTP tests**

Create `tests/integration/messages/message-drafts.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectError, expectNoContent, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';
import { MessagingApiFixture } from './messaging-api.fixture.js';

interface DraftResponse {
  body: string;
  updatedAt: string;
}

describe('message drafts', () => {
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

  async function pair() {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    const chatId = await fixture.openDirectChat(bob.id, alice.headers);

    return { alice, bob, chatId };
  }

  function draftUrl(chatId: string): string {
    return `/api/chats/${chatId}/draft`;
  }

  it('saves, reads, overwrites, and deletes a draft', async () => {
    const { alice, chatId } = await pair();

    expectSuccess(await app.request.get(draftUrl(chatId)).set(alice.headers), 200).toBeNull();

    const first = expectSuccess<DraftResponse>(
      await app.request.put(draftUrl(chatId)).set(alice.headers).send({ body: 'first' }),
      200,
    );
    expect(first.body).toBe('first');
    expect(Number.isNaN(Date.parse(first.updatedAt))).toBe(false);

    const second = expectSuccess<DraftResponse>(
      await app.request.put(draftUrl(chatId)).set(alice.headers).send({ body: 'second' }),
      200,
    );
    expect(second.body).toBe('second');
    expect(Date.parse(second.updatedAt)).toBeGreaterThanOrEqual(Date.parse(first.updatedAt));

    expect(
      expectSuccess<DraftResponse>(await app.request.get(draftUrl(chatId)).set(alice.headers), 200),
    ).toEqual(second);

    expectNoContent(await app.request.delete(draftUrl(chatId)).set(alice.headers));
    expectNoContent(await app.request.delete(draftUrl(chatId)).set(alice.headers));
    expectSuccess(await app.request.get(draftUrl(chatId)).set(alice.headers), 200).toBeNull();
  });

  it('keeps drafts private to their author', async () => {
    const { alice, bob, chatId } = await pair();

    await app.request.put(draftUrl(chatId)).set(alice.headers).send({ body: 'alice only' });
    expectSuccess(await app.request.get(draftUrl(chatId)).set(bob.headers), 200).toBeNull();

    await app.request.put(draftUrl(chatId)).set(bob.headers).send({ body: 'bob only' });

    expect(
      expectSuccess<DraftResponse>(await app.request.get(draftUrl(chatId)).set(alice.headers), 200)
        .body,
    ).toBe('alice only');
    expect(
      expectSuccess<DraftResponse>(await app.request.get(draftUrl(chatId)).set(bob.headers), 200)
        .body,
    ).toBe('bob only');

    const chats = expectSuccess<Array<Record<string, unknown>>>(
      await app.request.get('/api/chats').set(alice.headers),
      200,
    );
    expect(chats.find((chat) => chat.id === chatId)).not.toHaveProperty('draft');

    const history = expectSuccess<Array<Record<string, unknown>>>(
      await app.request.get(`/api/chats/${chatId}/messages`).set(alice.headers),
      200,
    );
    for (const message of history) {
      expect(message).not.toHaveProperty('draft');
    }
  });

  it('rejects secret chats, non-members, and unknown chats', async () => {
    const { alice, bob, chatId } = await pair();

    await fixture.registerDevice(alice);
    await fixture.registerDevice(bob);
    const secretChatId = await fixture.openSecretChat(bob.id, alice.headers);

    expectError(
      await app.request.put(draftUrl(secretChatId)).set(alice.headers).send({ body: 'secret' }),
      403,
      'E2EE_NOT_ALLOWED',
    );
    expectError(
      await app.request.get(draftUrl(secretChatId)).set(alice.headers),
      403,
      'E2EE_NOT_ALLOWED',
    );
    expectError(
      await app.request.delete(draftUrl(secretChatId)).set(alice.headers),
      403,
      'E2EE_NOT_ALLOWED',
    );

    const outsider = await fixture.verifiedUser('Outsider');
    expectError(
      await app.request.put(draftUrl(chatId)).set(outsider.headers).send({ body: 'nope' }),
      403,
      'NOT_CHAT_MEMBER',
    );

    const unknown = '00000000-0000-7000-8000-000000000000';
    expectError(
      await app.request.get(draftUrl(unknown)).set(alice.headers),
      403,
      'NOT_CHAT_MEMBER',
    );
  });

  it('validates bodies and requires an authenticated, verified caller', async () => {
    const { bob, chatId } = await pair();

    expectError(
      await app.request.put(draftUrl(chatId)).set(bob.headers).send({ body: '' }),
      400,
      'VALIDATION_ERROR',
    );
    expectError(
      await app.request.put(draftUrl(chatId)).set(bob.headers).send({ body: '   ' }),
      400,
      'VALIDATION_ERROR',
    );
    expectError(
      await app.request.put(draftUrl(chatId)).set(bob.headers).send({ body: 'x'.repeat(4097) }),
      400,
      'VALIDATION_ERROR',
    );
    expectError(
      await app.request.put(draftUrl(chatId)).set(bob.headers).send({}),
      400,
      'VALIDATION_ERROR',
    );
    expectError(
      await app.request.put(draftUrl(chatId)).send({ body: 'x' }),
      401,
      'UNAUTHORIZED',
    );

    const unverified = await fixture.unverifiedUser('Unverified');
    await fixture.openDirectChat(unverified.id, bob.headers);
    expectError(
      await app.request.put(draftUrl(chatId)).set(unverified.headers).send({ body: 'x' }),
      403,
      'EMAIL_NOT_VERIFIED',
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/messages/message-drafts.test.ts 2>&1 | tail -25`
Expected: FAIL with `404 NOT_FOUND` for the draft routes.

- [ ] **Step 3: Add the DraftService**

Create `src/modules/messages/logic/draft.service.ts`:

```ts
import { inject, injectable } from 'inversify';
import { E2eeNotAllowedException, NotChatMemberException } from '@/core/errors/domain.error.js';
import { MessageDraftRecord } from '@/modules/messages/logic/entities/message-draft-record.js';
import type { MessagingPolicy } from '@/modules/messages/logic/messaging-policy.service.js';
import type { ChatRepository } from '@/modules/messages/logic/ports/chat.repository.js';
import type { MessageDraftRepository } from '@/modules/messages/logic/ports/message-draft.repository.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';

/** Owns draft authorization and last-write-wins persistence. */
@injectable()
export class DraftService {
  constructor(
    @inject(MESSAGES_TYPES.ChatRepository) private readonly chats: ChatRepository,
    @inject(MESSAGES_TYPES.MessagingPolicy) private readonly policy: MessagingPolicy,
    @inject(MESSAGES_TYPES.MessageDraftRepository)
    private readonly drafts: MessageDraftRepository,
  ) {}

  async get(chatId: string, userId: string): Promise<MessageDraftRecord | null> {
    await this.assertDraftable(chatId, userId);

    return this.drafts.find(chatId, userId);
  }

  async save(chatId: string, userId: string, body: string): Promise<MessageDraftRecord> {
    await this.assertDraftable(chatId, userId);

    return this.drafts.upsert(chatId, userId, body, new Date());
  }

  async delete(chatId: string, userId: string): Promise<boolean> {
    await this.assertDraftable(chatId, userId);

    return this.drafts.delete(chatId, userId);
  }

  /** Best-effort cleanup after a send; the send path already authorized the caller. */
  async clearOnSend(chatId: string, userId: string): Promise<void> {
    await this.drafts.delete(chatId, userId);
  }

  private async assertDraftable(chatId: string, userId: string): Promise<void> {
    const chat = await this.chats.findById(chatId);

    if (!chat) {
      throw new NotChatMemberException();
    }

    await this.policy.requireMember(chatId, userId);

    if (chat.type !== 'direct') {
      throw new E2eeNotAllowedException();
    }
  }
}
```

Membership is checked before the chat type so a non-member never learns the chat type. The unknown-chat path still resolves to `NOT_CHAT_MEMBER` via `ChatRepository.findById` returning `null`.

- [ ] **Step 4: Add the DTO schema**

In `src/modules/messages/web/dto/message.schemas.ts`, add after `messageBodySchema`:

```ts
/** Body for an unsent draft. Trimming rejects whitespace-only drafts. */
export const saveDraftSchema = z.object({
  body: z.string().trim().min(1).max(4096),
});

export type SaveDraftSchema = z.infer<typeof saveDraftSchema>;
```

Do not modify `messageBodySchema` or any send schema.

- [ ] **Step 5: Add the OpenAPI schemas and contracts**

In `src/modules/messages/web/dto/message.openapi.ts`, add `saveDraftSchema` to the import list from `message.schemas.js`, then add these schemas beside `selfDestructResponse`:

```ts
export const draftSchema = z
  .object({
    body: z.string(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'MessageDraft' });

const draftResponse = successEnvelope(draftSchema, 'MessageDraftResponse');
const draftOrNullResponse = successEnvelope(draftSchema.nullable(), 'MessageDraftLookupResponse');
```

Add these three entries to `messageContracts` after `setSelfDestruct`:

```ts
  saveDraft: {
    operationId: 'chats.saveDraft',
    tags: ['Chats'],
    summary: "Save the caller's unsent text draft for a chat",
    description:
      'Stores one private draft per chat and caller. Saving again overwrites the body and refreshes updatedAt (last write wins). Direct cloud chats only; secret chats return 403 E2EE_NOT_ALLOWED.',
    security: bearerSecurity,
    request: { params: chatParamsSchema, body: saveDraftSchema },
    responses: {
      200: { description: 'The saved draft', schema: draftResponse },
      ...commonErrorResponses,
    },
  },
  getDraft: {
    operationId: 'chats.getDraft',
    tags: ['Chats'],
    summary: "Read the caller's unsent text draft for a chat",
    description:
      'Returns the caller own draft for this chat, or data: null when none exists. The peer draft is never returned.',
    security: bearerSecurity,
    request: { params: chatParamsSchema },
    responses: {
      200: { description: 'The draft, or null', schema: draftOrNullResponse },
      ...commonErrorResponses,
    },
  },
  deleteDraft: {
    operationId: 'chats.deleteDraft',
    tags: ['Chats'],
    summary: "Clear the caller's unsent text draft for a chat",
    description: 'Idempotent: clearing a chat with no draft still returns 204.',
    security: bearerSecurity,
    request: { params: chatParamsSchema },
    responses: {
      204: noContentResponse,
      ...commonErrorResponses,
    },
  },
```

- [ ] **Step 6: Add the controller**

Create `src/modules/messages/web/draft.controller.ts`:

```ts
import type { Request, RequestHandler } from 'express';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { UnauthorizedException } from '@/core/errors/http.error.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';
import type { MessageDraftRecord } from '@/modules/messages/logic/entities/message-draft-record.js';
import type { DraftService } from '@/modules/messages/logic/draft.service.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import { chatParamsSchema, saveDraftSchema } from '@/modules/messages/web/dto/message.schemas.js';

/** Request-scoped handlers for the caller's private unsent drafts. */
@injectable()
export class DraftController {
  constructor(
    @inject(MESSAGES_TYPES.DraftService) private readonly drafts: DraftService,
    @inject(CORE_TYPES.ApiResponse) private readonly response: ApiResponse,
  ) {}

  save: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const { chatId } = chatParamsSchema.parse(req.params);
    const { body } = saveDraftSchema.parse(req.body);
    const draft = await this.drafts.save(user.id, chatId, body);

    this.response.ok(res, this.present(draft));
  };

  get: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const { chatId } = chatParamsSchema.parse(req.params);
    const draft = await this.drafts.get(user.id, chatId);

    this.response.ok(res, draft === null ? null : this.present(draft));
  };

  remove: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const { chatId } = chatParamsSchema.parse(req.params);
    await this.drafts.delete(user.id, chatId);

    this.response.noContent(res);
  };

  private present(draft: MessageDraftRecord) {
    return {
      body: draft.body,
      updatedAt: draft.updatedAt.toISOString(),
    };
  }

  private requireUser(req: Request): Express.User {
    if (!req.isAuthenticated()) {
      throw new UnauthorizedException();
    }

    return req.user;
  }
}
```

- [ ] **Step 7: Bind the service and controller**

In `src/modules/messages/messages.types.ts`, add beside the other service/controller symbols:

```ts
  DraftService: Symbol.for('Messages.DraftService'),
  DraftController: Symbol.for('Messages.DraftController'),
```

In `src/modules/messages/messages.container.ts`, add the imports:

```ts
import { DraftService } from '@/modules/messages/logic/draft.service.js';
import { DraftController } from '@/modules/messages/web/draft.controller.js';
```

and add the bindings after `MessagingPolicy` (service) and after `ChatController` (controller):

```ts
    this.bind<DraftService>(MESSAGES_TYPES.DraftService).to(DraftService).inSingletonScope();
```

```ts
    this.bind<DraftController>(MESSAGES_TYPES.DraftController).to(DraftController);
```

- [ ] **Step 8: Register the three routes**

In `src/modules/messages/web/routes/messages.router.ts`, add the type import:

```ts
import type { DraftController } from '@/modules/messages/web/draft.controller.js';
```

Insert these registrations after the `/:chatId/self-destruct` route and before the pin routes:

```ts
    routes.put(
      '/:chatId/draft',
      messageContracts.saveDraft,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container.get<DraftController>(MESSAGES_TYPES.DraftController).save(req, res, next),
    );

    routes.get(
      '/:chatId/draft',
      messageContracts.getDraft,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container.get<DraftController>(MESSAGES_TYPES.DraftController).get(req, res, next),
    );

    routes.delete(
      '/:chatId/draft',
      messageContracts.deleteDraft,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container.get<DraftController>(MESSAGES_TYPES.DraftController).remove(req, res, next),
    );
```

- [ ] **Step 9: Add the README route rows**

In the messaging route table in `README.md`, add after the self-destruct row:

```md
| `PUT`    | `/api/chats/:chatId/draft`                      | Save the caller's unsent text draft       |
| `GET`    | `/api/chats/:chatId/draft`                      | Read the caller's draft (or `null`)       |
| `DELETE` | `/api/chats/:chatId/draft`                      | Clear the caller's draft (idempotent)     |
```

The full explanatory "Message drafts" prose section is added in Task 4 together with the send-clear behavior.

- [ ] **Step 10: Run typecheck and the HTTP test**

Run: `npm run typecheck 2>&1 | tail -25; npx vitest run tests/integration/messages/message-drafts.test.ts 2>&1 | tail -25`
Expected: typecheck clean; the four HTTP tests pass. The generated OpenAPI document registers three new unique operations (the registry rejects duplicates at boot, so `TestApp.create()` succeeding is the check).

- [ ] **Step 11: Commit**

```bash
git add src/modules/messages/logic/draft.service.ts src/modules/messages/web/draft.controller.ts src/modules/messages/messages.types.ts src/modules/messages/messages.container.ts src/modules/messages/web/dto/message.schemas.ts src/modules/messages/web/dto/message.openapi.ts src/modules/messages/web/routes/messages.router.ts tests/integration/messages/message-drafts.test.ts README.md
git commit -m "feat(messaging): add private per-chat draft API"
```

---

### Task 4: Clear drafts after successful sends

**Files:**
- Modify: `src/modules/messages/logic/message.service.ts`
- Modify: `tests/unit/message-media.service.test.ts`
- Modify: `tests/integration/messages/message-drafts.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `DraftService.clearOnSend(chatId, userId)`, `CORE_TYPES.Logger`.
- Produces: best-effort `clearDraftAfterSend` on `MessageService` after cloud text, media, upload, and forward sends; docs describing the behavior.

- [ ] **Step 1: Add failing send-clear HTTP tests**

Append these two `it` blocks inside `describe('message drafts', ...)` in `tests/integration/messages/message-drafts.test.ts`:

```ts
  it('clears only the sender draft after a text send', async () => {
    const { alice, bob, chatId } = await pair();

    await app.request.put(draftUrl(chatId)).set(alice.headers).send({ body: 'unsent' });
    await app.request.put(draftUrl(chatId)).set(bob.headers).send({ body: 'bob draft' });

    expectSuccess(
      await app.request
        .post(`/api/chats/${chatId}/messages`)
        .set(alice.headers)
        .send({ body: 'sent' }),
      201,
    );

    expectSuccess(await app.request.get(draftUrl(chatId)).set(alice.headers), 200).toBeNull();
    expect(
      expectSuccess<DraftResponse>(await app.request.get(draftUrl(chatId)).set(bob.headers), 200)
        .body,
    ).toBe('bob draft');
  });

  it('clears the target draft after a forward', async () => {
    const { alice, bob, chatId } = await pair();
    const carol = await fixture.verifiedUser('Carol');
    const targetChatId = await fixture.openDirectChat(carol.id, alice.headers);

    const source = expectSuccess<{ id: string }>(
      await app.request
        .post(`/api/chats/${chatId}/messages`)
        .set(alice.headers)
        .send({ body: 'source' }),
      201,
    );
    await app.request.put(draftUrl(chatId)).set(alice.headers).send({ body: 'unsent' });
    await app.request
      .put(draftUrl(targetChatId))
      .set(alice.headers)
      .send({ body: 'forward draft' });

    expectSuccess(
      await app.request
        .post(`/api/chats/${chatId}/messages/${source.id}/forward`)
        .set(alice.headers)
        .send({ targetChatId }),
      201,
    );

    expectSuccess(await app.request.get(draftUrl(targetChatId)).set(alice.headers), 200).toBeNull();
    expect(
      expectSuccess<DraftResponse>(await app.request.get(draftUrl(chatId)).set(alice.headers), 200)
        .body,
    ).toBe('unsent');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/messages/message-drafts.test.ts 2>&1 | tail -30`
Expected: the two new tests FAIL because no send path clears drafts; the four existing tests still pass.

- [ ] **Step 3: Inject DraftService and Logger into MessageService**

In `src/modules/messages/logic/message.service.ts`, add the imports:

```ts
import type { Logger } from 'pino';
```

and add these two parameters at the end of the constructor parameter list:

```ts
    @inject(MESSAGES_TYPES.DraftService) private readonly drafts: DraftService,
    @inject(CORE_TYPES.Logger) private readonly logger: Logger,
```

with `import type { DraftService } from '@/modules/messages/logic/draft.service.js';` added beside the other logic imports.

- [ ] **Step 4: Call the best-effort clear after each cloud send**

In `send`, replace the final `return this.messages.create({...})` with:

```ts
    const message = await this.messages.create({
      chatId,
      senderId: userId,
      body: input.body,
      type: 'text',
      replyToMessageId: input.replyToMessageId ?? null,
      expiresAt,
    });
    await this.clearDraftAfterSend(chatId, userId);

    return message;
```

In `sendMedia`, replace the final `return this.messages.create({...})` with:

```ts
    const message = await this.messages.create({
      chatId,
      senderId: userId,
      body: null,
      type: 'media',
      media: {
        mediaId: input.mediaId,
        kind: input.kind,
        caption: input.caption ?? null,
        durationMs: input.durationMs ?? null,
        width: input.width ?? null,
        height: input.height ?? null,
      },
      replyToMessageId: input.replyToMessageId ?? null,
      expiresAt,
    });
    await this.clearDraftAfterSend(chatId, userId);

    return message;
```

In `sendMediaFromUpload`, replace the final `return this.messages.create({...})` with the same block but with `mediaId: asset.id` inside `media`, then `await this.clearDraftAfterSend(chatId, userId);` and `return message;`.

In `forward`, replace the final `return this.messages.create({...})` with:

```ts
    const message = await this.messages.create({
      chatId: targetChatId,
      senderId: userId,
      body: original.media === null ? original.body : null,
      type: original.media === null ? 'text' : 'media',
      ...(original.media === null ? {} : { media: original.media }),
      forwardedFromChatId: sourceChatId,
      forwardedFromMessageId: messageId,
      expiresAt,
    });
    await this.clearDraftAfterSend(targetChatId, userId);

    return message;
```

Do **not** call it from `sendSecret`: drafts are not supported in secret chats.

Add this private method near `expiryFor`:

```ts
  /** A stale draft is recoverable; a failed send is not. Never fail a send for this. */
  private async clearDraftAfterSend(chatId: string, userId: string): Promise<void> {
    try {
      await this.drafts.clearOnSend(chatId, userId);
    } catch (error) {
      this.logger.warn({ err: error, chatId, userId }, 'Failed to clear message draft after send');
    }
  }
```

- [ ] **Step 5: Update the unit-test constructor stub**

In `tests/unit/message-media.service.test.ts`, append two arguments to the `new MessageService(...)` call (currently ending with `new MediaKindPolicy(),`):

```ts
    new MediaKindPolicy(),
    { clearOnSend: () => Promise.resolve() } as never,
    { warn: () => undefined } as never,
```

No other unit test constructs `MessageService` directly.

- [ ] **Step 6: Document the behavior**

Add this section to `README.md` after the `### Self-destruct presets` section:

```md
### Message drafts

`PUT /api/chats/:chatId/draft` accepts `{ "body": "..." }` with a trimmed body of 1–4096
characters and saves one private draft per chat and caller. Saving again overwrites the body
and refreshes `updatedAt`, so the latest save from any device wins. `GET` returns
`{ "body": "...", "updatedAt": "..." }` or `data: null` when no draft exists; `DELETE` is
idempotent and returns `204`.

Drafts are visible only to their author and never appear in chat lists, message history, or
unread counts. Secret chats return `403 E2EE_NOT_ALLOWED` so their plaintext never reaches
the server. A successful cloud message send in that chat clears the caller's draft (text,
media, upload, or forward), while the peer's draft is untouched.
```

- [ ] **Step 7: Run the affected tests and typecheck**

Run: `npm run typecheck 2>&1 | tail -25; npx vitest run tests/integration/messages/message-drafts.test.ts tests/unit/message-media.service.test.ts 2>&1 | tail -25`
Expected: typecheck clean; draft tests PASS (6 tests); media-service unit tests still pass.

- [ ] **Step 8: Commit**

```bash
git add src/modules/messages/logic/message.service.ts tests/unit/message-media.service.test.ts tests/integration/messages/message-drafts.test.ts README.md
git commit -m "feat(messaging): clear drafts after successful sends"
```

---

### Task 5: Full regression pass and live HTTP smoke

**Files:**
- No source changes expected. Update the gitignored `plan.md` handoff only if verification reveals a needed note; never commit it.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: verified tree, recorded smoke result, clean worktree.

- [ ] **Step 1: Run the full automated gate**

Run: `npm run verify && npm run db:check`
Expected: typecheck, Biome, build, all tests, and `Everything's fine 🐶🔥`. The only known Biome output is the pre-existing non-blocking `SelfDestructTimer` static-only-class warning; there should be no new errors. Do not run this gate in the original checkout, which has unrelated committed `is-prime.test.ts`/`tsconfig.json` edits.

- [ ] **Step 2: Start services and the API**

Run: `docker compose up -d postgres redis minio storage-init && npm run dev`
Wait for the API to listen on port 4000.

- [ ] **Step 3: Smoke-test success paths**

Using two verified temporary users (created through the existing registration/verification helper flow), exercise over HTTP:

1. `PUT /api/chats/:chatId/draft` with `{"body":"first"}` → `200` with `body` and ISO `updatedAt`.
2. `PUT` again with `{"body":"second"}` → `200`, newer `updatedAt`; `GET` returns `second`.
3. `GET` from the peer → `200` with `data: null`; peer `PUT` does not change the author's draft.
4. `POST /api/chats/:chatId/messages` as the author → `201`; `GET` draft as the author → `data: null`; peer's draft unchanged.
5. `PUT` as the peer, then `DELETE` twice → both `204`; `GET` → `data: null`.
6. Confirm in PostgreSQL that draft rows are gone for that chat and user after the clear/delete.

- [ ] **Step 4: Smoke-test error paths**

1. `PUT` with `{"body":""}` or a 4097-character body → `400 VALIDATION_ERROR`.
2. `PUT` without a bearer token → `401 UNAUTHORIZED`.
3. `PUT` from an unverified user → `403 EMAIL_NOT_VERIFIED`.
4. `PUT` from a non-member → `403 NOT_CHAT_MEMBER`, and for an unknown chat → `403 NOT_CHAT_MEMBER`.
5. Register E2EE devices, open a secret chat, and `PUT`/`GET`/`DELETE` its draft → `403 E2EE_NOT_ALLOWED`; confirm no draft row was written.

- [ ] **Step 5: Clean up and record the result**

Delete every temporary user created for the smoke, stop the API process, and leave PostgreSQL/Redis/MinIO running. Confirm the worktree contains only intended changes. Update the gitignored `plan.md` in the original checkout with the commit range, verification output, smoke result, cleanup confirmation, and remaining risks. Do not commit `plan.md` or any `.env`/secret file.

- [ ] **Step 6: Integration choice**

Only after this plan is reviewed and the full gate is green, present the integration options: PR + merge + original-checkout update, squash merge, or rebase onto `main`. Keep `feat/message-drafts` until the human partner chooses.
