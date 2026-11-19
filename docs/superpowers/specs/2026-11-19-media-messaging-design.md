# Design — Phase 2.5 media messaging

Status: written after section-by-section approval on 2026-11-19; awaiting written-spec review.

## 1. Context and intent

Phase 2.4 delivered a generic, owner-scoped media upload pipeline: a verified
user creates a ticket, uploads bytes directly to private S3-compatible storage,
finalizes through a fail-closed ClamAV gate, and receives a version-pinned
presigned download URL. It deliberately did not connect those objects to
messages, avatars, or stories.

Phase 2.5 adds media messages to cloud chats. A user can either attach an
already-ready `mediaId` or send a file in one combined multipart request. Chat
members read a media message with a short-lived signed URL; the server never
returns the object key, stored S3 version, or SHA-256. The design reuses the
Phase 2.4 lifecycle and version-pinning guarantees instead of building a second
upload path.

Success means:

- a verified chat member can send and read images, videos, documents, voice
  notes, stickers, and GIFs in cloud chats;
- secret chats remain ciphertext-only and reject all media operations;
- malware, invalid input, scanner outages, and storage failures produce the
  same predictable errors as Phase 2.4 and never create a visible message;
- forwarding reuses the same scanned object and deletion reclaims the object
  only after the last live message reference is gone;
- messaging and media modules remain decoupled behind narrow core ports.

## 2. Goals

- Support two user-facing modes: attach a ready `mediaId`, and a combined
  multipart upload-and-send request.
- Introduce a first-class `mediaKind` discriminator with minimal optional
  metadata.
- Keep secret-chat payloads server-invisible; reject media there.
- Give chat members download URLs only after normal chat authorization.
- Track message→media references so forwards keep objects alive and deletion
  reclaims unreferenced objects.
- Preserve S3 version pinning so overwriting an uploaded object cannot change
  what a message reader receives.
- Extend Drizzle schema, ports, services, controllers, DTOs, OpenAPI contracts,
  README, and integration tests consistently.

## 3. Confirmed decisions

1. **Both modes.** Implement attach-ready-`mediaId` and combined
   upload-and-send.
2. **Secret chats reject media.** Media messages are cloud-chat-only. Secret
   chats keep `body IS NULL` with ciphertext fields only.
3. **Kind enum with minimal metadata.** `mediaKind` is one of `image`, `video`,
   `document`, `voice_note`, `sticker`, `gif`. Caption is optional; duration and
   dimensions are accepted when supplied but never required.
4. **GC when unreferenced.** Deleting a media message removes its reference;
   the object is deleted only when no live message references it.
5. **Forward reuses the object.** A forward is a new message row pointing at the
   same `mediaId`; no S3 copy and no re-scan.
6. **Combined mode is one multipart request.** The file is streamed through the
   existing pipeline; the message is created only after a clean verdict.
7. **Signed URL on read.** Message DTOs include a short-lived `downloadUrl`.
   Object key, version id, and hash remain hidden.
8. **Columns plus core ports.** Media fields live on `messages`; the two modules
   communicate through core ports, never by importing each other's layers.
9. **Declared size for combined uploads.** The multipart form requires
   `sizeBytes`; the parser enforces the exact byte count so S3 `PutObject` can
   use a known `ContentLength` without local spooling.

## 4. Non-goals

- Media in secret chats, client-side media encryption, or encrypted attachment
  envelopes.
- Avatar/profile and story wiring; `users.avatar_key` and `stories.media_key`
  remain placeholders.
- Thumbnails, image transforms, video transcoding, GIF loops, or per-kind
  storage quotas.
- Editing a media message or its caption after send.
- Background sweepers for all unreferenced media; GC in this phase is triggered
  by removal of the last live message reference.
- Public/CDN object access, anonymous downloads, or resumable/multipart S3
  uploads.
- New environment variables. Existing media limits, allowed-content-type
  configuration, and presign TTL are reused.
- Changing Phase 2.4's quarantine retention or its current-version-only S3
  delete behavior.

## 5. Architecture

### 5.1 Module boundaries

`src/modules/messages` must not import from `src/modules/media`, and vice versa.
Two core ports are added:

- `src/core/media/media-access.port.ts` — `MediaAccess`, `MediaAsset`,
  `IncomingMediaUpload`, and `MediaDownload`.
- `src/core/media/media-reference.port.ts` — `MediaReferenceReader`.

New symbols `CORE_TYPES.MediaAccess` and `CORE_TYPES.MediaReferenceReader` are
added to `src/core/container/core.types.ts`.

`MediaAccess` exposes:

```ts
requireReadyOwned(mediaId: string, userId: string): Promise<MediaAsset>;
storeAndScan(userId: string, input: IncomingMediaUpload): Promise<MediaAsset>;
signDownload(mediaId: string): Promise<MediaDownload>;
releaseIfUnreferenced(mediaId: string): Promise<void>;
assertDeletable(mediaId: string): Promise<void>;
```

`MediaReferenceReader` exposes:

```ts
hasLiveReferences(mediaId: string): Promise<boolean>;
```

`MediaAccess` is implemented by
`src/modules/media/logic/media-access.service.ts`, which delegates to
`MediaService`. `MediaReferenceReader` is implemented by
`src/modules/messages/logic/media-reference-reader.service.ts`, which delegates
to `MessageRepository.hasLiveMediaReferences`. Both follow the E2EE precedent:
the owning module's container binds a module-scoped service, then binds the core
symbol on the root container to that singleton.

Because `MediaAccessService` resolves `CORE_TYPES.MediaReferenceReader` at
construction time, `Application` constructs modules in this order: Health,
Auth, Stories, E2EE, Messages, Media. Route mounting order is unchanged in
meaning; only module construction order matters.

`MessageService` injects only `CORE_TYPES.MediaAccess`. `MediaService` injects
only `CORE_TYPES.MediaReferenceReader` for delete guards and GC decisions.

### 5.2 Schema

Extend `src/core/database/schema/messaging.schema.ts`. The `messages` table is
hash-partitioned by `chat_id` into 16 partitions; message ids are unique only
per chat, and ordinary message queries must include `chat_id`. The deliberate
exception is the cross-partition live-reference lookup, which uses the
non-unique `media_id` index described below.

| New column | Type | Notes |
| --- | --- | --- |
| `media_id` | `uuid` NULL | FK to `media_objects.id`, `ON DELETE RESTRICT`. |
| `media_kind` | `text` NULL | One of the six kind values. |
| `caption` | `text` NULL | 1–1000 characters when present. |
| `duration_ms` | `integer` NULL | 1–86,400,000 (24 hours) when present. |
| `width` | `integer` NULL | 1–16,384 when present. |
| `height` | `integer` NULL | 1–16,384 when present. |

Extend `messages_type_check` to include `media`. Add named checks:

- `messages_media_shape_check`: `type = 'media'` implies `media_id` and
  `media_kind` are present, `body` is `NULL`, and all E2EE fields are `NULL`.
- `messages_non_media_no_media_check`: every non-`media` row has all six new
  columns `NULL`.
- checks for caption length, kind values, the duration/dimension bounds in the
  table above.

Existing checks remain authoritative for secret chats: secret rows require
ciphertext fields, forbid plaintext body, and forbid reply/forward. The
non-media check also guarantees secret rows carry no media fields.

Add a non-unique index `messages_media_id_index` on `media_id` for reference
checks. Non-unique partitioned indexes may omit the partition key. All new CHECK
expressions use unqualified identifiers because qualified names such as
`"messages"."type"` are invalid in partitions (see `0009_young_human_fly.sql`).

Generate a new migration with `npm run db:generate`, review the SQL, and apply
it with `npm run db:migrate`. Never edit an already-applied migration.

### 5.3 Domain records and repository

`MessageRecord` gains an optional `media` value object containing only stored
fields: `mediaId`, `kind`, `caption`, `durationMs`, `width`, `height`.
`contentType`, `sizeBytes`, `downloadUrl`, and `expiresAt` are composed by
`src/modules/messages/web/message-presenter.service.ts` from
`MediaAccess.signDownload`; that presenter is bound in `MessagesContainer` and
used by send, list, and forward responses. Drizzle row types never leave
`data/`.

`MessageRepository` gains:

- media fields on the create input for cloud media messages;
- `hasLiveMediaReferences(mediaId): Promise<boolean>`, which checks for rows
  with that `media_id` and `deleted_at IS NULL`;
- `markDeleted` behavior that sets `deleted_at` and clears all media columns.

The service captures `mediaId` before calling `markDeleted` so it can trigger
GC afterward.

### 5.4 Media service additions

`MediaService` gains methods used by `MediaAccessService`:

- `requireReadyForUse(mediaId, userId)` — owner-scoped ready check.
- `storeAndScan(userId, { contentType, sizeBytes, body })` — create a pending
  row, `putStream` to S3, HEAD to capture the version, recheck metadata, run the
  existing `scanWithHash` path, transition to ready or quarantined, and return a
  `MediaAsset` only when ready.
- `signForReader(mediaId)` — ready-only, no owner check; returns content type,
  size, and version-pinned presigned GET URL.
- `releaseIfUnreferenced(mediaId)` — ask `MediaReferenceReader`; when no live
  references exist, delete the S3 object and the media row.
- `assertDeletable(mediaId)` — throw `MediaInUseException` when live references
  exist.

Existing `initiate`, `finalize`, `getDownload`, and `remove` behavior remains;
`remove` calls `assertDeletable` before deleting.

### 5.5 Object store and multipart parsing

Extend `ObjectStore` with:

```ts
putStream(
  objectKey: string,
  contentType: string,
  sizeBytes: number,
  body: Readable,
): Promise<void>;
```

`S3ObjectStore` implements it with `PutObjectCommand`, exact `ContentLength`,
and the same private-bucket credentials and endpoint configuration as existing
presigning. No multipart S3 upload is used, so a failed stream leaves no
partial object.

Add `busboy` as a dependency and `@types/busboy` as a dev dependency. A web-layer
multipart parser enforces:

- exactly one `file` part;
- required text fields `kind` and `sizeBytes`;
- optional `caption`, `durationMs`, `width`, `height`, `replyToMessageId`;
- a file byte limit of `MEDIA_MAX_BYTES`;
- a total request `Content-Length` limit of `MEDIA_MAX_BYTES + 65,536` bytes;
- an 8,192-byte limit per text field.

The parser rejects a mismatch between declared `sizeBytes` and actual bytes.
`express.json` remains configured as before; multipart requests bypass it.

## 6. HTTP contract

### 6.1 Routes

Both new routes are registered in `MessagesRouter` through `DocumentedRouter`
under `/api/chats`, with bearer auth, `RequireVerifiedEmailMiddleware`, and
`MessagesRateLimiter`:

- `POST /:chatId/messages/media` — attach a ready object.
  Operation id: `messages.sendMedia`.
- `POST /:chatId/messages/media/upload` — combined upload and send.
  Operation id: `messages.uploadMedia`.

### 6.2 Requests

Attach JSON body:

```json
{
  "mediaId": "uuid",
  "kind": "image",
  "caption": "optional",
  "durationMs": 1234,
  "width": 1920,
  "height": 1080,
  "replyToMessageId": "uuid"
}
```

`mediaId` and `kind` are required; the remaining fields are optional. The same
Zod schema documents and validates the request.

Combined multipart fields are the same except `sizeBytes` is required and the
binary part is named `file`. Content type comes from the file part and is
checked against `MEDIA_ALLOWED_CONTENT_TYPES`; clients cannot supply an object
key.

Kind/content-type validation:

- `image`: `image/jpeg`, `image/png`, `image/webp`.
- `gif`: `image/gif`.
- `sticker`: `image/webp`, `image/png`.
- `video`: `video/mp4`, `video/webm`.
- `voice_note`: `audio/mpeg`, `audio/ogg`, `audio/wav`, `audio/webm`,
  `audio/mp4`.
- `document`: any other configured allowed type.

A content type not present in `MEDIA_ALLOWED_CONTENT_TYPES` is always rejected,
even if its family matches a kind.

### 6.3 Responses

Both routes return the normal success envelope with a single message object.
`GET /:chatId/messages` and forward responses use the same shape.

```json
{
  "id": "uuid",
  "chatId": "uuid",
  "senderId": "uuid",
  "type": "media",
  "body": null,
  "media": {
    "mediaId": "uuid",
    "kind": "image",
    "contentType": "image/png",
    "sizeBytes": 12345,
    "caption": "optional",
    "durationMs": 1234,
    "width": 1920,
    "height": 1080,
    "downloadUrl": "https://...",
    "expiresAt": "2026-11-19T00:00:00.000Z"
  },
  "replyToMessageId": null,
  "forwardedFromChatId": null,
  "forwardedFromMessageId": null,
  "createdAt": "2026-11-19T00:00:00.000Z",
  "editedAt": null,
  "deletedAt": null
}
```

Text, system, and secret messages keep their existing shapes. Media messages
never expose `object_key`, `version_id`, `sha256`, `scan_signature`, or
`scan_error`.

`PATCH /:chatId/messages/:messageId` rejects media messages with `400
VALIDATION_ERROR`; captions are immutable in this phase.

### 6.4 Errors

Reused codes and statuses:

- `400 VALIDATION_ERROR` — malformed DTO, missing/extra file, wrong field types,
  size mismatch, oversized request, unsupported content type, kind mismatch, or
  media edit attempt.
- `401 UNAUTHORIZED` — missing/invalid bearer token.
- `403 EMAIL_NOT_VERIFIED` — verified-email gate.
- `403 E2EE_NOT_ALLOWED` — secret chat on any media path.
- `404 NOT_FOUND` — chat/message/media missing, or media not owned by the
  sender in attach mode.
- `409 MEDIA_NOT_READY` — attaching a non-ready object.
- `409 MEDIA_IN_USE` — manual media delete with live message references.
- `422 MEDIA_INFECTED` — ClamAV verdict; no message is created.
- `503 MEDIA_SCAN_UNAVAILABLE` — scanner outage; no message is created and
  `MediaScanUnavailableException` is raised with `details.mediaId` for retry.

## 7. Lifecycle

### 7.1 Attaching a ready object

1. Reject secret chats before touching media state.
2. Require chat membership and an unblocked chat.
3. Validate any reply target belongs to the same chat.
4. `MediaAccess.requireReadyOwned(mediaId, userId)` verifies owner and `ready`
   status.
5. Validate `kind` against the media object's content type.
6. Insert a `type = 'media'` message with `body IS NULL` and the stored media
   fields.
7. Present the message with a freshly signed download URL.

### 7.2 Combined upload and send

1. Apply the same chat checks as attach mode.
2. Parse the bounded multipart form and validate fields and `sizeBytes`.
3. `MediaAccess.storeAndScan` streams to S3, HEADs the captured version,
   rechecks metadata, and runs the existing scan/hash path.
4. On a clean verdict, insert the media message and present it with a signed
   URL.
5. On an infected verdict, quarantine the object, return `422`, and create no
   message.
6. On a scanner outage, leave the row `pending`, return `503` with
   `details.mediaId`, and create no message. The client may finalize that media
   object later and then use attach mode.
7. On storage or metadata failure, mark the row `failed`, return the existing
   mapped storage error, and create no message.

### 7.3 Reading and signed URLs

`MessageService.list` already verifies membership and blocking before returning
records. The web-layer presenter then calls `MediaAccess.signDownload` for each
media record. The media module signs the stored S3 version with the existing
`MEDIA_PRESIGN_TTL_SECONDS`. A missing or non-ready referenced object fails
closed with its existing error instead of emitting a broken URL.

### 7.4 Forwarding

Forwarding remains cloud-chat-only and continues to reject deleted messages.
For a media message, the new row copies `media_id`, `media_kind`, `caption`,
`duration_ms`, `width`, `height`, and the existing forwarded-from fields. No
ownership check is performed for the forwarder; the object was already scanned
and the source chat authorized the sender. The new row increments the live
reference count and members of the target chat receive signed URLs.

### 7.5 Deletion and GC

Deleting a media message sets `deleted_at`, clears all media columns, and then
calls `MediaAccess.releaseIfUnreferenced(capturedMediaId)`. The core port asks
`MediaReferenceReader`; only when no live references remain does the media
module delete the S3 object and `media_objects` row. The `ON DELETE RESTRICT`
foreign key is the concurrency backstop. This is synchronous GC on last
reference removal, not a periodic sweeper.

Deleting a chat cascades its message rows but does not trigger media GC in this
phase; this limitation is documented in README.

### 7.6 Manual media delete

`DELETE /api/media/:mediaId` still requires ownership. Before deleting, the
media module calls `assertDeletable`; live message references produce `409
MEDIA_IN_USE`. After the last message reference is removed, the ordinary owner
delete succeeds. S3 deletion still removes only the current object version.

## 8. Security invariants

- Ownership is derived from the bearer token, never from request bodies.
- Chat membership is checked before any download URL is signed.
- Secret chats reject media before any media lookup or database write.
- Recipients never receive object keys, version ids, hashes, or scan metadata.
- Download URLs are short-lived and pinned to the scanned S3 version.
- Presigned PUT remains limited to the exact content type and size; combined
  uploads use the same limits and HEAD recheck.
- Infected objects are quarantined; non-ready objects never receive URLs.
- A forward only grants access to members of chats that contain a live
  reference.
- Manual media deletion cannot break a live message.
- Object keys remain server-generated; client filenames never influence them.
- No credentials, object bytes, signatures, or signed URLs are written to
  logs.

## 9. Error model

Add `MediaInUseException` to `src/core/errors/domain.error.ts` and map
`MEDIA_IN_USE` to `409` in `src/core/errors/error-mapper.ts`. Add the code to
`src/core/errors/error-code.ts` and the shared OpenAPI error component. All
other errors reuse codes already defined by Phase 2.4, E2EE, and messaging.
The combined path reuses `MediaScanUnavailableException` with `details.mediaId`;
no second scanner-outage error type is introduced. Domain errors carry no HTTP
status; only `ErrorMapper` chooses statuses.

## 10. Testing strategy

Unit tests cover:

- kind/content-type validation and DTO parsing;
- presenter redaction and URL composition;
- `releaseIfUnreferenced` and `assertDeletable` decisions with a fake
  `MediaReferenceReader`;
- multipart field parsing, exact-size enforcement, and request limits.

Integration tests cover:

- attach-ready success, including a signed URL that serves the original bytes;
- secret-chat rejection with no message or media mutation;
- non-member denial and unverified-email `403`;
- combined multipart success with deterministic fake scanner;
- EICAR `422 MEDIA_INFECTED` with no message row;
- scanner-outage `503` with retryable `mediaId` and no message;
- oversized, mismatched-size, invalid-kind, missing-file, and disallowed
  content-type `400` paths;
- forward reuse across two chats and download access in both;
- deleting one of two forwards keeps the object; deleting the last one removes
  the S3 object and media row;
- manual media delete returns `409` while referenced and `204` afterward;
- overwriting an object after attaching leaves the message download URL serving
  the originally scanned bytes;
- existing text send/edit/forward/delete tests remain green;
- media-message `PATCH` returns `400`.

Tests use deterministic fake scanners by default. A live ClamAV smoke test is
run manually under the `scan` profile, not in the normal suite.

## 11. Documentation and configuration

No environment variables are added. README updates document the two new
endpoints, the media DTO, cloud-only behavior, kind validation, GC/forward
semantics, and the limitations listed in section 4. OpenAPI contracts in
`message.openapi.ts` and the shared error components are updated from the same
Zod schemas used for validation. The gitignored `plan.md` must not be staged in
any feature commit.

## 12. Verification and rollout

Before reporting completion:

1. Run `npm run verify && npm run db:check`.
2. Run the app and smoke-test at least one success path and representative
   `400`, `403`, `404`, `409`, `422`, and `503` paths.
3. Confirm secret-chat media is rejected and no plaintext body is written.
4. Confirm forward/GC behavior with real PostgreSQL, Redis, and MinIO.
5. Remove temporary users, messages, and S3 versions; stop started processes and
   containers.
6. Commit each implementation unit separately with a long descriptive message
   and review every task independently before proceeding.

## 13. Acceptance criteria

- Both send modes work for all six kinds in cloud chats.
- Secret chats reject media and keep ciphertext-only rows.
- Message reads expose signed URLs but never hidden media metadata.
- Forwards reuse one object and GC removes it only after the last live
  reference.
- Manual media delete cannot break a live message.
- All verification commands pass and the live smoke covers success and error
  paths.
- README and OpenAPI match runtime behavior.
