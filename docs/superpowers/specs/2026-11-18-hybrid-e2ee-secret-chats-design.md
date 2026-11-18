# Hybrid E2EE secret chats (Phase 2.3) design

## 1. Context and goal

Phase 2.2 delivered one-on-one cloud messaging. Phase 2.3 adds Telegram-style
hybrid E2EE: ordinary chats remain server-visible and searchable, while opt-in
secret chats carry only opaque ciphertext that the API cannot decrypt.

The API is a key and ciphertext registry. Clients own private keys, derive
shared secrets, and encrypt/decrypt message content. The server stores public
key material, device metadata, and ciphertext only.

## 2. Scope

### In scope

- A new `e2ee` module mounted at `/api/e2ee` for device and public-key registry
  operations.
- New secret-chat endpoints in the existing `messages` module at `/api/chats`.
- A stable device id derived from the refresh-token family id and exposed on
  access tokens as `req.auth.deviceId`.
- X25519 identity keys, Ed25519 signing keys, signed prekeys, one-time prekeys,
  and AES-GCM ciphertext per message. No double ratchet.
- Reuse of the hash-partitioned `messages` table for secret ciphertext.
- Blocking, membership, email verification, and rate-limit enforcement for all
  new endpoints.

### Out of scope

- Media or file attachments in secret chats.
- Search over secret-chat content. Phase 2.8 must exclude `type = 'secret'`.
- Self-destruct timers (Phase 2.6).
- Server-side plaintext fallback, key recovery, or double-ratchet state.
- Changes to cloud-chat behavior.

## 3. Architecture

### 3.1 Device identity from auth tokens

The refresh-token family id is already stable across refresh rotation and
represents one auth-issued device lineage. It becomes the public device id.

- `AccessTokenClaims` gains `deviceId: string`; JWT payload gains `did`.
- `AccessTokenService.sign()` accepts the device id and writes `did`.
- `AccessTokenService.verify()` requires a string `did`; missing or invalid
  claims reject the token.
- `TokenService.createPair()` passes its `familyId` when signing access tokens,
  so login, OAuth grant exchange, and refresh all produce a stable `deviceId`.
- `req.auth.deviceId` is available through the existing `AccessTokenClaims`.
  `AuthenticatedUser` is unchanged.

Tokens issued before this change do not have `did` and must be refreshed or
reissued. This is acceptable because refresh tokens already carry the family id.

### 3.2 `e2ee` module

A new child container and module follow the existing module pattern:

- `E2eeModule` mounts `/api/e2ee` and initializes its own rate limiter.
- `E2eeContainer` binds repositories, services, controllers, and the router.
- `PostgresE2eeDeviceRepository` and `PostgresE2eePrekeyRepository` implement
  ports in `logic/ports`; Drizzle rows are mapped to domain records in `data/`.
- `E2eeKeyService` validates public key shapes and verifies Ed25519 signatures.
- `E2eeDeviceService` owns registration, rotation, one-time prekey replenishment,
  and bundle distribution.
- `E2eeController` and `E2eeRouter` expose the HTTP surface. Controllers are
  request-scoped; the router is a singleton.

The module publishes a narrow `E2eeDeviceReader` into the root container under
`CORE_TYPES.E2eeDeviceReader`. This keeps `messages` dependent on `core` only.

### 3.3 `messages` module changes

`ChatService` gains secret-chat creation using a deterministic key
`secret:<sorted-user-ids>`. The prefix prevents collisions with cloud direct
keys, and the existing partial unique index enforces one secret chat per pair.

`MessageService` gains a secret send path and a guard that rejects mutation of
secret messages. It injects `CORE_TYPES.E2eeDeviceReader` to verify that the
token device belongs to the sender and that the target device belongs to the
other participant. Existing membership, block, and verified-email middleware
still apply.

`MessageRecord` gains ciphertext metadata. The HTTP presenter never returns a
plaintext body for secret messages.

### 3.4 Cross-module port

`src/core/e2ee/e2ee-device.reader.ts` defines:

```ts
interface E2eeDeviceSummary {
  deviceId: string;
  userId: string;
  identityPublicKey: string;
  signingPublicKey: string;
  hasOneTimePreKeys: boolean;
}

interface E2eeDeviceReader {
  findByUserAndDevice(userId: string, deviceId: string): Promise<E2eeDeviceSummary | null>;
  hasAnyDevice(userId: string): Promise<boolean>;
}
```

No private key, shared secret, or plaintext crosses this boundary.

## 4. Data model and migration

A new `src/core/database/schema/e2ee.schema.ts` is exported from the schema
barrel. All names are explicit.

### 4.1 `e2ee_devices`

- `device_id uuid` primary key — the refresh-token family id.
- `user_id uuid not null` references `users(id)` with `CASCADE`.
- `signing_public_key text not null` — base64url raw Ed25519 public key.
- `identity_public_key text not null` — base64url raw X25519 public key.
- `identity_signature text not null` — base64url Ed25519 signature over
  `e2ee-identity:` followed by the raw identity public key bytes.
- `signed_prekey_id integer not null`.
- `signed_prekey_public_key text not null` — base64url raw X25519 public key.
- `signed_prekey_signature text not null` — Ed25519 signature over
  `e2ee-signed-prekey:${id}:` followed by the raw prekey bytes.
- `created_at`, `updated_at` timestamptz.
- `rotated_at` timestamptz nullable.
- Unique index on `(user_id, device_id)`.
- Check constraints for non-empty key/signature strings and positive prekey id.

### 4.2 `e2ee_prekeys`

- `device_id uuid not null` references `e2ee_devices(device_id)` with `CASCADE`.
- `prekey_id integer not null`.
- `public_key text not null` — base64url raw X25519 public key.
- `created_at` timestamptz.
- Primary key `(device_id, prekey_id)`; index on `device_id`.
- A fetch consumes one row in a transaction, so no one-time prekey is reused.

### 4.3 `chats` and `messages` changes

- `chats.type` check gains `'secret'`.
- `chats_shape_check` treats `secret` like `direct`: `title` is null,
  `direct_key` is non-null, and the deterministic key is unique.
- `messages.type` check gains `'secret'`.
- New nullable columns on `messages`: `ciphertext text`, `nonce text`,
  `ephemeral_public_key text`, `sender_device_id uuid`, `recipient_device_id uuid`.
- Check constraints:
  - `type = 'secret'` requires all five new columns and `body is null`.
  - `type <> 'secret'` requires the new columns to be null.
  - `type = 'text'` still requires a non-null body.
- Indexes on `(chat_id, sender_device_id)` and `(chat_id, recipient_device_id)`.
- Secret messages do not use reply or forward ids; the web layer rejects those
  fields.

Because `messages` is hash partitioned, generated `ALTER TABLE` statements
propagate to all partitions. The generated SQL is reviewed before applying it,
and `npm run db:check` must remain clean.

## 5. API surface

All routes use `DocumentedRouter`, the same Zod schemas for validation and
documentation, `RequireAuth`, `RequireVerifiedEmail`, `ApiResponse`, and the
appropriate rate limiter.

### 5.1 `/api/e2ee`

| Route | Purpose |
| --- | --- |
| `POST /api/e2ee/devices` | Register `req.auth.deviceId` with identity/signing keys, signed prekey, and 1–100 one-time prekeys. Duplicate device returns `409 E2EE_DEVICE_CONFLICT`. |
| `GET /api/e2ee/devices` | List the caller's registered devices with public keys and rotation times only. |
| `POST /api/e2ee/devices/rotate` | Replace identity key, signing key, signed prekey, and one-time prekeys for the same device id. Missing device returns `404 E2EE_DEVICE_NOT_FOUND`. |
| `POST /api/e2ee/devices/prekeys` | Add one-time prekeys to the current device. Duplicate prekey id returns `409 CONFLICT`. |
| `GET /api/e2ee/users/:userId/devices/:deviceId/bundle` | Return the public key bundle and atomically consume one one-time prekey. No one-time prekeys returns `409 E2EE_PREKEY_EXHAUSTED`. |

Key fields are base64url strings with exact byte lengths: identity/prekey public
keys 32 bytes, signing public key 32 bytes, Ed25519 signatures 64 bytes, AES-GCM
nonce 12 bytes. Ciphertext is a non-empty base64url string capped at 8192
characters. Invalid shapes fail Zod validation with `400 VALIDATION_ERROR`.

### 5.2 `/api/chats`

| Route | Purpose |
| --- | --- |
| `POST /api/chats/secret` | Open or retrieve the one-to-one secret chat for `participantId`. Requires the caller's current device and at least one peer device to be registered. |
| `POST /api/chats/:chatId/secret-messages` | Store one AES-GCM ciphertext for `recipientDeviceId`. Caller device comes from `req.auth.deviceId`; recipient device must belong to the other participant. |
| `GET /api/chats/:chatId/messages` | Existing history route; returns secret rows with `body: null` and ciphertext metadata. |

Existing `PATCH`, `DELETE`, and forward routes return `403 E2EE_NOT_ALLOWED` for
secret chats. There is no secret-message search endpoint.

### 5.3 Presentation

Secret `Message` responses include `id`, `chatId`, `senderId`, `type: 'secret'`,
`body: null`, `ciphertext`, `nonce`, `ephemeralPublicKey`, `senderDeviceId`,
`recipientDeviceId`, timestamps, and null reply/forward fields. OpenAPI response
schemas are extended with the new fields and error codes.

## 6. Errors

New codes:

| Code | Status | Use |
| --- | --- | --- |
| `E2EE_DEVICE_CONFLICT` | 409 | Registering an already-registered device id. |
| `E2EE_DEVICE_NOT_FOUND` | 404 | Device does not exist or is not owned by the expected user. |
| `E2EE_PREKEY_EXHAUSTED` | 409 | Bundle requested when no one-time prekeys remain. |
| `E2EE_NOT_ALLOWED` | 403 | Edit, delete, forward, or search attempted on secret content. |

Existing codes remain in use: `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`,
`NOT_FOUND`, `CONFLICT`, `NOT_CHAT_MEMBER`, `USER_BLOCKED`,
`EMAIL_NOT_VERIFIED`, and `RATE_LIMITED`.

Add corresponding domain exception classes in `core/errors/domain.error.ts` and
status mappings in `ErrorMapper`. Domain errors carry no HTTP status. Error
details never include key material, ciphertext, nonces, or plaintext.

## 7. Security invariants

- Device id is server-derived from `req.auth.deviceId`; clients cannot choose it.
- Server stores no private keys, shared secrets, symmetric keys, or plaintext.
- Server verifies the identity-key signature and signed-prekey signature using
  the registered Ed25519 signing key.
- One-time prekeys are single-use and consumed in a transaction.
- Secret chat membership and block checks use the existing `MessagingPolicy`.
- Ciphertext, keys, nonces, and secrets are never logged or placed in error
  details; request logging continues to redact credentials.
- Secret messages cannot be edited, deleted, forwarded, replied to, or searched.
- `/api/e2ee` uses a dedicated Redis rate-limit bucket; secret sends use the
  existing messages bucket.
- Phases 2.4/2.5 media and 2.8 search must not accept secret chats.

## 8. Testing strategy

Follow TDD for every new behavior.

Unit tests:

- Access token sign/verify carries `did`, and refresh preserves the family id.
- Key-shape and signature verification accept valid material and reject tampered
  signatures, wrong lengths, and malformed base64url.
- Device reader / service rules that can be tested without HTTP.

Integration tests:

- Register, list, rotate, replenish, and fetch bundles through `/api/e2ee`.
- Duplicate registration, missing device, invalid signature, malformed key,
  prekey consumption, and prekey exhaustion paths.
- Open a secret chat for two users; verify deterministic reuse, blocked-user
  rejection, self-chat rejection, and missing peer device.
- Send ciphertext and read history; assert the database and response contain no
  plaintext body.
- Reject edit, delete, forward, and reply attempts on secret messages.
- Reject non-member, unverified, unauthenticated, and wrong-device-owner cases.
- Extend `clearDatabase()` to truncate the new E2EE tables.

Verification:

- `npm run verify` (typecheck, lint, build, tests).
- `npm run db:check`.
- Live smoke of at least one success and one error path per new endpoint group;
  start `postgres`, `redis`, `minio`, and `storage-init` first, then stop them.

## 9. Documentation and commit boundaries

- Update `README.md` with the E2EE contract, endpoint summary, and limitations.
- `.env.example` is unchanged: no new configuration is introduced.
- Keep the ignored `plan.md` handoff out of feature commits.
- Commit the design spec first, then the implementation as a separate feature
  commit with a long descriptive message.

## 10. Risks

- Adding a required `did` claim invalidates pre-existing access tokens until
  refresh; this is intentional and covered by tests.
- Partitioned-table migrations need SQL review to ensure constraints/indexes
  propagate to all 16 partitions.
- E2EE signature verification relies on Node's Ed25519 implementation and the
  exact byte encodings documented above; client/server encoding drift would
  break registration and bundle verification.

## 11. Acceptance criteria

- Cloud chat behavior and existing 2.2 tests remain unchanged.
- Access tokens expose a stable device id from the refresh-token family.
- The API can store and serve ciphertext but has no plaintext or private keys.
- All secret-message mutation/search paths are rejected.
- New error codes are mapped and documented.
- `npm run verify` and `npm run db:check` pass, and smoke tests cover success and
  error paths.
