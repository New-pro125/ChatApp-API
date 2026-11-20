# Self-destructing Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-chat, per-sender self-destruct presets (`24h`, `7d`, `90d`, off) so a sender's later cloud text, media, secret-ciphertext, and forwarded messages get a server-computed expiry, disappear from all reads immediately at that deadline, and are scrubbed by a repeatable worker without regressing E2EE, privacy, media GC, pins, or read receipts.

**Architecture:** Store the caller's preset on `chat_members` and an optional `expires_at` on `messages`. Message creation resolves the sender's preset and writes the server-computed deadline; every message read/lookup adds `expires_at is null or expires_at > now()`. A BullMQ worker hosted by the messages module lists expired rows, removes pins, releases media after the last live reference, and conditionally clears content while retaining tombstone metadata. The only new HTTP surface is `PATCH /api/chats/:chatId/self-destruct` plus a `selfDestructPreset` field on chat-list items; message responses are unchanged.

**Tech Stack:** Node 24, TypeScript 7.0.2, ESM (`@/` aliases, explicit `.js`), Express 5, Inversify 8 child containers, Drizzle ORM + PostgreSQL 18 (16 hash partitions), Zod, BullMQ 6.7.2 on the existing node-redis client, Vitest + Supertest, Biome.

**Spec:** `docs/superpowers/specs/2026-11-19-self-destructing-messages-design.md`

## Global Constraints

- Presets are exactly `24h`, `7d`, and `90d`, mapping to `86_400`, `604_800`, and `7_776_000` seconds; `null` means off. No custom durations and no env-configured preset list.
- Timer state is keyed by `(chat, user)`. Each participant changes only their own setting. Changes are not retroactive.
- The server computes `expiresAt` from its own clock at send time; requests never carry an absolute expiry.
- Individual message responses must not expose `expiresAt`, a timer flag, or remaining time. Only `GET /api/chats` exposes the caller's own `selfDestructPreset`.
- Every message read/lookup adds `expires_at is null or expires_at > now()`; it does **not** change existing manual-delete tombstone behavior. `listByChat` still shows manual tombstones with a null body.
- Expired targets behave as `404 NOT_FOUND` for edit, delete, forward, pin, unpin, mark-read, and reply targets.
- Scrub keeps id, chat, sender, created/edited/deleted/expires timestamps, and reply/forward ids; it clears body, ciphertext, nonce, ephemeral key, device ids, and all media columns.
- Media is released only after the last live, non-expired reference is gone; release happens before scrub so a failed release can be retried.
- Reuse existing error codes only: `400 VALIDATION_ERROR`, `401 UNAUTHORIZED`, `403 NOT_CHAT_MEMBER`/`EMAIL_NOT_VERIFIED`/`E2EE_NOT_ALLOWED`, `404 NOT_FOUND`. No new codes and no `ErrorMapper` changes.
- All JSON goes through `ApiResponse`; controllers never call `res.json`.
- Domain/data layers contain no Express types or HTTP status codes; services depend on ports.
- Config is read only through `EnvironmentReader` in `AppConfig`; no other file reads `process.env`.
- Every relative ESM import uses an explicit `.js` extension; use `@/...` aliases.
- Biome: single quotes, semicolons, trailing commas, 2-space indentation, 100-character lines, organized imports. Prefer `unknown` over `any`.
- Keep `plan.md` untracked and out of every commit. The spec and this plan are gitignored; force-add them with the first feature commit if following repository precedent.
- Definition of done: `npm run verify` and `npm run db:check` pass; live HTTP smoke covers success + error paths; temporary users removed; API and ClamAV stopped; PostgreSQL/Redis/MinIO left running.

## Review Focus

- **Elapsed message still visible in history or unread counts** → Task 3 test `hides elapsed messages from find/list/count/max while preserving manual tombstones`; Task 4 HTTP test `hides elapsed messages and returns 404 for targets`.
- **Per-sender isolation and non-retroactivity** → Task 2 HTTP test `changes only the caller's setting`; Task 4 HTTP test `later sends inherit the sender's current preset without rewriting existing expiries`.
- **Secret-chat plaintext or E2EE regression** → Task 4 test `secret ciphertext gets a hidden expiry and scrub never decrypts`; Task 5 worker test `scrub clears ciphertext metadata`.
- **Shared media leak or premature delete** → Task 5 test `releases media only after the last live forward expires`.
- **Worker retry/overlap behavior** → Task 5 tests `failed media release retries before scrub` and `scrub is idempotent under repeat runs`.

---

### Task 1: Schema, migration, domain values, records, mappers, and ports

**Files:**
- Modify: `src/core/database/schema/messaging.schema.ts`
- Create: `drizzle/0017_<generated>.sql` and its `drizzle/meta/0017_snapshot.json`; update `drizzle/meta/_journal.json`
- Create: `src/modules/messages/logic/entities/self-destruct-preset.ts`
- Create: `src/modules/messages/logic/entities/self-destruct-timer.ts`
- Modify: `src/modules/messages/logic/entities/chat-member-record.ts`
- Modify: `src/modules/messages/logic/entities/chat-view.ts`
- Modify: `src/modules/messages/logic/entities/message-record.ts`
- Modify: `src/modules/messages/data/chat-member.mapper.ts`
- Modify: `src/modules/messages/data/message.mapper.ts`
- Modify: `src/modules/messages/logic/ports/chat-member.repository.ts`
- Modify: `src/modules/messages/logic/ports/message.repository.ts`
- Test: `tests/integration/messages/messaging-schema.test.ts`

**Interfaces:**
- Consumes: existing `chatMembers`, `messages`, `chatMemberSelection`, `messageSelection`.
- Produces: `SelfDestructPreset`, `SELF_DESTRUCT_PRESETS`, `SelfDestructTimer.expiryFor(preset, now?)`, `ChatMemberRecord.selfDestructPreset`, `ChatView.selfDestructPreset`, `MessageRecord.expiresAt`, `ChatMemberRepository.setSelfDestructPreset(chatId, userId, preset)`, `MessageRepository.listExpired(now, limit)` and `scrubExpired(chatId, id, deletedAt)`, and optional `expiresAt` on both create inputs.

- [ ] **Step 1: Commit the approved spec and plan on the feature branch**

On the execution branch (created with the worktree skill), run:

```bash
git add -f docs/superpowers/specs/2026-11-19-self-destructing-messages-design.md docs/superpowers/plans/2026-11-19-self-destructing-messages.md
git commit -m "docs(messaging): specify and plan self-destructing messages"
```

Do not add `plan.md`.

- [ ] **Step 2: Write the failing schema test**

Add these assertions to `tests/integration/messages/messaging-schema.test.ts` inside the existing chat-member and message schema tests, or add a new `it` after the pin test if that is cleaner:

```ts
  it('stores per-member self-destruct presets and per-message expiries', async () => {
    const memberColumns = await app.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'chat_members' ORDER BY ordinal_position`,
    );
    expect(memberColumns.rows.map((row) => row.column_name)).toContain('self_destruct_preset');

    const memberChecks = await app.pool.query<{ constraint_name: string }>(
      `SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_name = 'chat_members' AND constraint_type = 'CHECK'`,
    );
    expect(memberChecks.rows.map((row) => row.constraint_name)).toContain(
      'chat_members_self_destruct_preset_check',
    );

    const messageColumns = await app.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'messages' ORDER BY ordinal_position`,
    );
    expect(messageColumns.rows.map((row) => row.column_name)).toContain('expires_at');

    const messageChecks = await app.pool.query<{ constraint_name: string }>(
      `SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_name = 'messages' AND constraint_type = 'CHECK'`,
    );
    expect(messageChecks.rows.map((row) => row.constraint_name)).toContain(
      'messages_expires_at_check',
    );

    const messageIndexes = await app.pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'messages' ORDER BY indexname`,
    );
    expect(messageIndexes.rows.map((row) => row.indexname)).toContain('messages_expires_at_index');
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/integration/messages/messaging-schema.test.ts 2>&1 | tail -30`
Expected: FAIL because the columns, check constraints, and index do not exist yet.

- [ ] **Step 4: Update the Drizzle schema**

In `src/core/database/schema/messaging.schema.ts`, add the preset column to `chatMembers` after `lastReadAt`:

```ts
    lastReadMessageId: uuid('last_read_message_id'),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }),
    selfDestructPreset: text('self_destruct_preset'),
```

Add the check beside the existing chat-member checks:

```ts
    check(
      'chat_members_self_destruct_preset_check',
      sql`${table.selfDestructPreset} is null or ${table.selfDestructPreset} in ('24h', '7d', '90d')`,
    ),
```

Add the expiry column to `messages` after `createdAt`:

```ts
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ciphertext: text('ciphertext'),
```

Add the check and index to the `messages` table configuration:

```ts
    check(
      'messages_expires_at_check',
      sql`${table.expiresAt} is null or ${table.expiresAt} > ${table.createdAt}`,
    ),
    index('messages_expires_at_index').on(table.expiresAt),
```

- [ ] **Step 5: Generate and review the migration**

Run: `npm run db:generate`

Open the generated `drizzle/0017_*.sql`. Expected final SQL shape (keep the exact generated type expression if different):

```sql
ALTER TABLE "chat_members" ADD COLUMN "self_destruct_preset" text;
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_self_destruct_preset_check"
  CHECK ("self_destruct_preset" is null or "self_destruct_preset" in ('24h', '7d', '90d'));
ALTER TABLE "messages" ADD COLUMN "expires_at" timestamp with time zone;
ALTER TABLE "messages" ADD CONSTRAINT "messages_expires_at_check"
  CHECK ("expires_at" is null or "expires_at" > "created_at");
CREATE INDEX "messages_expires_at_index" ON "messages" ("expires_at");
```

Do not add a backfill: existing rows mean “no timer.” Do not edit any already-applied migration.

- [ ] **Step 6: Apply the migration and run schema checks**

Run: `npm run db:migrate && npm run db:check`
Expected: migration applies; `Everything's fine 🐶🔥`.

- [ ] **Step 7: Add the domain values**

Create `src/modules/messages/logic/entities/self-destruct-preset.ts`:

```ts
export const SELF_DESTRUCT_PRESETS = ['24h', '7d', '90d'] as const;

export type SelfDestructPreset = (typeof SELF_DESTRUCT_PRESETS)[number];
```

Create `src/modules/messages/logic/entities/self-destruct-timer.ts`:

```ts
import type { SelfDestructPreset } from '@/modules/messages/logic/entities/self-destruct-preset.js';

/** Maps API presets to server-computed deadlines. */
export class SelfDestructTimer {
  static readonly seconds: Readonly<Record<SelfDestructPreset, number>> = {
    '24h': 86_400,
    '7d': 604_800,
    '90d': 7_776_000,
  };

  static expiryFor(preset: SelfDestructPreset | null, now: Date = new Date()): Date | null {
    return preset === null ? null : new Date(now.getTime() + this.seconds[preset] * 1000);
  }
}
```

- [ ] **Step 8: Extend records and mappers**

Replace `src/modules/messages/logic/entities/chat-member-record.ts` with:

```ts
import type { SelfDestructPreset } from '@/modules/messages/logic/entities/self-destruct-preset.js';

export type ChatMemberRole = 'member' | 'admin' | 'owner';

/**
 * A user's membership in a chat.
 *
 * `leftAt` is reserved for a future leave model; 2.1 removes members by
 * deleting the row. The read watermark is a monotonic per-membership cursor:
 * `null` means nothing has been read yet. `selfDestructPreset` is the caller's
 * own timer for messages they send in this chat.
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
    readonly selfDestructPreset: SelfDestructPreset | null = null,
  ) {}
}
```

In `src/modules/messages/logic/entities/chat-view.ts`, import the preset type and add the property to the constructor:

```ts
import type { SelfDestructPreset } from '@/modules/messages/logic/entities/self-destruct-preset.js';

  constructor(
    chat: ChatRecord,
    readonly participants: readonly UserSummary[],
    readonly unreadCount: number,
    readonly selfDestructPreset: SelfDestructPreset | null = null,
  ) {
```

In `src/modules/messages/logic/entities/message-record.ts`, add `expiresAt` as the last constructor parameter:

```ts
    readonly recipientDeviceId: string | null,
    readonly media: MessageMediaFields | null = null,
    readonly expiresAt: Date | null = null,
  ) {}
```

In `src/modules/messages/data/chat-member.mapper.ts`, add the selection field and pass it to the record:

```ts
  lastReadMessageId: chatMembers.lastReadMessageId,
  lastReadAt: chatMembers.lastReadAt,
  selfDestructPreset: chatMembers.selfDestructPreset,
```

```ts
      row.lastReadMessageId,
      row.lastReadAt,
      row.selfDestructPreset as SelfDestructPreset | null,
    );
```

Add the import:

```ts
import type { SelfDestructPreset } from '@/modules/messages/logic/entities/self-destruct-preset.js';
```

In `src/modules/messages/data/message.mapper.ts`, add the selection field and pass it as the final constructor argument:

```ts
  createdAt: messages.createdAt,
  expiresAt: messages.expiresAt,
  ciphertext: messages.ciphertext,
```

```ts
      row.mediaId === null || row.mediaKind === null
        ? null
        : {
            mediaId: row.mediaId,
            kind: row.mediaKind as MessageKind,
            caption: row.caption,
            durationMs: row.durationMs,
            width: row.width,
            height: row.height,
          },
      row.expiresAt,
    );
```

Use the existing `MessageKind`/`MediaKind` name already imported in that file; keep the current cast unchanged.

- [ ] **Step 9: Extend the ports**

In `src/modules/messages/logic/ports/chat-member.repository.ts`, add the import and method:

```ts
import type { SelfDestructPreset } from '@/modules/messages/logic/entities/self-destruct-preset.js';

  /** Updates only this user's timer for this chat. */
  setSelfDestructPreset(
    chatId: string,
    userId: string,
    preset: SelfDestructPreset | null,
  ): Promise<ChatMemberRecord>;
```

In `src/modules/messages/logic/ports/message.repository.ts`, add `expiresAt` to both create inputs and add the worker methods:

```ts
export interface CreateMessageInput {
  // ...existing fields...
  expiresAt?: Date | null;
}

export interface CreateSecretMessageInput {
  // ...existing fields...
  expiresAt?: Date | null;
}

  /** Live rows whose deadline has passed, oldest deadline first. */
  listExpired(now: Date, limit: number): Promise<MessageRecord[]>;

  /**
   * Conditionally clears content on one still-live expired row.
   * Returns false when a row was missing, already scrubbed, or not expired.
   */
  scrubExpired(chatId: string, id: string, deletedAt: Date): Promise<boolean>;
```

- [ ] **Step 10: Run typecheck and the schema test**

Run: `npm run typecheck 2>&1 | tail -30; npx vitest run tests/integration/messages/messaging-schema.test.ts 2>&1 | tail -15`
Expected: schema test passes. Typecheck may fail only in Task 2/3 files where the new port methods are not implemented yet; those are fixed in the next tasks.

- [ ] **Step 11: Commit**

```bash
git add src/core/database/schema/messaging.schema.ts drizzle src/modules/messages/logic/entities src/modules/messages/data/chat-member.mapper.ts src/modules/messages/data/message.mapper.ts src/modules/messages/logic/ports tests/integration/messages/messaging-schema.test.ts
git commit -m "feat(messaging): add self-destruct timer schema and domain values"
```

---

### Task 2: Per-chat setting persistence and HTTP surface

**Files:**
- Modify: `src/modules/messages/data/postgres-chat-member.repository.ts`
- Modify: `src/modules/messages/logic/chat.service.ts`
- Modify: `src/modules/messages/web/chat.controller.ts`
- Modify: `src/modules/messages/web/routes/messages.router.ts`
- Modify: `src/modules/messages/web/dto/message.schemas.ts`
- Modify: `src/modules/messages/web/dto/message.openapi.ts`
- Create: `tests/integration/messages/self-destruct-setting.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `SelfDestructPreset`, `SELF_DESTRUCT_PRESETS`, `ChatMemberRepository.setSelfDestructPreset`, `ChatView.selfDestructPreset`.
- Produces: `PATCH /api/chats/:chatId/self-destruct` with body `{ preset }` and response `{ preset }`; `ChatView.selfDestructPreset` in `GET /api/chats`, direct-chat, and secret-chat responses; Zod schemas `selfDestructPresetSchema` and `setSelfDestructSchema`.

- [ ] **Step 1: Write the failing HTTP/repository test**

Create `tests/integration/messages/self-destruct-setting.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMemberRepository } from '@/modules/messages/logic/ports/chat-member.repository.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import { expectError, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';
import { MessagingApiFixture } from './messaging-api.fixture.js';

interface PresetResponse {
  preset: '24h' | '7d' | '90d' | null;
}

interface ChatResponse {
  id: string;
  selfDestructPreset: '24h' | '7d' | '90d' | null;
}

describe('per-chat self-destruct settings', () => {
  let app: TestApp;
  let fixture: MessagingApiFixture;
  let members: ChatMemberRepository;

  beforeAll(async () => {
    app = await TestApp.create();
    fixture = new MessagingApiFixture(app);
    members = app.container.get<ChatMemberRepository>(MESSAGES_TYPES.ChatMemberRepository);
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

  it('changes only the caller setting and exposes it in chat lists', async () => {
    const { alice, bob, chatId } = await pair();

    const set = expectSuccess<PresetResponse>(
      await app.request
        .patch(`/api/chats/${chatId}/self-destruct`)
        .set(alice.headers)
        .send({ preset: '7d' }),
      200,
    );
    expect(set.preset).toBe('7d');
    expect((await members.find(chatId, alice.id))?.selfDestructPreset).toBe('7d');
    expect((await members.find(chatId, bob.id))?.selfDestructPreset).toBeNull();

    const aliceChats = expectSuccess<ChatResponse[]>(
      await app.request.get('/api/chats').set(alice.headers),
      200,
    );
    expect(aliceChats.find((chat) => chat.id === chatId)?.selfDestructPreset).toBe('7d');
    const bobChats = expectSuccess<ChatResponse[]>(
      await app.request.get('/api/chats').set(bob.headers),
      200,
    );
    expect(bobChats.find((chat) => chat.id === chatId)?.selfDestructPreset).toBeNull();

    expect(
      expectSuccess<PresetResponse>(
        await app.request
          .patch(`/api/chats/${chatId}/self-destruct`)
          .set(alice.headers)
          .send({ preset: '90d' }),
        200,
      ).preset,
    ).toBe('90d');
    expect(
      expectSuccess<PresetResponse>(
        await app.request
          .patch(`/api/chats/${chatId}/self-destruct`)
          .set(alice.headers)
          .send({ preset: null }),
        200,
      ).preset,
    ).toBeNull();
  });

  it('rejects invalid, missing, unauthenticated, and non-member updates', async () => {
    const { alice, chatId } = await pair();

    expectError(
      await app.request
        .patch(`/api/chats/${chatId}/self-destruct`)
        .set(alice.headers)
        .send({ preset: '1h' }),
      400,
      'VALIDATION_ERROR',
    );
    expectError(
      await app.request.patch(`/api/chats/${chatId}/self-destruct`).set(alice.headers).send({}),
      400,
      'VALIDATION_ERROR',
    );
    expectError(
      await app.request
        .patch(`/api/chats/${chatId}/self-destruct`)
        .send({ preset: '24h' }),
      401,
      'UNAUTHORIZED',
    );

    const outsider = await fixture.verifiedUser('Outsider');
    expectError(
      await app.request
        .patch(`/api/chats/${chatId}/self-destruct`)
        .set(outsider.headers)
        .send({ preset: '24h' }),
      403,
      'NOT_CHAT_MEMBER',
    );
  });

  it('blocks unverified callers', async () => {
    const { bob, chatId } = await pair();
    const unverified = await fixture.unverifiedUser('Unverified');
    await fixture.openDirectChat(unverified.id, bob.headers);

    expectError(
      await app.request
        .patch(`/api/chats/${chatId}/self-destruct`)
        .set(unverified.headers)
        .send({ preset: '24h' }),
      403,
      'EMAIL_NOT_VERIFIED',
    );
  });
});
```

Note: replace `app.container.get` with the same root access pattern used by existing tests if `TestApp` does not expose `container` directly; the pin worker test uses `new MessagesContainer(new Container({ parent: app.container }))`, which also works here.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/messages/self-destruct-setting.test.ts 2>&1 | tail -30`
Expected: FAIL with 404/route or type errors because the endpoint does not exist yet.

- [ ] **Step 3: Implement the repository method**

In `src/modules/messages/data/postgres-chat-member.repository.ts`, add the import and method:

```ts
import type { SelfDestructPreset } from '@/modules/messages/logic/entities/self-destruct-preset.js';
```

```ts
  async setSelfDestructPreset(
    chatId: string,
    userId: string,
    preset: SelfDestructPreset | null,
  ): Promise<ChatMemberRecord> {
    try {
      const rows = await this.db
        .update(chatMembers)
        .set({ selfDestructPreset: preset })
        .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)))
        .returning(chatMemberSelection);

      const updated = rows[0];

      if (!updated) {
        throw new PersistenceException('Failed to set self-destruct preset: membership not found');
      }

      return this.mapper.toRecord(updated);
    } catch (error) {
      if (error instanceof PersistenceException) {
        throw error;
      }

      throw new PersistenceException('Failed to set self-destruct preset', { cause: error });
    }
  }
```

- [ ] **Step 4: Extend ChatService**

In `src/modules/messages/logic/chat.service.ts`, import the preset type and add the public method after `openSecret`:

```ts
import type { SelfDestructPreset } from '@/modules/messages/logic/entities/self-destruct-preset.js';
```

```ts
  async setSelfDestructPreset(
    userId: string,
    chatId: string,
    preset: SelfDestructPreset | null,
  ): Promise<SelfDestructPreset | null> {
    await this.policy.requireMember(chatId, userId);
    const member = await this.members.setSelfDestructPreset(chatId, userId, preset);

    return member.selfDestructPreset;
  }
```

In `listForUser`, build a viewer map after loading memberships:

```ts
    const viewerPresetByChat = new Map(
      memberships
        .filter((membership) => membership.userId === userId)
        .map((membership) => [membership.chatId, membership.selfDestructPreset]),
    );
```

Change the `ChatView` construction at the end of `listForUser`:

```ts
    return chats.map(
      (chat) =>
        new ChatView(
          chat,
          byChat.get(chat.id) ?? [],
          unread.get(chat.id) ?? 0,
          viewerPresetByChat.get(chat.id) ?? null,
        ),
    );
```

Change `toView` to pass the viewer's own preset:

```ts
    const viewer = memberships.find((member) => member.userId === viewerId);

    return new ChatView(chat, participants, unread.get(chat.id) ?? 0, viewer?.selfDestructPreset ?? null);
```

- [ ] **Step 5: Add the DTO and OpenAPI contract**

In `src/modules/messages/web/dto/message.schemas.ts`, add:

```ts
import { SELF_DESTRUCT_PRESETS } from '@/modules/messages/logic/entities/self-destruct-preset.js';

/** Caller-scoped self-destruct preset; null clears the caller's timer. */
export const selfDestructPresetSchema = z.enum(SELF_DESTRUCT_PRESETS);

export const setSelfDestructSchema = z.object({
  preset: selfDestructPresetSchema.nullable(),
});
```

In `src/modules/messages/web/dto/message.openapi.ts`, import the new schemas:

```ts
  selfDestructPresetSchema,
  setSelfDestructSchema,
```

Add the field to `chatSchema`:

```ts
    unreadCount: z.number().int().nonnegative(),
    selfDestructPreset: selfDestructPresetSchema.nullable(),
```

Add a response envelope after `pinResponse`:

```ts
const selfDestructResponse = successEnvelope(
  z.object({ preset: selfDestructPresetSchema.nullable() }),
  'SelfDestructSettingResponse',
);
```

Add the contract after `markRead`:

```ts
  setSelfDestruct: {
    operationId: 'chats.setSelfDestruct',
    tags: ['Chats'],
    summary: "Set the caller's self-destruct preset for a chat",
    description:
      'Sets or clears only the caller self-destruct preset for this chat. Later messages sent by the caller inherit it; existing messages are unchanged. The peer setting is never returned.',
    security: bearerSecurity,
    request: { params: chatParamsSchema, body: setSelfDestructSchema },
    responses: {
      200: { description: 'The updated caller setting', schema: selfDestructResponse },
      ...commonErrorResponses,
    },
  },
```

- [ ] **Step 6: Add the controller and route**

In `src/modules/messages/web/chat.controller.ts`, import and add the handler:

```ts
  setSelfDestruct: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const { chatId } = chatParamsSchema.parse(req.params);
    const { preset } = setSelfDestructSchema.parse(req.body);
    const updated = await this.chats.setSelfDestructPreset(user.id, chatId, preset);

    this.response.ok(res, { preset: updated });
  };
```

Add the import:

```ts
  setSelfDestructSchema,
```

Add the field to the private `present` method:

```ts
      unreadCount: chat.unreadCount,
      selfDestructPreset: chat.selfDestructPreset,
```

In `src/modules/messages/web/routes/messages.router.ts`, add the route after `markRead`:

```ts
    routes.patch(
      '/:chatId/self-destruct',
      messageContracts.setSelfDestruct,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container.get<ChatController>(MESSAGES_TYPES.ChatController).setSelfDestruct(req, res, next),
    );
```

- [ ] **Step 7: Document the endpoint**

Add this subsection to `README.md` under the messaging/pinning section:

```md
### Self-destruct presets

Each participant controls their own timer per chat. `PATCH /api/chats/:chatId/self-destruct`
accepts `{ "preset": "24h" | "7d" | "90d" | null }`; `null` clears the caller's timer.
The response is `{ "preset": ... }`. Changing or clearing the preset affects only later
messages sent by that caller, never existing messages or the peer's messages.

Every chat returned by `GET /api/chats` includes `selfDestructPreset`, which is the
caller's own setting for that chat (`null` when off). The peer's setting is never returned,
and individual message responses never include expiry or countdown metadata.
```

- [ ] **Step 8: Run the setting test and typecheck**

Run: `npm run typecheck 2>&1 | tail -20; npx vitest run tests/integration/messages/self-destruct-setting.test.ts 2>&1 | tail -20`
Expected: typecheck may still fail in `PostgresMessageRepository` because Task 3 ports are not implemented; the setting test passes.

- [ ] **Step 9: Commit**

```bash
git add src/modules/messages/data/postgres-chat-member.repository.ts src/modules/messages/logic/chat.service.ts src/modules/messages/web/chat.controller.ts src/modules/messages/web/routes/messages.router.ts src/modules/messages/web/dto/message.schemas.ts src/modules/messages/web/dto/message.openapi.ts tests/integration/messages/self-destruct-setting.test.ts README.md
git commit -m "feat(messaging): add per-chat self-destruct settings"
```

---

### Task 3: Repository expiry filtering and scrub operations

**Files:**
- Modify: `src/modules/messages/data/postgres-message.repository.ts`
- Create: `tests/integration/messages/message-expiry-repository.test.ts`

**Interfaces:**
- Consumes: optional `expiresAt` on create inputs; `MessageRecord.expiresAt`; `messages.expiresAt`.
- Produces: `findById`, `listByChat`, `listByIds`, `maxIdByChat`, `countUnread`, `countUnreadByChats`, and `hasLiveMediaReferences` all add the not-expired predicate; `listExpired(now, limit)`; `scrubExpired(chatId, id, deletedAt)`.

- [ ] **Step 1: Write the failing repository tests**

Create `tests/integration/messages/message-expiry-repository.test.ts`:

```ts
import { Container } from 'inversify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMemberRepository } from '@/modules/messages/logic/ports/chat-member.repository.js';
import type { ChatRepository } from '@/modules/messages/logic/ports/chat.repository.js';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import { MessagesContainer } from '@/modules/messages/messages.container.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { TestApp } from '../../helpers/test-app.js';

describe('message expiry repository behavior', () => {
  let app: TestApp;
  let auth: AuthFixture;
  let chats: ChatRepository;
  let members: ChatMemberRepository;
  let messages: MessageRepository;

  beforeAll(async () => {
    app = await TestApp.create();
    auth = new AuthFixture(app);
    const container = new MessagesContainer(new Container({ parent: app.container }));
    chats = container.get(MESSAGES_TYPES.ChatRepository);
    members = container.get(MESSAGES_TYPES.ChatMemberRepository);
    messages = container.get(MESSAGES_TYPES.MessageRepository);
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

  function age(chatId: string, messageId: string): Promise<unknown> {
    return app.pool.query(
      `UPDATE messages SET expires_at = now() - interval '1 second'
       WHERE chat_id = $1 AND id = $2`,
      [chatId, messageId],
    );
  }

  it('hides elapsed messages from find/list/count/max while preserving manual tombstones', async () => {
    const { bob, chat } = await setup();
    const expiring = await messages.create({
      chatId: chat.id,
      senderId: bob.id,
      body: 'expiring',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const manual = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'manual' });
    await messages.markDeleted(chat.id, manual.id, new Date());
    await age(chat.id, expiring.id);

    expect(await messages.findById(chat.id, expiring.id)).toBeNull();
    expect((await messages.listByChat(chat.id, { limit: 10 })).map((row) => row.id)).toEqual([
      manual.id,
    ]);
    expect((await messages.listByIds(chat.id, [expiring.id])).map((row) => row.id)).toEqual([]);
    expect(await messages.maxIdByChat(chat.id)).toBe(manual.id);
    expect(await messages.countUnread(chat.id, bob.id, null)).toBe(0);

    const manualRow = await messages.findById(chat.id, manual.id);
    expect(manualRow?.body).toBeNull();
    expect(manualRow?.deletedAt).not.toBeNull();
  });

  it('lists only elapsed live rows and scrubs content idempotently', async () => {
    const { bob, chat } = await setup();
    const expired = await messages.create({
      chatId: chat.id,
      senderId: bob.id,
      body: 'secret text in a plain row',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const active = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'active' });
    await age(chat.id, expired.id);

    const due = await messages.listExpired(new Date(), 10);
    expect(due.map((row) => row.id)).toEqual([expired.id]);

    expect(await messages.scrubExpired(chat.id, expired.id, new Date())).toBe(true);
    expect(await messages.scrubExpired(chat.id, expired.id, new Date())).toBe(false);

    const raw = await app.pool.query<{
      body: string | null;
      deleted_at: Date | null;
      expires_at: Date | null;
      sender_id: string;
    }>(
      `SELECT body, deleted_at, expires_at, sender_id FROM messages
       WHERE chat_id = $1 AND id = $2`,
      [chat.id, expired.id],
    );
    expect(raw.rows[0]).toMatchObject({
      body: null,
      expires_at: expect.any(Date),
      sender_id: bob.id,
    });
    expect(raw.rows[0]?.deleted_at).not.toBeNull();
    expect((await messages.listExpired(new Date(), 10)).map((row) => row.id)).toEqual([]);
    expect((await messages.listByChat(chat.id, { limit: 10 })).map((row) => row.id)).toEqual([
      active.id,
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/messages/message-expiry-repository.test.ts 2>&1 | tail -30`
Expected: FAIL because expiry filtering and `listExpired`/`scrubExpired` are not implemented.

- [ ] **Step 3: Implement filtering and persistence**

Replace `src/modules/messages/data/postgres-message.repository.ts` with the existing implementation extended as follows. Keep all existing methods and error wrapping; add these imports:

```ts
import { and, asc, desc, eq, gt, inArray, isNull, le, lt, ne, or, sql } from 'drizzle-orm';
```

Add a private predicate to `PostgresMessageRepository`:

```ts
  private notExpired() {
    return or(isNull(messages.expiresAt), gt(messages.expiresAt, new Date()));
  }
```

In `create` and `createSecret`, add the expiry to the inserted values:

```ts
            forwardedFromMessageId: input.forwardedFromMessageId ?? null,
            expiresAt: input.expiresAt ?? null,
```

```ts
            recipientDeviceId: input.recipientDeviceId,
            expiresAt: input.expiresAt ?? null,
```

Add `this.notExpired()` to these existing `where` clauses:

```ts
        .where(and(eq(messages.chatId, chatId), eq(messages.id, id), this.notExpired()))
```

```ts
            inArray(messages.id, [...ids]),
            isNull(messages.deletedAt),
            this.notExpired(),
```

```ts
    const conditions = [eq(messages.chatId, chatId), this.notExpired()];
```

```ts
        .where(eq(messages.chatId, chatId))
```
becomes:
```ts
        .where(and(eq(messages.chatId, chatId), this.notExpired()))
```

```ts
        isNull(messages.deletedAt),
        this.notExpired(),
```

In `countUnreadByChats`, add it after `isNull(messages.deletedAt)`:

```ts
            isNull(messages.deletedAt),
            this.notExpired(),
```

In `hasLiveMediaReferences`, add it:

```ts
        .where(
          and(
            eq(messages.mediaId, mediaId),
            isNull(messages.deletedAt),
            this.notExpired(),
          ),
        )
```

Add the two new methods before the final closing brace:

```ts
  async listExpired(now: Date, limit: number): Promise<MessageRecord[]> {
    try {
      const rows = await this.db
        .select(messageSelection)
        .from(messages)
        .where(and(isNull(messages.deletedAt), le(messages.expiresAt, now)))
        .orderBy(asc(messages.expiresAt))
        .limit(limit)
        .for('update', { skipLocked: true });

      return rows.map((row) => this.mapper.toRecord(row));
    } catch (error) {
      throw new PersistenceException('Failed to list expired messages', { cause: error });
    }
  }

  async scrubExpired(chatId: string, id: string, deletedAt: Date): Promise<boolean> {
    try {
      const rows = await this.db
        .update(messages)
        .set({
          deletedAt,
          body: null,
          ciphertext: null,
          nonce: null,
          ephemeralPublicKey: null,
          senderDeviceId: null,
          recipientDeviceId: null,
          mediaId: null,
          mediaKind: null,
          caption: null,
          durationMs: null,
          width: null,
          height: null,
        })
        .where(
          and(
            eq(messages.chatId, chatId),
            eq(messages.id, id),
            isNull(messages.deletedAt),
            le(messages.expiresAt, new Date()),
          ),
        )
        .returning({ id: messages.id });

      return rows.length > 0;
    } catch (error) {
      throw new PersistenceException('Failed to scrub expired message', { cause: error });
    }
  }
```

- [ ] **Step 4: Run the repository test**

Run: `npx vitest run tests/integration/messages/message-expiry-repository.test.ts 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/messages/data/postgres-message.repository.ts tests/integration/messages/message-expiry-repository.test.ts
git commit -m "feat(messaging): filter expired messages and add scrub operations"
```

---

### Task 4: Send-time expiry resolution and HTTP message behavior

**Files:**
- Modify: `src/modules/messages/logic/message.service.ts`
- Create: `tests/integration/messages/message-expiry.test.ts`

**Interfaces:**
- Consumes: `SelfDestructTimer.expiryFor`, `ChatMemberRecord.selfDestructPreset`, filtered `findById`.
- Produces: all message creation paths pass `expiresAt` to the repository; no new response fields.

- [ ] **Step 1: Write the failing HTTP tests**

Create `tests/integration/messages/message-expiry.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import { expectError, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';
import { MessagingApiFixture } from './messaging-api.fixture.js';

interface MessageView {
  id: string;
  body: string | null;
  ciphertext: string | null;
  [key: string]: unknown;
}

describe('self-destructing message behavior', () => {
  let app: TestApp;
  let fixture: MessagingApiFixture;
  let messages: MessageRepository;

  beforeAll(async () => {
    app = await TestApp.create();
    fixture = new MessagingApiFixture(app);
    messages = app.container.get<MessageRepository>(MESSAGES_TYPES.MessageRepository);
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

  function setPreset(headers: Record<string, string>, chatId: string, preset: string | null) {
    return app.request
      .patch(`/api/chats/${chatId}/self-destruct`)
      .set(headers)
      .send({ preset });
  }

  function send(headers: Record<string, string>, chatId: string, body: string) {
    return app.request.post(`/api/chats/${chatId}/messages`).set(headers).send({ body });
  }

  function age(chatId: string, messageId: string) {
    return app.pool.query(
      `UPDATE messages SET expires_at = now() - interval '1 second'
       WHERE chat_id = $1 AND id = $2`,
      [chatId, messageId],
    );
  }

  it('applies only the sender current preset and does not expose expiry on messages', async () => {
    const { alice, bob, chatId } = await pair();
    expectSuccess(await setPreset(alice.headers, chatId, '24h'), 200);

    const first = expectSuccess<MessageView>(await send(alice.headers, chatId, 'first'), 201);
    expect(first).not.toHaveProperty('expiresAt');
    expect(first).not.toHaveProperty('selfDestruct');
    const firstRow = await messages.findById(chatId, first.id);
    expect(firstRow?.expiresAt).not.toBeNull();

    const bobMessage = expectSuccess<MessageView>(await send(bob.headers, chatId, 'bob'), 201);
    expect((await messages.findById(chatId, bobMessage.id))?.expiresAt).toBeNull();

    expectSuccess(await setPreset(alice.headers, chatId, '7d'), 200);
    const second = expectSuccess<MessageView>(await send(alice.headers, chatId, 'second'), 201);
    const firstDeadline = firstRow?.expiresAt?.getTime() ?? 0;
    const secondDeadline = (await messages.findById(chatId, second.id))?.expiresAt?.getTime() ?? 0;
    expect(secondDeadline - firstDeadline).toBeGreaterThan(0);

    expectSuccess(await setPreset(alice.headers, chatId, null), 200);
    const third = expectSuccess<MessageView>(await send(alice.headers, chatId, 'third'), 201);
    expect((await messages.findById(chatId, third.id))?.expiresAt).toBeNull();
  });

  it('hides elapsed messages and returns 404 for expired targets', async () => {
    const { alice, chatId } = await pair();
    expectSuccess(await setPreset(alice.headers, chatId, '24h'), 200);
    const created = expectSuccess<MessageView>(await send(alice.headers, chatId, 'gone'), 201);
    await age(chatId, created.id);

    const history = expectSuccess<MessageView[]>(
      await app.request.get(`/api/chats/${chatId}/messages`).set(alice.headers),
      200,
    );
    expect(history.map((message) => message.id)).not.toContain(created.id);

    expectError(
      await app.request
        .patch(`/api/chats/${chatId}/messages/${created.id}`)
        .set(alice.headers)
        .send({ body: 'edit' }),
      404,
      'NOT_FOUND',
    );
    expectError(
      await app.request.delete(`/api/chats/${chatId}/messages/${created.id}`).set(alice.headers),
      404,
      'NOT_FOUND',
    );
    expectError(
      await app.request
        .post(`/api/chats/${chatId}/messages/${created.id}/pin`)
        .set(alice.headers)
        .send({ durationSeconds: 3600 }),
      404,
      'NOT_FOUND',
    );
    expectError(
      await app.request
        .post(`/api/chats/${chatId}/read`)
        .set(alice.headers)
        .send({ messageId: created.id }),
      404,
      'NOT_FOUND',
    );
  });

  it('applies the target-chat preset to forwarded messages', async () => {
    const { alice, bob, chatId } = await pair();
    const third = await fixture.verifiedUser('Third');
    const targetChatId = await fixture.openDirectChat(third.id, alice.headers);
    const source = expectSuccess<MessageView>(await send(bob.headers, chatId, 'source'), 201);

    expectSuccess(await setPreset(alice.headers, targetChatId, '7d'), 200);
    const forwarded = expectSuccess<MessageView>(
      await app.request
        .post(`/api/chats/${chatId}/messages/${source.id}/forward`)
        .set(alice.headers)
        .send({ targetChatId }),
      201,
    );
    expect((await messages.findById(targetChatId, forwarded.id))?.expiresAt).not.toBeNull();
  });

  it('sets a hidden expiry on secret ciphertext without exposing plaintext', async () => {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    await fixture.registerDevice(alice);
    await fixture.registerDevice(bob);
    const chatId = await fixture.openSecretChat(bob.id, alice.headers);
    expectSuccess(await setPreset(alice.headers, chatId, '24h'), 200);

    const registration = await fixture.registerDevice(bob, 3);
    const sent = expectSuccess<MessageView>(
      await app.request
        .post(`/api/chats/${chatId}/secret-messages`)
        .set(alice.headers)
        .send({
          recipientDeviceId: registration.deviceId,
          ciphertext: 'QUJD',
          nonce: 'AAAAAAAAAAAAAAAA',
          ephemeralPublicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        }),
      201,
    );
    expect(sent.body).toBeNull();
    expect(sent.ciphertext).toBe('QUJD');
    expect(sent).not.toHaveProperty('expiresAt');
    expect((await messages.findById(chatId, sent.id))?.expiresAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/messages/message-expiry.test.ts 2>&1 | tail -30`
Expected: FAIL because send paths do not pass `expiresAt`.

- [ ] **Step 3: Resolve the sender preset in MessageService**

In `src/modules/messages/logic/message.service.ts`, import the timer:

```ts
import { SelfDestructTimer } from '@/modules/messages/logic/entities/self-destruct-timer.js';
```

Add the private resolver next to `rejectSecretChat`:

```ts
  private async expiryFor(chatId: string, userId: string): Promise<Date | null> {
    const membership = await this.members.find(chatId, userId);

    return SelfDestructTimer.expiryFor(membership?.selfDestructPreset ?? null);
  }
```

In `send`, after the reply-target check, compute and pass the expiry:

```ts
    const expiresAt = await this.expiryFor(chatId, userId);

    return this.messages.create({
      chatId,
      senderId: userId,
      body: input.body,
      type: 'text',
      replyToMessageId: input.replyToMessageId ?? null,
      expiresAt,
    });
```

In `sendMedia`, after `this.kinds.assertMatches(...)`, compute and pass it:

```ts
    const expiresAt = await this.expiryFor(chatId, userId);

    return this.messages.create({
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
```

In `sendMediaFromUpload`, after `storeAndScan`, compute and pass it:

```ts
    const expiresAt = await this.expiryFor(chatId, userId);

    return this.messages.create({
      chatId,
      senderId: userId,
      body: null,
      type: 'media',
      media: {
        mediaId: asset.id,
        kind: input.kind,
        caption: input.caption ?? null,
        durationMs: input.durationMs ?? null,
        width: input.width ?? null,
        height: input.height ?? null,
      },
      replyToMessageId: input.replyToMessageId ?? null,
      expiresAt,
    });
```

In `sendSecret`, after `this.ciphertextValidator.assertCiphertextInput(input)`, compute and pass it:

```ts
    const expiresAt = await this.expiryFor(chatId, userId);

    return this.messages.createSecret({
      chatId,
      senderId: userId,
      senderDeviceId,
      recipientDeviceId: input.recipientDeviceId,
      ciphertext: input.ciphertext,
      nonce: input.nonce,
      ephemeralPublicKey: input.ephemeralPublicKey,
      expiresAt,
    });
```

In `forward`, after the deleted-or-empty check, resolve the **target** chat's preset for the caller and pass it:

```ts
    const expiresAt = await this.expiryFor(targetChatId, userId);

    return this.messages.create({
      chatId: targetChatId,
      senderId: userId,
      body: original.media === null ? original.body : null,
      type: original.media === null ? 'text' : 'media',
      ...(original.media === null ? {} : { media: original.media }),
      forwardedFromChatId: sourceChatId,
      forwardedFromMessageId: messageId,
      expiresAt,
    });
```

- [ ] **Step 4: Run the HTTP test suite**

Run: `npx vitest run tests/integration/messages/message-expiry.test.ts 2>&1 | tail -25`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/messages/logic/message.service.ts tests/integration/messages/message-expiry.test.ts
git commit -m "feat(messaging): apply per-sender expiry on message creation"
```

---

### Task 5: Cleanup worker, configuration, media release, and container lifecycle

**Files:**
- Modify: `src/core/config/app.config.ts`
- Modify: `.env.example`
- Create: `src/modules/messages/logic/self-destruct-cleanup.worker.ts`
- Modify: `src/modules/messages/messages.types.ts`
- Modify: `src/modules/messages/messages.container.ts`
- Modify: `src/modules/messages/messages.module.ts`
- Create: `tests/integration/messages/self-destruct-cleanup.worker.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `MessageRepository.listExpired`/`scrubExpired`, `MessagePinRepository.removeForMessage`, core `MediaAccess.releaseIfUnreferenced`, `AppConfig`, root Redis/Logger.
- Produces: `SelfDestructCleanupWorker.process(): Promise<{ scrubbed: number }>`; `MESSAGES_TYPES.SelfDestructCleanupWorker`; config `selfDestructCleanup.intervalMinutes`; env `SELF_DESTRUCT_CLEANUP_INTERVAL_MINUTES`.

- [ ] **Step 1: Write the failing worker test**

Create `tests/integration/messages/self-destruct-cleanup.worker.test.ts`:

```ts
import { Queue } from 'bullmq';
import { Container } from 'inversify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SelfDestructCleanupWorker } from '@/modules/messages/logic/self-destruct-cleanup.worker.js';
import type { MessagePinRepository } from '@/modules/messages/logic/ports/message-pin.repository.js';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import { MessagesContainer } from '@/modules/messages/messages.container.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import { expectSuccess } from '../../helpers/assertions.js';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { MediaFixture, type UploadTicketResponse } from '../../fixtures/media.fixture.js';
import { TestApp } from '../../helpers/test-app.js';
import { MessagingApiFixture } from './messaging-api.fixture.js';

describe('SelfDestructCleanupWorker', () => {
  let app: TestApp;
  let auth: AuthFixture;
  let fixture: MessagingApiFixture;
  let media: MediaFixture;
  let messages: MessageRepository;
  let pins: MessagePinRepository;
  let worker: SelfDestructCleanupWorker;

  beforeAll(async () => {
    app = await TestApp.create();
    auth = new AuthFixture(app);
    fixture = new MessagingApiFixture(app);
    media = new MediaFixture(app);
    const container = new MessagesContainer(new Container({ parent: app.container }));
    messages = container.get(MESSAGES_TYPES.MessageRepository);
    pins = container.get(MESSAGES_TYPES.MessagePinRepository);
    worker = container.get(MESSAGES_TYPES.SelfDestructCleanupWorker);
    await worker.start();

    const queue = new Queue('self-destruct-cleanup', { connection: app.redis });
    try {
      const schedulers = await queue.getJobSchedulers();
      expect(schedulers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'scrub-expired-messages', every: 300_000 }),
        ]),
      );
    } finally {
      await queue.close();
    }
    expect(worker.isRunning()).toBe(true);
  });

  afterAll(async () => {
    await worker.close();
    expect(worker.isRunning()).toBe(false);
    await worker.close();
    await media.cleanup();
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
    auth.emails.clear();
    media.scanner.mode = 'clean';
  });

  async function createAgedMessage(senderId: string, chatId: string, body: string) {
    const created = await messages.create({
      chatId,
      senderId,
      body,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await app.pool.query(
      `UPDATE messages SET expires_at = now() - interval '1 second'
       WHERE chat_id = $1 AND id = $2`,
      [chatId, created.id],
    );
    return created;
  }

  it('scrubs expired content, removes pins, and leaves active rows alone', async () => {
    const alice = await auth.createUser();
    const bob = await auth.createUser();
    const chat = await app.container.database.db.query.chats.findFirst();
    void chat;
    const chatId = await fixture.openDirectChat(
      bob.id,
      fixture.auth.bearerHeader(
        (await fixture.auth.mintTokens(alice)).accessToken,
      ),
    );
    const expired = await createAgedMessage(bob.id, chatId, 'expired body');
    const active = await messages.create({ chatId, senderId: bob.id, body: 'active body' });
    await pins.pin(chatId, alice.id, expired.id, new Date(Date.now() + 3_600_000));

    const result = await worker.process();
    expect(result.scrubbed).toBe(1);

    const raw = await app.pool.query<{ body: string | null; deleted_at: Date | null }>(
      `SELECT body, deleted_at FROM messages WHERE chat_id = $1 AND id = $2`,
      [chatId, expired.id],
    );
    expect(raw.rows[0]?.body).toBeNull();
    expect(raw.rows[0]?.deleted_at).not.toBeNull();
    expect(await pins.list(chatId, alice.id)).toEqual([]);
    expect((await messages.findById(chatId, active.id))?.body).toBe('active body');
    expect((await worker.process()).scrubbed).toBe(0);
  });

  it('releases shared media only after the last live forward expires', async () => {
    const sender = await fixture.verifiedUser('Sender');
    const recipient = await fixture.verifiedUser('Recipient');
    const third = await fixture.verifiedUser('Third');
    const chatA = await fixture.openDirectChat(recipient.id, sender.headers);
    const chatB = await fixture.openDirectChat(third.id, sender.headers);

    const ticketResponse = await app.request
      .post('/api/media/uploads')
      .set(sender.headers)
      .send({ contentType: 'image/png', sizeBytes: 14 });
    const ticket = expectSuccess<UploadTicketResponse>(ticketResponse, 201);
    media.track(ticket);
    await media.put(ticket, Buffer.from('original-bytes'), 'image/png');
    expectSuccess(
      await app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(sender.headers),
      200,
    );

    const first = expectSuccess<{ id: string }>(
      await app.request
        .post(`/api/chats/${chatA}/messages/media`)
        .set(sender.headers)
        .send({ mediaId: ticket.mediaId, kind: 'image' }),
      201,
    );
    const second = expectSuccess<{ id: string }>(
      await app.request
        .post(`/api/chats/${chatA}/messages/${first.id}/forward`)
        .set(sender.headers)
        .send({ targetChatId: chatB }),
      201,
    );

    await app.pool.query(
      `UPDATE messages SET expires_at = now() - interval '1 second'
       WHERE media_id = $1 AND id = $2`,
      [ticket.mediaId, first.id],
    );
    expect((await worker.process()).scrubbed).toBe(1);
    expect(
      expectSuccess(
        await app.request.get(`/api/media/${ticket.mediaId}`).set(sender.headers),
        200,
      ),
    ).toBeDefined();

    await app.pool.query(
      `UPDATE messages SET expires_at = now() - interval '1 second'
       WHERE media_id = $1 AND id = $2`,
      [ticket.mediaId, second.id],
    );
    expect((await worker.process()).scrubbed).toBe(1);
    expect(
      (await app.pool.query(`SELECT id FROM media_objects WHERE id = $1`, [ticket.mediaId]))
        .rows,
    ).toEqual([]);
  });
});
```

Replace the stray `chat` lookup lines in the first test with the same `MessagingApiFixture` pattern used elsewhere in that test; do not leave unused variables.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/messages/self-destruct-cleanup.worker.test.ts 2>&1 | tail -30`
Expected: FAIL because the worker type and binding do not exist.

- [ ] **Step 3: Add configuration**

In `src/core/config/app.config.ts`, add after `PinCleanupConfig`:

```ts
export class SelfDestructCleanupConfig {
  constructor(readonly intervalMinutes: number) {
    if (!Number.isInteger(this.intervalMinutes) || this.intervalMinutes <= 0) {
      throw new Error('SELF_DESTRUCT_CLEANUP_INTERVAL_MINUTES must be a positive integer');
    }
  }
}
```

Add the property beside `pinCleanup`:

```ts
  readonly pinCleanup: PinCleanupConfig;
  readonly selfDestructCleanup: SelfDestructCleanupConfig;
```

Initialize it after `pinCleanup`:

```ts
    this.selfDestructCleanup = new SelfDestructCleanupConfig(
      env.readNumber('SELF_DESTRUCT_CLEANUP_INTERVAL_MINUTES', 5),
    );
```

Add to `.env.example` after `PIN_CLEANUP_INTERVAL_MINUTES`:

```env
# How often the BullMQ job scrubs elapsed self-destructing messages
SELF_DESTRUCT_CLEANUP_INTERVAL_MINUTES=5
```

- [ ] **Step 4: Add the worker**

Create `src/modules/messages/logic/self-destruct-cleanup.worker.ts`:

```ts
import { type Job, Queue, Worker } from 'bullmq';
import { inject, injectable } from 'inversify';
import type { Logger } from 'pino';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { MediaAccess } from '@/core/media/media-access.port.js';
import type { MessagePinRepository } from '@/modules/messages/logic/ports/message-pin.repository.js';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import type { RedisClient } from '@/types/redis.js';

const QUEUE_NAME = 'self-destruct-cleanup';
const JOB_NAME = 'scrub-expired-messages';
const REPEAT_KEY = 'self-destruct-cleanup-expired-messages';
const BATCH_SIZE = 100;
const MAX_BATCHES = 100;

/** Owns the repeatable job that scrubs elapsed self-destructing messages. */
@injectable()
export class SelfDestructCleanupWorker {
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(
    @inject(MESSAGES_TYPES.MessageRepository) private readonly messages: MessageRepository,
    @inject(MESSAGES_TYPES.MessagePinRepository) private readonly pins: MessagePinRepository,
    @inject(CORE_TYPES.MediaAccess) private readonly mediaAccess: MediaAccess,
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
    this.worker = new Worker(QUEUE_NAME, (job: Job) => this.process(job), {
      connection,
      concurrency: 1,
    });
    this.worker.on('error', (error: Error) => {
      this.logger.error({ err: error }, 'Self-destruct cleanup worker error');
    });
    this.worker.on('failed', (job, error) => {
      this.logger.error({ err: error, jobId: job?.id }, 'Self-destruct cleanup job failed');
    });

    await this.queue.upsertJobScheduler(
      REPEAT_KEY,
      { every: this.config.selfDestructCleanup.intervalMinutes * 60_000 },
      {
        name: JOB_NAME,
        data: {},
        opts: { removeOnComplete: true, removeOnFail: 100 },
      },
    );
  }

  isRunning(): boolean {
    return this.worker?.isRunning() ?? false;
  }

  async process(_job?: Job): Promise<{ scrubbed: number }> {
    let scrubbed = 0;

    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const due = await this.messages.listExpired(new Date(), BATCH_SIZE);

      if (due.length === 0) {
        break;
      }

      for (const message of due) {
        await this.pins.removeForMessage(message.chatId, message.id);

        const mediaId = message.media?.mediaId ?? null;

        if (mediaId !== null) {
          await this.mediaAccess.releaseIfUnreferenced(mediaId);
        }

        if (await this.messages.scrubExpired(message.chatId, message.id, new Date())) {
          scrubbed += 1;
        }
      }
    }

    this.logger.info({ scrubbed }, 'Expired self-destructing message cleanup completed');

    return { scrubbed };
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

- [ ] **Step 5: Bind and start the worker**

In `src/modules/messages/messages.types.ts`, add:

```ts
  SelfDestructCleanupWorker: Symbol.for('Messages.SelfDestructCleanupWorker'),
```

In `src/modules/messages/messages.container.ts`, import the worker and bind it beside `PinCleanupWorker`:

```ts
import { SelfDestructCleanupWorker } from '@/modules/messages/logic/self-destruct-cleanup.worker.js';
```

```ts
    this.bind<SelfDestructCleanupWorker>(MESSAGES_TYPES.SelfDestructCleanupWorker)
      .to(SelfDestructCleanupWorker)
      .inSingletonScope();
```

In `src/modules/messages/messages.module.ts`, import the worker type and update lifecycle:

```ts
import type { SelfDestructCleanupWorker } from '@/modules/messages/logic/self-destruct-cleanup.worker.js';
```

```ts
    await this.container.get<PinCleanupWorker>(MESSAGES_TYPES.PinCleanupWorker).start();
    await this.container
      .get<SelfDestructCleanupWorker>(MESSAGES_TYPES.SelfDestructCleanupWorker)
      .start();
```

```ts
    await this.container
      .get<SelfDestructCleanupWorker>(MESSAGES_TYPES.SelfDestructCleanupWorker)
      .close();
    await this.container.get<PinCleanupWorker>(MESSAGES_TYPES.PinCleanupWorker).close();
    this.container.unbindAll();
```

- [ ] **Step 6: Document the worker**

Add this paragraph to the `README.md` self-destruct section from Task 2:

```md
Elapsed messages are hidden by every read immediately, before cleanup runs. A BullMQ
repeatable job physically scrubs them every
`SELF_DESTRUCT_CLEANUP_INTERVAL_MINUTES` (default `5`): pins are removed, message
content and ciphertext are cleared, media columns are cleared, and the media object is
deleted only after the last live reference expires. A worker or Redis outage only delays
storage cleanup; it never makes an elapsed message visible again.
```

- [ ] **Step 7: Run the worker test and config checks**

Run: `npm run typecheck 2>&1 | tail -30; npx vitest run tests/integration/messages/self-destruct-cleanup.worker.test.ts 2>&1 | tail -25`
Expected: PASS. If the scheduler assertion fails because Redis is unavailable, start `redis` with `docker compose up -d redis` and rerun.

- [ ] **Step 8: Commit**

```bash
git add src/core/config/app.config.ts .env.example src/modules/messages/logic/self-destruct-cleanup.worker.ts src/modules/messages/messages.types.ts src/modules/messages/messages.container.ts src/modules/messages/messages.module.ts tests/integration/messages/self-destruct-cleanup.worker.test.ts README.md
git commit -m "feat(messaging): add self-destruct cleanup worker and config"
```

---

### Task 6: Full regression pass and live HTTP smoke

**Files:**
- No source changes expected. Update the gitignored `plan.md` handoff only if verification reveals a needed note; never commit it.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: verified tree and a recorded smoke result.

- [ ] **Step 1: Run the full automated gate**

Run: `npm run verify && npm run db:check`
Expected: typecheck, Biome, build, all tests, and `Everything's fine 🐶🔥`. Note: the original checkout at planning time had committed local edits to `tests/unit/is-prime.test.ts` and `tsconfig.json` that made Biome fail there; execute on a clean feature branch/worktree created for this feature, and do not modify those files.

- [ ] **Step 2: Start required services and the API**

Run: `docker compose up -d postgres redis minio storage-init && npm run dev`
Wait for the API to listen on port 4000.

- [ ] **Step 3: Smoke-test success paths**

Using two verified temporary users, exercise over HTTP:

1. `PATCH /api/chats/:chatId/self-destruct` with `"preset": "24h"` → `200` and `{ "preset": "24h" }`.
2. `GET /api/chats` for the setter → `selfDestructPreset: "24h"`; for the peer → `null`.
3. Send a cloud text as the setter → `201`; message response has no expiry field.
4. Send a cloud text as the peer → `201`; confirm in a direct DB query that `expires_at` is null for the peer's row and set for the setter's row.
5. Age the setter's row in PostgreSQL with `UPDATE messages SET expires_at = now() - interval '1 second' ...`.
6. `GET /api/chats/:chatId/messages` → aged message absent.
7. `POST /api/chats/:chatId/messages/:id/pin` on the aged id → `404 NOT_FOUND`.
8. `POST /api/chats/:chatId/read` with the aged id → `404 NOT_FOUND`.
9. Set `"preset": null` → `200`; send again → no new expiry.
10. Trigger `SelfDestructCleanupWorker.process()` through the module/container in a test hook or wait for the job; confirm body/ciphertext/media columns are cleared and `deleted_at` is set.

- [ ] **Step 4: Smoke-test error paths**

1. `PATCH` with `{ "preset": "1h" }` → `400 VALIDATION_ERROR`.
2. `PATCH` with `{}` → `400 VALIDATION_ERROR`.
3. `PATCH` without a bearer token → `401 UNAUTHORIZED`.
4. `PATCH` from a non-member → `403 NOT_CHAT_MEMBER`.
5. `PATCH` from an unverified user → `403 EMAIL_NOT_VERIFIED`.
6. Edit/delete/forward/pin an expired message → `404 NOT_FOUND`.

- [ ] **Step 5: Clean up**

Delete every temporary user created for the smoke, stop the API process, stop ClamAV if started, and leave PostgreSQL/Redis/MinIO running. Confirm no temporary users remain.

- [ ] **Step 6: Record the result**

Update the gitignored `plan.md` with the commit range, verification output, smoke result, cleanup confirmation, and remaining risks. Do not commit `plan.md` or any `.env`/secret file.
