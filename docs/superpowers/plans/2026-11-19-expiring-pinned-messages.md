# Expiring Pinned Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each private message pin carry a caller-chosen duration (60..604800 seconds), hide elapsed pins immediately from lists, indicators, and the cap count, and physically delete elapsed rows with a BullMQ repeatable job.

**Architecture:** Add `expires_at` to `message_pins` with a backfilled migration. All pin reads and the cap count filter `expires_at > now()`; `pin()` receives a server-computed expiry and keeps its `FOR UPDATE` membership lock. A `PinCleanupWorker` hosted by the messages module runs a BullMQ repeatable job that batch-deletes elapsed rows. The HTTP layer gains a required `durationSeconds` body and exposes `expiresAt` / `pinExpiresAt`.

**Tech Stack:** Node 24, TypeScript 7.0.2, ESM (`@/` aliases, explicit `.js`), Express 5, Inversify 8 child containers, Drizzle ORM + PostgreSQL 18, Zod, BullMQ 6.7.2 on the existing node-redis client, Vitest + Supertest, Biome.

**Spec:** `docs/superpowers/specs/2026-11-19-pinned-message-expiry-design.md`

## Global Constraints

- Duration bounds are exactly `60..604800` seconds; required integer; no default and no env config for bounds.
- `expiresAt` is computed on the server from `Date.now()`; clients never send an absolute timestamp.
- Reads and the cap count must filter `expires_at > now()`; `PIN_LIMIT` stays at 10.
- Active re-pin is idempotent with original `pinnedAt`/`expiresAt`; expired re-pin creates a fresh pin.
- `message_pins` must still have no FK to the partitioned `messages` table.
- Reuse existing error codes only: `400 VALIDATION_ERROR`, `401 UNAUTHORIZED`, `403 NOT_CHAT_MEMBER`, `403 EMAIL_NOT_VERIFIED`, `404 NOT_FOUND`, `409 CONFLICT`. No new codes, no `ErrorMapper` changes.
- All JSON goes through `ApiResponse`; controllers never call `res.json`.
- Domain/data layers contain no Express types or HTTP status codes; repositories implement ports and services depend on ports.
- Config is read only through `EnvironmentReader` in `AppConfig`; no other file reads `process.env`.
- No new dependencies; no commits containing `.env`, secrets, or the gitignored plan workspace.
- Biome: single quotes, semicolons, trailing commas, 2-space indentation, 100-character lines, organized imports. Prefer `unknown` over `any`.
- Every relative ESM import uses an explicit `.js` extension; use `@/...` aliases.
- Definition of done: `npm run verify` and `npm run db:check` pass; live HTTP smoke covers success + error paths; temporary users removed; API and ClamAV stopped; Postgres/Redis/MinIO left running.

## Review Focus

- **Elapsed pin still visible or blocking the cap** → Task 2 repository tests `expired pin vanishes from list/listPinnedFor and frees a cap slot`; Task 3 HTTP test `hides elapsed pins and frees a cap slot`.
- **Re-pin of active vs expired pin** → Task 2 repository tests `active re-pin keeps original timestamps` and `expired re-pin starts a fresh pin`.
- **Invalid duration input (missing, non-integer, out of range)** → Task 3 HTTP test `rejects invalid durationSeconds with 400 VALIDATION_ERROR`.
- **Cross-user expiry leak** → Task 3 HTTP test `exposes pinExpiresAt only to the pinning user`; Bob's history and pins stay null.
- **Cleanup deleting active rows or missing elapsed rows** → Task 4 worker test `deletes only elapsed rows in bounded batches`.

---

### Task 1: Schema, migration, mapper, and repository port

**Files:**
- Modify: `src/core/database/schema/messaging.schema.ts:95-118`
- Create: `drizzle/0016_<generated>.sql` (name from `npm run db:generate`) and its `drizzle/meta/0016_snapshot.json`, updated `drizzle/meta/_journal.json`
- Modify: `src/modules/messages/data/message-pin.mapper.ts`
- Modify: `src/modules/messages/logic/ports/message-pin.repository.ts`
- Test: `tests/integration/messages/messaging-schema.test.ts:211-276`

**Interfaces:**
- Consumes: existing `messagePins` table, `pinSelection`, `PinRecord`.
- Produces: `messagePins.expiresAt` column and `message_pins_expires_at_index`; `PinRecord.expiresAt: Date`; `PinIndicators { pinnedAt: Date; expiresAt: Date }`; new port signatures `pin(chatId, userId, messageId, expiresAt: Date)`, `listPinnedFor(...): Promise<Map<string, PinIndicators>>`, `deleteExpired(now: Date, limit: number): Promise<number>`.

- [ ] **Step 1: Write the failing schema test**

In `tests/integration/messages/messaging-schema.test.ts`, change the expected column list (line 216) to include the new column and add the index assertion. Add `expires_at` to the existing pin inserts (the two statements at lines 259-268).

```ts
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'chat_id',
      'message_id',
      'user_id',
      'pinned_at',
      'expires_at',
    ]);
```

```ts
    const indexes = await app.pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'message_pins' ORDER BY indexname`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toContain('message_pins_expires_at_index');
```

Replace the two raw inserts with a version that supplies the required expiry:

```ts
    await app.pool.query(
      `INSERT INTO message_pins (chat_id, message_id, user_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [chatId, messageId, first.id],
    );
    await expect(
      app.pool.query(
        `INSERT INTO message_pins (chat_id, message_id, user_id, expires_at)
         VALUES ($1, $2, $3, now() + interval '1 hour')`,
        [chatId, messageId, first.id],
      ),
    ).rejects.toThrow(/message_pins_pkey/);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/messages/messaging-schema.test.ts 2>&1 | tail -30`
Expected: FAIL — `expires_at` is not a column (the migration has not been created/applied yet).

- [ ] **Step 3: Update the Drizzle schema**

In `src/core/database/schema/messaging.schema.ts`, add the column after `pinnedAt` and the index after the existing one:

```ts
    pinnedAt: timestamp('pinned_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.chatId, table.userId, table.messageId],
      name: 'message_pins_pkey',
    }),
    index('message_pins_chat_user_pinned_at_index').on(
      table.chatId,
      table.userId,
      table.pinnedAt.desc(),
    ),
    index('message_pins_expires_at_index').on(table.expiresAt),
  ],
);
```

- [ ] **Step 4: Generate and adjust migration 0016**

Run: `npm run db:generate`
Then open the generated `drizzle/0016_*.sql`. Replace its `ADD COLUMN ... NOT NULL` statement with an additive backfill sequence, keeping the exact generated column type expression and index name. Expected final SQL shape:

```sql
ALTER TABLE "message_pins" ADD COLUMN "expires_at" timestamp with time zone;
UPDATE "message_pins" SET "expires_at" = now() + interval '1 day';
ALTER TABLE "message_pins" ALTER COLUMN "expires_at" SET NOT NULL;
CREATE INDEX "message_pins_expires_at_index" ON "message_pins" ("expires_at");
```

The backfill gives every pre-existing pin one more day of life. Do not edit any already-applied migration.

- [ ] **Step 5: Apply the migration and run schema checks**

Run: `npm run db:migrate && npm run db:check`
Expected: migration applies; `Everything's fine 🐶🔥`.

- [ ] **Step 6: Update the mapper and port**

Replace `src/modules/messages/data/message-pin.mapper.ts` with:

```ts
import type { InferSelectModel } from 'drizzle-orm';
import { messagePins } from '@/core/database/schema/index.js';
import type { PinRecord } from '@/modules/messages/logic/ports/message-pin.repository.js';

/** Explicit column selection for the `message_pins` table. */
export const pinSelection = {
  messageId: messagePins.messageId,
  pinnedAt: messagePins.pinnedAt,
  expiresAt: messagePins.expiresAt,
} as const;

export type PinRow = Pick<InferSelectModel<typeof messagePins>, keyof typeof pinSelection>;

export class MessagePinMapper {
  toRecord(row: PinRow): PinRecord {
    return { messageId: row.messageId, pinnedAt: row.pinnedAt, expiresAt: row.expiresAt };
  }
}
```

Replace `src/modules/messages/logic/ports/message-pin.repository.ts` with:

```ts
export interface PinRecord {
  readonly messageId: string;
  readonly pinnedAt: Date;
  readonly expiresAt: Date;
}

/** Caller-specific indicator for one message in a page of history. */
export interface PinIndicators {
  readonly pinnedAt: Date;
  readonly expiresAt: Date;
}

/** Per-user, private message bookmarks. Every method is scoped by chat and user. */
export interface MessagePinRepository {
  /** Returns null when the caller already has ten active pins in this chat. */
  pin(
    chatId: string,
    userId: string,
    messageId: string,
    expiresAt: Date,
  ): Promise<PinRecord | null>;

  /** True when a pin was removed, false when none existed. */
  unpin(chatId: string, userId: string, messageId: string): Promise<boolean>;

  /** Caller's active pins in this chat, newest pin first. */
  list(chatId: string, userId: string): Promise<PinRecord[]>;

  /** Batched active-indicator lookup for one page of message ids. */
  listPinnedFor(
    chatId: string,
    userId: string,
    messageIds: readonly string[],
  ): Promise<Map<string, PinIndicators>>;

  /** Deletes at most `limit` elapsed rows; returns the deleted count. */
  deleteExpired(now: Date, limit: number): Promise<number>;

  /** Removes every user's pin of one message. */
  removeForMessage(chatId: string, messageId: string): Promise<void>;
}
```

- [ ] **Step 7: Run typecheck and the schema test**

Run: `npm run typecheck 2>&1 | tail -20; npx vitest run tests/integration/messages/messaging-schema.test.ts 2>&1 | tail -12`
Expected: typecheck fails only where callers still pass three arguments to `pins.pin` (fixed in Task 2); the schema test passes.

- [ ] **Step 8: Commit**

```bash
git add src/core/database/schema/messaging.schema.ts drizzle src/modules/messages/data/message-pin.mapper.ts src/modules/messages/logic/ports/message-pin.repository.ts tests/integration/messages/messaging-schema.test.ts
git commit -m "feat(messaging): add expiry column to message pins"
```

---

### Task 2: Repository expiry behavior

**Files:**
- Modify: `src/modules/messages/data/postgres-message-pin.repository.ts`
- Test: `tests/integration/messages/messaging-repositories.test.ts`

**Interfaces:**
- Consumes: `pinSelection`, `PinRecord`, `PinIndicators`, `messagePins`, `chatMembers`, `PIN_LIMIT = 10`.
- Produces: `PostgresMessagePinRepository.pin(..., expiresAt)`, `deleteExpired(now, limit)`, and expiry-filtered `list`/`listPinnedFor`.

- [ ] **Step 1: Write failing repository tests**

Append these tests inside the existing `describe` in `tests/integration/messages/messaging-repositories.test.ts`. They reuse the existing `auth`, `chats`, `members`, `messages`, `pins`, and `app` fixtures. Add a helper near the top of the describe:

```ts
  async function expirePin(chatId: string, userId: string, messageId: string): Promise<void> {
    await app.pool.query(
      `UPDATE message_pins SET expires_at = now() - interval '1 second'
       WHERE chat_id = $1 AND user_id = $2 AND message_id = $3`,
      [chatId, userId, messageId],
    );
  }
```

Update **all seven** existing `pins.pin(chat.id, ...)` calls in the pin-related tests (lines 440, 450, 481, 485, 486, 507 and 508) to pass a fourth argument `new Date(Date.now() + 3_600_000)`. Change `expect(map.get(message.id)?.toISOString()).toBe(first?.pinnedAt.toISOString());` to `expect(map.get(message.id)?.pinnedAt.toISOString()).toBe(first?.pinnedAt.toISOString());` because the map now returns `{ pinnedAt, expiresAt }`, and add `expect(map.get(message.id)?.expiresAt).toBeInstanceOf(Date);`.

Add these four tests:

```ts
  it('hides an expired pin from list and listPinnedFor', async () => {
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
    const message = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'short' });

    await pins.pin(chat.id, alice.id, message.id, new Date(Date.now() + 3_600_000));
    await expirePin(chat.id, alice.id, message.id);

    expect(await pins.list(chat.id, alice.id)).toEqual([]);
    expect(await pins.listPinnedFor(chat.id, alice.id, [message.id])).toEqual(new Map());
  });

  it('frees a cap slot when a pin expires', async () => {
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
    for (const id of ids.slice(0, 10)) {
      expect(
        await pins.pin(chat.id, alice.id, id, new Date(Date.now() + 3_600_000)),
      ).not.toBeNull();
    }
    expect(await pins.pin(chat.id, alice.id, ids[10] as string, new Date(Date.now() + 3_600_000))).toBeNull();

    await expirePin(chat.id, alice.id, ids[0] as string);
    const replacement = await pins.pin(
      chat.id,
      alice.id,
      ids[10] as string,
      new Date(Date.now() + 3_600_000),
    );
    expect(replacement).not.toBeNull();
    expect(await pins.list(chat.id, alice.id)).toHaveLength(10);
  });

  it('keeps an active re-pin idempotent but replaces an expired one', async () => {
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
    const message = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'repeat' });

    const original = await pins.pin(chat.id, alice.id, message.id, new Date(Date.now() + 60_000));
    const duplicate = await pins.pin(
      chat.id,
      alice.id,
      message.id,
      new Date(Date.now() + 604800_000),
    );
    expect(duplicate?.pinnedAt.toISOString()).toBe(original?.pinnedAt.toISOString());
    expect(duplicate?.expiresAt.toISOString()).toBe(original?.expiresAt.toISOString());

    await expirePin(chat.id, alice.id, message.id);
    const freshExpiresAt = new Date(Date.now() + 604800_000);
    const refreshed = await pins.pin(chat.id, alice.id, message.id, freshExpiresAt);
    expect(refreshed?.expiresAt.toISOString()).toBe(freshExpiresAt.toISOString());
    expect(refreshed?.pinnedAt.getTime()).toBeGreaterThan(original?.pinnedAt.getTime() ?? 0);
  });

  it('deletes only elapsed rows in bounded batches', async () => {
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
    const expired = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'expired' });
    const active = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'active' });

    await pins.pin(chat.id, alice.id, expired.id, new Date(Date.now() + 3_600_000));
    await pins.pin(chat.id, alice.id, active.id, new Date(Date.now() + 3_600_000));
    await expirePin(chat.id, alice.id, expired.id);

    expect(await pins.deleteExpired(new Date(), 1)).toBe(1);
    expect(await pins.deleteExpired(new Date(), 1)).toBe(0);
    expect((await pins.list(chat.id, alice.id)).map((pin) => pin.messageId)).toEqual([active.id]);
  });
```

- [ ] **Step 2: Run the repository tests to verify they fail**

Run: `npx vitest run tests/integration/messages/messaging-repositories.test.ts 2>&1 | tail -35`
Expected: FAIL — `pins.pin` takes three arguments and `deleteExpired` does not exist.

- [ ] **Step 3: Implement the repository**

Replace `src/modules/messages/data/postgres-message-pin.repository.ts` with the following. It keeps the membership `FOR UPDATE` lock, handles active/expired duplicates, counts only active pins, filters all reads, and adds a `SKIP LOCKED` batch delete.

```ts
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { AppDatabase } from '@/core/database/database.provider.js';
import { chatMembers, messagePins } from '@/core/database/schema/index.js';
import { PersistenceException } from '@/core/errors/repository.error.js';
import { MessagePinMapper, pinSelection } from '@/modules/messages/data/message-pin.mapper.js';
import type {
  MessagePinRepository,
  PinIndicators,
  PinRecord,
} from '@/modules/messages/logic/ports/message-pin.repository.js';

/** Ten active bookmarks per chat and user; the 11th pin is rejected. */
const PIN_LIMIT = 10;

@injectable()
export class PostgresMessagePinRepository implements MessagePinRepository {
  private readonly mapper = new MessagePinMapper();

  constructor(@inject(CORE_TYPES.Db) private readonly db: AppDatabase) {}

  async pin(
    chatId: string,
    userId: string,
    messageId: string,
    expiresAt: Date,
  ): Promise<PinRecord | null> {
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
        const current = existing[0];

        if (current && current.expiresAt > new Date()) {
          return this.mapper.toRecord(current);
        }

        if (current) {
          await tx
            .delete(messagePins)
            .where(
              and(
                eq(messagePins.chatId, chatId),
                eq(messagePins.userId, userId),
                eq(messagePins.messageId, messageId),
              ),
            );
        }

        const counted = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(messagePins)
          .where(
            and(
              eq(messagePins.chatId, chatId),
              eq(messagePins.userId, userId),
              gt(messagePins.expiresAt, new Date()),
            ),
          );

        if ((counted[0]?.count ?? 0) >= PIN_LIMIT) {
          return null;
        }

        const inserted = await tx
          .insert(messagePins)
          .values({ chatId, userId, messageId, expiresAt })
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
        .where(
          and(
            eq(messagePins.chatId, chatId),
            eq(messagePins.userId, userId),
            gt(messagePins.expiresAt, new Date()),
          ),
        )
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
  ): Promise<Map<string, PinIndicators>> {
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
            gt(messagePins.expiresAt, new Date()),
            inArray(messagePins.messageId, [...messageIds]),
          ),
        );

      return new Map(
        rows.map((row) => [
          row.messageId,
          { pinnedAt: row.pinnedAt, expiresAt: row.expiresAt } satisfies PinIndicators,
        ]),
      );
    } catch (error) {
      throw new PersistenceException('Failed to look up pinned messages', { cause: error });
    }
  }

  async deleteExpired(now: Date, limit: number): Promise<number> {
    try {
      const result = await this.db.execute<{ message_id: string }>(sql`
        WITH candidates AS (
          SELECT chat_id, user_id, message_id
          FROM message_pins
          WHERE expires_at <= ${now}
          ORDER BY expires_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM message_pins p
        USING candidates c
        WHERE p.chat_id = c.chat_id
          AND p.user_id = c.user_id
          AND p.message_id = c.message_id
        RETURNING p.message_id
      `);

      return result.rowCount ?? 0;
    } catch (error) {
      throw new PersistenceException('Failed to delete expired message pins', { cause: error });
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

- [ ] **Step 4: Run typecheck and the repository tests**

Run: `npm run typecheck 2>&1 | tail -20; npx vitest run tests/integration/messages/messaging-repositories.test.ts 2>&1 | tail -15`
Expected: typecheck still fails in `pin.service.ts` (fixed in Task 3); all repository tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/modules/messages/data/postgres-message-pin.repository.ts tests/integration/messages/messaging-repositories.test.ts
git commit -m "feat(messaging): expire pins on read and free cap slots"
```

---

### Task 3: Duration validation, service, presenter, and HTTP contracts

**Files:**
- Modify: `src/modules/messages/web/dto/message.schemas.ts`
- Modify: `src/modules/messages/web/dto/message.openapi.ts`
- Modify: `src/modules/messages/logic/pin.service.ts`
- Modify: `src/modules/messages/web/pin.controller.ts`
- Modify: `src/modules/messages/web/message-presenter.service.ts`
- Test: `tests/integration/messages/pin-service.test.ts`
- Test: `tests/integration/messages/pins.test.ts`

**Interfaces:**
- Consumes: `PinRecord.expiresAt`, `PinIndicators`, `pinSelection`.
- Produces: `pinMessageSchema` with `durationSeconds`; `PinService.pin(userId, chatId, messageId, durationSeconds)`, `PinnedMessage { message, pinnedAt, expiresAt }`, `listPinnedFor(): Promise<Map<string, PinIndicators>>`; presenter third argument `ReadonlyMap<string, PinIndicators>` emitting `pinnedAt` and `pinExpiresAt`; `pinSchema` with `expiresAt` and `messageSchema` with `pinExpiresAt`.

- [ ] **Step 1: Write failing service tests**

In `tests/integration/messages/pin-service.test.ts`, update every `pins.pin(...)` call to pass `3_600` as a fourth argument. Then append these tests inside the describe:

```ts
  it('returns a server-computed expiry and keeps active re-pins idempotent', async () => {
    const { alice, bob, chat } = await pair();
    const message = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'timed' });

    const before = Date.now();
    const first = await pins.pin(alice.id, chat.id, message.id, 60);
    const after = Date.now();

    expect(first.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect(first.expiresAt.getTime()).toBeLessThanOrEqual(after + 60_000);

    const duplicate = await pins.pin(alice.id, chat.id, message.id, 604800);
    expect(duplicate.pinnedAt.toISOString()).toBe(first.pinnedAt.toISOString());
    expect(duplicate.expiresAt.toISOString()).toBe(first.expiresAt.toISOString());
  });

  it('omits elapsed pins from list after the row is aged out', async () => {
    const { alice, bob, chat } = await pair();
    const message = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'aged' });
    await pins.pin(alice.id, chat.id, message.id, 60);
    await app.pool.query(
      `UPDATE message_pins SET expires_at = now() - interval '1 second'
       WHERE chat_id = $1 AND user_id = $2 AND message_id = $3`,
      [chat.id, alice.id, message.id],
    );

    const list = await pins.list(alice.id, chat.id);
    expect(list).toEqual([]);
    expect(list[0]?.expiresAt).toBeUndefined();
  });
```

- [ ] **Step 2: Write failing HTTP tests**

In `tests/integration/messages/pins.test.ts`, change `PinResult` and the `pin` helper:

```ts
interface PinResult {
  messageId: string;
  pinnedAt: string;
  expiresAt: string;
}
```

```ts
  function pin(headers: Record<string, string>, chatId: string, messageId: string, duration = 3600) {
    return app.request
      .post(`/api/chats/${chatId}/messages/${messageId}/pin`)
      .set(headers)
      .send({ durationSeconds: duration });
  }
```

Inside the first test, add expiry assertions:

```ts
    expect(new Date(firstPin.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const duplicate = expectSuccess<PinResult>(await pin(alice.headers, chatId, first), 201);
    expect(duplicate.pinnedAt).toBe(firstPin.pinnedAt);
    expect(duplicate.expiresAt).toBe(firstPin.expiresAt);
```

Add these tests:

```ts
  it('rejects invalid durationSeconds with 400 VALIDATION_ERROR', async () => {
    const { alice, bob, chatId } = await pair();
    const messageId = await send(bob.headers, chatId, 'guarded');

    expectError(
      await app.request
        .post(`/api/chats/${chatId}/messages/${messageId}/pin`)
        .set(alice.headers)
        .send({}),
      400,
      'VALIDATION_ERROR',
    );
    expectError(await pin(alice.headers, chatId, messageId, 59), 400, 'VALIDATION_ERROR');
    expectError(await pin(alice.headers, chatId, messageId, 604801), 400, 'VALIDATION_ERROR');
    expectError(await pin(alice.headers, chatId, messageId, 60.5), 400, 'VALIDATION_ERROR');
  });

  it('exposes pinExpiresAt only to the pinning user', async () => {
    const { alice, bob, chatId } = await pair();
    const messageId = await send(bob.headers, chatId, 'private expiry');
    await pin(alice.headers, chatId, messageId, 604800);

    const alicePins = expectSuccess<Array<{ id: string; pinExpiresAt: string | null }>>(
      await app.request.get(`/api/chats/${chatId}/pins`).set(alice.headers),
      200,
    );
    expect(alicePins[0]?.pinExpiresAt).not.toBeNull();

    const bobPins = expectSuccess<Array<{ id: string; pinExpiresAt: string | null }>>(
      await app.request.get(`/api/chats/${chatId}/pins`).set(bob.headers),
      200,
    );
    expect(bobPins).toEqual([]);

    const bobHistory = expectSuccess<
      Array<{ id: string; pinnedAt: string | null; pinExpiresAt: string | null }>
    >(await app.request.get(`/api/chats/${chatId}/messages`).set(bob.headers), 200);
    const bobRow = bobHistory.find((message) => message.id === messageId);
    expect(bobRow?.pinnedAt).toBeNull();
    expect(bobRow?.pinExpiresAt).toBeNull();
  });

  it('hides elapsed pins and frees a cap slot', async () => {
    const { alice, bob, chatId } = await pair();
    const ids: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      ids.push(await send(bob.headers, chatId, `expiring ${index}`));
    }
    for (const id of ids.slice(0, 10)) {
      expectSuccess(await pin(alice.headers, chatId, id), 201);
    }
    expectError(await pin(alice.headers, chatId, ids[10] as string), 409, 'CONFLICT');

    await app.pool.query(
      `UPDATE message_pins SET expires_at = now() - interval '1 second'
       WHERE chat_id = $1 AND user_id = $2 AND message_id = $3`,
      [chatId, alice.id, ids[0]],
    );

    const after = expectSuccess<Array<{ id: string }>>(
      await app.request.get(`/api/chats/${chatId}/pins`).set(alice.headers),
      200,
    );
    expect(after.map((message) => message.id)).not.toContain(ids[0]);
    expectSuccess(await pin(alice.headers, chatId, ids[10] as string), 201);
  });
```

In the secret-chat test, extend the response type to include `pinExpiresAt` and assert it is non-null for Alice. Keep the existing `ciphertext` assertion.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/messages/pins.test.ts tests/integration/messages/pin-service.test.ts 2>&1 | tail -35`
Expected: FAIL — no body validation, no `expiresAt`/`pinExpiresAt`, and `PinService.pin` takes three arguments.

- [ ] **Step 4: Add the Zod duration schema**

In `src/modules/messages/web/dto/message.schemas.ts`, add after `messageParamsSchema`:

```ts
/** Body for creating a time-bounded pin: 60 seconds to 7 days. */
export const pinMessageSchema = z.object({
  durationSeconds: z.number().int().min(60).max(604800),
});

export type PinMessageSchema = z.infer<typeof pinMessageSchema>;
```

- [ ] **Step 5: Update the service**

Replace `src/modules/messages/logic/pin.service.ts` with:

```ts
import { inject, injectable } from 'inversify';
import { ConflictException, NotFoundException } from '@/core/errors/http.error.js';
import type { MessageRecord } from '@/modules/messages/logic/entities/message-record.js';
import type { MessagingPolicy } from '@/modules/messages/logic/messaging-policy.service.js';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import type {
  MessagePinRepository,
  PinIndicators,
  PinRecord,
} from '@/modules/messages/logic/ports/message-pin.repository.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';

export interface PinnedMessage {
  readonly message: MessageRecord;
  readonly pinnedAt: Date;
  readonly expiresAt: Date;
}

/** Owns pin authorization, validation, and ordered listing. */
@injectable()
export class PinService {
  constructor(
    @inject(MESSAGES_TYPES.MessagingPolicy) private readonly policy: MessagingPolicy,
    @inject(MESSAGES_TYPES.MessageRepository) private readonly messages: MessageRepository,
    @inject(MESSAGES_TYPES.MessagePinRepository) private readonly pins: MessagePinRepository,
  ) {}

  async pin(
    userId: string,
    chatId: string,
    messageId: string,
    durationSeconds: number,
  ): Promise<PinRecord> {
    await this.policy.requireMember(chatId, userId);
    await this.requireLiveMessage(chatId, messageId);

    const expiresAt = new Date(Date.now() + durationSeconds * 1_000);
    const pin = await this.pins.pin(chatId, userId, messageId, expiresAt);

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
      (
        await this.messages.listByIds(
          chatId,
          records.map((record) => record.messageId),
        )
      ).map((message) => [message.id, message]),
    );

    return records.flatMap((record) => {
      const message = byId.get(record.messageId);

      return message === undefined
        ? []
        : [{ message, pinnedAt: record.pinnedAt, expiresAt: record.expiresAt }];
    });
  }

  /** Batched pin indicators for a page; called after history validates membership. */
  listPinnedFor(
    chatId: string,
    viewerId: string,
    messageIds: readonly string[],
  ): Promise<Map<string, PinIndicators>> {
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

- [ ] **Step 6: Update the controller**

In `src/modules/messages/web/pin.controller.ts`, import `pinMessageSchema` and use it:

```ts
import {
  chatParamsSchema,
  messageParamsSchema,
  pinMessageSchema,
} from '@/modules/messages/web/dto/message.schemas.js';
```

```ts
  pin: RequestHandler = async (req, res) => {
    const { chatId, messageId } = messageParamsSchema.parse(req.params);
    const { durationSeconds } = pinMessageSchema.parse(req.body ?? {});
    const pin = await this.pins.pin(
      this.requireUser(req).id,
      chatId,
      messageId,
      durationSeconds,
    );

    this.response.created(res, pin);
  };
```

In `list`, replace the indicator map construction with the `expiresAt`-carrying shape:

```ts
    const pinnedBy = new Map(pinned.map((item) => [item.message.id, {
      pinnedAt: item.pinnedAt,
      expiresAt: item.expiresAt,
    }]));
    const items = await Promise.all(
      pinned.map((item) => this.presenter.present(item.message, receipts, pinnedBy)),
    );
```

- [ ] **Step 7: Update the presenter**

In `src/modules/messages/web/message-presenter.service.ts`, import `PinIndicators` and change the third parameter plus the base output:

```ts
import type { PinIndicators } from '@/modules/messages/logic/ports/message-pin.repository.js';
```

```ts
    pinnedAtById: ReadonlyMap<string, PinIndicators> = new Map(),
```

```ts
      pinnedAt: pinnedAtById.get(message.id)?.pinnedAt.toISOString() ?? null,
      pinExpiresAt: pinnedAtById.get(message.id)?.expiresAt.toISOString() ?? null,
```

`MessageController.list` already passes `this.pins.listPinnedFor(...)` straight through, so it needs no source change; its inferred type now matches. `PinController.list` is updated in Step 6.

- [ ] **Step 8: Update the OpenAPI contracts**

In `src/modules/messages/web/dto/message.openapi.ts`, import `pinMessageSchema` from `message.schemas.js`. Change `messageSchema` (around line 74) to add:

```ts
    pinnedAt: z.iso.datetime().nullable(),
    pinExpiresAt: z.iso.datetime().nullable(),
```

Change `pinSchema` (around line 106) to:

```ts
export const pinSchema = z
  .object({
    messageId: z.uuid(),
    pinnedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'MessagePin' });
```

Change the `pinMessage` contract request and description:

```ts
    description:
      'Adds a private, time-bounded bookmark to a live message in a direct or secret chat. durationSeconds must be 60..604800. Each user has at most ten active pins per chat; an eleventh returns 409 CONFLICT. Pinning again keeps the original timestamps.',
    request: { params: messageParamsSchema, body: pinMessageSchema },
```

Update `listPinned`'s description to mention `pinExpiresAt`.

- [ ] **Step 9: Run typecheck, lint, and the tests**

Run: `npm run typecheck 2>&1 | tail -20 && npm run lint 2>&1 | tail -10 && npx vitest run tests/integration/messages/pins.test.ts tests/integration/messages/pin-service.test.ts 2>&1 | tail -15`
Expected: typecheck and lint clean; all pin HTTP and service tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/modules/messages tests/integration/messages/pins.test.ts tests/integration/messages/pin-service.test.ts
git commit -m "feat(messaging): validate pin duration and expose expiry"
```

---

### Task 4: Config and BullMQ cleanup worker

**Files:**
- Modify: `src/core/config/app.config.ts`
- Modify: `.env.example`
- Create: `src/modules/messages/logic/pin-cleanup.worker.ts`
- Modify: `src/modules/messages/messages.types.ts`
- Modify: `src/modules/messages/messages.container.ts`
- Modify: `src/modules/messages/messages.module.ts`
- Test: `tests/integration/messages/pin-cleanup.worker.test.ts`

**Interfaces:**
- Consumes: `MessagePinRepository.deleteExpired(now, limit)`, `CORE_TYPES.RedisClient`, `CORE_TYPES.Config`, `CORE_TYPES.Logger`.
- Produces: `AppConfig.pinCleanup.intervalMinutes`; `PinCleanupWorker.start()`, `process()`, `close()`; symbol `MESSAGES_TYPES.PinCleanupWorker`.

- [ ] **Step 1: Write the failing worker test**

Create `tests/integration/messages/pin-cleanup.worker.test.ts`:

```ts
import { Container } from 'inversify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PinCleanupWorker } from '@/modules/messages/logic/pin-cleanup.worker.js';
import type { ChatRepository } from '@/modules/messages/logic/ports/chat.repository.js';
import type { ChatMemberRepository } from '@/modules/messages/logic/ports/chat-member.repository.js';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import type { MessagePinRepository } from '@/modules/messages/logic/ports/message-pin.repository.js';
import { MessagesContainer } from '@/modules/messages/messages.container.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { TestApp } from '../../helpers/test-app.js';

describe('PinCleanupWorker', () => {
  let app: TestApp;
  let auth: AuthFixture;
  let chats: ChatRepository;
  let members: ChatMemberRepository;
  let messages: MessageRepository;
  let pins: MessagePinRepository;
  let worker: PinCleanupWorker;

  beforeAll(async () => {
    app = await TestApp.create();
    auth = new AuthFixture(app);
    const container = new MessagesContainer(new Container({ parent: app.container }));
    chats = container.get(MESSAGES_TYPES.ChatRepository);
    members = container.get(MESSAGES_TYPES.ChatMemberRepository);
    messages = container.get(MESSAGES_TYPES.MessageRepository);
    pins = container.get(MESSAGES_TYPES.MessagePinRepository);
    worker = container.get(MESSAGES_TYPES.PinCleanupWorker);
  });

  afterAll(async () => {
    await worker.close();
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
    auth.emails.clear();
  });

  it('deletes only elapsed rows in bounded batches', async () => {
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

    const expiredIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const message = await messages.create({
        chatId: chat.id,
        senderId: bob.id,
        body: `expired ${index}`,
      });
      expiredIds.push(message.id);
      await pins.pin(chat.id, alice.id, message.id, new Date(Date.now() + 3_600_000));
    }
    const active = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'active' });
    await pins.pin(chat.id, alice.id, active.id, new Date(Date.now() + 3_600_000));

    for (const id of expiredIds) {
      await app.pool.query(
        `UPDATE message_pins SET expires_at = now() - interval '1 second'
         WHERE chat_id = $1 AND user_id = $2 AND message_id = $3`,
        [chat.id, alice.id, id],
      );
    }

    const result = await worker.process();
    expect(result.deleted).toBe(3);
    expect((await pins.list(chat.id, alice.id)).map((pin) => pin.messageId)).toEqual([active.id]);
  });
});
```

`MessagesContainer` binds `CORE_TYPES.MediaReferenceReader` on its **parent** (see `messages.container.ts:69-71`), so this extra module must sit behind an intermediate `new Container({ parent: app.container })`, exactly as `pin-service.test.ts` does. Wiring it directly to `app.container` would add a second binding for that symbol and make HTTP requests through the app fail with an ambiguous match.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/messages/pin-cleanup.worker.test.ts 2>&1 | tail -30`
Expected: FAIL — module and symbol do not exist.

- [ ] **Step 3: Add config**

In `src/core/config/app.config.ts`, add next to `StoryConfig`:

```ts
export class PinCleanupConfig {
  constructor(readonly intervalMinutes: number) {
    if (!Number.isInteger(this.intervalMinutes) || this.intervalMinutes <= 0) {
      throw new Error('PIN_CLEANUP_INTERVAL_MINUTES must be a positive integer');
    }
  }
}
```

Add `readonly pinCleanup: PinCleanupConfig;` beside `readonly stories: StoryConfig;`, and in the constructor beside the stories assignment:

```ts
    this.pinCleanup = new PinCleanupConfig(
      env.readNumber('PIN_CLEANUP_INTERVAL_MINUTES', 5),
    );
```

In `.env.example`, add near the messaging/stories settings:

```bash
# How often the BullMQ job physically deletes expired message pins
PIN_CLEANUP_INTERVAL_MINUTES=5
```

- [ ] **Step 4: Add the worker**

Create `src/modules/messages/logic/pin-cleanup.worker.ts`:

```ts
import { Queue, Worker, type Job } from 'bullmq';
import { inject, injectable } from 'inversify';
import type { Logger } from 'pino';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { MessagePinRepository } from '@/modules/messages/logic/ports/message-pin.repository.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import type { RedisClient } from '@/types/redis.js';

const QUEUE_NAME = 'pin-cleanup';
const JOB_NAME = 'delete-expired-pins';
const REPEAT_KEY = 'pin-cleanup-expired-pins';
const BATCH_SIZE = 100;
const MAX_BATCHES = 100;

/** Owns the repeatable job that physically removes elapsed pin metadata. */
@injectable()
export class PinCleanupWorker {
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(
    @inject(MESSAGES_TYPES.MessagePinRepository) private readonly pins: MessagePinRepository,
    @inject(CORE_TYPES.RedisClient) private readonly redis: RedisClient,
    @inject(CORE_TYPES.Config) private readonly config: AppConfig,
    @inject(CORE_TYPES.Logger) private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (this.queue !== null) {
      return;
    }

    const connection = this.redis;
    this.queue = new Queue(QUEUE_NAME, { connection });
    this.worker = new Worker(
      QUEUE_NAME,
      (job: Job) => this.process(job),
      { connection, concurrency: 1 },
    );
    this.worker.on('error', (error: Error) => {
      this.logger.error({ err: error }, 'Pin cleanup worker error');
    });

    await this.queue.add(
      JOB_NAME,
      {},
      {
        repeat: {
          key: REPEAT_KEY,
          every: this.config.pinCleanup.intervalMinutes * 60_000,
        },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
  }

  async process(_job?: Job): Promise<{ deleted: number }> {
    let deleted = 0;

    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const removed = await this.pins.deleteExpired(new Date(), BATCH_SIZE);
      deleted += removed;

      if (removed < BATCH_SIZE) {
        break;
      }
    }

    this.logger.info({ deleted }, 'Expired message pin cleanup completed');

    return { deleted };
  }

  async close(): Promise<void> {
    const worker = this.worker;
    const queue = this.queue;
    this.worker = null;
    this.queue = null;

    if (worker) {
      await worker.close();
    }

    if (queue) {
      await queue.close();
    }
  }
}
```

BullMQ 6.7.2 auto-detects a native node-redis client (`sendCommand` plus `isOpen`/`isReady`) and wraps it with its own `NodeRedisAdapter`, and its `ConnectionOptions` accepts the existing client type — no new dependency or manual adapter is needed.

- [ ] **Step 5: Wire DI and module lifecycle**

In `src/modules/messages/messages.types.ts`, add:

```ts
  PinCleanupWorker: Symbol.for('Messages.PinCleanupWorker'),
```

In `src/modules/messages/messages.container.ts`, import `PinCleanupWorker` and bind it as a singleton next to `PinService`:

```ts
import { PinCleanupWorker } from '@/modules/messages/logic/pin-cleanup.worker.js';
```

```ts
    this.bind<PinCleanupWorker>(MESSAGES_TYPES.PinCleanupWorker)
      .to(PinCleanupWorker)
      .inSingletonScope();
```

In `src/modules/messages/messages.module.ts`:

```ts
import type { PinCleanupWorker } from '@/modules/messages/logic/pin-cleanup.worker.js';
```

```ts
  async configure(): Promise<void> {
    this.container.get<MessagesRateLimiter>(MESSAGES_TYPES.MessagesRateLimiter).initialize();
    await this.container.get<PinCleanupWorker>(MESSAGES_TYPES.PinCleanupWorker).start();
  }

  async dispose(): Promise<void> {
    await this.container.get<PinCleanupWorker>(MESSAGES_TYPES.PinCleanupWorker).close();
    this.container.unbindAll();
  }
```

`AppModule.configure()` already returns `void | Promise<void>` and `Application.initialize()` awaits it, so awaiting `start()` surfaces repeatable-job registration failures at boot. The `error` listener added in Step 4 logs later Redis or processor errors that `await` cannot catch.

- [ ] **Step 6: Run typecheck, lint, and the worker test**

Run: `npm run typecheck 2>&1 | tail -25 && npm run lint 2>&1 | tail -10 && npx vitest run tests/integration/messages/pin-cleanup.worker.test.ts 2>&1 | tail -15`
Expected: typecheck and lint clean; worker test passes.

- [ ] **Step 7: Commit**

```bash
git add src/core/config/app.config.ts .env.example src/modules/messages tests/integration/messages/pin-cleanup.worker.test.ts
git commit -m "feat(messaging): add repeatable expired-pin cleanup job"
```

---

### Task 5: Documentation, final verification, and live smoke

**Files:**
- Modify: `README.md`
- No source changes; evidence written to `/tmp/opencode/pin-expiry-smoke-report.md`.

**Interfaces:**
- Consumes: all prior tasks; the running API on `http://127.0.0.1:4000` with PostgreSQL, Redis, and MinIO up.
- Produces: updated setup/API docs, a green full verification, a pass/fail live smoke report, and a clean database.

- [ ] **Step 1: Update README**

In the messaging route table (around `README.md:282`), replace the pin row with:

```markdown
| `POST`   | `/api/chats/:chatId/messages/:messageId/pin`     | Pin a message for a chosen duration        |
```

Replace `README.md:336-346` (the "Pinned messages" section paragraph) with exactly:

```markdown
Pins are private, per-user bookmarks on live messages. Both direct cloud chats
and secret chats are supported, and pinning only stores metadata: secret-chat
ciphertext, nonce, and device ids are never read or changed. `POST /pin` requires
`{ "durationSeconds": 3600 }` with an integer from 60 (1 minute) to 604800
(7 days); invalid values return `400 VALIDATION_ERROR`. The server computes
`expiresAt` from its own clock when the pin is created; clients never supply an
absolute deadline. Once elapsed, a pin is hidden from `GET /pins` and from
message history (both `pinnedAt` and `pinExpiresAt` become `null`) and immediately
stops counting toward the ten-pin cap. A pin can be created again after expiry;
pinning an active message again is idempotent and keeps the original timestamps.
`POST /pin` returns `expiresAt` and message views plus `GET /pins` return
`pinExpiresAt`. A BullMQ repeatable job physically deletes elapsed rows every
`PIN_CLEANUP_INTERVAL_MINUTES` (default 5), but read-time filtering is
authoritative, so a Redis or job outage never exposes an expired pin. Pins
created before this change were backfilled to expire one day after deployment;
they are not permanent. `DELETE /api/chats/:chatId/messages/:messageId/pin` is
idempotent and returns `204` even when no pin exists.
`GET /api/chats/:chatId/pins` returns the caller's active pins newest-first as
full message views; the other participant's pins are never listed or exposed.
Soft-deleting a message removes all of its pins.
```

In the "Configuration" section (after the paragraph ending `messaging, captcha, MFA, SMTP, OAuth, SSO, and Docker Compose options.` at `README.md:628`), add:

```markdown
`PIN_CLEANUP_INTERVAL_MINUTES` (default `5`) sets how often the BullMQ repeatable
job physically deletes elapsed pin rows. Elapsed pins are already hidden on read,
so this only controls storage hygiene.
```

- [ ] **Step 2: Run the full verification gate**

Run: `npm run verify && npm run db:check`
Expected: typecheck, lint, build, and all tests pass; `Everything's fine 🐶🔥`.

- [ ] **Step 3: Live HTTP smoke**

Start `npm run dev` in the background, wait for `GET /health/live` → 200, then exercise over HTTP:

1. Register three verified users (A, B, outsider) and one unverified user; use a controlled DB update to set `email_verified_at` and re-login for fresh tokens.
2. Open a direct chat; B sends 12 messages.
3. `POST /pin` as A with `durationSeconds: 3600` → 201 with `messageId`, `pinnedAt`, `expiresAt`; repeat → identical timestamps.
4. `GET /pins` as A → newest-first with non-null `pinExpiresAt`; as B → `[]`.
5. `GET /messages` as A → `pinnedAt`/`pinExpiresAt` non-null for pinned rows; as B → both null.
6. Pin ten messages; 11th → `409 CONFLICT`. Age one pin with `UPDATE message_pins SET expires_at = now() - interval '1 second'`; confirm it disappears from A's pins and history and that the 11th pin now succeeds.
7. Delete elapsed rows via the worker processor path (enqueue one job or call `process()` from a small script) and confirm no elapsed rows remain.
8. Error paths: `{}` → `400 VALIDATION_ERROR`; `59`, `604801`, `60.5` → `400`; no bearer → `401`; unverified → `403 EMAIL_NOT_VERIFIED`; outsider `GET /pins` → `403 NOT_CHAT_MEMBER`; foreign/deleted/malformed message ids → `404`/`400`.
9. Secret chat: register devices, open a secret chat, store ciphertext, pin it, confirm ciphertext/nonce/device ids unchanged and `pinExpiresAt` present.
10. Clean up the smoke users and their rows; assert `users|chats|messages|pins = 0|0|0|0` for the smoke prefix. Record every check in `/tmp/opencode/pin-expiry-smoke-report.md`.

- [ ] **Step 4: Stop processes and commit docs**

Stop the API and ClamAV; leave PostgreSQL, Redis, and MinIO running. Remove temporary smoke scripts. Commit README changes:

```bash
git add README.md
git commit -m "docs(messaging): document expiring pinned messages"
```
