# Read Receipts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit, monotonic read receipts to cloud and secret chats with mutual `readAt` visibility and caller-private unread counts.

**Architecture:** A nullable per-membership watermark (`last_read_message_id` + `last_read_at`) on `chat_members` records read state; a new core `ReadReceiptPreferenceReader` port lets messaging ask auth whether a pair shares receipts without importing auth internals. A `ReadReceiptService` owns mark-read, `ChatService` and `MessagePresenter` hydrate counts and timestamps, and one documented `POST /api/chats/:chatId/read` route is the only writer.

**Tech Stack:** Node 24, TypeScript 7.0.2, ESM, Express 5, Inversify 8 child containers, Drizzle ORM + PostgreSQL 18 (hash-partitioned `messages`, UUIDv7 ids), Zod, Vitest + Supertest, Biome.

**Spec:** `docs/superpowers/specs/2026-11-19-read-receipts-design.md`

## Global Constraints

- Node 24, TypeScript 7.0.2, ESM (`"type": "module"`); no CommonJS imports.
- Express 5 + Inversify 8: modules depend on `core` only; messages must never import auth internals (or vice versa).
- Use `@/...` path aliases and explicit `.js` extensions on every relative ESM import.
- Biome: single quotes, semicolons, trailing commas, 2-space indentation, 100-character line width, organized imports. Run `npm run check` after edits if Biome feedback is unclear.
- Prefer `unknown` over `any`; no module-level helper functions except framework callbacks or declarative values.
- Put behavior in classes; use `@injectable()` + constructor injection with `@inject(TYPE_SYMBOL)`.
- All JSON responses go through the injected `ApiResponse`; never call `res.json` directly.
- Error hierarchy only; no new public error code. Domain errors carry no HTTP status; `ErrorMapper` owns status mapping.
- Drizzle is the only data-access layer; wrap failures in `PersistenceException`; no raw `pg` repositories.
- Explicit names for every index/constraint; no FK from a watermark to partitioned `messages`.
- Read ordering is UUIDv7 id ordering (`ORDER BY id DESC`); never use `created_at` as a cursor.
- Every route must be registered through `DocumentedRouter` with a `RouteContract`; request Zod schemas are shared for docs and validation.
- `user_privacy_settings.read_receipts_enabled` defaults to `true`; mutual means both users must have it on.
- `GET /api/chats/:chatId/messages` never mutates read state.
- Keep secret-chat ciphertext untouched; read state is metadata only.
- Verify with `npm run verify` and `npm run db:check`; `npm run test` requires Postgres/Redis running and `npm run verify` additionally needs the `scan`-profile ClamAV sidecar.
- The gitignored `/home/ahmed/Desktop/tutorial/inversify-passport/plan.md` must never be committed.
- Every subagent dispatched for this plan must use `model: opencode/big-pickle`; each task gets an independent review before the next task starts.
- Each task ends with a single commit that contains its code, tests, and any docs that belong to it.

## Review Focus

These five failure modes are implied by the spec but easy to miss in ordinary task tests. Each has a pinned test in the owning task.

1. A client sends a `messageId` from another chat, or two devices race stale watermarks → must 404 / never rewind. Pinned in Task 2 (concurrent stale) and Task 4 (foreign id).
2. A watermark target is a soft-deleted message, or the chat is empty → must be accepted and must not resurrect unread counts. Pinned in Task 2 (deleted target) and Task 4 (empty chat).
3. A chat with zero messages in a multi-chat list → must report `unreadCount: 0`, not omit the chat. Pinned in Task 5.
4. Marking a secret chat read must not change ciphertext, nonce, or device ids. Pinned in Task 6.
5. A peer with no stored privacy row still defaults to receipts enabled, and an opt-out takes effect on the next presentation without a restart. Pinned in Task 3 and Task 6.

---

### Task 1: Read watermark schema, migration, and membership record

**Files:**
- Modify: `src/core/database/schema/messaging.schema.ts:65-83`
- Create: `drizzle/0014_<generated>.sql` (generated, then reviewed)
- Modify: `src/modules/messages/logic/entities/chat-member-record.ts`
- Modify: `src/modules/messages/data/chat-member.mapper.ts`
- Test: `tests/integration/messages/messaging-schema.test.ts`
- Test: `tests/integration/messages/messaging-repositories.test.ts`

**Interfaces:**
- Consumes: existing `chatMembers` Drizzle table; `ChatMemberMapper.chatMemberSelection`.
- Produces: `chat_members.last_read_message_id uuid NULL`, `chat_members.last_read_at timestamptz NULL`, migration `0014`, `ChatMemberRecord.lastReadMessageId: string | null`, `ChatMemberRecord.lastReadAt: Date | null`.

- [ ] **Step 1: Write the failing schema test**

Append to `describe('Messaging schema', ...)` in `tests/integration/messages/messaging-schema.test.ts`:

```ts
  it('stores nullable read watermarks on chat members without a message foreign key', async () => {
    const columns = await app.pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'chat_members'
          AND column_name IN ('last_read_message_id', 'last_read_at')
        ORDER BY column_name`,
    );

    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'last_read_at',
      'last_read_message_id',
    ]);
    expect(columns.rows.every((row) => row.is_nullable === 'YES')).toBe(true);

    const foreignKeys = await app.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_constraint
        WHERE conrelid = 'public.chat_members'::regclass
          AND contype = 'f'
          AND confrelid = 'public.messages'::regclass`,
    );
    expect(foreignKeys.rows[0]?.count).toBe(0);
  });
```

- [ ] **Step 2: Write the failing repository test**

Append to `describe('Messaging repositories', ...)` in `tests/integration/messages/messaging-repositories.test.ts`:

```ts
  it('returns null read watermarks for a fresh membership', async () => {
    const owner = await auth.createUser();
    const chatId = await createGroupChat(owner.id);

    const membership = await members.find(chatId, owner.id);

    expect(membership?.lastReadMessageId).toBeNull();
    expect(membership?.lastReadAt).toBeNull();
  });
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `npx vitest run tests/integration/messages/messaging-schema.test.ts tests/integration/messages/messaging-repositories.test.ts`
Expected: FAIL — `last_read_at` / `last_read_message_id` columns do not exist, and `membership.lastReadMessageId` is `undefined`.

- [ ] **Step 4: Add the schema columns**

In `src/core/database/schema/messaging.schema.ts`, inside the `chatMembers` `pgTable` object after `leftAt`, insert:

```ts
    // Read state is a watermark, not a per-message table. No FK to `messages`:
    // that table is partitioned and hard-deletes must not be restricted.
    lastReadMessageId: uuid('last_read_message_id'),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }),
```

`uuid` and `timestamp` are already imported from `drizzle-orm/pg-core`.

- [ ] **Step 5: Extend the membership record and mapper**

Replace `src/modules/messages/logic/entities/chat-member-record.ts` with:

```ts
export type ChatMemberRole = 'member' | 'admin' | 'owner';

/**
 * A user's membership in a chat.
 *
 * `leftAt` is reserved for a future leave model; 2.1 removes members by
 * deleting the row. The read watermark is a monotonic per-membership cursor:
 * `null` means nothing has been read yet.
 */
export class ChatMemberRecord {
  constructor(
    readonly chatId: string,
    readonly userId: string,
    readonly role: ChatMemberRole,
    readonly joinedAt: Date,
    readonly leftAt: Date | null,
    readonly lastReadMessageId: string | null = null,
    readonly lastReadAt: Date | null = null,
  ) {}
}
```

In `src/modules/messages/data/chat-member.mapper.ts`, add to `chatMemberSelection` after `leftAt`:

```ts
  lastReadMessageId: chatMembers.lastReadMessageId,
  lastReadAt: chatMembers.lastReadAt,
```

and extend the constructor call at the end of `toRecord`:

```ts
      row.leftAt,
      row.lastReadMessageId,
      row.lastReadAt,
    );
```

- [ ] **Step 6: Generate, review, and apply migration 0014**

Run: `npm run db:generate`
Review the generated `drizzle/0014_*.sql`: it must contain two `ADD COLUMN ...` statements for `last_read_message_id uuid` and `last_read_at timestamp with time zone`, both nullable, with **no** foreign key and no backfill UPDATE.

Run: `npm run db:migrate`
Run: `npm run db:check`
Expected: `Everything's fine 🐶🔥`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/integration/messages/messaging-schema.test.ts tests/integration/messages/messaging-repositories.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -f drizzle/0014_*.sql
git add src/core/database/schema/messaging.schema.ts \
  src/modules/messages/logic/entities/chat-member-record.ts \
  src/modules/messages/data/chat-member.mapper.ts \
  tests/integration/messages/messaging-schema.test.ts \
  tests/integration/messages/messaging-repositories.test.ts
git commit -m "feat(messaging): add nullable read watermark to chat members"
```

---

### Task 2: Read-state repository methods

**Files:**
- Modify: `src/modules/messages/logic/ports/chat-member.repository.ts`
- Modify: `src/modules/messages/logic/ports/message.repository.ts`
- Modify: `src/modules/messages/data/postgres-chat-member.repository.ts`
- Modify: `src/modules/messages/data/postgres-message.repository.ts`
- Test: `tests/integration/messages/messaging-repositories.test.ts`

**Interfaces:**
- Consumes: `ChatMemberRecord.lastReadMessageId` / `.lastReadAt` from Task 1.
- Produces, added to `ChatMemberRepository`:
  `markRead(chatId: string, userId: string, messageId: string): Promise<ChatMemberRecord>`
- Produces, added to `MessageRepository`:
  `maxIdByChat(chatId: string): Promise<string | null>`
  `countUnread(chatId: string, readerId: string, watermarkId: string | null): Promise<number>`
  `countUnreadByChats(readerId: string, chatIds: readonly string[]): Promise<Map<string, number>>`

- [ ] **Step 1: Write the failing repository tests**

Append to `tests/integration/messages/messaging-repositories.test.ts`. Add `vi` to the vitest import at the top:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
```

Then append these tests inside `describe('Messaging repositories', ...)`:

```ts
  it('marks read monotonically and counts only newer live inbound messages', async () => {
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

    const first = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'one' });
    const second = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'two' });

    // uuidv7 ordering is the pagination and watermark ordering invariant.
    expect(second.id > first.id).toBe(true);

    const afterFirst = await members.markRead(chat.id, alice.id, first.id);
    expect(afterFirst.lastReadMessageId).toBe(first.id);
    expect(afterFirst.lastReadAt).toBeInstanceOf(Date);

    const afterStale = await members.markRead(chat.id, alice.id, first.id);
    expect(afterStale.lastReadMessageId).toBe(first.id);
    expect(afterStale.lastReadAt?.getTime()).toBe(afterFirst.lastReadAt?.getTime());

    await members.markRead(chat.id, alice.id, second.id);
    expect(await messages.countUnread(chat.id, alice.id, first.id)).toBe(1);
    expect(await messages.countUnread(chat.id, alice.id, second.id)).toBe(0);
    expect(await messages.maxIdByChat(chat.id)).toBe(second.id);
  });

  it('ignores own and soft-deleted messages when counting unread', async () => {
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

    await messages.create({ chatId: chat.id, senderId: alice.id, body: 'mine' });
    const inbound = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'theirs' });
    expect(await messages.countUnread(chat.id, alice.id, null)).toBe(1);

    await messages.markDeleted(chat.id, inbound.id, new Date());
    // A deleted message may still be a legitimate watermark target.
    const marked = await members.markRead(chat.id, alice.id, inbound.id);
    expect(marked.lastReadMessageId).toBe(inbound.id);
    expect(await messages.countUnread(chat.id, alice.id, null)).toBe(0);
    expect(await messages.countUnread(chat.id, alice.id, inbound.id)).toBe(0);
  });

  it('counts unread for several chats in one query', async () => {
    const alice = await auth.createUser();
    const bob = await auth.createUser();
    const charlie = await auth.createUser();
    const firstChat = await createGroupChat(alice.id);
    const secondChat = await createGroupChat(alice.id);
    await members.add(firstChat, bob.id);
    await members.add(secondChat, charlie.id);
    await messages.create({ chatId: firstChat, senderId: bob.id, body: 'first' });
    await messages.create({ chatId: secondChat, senderId: charlie.id, body: 'second' });

    const selectSpy = vi.spyOn(app.db, 'select');
    const counts = await messages.countUnreadByChats(alice.id, [firstChat, secondChat]);
    const queryCount = selectSpy.mock.calls.length;
    selectSpy.mockRestore();

    expect(queryCount).toBe(1);
    expect(counts.get(firstChat)).toBe(1);
    expect(counts.get(secondChat)).toBe(1);
    expect(counts.has('00000000-0000-7000-8000-000000000000')).toBe(false);
  });

  it('never rewinds the watermark when stale marks race', async () => {
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
    const first = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'one' });
    const second = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'two' });

    await Promise.all([
      members.markRead(chat.id, alice.id, second.id),
      members.markRead(chat.id, alice.id, first.id),
      members.markRead(chat.id, alice.id, second.id),
    ]);

    const current = await members.find(chat.id, alice.id);
    expect(current?.lastReadMessageId).toBe(second.id);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/messages/messaging-repositories.test.ts`
Expected: FAIL — `members.markRead`, `messages.countUnread`, `messages.maxIdByChat`, and `messages.countUnreadByChats` are not functions.

- [ ] **Step 3: Extend the repository ports**

In `src/modules/messages/logic/ports/chat-member.repository.ts`, add before the closing `}`:

```ts
  /**
   * Advances the read watermark only when `messageId` is newer than the stored
   * id. Returns the current membership row, including on a stale no-op.
   */
  markRead(chatId: string, userId: string, messageId: string): Promise<ChatMemberRecord>;
```

In `src/modules/messages/logic/ports/message.repository.ts`, add before the closing `}`:

```ts
  /** Newest message id in a chat, or null when the chat has no messages. */
  maxIdByChat(chatId: string): Promise<string | null>;

  /** Live messages from other participants newer than the reader watermark. */
  countUnread(chatId: string, readerId: string, watermarkId: string | null): Promise<number>;

  /** Batched variant for chat lists; chats with zero unread may be absent. */
  countUnreadByChats(readerId: string, chatIds: readonly string[]): Promise<Map<string, number>>;
```

- [ ] **Step 4: Implement `markRead`**

In `src/modules/messages/data/postgres-chat-member.repository.ts`, change the first line (the drizzle import) to this single import — `asc` and `inArray` are still used by `listByChat`/`listByChats`, and `sql` supplies the database clock:

```ts
import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
```

Add this method before `remove`:

```ts
  async markRead(
    chatId: string,
    userId: string,
    messageId: string,
  ): Promise<ChatMemberRecord> {
    try {
      const rows = await this.db
        .update(chatMembers)
        .set({ lastReadMessageId: messageId, lastReadAt: sql`now()` })
        .where(
          and(
            eq(chatMembers.chatId, chatId),
            eq(chatMembers.userId, userId),
            or(
              isNull(chatMembers.lastReadMessageId),
              lt(chatMembers.lastReadMessageId, messageId),
            ),
          ),
        )
        .returning(chatMemberSelection);

      const updated = rows[0];

      if (updated) {
        return this.mapper.toRecord(updated);
      }

      const current = await this.find(chatId, userId);

      if (!current) {
        throw new PersistenceException('Failed to mark chat read: membership not found');
      }

      return current;
    } catch (error) {
      if (error instanceof PersistenceException) {
        throw error;
      }

      throw new PersistenceException('Failed to mark chat read', { cause: error });
    }
  }
```

- [ ] **Step 5: Implement the message read-state queries**

In `src/modules/messages/data/postgres-message.repository.ts`, change the first line (the drizzle import) to this single import — `lt` is still used by cursor pagination in `list`:

```ts
import { and, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
```

and change the schema import to `import { chatMembers, chats, messages } from '@/core/database/schema/index.js';`

Add these methods before `hasLiveMediaReferences`:

```ts
  async maxIdByChat(chatId: string): Promise<string | null> {
    try {
      const rows = await this.db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.chatId, chatId))
        .orderBy(desc(messages.id))
        .limit(1);

      return rows[0]?.id ?? null;
    } catch (error) {
      throw new PersistenceException('Failed to find the latest message', { cause: error });
    }
  }

  async countUnread(
    chatId: string,
    readerId: string,
    watermarkId: string | null,
  ): Promise<number> {
    try {
      const conditions = [
        eq(messages.chatId, chatId),
        ne(messages.senderId, readerId),
        isNull(messages.deletedAt),
      ];

      if (watermarkId !== null) {
        conditions.push(gt(messages.id, watermarkId));
      }

      const rows = await this.db
        .select({ value: sql<number>`count(*)::int` })
        .from(messages)
        .where(and(...conditions));

      return rows[0]?.value ?? 0;
    } catch (error) {
      throw new PersistenceException('Failed to count unread messages', { cause: error });
    }
  }

  async countUnreadByChats(
    readerId: string,
    chatIds: readonly string[],
  ): Promise<Map<string, number>> {
    if (chatIds.length === 0) {
      return new Map();
    }

    try {
      const rows = await this.db
        .select({ chatId: messages.chatId, value: sql<number>`count(*)::int` })
        .from(messages)
        .innerJoin(
          chatMembers,
          and(eq(chatMembers.chatId, messages.chatId), eq(chatMembers.userId, readerId)),
        )
        .where(
          and(
            inArray(messages.chatId, [...chatIds]),
            ne(messages.senderId, readerId),
            isNull(messages.deletedAt),
            or(isNull(chatMembers.lastReadMessageId), gt(messages.id, chatMembers.lastReadMessageId)),
          ),
        )
        .groupBy(messages.chatId);

      return new Map(rows.map((row) => [row.chatId, row.value]));
    } catch (error) {
      throw new PersistenceException('Failed to count unread chats', { cause: error });
    }
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/integration/messages/messaging-repositories.test.ts`
Expected: PASS, including the one-query assertion and the concurrent stale-mark test.

- [ ] **Step 7: Commit**

```bash
git add src/modules/messages/logic/ports/chat-member.repository.ts \
  src/modules/messages/logic/ports/message.repository.ts \
  src/modules/messages/data/postgres-chat-member.repository.ts \
  src/modules/messages/data/postgres-message.repository.ts \
  tests/integration/messages/messaging-repositories.test.ts
git commit -m "feat(messaging): add monotonic read watermark repository methods"
```

---

### Task 3: Core read-receipt preference port and auth adapter

**Files:**
- Create: `src/core/privacy/read-receipt-preference.reader.ts`
- Create: `src/modules/auth/logic/read-receipt-preference.service.ts`
- Modify: `src/core/container/core.types.ts`
- Modify: `src/modules/auth/auth.types.ts`
- Modify: `src/modules/auth/auth.container.ts`
- Test: `tests/integration/auth/read-receipt-preference.test.ts`

**Interfaces:**
- Consumes: `PrivacyService.get(userId): Promise<PrivacySettingsRecord>` with `.readReceiptsEnabled: boolean`; `AUTH_TYPES.PrivacyService`; `CORE_TYPES.UserPrivacyReader` binding pattern.
- Produces: `CORE_TYPES.ReadReceiptPreferenceReader` and
  `ReadReceiptPreferenceReader.areEnabledForPair(firstUserId, secondUserId): Promise<boolean>`,
  root-bound by the auth module.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/auth/read-receipt-preference.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { ReadReceiptPreferenceReader } from '@/core/privacy/read-receipt-preference.reader.js';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { TestApp } from '../../helpers/test-app.js';

describe('Core: read receipt preference reader', () => {
  let app: TestApp;
  let auth: AuthFixture;

  beforeAll(async () => {
    app = await TestApp.create();
    auth = new AuthFixture(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
    auth.emails.clear();
  });

  it('is mutual, defaults on, and reflects a privacy change immediately', async () => {
    const alice = await auth.createUser();
    const bob = await auth.createUser();
    const reader = app.container.get<ReadReceiptPreferenceReader>(
      CORE_TYPES.ReadReceiptPreferenceReader,
    );

    // Neither user has a settings row yet; the defaults must apply.
    expect(await reader.areEnabledForPair(alice.id, bob.id)).toBe(true);

    const tokens = await auth.mintTokens(alice);
    const updated = await app.request
      .patch('/api/auth/me/privacy')
      .set(auth.bearerHeader(tokens.accessToken))
      .send({ readReceiptsEnabled: false });
    expect(updated.status).toBe(200);

    expect(await reader.areEnabledForPair(alice.id, bob.id)).toBe(false);
    expect(await reader.areEnabledForPair(bob.id, alice.id)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/auth/read-receipt-preference.test.ts`
Expected: FAIL — module `@/core/privacy/read-receipt-preference.reader.js` does not exist.

- [ ] **Step 3: Create the core port**

Create `src/core/privacy/read-receipt-preference.reader.ts`:

```ts
/**
 * Read-only view of read-receipt consent for other modules.
 *
 * The auth module owns `user_privacy_settings` and provides the implementation;
 * feature modules resolve this through the root container so they never import
 * auth internals. Consent is mutual: receipts are visible only when both peers
 * have opted in.
 */
export interface ReadReceiptPreferenceReader {
  areEnabledForPair(firstUserId: string, secondUserId: string): Promise<boolean>;
}
```

In `src/core/container/core.types.ts`, add after `UserBlockReader`:

```ts
  ReadReceiptPreferenceReader: Symbol.for('Core.ReadReceiptPreferenceReader'),
```

- [ ] **Step 4: Create the auth adapter**

Create `src/modules/auth/logic/read-receipt-preference.service.ts`:

```ts
import { inject, injectable } from 'inversify';
import type { ReadReceiptPreferenceReader } from '@/core/privacy/read-receipt-preference.reader.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { PrivacyService } from '@/modules/auth/logic/privacy.service.js';

/** Answers the mutual read-receipt question from auth-owned privacy settings. */
@injectable()
export class ReadReceiptPreferenceService implements ReadReceiptPreferenceReader {
  constructor(
    @inject(AUTH_TYPES.PrivacyService) private readonly privacy: PrivacyService,
  ) {}

  async areEnabledForPair(firstUserId: string, secondUserId: string): Promise<boolean> {
    const [first, second] = await Promise.all([
      this.privacy.get(firstUserId),
      this.privacy.get(secondUserId),
    ]);

    return first.readReceiptsEnabled && second.readReceiptsEnabled;
  }
}
```

- [ ] **Step 5: Bind and publish the adapter**

In `src/modules/auth/auth.types.ts`, add after `UserPrivacyRepository`:

```ts
  ReadReceiptPreferenceService: Symbol.for('Auth.ReadReceiptPreferenceService'),
```

In `src/modules/auth/auth.container.ts`, add the import:

```ts
import type { ReadReceiptPreferenceReader } from '@/core/privacy/read-receipt-preference.reader.js';
import { ReadReceiptPreferenceService } from '@/modules/auth/logic/read-receipt-preference.service.js';
```

Add a singleton binding next to the `UserPrivacyRepository` binding:

```ts
    this.bind<ReadReceiptPreferenceService>(AUTH_TYPES.ReadReceiptPreferenceService)
      .to(ReadReceiptPreferenceService)
      .inSingletonScope();
```

Then, inside `publishToRoot()`, after the `blockReader` declaration add:

```ts
    const receiptReader = this.get<ReadReceiptPreferenceService>(
      AUTH_TYPES.ReadReceiptPreferenceService,
    );
```

and after the `UserBlockReader` binding add:

```ts
    this.root
      .bind<ReadReceiptPreferenceReader>(CORE_TYPES.ReadReceiptPreferenceReader)
      .toConstantValue(receiptReader);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/integration/auth/read-receipt-preference.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/privacy/read-receipt-preference.reader.ts \
  src/core/container/core.types.ts \
  src/modules/auth/logic/read-receipt-preference.service.ts \
  src/modules/auth/auth.types.ts \
  src/modules/auth/auth.container.ts \
  tests/integration/auth/read-receipt-preference.test.ts
git commit -m "feat(auth): publish mutual read receipt preference port"
```

---

### Task 4: ReadReceiptService and the mark-read endpoint

**Files:**
- Create: `src/modules/messages/logic/entities/read-receipt-context.ts`
- Create: `src/modules/messages/logic/read-receipt.service.ts`
- Modify: `src/modules/messages/messages.types.ts`
- Modify: `src/modules/messages/messages.container.ts`
- Modify: `src/modules/messages/web/dto/message.schemas.ts`
- Modify: `src/modules/messages/web/dto/message.openapi.ts`
- Modify: `src/modules/messages/web/chat.controller.ts`
- Modify: `src/modules/messages/web/routes/messages.router.ts`
- Test: `tests/integration/messages/read-receipts.test.ts`

**Interfaces:**
- Consumes: `ChatMemberRepository.markRead`, `MessageRepository.findById/maxIdByChat` (Task 2), `CORE_TYPES.ReadReceiptPreferenceReader` (Task 3), `MessagingPolicy.requireMember`.
- Produces:
  `MESSAGES_TYPES.ReadReceiptService`;
  `ReadReceiptService.markRead(userId: string, chatId: string, messageId?: string | undefined): Promise<ReadMarkResult>`;
  `ReadReceiptService.contextFor(chatId: string, viewerId: string): Promise<ReadReceiptContext>`;
  `ReadReceiptContext = { viewerId: string; mutual: boolean; peerLastReadMessageId: string | null; peerLastReadAt: Date | null }`;
  `markReadSchema` Zod schema;
  `POST /api/chats/:chatId/read`.

- [ ] **Step 1: Write the failing HTTP tests**

Create `tests/integration/messages/read-receipts.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectError, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';
import { type ApiUser, MessagingApiFixture } from './messaging-api.fixture.js';

interface ReadWatermark {
  chatId: string;
  lastReadMessageId: string | null;
  lastReadAt: string | null;
}

describe('Read receipts', () => {
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

  async function createPair(): Promise<{ alice: ApiUser; bob: ApiUser; chatId: string }> {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    const chatId = await fixture.openDirectChat(bob.id, alice.headers);

    return { alice, bob, chatId };
  }

  function send(headers: Record<string, string>, chatId: string, body: string) {
    return app.request.post(`/api/chats/${chatId}/messages`).set(headers).send({ body });
  }

  function markRead(headers: Record<string, string>, chatId: string, body: object = {}) {
    return app.request.post(`/api/chats/${chatId}/read`).set(headers).send(body);
  }

  it('marks a chat read up to the newest message when no messageId is given', async () => {
    const { alice, bob, chatId } = await createPair();
    await send(bob.headers, chatId, 'one');
    const newest = await send(bob.headers, chatId, 'two');
    const newestId = newest.body.data.id as string;

    const data = expectSuccess<ReadWatermark>(await markRead(alice.headers, chatId), 200);

    expect(data.chatId).toBe(chatId);
    expect(data.lastReadMessageId).toBe(newestId);
    expect(data.lastReadAt).not.toBeNull();
  });

  it('marks a chat read up to a specific message and never rewinds', async () => {
    const { alice, bob, chatId } = await createPair();
    const first = await send(bob.headers, chatId, 'one');
    const firstId = first.body.data.id as string;
    const second = await send(bob.headers, chatId, 'two');
    const secondId = second.body.data.id as string;

    const atFirst = expectSuccess<ReadWatermark>(
      await markRead(alice.headers, chatId, { messageId: firstId }),
      200,
    );
    expect(atFirst.lastReadMessageId).toBe(firstId);

    const atSecond = expectSuccess<ReadWatermark>(
      await markRead(alice.headers, chatId, { messageId: secondId }),
      200,
    );
    const stale = expectSuccess<ReadWatermark>(
      await markRead(alice.headers, chatId, { messageId: firstId }),
      200,
    );

    expect(stale.lastReadMessageId).toBe(secondId);
    expect(stale.lastReadAt).toBe(atSecond.lastReadAt);
  });

  it('accepts mark-read on an empty chat', async () => {
    const { alice, chatId } = await createPair();

    const data = expectSuccess<ReadWatermark>(await markRead(alice.headers, chatId), 200);

    expect(data.chatId).toBe(chatId);
    expect(data.lastReadMessageId).toBeNull();
    expect(data.lastReadAt).toBeNull();
  });

  it('rejects a messageId from another chat', async () => {
    const { alice, chatId } = await createPair();
    const charlie = await fixture.verifiedUser('Charlie');
    const otherChatId = await fixture.openDirectChat(alice.id, charlie.headers);
    const foreign = await send(charlie.headers, otherChatId, 'foreign');
    const foreignId = foreign.body.data.id as string;

    const response = await markRead(alice.headers, chatId, { messageId: foreignId });

    expectError(response, 404, 'NOT_FOUND');
  });

  it('rejects malformed, unauthenticated, unverified, and non-member calls', async () => {
    const { alice, chatId } = await createPair();
    const charlie = await fixture.verifiedUser('Charlie');
    const unverified = await fixture.unverifiedUser('Unverified');

    expectError(
      await markRead(alice.headers, chatId, { messageId: 'not-a-uuid' }),
      400,
      'VALIDATION_ERROR',
    );
    expectError(await app.request.post(`/api/chats/${chatId}/read`).send({}), 401, 'UNAUTHORIZED');
    expectError(await markRead(unverified.headers, chatId), 403, 'EMAIL_NOT_VERIFIED');
    expectError(await markRead(charlie.headers, chatId), 403, 'NOT_CHAT_MEMBER');
  });

  it('allows mark-read in a secret chat without touching its ciphertext payload', async () => {
    const alice = await fixture.verifiedUser('Alice Secret');
    const bob = await fixture.verifiedUser('Bob Secret');
    await fixture.registerDevice(alice);
    const bobDevice = await fixture.registerDevice(bob);
    const chatId = await fixture.openSecretChat(bob.id, alice.headers);
    const sent = await app.request
      .post(`/api/chats/${chatId}/secret-messages`)
      .set(alice.headers)
      .send({
        recipientDeviceId: bobDevice.deviceId,
        ciphertext: Buffer.from('ciphertext').toString('base64url'),
        nonce: 'A'.repeat(16),
        ephemeralPublicKey: 'A'.repeat(43),
      });
    expect(sent.status).toBe(201);
    const messageId = sent.body.data.id as string;

    const data = expectSuccess<ReadWatermark>(
      await markRead(bob.headers, chatId, { messageId }),
      200,
    );
    expect(data.lastReadMessageId).toBe(messageId);

    const after = await app.request.get(`/api/chats/${chatId}/messages`).set(alice.headers);
    expect(after.body.data[0].ciphertext).toBe(sent.body.data.ciphertext);
    expect(after.body.data[0].nonce).toBe(sent.body.data.nonce);
    expect(after.body.data[0].body).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/messages/read-receipts.test.ts`
Expected: FAIL — `POST /api/chats/:chatId/read` is a 404 route.

- [ ] **Step 3: Add the presentation context type**

Create `src/modules/messages/logic/entities/read-receipt-context.ts`:

```ts
/** Per-request receipt context for presenting a page of messages. */
export interface ReadReceiptContext {
  readonly viewerId: string;
  readonly mutual: boolean;
  readonly peerLastReadMessageId: string | null;
  readonly peerLastReadAt: Date | null;
}
```

- [ ] **Step 4: Add the service result type and service**

Create `src/modules/messages/logic/read-receipt.service.ts`:

```ts
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { NotFoundException } from '@/core/errors/http.error.js';
import type { ReadReceiptPreferenceReader } from '@/core/privacy/read-receipt-preference.reader.js';
import type { ReadReceiptContext } from '@/modules/messages/logic/entities/read-receipt-context.js';
import type { MessagingPolicy } from '@/modules/messages/logic/messaging-policy.service.js';
import type { ChatMemberRepository } from '@/modules/messages/logic/ports/chat-member.repository.js';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';

export interface ReadMarkResult {
  readonly chatId: string;
  readonly lastReadMessageId: string | null;
  readonly lastReadAt: Date | null;
}

/** Owns read-watermark writes and the receipt context used by presenters. */
@injectable()
export class ReadReceiptService {
  constructor(
    @inject(MESSAGES_TYPES.MessagingPolicy) private readonly policy: MessagingPolicy,
    @inject(MESSAGES_TYPES.MessageRepository) private readonly messages: MessageRepository,
    @inject(MESSAGES_TYPES.ChatMemberRepository) private readonly members: ChatMemberRepository,
    @inject(CORE_TYPES.ReadReceiptPreferenceReader)
    private readonly preferences: ReadReceiptPreferenceReader,
  ) {}

  async markRead(
    userId: string,
    chatId: string,
    messageId?: string | undefined,
  ): Promise<ReadMarkResult> {
    await this.policy.requireMember(chatId, userId);

    let target = messageId ?? null;

    if (target !== null) {
      const message = await this.messages.findById(chatId, target);

      if (!message) {
        throw new NotFoundException('Message not found in this chat');
      }
    } else {
      target = await this.messages.maxIdByChat(chatId);
    }

    if (target === null) {
      const current = await this.members.find(chatId, userId);

      return {
        chatId,
        lastReadMessageId: current?.lastReadMessageId ?? null,
        lastReadAt: current?.lastReadAt ?? null,
      };
    }

    const updated = await this.members.markRead(chatId, userId, target);

    return {
      chatId,
      lastReadMessageId: updated.lastReadMessageId,
      lastReadAt: updated.lastReadAt,
    };
  }

  async contextFor(chatId: string, viewerId: string): Promise<ReadReceiptContext> {
    const memberships = await this.members.listByChat(chatId);
    const peer = memberships.find((member) => member.userId !== viewerId);

    if (!peer) {
      return {
        viewerId,
        mutual: false,
        peerLastReadMessageId: null,
        peerLastReadAt: null,
      };
    }

    const mutual = await this.preferences.areEnabledForPair(viewerId, peer.userId);

    return {
      viewerId,
      mutual,
      peerLastReadMessageId: peer.lastReadMessageId,
      peerLastReadAt: peer.lastReadAt,
    };
  }
}
```

- [ ] **Step 5: Bind the service**

In `src/modules/messages/messages.types.ts`, add after `MessagingPolicy`:

```ts
  ReadReceiptService: Symbol.for('Messages.ReadReceiptService'),
```

In `src/modules/messages/messages.container.ts`, add the import:

```ts
import { ReadReceiptService } from '@/modules/messages/logic/read-receipt.service.js';
```

and add the binding after `MessagingPolicy`:

```ts
    this.bind<ReadReceiptService>(MESSAGES_TYPES.ReadReceiptService)
      .to(ReadReceiptService)
      .inSingletonScope();
```

- [ ] **Step 6: Add the request schema**

In `src/modules/messages/web/dto/message.schemas.ts`, add after `chatParamsSchema`:

```ts
/** Body for advancing a chat's read watermark. An absent id means "up to now". */
export const markReadSchema = z.object({
  messageId: z.uuid().optional(),
});
```

- [ ] **Step 7: Add the OpenAPI contract**

In `src/modules/messages/web/dto/message.openapi.ts`, add `markReadSchema` to the import from `message.schemas.js`, then add this schema after `chatSchema`:

```ts
export const readWatermarkSchema = z
  .object({
    chatId: z.uuid(),
    lastReadMessageId: z.uuid().nullable(),
    lastReadAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'ReadWatermark' });
```

and after `const chatListResponse = ...`:

```ts
const readWatermarkResponse = successEnvelope(readWatermarkSchema, 'ReadWatermarkResponse');
```

Add this entry at the end of `messageContracts`, before the closing `} satisfies ...`:

```ts
  markRead: {
    operationId: 'chats.markRead',
    tags: ['Chats'],
    summary: 'Advance the caller read watermark for a chat',
    description:
      'Marks a chat read up to the supplied message id, or to the newest message when omitted. The watermark never moves backwards. Marking is explicit; listing history does not change read state. Works for direct and secret chats; secret chat ciphertext is never read or modified.',
    security: bearerSecurity,
    request: { params: chatParamsSchema, body: markReadSchema },
    responses: {
      200: { description: 'The updated read watermark', schema: readWatermarkResponse },
      ...commonErrorResponses,
    },
  },
```

- [ ] **Step 8: Add the controller handler**

In `src/modules/messages/web/chat.controller.ts`, add imports:

```ts
import type { ReadReceiptService } from '@/modules/messages/logic/read-receipt.service.js';
import { chatParamsSchema, markReadSchema, openDirectChatSchema } from '@/modules/messages/web/dto/message.schemas.js';
```

(replace the existing `openDirectChatSchema`-only import). Add the constructor parameter after `ChatService`:

```ts
    @inject(MESSAGES_TYPES.ReadReceiptService) private readonly receipts: ReadReceiptService,
```

Add this handler before `private requireUser`:

```ts
  markRead: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const { chatId } = chatParamsSchema.parse(req.params);
    const { messageId } = markReadSchema.parse(req.body ?? {});
    const result = await this.receipts.markRead(user.id, chatId, messageId);

    this.response.ok(res, result);
  };
```

- [ ] **Step 9: Register the route**

In `src/modules/messages/web/routes/messages.router.ts`, insert before the `/:chatId/secret-messages` route:

```ts
    routes.post(
      '/:chatId/read',
      messageContracts.markRead,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container.get<ChatController>(MESSAGES_TYPES.ChatController).markRead(req, res, next),
    );
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npx vitest run tests/integration/messages/read-receipts.test.ts`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/modules/messages/logic/entities/read-receipt-context.ts \
  src/modules/messages/logic/read-receipt.service.ts \
  src/modules/messages/messages.types.ts \
  src/modules/messages/messages.container.ts \
  src/modules/messages/web/dto/message.schemas.ts \
  src/modules/messages/web/dto/message.openapi.ts \
  src/modules/messages/web/chat.controller.ts \
  src/modules/messages/web/routes/messages.router.ts \
  tests/integration/messages/read-receipts.test.ts
git commit -m "feat(messaging): add explicit chat mark-read endpoint"
```

---

### Task 5: Caller-private unread counts on chat lists

**Files:**
- Modify: `src/modules/messages/logic/entities/chat-view.ts`
- Modify: `src/modules/messages/logic/chat.service.ts`
- Modify: `src/modules/messages/web/chat.controller.ts`
- Modify: `src/modules/messages/web/dto/message.openapi.ts`
- Test: `tests/integration/messages/read-receipts.test.ts`
- Test: `tests/integration/messages/chat-api.test.ts`

**Interfaces:**
- Consumes: `MessageRepository.countUnreadByChats` (Task 2), `ReadReceiptContext` type (Task 4).
- Produces: `ChatView.unreadCount: number`; `unreadCount` on every `GET /api/chats` row.

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/messages/read-receipts.test.ts` inside the `describe`:

```ts
  it('reports caller-private unread counts that clear on mark-read', async () => {
    const { alice, bob, chatId } = await createPair();
    await send(bob.headers, chatId, 'one');
    await send(bob.headers, chatId, 'two');
    await send(alice.headers, chatId, 'mine');

    async function unreadFor(headers: Record<string, string>): Promise<number> {
      const chats = expectSuccess<Array<{ id: string; unreadCount: number }>>(
        await app.request.get('/api/chats').set(headers),
        200,
      );
      return chats.find((chat) => chat.id === chatId)?.unreadCount ?? -1;
    }

    expect(await unreadFor(alice.headers)).toBe(2);
    expect(await unreadFor(bob.headers)).toBe(1);

    // History GET must not mutate read state.
    await app.request.get(`/api/chats/${chatId}/messages`).set(alice.headers);
    expect(await unreadFor(alice.headers)).toBe(2);

    // Unread counts stay caller-private when the peer disables receipts.
    await app.request
      .patch('/api/auth/me/privacy')
      .set(bob.headers)
      .send({ readReceiptsEnabled: false });
    expect(await unreadFor(alice.headers)).toBe(2);

    await markRead(alice.headers, chatId);
    expect(await unreadFor(alice.headers)).toBe(0);
    expect(await unreadFor(bob.headers)).toBe(1);
  });

  it('reports unread counts for secret chats and chats with no messages', async () => {
    const alice = await fixture.verifiedUser('Alice Secret');
    const bob = await fixture.verifiedUser('Bob Secret');
    await fixture.registerDevice(alice);
    const bobDevice = await fixture.registerDevice(bob);
    const secretChatId = await fixture.openSecretChat(bob.id, alice.headers);
    const emptyChatId = await fixture.openDirectChat(
      (await fixture.verifiedUser('Charlie')).id,
      alice.headers,
    );

    await app.request
      .post(`/api/chats/${secretChatId}/secret-messages`)
      .set(alice.headers)
      .send({
        recipientDeviceId: bobDevice.deviceId,
        ciphertext: Buffer.from('ciphertext').toString('base64url'),
        nonce: 'A'.repeat(16),
        ephemeralPublicKey: 'A'.repeat(43),
      });

    const chats = expectSuccess<Array<{ id: string; unreadCount: number }>>(
      await app.request.get('/api/chats').set(bob.headers),
      200,
    );

    expect(chats.find((chat) => chat.id === secretChatId)?.unreadCount).toBe(1);
    expect(chats.find((chat) => chat.id === emptyChatId)?.unreadCount).toBe(0);
  });
```

Append to `tests/integration/messages/chat-api.test.ts` inside `describe('Chat API', ...)`:

```ts
  it('includes unreadCount in every chat row', async () => {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    const chatId = await fixture.openDirectChat(bob.id, alice.headers);

    const chats = expectSuccess<Array<{ id: string; unreadCount: number }>>(
      await app.request.get('/api/chats').set(alice.headers),
      200,
    );

    expect(chats.find((chat) => chat.id === chatId)?.unreadCount).toBe(0);
  });
```

Add `expectSuccess` to that file's imports:

```ts
import { expectSuccess } from '../../helpers/assertions.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/messages/read-receipts.test.ts tests/integration/messages/chat-api.test.ts`
Expected: FAIL — `unreadCount` is `undefined` in chat rows.

- [ ] **Step 3: Extend `ChatView`**

Replace `src/modules/messages/logic/entities/chat-view.ts` with:

```ts
import type { UserSummary } from '@/core/users/user-summary.reader.js';
import type { ChatRecord, ChatType } from '@/modules/messages/logic/entities/chat-record.js';

/**
 * A chat hydrated with its participants' public display data.
 *
 * The full user record never leaves the auth module; only the summary fields
 * needed to render a conversation row are carried across the boundary.
 * `unreadCount` is caller-private and independent of receipt mutuality.
 */
export class ChatView {
  readonly id: string;
  readonly type: ChatType;
  readonly title: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;

  constructor(
    chat: ChatRecord,
    readonly participants: readonly UserSummary[],
    readonly unreadCount: number,
  ) {
    this.id = chat.id;
    this.type = chat.type;
    this.title = chat.title;
    this.createdAt = chat.createdAt;
    this.updatedAt = chat.updatedAt;
  }
}
```

- [ ] **Step 4: Hydrate counts in `ChatService`**

In `src/modules/messages/logic/chat.service.ts`, add the import:

```ts
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
```

Add a constructor parameter after `ChatMemberRepository`:

```ts
    @inject(MESSAGES_TYPES.MessageRepository) private readonly messages: MessageRepository,
```

In `listForUser`, after `if (chats.length === 0) return [];` add:

```ts
    const unread = await this.messages.countUnreadByChats(
      userId,
      chats.map((chat) => chat.id),
    );
```

and replace the final `return chats.map(...)` with:

```ts
    return chats.map(
      (chat) => new ChatView(chat, byChat.get(chat.id) ?? [], unread.get(chat.id) ?? 0),
    );
```

In `toView`, replace `return new ChatView(chat, participants);` with:

```ts
    return new ChatView(chat, participants, 0);
```

- [ ] **Step 5: Expose the field in the controller and OpenAPI**

In `src/modules/messages/web/chat.controller.ts`, add inside the object returned by `present`, after `title`:

```ts
      unreadCount: chat.unreadCount,
```

In `src/modules/messages/web/dto/message.openapi.ts`, add to `chatSchema` after `title`:

```ts
    unreadCount: z.number().int().nonnegative(),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/integration/messages/read-receipts.test.ts tests/integration/messages/chat-api.test.ts`
Expected: PASS, including the zero-message chat and secret-chat cases.

- [ ] **Step 7: Commit**

```bash
git add src/modules/messages/logic/entities/chat-view.ts \
  src/modules/messages/logic/chat.service.ts \
  src/modules/messages/web/chat.controller.ts \
  src/modules/messages/web/dto/message.openapi.ts \
  tests/integration/messages/read-receipts.test.ts \
  tests/integration/messages/chat-api.test.ts
git commit -m "feat(messaging): add caller-private unread counts to chat lists"
```

---

### Task 6: Mutual `readAt` on message responses

**Files:**
- Modify: `src/modules/messages/web/message-presenter.service.ts`
- Modify: `src/modules/messages/web/message.controller.ts`
- Modify: `src/modules/messages/web/dto/message.openapi.ts`
- Test: `tests/integration/messages/read-receipts.test.ts`

**Interfaces:**
- Consumes: `ReadReceiptContext` (Task 4), `ReadReceiptService.contextFor` (Task 4).
- Produces: `readAt: string | null` on every message DTO; `MessagePresenter.present(message, context?)`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/messages/read-receipts.test.ts` inside the `describe`:

```ts
  it('shows readAt only to the sender, only for read messages, and only when mutual', async () => {
    const { alice, bob, chatId } = await createPair();
    const first = await send(bob.headers, chatId, 'one');
    const firstId = first.body.data.id as string;
    const second = await send(bob.headers, chatId, 'two');
    const secondId = second.body.data.id as string;
    const own = await send(alice.headers, chatId, 'mine');
    const ownId = own.body.data.id as string;

    await markRead(alice.headers, chatId, { messageId: firstId });
    await markRead(bob.headers, chatId, { messageId: ownId });

    async function readAtFor(headers: Record<string, string>) {
      const messages = expectSuccess<Array<{ id: string; readAt: string | null }>>(
        await app.request.get(`/api/chats/${chatId}/messages`).set(headers),
        200,
      );
      return new Map(messages.map((message) => [message.id, message.readAt]));
    }

    const forBob = await readAtFor(bob.headers);
    expect(forBob.get(firstId)).not.toBeNull();
    expect(forBob.get(secondId)).toBeNull();
    expect(forBob.get(ownId)).toBeNull();

    const forAlice = await readAtFor(alice.headers);
    expect(forAlice.get(ownId)).not.toBeNull();
    expect(forAlice.get(firstId)).toBeNull();

    await app.request
      .patch('/api/auth/me/privacy')
      .set(bob.headers)
      .send({ readReceiptsEnabled: false });

    const hidden = await readAtFor(bob.headers);
    expect(hidden.get(firstId)).toBeNull();

    await app.request
      .patch('/api/auth/me/privacy')
      .set(bob.headers)
      .send({ readReceiptsEnabled: true });

    const visibleAgain = await readAtFor(bob.headers);
    expect(visibleAgain.get(firstId)).not.toBeNull();
  });

  it('suppresses readAt on soft-deleted messages', async () => {
    const { alice, bob, chatId } = await createPair();
    const message = await send(bob.headers, chatId, 'delete me');
    const messageId = message.body.data.id as string;
    await markRead(alice.headers, chatId, { messageId });

    const deleted = await app.request
      .delete(`/api/chats/${chatId}/messages/${messageId}`)
      .set(bob.headers);
    expect(deleted.status).toBe(204);

    const messages = expectSuccess<
      Array<{ id: string; readAt: string | null; deletedAt: string | null }>
    >(await app.request.get(`/api/chats/${chatId}/messages`).set(bob.headers), 200);
    const tombstone = messages.find((item) => item.id === messageId);
    expect(tombstone?.deletedAt).not.toBeNull();
    expect(tombstone?.readAt).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/messages/read-receipts.test.ts`
Expected: FAIL — `readAt` is `undefined` on message rows.

- [ ] **Step 3: Add `readAt` to the presenter**

In `src/modules/messages/web/message-presenter.service.ts`, add the import:

```ts
import type { ReadReceiptContext } from '@/modules/messages/logic/entities/read-receipt-context.js';
```

Replace the `present` signature with:

```ts
  async present(
    message: MessageRecord,
    receipts?: ReadReceiptContext,
  ): Promise<Record<string, unknown>> {
```

and add `readAt: this.readAt(message, receipts),` to the `base` object (after `createdAt` is fine).

Add this private method before the final `}` of the class:

```ts
  private readAt(message: MessageRecord, receipts?: ReadReceiptContext): string | null {
    if (
      receipts === undefined ||
      !receipts.mutual ||
      message.senderId !== receipts.viewerId ||
      message.deletedAt !== null ||
      receipts.peerLastReadMessageId === null ||
      message.id > receipts.peerLastReadMessageId
    ) {
      return null;
    }

    return receipts.peerLastReadAt?.toISOString() ?? null;
  }
```

The `viewerId` guard is essential: the context's `peerLastRead*` fields describe the *other* member, so without it an incoming message would display the viewer's own watermark as a receipt. The `forAlice.get(firstId) === null` assertion in Step 1 pins this.

- [ ] **Step 4: Build the context in the message controller**

In `src/modules/messages/web/message.controller.ts`:

1. Add imports:

```ts
import type { MessageRecord } from '@/modules/messages/logic/entities/message-record.js';
import type { ReadReceiptService } from '@/modules/messages/logic/read-receipt.service.js';
```

2. Add a constructor parameter after `MessageService`:

```ts
    @inject(MESSAGES_TYPES.ReadReceiptService) private readonly receipts: ReadReceiptService,
```

3. Replace the single-message `this.presenter.present(message)` call with `await this.present(message, userId)` in `send`, `sendMedia`, `uploadMedia`, `sendSecret`, `edit`, and `forward`. One context lookup per single-message response is fine.

   For `list`, do **not** call the helper per message — that would add two queries per row. Instead, after `const query = listMessagesQuerySchema.parse(req.query);` add:

   ```ts
   const receipts = await this.receipts.contextFor(chatId, userId);
   ```

   and replace the `Promise.all` line with:

   ```ts
   await Promise.all(page.map((message) => this.presenter.present(message, receipts))),
   ```

   This resolves memberships and the pair preference once for the whole page, as the spec requires.

4. Add this private helper before `requireAuth`:

```ts
  private async present(
    message: MessageRecord,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const context = await this.receipts.contextFor(message.chatId, userId);

    return this.presenter.present(message, context);
  }
```

- [ ] **Step 5: Document the field**

In `src/modules/messages/web/dto/message.openapi.ts`, add to `messageSchema` after `createdAt`:

```ts
    readAt: z.iso.datetime().nullable(),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/integration/messages/read-receipts.test.ts tests/integration/messages/message-api.test.ts tests/integration/messages/secret-chat-api.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/messages/web/message-presenter.service.ts \
  src/modules/messages/web/message.controller.ts \
  src/modules/messages/web/dto/message.openapi.ts \
  tests/integration/messages/read-receipts.test.ts
git commit -m "feat(messaging): expose mutual readAt on message responses"
```

---

### Task 7: Documentation and full verification gate

**Files:**
- Modify: `README.md`
- No code changes.

**Interfaces:**
- Consumes: the `POST /api/chats/:chatId/read` route and the new `readAt` / `unreadCount` fields from Tasks 4–6.
- Produces: operator-facing documentation.

- [ ] **Step 1: Add the route to the messaging table**

In `README.md`, in the `### Messaging` route table after the `GET /api/chats` row, insert:

```markdown
| `POST`   | `/api/chats/:chatId/read`                        | Advance the caller's read watermark             |
```

- [ ] **Step 2: Document read receipts**

In `README.md`, after the paragraph ending "`GET /api/chats`." (line 308, immediately before `### Media messages`), insert:

```markdown
### Read receipts

Reading is explicit: `POST /api/chats/:chatId/read` accepts an optional
`{ "messageId": "<uuid>" }` and advances the caller's watermark up to that
message, or to the newest message when omitted. A watermark never moves
backwards, and a `messageId` from another chat returns `404 NOT_FOUND`.
`GET /api/chats/:chatId/messages` never changes read state. Read state is stored
per membership as `last_read_message_id` plus a database-generated
`last_read_at`; it is metadata only and works in secret chats without reading
their ciphertext.

Chat rows include `unreadCount`, the number of live incoming messages newer
than the caller's watermark. This count is caller-private and is always
available. Message rows include `readAt`, populated with the peer's watermark
timestamp only for a message the viewer sent, only when it is at or below the
peer's watermark, and only when **both** peers have
`readReceiptsEnabled = true`. If either peer disables it, `readAt` is `null` in
both directions, while each peer's own unread counts keep working. `readAt` is
also `null` for deleted messages and for incoming messages.
```

- [ ] **Step 3: Run the full verification gate**

Run: `npm run verify`
Expected: typecheck, Biome lint, build, and all Vitest suites pass. If ClamAV is required for the media suites, start it with `docker compose --profile scan up -d clamav`, wait for `healthy`, rerun, then stop it again with `docker compose --profile scan stop clamav`.

Run: `npm run db:check`
Expected: `Everything's fine 🐶🔥`.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(messaging): document read receipts and unread counts"
```

---

### Task 8: Live HTTP smoke and cleanup (executed by the controller at handoff)

**Files:**
- No repository changes; evidence is written to `/tmp/opencode/read-receipts-smoke-report.md`.

**Interfaces:**
- Consumes: the running API from `npm run dev` on `http://127.0.0.1:4000`, with PostgreSQL, Redis, and MinIO already up.
- Produces: pass/fail evidence for every success and error path, and a clean database.

- [ ] **Step 1: Start the API and register two verified users over HTTP**

Start `npm run dev` in the background, record its PID, and wait for `GET /health/live` to return 200. Register two users with `POST /api/auth/register`, then mark them verified with a controlled DB update (`UPDATE users SET email_verified_at = now() WHERE email LIKE 'rr-smoke-%@example.test'`) and re-authenticate to get fresh tokens.

- [ ] **Step 2: Exercise the success paths**

- `POST /api/chats` → 201; `POST /api/chats/:id/messages` twice from user B → 201.
- `POST /api/chats/:id/read` without a body → 200 with `lastReadMessageId` equal to the newest id.
- `GET /api/chats` as A → `unreadCount: 0`; as B → `unreadCount: 2`.
- `GET /api/chats/:id/messages` as B → both own messages have a non-null `readAt`.
- Set `readReceiptsEnabled: false` for A via `PATCH /api/auth/me/privacy`; repeat the list as B → `readAt: null`; restore to `true` → non-null again.
- Open a secret chat with `POST /api/chats/secret` after registering E2EE devices for both users (use a Node script with `generateKeyPairSync('ed25519')` and the signatures from `tests/helpers/e2ee-keys.ts`), send one secret message, mark it read, and confirm `ciphertext` is unchanged in history.

- [ ] **Step 3: Exercise the error paths**

- `POST /api/chats/:id/read` with a `messageId` from another chat → `404 NOT_FOUND`.
- malformed `messageId` → `400 VALIDATION_ERROR`; no bearer token → `401`; unverified user → `403 EMAIL_NOT_VERIFIED`; non-member → `403 NOT_CHAT_MEMBER`.

- [ ] **Step 4: Clean up**

Delete smoke messages via `DELETE /api/chats/:id/messages/:messageId` (204), then delete smoke users in FK-safe order (`DELETE FROM chats WHERE created_by IN (...)`, then `DELETE FROM users WHERE email LIKE 'rr-smoke-%@example.test'`). Confirm final counts are zero for smoke-email users, their chats, and their messages. Stop the API process and confirm port 4000 is closed. Leave PostgreSQL, Redis, and MinIO running as found.

- [ ] **Step 5: Write the report**

Save the pass/fail table and cleanup evidence to `/tmp/opencode/read-receipts-smoke-report.md` and include it in the final handoff.
