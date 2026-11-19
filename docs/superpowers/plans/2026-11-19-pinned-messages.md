# Pinned Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add private, per-user pinned messages to direct cloud and secret chats, with a 10-pin cap and a caller-specific `pinnedAt` indicator on message history.

**Architecture:** A new `message_pins` table holds `(chat_id, message_id, user_id, pinned_at)` with no FK to the partitioned `messages` table. A `MessagePinRepository` serializes cap checks with a `FOR UPDATE` lock on the caller's membership row; a `PinService` enforces membership and message validity; a request-scoped `PinController` exposes pin/unpin/list through `DocumentedRouter`. `MessagePresenter` gains an optional pinned-at map so history resolves indicators in one batched query per page.

**Tech Stack:** Node 24, TypeScript 7.0.2, ESM, Express 5, Inversify 8 child containers, Drizzle ORM + PostgreSQL 18, Zod, Vitest + Supertest, Biome, Pino.

**Spec:** `docs/superpowers/specs/2026-11-19-pinned-messages-design.md`

## Global Constraints

- Node 24, TypeScript 7.0.2, ESM (`"type": "module"`); use `@/...` aliases and explicit `.js` extensions in relative imports.
- Biome: single quotes, semicolons, trailing commas, 2-space indentation, 100-character line width, organized imports.
- Put behavior in classes; prefer `@injectable()` services with constructor injection and `@inject(SYMBOL)`. No module-level helper functions except framework callbacks or declarative values.
- Controllers are request-scoped and resolved from `req.container`. Keep transport concerns in `web/` and out of `logic/` and `data/`.
- All JSON responses use the shared envelope via the injected `ApiResponse` service (`created`, `ok`, `list`, `noContent`); never call `res.json` directly.
- Use the layered error hierarchy; no ad hoc `Error` with status codes. `NotFoundException` → `404 NOT_FOUND`, `ConflictException` → `409 CONFLICT`, `PersistenceException` for database failures. No new public error codes.
- Drizzle ORM is the only data-access layer. Repositories inject `CORE_TYPES.Db`, import tables from the schema barrel, map rows via a mapper class, and wrap database errors. Raw `pg.Pool` is only for health/migrations/tests.
- Every route goes through `DocumentedRouter` with a `RouteContract`; the same Zod schema documents and validates. Update `messageSchema` when response fields change.
- Generate migrations with `npm run db:generate`, review the SQL, apply with `npm run db:migrate`. Never edit an applied migration. `npm run db:check` must be clean.
- `docs/superpowers/**/*.md` is gitignored: use `git add -f` for the plan and any spec changes.
- The gitignored `/home/ahmed/Desktop/tutorial/inversify-passport/plan.md` must never be committed.
- Tests need PostgreSQL, Redis, MinIO (already running) plus `docker compose --profile scan up -d clamav` before `npm test`, stopped afterwards. Leave PostgreSQL/Redis/MinIO running.
- Definition of done: `npm run verify && npm run db:check`, live HTTP smoke with success and error paths, cleanup of all temporary data/processes, and an explicit handoff.

## Review Focus

- **Concurrent 11th pin:** two simultaneous pin requests when 9 pins exist must produce exactly 10 rows and one cap rejection; a count-then-insert without a row lock would silently allow 11. Test in Task 2.
- **Cross-user pin leak:** Alice's pin must not change Bob's `pinnedAt` or appear in Bob's `GET /pins`; any query missing the `user_id` predicate leaks private bookmarks. Test in Tasks 4 and 5.
- **Foreign-chat message id:** pinning a message id that exists in another chat must return `404 NOT_FOUND` and create no pin row; a lookup without `chat_id` would create a cross-chat pin. Test in Tasks 3 and 5.
- **Soft-deleted target:** pinning a soft-deleted message must return `404 NOT_FOUND`, and `GET /pins` must omit a message deleted after pinning. Test in Tasks 3 and 5.
- **Secret-chat content preservation:** pinning in a secret chat must not alter `ciphertext`, `nonce`, device ids, or message `updated_at`. Test in Task 5.

---

### Task 1: Schema, migration 0015, and schema tests

**Files:**
- Modify: `src/core/database/schema/messaging.schema.ts` (after `chatMembers`, before `messages`)
- Modify: `tests/helpers/test-app.ts:34-54` (TRUNCATE list)
- Modify: `tests/integration/messages/messaging-schema.test.ts`
- Create: `drizzle/0015_<generated>.sql` and the updated `drizzle/meta/*` snapshot (generated)

**Interfaces:**
- Consumes: `chats`, `users` tables from the schema barrel.
- Produces: exported `messagePins` table with columns `chatId`, `messageId`, `userId`, `pinnedAt`; composite PK `message_pins_pkey`; index `message_pins_chat_user_pinned_at_index`; FK to `chats` and `users` with `ON DELETE CASCADE`; no FK to `messages`.

- [ ] **Step 1: Add the failing schema tests**

Append to `tests/integration/messages/messaging-schema.test.ts` inside the existing `describe('Messaging schema', ...)`:

```ts
  it('creates message_pins with a composite key and cascade FKs but no message FK', async () => {
    const columns = await app.pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'message_pins' ORDER BY ordinal_position`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'chat_id',
      'message_id',
      'user_id',
      'pinned_at',
    ]);

    const keys = await app.pool.query<{ constraint_name: string; constraint_type: string }>(
      `SELECT constraint_name, constraint_type FROM information_schema.table_constraints
       WHERE table_name = 'message_pins' ORDER BY constraint_type, constraint_name`,
    );
    expect(keys.rows.map((row) => row.constraint_name)).toContain('message_pins_pkey');

    const fks = await app.pool.query<{ target: string; on_delete: string }>(
      `SELECT ccu.table_name AS target, rc.delete_rule AS on_delete
       FROM information_schema.table_constraints tc
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_name = tc.constraint_name
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
       WHERE tc.table_name = 'message_pins' AND tc.constraint_type = 'FOREIGN KEY'`,
    );
    expect(fks.rows).toEqual(
      expect.arrayContaining([
        { target: 'chats', on_delete: 'CASCADE' },
        { target: 'users', on_delete: 'CASCADE' },
      ]),
    );
    expect(fks.rows.some((row) => row.target === 'messages')).toBe(false);
  });

  it('stores one pin per (chat, user, message) and orders pins by pinned_at', async () => {
    const first = await auth.createUser();
    const second = await auth.createUser();
    const chatId = await createDirectChat(first.id, second.id);
    await app.pool.query(
      `INSERT INTO messages (chat_id, sender_id, body) VALUES ($1, $2, 'pinned')`,
      [chatId, second.id],
    );
    const messageId = (
      await app.pool.query<{ id: string }>(`SELECT id FROM messages WHERE chat_id = $1`, [chatId])
    ).rows[0]?.id as string;

    await app.pool.query(
      `INSERT INTO message_pins (chat_id, message_id, user_id) VALUES ($1, $2, $3)`,
      [chatId, messageId, first.id],
    );
    await expect(
      app.pool.query(
        `INSERT INTO message_pins (chat_id, message_id, user_id) VALUES ($1, $2, $3)`,
        [chatId, messageId, first.id],
      ),
    ).rejects.toThrow(/message_pins_pkey/);

    const ordered = await app.pool.query<{ message_id: string }>(
      `SELECT message_id FROM message_pins
       WHERE chat_id = $1 AND user_id = $2 ORDER BY pinned_at DESC`,
      [chatId, first.id],
    );
    expect(ordered.rows.map((row) => row.message_id)).toEqual([messageId]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/messages/messaging-schema.test.ts -t message_pins`
Expected: FAIL with `relation "message_pins" does not exist`.

- [ ] **Step 3: Add the table definition**

Insert between `chatMembers` and `messages` in `src/core/database/schema/messaging.schema.ts`:

```ts
/**
 * Per-user bookmarks. There is deliberately no FK to `messages`: that table is
 * hash partitioned and a bookmark must not restrict message deletion. Pins are
 * removed explicitly when a message is soft-deleted, and chat/user deletion
 * cascades from the parent rows.
 */
export const messagePins = pgTable(
  'message_pins',
  {
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pinnedAt: timestamp('pinned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.userId, table.messageId], name: 'message_pins_pkey' }),
    index('message_pins_chat_user_pinned_at_index').on(table.chatId, table.userId, table.pinnedAt.desc()),
  ],
);
```

`pgTable`, `primaryKey`, `index`, `timestamp`, `uuid` are already imported at the top of that file.

- [ ] **Step 4: Add the table to test cleanup**

In `tests/helpers/test-app.ts`, insert `message_pins,` after `media_objects,` in the `TRUNCATE TABLE` list so pin rows never leak between tests.

- [ ] **Step 5: Generate, review, and apply the migration**

Run `npm run db:generate`. Confirm it produced `drizzle/0015_*.sql` containing only `CREATE TABLE "message_pins"` with the composite primary key, two cascading FKs, and the index — no `ALTER TABLE messages`. Then run `npm run db:migrate` and `npm run db:check` (expected: `Everything's fine 🐶🔥`). Never edit the generated file by hand.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/integration/messages/messaging-schema.test.ts -t message_pins`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add src/core/database/schema/messaging.schema.ts tests/helpers/test-app.ts \
  tests/integration/messages/messaging-schema.test.ts drizzle
git commit -m "feat(messaging): add per-user message pin table and migration"
```

---

### Task 2: Pin repository port, PostgreSQL implementation, and repository tests

**Files:**
- Create: `src/modules/messages/logic/ports/message-pin.repository.ts`
- Create: `src/modules/messages/data/message-pin.mapper.ts`
- Create: `src/modules/messages/data/postgres-message-pin.repository.ts`
- Modify: `src/modules/messages/logic/ports/message.repository.ts` (add `listByIds`)
- Modify: `src/modules/messages/data/postgres-message.repository.ts` (implement `listByIds`)
- Modify: `src/modules/messages/messages.types.ts`
- Modify: `src/modules/messages/messages.container.ts`
- Modify: `tests/integration/messages/messaging-repositories.test.ts`

**Interfaces:**
- Consumes: `messagePins`, `chatMembers` tables; `AppDatabase` (`CORE_TYPES.Db`); `MessageMapper`/`messageSelection`.
- Produces: `PinRecord { messageId: string; pinnedAt: Date }`; `MessagePinRepository` with `pin(chatId, userId, messageId): Promise<PinRecord | null>` (null = cap reached, duplicate returns original), `unpin(chatId, userId, messageId): Promise<boolean>`, `list(chatId, userId): Promise<PinRecord[]>`, `listPinnedFor(chatId, userId, messageIds): Promise<Map<string, Date>>`, `removeForMessage(chatId, messageId): Promise<void>`; `MessageRepository.listByIds(chatId, ids): Promise<MessageRecord[]>`; symbols `MESSAGES_TYPES.MessagePinRepository`.

- [ ] **Step 1: Write the failing repository tests**

Append to `tests/integration/messages/messaging-repositories.test.ts` inside the existing describe. Add imports at the top:

```ts
import type { MessagePinRepository } from '@/modules/messages/logic/ports/message-pin.repository.js';
```

In `beforeAll`, add:

```ts
    pins = container.get(MESSAGES_TYPES.MessagePinRepository);
```

and declare `let pins: MessagePinRepository;` beside the other repository variables.

Then append the tests:

```ts
  it('pins, lists, and unpins a message for one user only', async () => {
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
    const message = await messages.create({
      chatId: chat.id,
      senderId: bob.id,
      body: 'important',
    });

    const first = await pins.pin(chat.id, alice.id, message.id);
    expect(first?.messageId).toBe(message.id);
    expect(first?.pinnedAt).toBeInstanceOf(Date);
    expect((await pins.list(chat.id, alice.id)).map((pin) => pin.messageId)).toEqual([message.id]);
    expect(await pins.list(chat.id, bob.id)).toEqual([]);

    const map = await pins.listPinnedFor(chat.id, alice.id, [message.id]);
    expect(map.get(message.id)?.toISOString()).toBe(first?.pinnedAt.toISOString());

    // A duplicate keeps its original timestamp.
    const duplicate = await pins.pin(chat.id, alice.id, message.id);
    expect(duplicate?.pinnedAt.toISOString()).toBe(first?.pinnedAt.toISOString());

    expect(await pins.unpin(chat.id, alice.id, message.id)).toBe(true);
    expect(await pins.unpin(chat.id, alice.id, message.id)).toBe(false);
    expect(await pins.list(chat.id, alice.id)).toEqual([]);
  });

  it('enforces the ten-pin cap under concurrent writes', async () => {
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

    const ids: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      const message = await messages.create({
        chatId: chat.id,
        senderId: bob.id,
        body: `message ${index}`,
      });
      ids.push(message.id);
    }

    for (const id of ids.slice(0, 9)) {
      expect(await pins.pin(chat.id, alice.id, id)).not.toBeNull();
    }

    const results = await Promise.all([
      pins.pin(chat.id, alice.id, ids[9] as string),
      pins.pin(chat.id, alice.id, ids[10] as string),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(await pins.list(chat.id, alice.id)).toHaveLength(10);
  });

  it('removes every user pin of a message and lists only live rows by id', async () => {
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
    const pinned = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'pin me' });
    const removed = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'delete me' });

    await pins.pin(chat.id, alice.id, pinned.id);
    await pins.pin(chat.id, bob.id, pinned.id);
    await pins.pin(chat.id, alice.id, removed.id);
    await messages.markDeleted(chat.id, removed.id, new Date());

    const loaded = await messages.listByIds(chat.id, [pinned.id, removed.id]);
    expect(loaded.map((message) => message.id)).toEqual([pinned.id]);

    await pins.removeForMessage(chat.id, pinned.id);
    expect(await pins.list(chat.id, alice.id)).toEqual([]);
    expect(await pins.list(chat.id, bob.id)).toEqual([]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/messages/messaging-repositories.test.ts -t "pins|ten-pin|removes every user pin"`
Expected: FAIL because `MESSAGES_TYPES.MessagePinRepository` is not bound and `listByIds` is missing.

- [ ] **Step 3: Define the port**

Create `src/modules/messages/logic/ports/message-pin.repository.ts`:

```ts
export interface PinRecord {
  readonly messageId: string;
  readonly pinnedAt: Date;
}

/** Per-user, private message bookmarks. Every method is scoped by chat and user. */
export interface MessagePinRepository {
  /** Returns null when the caller already has ten pins in this chat. */
  pin(chatId: string, userId: string, messageId: string): Promise<PinRecord | null>;

  /** True when a pin was removed, false when none existed. */
  unpin(chatId: string, userId: string, messageId: string): Promise<boolean>;

  /** Caller's pins in this chat, newest pin first. */
  list(chatId: string, userId: string): Promise<PinRecord[]>;

  /** Batched indicator lookup for one page of message ids. */
  listPinnedFor(
    chatId: string,
    userId: string,
    messageIds: readonly string[],
  ): Promise<Map<string, Date>>;

  /** Removes every user's pin of one message. */
  removeForMessage(chatId: string, messageId: string): Promise<void>;
}
```

- [ ] **Step 4: Add `listByIds` to the message repository**

In `src/modules/messages/logic/ports/message.repository.ts`, add to the interface:

```ts
  /** Live messages among the given ids, scoped by chat for partition pruning. */
  listByIds(chatId: string, ids: readonly string[]): Promise<MessageRecord[]>;
```

In `src/modules/messages/data/postgres-message.repository.ts`, add the method (the imports `and`, `eq`, `inArray`, `isNull` are already present):

```ts
  async listByIds(chatId: string, ids: readonly string[]): Promise<MessageRecord[]> {
    if (ids.length === 0) {
      return [];
    }

    try {
      const rows = await this.db
        .select(messageSelection)
        .from(messages)
        .where(and(eq(messages.chatId, chatId), inArray(messages.id, [...ids]), isNull(messages.deletedAt)));

      return rows.map((row) => this.mapper.toRecord(row));
    } catch (error) {
      throw new PersistenceException('Failed to list messages by id', { cause: error });
    }
  }
```

- [ ] **Step 5: Add the mapper and PostgreSQL implementation**

Create `src/modules/messages/data/message-pin.mapper.ts`:

```ts
import type { InferSelectModel } from 'drizzle-orm';
import { messagePins } from '@/core/database/schema/index.js';
import type { PinRecord } from '@/modules/messages/logic/ports/message-pin.repository.js';

/** Explicit column selection for the `message_pins` table. */
export const pinSelection = {
  messageId: messagePins.messageId,
  pinnedAt: messagePins.pinnedAt,
} as const;

export type PinRow = Pick<InferSelectModel<typeof messagePins>, keyof typeof pinSelection>;

export class MessagePinMapper {
  toRecord(row: PinRow): PinRecord {
    return { messageId: row.messageId, pinnedAt: row.pinnedAt };
  }
}
```

Create `src/modules/messages/data/postgres-message-pin.repository.ts`:

```ts
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { AppDatabase } from '@/core/database/database.provider.js';
import { chatMembers, messagePins } from '@/core/database/schema/index.js';
import { PersistenceException } from '@/core/errors/repository.error.js';
import { MessagePinMapper, pinSelection } from '@/modules/messages/data/message-pin.mapper.js';
import type {
  MessagePinRepository,
  PinRecord,
} from '@/modules/messages/logic/ports/message-pin.repository.js';

/** Ten bookmarks per chat and user; the 11th pin is rejected. */
const PIN_LIMIT = 10;

@injectable()
export class PostgresMessagePinRepository implements MessagePinRepository {
  private readonly mapper = new MessagePinMapper();

  constructor(@inject(CORE_TYPES.Db) private readonly db: AppDatabase) {}

  async pin(chatId: string, userId: string, messageId: string): Promise<PinRecord | null> {
    try {
      return await this.db.transaction(async (tx) => {
        // Serializes concurrent pin attempts by this user in this chat.
        await tx
          .select({ userId: chatMembers.userId })
          .from(chatMembers)
          .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)))
          .limit(1)
          .for('update');

        const existing = await tx
          .select(pinSelection)
          .from(messagePins)
          .where(
            and(
              eq(messagePins.chatId, chatId),
              eq(messagePins.userId, userId),
              eq(messagePins.messageId, messageId),
            ),
          )
          .limit(1);

        if (existing[0]) {
          return this.mapper.toRecord(existing[0]);
        }

        const counted = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(messagePins)
          .where(and(eq(messagePins.chatId, chatId), eq(messagePins.userId, userId)));

        if ((counted[0]?.count ?? 0) >= PIN_LIMIT) {
          return null;
        }

        const inserted = await tx
          .insert(messagePins)
          .values({ chatId, userId, messageId })
          .returning(pinSelection);

        const row = inserted[0];

        if (!row) {
          throw new PersistenceException('PostgreSQL did not return the created pin');
        }

        return this.mapper.toRecord(row);
      });
    } catch (error) {
      if (error instanceof PersistenceException) {
        throw error;
      }

      throw new PersistenceException('Failed to pin message', { cause: error });
    }
  }

  async unpin(chatId: string, userId: string, messageId: string): Promise<boolean> {
    try {
      const rows = await this.db
        .delete(messagePins)
        .where(
          and(
            eq(messagePins.chatId, chatId),
            eq(messagePins.userId, userId),
            eq(messagePins.messageId, messageId),
          ),
        )
        .returning({ messageId: messagePins.messageId });

      return rows.length > 0;
    } catch (error) {
      throw new PersistenceException('Failed to unpin message', { cause: error });
    }
  }

  async list(chatId: string, userId: string): Promise<PinRecord[]> {
    try {
      const rows = await this.db
        .select(pinSelection)
        .from(messagePins)
        .where(and(eq(messagePins.chatId, chatId), eq(messagePins.userId, userId)))
        .orderBy(desc(messagePins.pinnedAt));

      return rows.map((row) => this.mapper.toRecord(row));
    } catch (error) {
      throw new PersistenceException('Failed to list pinned messages', { cause: error });
    }
  }

  async listPinnedFor(
    chatId: string,
    userId: string,
    messageIds: readonly string[],
  ): Promise<Map<string, Date>> {
    if (messageIds.length === 0) {
      return new Map();
    }

    try {
      const rows = await this.db
        .select(pinSelection)
        .from(messagePins)
        .where(
          and(
            eq(messagePins.chatId, chatId),
            eq(messagePins.userId, userId),
            inArray(messagePins.messageId, [...messageIds]),
          ),
        );

      return new Map(rows.map((row) => [row.messageId, row.pinnedAt]));
    } catch (error) {
      throw new PersistenceException('Failed to look up pinned messages', { cause: error });
    }
  }

  async removeForMessage(chatId: string, messageId: string): Promise<void> {
    try {
      await this.db
        .delete(messagePins)
        .where(and(eq(messagePins.chatId, chatId), eq(messagePins.messageId, messageId)));
    } catch (error) {
      throw new PersistenceException('Failed to remove message pins', { cause: error });
    }
  }
}
```

- [ ] **Step 6: Bind the repository**

In `src/modules/messages/messages.types.ts`, add to `MESSAGES_TYPES`:

```ts
  MessagePinRepository: Symbol.for('Messages.MessagePinRepository'),
```

In `src/modules/messages/messages.container.ts`, add imports for `PostgresMessagePinRepository` and `MessagePinRepository`, then bind after `MessageRepository`:

```ts
    this.bind<MessagePinRepository>(MESSAGES_TYPES.MessagePinRepository)
      .to(PostgresMessagePinRepository)
      .inSingletonScope();
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/integration/messages/messaging-repositories.test.ts`
Expected: PASS (all repository tests, including the three new ones).

- [ ] **Step 8: Commit**

```bash
git add src/modules/messages tests/integration/messages/messaging-repositories.test.ts
git commit -m "feat(messaging): add per-user pin repository with capped writes"
```

---

### Task 3: PinService and service-level tests

**Files:**
- Create: `src/modules/messages/logic/pin.service.ts`
- Modify: `src/modules/messages/messages.types.ts`
- Modify: `src/modules/messages/messages.container.ts`
- Create: `tests/integration/messages/pin-service.test.ts`

**Interfaces:**
- Consumes: `MessagingPolicy.requireMember(chatId, userId)`, `MessageRepository.findById`/`listByIds`, `MessagePinRepository` from Task 2.
- Produces: `PinnedMessage { message: MessageRecord; pinnedAt: Date }`; `PinService.pin(userId, chatId, messageId): Promise<PinRecord>`, `unpin(userId, chatId, messageId): Promise<void>`, `list(userId, chatId): Promise<PinnedMessage[]>`, `listPinnedFor(chatId, viewerId, messageIds): Promise<Map<string, Date>>`; symbol `MESSAGES_TYPES.PinService`.

- [ ] **Step 1: Write the failing service tests**

Create `tests/integration/messages/pin-service.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConflictException } from '@/core/errors/http.error.js';
import type { PinService } from '@/modules/messages/logic/pin.service.js';
import type { ChatRepository } from '@/modules/messages/logic/ports/chat.repository.js';
import type { ChatMemberRepository } from '@/modules/messages/logic/ports/chat-member.repository.js';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import { MessagesContainer } from '@/modules/messages/messages.container.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { TestApp } from '../../helpers/test-app.js';

describe('PinService', () => {
  let app: TestApp;
  let auth: AuthFixture;
  let chats: ChatRepository;
  let members: ChatMemberRepository;
  let messages: MessageRepository;
  let pins: PinService;

  beforeAll(async () => {
    app = await TestApp.create();
    auth = new AuthFixture(app);
    const container = new MessagesContainer(app.container);
    chats = container.get(MESSAGES_TYPES.ChatRepository);
    members = container.get(MESSAGES_TYPES.ChatMemberRepository);
    messages = container.get(MESSAGES_TYPES.MessageRepository);
    pins = container.get(MESSAGES_TYPES.PinService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
    auth.emails.clear();
  });

  async function pair() {
    // Verified so the HTTP assertion in the last test passes RequireVerifiedEmail.
    const alice = await auth.createUser({ emailVerifiedAt: new Date() });
    const bob = await auth.createUser({ emailVerifiedAt: new Date() });
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

  it('rejects a non-member and a message from another chat', async () => {
    const { alice, chat } = await pair();
    const outsider = await auth.createUser();
    const other = await chats.create({
      type: 'direct',
      title: null,
      directKey: [alice.id, outsider.id].sort().join(':'),
      createdBy: alice.id,
    });
    await members.add(other.id, alice.id);
    await members.add(other.id, outsider.id);
    const foreign = await messages.create({ chatId: other.id, senderId: outsider.id, body: 'x' });

    await expect(pins.pin(outsider.id, chat.id, foreign.id)).rejects.toThrow(
      'You are not a member of this chat',
    );
    await expect(pins.pin(alice.id, chat.id, foreign.id)).rejects.toMatchObject({ status: 404 });
  });

  it('rejects a soft-deleted message and omits it from the list', async () => {
    const { alice, bob, chat } = await pair();
    const message = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'gone' });
    await pins.pin(alice.id, chat.id, message.id);
    await messages.markDeleted(chat.id, message.id, new Date());

    await expect(pins.pin(alice.id, chat.id, message.id)).rejects.toMatchObject({ status: 404 });
    expect(await pins.list(alice.id, chat.id)).toEqual([]);
  });

  it('translates the repository cap signal into a conflict error', async () => {
    const { alice, bob, chat } = await pair();
    for (let index = 0; index < 10; index += 1) {
      const message = await messages.create({
        chatId: chat.id,
        senderId: bob.id,
        body: `message ${index}`,
      });
      await pins.pin(alice.id, chat.id, message.id);
    }
    const extra = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'extra' });

    await expect(pins.pin(alice.id, chat.id, extra.id)).rejects.toBeInstanceOf(ConflictException);
    expect(await pins.list(alice.id, chat.id)).toHaveLength(10);
  });

  it('lists pinned messages newest-first with their full records', async () => {
    const { alice, bob, chat } = await pair();
    const first = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'first' });
    const second = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'second' });
    await pins.pin(alice.id, chat.id, first.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await pins.pin(alice.id, chat.id, second.id);

    const list = await pins.list(alice.id, chat.id);
    expect(list.map((item) => item.message.id)).toEqual([second.id, first.id]);
    expect(list[0]?.pinnedAt).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/messages/pin-service.test.ts`
Expected: FAIL because `MESSAGES_TYPES.PinService` is not bound.

- [ ] **Step 3: Implement the service**

Create `src/modules/messages/logic/pin.service.ts`:

```ts
import { inject, injectable } from 'inversify';
import { ConflictException, NotFoundException } from '@/core/errors/http.error.js';
import type { MessageRecord } from '@/modules/messages/logic/entities/message-record.js';
import type { MessagingPolicy } from '@/modules/messages/logic/messaging-policy.service.js';
import type {
  MessagePinRepository,
  PinRecord,
} from '@/modules/messages/logic/ports/message-pin.repository.js';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';

export interface PinnedMessage {
  readonly message: MessageRecord;
  readonly pinnedAt: Date;
}

/** Owns pin authorization, validation, and ordered listing. */
@injectable()
export class PinService {
  constructor(
    @inject(MESSAGES_TYPES.MessagingPolicy) private readonly policy: MessagingPolicy,
    @inject(MESSAGES_TYPES.MessageRepository) private readonly messages: MessageRepository,
    @inject(MESSAGES_TYPES.MessagePinRepository) private readonly pins: MessagePinRepository,
  ) {}

  async pin(userId: string, chatId: string, messageId: string): Promise<PinRecord> {
    await this.policy.requireMember(chatId, userId);
    await this.requireLiveMessage(chatId, messageId);

    const pin = await this.pins.pin(chatId, userId, messageId);

    if (pin === null) {
      throw new ConflictException('Pin limit reached for this chat');
    }

    return pin;
  }

  async unpin(userId: string, chatId: string, messageId: string): Promise<void> {
    await this.policy.requireMember(chatId, userId);
    await this.pins.unpin(chatId, userId, messageId);
  }

  async list(userId: string, chatId: string): Promise<PinnedMessage[]> {
    await this.policy.requireMember(chatId, userId);
    const records = await this.pins.list(chatId, userId);
    const byId = new Map(
      (await this.messages.listByIds(chatId, records.map((record) => record.messageId))).map(
        (message) => [message.id, message],
      ),
    );

    return records.flatMap((record) => {
      const message = byId.get(record.messageId);

      return message === undefined ? [] : [{ message, pinnedAt: record.pinnedAt }];
    });
  }

  /** Batched pin indicators for a page; called after history validates membership. */
  async listPinnedFor(
    chatId: string,
    viewerId: string,
    messageIds: readonly string[],
  ): Promise<Map<string, Date>> {
    return this.pins.listPinnedFor(chatId, viewerId, messageIds);
  }

  private async requireLiveMessage(chatId: string, messageId: string): Promise<void> {
    const message = await this.messages.findById(chatId, messageId);

    if (message === null || message.deletedAt !== null) {
      throw new NotFoundException('Message not found in this chat');
    }
  }
}
```

- [ ] **Step 4: Bind the service**

In `src/modules/messages/messages.types.ts`, add:

```ts
  PinService: Symbol.for('Messages.PinService'),
```

In `src/modules/messages/messages.container.ts`, import `PinService`, then bind:

```ts
    this.bind<PinService>(MESSAGES_TYPES.PinService).to(PinService).inSingletonScope();
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/integration/messages/pin-service.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/modules/messages tests/integration/messages/pin-service.test.ts
git commit -m "feat(messaging): add pin service with membership and cap checks"
```

---

### Task 4: Caller-specific pinnedAt on message history

**Files:**
- Modify: `src/modules/messages/web/message-presenter.service.ts`
- Modify: `src/modules/messages/web/message.controller.ts`
- Modify: `src/modules/messages/web/dto/message.openapi.ts`
- Modify: `tests/integration/messages/pin-service.test.ts`

**Interfaces:**
- Consumes: `PinService.listPinnedFor` from Task 2 and `MessagePresenter` from existing code.
- Produces: `MessagePresenter.present(message, receipts?, pinnedAtById?)` where `pinnedAtById` is `ReadonlyMap<string, Date>`; message responses include `pinnedAt: string | null`; `messageSchema` includes `pinnedAt`.

- [ ] **Step 1: Write the failing history test**

Append to `tests/integration/messages/pin-service.test.ts` inside the describe, using `app.request` (Supertest) with bearer headers from `AuthFixture`:

```ts
  it('shows pinnedAt only to the user who pinned the message', async () => {
    const { alice, bob, chat } = await pair();
    const aliceToken = await auth.mintTokens(alice);
    const bobToken = await auth.mintTokens(bob);
    const message = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'visible' });
    await pins.pin(alice.id, chat.id, message.id);

    async function pinnedAtFor(headers: Record<string, string>): Promise<string | null> {
      const response = await app.request
        .get(`/api/chats/${chat.id}/messages`)
        .set(headers);
      const data = response.body.data as Array<{ id: string; pinnedAt: string | null }>;
      expect(response.status).toBe(200);
      return data.find((item) => item.id === message.id)?.pinnedAt ?? null;
    }

    expect(await pinnedAtFor(auth.bearerHeader(aliceToken.accessToken))).not.toBeNull();
    expect(await pinnedAtFor(auth.bearerHeader(bobToken.accessToken))).toBeNull();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/messages/pin-service.test.ts -t "shows pinnedAt only"`
Expected: FAIL because `pinnedAt` is absent (the `?? null` returns null for Alice instead of a timestamp).

- [ ] **Step 3: Update the presenter**

In `src/modules/messages/web/message-presenter.service.ts`, change `present` to:

```ts
  async present(
    message: MessageRecord,
    receipts?: ReadReceiptContext,
    pinnedAtById: ReadonlyMap<string, Date> = new Map(),
  ): Promise<Record<string, unknown>> {
```

and add to `base` immediately after `readAt`:

```ts
      pinnedAt: pinnedAtById.get(message.id)?.toISOString() ?? null,
```

No other presenter logic changes; `readAt` stays untouched.

- [ ] **Step 4: Resolve the map once per history request**

In `src/modules/messages/web/message.controller.ts`, inject `PinService`:

```ts
  constructor(
    // ...existing injections...
    @inject(MESSAGES_TYPES.PinService) private readonly pins: PinService,
  ) {}
```

(add the import `import type { PinService } from '@/modules/messages/logic/pin.service.js';`)

Replace the `list` handler's `contextFor`/`Promise.all` region so it calls the pin lookup once:

```ts
    const rows = await this.messages.list(userId, chatId, {
      limit: query.limit + 1,
      beforeId: query.cursor,
    });
    const receipts = await this.receipts.contextFor(chatId, userId);
    const page = rows.slice(0, query.limit);
    const nextCursor = rows.length > query.limit ? (page.at(-1)?.id ?? null) : null;
    const pinnedAtById = await this.pins.listPinnedFor(
      chatId,
      userId,
      page.map((message) => message.id),
    );

    this.response.cursor(
      res,
      await Promise.all(
        page.map((message) => this.presenter.present(message, receipts, pinnedAtById)),
      ),
      nextCursor,
    );
```

Keep the membership-first ordering: call `this.messages.list(...)` before `contextFor` and `listPinnedFor` so a 403 does no extra work.

- [ ] **Step 5: Update the OpenAPI message schema**

In `src/modules/messages/web/dto/message.openapi.ts`, add after `readAt` in `messageSchema`:

```ts
    pinnedAt: z.iso.datetime().nullable(),
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/integration/messages/pin-service.test.ts -t "shows pinnedAt only"`
Expected: PASS (Alice non-null, Bob null).

- [ ] **Step 7: Commit**

```bash
git add src/modules/messages tests/integration/messages/pin-service.test.ts
git commit -m "feat(messaging): expose caller-private pinnedAt on message history"
```

---

### Task 5: Pin/unpin/list endpoints, OpenAPI contracts, README, and HTTP tests

**Files:**
- Create: `src/modules/messages/web/pin.controller.ts`
- Modify: `src/modules/messages/web/routes/messages.router.ts`
- Modify: `src/modules/messages/web/dto/message.openapi.ts`
- Modify: `src/modules/messages/messages.types.ts`
- Modify: `src/modules/messages/messages.container.ts`
- Modify: `README.md`
- Create: `tests/integration/messages/pins.test.ts`

**Interfaces:**
- Consumes: `PinService.pin/unpin/list` from Task 3; `MessagePresenter` and `ReadReceiptService` from Task 4; `ApiResponse` from the root container.
- Produces: `POST`/`DELETE /api/chats/:chatId/messages/:messageId/pin`, `GET /api/chats/:chatId/pins`; contracts `messageContracts.pinMessage`, `unpinMessage`, `listPinned`; symbol `MESSAGES_TYPES.PinController`.

- [ ] **Step 1: Write the failing HTTP tests**

Create `tests/integration/messages/pins.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectError, expectNoContent, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';
import { MessagingApiFixture } from './messaging-api.fixture.js';

interface PinResult {
  messageId: string;
  pinnedAt: string;
}

describe('Pinned messages HTTP API', () => {
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

  async function send(headers: Record<string, string>, chatId: string, body: string): Promise<string> {
    const created = expectSuccess<{ id: string }>(
      await app.request.post(`/api/chats/${chatId}/messages`).set(headers).send({ body }),
      201,
    );
    return created.id;
  }

  function pin(headers: Record<string, string>, chatId: string, messageId: string) {
    return app.request.post(`/api/chats/${chatId}/messages/${messageId}/pin`).set(headers);
  }

  it('pins idempotently, lists newest-first, and unpins to 204', async () => {
    const { alice, bob, chatId } = await pair();
    const first = await send(bob.headers, chatId, 'first');
    const second = await send(bob.headers, chatId, 'second');

    const firstPin = expectSuccess<PinResult>(await pin(alice.headers, chatId, first), 201);
    expect(firstPin.messageId).toBe(first);
    const duplicate = expectSuccess<PinResult>(await pin(alice.headers, chatId, first), 201);
    expect(duplicate.pinnedAt).toBe(firstPin.pinnedAt);
    await pin(alice.headers, chatId, second);

    const listed = expectSuccess<Array<{ id: string; pinnedAt: string | null }>>(
      await app.request.get(`/api/chats/${chatId}/pins`).set(alice.headers),
      200,
    );
    expect(listed.map((message) => message.id)).toEqual([second, first]);
    expect(listed.every((message) => message.pinnedAt !== null)).toBe(true);

    expectNoContent(await app.request.delete(`/api/chats/${chatId}/messages/${first}/pin`).set(alice.headers));
    expectNoContent(await app.request.delete(`/api/chats/${chatId}/messages/${first}/pin`).set(alice.headers));
    const after = expectSuccess<Array<{ id: string }>>(
      await app.request.get(`/api/chats/${chatId}/pins`).set(alice.headers),
      200,
    );
    expect(after.map((message) => message.id)).toEqual([second]);
  });

  it('keeps pins private between participants', async () => {
    const { alice, bob, chatId } = await pair();
    const messageId = await send(alice.headers, chatId, 'mine');
    await pin(alice.headers, chatId, messageId);

    const bobPins = expectSuccess<Array<{ id: string }>>(
      await app.request.get(`/api/chats/${chatId}/pins`).set(bob.headers),
      200,
    );
    expect(bobPins).toEqual([]);
    const bobHistory = expectSuccess<Array<{ id: string; pinnedAt: string | null }>>(
      await app.request.get(`/api/chats/${chatId}/messages`).set(bob.headers),
      200,
    );
    expect(bobHistory.find((message) => message.id === messageId)?.pinnedAt).toBeNull();
  });

  it('rejects the eleventh pin with 409 CONFLICT', async () => {
    const { alice, bob, chatId } = await pair();
    const ids: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      ids.push(await send(bob.headers, chatId, `message ${index}`));
    }
    for (const id of ids.slice(0, 10)) {
      expectSuccess(await pin(alice.headers, chatId, id), 201);
    }
    expectError(await pin(alice.headers, chatId, ids[10] as string), 409, 'CONFLICT');
  });

  it('rejects foreign, deleted, and malformed targets', async () => {
    const { alice, chatId } = await pair();
    const outsider = await fixture.verifiedUser('Charlie');
    const otherChatId = await fixture.openDirectChat(outsider.id, alice.headers);
    const foreignId = await send(outsider.headers, otherChatId, 'foreign');
    const ownId = await send(alice.headers, chatId, 'own');

    expectError(await pin(alice.headers, chatId, foreignId), 404, 'NOT_FOUND');
    expectError(
      await app.request
        .post(`/api/chats/${chatId}/messages/${ownId}/pin`)
        .set(alice.headers)
        .send(),
      404,
      'NOT_FOUND',
    );
    expectError(
      await pin(alice.headers, chatId, '00000000-0000-7000-8000-000000000000'),
      404,
      'NOT_FOUND',
    );
    expectError(
      await pin(alice.headers, chatId, 'not-a-uuid'),
      400,
      'VALIDATION_ERROR',
    );

    expectNoContent(
      await app.request.delete(`/api/chats/${chatId}/messages/${ownId}`).set(alice.headers),
    );
    expectError(await pin(alice.headers, chatId, ownId), 404, 'NOT_FOUND');
  });

  it('enforces auth and membership', async () => {
    const { alice, chatId } = await pair();
    const messageId = await send(alice.headers, chatId, 'guarded');
    const unverified = await fixture.unverifiedUser('Unverified');
    const outsider = await fixture.verifiedUser('Charlie');

    expectError(await pin({}, chatId, messageId), 401, 'UNAUTHORIZED');
    expectError(await pin(unverified.headers, chatId, messageId), 403, 'EMAIL_NOT_VERIFIED');
    expectError(
      await app.request.get(`/api/chats/${chatId}/pins`).set(outsider.headers),
      403,
      'NOT_CHAT_MEMBER',
    );
  });

  it('pins in a secret chat without changing ciphertext', async () => {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    await fixture.registerDevice(alice);
    const bobDevice = await fixture.registerDevice(bob);
    const chatId = await fixture.openSecretChat(bob.id, alice.headers);
    const ciphertext = 'c2VjcmV0LWNpcGhlcnRleHQ';
    const sent = expectSuccess<{ id: string; ciphertext: string }>(
      await app.request
        .post(`/api/chats/${chatId}/secret-messages`)
        .set(alice.headers)
        .send({
          recipientDeviceId: bobDevice.deviceId,
          ciphertext,
          nonce: 'AAAAAAAAAAAAAAAA',
          ephemeralPublicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        }),
      201,
    );

    expectSuccess(await pin(alice.headers, chatId, sent.id), 201);
    const history = expectSuccess<Array<{ id: string; ciphertext: string; pinnedAt: string | null }>>(
      await app.request.get(`/api/chats/${chatId}/messages`).set(alice.headers),
      200,
    );
    const row = history.find((message) => message.id === sent.id);
    expect(row?.ciphertext).toBe(ciphertext);
    expect(row?.pinnedAt).not.toBeNull();
  });
});
```

Note: the deleted-target case uses `DELETE /api/chats/:chatId/messages/:messageId` by Alice on her own message, which is allowed for cloud chats. The nonexistent-uuid case returns 404 because no row matches in that chat.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/messages/pins.test.ts`
Expected: FAIL with 404 for every pin route (routes not registered).

- [ ] **Step 3: Add the contracts**

In `src/modules/messages/web/dto/message.openapi.ts`, add before `markRead`:

```ts
  pinMessage: {
    operationId: 'messages.pinMessage',
    tags: ['Messages'],
    summary: 'Pin a message for the caller',
    description:
      'Adds a private bookmark to a live message in a direct or secret chat. Each user has at most ten pins per chat; an eleventh returns 409 CONFLICT. Pinning again keeps the original timestamp.',
    security: bearerSecurity,
    request: { params: messageParamsSchema },
    responses: {
      201: { description: 'The created pin', schema: pinResponse },
      ...commonErrorResponses,
      409: errorResponse('Pin limit reached'),
    },
  },
  unpinMessage: {
    operationId: 'messages.unpinMessage',
    tags: ['Messages'],
    summary: 'Remove the caller pin from a message',
    description: 'Idempotent: removing a pin that does not exist still returns 204.',
    security: bearerSecurity,
    request: { params: messageParamsSchema },
    responses: {
      204: noContentResponse,
      ...commonErrorResponses,
    },
  },
  listPinned: {
    operationId: 'messages.listPinned',
    tags: ['Messages'],
    summary: 'List the caller pinned messages in a chat',
    description:
      'Returns the caller private bookmarks, newest pin first, as full message views with pinnedAt. Pins belonging to the other participant are never returned.',
    security: bearerSecurity,
    request: { params: chatParamsSchema },
    responses: {
      200: { description: 'The caller pinned messages', schema: messageListResponse },
      ...commonErrorResponses,
    },
  },
```

Add above `export const messageContracts` (immediately after `messageListResponse`):

```ts
export const pinSchema = z
  .object({
    messageId: z.uuid(),
    pinnedAt: z.iso.datetime(),
  })
  .meta({ id: 'MessagePin' });

const pinResponse = successEnvelope(pinSchema, 'MessagePinResponse');
```

- [ ] **Step 4: Add the controller**

Create `src/modules/messages/web/pin.controller.ts`:

```ts
import type { Request, RequestHandler } from 'express';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { UnauthorizedException } from '@/core/errors/http.error.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import type { PinService } from '@/modules/messages/logic/pin.service.js';
import type { ReadReceiptService } from '@/modules/messages/logic/read-receipt.service.js';
import { chatParamsSchema, messageParamsSchema } from '@/modules/messages/web/dto/message.schemas.js';
import type { MessagePresenter } from '@/modules/messages/web/message-presenter.service.js';

/** Request-scoped handlers for per-user message bookmarks. */
@injectable()
export class PinController {
  constructor(
    @inject(MESSAGES_TYPES.PinService) private readonly pins: PinService,
    @inject(MESSAGES_TYPES.ReadReceiptService) private readonly receipts: ReadReceiptService,
    @inject(MESSAGES_TYPES.MessagePresenter) private readonly presenter: MessagePresenter,
    @inject(CORE_TYPES.ApiResponse) private readonly response: ApiResponse,
  ) {}

  pin: RequestHandler = async (req, res) => {
    const { chatId, messageId } = messageParamsSchema.parse(req.params);
    const pin = await this.pins.pin(this.requireUser(req).id, chatId, messageId);

    this.response.created(res, pin);
  };

  unpin: RequestHandler = async (req, res) => {
    const { chatId, messageId } = messageParamsSchema.parse(req.params);
    await this.pins.unpin(this.requireUser(req).id, chatId, messageId);

    this.response.noContent(res);
  };

  list: RequestHandler = async (req, res) => {
    const userId = this.requireUser(req).id;
    const { chatId } = chatParamsSchema.parse(req.params);
    const pinned = await this.pins.list(userId, chatId);
    const receipts = await this.receipts.contextFor(chatId, userId);
    const pinnedAtById = new Map(pinned.map((item) => [item.message.id, item.pinnedAt]));
    const items = await Promise.all(
      pinned.map((item) => this.presenter.present(item.message, receipts, pinnedAtById)),
    );

    this.response.list(res, items);
  };

  private requireUser(req: Request): Express.User {
    if (!(req.auth && req.isAuthenticated())) {
      throw new UnauthorizedException();
    }

    return req.user;
  }
}
```

- [ ] **Step 5: Register the routes**

In `src/modules/messages/web/routes/messages.router.ts`, add the import for `PinController` and insert these routes immediately after `/:chatId/read` (before `/:chatId/secret-messages`):

```ts
    routes.post(
      '/:chatId/messages/:messageId/pin',
      messageContracts.pinMessage,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container.get<PinController>(MESSAGES_TYPES.PinController).pin(req, res, next),
    );

    routes.delete(
      '/:chatId/messages/:messageId/pin',
      messageContracts.unpinMessage,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container.get<PinController>(MESSAGES_TYPES.PinController).unpin(req, res, next),
    );

    routes.get(
      '/:chatId/pins',
      messageContracts.listPinned,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      (req, res, next) =>
        req.container.get<PinController>(MESSAGES_TYPES.PinController).list(req, res, next),
    );
```

- [ ] **Step 6: Bind the controller**

In `src/modules/messages/messages.types.ts`, add:

```ts
  PinController: Symbol.for('Messages.PinController'),
```

In `src/modules/messages/messages.container.ts`, import `PinController` and bind:

```ts
    this.bind<PinController>(MESSAGES_TYPES.PinController).to(PinController);
```

- [ ] **Step 7: Unpin on message delete**

In `src/modules/messages/logic/message.service.ts`, inject the pin repository:

```ts
  @inject(MESSAGES_TYPES.MessagePinRepository) private readonly pins: MessagePinRepository,
```

(add the import `import type { MessagePinRepository } from '@/modules/messages/logic/ports/message-pin.repository.js';`)

In `remove`, after `await this.messages.markDeleted(chatId, messageId, new Date());`, add:

```ts
    await this.pins.removeForMessage(chatId, messageId);
```

- [ ] **Step 8: Update the README**

In `README.md`, add a `POST /api/chats/:chatId/messages/:messageId/pin`, `DELETE /api/chats/:chatId/messages/:messageId/pin`, and `GET /api/chats/:chatId/pins` row to the Messaging route table, then a short `### Pinned messages` section after `### Read receipts` stating: pins are per-user and private; both direct cloud and secret chats are supported; a user can pin at most 10 messages per chat and an 11th returns `409 CONFLICT`; a repeated pin keeps its original timestamp; unpin is idempotent and returns `204`; `GET /pins` returns the caller's pins newest-first as full message views; message history and pin lists include `pinnedAt` for the caller only; soft-deleting a message removes its pins; secret-chat ciphertext is never touched.

- [ ] **Step 9: Run the HTTP tests**

Run: `npx vitest run tests/integration/messages/pins.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 10: Commit**

```bash
git add src/modules/messages README.md tests/integration/messages/pins.test.ts
git commit -m "feat(messaging): add private pin and unpin endpoints with docs"
```

---

### Task 6: Live HTTP smoke and cleanup (executed by the controller at handoff)

**Files:**
- No repository changes; evidence written to `/tmp/opencode/pins-smoke-report.md`.

**Interfaces:**
- Consumes: the running API from `npm run dev` on `http://127.0.0.1:4000`, with PostgreSQL, Redis, and MinIO up.
- Produces: pass/fail evidence for every success and error path, and a clean database.

- [ ] **Step 1: Start the API and register two verified users over HTTP**

Start `npm run dev` in the background, record its PID, and wait for `GET /health/live` to return 200. Register two users with `POST /api/auth/register`, mark them verified with a controlled DB update (`UPDATE users SET email_verified_at = now() WHERE email LIKE 'pins-smoke-%@example.test'`), and re-authenticate for fresh tokens. Include an unverified caller and a non-member caller for error paths.

- [ ] **Step 2: Exercise success paths**

- Open a direct cloud chat; send two messages from user B.
- `POST /pin` as A → 201 with `messageId`/`pinnedAt`; repeat → 201 with the same `pinnedAt`.
- `GET /pins` as A → both messages, newest pin first; as B → `[]`.
- `GET /messages` as A → `pinnedAt` non-null on the pinned message, null for B.
- `DELETE /pin` twice → `204` both times; `GET /pins` as A → empty.
- Pin an 11th message after ten pins → `409 CONFLICT`.
- Open a secret chat with registered E2EE devices, send one secret message, pin it as A, and confirm `ciphertext` is unchanged and `pinnedAt` is non-null for A.

- [ ] **Step 3: Exercise error paths**

- Foreign-chat `messageId` → `404 NOT_FOUND`; nonexistent uuid → `404 NOT_FOUND`; malformed uuid → `400 VALIDATION_ERROR`; no bearer → `401 UNAUTHORIZED`; unverified → `403 EMAIL_NOT_VERIFIED`; non-member → `403 NOT_CHAT_MEMBER`; soft-deleted message → `404 NOT_FOUND`.

- [ ] **Step 4: Clean up and report**

Delete all smoke messages via the API where possible, then delete smoke chats and users in FK-safe order. Confirm zero smoke users/chats/messages/pins remain. Stop the API and confirm port 4000 is closed. Leave PostgreSQL/Redis/MinIO running. Write the pass/fail table and cleanup evidence to `/tmp/opencode/pins-smoke-report.md`.

- [ ] **Step 5: Final verification gate**

With ClamAV started under the `scan` profile, run `npm run verify && npm run db:check`; stop ClamAV afterwards. Expected: green verification (all suites) and `Everything's fine 🐶🔥`.
