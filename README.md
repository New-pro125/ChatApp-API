# ChatApp-API

Express 5 + TypeScript API with a module-based, object-oriented architecture built on Inversify 8, Passport, PostgreSQL, and Redis.

See `AGENTS.md` for the conventions AI agents and contributors should follow.

## Stack

- Node 24, TypeScript 7.0.2, ESM
- Express 5, Inversify 8 child containers
- Passport local, GitHub, Google, OIDC SSO, and TOTP strategies
- EdDSA access tokens with rotating single-use refresh tokens
- PostgreSQL 18
- Argon2id password hashing
- Zod request validation, Pino logging, unified response envelopes, layered error handling
- Account lockout, OTP password reset, TOTP two-factor authentication

## Architecture

```
src/
  app/                 Application bootstrap and HTTP assembly
  core/                Config, container, database, cache, logging, auth, HTTP middleware
  modules/
    auth/              Auth module (child container)
      data/            Repositories, hashers, email senders, token stores
      logic/           Entities, ports, services
      web/             Controllers, DTOs, routers, Passport strategies
    health/            Health module (child container)
  types/               Ambient Express, environment, and Passport declarations
```

Each module owns a child container whose parent is the root `AppContainer`. Every request gets its own container scoped to the module container and is disposed when the response closes.

## Ports

| Service               | Host port |
| --------------------- | --------: |
| API                   |      4000 |
| PostgreSQL            |      5434 |
| Redis                 |      6381 |
| MinIO API             |      9000 |
| MinIO console         |      9001 |
| ClamAV (scan profile) |      3310 |
| Adminer               |      8088 |
| RedisInsight          |      5540 |
| Mailpit SMTP          |      1025 |
| Mailpit UI            |      8025 |

Presigned media URLs use the host-reachable `MEDIA_ENDPOINT` (`http://localhost:9000`
locally), so clients and `curl` can fetch objects from the host. Inside Docker,
the API and `storage-init` talk to the S3 backend through the `minio:9000`
service name instead. ClamAV is optional; its port is exposed only when the
`scan` profile is enabled.

## Local development

Databases run in Docker; the API runs on the host.

```bash
cp .env.example .env
npm ci
docker compose up -d postgres redis minio storage-init
npm run db:migrate
npm run dev
```

`minio` and `storage-init` are required for the test suite as well as local
media uploads, so start them before running `npm test` or `npm run verify`.
ClamAV is optional: start it only when you want scanned uploads to succeed with
`docker compose --profile scan up -d`. Without it, uploads fail closed with
`503 MEDIA_SCAN_UNAVAILABLE` unless scanning is explicitly disabled.

Optional tools:

```bash
docker compose --profile tools up -d
```

With Mailpit running, enable SMTP in `.env`:

```dotenv
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_FROM=no-reply@example.com
```

Open Mailpit at <http://localhost:8025>. Without SMTP configured, the password
reset OTP is logged by the API (except in production, where it is redacted).

## API

### Interactive documentation

Every route is registered through `DocumentedRouter`, which records an OpenAPI
3.1 contract while it registers the Express handler. The document is generated
from the same Zod schemas the controllers validate with, so routes cannot be
added without documentation.

- `GET /api/openapi.json` — the generated OpenAPI document
- `GET /api/docs` — the Scalar API reference UI

Documentation is controlled by `DOCS_ENABLED`. It defaults to `true` outside
production and `false` in production; set it explicitly to expose or hide the
docs in a deployed environment. The runtime registry rejects duplicate
`operationId` values and duplicate method/path pairs during startup.

### Token authentication

| Method   | Path                          | Description                                      |
| -------- | ----------------------------- | ------------------------------------------------ |
| `POST`   | `/api/auth/register`          | Create a user and receive the initial token pair |
| `POST`   | `/api/auth/login`             | Authenticate and receive a token pair            |
| `POST`   | `/api/auth/token/refresh`     | Rotate the refresh token and receive a new pair  |
| `POST`   | `/api/auth/token/grant`       | Exchange an OAuth grant code for a token pair    |
| `POST`   | `/api/auth/logout`            | Revoke the calling device's tokens               |
| `POST`   | `/api/auth/logout-all`        | Revoke every device for the account              |
| `GET`    | `/api/auth/me`                | Return the authenticated user                    |
| `PATCH`  | `/api/auth/me`                | Update the authenticated user's profile          |
| `GET`    | `/api/auth/me/privacy`        | Return the caller's privacy settings             |
| `PATCH`  | `/api/auth/me/privacy`        | Update the caller's privacy settings             |
| `GET`    | `/api/auth/me/blocks`         | List the users the caller has blocked            |
| `POST`   | `/api/auth/me/blocks`         | Block a user                                     |
| `DELETE` | `/api/auth/me/blocks/:userId` | Unblock a user                                   |
| `GET`    | `/api/auth/sessions`          | List active refresh-token sessions               |
| `DELETE` | `/api/auth/sessions/:id`      | Revoke one session                               |

Successful authentication returns `{ user, tokens }` where `tokens` is
`{ accessToken, refreshToken, tokenType, expiresIn, refreshExpiresAt }`.
Access tokens are short-lived EdDSA (Ed25519) JWTs carrying the user id,
session version, and the id of the refresh token they were issued with; send
them as `Authorization: Bearer <accessToken>`. The user record is resolved
per request, so password changes, bans, and global logouts take effect
immediately instead of at token expiry.

Refresh tokens are single-use and stored as hashes. Every refresh rotates the
presented token within its family; presenting an already-rotated or revoked
token is treated as theft and revokes the entire family, forcing both the
attacker and the victim to re-authenticate. Logging out one device revokes its
refresh lineage and denylists the outstanding access token in Redis; the
denylist fails open (tokens then expire by TTL) if Redis is unavailable.

### User profile

`PATCH /api/auth/me` updates the authenticated user's profile and returns the
full user record. `GET /api/auth/me`, registration, login, and OAuth responses
include the same fields.

| Field         | Rules                                                                            |
| ------------- | -------------------------------------------------------------------------------- |
| `displayName` | Screen name, 1-100 characters. Always set.                                       |
| `username`    | Optional, unique (case-insensitive), `^[a-z][a-z0-9_]{4,31}$`, stored lowercase. |
| `bio`         | Optional, at most 70 characters.                                                 |
| `phone`       | Optional, unique, E.164 format such as `+15551234567`.                           |
| `avatarKey`   | Read-only. Reserved for the media pipeline; clients cannot set it.               |

Send only the fields you want to change: an omitted field keeps its current
value and `null` clears a nullable field. An empty payload is rejected with
`400 VALIDATION_ERROR`. A username or phone that is already in use returns
`409 CONFLICT` with a field-specific message.

`phone` is informational and **not verified** yet; SMS verification and avatar
uploads arrive in later phases, so treat the stored number as untrusted.

### Privacy settings and blocking

`GET /api/auth/me/privacy` returns the caller's privacy preferences. Accounts
that have never changed them receive permissive defaults without a row being
created; the first write creates one.

| Field                    | Meaning                                                   | Default    |
| ------------------------ | --------------------------------------------------------- | ---------- |
| `profilePhotoVisibility` | Who may see the profile photo                             | `everyone` |
| `lastSeenVisibility`     | Who may see the last-seen timestamp                       | `everyone` |
| `storiesVisibility`      | Who may see stories                                       | `everyone` |
| `readReceiptsEnabled`    | Whether read receipts are shared (mutual, Telegram-style) | `true`     |

`PATCH /api/auth/me/privacy` accepts any subset of the fields; omitted settings
keep their stored value and an empty payload is rejected with
`400 VALIDATION_ERROR`. Visibility accepts `everyone` or `nobody` until the
contact graph exists. `storiesVisibility` is enforced by the stories endpoints
below; the remaining settings are **stored but not yet enforced** and are
honored by messaging and search in later phases.

Blocking is directional and idempotent. `POST /api/auth/me/blocks` with
`{ "userId": "..." }` returns `204`; repeating it is a no-op, blocking yourself
returns `400 VALIDATION_ERROR`, and an unknown target returns `404 NOT_FOUND`.
`GET /api/auth/me/blocks` returns the blocked users, newest first, with
`id`, `username`, `displayName`, `avatarKey`, and `blockedAt`.
`DELETE /api/auth/me/blocks/:userId` also returns `204` and is a no-op when the
user is not blocked. Each side manages its own list, so a block does not appear
in the other user's list.

### Stories

Stories are short-lived posts owned by a user and served by the dedicated
`stories` module. A story carries a caption, a media object key, or both, and
expires after `STORY_TTL_SECONDS` (24 hours by default). Expired stories are
filtered out of every read; there is no background cleanup job yet.

| Method   | Path                         | Description                                    |
| -------- | ---------------------------- | ---------------------------------------------- |
| `POST`   | `/api/stories`               | Create a story                                 |
| `GET`    | `/api/stories`               | List the caller's active stories, newest first |
| `GET`    | `/api/stories/users/:userId` | List another user's active stories             |
| `DELETE` | `/api/stories/:id`           | Delete one of the caller's stories             |

`POST /api/stories` accepts `{ "caption": "..." }`, `{ "mediaKey": "..." }`, or
both; an empty body returns `400 VALIDATION_ERROR`. Creation requires a verified
email (`403 EMAIL_NOT_VERIFIED` otherwise) and is rate limited by the
`rl:stories:` bucket (30 requests per 15 minutes). `mediaKey` is validated as a
safe object key but is currently supplied by the client: the media pipeline
(Phase 2.4) will replace this with server-generated keys and presigned uploads,
and no route serves the object yet.

Reading another user's stories honors their `storiesVisibility` setting. When it
is `nobody` the response is an empty list rather than `403`, so the setting is
not leaked; an unknown user also returns an empty list. `DELETE /api/stories/:id`
returns `204` for an owned story and `404` when the story is missing or belongs
to someone else.

### Media uploads

Phase 2.4 provides a generic upload pipeline. The bucket stays private: the API
generates every object key, issues short-lived presigned PUT/GET URLs, and gates
readiness on a virus scan. Avatar, story, and message integrations are not wired
to it yet and continue using their placeholder keys.

| Method   | Path                      | Purpose                                               |
| -------- | ------------------------- | ----------------------------------------------------- |
| `POST`   | `/api/media/uploads`      | Create a pending object and presigned `PUT` ticket    |
| `POST`   | `/api/media/:id/finalize` | Recheck S3 metadata, scan, and mark ready/quarantined |
| `GET`    | `/api/media/:id`          | Get a fresh presigned `GET` URL for a ready object    |
| `DELETE` | `/api/media/:id`          | Delete the object and its row                         |

All four routes require bearer authentication, a verified email, and the
`rl:media:` limiter. `POST /api/media/uploads` accepts
`{ "contentType": "image/png", "sizeBytes": 1234 }`; the type must appear in
`MEDIA_ALLOWED_CONTENT_TYPES` and the size must be between 1 and
`MEDIA_MAX_BYTES` (default 52428800). The response contains `mediaId`,
`objectKey`, `uploadUrl`, exact `Content-Type`/`Content-Length` headers to send,
and `expiresAt`. Upload the bytes directly to `uploadUrl`, then call finalize.

Finalize returns `200` with `downloadUrl` for a clean object and a SHA-256 hash.
An infected object becomes `quarantined` and returns `422 MEDIA_INFECTED` with
no download URL. A missing object returns `404`, mismatched metadata returns
`400` and marks the row `failed`, a scanner outage returns `503
MEDIA_SCAN_UNAVAILABLE` and leaves the row `pending` for retry, and finalizing a
non-pending object returns `409 MEDIA_NOT_READY`. Setting
`MEDIA_SCAN_REQUIRED=false` explicitly skips scanning and yields a ready object
with a null hash; never do this in production.

Cross-user access always returns `404 NOT_FOUND` without revealing object keys
or download URLs. Objects are deleted from storage before their database rows,
so a storage failure leaves the row available for retry.

### Messaging

One-on-one messaging lives in the `messages` module and is mounted at
`/api/chats`. All routes require a bearer token and a verified email; writes also
use the shared `rl:messages:` bucket (120 requests per 15 minutes).

| Method   | Path                                             | Description                                |
| -------- | ------------------------------------------------ | ------------------------------------------ |
| `POST`   | `/api/chats`                                     | Open (or retrieve) a direct chat           |
| `GET`    | `/api/chats`                                     | List the caller's chats, most active first |
| `POST`   | `/api/chats/:chatId/messages`                    | Send a text message                        |
| `GET`    | `/api/chats/:chatId/messages`                    | List history with keyset pagination        |
| `PATCH`  | `/api/chats/:chatId/messages/:messageId`         | Edit an owned message                      |
| `DELETE` | `/api/chats/:chatId/messages/:messageId`         | Soft-delete an owned message               |
| `POST`   | `/api/chats/:chatId/messages/:messageId/forward` | Forward a message into another chat        |

`POST /api/chats` accepts `{ "participantId": "<uuid>" }`. It returns `201` for a
new chat and `200` for the existing pair, and every chat response embeds public
participant summaries (`userId`, `username`, `displayName`, `avatarKey`). Opening
a chat with yourself returns `400`, an unknown participant returns `404`, and
either side having blocked the other returns `403 USER_BLOCKED`.

`POST /api/chats/:chatId/messages` accepts `{ "body": "...", "replyToMessageId":
"<uuid>" }` with a body of 1–4096 characters. Replies must reference a message in
the same chat. `GET` accepts `limit` (1–100, default 30) and an opaque `cursor`;
history is newest first and `meta.pagination.nextCursor` is `null` on the last
page. The cursor is the last returned uuidv7 message id, so several messages
created in the same millisecond are never skipped.

Only the sender can edit or delete a message. Deletes are tombstones: the row
stays in history with `body: null` and a `deletedAt` timestamp. Forwarding copies
the body into a target chat the caller belongs to and records
`forwardedFromChatId` and `forwardedFromMessageId`. Non-members receive `403
NOT_CHAT_MEMBER` on every chat-scoped operation. Sending and forwarding bump the
chat's `updated_at`, so a newly active conversation moves to the top of
`GET /api/chats`.

### Two-factor authentication

| Method | Path                                      | Description                                           |
| ------ | ----------------------------------------- | ----------------------------------------------------- |
| `POST` | `/api/auth/mfa/verify`                    | Complete a pending login challenge                    |
| `POST` | `/api/auth/mfa/enroll`                    | Start TOTP enrollment                                 |
| `POST` | `/api/auth/mfa/enroll/confirm`            | Confirm TOTP and receive recovery codes               |
| `GET`  | `/api/auth/mfa/status`                    | Return enrollment status and remaining recovery codes |
| `POST` | `/api/auth/mfa/disable`                   | Disable MFA with a current code                       |
| `POST` | `/api/auth/mfa/recovery-codes/regenerate` | Replace recovery codes with a current code            |

MFA is optional per user. Enrollment returns an `otpauth://` URI and a base32
secret for authenticator apps. Confirming enrollment returns one-time recovery
codes; only their hashes are stored. TOTP secrets are encrypted with
AES-256-GCM using `MFA_ENCRYPTION_KEY`.

When a user with MFA enabled logs in with a password, `POST /api/auth/login`
returns `202` with `{ mfaRequired: true, challengeToken, expiresAt }` instead of
issuing tokens. Submit the authenticator or recovery code to
`POST /api/auth/mfa/verify` to receive the token pair. Challenge tokens are
hashed in the database, short-lived, single-use, attempt-limited, and rejected
after expiry. A TOTP step can only be used once.

OAuth and OIDC callbacks behave the same way: JSON clients receive `202` with a
challenge, while browser callbacks redirect to `OAUTH_MFA_REDIRECT` with the
challenge token and expiry in the query, and the web client posts them to
`POST /api/auth/mfa/verify`.

Protected enrollment, status, disable, and recovery-code routes require a valid
access token. Disabling MFA or regenerating recovery codes requires a
current authenticator code.

### Email verification

| Method | Path                     | Description                           |
| ------ | ------------------------ | ------------------------------------- |
| `POST` | `/api/auth/email/resend` | Send a new verification code          |
| `POST` | `/api/auth/email/verify` | Confirm the email with a 6-digit code |

Registering an account sends an initial verification code automatically.
Codes are generated with a cryptographically secure RNG, stored only as Argon2
hashes, expire after `EMAIL_VERIFICATION_TTL_SECONDS`, and are limited to
`EMAIL_VERIFICATION_MAX_ATTEMPTS` guesses. Requesting a new code invalidates
any older active code, and requests inside
`EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS` return `429 RATE_LIMITED` with a
`Retry-After` header. Issuance is serialized per account, so concurrent resends
cannot both pass the cooldown. Resending for an account that is already
verified returns `409 CONFLICT`.

Unverified users can still log in, review their sessions, change their password,
and manage MFA, but messaging and upload routes will be gated by
`RequireVerifiedEmailMiddleware`, which returns `403 EMAIL_NOT_VERIFIED` until
the address is confirmed. `GET /api/auth/me` exposes `emailVerifiedAt` so
clients can display and prompt for verification.

### Password reset

| Method | Path                            | Description                                   |
| ------ | ------------------------------- | --------------------------------------------- |
| `POST` | `/api/auth/password/forgot`     | Request a 6-digit OTP by email                |
| `POST` | `/api/auth/password/verify-otp` | Verify the OTP and receive a single-use token |
| `POST` | `/api/auth/password/reset`      | Set a new password with the reset token       |

The forgot endpoint always returns `202` so it does not reveal whether an email
is registered. Verifying an OTP returns a short-lived reset token. A successful
reset increments the user's session version and revokes every refresh token for
the account, invalidating all existing sessions.

### OAuth2 and OIDC

| Method | Path                                | Description        |
| ------ | ----------------------------------- | ------------------ |
| `GET`  | `/api/auth/oauth/github`            | Start GitHub OAuth |
| `GET`  | `/api/auth/oauth/github/callback`   | GitHub callback    |
| `GET`  | `/api/auth/oauth/google`            | Start Google OAuth |
| `GET`  | `/api/auth/oauth/google/callback`   | Google callback    |
| `GET`  | `/api/auth/oauth/facebook`          | Start Meta OAuth   |
| `GET`  | `/api/auth/oauth/facebook/callback` | Meta callback      |
| `GET`  | `/api/auth/sso`                     | Start OIDC SSO     |
| `GET`  | `/api/auth/sso/callback`            | OIDC callback      |

A provider is enabled only when its client ID, secret, and callback URL are all
set. OAuth accounts are linked to existing users by verified email; if no
matching user exists, one is created. Unverified provider emails are rejected.

Facebook does not expose a per-email verification flag in its profile, so an
email returned by the Facebook Graph API is treated as verified. If the user
declines the `email` permission, login fails rather than creating an account
without an address.

OAuth state is kept server-side in Redis behind an opaque httpOnly cookie, so
PKCE code verifiers never reach the browser. JSON clients receive the token pair
directly from the callback; browser callbacks redirect to
`OAUTH_SUCCESS_REDIRECT` with a single-use grant code that the web client
exchanges at `POST /api/auth/token/grant`.

### Health and metrics

| Method | Path            | Description                                    |
| ------ | --------------- | ---------------------------------------------- |
| `GET`  | `/health/live`  | Liveness; never touches dependencies           |
| `GET`  | `/health/ready` | PostgreSQL and Redis readiness                 |
| `GET`  | `/health`       | Deprecated alias for `/health/ready`           |
| `GET`  | `/metrics`      | Prometheus metrics, gated by `METRICS_ENABLED` |

Readiness checks are coalesced and cached for `HEALTH_CACHE_TTL_MS` so frequent
orchestrator probes cannot turn into a database connection storm. `METRICS_TOKEN`
optionally requires `Authorization: Bearer <token>` on `/metrics`. The metrics
use the matched route template as a label, so request ids and user ids never
create unbounded series.

### Server hardening

The raw HTTP server is owned by `src/core/http/server/http-server.ts`, not by
`app.listen`. It applies explicit request, header, keep-alive, connection-check,
header-size, and per-socket request limits, rejects malformed requests with a
`400` and `Connection: close`, and drains connections during shutdown before
force-closing whatever remains after `HTTP_SHUTDOWN_TIMEOUT_MS`. The Express
pipeline adds request ids, structured redacted request logs, Helmet, an origin
allowlist, compression, a JSON body limit, and `Cache-Control: no-store` for
API responses. All limits and origins are environment-driven; see `.env.example`.

## Response contract

Every JSON response uses one of two envelopes. Controllers use the injected
`ApiResponse` service from `src/core/http/response/api-response.ts`; they never
call `res.json` directly.

Success:

```json
{
  "success": true,
  "data": {},
  "message": "Optional human-readable outcome",
  "meta": {
    "requestId": "b4c1f4d2-...",
    "pagination": {
      "page": 1,
      "pageSize": 20,
      "total": 42,
      "totalPages": 3,
      "hasNextPage": true,
      "hasPreviousPage": false
    }
  }
}
```

Error:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request",
    "details": [{ "path": "email", "message": "Invalid email", "code": "invalid_format" }]
  },
  "meta": {
    "requestId": "b4c1f4d2-..."
  }
}
```

`data` holds the resource itself: a single object, an array for lists, or
`null` for message-only responses. Pagination is always under `meta`.
`204 No Content` responses have no body.

Available `ApiResponse` methods: `send`, `ok`, `created`, `accepted`, `list`,
`paginated`, `noContent`, and `fail`. The global error handler uses `fail`, so
success and error envelopes share the same `requestId` source.

## Error model

Errors are layered so transport concerns do not leak into business or data code:

| File                              | Purpose                                                                    |
| --------------------------------- | -------------------------------------------------------------------------- |
| `core/errors/app.error.ts`        | `AppError` base with a transport-neutral `code` and `details`              |
| `core/errors/http.error.ts`       | `HttpException` and concrete 4xx/5xx exceptions                            |
| `core/errors/domain.error.ts`     | Business-flow exceptions such as `AccountLocked` and `OtpInvalid`          |
| `core/errors/repository.error.ts` | `RepositoryException`, `UniqueConstraintException`, `PersistenceException` |
| `core/errors/error-mapper.ts`     | The single place that maps any thrown value to status and body             |

Domain errors carry no HTTP status. The injected `ErrorMapper` service maps
domain codes to statuses, converts `UniqueConstraintException` to
`409 CONFLICT`, sanitizes repository and unknown failures to `INTERNAL_ERROR`,
and sets `Retry-After` for `AccountLockedException`. Zod and body-parser
failures are normalized in the same mapper.

## Rate limiting

Authentication endpoints use `express-rate-limit` with a Redis-backed fixed
window (`rate-limit-redis`). Counters survive API restarts and are shared across
instances that use the same Redis database. The auth routes allow 20 requests
per 15 minutes per client IP, and profile updates use a separate `rl:profile:`
bucket (30 requests per 15 minutes) so editing a profile never consumes the
login or registration quota. Redis store errors are treated as server errors
rather than silently allowing requests. Story creation uses its own `rl:stories:`
bucket (30 requests per 15 minutes), and messaging writes use `rl:messages:`
(120 requests per 15 minutes).

## Account lockout

After `AUTH_MAX_FAILED_ATTEMPTS` failures inside `AUTH_LOCKOUT_WINDOW_SECONDS`,
the account is locked for `AUTH_LOCKOUT_SECONDS`. Locked logins return HTTP
`423` with an `ACCOUNT_LOCKED` error code and a `Retry-After` header.

## Captcha

Registration and login accept an optional `captchaToken` (a Cloudflare Turnstile
token) in the JSON body. When `CAPTCHA_ENABLED=true`, the token is mandatory and
verified through `CAPTCHA_VERIFY_URL` before any credential, lockout, or
account-creation work happens, so failed captchas never consume password hashing
or increment `failed_login_attempts` and never reveal whether an email exists.

- `400 CAPTCHA_REQUIRED` — the token is missing while captcha is enabled.
- `400 CAPTCHA_INVALID` — the provider rejected the token, hostname, or action.
- `503 CAPTCHA_UNAVAILABLE` — the provider timed out, returned a non-2xx status,
  or answered with malformed JSON. The request fails closed.

`CAPTCHA_SECRET` is required when the feature is enabled;
`CAPTCHA_EXPECTED_HOSTNAME` and `CAPTCHA_EXPECTED_ACTION` optionally pin tokens
to a specific site hostname and widget action. Local development and tests keep
captcha disabled, so no provider credentials are needed.

## Configuration

Loaded with `dotenv/config`; values are typed through `src/types/env.d.ts`.
Zod is used only for HTTP request bodies, not environment validation.

Required:

- `DATABASE_URL`
- `REDIS_URL`
- `ACCESS_TOKEN_PRIVATE_KEY` in production: a base64url-encoded 32-byte Ed25519
  seed. Development falls back to an ephemeral key, which invalidates tokens on
  every restart.
- `MFA_ENCRYPTION_KEY` when `MFA_ENABLED=true` (the default)

Generate either key with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

`DOCS_ENABLED` controls the OpenAPI document and Scalar UI. `METRICS_ENABLED`
and `METRICS_TOKEN` control the Prometheus endpoint. The `HTTP_*`, `TRUST_PROXY`,
`APP_ORIGINS`, and `HEALTH_CACHE_TTL_MS` variables tune server timeouts, proxy
trust, the CORS allowlist, and readiness caching. `SMTP_TIMEOUT_MS` bounds SMTP
connection, greeting, and socket waits. See `.env.example` for the full list of
database pool, HTTP hardening, auth hardening, OTP, email verification, stories,
messaging, captcha, MFA, SMTP, OAuth, SSO, and Docker Compose options.

### Media uploads and scanning

| Variable                      | Default                                                                                                                   | Purpose                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `MEDIA_BUCKET`                | `messenger-media`                                                                                                         | Private S3 bucket that holds media objects.          |
| `MEDIA_REGION`                | `us-east-1`                                                                                                               | Region used to sign S3 requests.                     |
| `MEDIA_ENDPOINT`              | `http://localhost:9000`                                                                                                   | Host-reachable endpoint embedded in presigned URLs.  |
| `MEDIA_ACCESS_KEY_ID`         | `minioadmin`                                                                                                              | S3 access key id.                                    |
| `MEDIA_SECRET_ACCESS_KEY`     | `minioadmin`                                                                                                              | S3 secret access key.                                |
| `MEDIA_FORCE_PATH_STYLE`      | `true`                                                                                                                    | Use path-style S3 URLs (required by MinIO).          |
| `MEDIA_MAX_BYTES`             | `52428800`                                                                                                                | Largest accepted upload, in bytes (50 MiB).          |
| `MEDIA_ALLOWED_CONTENT_TYPES` | `image/jpeg,image/png,image/gif,image/webp,video/mp4,audio/mpeg,application/pdf,application/zip,application/octet-stream` | Comma-separated MIME allowlist for uploads.          |
| `MEDIA_PRESIGN_TTL_SECONDS`   | `300`                                                                                                                     | Lifetime of presigned PUT and GET URLs.              |
| `MEDIA_SCAN_REQUIRED`         | `true`                                                                                                                    | Fail closed when no scanner is available.            |
| `CLAMAV_HOST`                 | `127.0.0.1`                                                                                                               | ClamAV daemon host used for INSTREAM scans.          |
| `CLAMAV_PORT`                 | `3310`                                                                                                                    | ClamAV daemon port.                                  |
| `CLAMAV_TIMEOUT_MS`           | `10000`                                                                                                                   | Timeout for one scan request, in milliseconds.       |
| `CLAMAV_HOST_PORT`            | `3310`                                                                                                                    | Host port published by the Compose `clamav` service. |

`MEDIA_SCAN_REQUIRED` defaults to `true`: an unreachable scanner makes finalize
return `503 MEDIA_SCAN_UNAVAILABLE` and leaves the object pending for retry. No
`NODE_ENV` check changes that default. Setting `MEDIA_SCAN_REQUIRED=false` is the
only bypass, is meant for local development and tests, and must never be used in
production.

## Scripts

```bash
npm run dev        # tsx watch
npm run clean      # remove dist
npm run typecheck  # tsc --noEmit
npm test           # run Vitest integration tests
npm run test:watch # vitest watch mode
npm run build      # clean + tsc + tsc-alias (no source maps)
npm run start      # node dist/index.js
npm run lint       # biome check
npm run check      # biome check --write
npm run verify     # typecheck + lint + build + test
npm run db:generate  # generate SQL from the Drizzle schema
npm run db:migrate   # apply pending Drizzle migrations
npm run db:check     # detect schema drift
npm run db:studio    # open Drizzle Studio (development only)
npm run db:reset     # drop local schemas and rebuild from migrations
```

> **Deploying migration `0009_young_human_fly`:** it alters the partitioned
> `messages` table, so PostgreSQL takes an `ACCESS EXCLUSIVE` lock that applies
> to every partition. Apply it in a maintenance window, or set a short
> `lock_timeout` (for example `SET lock_timeout = '5s'`) and retry so the DDL
> does not queue behind long-running reads and block new queries.

## Docker

`Dockerfile` is retained for production images. Compose provides the backing
services; the API is expected to run locally with `npm run dev` or as the built
image.

| Service         | Default port              | Purpose                                          |
| --------------- | ------------------------- | ------------------------------------------------ |
| `postgres`      | `5434`                    | PostgreSQL 18                                    |
| `pgbouncer`     | `6434`                    | Transaction-pooling proxy in front of Postgres   |
| `redis`         | `6381`                    | Token denylist, OAuth state, rate limits, queues |
| `minio`         | `9000`, console `9001`    | S3-compatible media storage                      |
| `storage-init`  | —                         | Creates and version-enables the media bucket     |
| `coturn`        | `3478`, UDP `49160-49200` | TURN relay for WebRTC calls                      |
| `clamav`        | `3310`                    | Optional upload scanning (`--profile scan`)      |
| `adminer`       | `8088`                    | Database UI (`--profile tools`)                  |
| `redis-insight` | `5540`                    | Redis UI (`--profile tools`)                     |
| `mailpit`       | SMTP `1025`, UI `8025`    | Local email testing (`--profile tools`)          |

```bash
docker compose up -d postgres pgbouncer redis minio storage-init coturn
docker compose --profile tools up -d
docker compose --profile scan up -d clamav

docker build -t inversify-passport .
docker run --env-file .env -p 4000:4000 inversify-passport
```

`pgbouncer` runs in transaction pooling mode. Use it as the production
`DATABASE_URL` target (host port `6434` locally) once the API is deployed;
local development can keep pointing at PostgreSQL directly. TURN is configured
for local use with long-term credentials and no TLS. For a public deployment,
provide certificates, enable TLS/DTLS, and set coturn's `external-ip` to the
relay's public address.

MinIO withdrew its public Docker images, so the `minio` service uses the
Bitnami legacy build of the same S3-compatible server. The API only depends on
the S3 API, so any S3-compatible backend (including a pinned private mirror)
can replace it. `storage-init` uses the AWS CLI, not the MinIO client, so bucket
provisioning keeps working with any compatible endpoint.

## Path aliases

Source imports use `@/...`:

```ts
import { AuthService } from '@/modules/auth/logic/auth.service.js';
```

- `tsx` resolves aliases during development.
- `tsc-alias` rewrites `@/...` to relative imports in `dist` after `tsc`.
- `paths` is declared without `baseUrl`, as required by TypeScript 7.

## End-to-end encrypted secret chats

The API supports hybrid E2EE. Normal direct chats remain server-visible and
searchable. Secret chats (`type: "secret"`) store only opaque ciphertext; the
API never receives private keys, shared secrets, or plaintext.

Clients register one device per refresh-token family:

- `POST /api/e2ee/devices`
- `GET /api/e2ee/devices`
- `GET /api/e2ee/users/:userId/devices`
- `POST /api/e2ee/devices/rotate`
- `POST /api/e2ee/devices/prekeys`
- `GET /api/e2ee/users/:userId/devices/:deviceId/bundle`

The peer device listing lets an authenticated client discover another user's
public devices without that user's token. Device listings expose
`identitySignature` and `hasOneTimePreKeys`, but never private keys or shared
secrets. Clients **must** verify that `identitySignature` is a valid Ed25519
signature by the device's `signingPublicKey` over the UTF-8 bytes
`e2ee-identity:` followed by the raw 32-byte `identityPublicKey`, and must
verify the signed prekey signature the same way over
`e2ee-signed-prekey:${id}:` followed by the raw prekey bytes.

Then they can open and use a secret chat:

- `POST /api/chats/secret`
- `POST /api/chats/:chatId/secret-messages`
- `GET /api/chats/:chatId/messages`

Secret messages cannot be edited, deleted, forwarded, replied to, or searched.
Media, self-destruct timers, and a double ratchet are not part of this release.
Pre-existing access tokens without the `did` claim must be refreshed.
