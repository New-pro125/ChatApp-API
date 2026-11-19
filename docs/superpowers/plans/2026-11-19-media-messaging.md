# Media Messaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cloud-chat media messages that reuse the Phase 2.4 scanned S3 pipeline through both attach-ready-`mediaId` and combined multipart upload-and-send modes.

**Architecture:** Media fields live on the hash-partitioned `messages` table, with a `RESTRICT` foreign key to `media_objects` and an index for live-reference checks. Messaging and media communicate only through new `CORE_TYPES.MediaAccess` and `CORE_TYPES.MediaReferenceReader` ports; module adapters are root-bound following the E2EE precedent. Deletion clears message media fields and synchronously releases the object only after the last live reference disappears.

**Tech Stack:** Node 24, TypeScript 7.0.2, ESM, Express 5, Inversify 8, Zod 4, Drizzle ORM 0.45 + PostgreSQL 18, AWS SDK v3, busboy, Vitest + Supertest, Biome.

**Spec:** `docs/superpowers/specs/2026-11-19-media-messaging-design.md`

## Global Constraints

- Node `>=24`; ESM with `"type": "module"`; use `@/...` aliases and explicit `.js` extensions on relative imports.
- Express 5 with Inversify child containers; controllers are request-scoped and resolved from `req.container`.
- Modules must not import other modules' data or logic layers. All cross-module work goes through `CORE_TYPES.MediaAccess` and `CORE_TYPES.MediaReferenceReader`.
- All JSON responses go through `ApiResponse`; `204` responses have no body.
- The same Zod schema documents and validates each request; response schemas use `successEnvelope` and shared error components.
- `messages` is `PARTITION BY HASH (chat_id)` with 16 partitions. Ordinary queries filter `chat_id`; the deliberate `media_id` reference lookup uses the non-unique index and scans partitions.
- New CHECK expressions on `messages` use unqualified identifiers (`sql.identifier('type')`, etc.) because qualified identifiers fail inside partitions.
- Generate migrations with `npm run db:generate`, review SQL, apply with `npm run db:migrate`, and confirm with `npm run db:check`. Never edit an applied migration.
- Drizzle is the only application data layer; raw `pg.Pool` is reserved for health checks and migration tooling.
- No new environment variables. `MEDIA_MAX_BYTES`, `MEDIA_ALLOWED_CONTENT_TYPES`, and `MEDIA_PRESIGN_TTL_SECONDS` are reused.
- Multipart limits: exactly one `file`, `sizeBytes` before the file part, file cap `MEDIA_MAX_BYTES`, total request `Content-Length` cap `MEDIA_MAX_BYTES + 65,536`, 8,192-byte field cap.
- Deterministic fake scanners run in tests; live ClamAV is manual under the `scan` profile.
- Biome: single quotes, semicolons, trailing commas, 2-space indentation, 100-character width, organized imports.
- Prefer `unknown` over `any`; domain layers never import Express types or HTTP status codes.
- Keep the gitignored `plan.md` out of every commit.
- Every task gets its own commit with a long descriptive message. All execution subagents use `opencode/big-pickle`; every task and major fix gets an independent review before proceeding.
- Before completion: `npm run verify && npm run db:check`, live success/error smoke, cleanup temp users/messages/S3 versions/processes.

## Review Focus

- **Secret-chat media rejection before any media lookup or DB write** — a media request to a secret chat must return `403 E2EE_NOT_ALLOWED`, leave no message, and leave no media state touched. Pinned in Task 6 unit test and Task 7 integration test.
- **Recipient access without ownership or metadata leakage** — a chat member who does not own the media must get a working signed URL, but never `objectKey`, `versionId`, `sha256`, signatures, or scan errors. Pinned in Task 7 integration test.
- **Post-finalize overwrite** — after a media message is attached, overwriting the S3 object must not change the bytes served by the message download URL. Pinned in Task 9 integration test.
- **Forward/delete reference accounting** — deleting one of two forwards keeps the object; deleting the last live reference removes the S3 object and media row, and manual media delete returns `409` while referenced. Pinned in Task 9 integration test.
- **Malformed or failed combined uploads must not create messages** — missing/extra file, size mismatch, EICAR, and scanner outage must produce `400`/`422`/`503` with zero message rows; scanner outage includes `details.mediaId`. Pinned in Task 8 integration tests.

## File Structure

Create:

- `src/core/media/media-access.port.ts` — core port and value types for cross-module media operations.
- `src/core/media/media-reference.port.ts` — core port for live message-reference checks.
- `src/core/media/media-form.schema.ts` — shared Zod form fields for combined uploads.
- `src/modules/media/logic/media-access.service.ts` — media-module adapter implementing `MediaAccess`.
- `src/modules/messages/web/multipart-media.parser.ts` — bounded busboy parser with exact-size verification.
- `src/modules/messages/logic/media-kind.policy.ts` — kind/content-type validation.
- `src/modules/messages/logic/media-reference-reader.service.ts` — messages-module adapter implementing `MediaReferenceReader`.
- `src/modules/messages/web/message-presenter.service.ts` — async message DTO presenter with signed URLs.
- `tests/integration/messages/media-message-schema.test.ts`
- `tests/integration/messages/media-messages.test.ts`
- `tests/integration/messages/media-forward-delete.test.ts`
- `tests/integration/media/object-store-put-stream.test.ts`
- `tests/integration/media/core-port-wiring.test.ts`
- `tests/unit/media-access.service.test.ts`
- `tests/unit/message-media.service.test.ts`
- `tests/unit/multipart-media.parser.test.ts`

Modify:

- `src/core/container/core.types.ts`
- `src/core/errors/error-code.ts`
- `src/core/errors/domain.error.ts`
- `src/core/errors/error-mapper.ts`
- `src/core/http/openapi/api-document.builder.ts`
- `src/core/http/openapi/openapi.types.ts`
- `src/app/application.ts`
- `src/core/database/schema/messaging.schema.ts`
- `drizzle/` — one generated migration plus journal/snapshot
- `src/modules/media/data/postgres-media-object.repository.ts`
- `src/modules/media/data/s3-object.store.ts`
- `src/modules/media/logic/media-object-key.factory.ts`
- `src/modules/media/logic/media.service.ts`
- `src/modules/media/logic/ports/media-object.repository.ts`
- `src/modules/media/logic/ports/object-store.ts`
- `src/modules/media/media.container.ts`
- `src/modules/media/media.types.ts`
- `src/modules/media/web/dto/media.openapi.ts`
- `src/modules/messages/data/message.mapper.ts`
- `src/modules/messages/data/postgres-message.repository.ts`
- `src/modules/messages/logic/entities/message-record.ts`
- `src/modules/messages/logic/message.service.ts`
- `src/modules/messages/logic/ports/message.repository.ts`
- `src/modules/messages/messages.container.ts`
- `src/modules/messages/messages.types.ts`
- `src/modules/messages/web/dto/message.openapi.ts`
- `src/modules/messages/web/dto/message.schemas.ts`
- `src/modules/messages/web/message.controller.ts`
- `src/modules/messages/web/routes/messages.router.ts`
- `package.json` and `package-lock.json`
- `tests/fixtures/media.fixture.ts`
- `tests/unit/media-service.test.ts`
- `README.md`

---

### Task 1: Core ports, MEDIA_IN_USE error, and OpenAPI request content type

**Files:**
- Create: `src/core/media/media-access.port.ts`
- Create: `src/core/media/media-reference.port.ts`
- Modify: `src/core/container/core.types.ts:1-30`
- Modify: `src/core/errors/error-code.ts:1-41`
- Modify: `src/core/errors/domain.error.ts:335-373`
- Modify: `src/core/errors/error-mapper.ts:20-55`
- Modify: `src/core/http/openapi/openapi.types.ts:5-9`
- Modify: `src/core/http/openapi/api-document.builder.ts:120-127`
- Test: `tests/unit/media-errors.test.ts`

**Interfaces:**
- Consumes: existing `AppErrorOptions`, `ErrorCode`, `ApiDocumentBuilder`.
- Produces: `MediaAccess`, `MediaAsset`, `IncomingMediaUpload`, `MediaDownload`, `MediaReferenceReader`, `CORE_TYPES.MediaAccess`, `CORE_TYPES.MediaReferenceReader`, `MediaInUseException`, `ERROR MEDIA_IN_USE -> 409`, and `OpenApiRequestContract.contentType`.

- [ ] **Step 1: Write the failing error-mapping test**

Append to `tests/unit/media-errors.test.ts` inside the existing `it.each` table:

```ts
[new MediaInUseException(), 409, ErrorCode.MEDIA_IN_USE],
```

Add the import at the top:

```ts
import {
  MediaInUseException,
  MediaInfectedException,
  MediaNotReadyException,
  MediaScanUnavailableException,
} from '@/core/errors/domain.error.js';
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npx vitest run tests/unit/media-errors.test.ts
```

Expected: FAIL with `MediaInUseException is not a function` and `ErrorCode.MEDIA_IN_USE` undefined.

- [ ] **Step 3: Implement the error code, domain error, and mapping**

In `src/core/errors/error-code.ts`, add after `MEDIA_NOT_READY`:

```ts
  MEDIA_IN_USE: 'MEDIA_IN_USE',
```

In `src/core/errors/domain.error.ts`, append:

```ts
export class MediaInUseException extends DomainException {
  readonly code = ErrorCode.MEDIA_IN_USE;

  constructor(message = 'Media object is referenced by a message', options?: AppErrorOptions) {
    super(message, options);
  }
}
```

In `src/core/errors/error-mapper.ts`, add to `HTTP_STATUS_BY_CODE`:

```ts
  [ErrorCode.MEDIA_IN_USE]: 409,
```

- [ ] **Step 4: Add the core ports and symbols**

Create `src/core/media/media-access.port.ts`:

```ts
import type { Readable } from 'node:stream';

/** A scanned, ready object that may be attached to a cloud message. */
export interface MediaAsset {
  readonly id: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string | null;
}

/** A bounded incoming stream whose exact byte count is verified before use. */
export interface IncomingMediaUpload {
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly body: Readable;
  assertComplete(): Promise<void>;
}

/** Short-lived signed download details for a chat-authorized reader. */
export interface MediaDownload {
  readonly url: string;
  readonly expiresAt: Date;
  readonly contentType: string;
  readonly sizeBytes: number;
}

/** The only media operations other modules may call. */
export interface MediaAccess {
  requireReadyOwned(mediaId: string, userId: string): Promise<MediaAsset>;
  storeAndScan(userId: string, input: IncomingMediaUpload): Promise<MediaAsset>;
  signDownload(mediaId: string): Promise<MediaDownload>;
  releaseIfUnreferenced(mediaId: string): Promise<void>;
  assertDeletable(mediaId: string): Promise<void>;
}
```

Create `src/core/media/media-reference.port.ts`:

```ts
/** Implemented by the messaging module; used for GC and delete guards. */
export interface MediaReferenceReader {
  hasLiveReferences(mediaId: string): Promise<boolean>;
}
```

In `src/core/container/core.types.ts`, add after `E2eeCiphertextValidator`:

```ts
  MediaAccess: Symbol.for('Core.MediaAccess'),
  MediaReferenceReader: Symbol.for('Core.MediaReferenceReader'),
```

- [ ] **Step 5: Add multipart OpenAPI support**

In `src/core/http/openapi/openapi.types.ts`, change `OpenApiRequestContract` to:

```ts
export interface OpenApiRequestContract {
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
  contentType?: 'application/json' | 'multipart/form-data';
}
```

In `src/core/http/openapi/api-document.builder.ts`, replace the request-body block with:

```ts
      ...(contract.request?.body === undefined
        ? {}
        : {
            requestBody: {
              required: true,
              content: {
                [contract.request.contentType ?? 'application/json']: {
                  schema: contract.request.body,
                },
              },
            },
          }),
```

- [ ] **Step 6: Run the focused test and typecheck**

Run:

```bash
npx vitest run tests/unit/media-errors.test.ts && npm run typecheck
```

Expected: PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/core/container/core.types.ts src/core/errors/error-code.ts src/core/errors/domain.error.ts src/core/errors/error-mapper.ts src/core/http/openapi/api-document.builder.ts src/core/http/openapi/openapi.types.ts src/core/media/media-access.port.ts src/core/media/media-reference.port.ts tests/unit/media-errors.test.ts
git commit -m "feat(media-messaging): add core ports and MEDIA_IN_USE error

Introduces the transport-neutral MediaAccess and MediaReferenceReader
interfaces that let messaging and media collaborate without importing each
other. MediaAccess covers owner-checked attachment, server-side store-and-scan,
chat-authorized URL signing, guarded manual deletion, and reference-aware
release. MediaReferenceReader exposes only a live-reference boolean so the
messaging module never leaks repository details into core.

Adds MEDIA_IN_USE as a 409 domain error for manual media deletion while a live
message still references an object, and extends the OpenAPI request contract
with an explicit content type so the combined multipart route can be documented
with the same Zod field schema used for validation."
```

---

### Task 2: Messages schema, migration, and reference repository methods

**Files:**
- Modify: `src/core/database/schema/messaging.schema.ts:83-136`
- Modify: `src/core/database/schema/index.ts` (no new file; barrel already exports messaging)
- Modify: `src/modules/messages/data/message.mapper.ts`
- Modify: `src/modules/messages/data/postgres-message.repository.ts`
- Modify: `src/modules/messages/logic/entities/message-record.ts`
- Modify: `src/modules/messages/logic/ports/message.repository.ts`
- Create migration via `npm run db:generate`
- Test: `tests/integration/messages/media-message-schema.test.ts`

**Interfaces:**
- Consumes: `AppDatabase`, `messages`, `MEDIA_KINDS`.
- Produces: `MediaKind`, `MessageMediaFields`, `MessageType = 'text'|'system'|'secret'|'media'`, `CreateMessageInput.media`, `MessageRecord.media`, `MessageRepository.hasLiveMediaReferences`.

- [ ] **Step 1: Write the failing schema/repository test**

Create `tests/integration/messages/media-message-schema.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { AppDatabase } from '@/core/database/database.provider.js';
import { AuthFixture } from '@/tests/fixtures/auth.fixture.js';
import { TestApp } from '@/tests/helpers/test-app.js';
import { PostgresMessageRepository } from '@/modules/messages/data/postgres-message.repository.js';

describe('media message schema and references', () => {
  let app: TestApp;
  let auth: AuthFixture;
  let repository: PostgresMessageRepository;
  let chatId: string;
  let userId: string;

  beforeAll(async () => {
    app = await TestApp.create();
    auth = new AuthFixture(app);
    repository = new PostgresMessageRepository(app.container.get<AppDatabase>(CORE_TYPES.Db));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
    const user = await auth.createUser({ emailVerifiedAt: new Date() });
    userId = user.id;
    chatId = randomUUID();
    await app.pool.query(
      `INSERT INTO chats (id, type, created_by, created_at, updated_at)
       VALUES ($1, 'direct', $2, now(), now())`,
      [chatId, userId],
    );
    await app.pool.query(
      `INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'member')`,
      [chatId, userId],
    );
  });

  it('stores media fields and tracks live references', async () => {
    const mediaId = randomUUID();
    await app.pool.query(
      `INSERT INTO media_objects
        (id, owner_user_id, object_key, content_type, size_bytes, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'image/png', 12, 'ready', now(), now())`,
      [mediaId, userId, `media/${userId}/${mediaId}.png`],
    );

    const message = await repository.create({
      chatId,
      senderId: userId,
      body: null,
      type: 'media',
      media: { mediaId, kind: 'image', caption: null, durationMs: null, width: null, height: null },
    });

    expect(message.type).toBe('media');
    expect(message.media?.mediaId).toBe(mediaId);
    expect(await repository.hasLiveMediaReferences(mediaId)).toBe(true);

    await repository.markDeleted(chatId, message.id, new Date());

    expect(await repository.hasLiveMediaReferences(mediaId)).toBe(false);
  });

  it('rejects media fields on secret rows', async () => {
    const mediaId = randomUUID();

    await expect(
      app.pool.query(
        `INSERT INTO messages
          (chat_id, id, sender_id, type, body, media_id, media_kind, ciphertext, nonce,
           ephemeral_public_key, sender_device_id, recipient_device_id, created_at)
         VALUES ($1, $2, $3, 'secret', NULL, $4, 'image', 'c', 'n', 'e', $5, $5, now())`,
        [chatId, randomUUID(), userId, mediaId, randomUUID()],
      ),
    ).rejects.toThrow(/messages_non_media_no_media_check|violates check constraint/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npx vitest run tests/integration/messages/media-message-schema.test.ts
```

Expected: FAIL because `media_id`, `media_kind`, `type='media'`, and `hasLiveMediaReferences` do not exist.

- [ ] **Step 3: Extend the domain entity and port**

In `src/modules/messages/logic/entities/message-record.ts`, replace the type and add the value object before `MessageRecord`:

```ts
export const MESSAGE_MEDIA_KINDS = [
  'image',
  'video',
  'document',
  'voice_note',
  'sticker',
  'gif',
] as const;

export type MediaKind = (typeof MESSAGE_MEDIA_KINDS)[number];

export interface MessageMediaFields {
  readonly mediaId: string;
  readonly kind: MediaKind;
  readonly caption: string | null;
  readonly durationMs: number | null;
  readonly width: number | null;
  readonly height: number | null;
}

export type MessageType = 'text' | 'system' | 'secret' | 'media';
```

Append a final constructor parameter to `MessageRecord`:

```ts
    readonly media: MessageMediaFields | null = null,
```

In `src/modules/messages/logic/ports/message.repository.ts`, change `CreateMessageInput` to:

```ts
export interface CreateMessageInput {
  chatId: string;
  senderId: string;
  body: string | null;
  type?: MessageType;
  media?: MessageMediaFields;
  replyToMessageId?: string | null;
  forwardedFromChatId?: string | null;
  forwardedFromMessageId?: string | null;
}
```

Add to the `MessageRepository` interface:

```ts
  hasLiveMediaReferences(mediaId: string): Promise<boolean>;
```

- [ ] **Step 4: Extend schema, mapper, and repository**

In `src/core/database/schema/messaging.schema.ts`, add after `body`:

```ts
    mediaId: uuid('media_id').references(() => mediaObjects.id, { onDelete: 'restrict' }),
    mediaKind: text('media_kind'),
    caption: text('caption'),
    durationMs: integer('duration_ms'),
    width: integer('width'),
    height: integer('height'),
```

Add the import at the top:

```ts
import { mediaObjects } from '@/core/database/schema/media.schema.js';
```

Replace `messages_type_check`, and change `messages_text_body_check` so media rows may
keep `body IS NULL` (the existing check would otherwise reject every media message):

```ts
    check(
      'messages_type_check',
      sql`${sql.identifier('type')} in ('text', 'system', 'secret', 'media')`,
    ),
    check(
      'messages_text_body_check',
      sql`${table.type} not in ('text', 'media') or ${table.body} is not null`,
    ),
```

and append these named checks after `messages_secret_no_reply_forward_check`:

```ts
    check(
      'messages_media_shape_check',
      sql`${sql.identifier('type')} <> 'media' or (${sql.identifier('media_id')} is not null and ${sql.identifier('media_kind')} in ('image', 'video', 'document', 'voice_note', 'sticker', 'gif') and ${sql.identifier('body')} is null and ${sql.identifier('ciphertext')} is null and ${sql.identifier('nonce')} is null and ${sql.identifier('ephemeral_public_key')} is null and ${sql.identifier('sender_device_id')} is null and ${sql.identifier('recipient_device_id')} is null)`,
    ),
    check(
      'messages_non_media_no_media_check',
      sql`${sql.identifier('type')} = 'media' or (${sql.identifier('media_id')} is null and ${sql.identifier('media_kind')} is null and ${sql.identifier('caption')} is null and ${sql.identifier('duration_ms')} is null and ${sql.identifier('width')} is null and ${sql.identifier('height')} is null)`,
    ),
    check(
      'messages_media_caption_check',
      sql`${sql.identifier('caption')} is null or char_length(${sql.identifier('caption')}) between 1 and 1000`,
    ),
    check(
      'messages_media_duration_check',
      sql`${sql.identifier('duration_ms')} is null or (${sql.identifier('duration_ms')} between 1 and 86400000)`,
    ),
    check(
      'messages_media_width_check',
      sql`${sql.identifier('width')} is null or (${sql.identifier('width')} between 1 and 16384)`,
    ),
    check(
      'messages_media_height_check',
      sql`${sql.identifier('height')} is null or (${sql.identifier('height')} between 1 and 16384)`,
    ),
```

Add after the existing indexes:

```ts
    index('messages_media_id_index').on(table.mediaId),
```

In `src/modules/messages/data/message.mapper.ts`, add the six columns to `messageSelection` and pass the final mapper argument:

```ts
    input.mediaId === null || input.mediaKind === null
      ? null
      : {
          mediaId: input.mediaId,
          kind: input.mediaKind as MediaKind,
          caption: input.caption,
          durationMs: input.durationMs,
          width: input.width,
          height: input.height,
        },
```

In `src/modules/messages/data/postgres-message.repository.ts`, extend the insert values in `create`:

```ts
      body: input.body,
      type: input.type ?? 'text',
      mediaId: input.media?.mediaId ?? null,
      mediaKind: input.media?.kind ?? null,
      caption: input.media?.caption ?? null,
      durationMs: input.media?.durationMs ?? null,
      width: input.media?.width ?? null,
      height: input.media?.height ?? null,
```

Extend `markDeleted` set:

```ts
.set({
  deletedAt,
  mediaId: null,
  mediaKind: null,
  caption: null,
  durationMs: null,
  width: null,
  height: null,
})
```

Add the method before the final closing brace:

```ts
  async hasLiveMediaReferences(mediaId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.mediaId, mediaId), isNull(messages.deletedAt)))
      .limit(1);

    return rows.length > 0;
  }
```

Ensure imports include `and`, `eq`, `isNull`, and `MediaKind` where used.

- [ ] **Step 5: Generate and review the migration**

Run:

```bash
npm run db:generate
npm run db:migrate
npm run db:check
```

Open the newest `drizzle/*.sql`. Confirm:

- all six columns are nullable;
- the FK is named and `ON DELETE RESTRICT`;
- `messages_media_id_index` is non-unique;
- every `messages` CHECK uses unqualified identifiers;
- the journal and snapshot chain to the previous migration.

If generated CHECKs qualify identifiers, edit the newly generated, unapplied SQL to use unqualified names before applying it. Never edit an applied migration.

- [ ] **Step 6: Run the focused test**

Run:

```bash
npx vitest run tests/integration/messages/media-message-schema.test.ts
```

Expected: PASS, both tests.

- [ ] **Step 7: Commit**

```bash
git add src/core/database/schema/messaging.schema.ts src/modules/messages/data/message.mapper.ts src/modules/messages/data/postgres-message.repository.ts src/modules/messages/logic/entities/message-record.ts src/modules/messages/logic/ports/message.repository.ts drizzle tests/integration/messages/media-message-schema.test.ts
git commit -m "feat(messaging): store media message references

Adds nullable media columns to the hash-partitioned messages table, extends
the type check with media, relaxes the text-body check so media rows keep a
null body, and adds constraints that keep secret rows
ciphertext-only and non-media rows free of media fields. A RESTRICT foreign key
to media_objects prevents a referenced object from disappearing, while a
non-unique media_id index supports the deliberate cross-partition reference
lookup.

MessageRecord and the repository port now carry a typed media value object.
Creating a media message persists those fields, marking one deletes them to
drop the reference, and hasLiveMediaReferences reports whether any live row
still points at an object. Checks use unqualified identifiers so PostgreSQL
can propagate them to all 16 partitions."
```

---

### Task 3: Streaming object store and content-type extensions

**Files:**
- Modify: `src/modules/media/logic/ports/object-store.ts:21-29`
- Modify: `src/modules/media/data/s3-object.store.ts:48-150`
- Modify: `src/modules/media/logic/media-object-key.factory.ts:4-14`
- Test: `tests/integration/media/object-store-put-stream.test.ts`

**Interfaces:**
- Consumes: `ObjectStore`, `S3Client`, `PutObjectCommand`, `MediaObjectKeyFactory`.
- Produces: `ObjectStore.putStream`, extension mappings for `video/webm`, `audio/ogg`, `audio/wav`, `audio/webm`, `audio/mp4`.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/media/object-store-put-stream.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MEDIA_TYPES } from '@/modules/media/media.types.js';
import { MediaModule } from '@/modules/media/media.module.js';
import type { ObjectStore } from '@/modules/media/logic/ports/object-store.js';
import type { MediaObjectKeyFactory } from '@/modules/media/logic/media-object-key.factory.js';
import { TestApp } from '@/tests/helpers/test-app.js';

describe('ObjectStore.putStream', () => {
  let app: TestApp;
  let store: ObjectStore;
  let keys: MediaObjectKeyFactory;
  const key = `media/test/${randomUUID()}.png`;
  const bytes = Buffer.from('streamed-media-bytes');

  beforeAll(async () => {
    app = await TestApp.create();
    const container = app.application.getModule<MediaModule>('media')!.mediaContainer;
    store = container.get<ObjectStore>(MEDIA_TYPES.ObjectStore);
    keys = container.get<MediaObjectKeyFactory>(MEDIA_TYPES.MediaObjectKeyFactory);
  });

  afterAll(async () => {
    await store.delete(key).catch(() => undefined);
    await app.close();
  });

  it('uploads a bounded stream and reads identical bytes', async () => {
    await store.putStream(key, 'image/png', bytes.length, Readable.from([bytes]));

    const head = await store.head(key);
    expect(head?.contentType).toBe('image/png');
    expect(head?.sizeBytes).toBe(bytes.length);

    const chunks: Buffer[] = [];
    for await (const chunk of await store.getStream(key, head?.versionId ?? null)) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
  });

  it.each([
    ['video/webm', 'webm'],
    ['audio/ogg', 'ogg'],
    ['audio/wav', 'wav'],
    ['audio/webm', 'webm'],
    ['audio/mp4', 'm4a'],
  ])('builds a key for %s', (contentType, extension) => {
    expect(keys.build('owner', 'media', contentType)).toBe(`media/owner/media.${extension}`);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npx vitest run tests/integration/media/object-store-put-stream.test.ts
```

Expected: FAIL because `putStream` and the new extensions do not exist.

- [ ] **Step 3: Implement the port and adapter**

In `src/modules/media/logic/ports/object-store.ts`, add to `interface ObjectStore`:

```ts
  putStream(
    objectKey: string,
    contentType: string,
    sizeBytes: number,
    body: Readable,
  ): Promise<void>;
```

In `src/modules/media/data/s3-object.store.ts`, add the method after `presignPut`:

```ts
  async putStream(
    objectKey: string,
    contentType: string,
    sizeBytes: number,
    body: Readable,
  ): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          Body: body,
          ContentType: contentType,
          ContentLength: sizeBytes,
        }),
      );
    } catch (error) {
      throw new ObjectStoreException('Failed to upload media object stream', { cause: error });
    }
  }
```

- [ ] **Step 4: Extend the key factory**

Replace `EXTENSIONS` in `src/modules/media/logic/media-object-key.factory.ts` with:

```ts
const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/octet-stream': 'bin',
};
```

- [ ] **Step 5: Run the focused test and typecheck**

Run:

```bash
npx vitest run tests/integration/media/object-store-put-stream.test.ts && npm run typecheck
```

Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/modules/media/data/s3-object.store.ts src/modules/media/logic/media-object-key.factory.ts src/modules/media/logic/ports/object-store.ts tests/integration/media/object-store-put-stream.test.ts
git commit -m "feat(media): stream bounded uploads into object storage

Adds putStream to the ObjectStore port and S3 adapter so the combined
upload-and-send route can stream request bytes directly into the same private
bucket used by presigned uploads. PutObjectCommand receives an exact
ContentLength, keeping the object atomic on failure and preserving the existing
HEAD/version-pinning flow.

Extends the server-owned key extension map to cover webm, ogg, wav, and m4a so
video and voice-note kinds work whenever those content types are present in
MEDIA_ALLOWED_CONTENT_TYPES."
```

---

### Task 4: MediaService cross-module methods and MediaAccess adapter

**Files:**
- Modify: `src/modules/media/logic/ports/media-object.repository.ts`
- Modify: `src/modules/media/data/postgres-media-object.repository.ts`
- Modify: `src/modules/media/logic/media.service.ts`
- Modify: `src/modules/media/media.types.ts`
- Modify: `src/modules/media/media.container.ts`
- Create: `src/modules/media/logic/media-access.service.ts`
- Create: `src/modules/messages/logic/media-reference-reader.service.ts`
- Modify: `src/modules/messages/messages.types.ts`
- Modify: `src/modules/messages/messages.container.ts`
- Modify: `src/app/application.ts:91-98`
- Modify: `tests/fixtures/media.fixture.ts:112-121`
- Modify: `tests/unit/media-service.test.ts:235,310`
- Test: `tests/unit/media-access.service.test.ts`

**Interfaces:**
- Consumes: `MediaObjectRecord`, `ObjectStore`, `VirusScanner`, `MediaReferenceReader`, core `MediaAccess` types.
- Produces: `MediaObjectRepository.findById`, `MediaService.requireReadyForUse`, `storeAndScan`, `signForReader`, `releaseIfUnreferenced`, `assertDeletable`, `MediaAccessService`, root-bound `CORE_TYPES.MediaReferenceReader`, and the Messages-before-Media construction order that lets `MediaService` resolve that binding at boot.

- [ ] **Step 1: Write the failing unit tests**

Create `tests/unit/media-access.service.test.ts` with hand-written fakes:

```ts
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MediaInUseException } from '@/core/errors/domain.error.js';
import type { MediaAccess } from '@/core/media/media-access.port.js';
import type { MediaReferenceReader } from '@/core/media/media-reference.port.js';
import { MediaAccessService } from '@/modules/media/logic/media-access.service.js';
import type { MediaService } from '@/modules/media/logic/media.service.js';

class FakeReferences implements MediaReferenceReader {
  live = false;
  async hasLiveReferences(): Promise<boolean> {
    return this.live;
  }
}

class FakeMediaService {
  calls: string[] = [];
  async requireReadyForUse(): Promise<unknown> {
    this.calls.push('requireReadyForUse');
    return { id: 'm1', contentType: 'image/png', sizeBytes: 12, sha256: 'h' };
  }
  async storeAndScan(): Promise<unknown> {
    this.calls.push('storeAndScan');
    return { id: 'm2', contentType: 'image/png', sizeBytes: 12, sha256: 'h' };
  }
  async signForReader(): Promise<unknown> {
    this.calls.push('signForReader');
    return { url: 'https://signed', expiresAt: new Date(), contentType: 'image/png', sizeBytes: 12 };
  }
  async releaseIfUnreferenced(): Promise<void> {
    this.calls.push('releaseIfUnreferenced');
  }
  async assertDeletable(): Promise<void> {
    this.calls.push('assertDeletable');
    throw new MediaInUseException();
  }
}

function service(): { access: MediaAccess; media: FakeMediaService } {
  const media = new FakeMediaService();
  return { access: new MediaAccessService(media as unknown as MediaService), media };
}

describe('MediaAccessService', () => {
  it('delegates owner-checked attachment and chat-authorized signing', async () => {
    const { access, media } = service();
    await expect(access.requireReadyOwned('m1', 'u1')).resolves.toMatchObject({ id: 'm1' });
    await expect(access.signDownload('m1')).resolves.toMatchObject({ url: 'https://signed' });
    expect(media.calls).toEqual(['requireReadyForUse', 'signForReader']);
  });

  it('delegates release and delete guards', async () => {
    const { access, media } = service();
    await access.releaseIfUnreferenced('m1');
    await expect(access.assertDeletable('m1')).rejects.toThrow(MediaInUseException);
    expect(media.calls).toEqual(['releaseIfUnreferenced', 'assertDeletable']);
  });

  it('streams an incoming upload through storeAndScan', async () => {
    const { access, media } = service();
    const input = {
      contentType: 'image/png',
      sizeBytes: 12,
      body: Readable.from([Buffer.from('012345678901')]),
      assertComplete: async () => undefined,
    };
    await expect(access.storeAndScan('u1', input)).resolves.toMatchObject({ id: 'm2' });
    expect(media.calls).toEqual(['storeAndScan']);
  });
});
```

Add to `tests/unit/media-service.test.ts` a fake reference reader and pass it as the fifth constructor argument at both existing `new MediaService(...)` call sites:

```ts
class FakeReferences implements MediaReferenceReader {
  live = false;
  async hasLiveReferences(): Promise<boolean> {
    return this.live;
  }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npx vitest run tests/unit/media-access.service.test.ts tests/unit/media-service.test.ts
```

Expected: FAIL because `MediaAccessService` and the new `MediaService` methods do not exist.

- [ ] **Step 3: Add repository lookup by id**

In `src/modules/media/logic/ports/media-object.repository.ts`, add:

```ts
  findById(mediaId: string): Promise<MediaObjectRecord | null>;
```

In `src/modules/media/data/postgres-media-object.repository.ts`, add:

```ts
  async findById(mediaId: string): Promise<MediaObjectRecord | null> {
    const rows = await this.db
      .select(mediaObjectSelection)
      .from(mediaObjects)
      .where(eq(mediaObjects.id, mediaId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : this.mapper.toRecord(row);
  }
```

- [ ] **Step 4: Extend MediaService**

In `src/modules/media/logic/media.service.ts`, add imports:

```ts
import type { MediaReferenceReader } from '@/core/media/media-reference.port.js';
import type {
  IncomingMediaUpload,
  MediaAsset,
  MediaDownload,
} from '@/core/media/media-access.port.js';
```

Add constructor parameter after `config`:

```ts
    @inject(CORE_TYPES.MediaReferenceReader)
    private readonly references: MediaReferenceReader,
```

Append these methods before `scanWithHash`:

```ts
  async requireReadyForUse(mediaId: string, userId: string): Promise<MediaAsset> {
    const record = await this.requireOwned(userId, mediaId);
    if (record.status !== 'ready') {
      throw new MediaNotReadyException();
    }
    return this.toAsset(record);
  }

  async storeAndScan(userId: string, input: IncomingMediaUpload): Promise<MediaAsset> {
    if (!this.config.media.allowedContentTypes.includes(input.contentType)) {
      throw new InvalidMediaInputException(`Unsupported media content type: ${input.contentType}`);
    }

    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > this.config.media.maxBytes) {
      throw new InvalidMediaInputException('Media size is outside the configured limit');
    }

    const record = await this.objects.create({
      ownerUserId: userId,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
    });

    try {
      await this.store.putStream(record.objectKey, input.contentType, input.sizeBytes, input.body);
      await input.assertComplete();
    } catch (error) {
      await this.failStorageScan(record.id, userId, null);
      throw error;
    }

    const head = await this.store.head(record.objectKey);
    if (head === null) {
      await this.failStorageScan(record.id, userId, null);
      throw new MediaNotFoundException('Uploaded object was not found');
    }

    if (head.contentType !== record.contentType || head.sizeBytes !== record.sizeBytes) {
      await this.objects.markFailed(
        record.id,
        userId,
        'Uploaded object metadata does not match ticket',
        head.versionId,
      );
      throw new InvalidMediaInputException('Uploaded object metadata does not match the ticket');
    }

    let sha256: string | null = null;
    if (this.config.media.scanRequired) {
      let outcome: ScanOutcome;

      try {
        outcome = await this.scanWithHash(record.objectKey, head.versionId);
      } catch (error) {
        if (error instanceof ObjectStoreException) {
          await this.failStorageScan(record.id, userId, head.versionId);
          throw error;
        }
        if (error instanceof VirusScannerException || error instanceof MediaScanUnavailableException) {
          throw new MediaScanUnavailableException(undefined, {
            details: { mediaId: record.id },
            cause: error,
          });
        }
        throw error;
      }

      if (outcome.verdict === 'infected') {
        await this.objects.transitionToQuarantined(
          record.id,
          userId,
          outcome.signature,
          null,
          head.versionId,
        );
        throw new MediaInfectedException();
      }
      sha256 = outcome.sha256;
    }

    const ready = await this.objects.transitionToReady(
      record.id,
      userId,
      sha256,
      head.versionId,
    );
    if (ready === null) {
      throw new MediaNotReadyException();
    }
    return this.toAsset(ready);
  }

  async signForReader(mediaId: string): Promise<MediaDownload> {
    const record = await this.objects.findById(mediaId);
    if (record === null || record.status !== 'ready') {
      throw new MediaNotReadyException();
    }
    const ticket = await this.toDownloadTicket(record);
    return {
      url: ticket.url,
      expiresAt: ticket.expiresAt,
      contentType: ticket.contentType,
      sizeBytes: ticket.sizeBytes,
    };
  }

  async releaseIfUnreferenced(mediaId: string): Promise<void> {
    if (await this.references.hasLiveReferences(mediaId)) {
      return;
    }
    const record = await this.objects.findById(mediaId);
    if (record === null) {
      return;
    }
    await this.store.delete(record.objectKey);
    await this.objects.deleteOwned(record.id, record.ownerUserId);
  }

  async assertDeletable(mediaId: string): Promise<void> {
    if (await this.references.hasLiveReferences(mediaId)) {
      throw new MediaInUseException();
    }
  }

  private toAsset(record: MediaObjectRecord): MediaAsset {
    return {
      id: record.id,
      contentType: record.contentType,
      sizeBytes: record.sizeBytes,
      sha256: record.sha256,
    };
  }
```

Add the guard to `remove`:

```ts
  async remove(userId: string, mediaId: string): Promise<void> {
    await this.assertDeletable(mediaId);
    const record = await this.requireOwned(userId, mediaId);
    await this.store.delete(record.objectKey);
    // ...existing deleteOwned behavior
  }
```

Leave `scanWithHash` and the scanner-outage behavior inside `finalize` unchanged. Only the new `storeAndScan` path attaches `details.mediaId` to scanner outages, as shown above.

- [ ] **Step 5: Add MediaAccessService, publish MediaReferenceReader, and order modules so the app still boots**

In `src/modules/media/media.types.ts`, add:

```ts
  MediaAccessService: Symbol.for('Media.MediaAccessService'),
```

Create `src/modules/media/logic/media-access.service.ts`:

```ts
import { inject, injectable } from 'inversify';
import type {
  IncomingMediaUpload,
  MediaAccess,
  MediaAsset,
  MediaDownload,
} from '@/core/media/media-access.port.js';
import type { MediaService } from '@/modules/media/logic/media.service.js';
import { MEDIA_TYPES } from '@/modules/media/media.types.js';

@injectable()
export class MediaAccessService implements MediaAccess {
  constructor(
    @inject(MEDIA_TYPES.MediaService) private readonly media: MediaService,
  ) {}

  requireReadyOwned(mediaId: string, userId: string): Promise<MediaAsset> {
    return this.media.requireReadyForUse(mediaId, userId);
  }

  storeAndScan(userId: string, input: IncomingMediaUpload): Promise<MediaAsset> {
    return this.media.storeAndScan(userId, input);
  }

  signDownload(mediaId: string): Promise<MediaDownload> {
    return this.media.signForReader(mediaId);
  }

  releaseIfUnreferenced(mediaId: string): Promise<void> {
    return this.media.releaseIfUnreferenced(mediaId);
  }

  assertDeletable(mediaId: string): Promise<void> {
    return this.media.assertDeletable(mediaId);
  }
}
```

In `src/modules/media/media.container.ts`, add before controller bindings:

```ts
    this.bind<MediaAccessService>(MEDIA_TYPES.MediaAccessService)
      .to(MediaAccessService)
      .inSingletonScope();
```

Do not bind `CORE_TYPES.MediaAccess` yet; Task 5 does that.

`MediaService` now resolves `CORE_TYPES.MediaReferenceReader` in its constructor, so
the app cannot boot until that binding exists and Messages is constructed before
Media. Add both in this task, not Task 5.

In `src/modules/messages/messages.types.ts`, add:

```ts
  MediaReferenceReader: Symbol.for('Messages.MediaReferenceReader'),
```

Create `src/modules/messages/logic/media-reference-reader.service.ts`:

```ts
import { inject, injectable } from 'inversify';
import type { MediaReferenceReader } from '@/core/media/media-reference.port.js';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';

@injectable()
export class MediaReferenceReaderService implements MediaReferenceReader {
  constructor(
    @inject(MESSAGES_TYPES.MessageRepository) private readonly messages: MessageRepository,
  ) {}

  hasLiveReferences(mediaId: string): Promise<boolean> {
    return this.messages.hasLiveMediaReferences(mediaId);
  }
}
```

In `src/modules/messages/messages.container.ts`, add the imports and bindings after the
`MessageService` binding:

```ts
    this.bind<MediaReferenceReaderService>(MESSAGES_TYPES.MediaReferenceReader)
      .to(MediaReferenceReaderService)
      .inSingletonScope();
    this.root
      .bind<MediaReferenceReader>(CORE_TYPES.MediaReferenceReader)
      .toConstantValue(this.get<MediaReferenceReaderService>(MESSAGES_TYPES.MediaReferenceReader));
```

Change **both** `MediaContainer` and `MessagesContainer` constructors from
`constructor(parent: Container) { super({ parent }); ... }` to
`constructor(private readonly root: Container) { super({ parent: root }); ... }` so
each can publish its core binding on the root container.

In `src/app/application.ts`, replace the `this.modules` array with:

```ts
    this.modules = [
      new HealthModule(container),
      new AuthModule(container, config),
      new StoriesModule(container),
      new E2eeModule(container),
      new MessagesModule(container),
      new MediaModule(container),
    ];
```

Module *mount* order is unchanged; only construction order changes. Without this,
`tests/integration/media/media-api.test.ts` will fail to boot at Step 7.

- [ ] **Step 6: Update positional MediaService constructors in tests**

In `tests/fixtures/media.fixture.ts` and `tests/unit/media-service.test.ts`, change each `new MediaService(repo, store, scanner, config)` to:

```ts
new MediaService(repo, store, scanner, config, new FakeReferences())
```

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```bash
npx vitest run tests/unit/media-access.service.test.ts tests/unit/media-service.test.ts tests/integration/media/media-api.test.ts && npm run typecheck
```

Expected: PASS; typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/app/application.ts src/modules/media/data/postgres-media-object.repository.ts src/modules/media/logic/media-access.service.ts src/modules/media/logic/media.service.ts src/modules/media/logic/ports/media-object.repository.ts src/modules/media/media.container.ts src/modules/media/media.types.ts src/modules/messages/logic/media-reference-reader.service.ts src/modules/messages/messages.container.ts src/modules/messages/messages.types.ts tests/fixtures/media.fixture.ts tests/unit/media-access.service.test.ts tests/unit/media-service.test.ts
git commit -m "feat(media): expose scanned assets through core access ports

Adds repository lookup by id and five MediaService methods that make the
scanned pipeline usable outside the media module: owner-checked readiness,
server-side store-and-scan, chat-authorized URL signing, reference-aware
release, and manual-delete guards. storeAndScan reuses the existing HEAD
metadata recheck, SHA-256 scanner stream, and version pinning, verifies the
declared byte count before any transition to ready, marks storage failures as
failed, and attaches mediaId to scanner-outage error details.

Introduces MediaAccessService as the media-module adapter for the new core
MediaAccess port and MediaReferenceReaderService as the messages-module adapter
for MediaReferenceReader. Both containers publish their adapter on the root,
and Application now constructs Messages before Media so MediaService can
resolve the reference reader at boot. Unit tests cover delegation,
redaction-safe signing, and reference guards. Existing positional MediaService
fixtures now inject a fake MediaReferenceReader."
```

---

### Task 5: Publish MediaAccess on the root container

**Files:**
- Modify: `src/modules/media/media.container.ts`
- Test: `tests/integration/media/core-port-wiring.test.ts`

**Interfaces:**
- Consumes: root-bound `CORE_TYPES.MediaReferenceReader` and module-scoped `MEDIA_TYPES.MediaAccessService` from Task 4.
- Produces: root-resolvable `CORE_TYPES.MediaAccess`.

- [ ] **Step 1: Write the failing wiring test**

Create `tests/integration/media/core-port-wiring.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { MediaAccess } from '@/core/media/media-access.port.js';
import type { MediaReferenceReader } from '@/core/media/media-reference.port.js';
import { MediaAccessService } from '@/modules/media/logic/media-access.service.js';
import { MediaReferenceReaderService } from '@/modules/messages/logic/media-reference-reader.service.js';
import { TestApp } from '@/tests/helpers/test-app.js';

describe('core media port wiring', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await TestApp.create();
  });

  afterAll(async () => {
    await app.close();
  });

  it('resolves both ports from the root container', () => {
    expect(app.container.get<MediaReferenceReader>(CORE_TYPES.MediaReferenceReader)).toBeInstanceOf(
      MediaReferenceReaderService,
    );
    expect(app.container.get<MediaAccess>(CORE_TYPES.MediaAccess)).toBeInstanceOf(
      MediaAccessService,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npx vitest run tests/integration/media/core-port-wiring.test.ts
```

Expected: FAIL because `CORE_TYPES.MediaAccess` is not bound. The
`CORE_TYPES.MediaReferenceReader` half of this test already passes after Task 4.

- [ ] **Step 3: Publish MediaAccess on the root container**

In `src/modules/media/media.container.ts`, add imports for `CORE_TYPES` and the
core `MediaAccess` type, then after the module-scoped `MediaAccessService` binding
add:

```ts
    this.root
      .bind<MediaAccess>(CORE_TYPES.MediaAccess)
      .toConstantValue(this.get<MediaAccessService>(MEDIA_TYPES.MediaAccessService));
```

The `root` field and the Messages-before-Media construction order were added in
Task 4, so no other wiring changes are needed here.

- [ ] **Step 4: Run focused test and full typecheck**

Run:

```bash
npx vitest run tests/integration/media/core-port-wiring.test.ts && npm run typecheck
```

Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/modules/media/media.container.ts tests/integration/media/core-port-wiring.test.ts
git commit -m "feat(media): publish MediaAccess on the root container

Publishes the media-module MediaAccessService adapter as the root-scoped
CORE_TYPES.MediaAccess symbol, following the existing E2EE precedent so the
messaging module never imports media layers. MediaReferenceReader was already
published by the messages module in the previous task, so a focused integration
test now resolves both core ports from the root and verifies their concrete
implementations."
```

---

### Task 6: MessageService attach, edit, forward, and delete behavior

**Files:**
- Create: `src/modules/messages/logic/media-kind.policy.ts`
- Modify: `src/modules/messages/logic/message.service.ts`
- Modify: `src/modules/messages/messages.container.ts`
- Modify: `src/modules/messages/messages.types.ts`
- Test: `tests/unit/message-media.service.test.ts`

**Interfaces:**
- Consumes: `MediaAccess`, `MessageRepository`, `MessagingPolicy`, `ChatRepository`, E2EE validators.
- Produces: `MessageService.sendMedia`, media-aware `forward`, media-rejecting `edit`, GC-triggering `remove`.

- [ ] **Step 1: Write the failing unit tests**

Create `tests/unit/message-media.service.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
} from '@/core/errors/http.error.js';
import { E2eeNotAllowedException } from '@/core/errors/domain.error.js';
import type { MediaAccess } from '@/core/media/media-access.port.js';
import type { MessageRecord } from '@/modules/messages/logic/entities/message-record.js';
import { MediaKindPolicy } from '@/modules/messages/logic/media-kind.policy.js';
import { MessageService } from '@/modules/messages/logic/message.service.js';

function record(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return new MessageRecord(
    'msg1', 'chat1', 'sender1', 'media', null, null, null, null,
    null, null, new Date(), null, null, null, null, null,
    overrides.media ?? {
      mediaId: 'media1',
      kind: 'image',
      caption: null,
      durationMs: null,
      width: null,
      height: null,
    },
  );
}

function setup(chatType: 'direct' | 'secret' = 'direct') {
  const created: unknown[] = [];
  const deleted: string[] = [];
  const released: string[] = [];
  const messages = {
    create: async (input: unknown) => {
      created.push(input);
      return record();
    },
    findById: async () => record(),
    markDeleted: async () => {
      deleted.push('msg1');
      return true;
    },
    editBody: async () => record(),
  };
  const chats = { findById: async () => ({ id: 'chat1', type: chatType }) };
  const policy = {
    requireMember: async () => undefined,
    assertChatUnblocked: async () => undefined,
  };
  const members = { listByChat: async () => [] };
  const mediaAccess = {
    requireReadyOwned: async () => ({
      id: 'media1',
      contentType: 'image/png',
      sizeBytes: 12,
      sha256: 'hash',
    }),
    storeAndScan: async () => ({
      id: 'media1',
      contentType: 'image/png',
      sizeBytes: 12,
      sha256: 'hash',
    }),
    signDownload: async () => ({
      url: 'https://signed',
      expiresAt: new Date(),
      contentType: 'image/png',
      sizeBytes: 12,
    }),
    releaseIfUnreferenced: async (mediaId: string) => {
      released.push(mediaId);
    },
    assertDeletable: async () => undefined,
  } as MediaAccess;
  const service = new MessageService(
    messages as never,
    policy as never,
    chats as never,
    members as never,
    {} as never,
    {} as never,
    mediaAccess,
    new MediaKindPolicy(),
  );
  return { service, created, deleted, released };
}

describe('MessageService media behavior', () => {
  it('attaches a ready owned object to a cloud chat', async () => {
    const { service, created } = setup();
    await service.sendMedia('sender1', 'chat1', {
      mediaId: 'media1',
      kind: 'image',
      caption: 'hello',
    });
    expect(created).toMatchObject([
      {
        chatId: 'chat1',
        senderId: 'sender1',
        type: 'media',
        body: null,
        media: { mediaId: 'media1', kind: 'image', caption: 'hello' },
      },
    ]);
  });

  it('rejects media before media lookup in secret chats', async () => {
    const { service, created } = setup('secret');
    await expect(
      service.sendMedia('sender1', 'chat1', { mediaId: 'media1', kind: 'image' }),
    ).rejects.toThrow(E2eeNotAllowedException);
    expect(created).toEqual([]);
  });

  it('rejects a kind that does not match the content type', async () => {
    const { service, created } = setup();
    await expect(
      service.sendMedia('sender1', 'chat1', { mediaId: 'media1', kind: 'gif' }),
    ).rejects.toThrow(BadRequestException);
    expect(created).toEqual([]);
  });

  it('rejects editing a media message', async () => {
    const { service } = setup();
    await expect(service.edit('sender1', 'chat1', 'msg1', 'new body')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('forwards media fields without an ownership check', async () => {
    const { service, created } = setup();
    await service.forward('sender1', 'chat1', 'msg1', 'chat2');
    expect(created).toMatchObject([
      {
        chatId: 'chat2',
        type: 'media',
        media: { mediaId: 'media1', kind: 'image' },
        forwardedFromChatId: 'chat1',
        forwardedFromMessageId: 'msg1',
      },
    ]);
  });

  it('releases media after deleting the last known reference', async () => {
    const { service, deleted, released } = setup();
    await service.remove('sender1', 'chat1', 'msg1');
    expect(deleted).toEqual(['msg1']);
    expect(released).toEqual(['media1']);
  });

  it('still forbids non-sender deletion', async () => {
    const { service, released } = setup();
    await expect(service.remove('other', 'chat1', 'msg1')).rejects.toThrow(ForbiddenException);
    expect(released).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npx vitest run tests/unit/message-media.service.test.ts
```

Expected: FAIL because `sendMedia`, media-aware forward/edit/delete, and `MediaAccess` constructor injection do not exist.

- [ ] **Step 3: Implement MediaKindPolicy**

Create `src/modules/messages/logic/media-kind.policy.ts`:

```ts
import { BadRequestException } from '@/core/errors/http.error.js';
import type { MediaKind } from '@/modules/messages/logic/entities/message-record.js';

const FAMILIES: Readonly<Record<MediaKind, readonly string[]>> = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  video: ['video/mp4', 'video/webm'],
  document: [],
  voice_note: ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/mp4'],
  sticker: ['image/webp', 'image/png'],
  gif: ['image/gif'],
};

/** Validates the client-supplied discriminator against the scanned object type. */
export class MediaKindPolicy {
  assertMatches(kind: MediaKind, contentType: string): void {
    if (kind === 'document') {
      return;
    }

    if (!FAMILIES[kind].includes(contentType)) {
      throw new BadRequestException(`Content type ${contentType} is not valid for kind ${kind}`);
    }
  }
}
```

In `src/modules/messages/messages.types.ts`, add:

```ts
  MediaKindPolicy: Symbol.for('Messages.MediaKindPolicy'),
```

Bind it in `src/modules/messages/messages.container.ts`:

```ts
    this.bind<MediaKindPolicy>(MESSAGES_TYPES.MediaKindPolicy)
      .to(MediaKindPolicy)
      .inSingletonScope();
```

- [ ] **Step 4: Extend MessageService**

In `src/modules/messages/logic/message.service.ts`, add imports for `CORE_TYPES`, `MediaAccess`, `MediaKindPolicy`, and `SendMediaMessageInput` type only if needed. Define:

```ts
export interface SendMediaMessageInput {
  mediaId: string;
  kind: MediaKind;
  caption?: string | undefined;
  durationMs?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  replyToMessageId?: string | undefined;
}
```

Add to the constructor:

```ts
    @inject(CORE_TYPES.MediaAccess) private readonly mediaAccess: MediaAccess,
    @inject(MESSAGES_TYPES.MediaKindPolicy) private readonly kinds: MediaKindPolicy,
```

Add `sendMedia` after `send`:

```ts
  async sendMedia(
    userId: string,
    chatId: string,
    input: SendMediaMessageInput,
  ): Promise<MessageRecord> {
    await this.rejectSecretChat(chatId);
    await this.policy.requireMember(chatId, userId);
    await this.policy.assertChatUnblocked(chatId, userId);

    if (input.replyToMessageId !== undefined) {
      const target = await this.messages.findById(chatId, input.replyToMessageId);
      if (!target) {
        throw new BadRequestException('Reply target must belong to this chat');
      }
    }

    const asset = await this.mediaAccess.requireReadyOwned(input.mediaId, userId);
    this.kinds.assertMatches(input.kind, asset.contentType);

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
    });
  }
```

Define a separate upload input so combined requests never carry a `mediaId`
(the stored id comes from `storeAndScan`):

```ts
export interface SendMediaFromUploadInput {
  kind: MediaKind;
  caption?: string | undefined;
  durationMs?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  replyToMessageId?: string | undefined;
  contentType: string;
  sizeBytes: number;
  body: IncomingMediaUpload['body'];
  assertComplete: () => Promise<void>;
}
```

```ts
  async sendMediaFromUpload(
    userId: string,
    chatId: string,
    input: SendMediaFromUploadInput,
  ): Promise<MessageRecord> {
    await this.rejectSecretChat(chatId);
    await this.policy.requireMember(chatId, userId);
    await this.policy.assertChatUnblocked(chatId, userId);

    if (input.replyToMessageId !== undefined) {
      const target = await this.messages.findById(chatId, input.replyToMessageId);
      if (!target) {
        throw new BadRequestException('Reply target must belong to this chat');
      }
    }

    // Validate before storing so a rejected kind cannot leave an unowned ready object.
    this.kinds.assertMatches(input.kind, input.contentType);

    const asset = await this.mediaAccess.storeAndScan(userId, {
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      body: input.body,
      assertComplete: input.assertComplete,
    });

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
    });
  }
```

In `edit`, after `assertSender` and the deleted check:

```ts
    if (message.media !== null) {
      throw new BadRequestException('Media messages cannot be edited');
    }
```

In `remove`, after `assertSender` and before `markDeleted`:

```ts
    const mediaId = message.media?.mediaId ?? null;
```

After `markDeleted`:

```ts
    if (mediaId !== null) {
      await this.mediaAccess.releaseIfUnreferenced(mediaId);
    }
```

In `forward`, replace the condition and create input with:

```ts
    if (original.deletedAt !== null || (original.body === null && original.media === null)) {
      throw new BadRequestException('Deleted messages cannot be forwarded');
    }

    return this.messages.create({
      chatId: targetChatId,
      senderId: userId,
      body: original.media === null ? original.body : null,
      type: original.media === null ? 'text' : 'media',
      media: original.media,
      forwardedFromChatId: sourceChatId,
      forwardedFromMessageId: messageId,
    });
```

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
npx vitest run tests/unit/message-media.service.test.ts && npm run typecheck
```

Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/modules/messages/logic/media-kind.policy.ts src/modules/messages/logic/message.service.ts src/modules/messages/messages.container.ts src/modules/messages/messages.types.ts tests/unit/message-media.service.test.ts
git commit -m "feat(messaging): send and forward media messages

Adds owner-checked attachment and single-request upload send methods to
MessageService. Both reject secret chats before touching media state, require
membership and an unblocked chat, validate reply targets, and verify the
client-supplied kind against the scanned object's content type.

Editing a media message is rejected because captions are immutable in this
phase. Forwarding copies the media value object into a new cloud message without
requiring the forwarder to own the object, and deletion captures the media id,
tombstones the row, then asks MediaAccess to release it if no live references
remain. Unit tests pin all of those transitions plus the secret-chat and
non-sender guards."
```

---

### Task 7: Message presenter, attach DTOs, and attach route

**Files:**
- Create: `src/modules/messages/web/message-presenter.service.ts`
- Modify: `src/modules/messages/web/message.controller.ts`
- Modify: `src/modules/messages/web/dto/message.schemas.ts`
- Modify: `src/modules/messages/web/dto/message.openapi.ts`
- Modify: `src/modules/messages/web/routes/messages.router.ts`
- Modify: `src/modules/messages/messages.container.ts`
- Modify: `src/modules/messages/messages.types.ts`
- Test: `tests/integration/messages/media-messages.test.ts`

**Interfaces:**
- Consumes: `MessageRecord`, `MediaAccess.signDownload`, `MessageService.sendMedia`.
- Produces: `MessagePresenter.present`, `sendMediaMessageSchema`, `mediaMessageResponseSchema`, `POST /api/chats/:chatId/messages/media`.

- [ ] **Step 1: Write the failing integration tests**

Create `tests/integration/messages/media-messages.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectError, expectSuccess } from '@/tests/helpers/assertions.js';
import { AuthFixture } from '@/tests/fixtures/auth.fixture.js';
import { MediaFixture } from '@/tests/fixtures/media.fixture.js';
import { MessagingApiFixture } from '@/tests/integration/messages/messaging-api.fixture.js';
import { TestApp } from '@/tests/helpers/test-app.js';

describe('media message attach mode', () => {
  let app: TestApp;
  let auth: AuthFixture;
  let messaging: MessagingApiFixture;
  let media: MediaFixture;

  beforeAll(async () => {
    app = await TestApp.create();
    auth = new AuthFixture(app);
    messaging = new MessagingApiFixture(app);
    media = new MediaFixture(app);
  });

  afterAll(async () => {
    await media.cleanup();
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
    auth.emails.clear();
    media.scanner.mode = 'clean';
  });

  async function readyPng(headers: Record<string, string>) {
    const ticketResponse = await app.request
      .post('/api/media/uploads')
      .set(headers)
      .send({ contentType: 'image/png', sizeBytes: 11 });
    const ticket = expectSuccess<{
      mediaId: string;
      objectKey: string;
      uploadUrl: string;
      headers: Record<string, string>;
    }>(ticketResponse, 201);
    media.track(ticket);
    await media.put(ticket, Buffer.from('clean-bytes'), 'image/png');
    const finalized = await app.request
      .post(`/api/media/${ticket.mediaId}/finalize`)
      .set(headers);
    expectSuccess(finalized, 200);
    return ticket.mediaId;
  }

  it('attaches a ready object and returns a signed URL to a non-owner member', async () => {
    const sender = await messaging.verifiedUser('Sender');
    const recipient = await messaging.verifiedUser('Recipient');
    const chatId = await messaging.openDirectChat(recipient.id, sender.headers);
    const mediaId = await readyPng(sender.headers);

    const sent = await app.request
      .post(`/api/chats/${chatId}/messages/media`)
      .set(sender.headers)
      .send({ mediaId, kind: 'image', caption: 'look' });
    const message = expectSuccess<{
      id: string;
      type: string;
      body: string | null;
      media: {
        mediaId: string;
        kind: string;
        contentType: string;
        sizeBytes: number;
        caption: string | null;
        downloadUrl: string;
      };
    }>(sent, 201);

    expect(message.type).toBe('media');
    expect(message.body).toBeNull();
    expect(message.media.mediaId).toBe(mediaId);
    expect(JSON.stringify(message)).not.toContain('objectKey');
    expect(JSON.stringify(message)).not.toContain('sha256');

    const listed = await app.request.get(`/api/chats/${chatId}/messages`).set(recipient.headers);
    const page = expectSuccess<Array<{ media: { downloadUrl: string } }>>(listed, 200);
    const response = await fetch(page[0]!.media.downloadUrl);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('clean-bytes');
  });

  it('rejects media in a secret chat before creating a message', async () => {
    const sender = await messaging.verifiedUser('Sender');
    const recipient = await messaging.verifiedUser('Recipient');
    const device = await messaging.registerDevice(recipient);
    await messaging.registerDevice(sender);
    const chatId = await messaging.openSecretChat(recipient.id, sender.headers);
    const mediaId = await readyPng(sender.headers);

    const response = await app.request
      .post(`/api/chats/${chatId}/messages/media`)
      .set(sender.headers)
      .send({ mediaId, kind: 'image' });
    expectError(response, 403, 'E2EE_NOT_ALLOWED');

    const listed = await app.request.get(`/api/chats/${chatId}/messages`).set(sender.headers);
    expect(expectSuccess<unknown[]>(listed, 200)).toEqual([]);
  });

  it('rejects a non-member, an unverified user, and a kind mismatch', async () => {
    const sender = await messaging.verifiedUser('Sender');
    const outsider = await messaging.verifiedUser('Outsider');
    const recipient = await messaging.verifiedUser('Recipient');
    const chatId = await messaging.openDirectChat(recipient.id, sender.headers);
    const mediaId = await readyPng(sender.headers);

    expectError(
      await app.request
        .post(`/api/chats/${chatId}/messages/media`)
        .set(outsider.headers)
        .send({ mediaId, kind: 'image' }),
      403,
      'NOT_CHAT_MEMBER',
    );

    const unverified = await messaging.unverifiedUser('Unverified');
    expectError(
      await app.request
        .post(`/api/chats/${chatId}/messages/media`)
        .set(unverified.headers)
        .send({ mediaId, kind: 'image' }),
      403,
      'EMAIL_NOT_VERIFIED',
    );

    expectError(
      await app.request
        .post(`/api/chats/${chatId}/messages/media`)
        .set(sender.headers)
        .send({ mediaId, kind: 'gif' }),
      400,
      'VALIDATION_ERROR',
    );
  });

  it('rejects a non-ready media id', async () => {
    const sender = await messaging.verifiedUser('Sender');
    const recipient = await messaging.verifiedUser('Recipient');
    const chatId = await messaging.openDirectChat(recipient.id, sender.headers);

    const ticketResponse = await app.request
      .post('/api/media/uploads')
      .set(sender.headers)
      .send({ contentType: 'image/png', sizeBytes: 9 });
    const ticket = expectSuccess<{ mediaId: string; objectKey: string }>(ticketResponse, 201);
    media.track(ticket as never);

    expectError(
      await app.request
        .post(`/api/chats/${chatId}/messages/media`)
        .set(sender.headers)
        .send({ mediaId: ticket.mediaId, kind: 'image' }),
      409,
      'MEDIA_NOT_READY',
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npx vitest run tests/integration/messages/media-messages.test.ts
```

Expected: FAIL with `404` for the attach route.

- [ ] **Step 3: Add DTO schemas**

In `src/modules/messages/web/dto/message.schemas.ts`, add:

```ts
export const mediaKindSchema = z.enum([
  'image',
  'video',
  'document',
  'voice_note',
  'sticker',
  'gif',
]);

const optionalMediaMetadata = {
  caption: z.string().trim().min(1).max(1000).optional(),
  durationMs: z.number().int().min(1).max(86_400_000).optional(),
  width: z.number().int().min(1).max(16_384).optional(),
  height: z.number().int().min(1).max(16_384).optional(),
  replyToMessageId: z.uuid().optional(),
};

export const sendMediaMessageSchema = z.object({
  mediaId: z.uuid(),
  kind: mediaKindSchema,
  ...optionalMediaMetadata,
});

export const combinedMediaFieldsSchema = z.object({
  kind: mediaKindSchema,
  sizeBytes: z.coerce.number().int().positive(),
  ...optionalMediaMetadata,
});

export type SendMediaMessageSchema = z.infer<typeof sendMediaMessageSchema>;
export type CombinedMediaFieldsSchema = z.infer<typeof combinedMediaFieldsSchema>;
```

- [ ] **Step 4: Add the presenter**

Create `src/modules/messages/web/message-presenter.service.ts`:

```ts
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { MediaAccess } from '@/core/media/media-access.port.js';
import type { MessageRecord } from '@/modules/messages/logic/entities/message-record.js';

@injectable()
export class MessagePresenter {
  constructor(@inject(CORE_TYPES.MediaAccess) private readonly media: MediaAccess) {}

  async present(message: MessageRecord): Promise<Record<string, unknown>> {
    const base = {
      id: message.id,
      chatId: message.chatId,
      senderId: message.senderId,
      type: message.type,
      body: message.deletedAt === null ? message.body : null,
      replyToMessageId: message.replyToMessageId,
      forwardedFromChatId: message.forwardedFromChatId,
      forwardedFromMessageId: message.forwardedFromMessageId,
      editedAt: message.editedAt?.toISOString() ?? null,
      deletedAt: message.deletedAt?.toISOString() ?? null,
      createdAt: message.createdAt.toISOString(),
      ciphertext: message.ciphertext,
      nonce: message.nonce,
      ephemeralPublicKey: message.ephemeralPublicKey,
      senderDeviceId: message.senderDeviceId,
      recipientDeviceId: message.recipientDeviceId,
      media: null as Record<string, unknown> | null,
    };

    if (message.media === null || message.deletedAt !== null) {
      return base;
    }

    const download = await this.media.signDownload(message.media.mediaId);

    return {
      ...base,
      media: {
        mediaId: message.media.mediaId,
        kind: message.media.kind,
        contentType: download.contentType,
        sizeBytes: download.sizeBytes,
        caption: message.media.caption,
        durationMs: message.media.durationMs,
        width: message.media.width,
        height: message.media.height,
        downloadUrl: download.url,
        expiresAt: download.expiresAt.toISOString(),
      },
    };
  }
}
```

In `src/modules/messages/messages.types.ts`, add:

```ts
  MessagePresenter: Symbol.for('Messages.MessagePresenter'),
```

In `src/modules/messages/messages.container.ts`, bind:

```ts
    this.bind<MessagePresenter>(MESSAGES_TYPES.MessagePresenter).to(MessagePresenter);
```

- [ ] **Step 5: Refactor MessageController to use the presenter and add sendMedia**

Replace `MessageController`'s constructor and imports with:

```ts
import type { Request, RequestHandler } from 'express';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { UnauthorizedException } from '@/core/errors/http.error.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';
import type { MessageService } from '@/modules/messages/logic/message.service.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import type { MessagePresenter } from '@/modules/messages/web/message-presenter.service.js';
import {
  chatParamsSchema,
  editMessageSchema,
  forwardMessageSchema,
  listMessagesQuerySchema,
  messageParamsSchema,
  sendMediaMessageSchema,
  sendMessageSchema,
  sendSecretMessageSchema,
} from '@/modules/messages/web/dto/message.schemas.js';

@injectable()
export class MessageController {
  constructor(
    @inject(MESSAGES_TYPES.MessageService) private readonly messages: MessageService,
    @inject(MESSAGES_TYPES.MessagePresenter) private readonly presenter: MessagePresenter,
    @inject(CORE_TYPES.ApiResponse) private readonly response: ApiResponse,
  ) {}
```

Replace every `this.present(...)` call with `await this.presenter.present(...)`, including inside `page.map`:

```ts
      await Promise.all(page.map((message) => this.presenter.present(message))),
```

Replace the private `present` method with nothing, and add after `send`:

```ts
  sendMedia: RequestHandler = async (req, res) => {
    const { userId } = this.requireAuth(req);
    const { chatId } = chatParamsSchema.parse(req.params);
    const input = sendMediaMessageSchema.parse(req.body);
    const message = await this.messages.sendMedia(userId, chatId, input);

    this.response.created(res, await this.presenter.present(message));
  };
```

- [ ] **Step 6: Register the attach route and OpenAPI contract**

In `src/modules/messages/web/dto/message.openapi.ts`, change `messageSchema` type to include `'media'` and add a nullable `media` object:

```ts
  type: z.enum(['text', 'system', 'secret', 'media']),
```

```ts
  media: z
    .object({
      mediaId: z.uuid(),
      kind: z.enum(['image', 'video', 'document', 'voice_note', 'sticker', 'gif']),
      contentType: z.string(),
      sizeBytes: z.number().int().positive(),
      caption: z.string().nullable(),
      durationMs: z.number().int().nullable(),
      width: z.number().int().nullable(),
      height: z.number().int().nullable(),
      downloadUrl: z.url(),
      expiresAt: z.iso.datetime(),
    })
    .nullable(),
```

In `src/modules/messages/web/dto/message.openapi.ts`, add `apiErrorResponseSchema`
and `conflictErrorResponse` to the existing import from
`@/core/http/openapi/openapi.schemas.js`, add `OpenApiResponseContract` to the
type import from `@/core/http/openapi/openapi.types.js`, and add
`sendMediaMessageSchema` to the import from `message.schemas.js`. Add a local
`errorResponse` helper beside `bearerSecurity`, using the same pattern as
`media.openapi.ts` (this file has no such helper today):

```ts
const errorResponse = (description: string): OpenApiResponseContract => ({
  description,
  schema: apiErrorResponseSchema,
});
```

Add a contract after `sendMessage`:

```ts
  sendMedia: {
    operationId: 'messages.sendMedia',
    tags: ['Messages'],
    summary: 'Attach a ready media object to a cloud chat message',
    security: bearerSecurity,
    request: {
      params: chatParamsSchema,
      body: sendMediaMessageSchema,
    },
    responses: {
      201: messageResponse,
      ...commonErrorResponses,
      409: conflictErrorResponse,
    },
  },
```

In `src/modules/messages/web/routes/messages.router.ts`, add after the existing `POST /:chatId/messages` route:

```ts
    routes.post(
      '/:chatId/messages/media',
      messageContracts.sendMedia,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container
          .get<MessageController>(MESSAGES_TYPES.MessageController)
          .sendMedia(req, res, next),
    );
```

- [ ] **Step 7: Run the focused test and typecheck**

Run:

```bash
npx vitest run tests/integration/messages/media-messages.test.ts && npm run typecheck
```

Expected: PASS; typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/modules/messages/messages.container.ts src/modules/messages/messages.types.ts src/modules/messages/web/dto/message.openapi.ts src/modules/messages/web/dto/message.schemas.ts src/modules/messages/web/message-presenter.service.ts src/modules/messages/web/message.controller.ts src/modules/messages/web/routes/messages.router.ts tests/integration/messages/media-messages.test.ts
git commit -m "feat(messaging): attach scanned media to cloud messages

Adds POST /api/chats/:chatId/messages/media for attaching an already-ready
mediaId. The Zod schema validates the kind discriminator and optional caption
and metadata, while OpenAPI documents the same schema with a messages.sendMedia
operation id.

Extracts message presentation into an async MessagePresenter that signs a
download URL only after the service has authorized chat membership. Recipients
receive contentType, size, and the signed URL, but never object keys, version
ids, hashes, or scan details. Integration tests pin attach success for a
non-owner member, secret-chat rejection, non-member and unverified denials,
kind mismatch, and non-ready media."
```

---

### Task 8: Multipart combined upload-and-send route

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `src/core/media/media-form.schema.ts`
- Create: `src/modules/messages/web/multipart-media.parser.ts`
- Modify: `src/modules/messages/messages.types.ts`
- Modify: `src/modules/messages/messages.container.ts`
- Modify: `src/modules/messages/web/message.controller.ts`
- Modify: `src/modules/messages/web/dto/message.schemas.ts`
- Modify: `src/modules/messages/web/dto/message.openapi.ts`
- Modify: `src/modules/messages/web/routes/messages.router.ts`
- Modify: `src/modules/media/web/dto/media.openapi.ts`
- Test: `tests/unit/multipart-media.parser.test.ts`
- Modify: `tests/integration/messages/media-messages.test.ts`

**Interfaces:**
- Consumes: `IncomingMediaUpload`, `MediaService.storeAndScan`, `combinedMediaFieldsSchema`.
- Produces: `MultipartMediaParser.parse`, `POST /api/chats/:chatId/messages/media/upload`, `messages.uploadMedia`.

- [ ] **Step 1: Install busboy and write parser unit tests**

Run:

```bash
npm install busboy@1.6.0
npm install -D @types/busboy@1.5.4
```

Create `tests/unit/multipart-media.parser.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@/core/errors/http.error.js';
import { MultipartMediaParser } from '@/modules/messages/web/multipart-media.parser.js';

function requestWith(body: Buffer, contentType: string) {
  return {
    headers: { 'content-type': contentType },
    async *[Symbol.asyncIterator]() {
      yield body;
    },
    pipe<T>(target: T): T {
      process.nextTick(() => {
        (target as { end: (chunk?: Buffer) => void; write: (chunk: Buffer) => void }).write(body);
        (target as { end: (chunk?: Buffer) => void }).end();
      });
      return target;
    },
  };
}

describe('MultipartMediaParser', () => {
  const boundary = '----testboundary';

  it('parses fields before the file and verifies exact size', async () => {
    const file = Buffer.from('clean-bytes');
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nimage\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="sizeBytes"\r\n\r\n${file.length}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\n` +
        `Content-Type: image/png\r\n\r\n`,
    ).toString('utf8') + file.toString('utf8') + `\r\n--${boundary}--\r\n`;

    const parsed = await new MultipartMediaParser().parse(
      requestWith(Buffer.from(body), `multipart/form-data; boundary=${boundary}`) as never,
      1000,
    );

    expect(parsed.fields.kind).toBe('image');
    expect(parsed.contentType).toBe('image/png');
    expect(parsed.sizeBytes).toBe(file.length);
    await expect(parsed.assertComplete()).resolves.toBeUndefined();
  });

  it('rejects a file that arrives before sizeBytes', async () => {
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\n` +
      `Content-Type: image/png\r\n\r\nabc\r\n--${boundary}--\r\n`;

    await expect(
      new MultipartMediaParser().parse(
        requestWith(Buffer.from(body), `multipart/form-data; boundary=${boundary}`) as never,
        1000,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a request with no file part', async () => {
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nimage\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="sizeBytes"\r\n\r\n3\r\n` +
      `--${boundary}--\r\n`;

    await expect(
      new MultipartMediaParser().parse(
        requestWith(Buffer.from(body), `multipart/form-data; boundary=${boundary}`) as never,
        1000,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a declared size above the configured maximum', async () => {
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nimage\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="sizeBytes"\r\n\r\n1000\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\n` +
      `Content-Type: image/png\r\n\r\nabc\r\n--${boundary}--\r\n`;

    await expect(
      new MultipartMediaParser().parse(
        requestWith(Buffer.from(body), `multipart/form-data; boundary=${boundary}`) as never,
        100,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a second file part through assertComplete', async () => {
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nimage\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="sizeBytes"\r\n\r\n3\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n` +
      `Content-Type: image/png\r\n\r\nabc\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="b.png"\r\n` +
      `Content-Type: image/png\r\n\r\ndef\r\n--${boundary}--\r\n`;

    const parsed = await new MultipartMediaParser().parse(
      requestWith(Buffer.from(body), `multipart/form-data; boundary=${boundary}`) as never,
      1000,
    );
    await expect(parsed.assertComplete()).rejects.toThrow(BadRequestException);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npx vitest run tests/unit/multipart-media.parser.test.ts
```

Expected: FAIL because `MultipartMediaParser` does not exist.

- [ ] **Step 3: Implement the parser**

Create `src/modules/messages/web/multipart-media.parser.ts`:

```ts
import type { IncomingMessage, Request } from 'express';
import { PassThrough, type Readable } from 'node:stream';
import Busboy from 'busboy';
import { injectable } from 'inversify';
import { BadRequestException } from '@/core/errors/http.error.js';
import type { CombinedMediaFieldsSchema } from '@/modules/messages/web/dto/message.schemas.js';
import { combinedMediaFieldsSchema } from '@/modules/messages/web/dto/message.schemas.js';

export interface ParsedMultipartMedia {
  readonly fields: CombinedMediaFieldsSchema;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly body: Readable;
  assertComplete(): Promise<void>;
}

/** Bounded busboy parser; text fields must precede the single file part. */
@injectable()
export class MultipartMediaParser {
  parse(req: Request | IncomingMessage, maxFileBytes: number): Promise<ParsedMultipartMedia> {
    return new Promise((resolve, reject) => {
      let busboy: ReturnType<typeof Busboy>;
      try {
        busboy = Busboy({
          headers: req.headers,
          limits: { files: 1, fields: 7, fieldSize: 8192, fileSize: maxFileBytes, parts: 9 },
        });
      } catch (error) {
        reject(new BadRequestException('Invalid multipart request', { cause: error }));
        return;
      }

      const fields: Record<string, string> = {};
      let settled = false;
      let fileSeen = false;
      let fileEnded = false;
      const body = new PassThrough({ highWaterMark: 64 * 1024 });
      let observedBytes = 0;
      let declaredBytes = 0;
      let resolveComplete!: () => void;
      let rejectComplete!: (error: unknown) => void;
      const complete = new Promise<void>((ok, fail) => {
        resolveComplete = ok;
        rejectComplete = fail;
      });
      // A failed parse never reaches a caller that would await assertComplete().
      complete.catch(() => {});

      const failOnce = (error: unknown): void => {
        if (!settled) {
          settled = true;
          reject(error);
        }
        rejectComplete(error);
      };

      busboy.on('field', (name, value) => {
        if (fileSeen) {
          failOnce(new BadRequestException('Multipart fields must precede the file part'));
          return;
        }
        fields[name] = value;
      });

      busboy.on('file', (_name, stream, info) => {
        if (fileSeen) {
          failOnce(new BadRequestException('Exactly one file is allowed'));
          return;
        }
        fileSeen = true;
        const declared = Number(fields.sizeBytes);
        if (!Number.isSafeInteger(declared) || declared < 1 || declared > maxFileBytes) {
          failOnce(new BadRequestException('sizeBytes must be a positive bounded integer'));
          return;
        }
        declaredBytes = declared;

        stream.on('data', (chunk: Buffer) => {
          observedBytes += chunk.length;
          if (observedBytes > declaredBytes) {
            failOnce(new BadRequestException('File exceeds declared sizeBytes'));
            stream.destroy();
          }
        });
        stream.on('error', failOnce);
        stream.on('end', () => {
          if (observedBytes !== declaredBytes) {
            failOnce(new BadRequestException('File size does not match sizeBytes'));
            return;
          }
          fileEnded = true;
        });
        stream.pipe(body);

        if (settled) {
          return;
        }
        try {
          const parsedFields = combinedMediaFieldsSchema.parse(fields);
          settled = true;
          resolve({
            fields: parsedFields,
            contentType: info.mimeType,
            sizeBytes: declaredBytes,
            body,
            assertComplete: () => complete,
          });
        } catch (error) {
          failOnce(error);
        }
      });

      busboy.on('filesLimit', () =>
        failOnce(new BadRequestException('Exactly one file is allowed')),
      );
      busboy.on('fieldsLimit', () => failOnce(new BadRequestException('Too many form fields')));
      busboy.on('partsLimit', () => failOnce(new BadRequestException('Too many form parts')));
      busboy.on('error', failOnce);
      busboy.on('close', () => {
        if (!fileSeen) {
          failOnce(new BadRequestException('A file part is required'));
          return;
        }
        if (!fileEnded) {
          failOnce(new BadRequestException('File stream ended before the part completed'));
          return;
        }
        resolveComplete();
      });

      req.pipe(busboy);
    });
  }
}
```

This parser imports a messages DTO. To preserve module boundaries, move `combinedMediaFieldsSchema` into `src/core/media/media-form.schema.ts` in this same task, re-export it from `message.schemas.ts`, and have both the parser and controller import the core file. Create `src/core/media/media-form.schema.ts`:

```ts
import { z } from 'zod';

export const mediaKindSchema = z.enum([
  'image',
  'video',
  'document',
  'voice_note',
  'sticker',
  'gif',
]);

export const combinedMediaFieldsSchema = z.object({
  kind: mediaKindSchema,
  sizeBytes: z.coerce.number().int().positive(),
  caption: z.string().trim().min(1).max(1000).optional(),
  durationMs: z.number().int().min(1).max(86_400_000).optional(),
  width: z.number().int().min(1).max(16_384).optional(),
  height: z.number().int().min(1).max(16_384).optional(),
  replyToMessageId: z.uuid().optional(),
});

export type CombinedMediaFieldsSchema = z.infer<typeof combinedMediaFieldsSchema>;
export type MediaKind = (typeof mediaKindSchema.options)[number];
```

`MediaKind` here is structurally identical to the one exported from
`message-record.ts` in Task 1. Core cannot import from a feature module, so the
two literal unions are duplicated; keep `MESSAGE_MEDIA_KINDS` and
`mediaKindSchema.options` in sync.

Change `src/modules/messages/web/dto/message.schemas.ts` to import and re-export these values:

```ts
export { combinedMediaFieldsSchema, mediaKindSchema } from '@/core/media/media-form.schema.js';
export type { CombinedMediaFieldsSchema, MediaKind } from '@/core/media/media-form.schema.js';
```

Change the parser import to:

```ts
import {
  combinedMediaFieldsSchema,
  type CombinedMediaFieldsSchema,
} from '@/core/media/media-form.schema.js';
```

- [ ] **Step 4: Add the combined controller method and route**

In `src/modules/messages/messages.types.ts`, add:

```ts
  MultipartMediaParser: Symbol.for('Messages.MultipartMediaParser'),
```

In `src/modules/messages/messages.container.ts`, bind:

```ts
    this.bind<MultipartMediaParser>(MESSAGES_TYPES.MultipartMediaParser)
      .to(MultipartMediaParser)
      .inSingletonScope();
```

In `src/modules/messages/web/message.controller.ts`, add imports and constructor parameter:

```ts
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { MultipartMediaParser } from '@/modules/messages/web/multipart-media.parser.js';
import { combinedMediaFieldsSchema } from '@/core/media/media-form.schema.js';
```

```ts
    @inject(MESSAGES_TYPES.MultipartMediaParser) private readonly parser: MultipartMediaParser,
    @inject(CORE_TYPES.Config) private readonly config: AppConfig,
```

Add the handler:

```ts
  uploadMedia: RequestHandler = async (req, res) => {
    const { userId } = this.requireAuth(req);
    const { chatId } = chatParamsSchema.parse(req.params);
    const upload = await this.parser.parse(req, this.config.media.maxBytes);
    const message = await this.messages.sendMediaFromUpload(userId, chatId, {
      kind: upload.fields.kind,
      caption: upload.fields.caption,
      durationMs: upload.fields.durationMs,
      width: upload.fields.width,
      height: upload.fields.height,
      replyToMessageId: upload.fields.replyToMessageId,
      contentType: upload.contentType,
      sizeBytes: upload.sizeBytes,
      body: upload.body,
      assertComplete: upload.assertComplete,
    });

    this.response.created(res, await this.presenter.present(message));
  };
```

No `mediaId` is passed here: Task 6 defined `SendMediaFromUploadInput` without one,
and `storeAndScan` supplies the stored id.

In `src/modules/messages/web/dto/message.openapi.ts`, add:

```ts
  uploadMedia: {
    operationId: 'messages.uploadMedia',
    tags: ['Messages'],
    summary: 'Upload a file and send it as a cloud media message',
    security: bearerSecurity,
    request: {
      params: chatParamsSchema,
      body: combinedMediaFieldsSchema.extend({
        file: z.string().meta({ format: 'binary' }),
      }),
      contentType: 'multipart/form-data',
    },
    responses: {
      201: messageResponse,
      ...commonErrorResponses,
      409: conflictErrorResponse,
      422: errorResponse('The uploaded file is infected', apiErrorResponseSchema),
      503: errorResponse('Virus scanning is temporarily unavailable', apiErrorResponseSchema),
    },
  },
```

Use the local `errorResponse` helper already defined in that file; add `apiErrorResponseSchema` to its imports from `@/core/http/openapi/openapi.schemas.js`.

In `src/modules/messages/web/routes/messages.router.ts`, add after the attach route:

```ts
    routes.post(
      '/:chatId/messages/media/upload',
      messageContracts.uploadMedia,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container
          .get<MessageController>(MESSAGES_TYPES.MessageController)
          .uploadMedia(req, res, next),
    );
```

In `src/modules/media/web/dto/media.openapi.ts`, add to `mediaErrors`:

```ts
  409: errorResponse('Media object is not ready or is referenced by a message'),
```

- [ ] **Step 5: Add combined integration tests**

Append to `tests/integration/messages/media-messages.test.ts`:

```ts
  it('uploads and sends a clean file in one request', async () => {
    const sender = await messaging.verifiedUser('Sender');
    const recipient = await messaging.verifiedUser('Recipient');
    const chatId = await messaging.openDirectChat(recipient.id, sender.headers);

    const response = await app.request
      .post(`/api/chats/${chatId}/messages/media/upload`)
      .set(sender.headers)
      .field('kind', 'image')
      .field('sizeBytes', '11')
      .attach('file', Buffer.from('clean-bytes'), { filename: 'x.png', contentType: 'image/png' });

    const message = expectSuccess<{ media: { downloadUrl: string; contentType: string } }>(
      response,
      201,
    );
    expect(message.media.contentType).toBe('image/png');
    const download = await fetch(message.media.downloadUrl);
    expect(await download.text()).toBe('clean-bytes');
  });

  it('rejects infected combined uploads without creating a message', async () => {
    media.scanner.mode = 'infected';
    const sender = await messaging.verifiedUser('Sender');
    const recipient = await messaging.verifiedUser('Recipient');
    const chatId = await messaging.openDirectChat(recipient.id, sender.headers);
    const eicar = Buffer.from(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    );

    const response = await app.request
      .post(`/api/chats/${chatId}/messages/media/upload`)
      .set(sender.headers)
      .field('kind', 'document')
      .field('sizeBytes', String(eicar.length))
      .attach('file', eicar, { filename: 'eicar.txt', contentType: 'application/octet-stream' });

    expectError(response, 422, 'MEDIA_INFECTED');
    const listed = await app.request.get(`/api/chats/${chatId}/messages`).set(sender.headers);
    expect(expectSuccess<unknown[]>(listed, 200)).toEqual([]);
  });

  it('returns 503 with mediaId on scanner outage and creates no message', async () => {
    media.scanner.mode = 'unavailable';
    const sender = await messaging.verifiedUser('Sender');
    const recipient = await messaging.verifiedUser('Recipient');
    const chatId = await messaging.openDirectChat(recipient.id, sender.headers);

    const response = await app.request
      .post(`/api/chats/${chatId}/messages/media/upload`)
      .set(sender.headers)
      .field('kind', 'image')
      .field('sizeBytes', '11')
      .attach('file', Buffer.from('clean-bytes'), { filename: 'x.png', contentType: 'image/png' });

    const error = expectError(response, 503, 'MEDIA_SCAN_UNAVAILABLE');
    expect(error.details).toMatchObject({ mediaId: expect.any(String) });

    const listed = await app.request.get(`/api/chats/${chatId}/messages`).set(sender.headers);
    expect(expectSuccess<unknown[]>(listed, 200)).toEqual([]);
  });

  it('rejects a size mismatch without creating a message', async () => {
    const sender = await messaging.verifiedUser('Sender');
    const recipient = await messaging.verifiedUser('Recipient');
    const chatId = await messaging.openDirectChat(recipient.id, sender.headers);

    expectError(
      await app.request
        .post(`/api/chats/${chatId}/messages/media/upload`)
        .set(sender.headers)
        .field('kind', 'image')
        .field('sizeBytes', '99')
        .attach('file', Buffer.from('clean-bytes'), {
          filename: 'x.png',
          contentType: 'image/png',
        }),
      400,
      'VALIDATION_ERROR',
    );

    const listed = await app.request.get(`/api/chats/${chatId}/messages`).set(sender.headers);
    expect(expectSuccess<unknown[]>(listed, 200)).toEqual([]);
  });

  it('rejects a kind that does not match the uploaded content type', async () => {
    const sender = await messaging.verifiedUser('Sender');
    const recipient = await messaging.verifiedUser('Recipient');
    const chatId = await messaging.openDirectChat(recipient.id, sender.headers);

    expectError(
      await app.request
        .post(`/api/chats/${chatId}/messages/media/upload`)
        .set(sender.headers)
        .field('kind', 'gif')
        .field('sizeBytes', '11')
        .attach('file', Buffer.from('clean-bytes'), {
          filename: 'x.png',
          contentType: 'image/png',
        }),
      400,
      'VALIDATION_ERROR',
    );
  });
```

The 503-with-`details.mediaId` behavior is already implemented in `storeAndScan`
by Task 4; no further service change is needed here.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
npx vitest run tests/unit/multipart-media.parser.test.ts tests/integration/messages/media-messages.test.ts && npm run typecheck
```

Expected: PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/core/media/media-form.schema.ts src/modules/media/logic/media.service.ts src/modules/media/web/dto/media.openapi.ts src/modules/messages/messages.container.ts src/modules/messages/messages.types.ts src/modules/messages/web/multipart-media.parser.ts src/modules/messages/web/dto/message.openapi.ts src/modules/messages/web/dto/message.schemas.ts src/modules/messages/web/message.controller.ts src/modules/messages/web/routes/messages.router.ts src/modules/messages/logic/message.service.ts tests/unit/multipart-media.parser.test.ts tests/integration/messages/media-messages.test.ts
git commit -m "feat(messaging): add combined multipart media send

Adds a bounded busboy parser that requires text fields before the single file
part, enforces MEDIA_MAX_BYTES and a declared sizeBytes value, and exposes an
assertComplete promise so a short stream is detected before any ready
transition. The parser lives in the messaging web layer; shared form fields live
in a core Zod schema so messaging and media validate the same contract.

POST /api/chats/:chatId/messages/media/upload streams the file through
MediaService.storeAndScan, creates the message only after a clean verdict, and
is documented as multipart/form-data via the extended OpenAPI builder. Infected
uploads return 422 with no message, scanner outages return 503 with
details.mediaId, and size or kind/content-type mismatches return 400 with no
message. Kind validation runs before storage so a rejected upload leaves no
orphaned object."
```

---

### Task 9: Forward, GC, manual delete guard, and version pinning

**Files:**
- Create: `tests/integration/messages/media-forward-delete.test.ts`
- Modify: `src/modules/messages/web/dto/message.openapi.ts` (ensure `MEDIA_IN_USE` description in message 409 response)

**Interfaces:**
- Consumes: `MediaAccess.releaseIfUnreferenced`, `MediaService.assertDeletable`, `MediaFixture.cleanup`.
- Produces: verified end-to-end forward/GC/delete and version-pinning behavior.

- [ ] **Step 1: Write the failing integration tests**

Create `tests/integration/messages/media-forward-delete.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectError, expectSuccess } from '@/tests/helpers/assertions.js';
import { AuthFixture } from '@/tests/fixtures/auth.fixture.js';
import { MediaFixture } from '@/tests/fixtures/media.fixture.js';
import { MessagingApiFixture } from '@/tests/integration/messages/messaging-api.fixture.js';
import { TestApp } from '@/tests/helpers/test-app.js';

describe('media message forward, delete, and pinning', () => {
  let app: TestApp;
  let auth: AuthFixture;
  let messaging: MessagingApiFixture;
  let media: MediaFixture;

  beforeAll(async () => {
    app = await TestApp.create();
    auth = new AuthFixture(app);
    messaging = new MessagingApiFixture(app);
    media = new MediaFixture(app);
  });

  afterAll(async () => {
    await media.cleanup();
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
    auth.emails.clear();
    media.scanner.mode = 'clean';
  });

  async function setup() {
    const sender = await messaging.verifiedUser('Sender');
    const recipient = await messaging.verifiedUser('Recipient');
    const third = await messaging.verifiedUser('Third');
    const chatA = await messaging.openDirectChat(recipient.id, sender.headers);
    const chatB = await messaging.openDirectChat(third.id, sender.headers);
    const ticketResponse = await app.request
      .post('/api/media/uploads')
      .set(sender.headers)
      .send({ contentType: 'image/png', sizeBytes: 14 });
    const ticket = expectSuccess<{
      mediaId: string;
      objectKey: string;
      uploadUrl: string;
      headers: Record<string, string>;
    }>(ticketResponse, 201);
    media.track(ticket);
    await media.put(ticket, Buffer.from('original-bytes'), 'image/png');
    expectSuccess(
      await app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(sender.headers),
      200,
    );
    const sent = expectSuccess<{ id: string; media: { downloadUrl: string } }>(
      await app.request
        .post(`/api/chats/${chatA}/messages/media`)
        .set(sender.headers)
        .send({ mediaId: ticket.mediaId, kind: 'image' }),
      201,
    );
    return { sender, chatA, chatB, ticket, sent };
  }

  it('keeps the object until the last forward is deleted', async () => {
    const { sender, chatA, chatB, ticket, sent } = await setup();
    const forwarded = expectSuccess<{ id: string; media: { downloadUrl: string } }>(
      await app.request
        .post(`/api/chats/${chatA}/messages/${sent.id}/forward`)
        .set(sender.headers)
        .send({ targetChatId: chatB }),
      201,
    );
    expect(forwarded.media.downloadUrl).toContain(ticket.mediaId);

    expectSuccess(
      await app.request.delete(`/api/chats/${chatA}/messages/${sent.id}`).set(sender.headers),
      204,
    );
    expectSuccess(await app.request.get(`/api/media/${ticket.mediaId}`).set(sender.headers), 200);

    expectSuccess(
      await app.request.delete(`/api/chats/${chatB}/messages/${forwarded.id}`).set(sender.headers),
      204,
    );
    expectError(await app.request.get(`/api/media/${ticket.mediaId}`).set(sender.headers), 404);
  });

  it('blocks manual media delete while a message references it', async () => {
    const { sender, ticket } = await setup();
    expectError(
      await app.request.delete(`/api/media/${ticket.mediaId}`).set(sender.headers),
      409,
      'MEDIA_IN_USE',
    );
  });

  it('serves originally scanned bytes after an object overwrite', async () => {
    const { ticket, sent } = await setup();
    await media.put(ticket, Buffer.from('replaced-bytes'), 'image/png');

    const response = await fetch(sent.media.downloadUrl);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('original-bytes');
  });

  it('rejects PATCH on a media message', async () => {
    const { sender, chatA, sent } = await setup();
    expectError(
      await app.request
        .patch(`/api/chats/${chatA}/messages/${sent.id}`)
        .set(sender.headers)
        .send({ body: 'new body' }),
      400,
      'VALIDATION_ERROR',
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npx vitest run tests/integration/messages/media-forward-delete.test.ts
```

Expected: FAIL on at least one assertion if forward/GC, manual delete guard, or pinning regressed.

- [ ] **Step 3: Ensure the 409 response is documented**

In `src/modules/messages/web/dto/message.openapi.ts`, change the message contracts' `409` response to:

```ts
      409: errorResponse('Conflict, including MEDIA_IN_USE', apiErrorResponseSchema),
```

- [ ] **Step 4: Run the focused test and typecheck**

Run:

```bash
npx vitest run tests/integration/messages/media-forward-delete.test.ts && npm run typecheck
```

Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/modules/messages/web/dto/message.openapi.ts tests/integration/messages/media-forward-delete.test.ts
git commit -m "test(messaging): pin media forward, GC, and version pinning

Adds integration coverage for the media message lifecycle beyond send. A
forwarded media message references the same scanned object, deleting one of two
references keeps the object available, and deleting the last reference removes
the media row. Manual media deletion while a live message references the object
returns MEDIA_IN_USE.

The suite also proves that overwriting the S3 object after attaching does not
change the bytes served by the previously issued message download URL, and
that editing a media message is rejected. OpenAPI now describes the 409 path
used by referenced media deletion."
```

---

### Task 10: Documentation and final verification

**Files:**
- Modify: `README.md:223-306`, `README.md:481-509`, `README.md:563-586`, `README.md:667-699`
- No source changes expected unless verification finds a defect.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: README documentation for media messages and a final green verification run.

- [ ] **Step 1: Update README media and messaging sections**

In the media uploads section, replace the sentence stating message integrations are not wired yet with:

```markdown
Phase 2.5 connects this pipeline to cloud-chat media messages. Secret chats do
not support media.
```

In the messaging route table, add:

```markdown
| `POST /api/chats/:chatId/messages/media` | Attach a ready `mediaId` as a media message |
| `POST /api/chats/:chatId/messages/media/upload` | Multipart upload-and-send in one request |
```

Add a subsection:

```markdown
### Media messages

Media messages use `type: "media"` with `body: null` and a `media` object
containing `mediaId`, `kind`, `contentType`, `sizeBytes`, optional caption and
metadata, `downloadUrl`, and `expiresAt`. Kinds are `image`, `video`,
`document`, `voice_note`, `sticker`, and `gif`; kind must match the scanned
object's content type. Downloads are short-lived and pinned to the scanned S3
version. Object keys, version ids, and hashes are never returned in message
responses.

Attaching requires the sender to own a ready media object. The combined route
requires `kind`, `sizeBytes`, and one `file` part; text fields must precede the
file. Sending creates a message only after a clean scan. Infected uploads return
`422`, scanner outages return `503` with `details.mediaId`, and malformed or
size-mismatched uploads return `400`.

Forwarding reuses the same media object. Deleting a media message removes its
reference and deletes the object only when no live message references remain;
manual media deletion returns `409 MEDIA_IN_USE` while referenced. Media
messages cannot be edited. Deleting a chat cascades message rows but does not
trigger media garbage collection in this phase.
```

In the E2EE section, change the media sentence to:

```markdown
Secret messages cannot contain media; media messages are rejected in secret
chats with `403 E2EE_NOT_ALLOWED`.
```

In the error model section, add `MEDIA_IN_USE` to the documented code list.

- [ ] **Step 2: Run the full gate**

Run:

```bash
npm run verify && npm run db:check
```

Expected: typecheck, lint, build, and all Vitest tests pass; `drizzle-kit check` reports `Everything's fine 🐶🔥`.

If any command fails, fix the defect in the task that owns it, add a focused regression test, commit that fix separately with a long message, and rerun this step.

- [ ] **Step 3: Run a live smoke**

Start dependencies and the API:

```bash
docker compose up -d postgres redis minio storage-init
docker compose --profile scan up -d clamav
npm run db:migrate
npm run dev
```

Using a temporary verified user, exercise:

- attach-ready success for `image/png`;
- combined multipart success for `application/pdf` as `document`;
- EICAR combined upload returning `422` with no message;
- media message in a secret chat returning `403 E2EE_NOT_ALLOWED`;
- manual media delete while referenced returning `409 MEDIA_IN_USE`;
- forward to a second chat and verify both download URLs serve the original bytes;
- delete both references and verify the media row returns `404`.

Clean up the temporary user, messages, and all S3 versions/delete markers; stop the API and ClamAV. Leave PostgreSQL, Redis, and MinIO running unless the user asks otherwise.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md
git commit -m "docs(messaging): document cloud media messages

Documents the two media send modes, the media message response shape, kind and
content-type validation, signed URL behavior, and the failure semantics for
infected uploads, scanner outages, and malformed multipart requests.

Records that secret chats reject media, forwards reuse one scanned object,
deletion garbage-collects only the last unreferenced object, manual media
delete returns MEDIA_IN_USE while referenced, and chat-cascade deletion does
not trigger garbage collection in this phase."
```

---

## Final Handoff Checklist

- [ ] Every task has its own commit with a long descriptive message.
- [ ] Every task and major fix has an independent reviewer using `opencode/big-pickle` before the next task starts.
- [ ] `npm run verify && npm run db:check` is green after the final task.
- [ ] Live smoke covers at least one success path and the `400`, `403`, `404`, `409`, `422`, and `503` paths.
- [ ] Temporary users, messages, S3 versions, API processes, and ClamAV are cleaned up.
- [ ] README and OpenAPI match runtime behavior.
- [ ] The gitignored `plan.md` is absent from all commits.
