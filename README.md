# inversify-passport

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

| Service      | Host port |
| ------------ | --------: |
| API          |      4000 |
| PostgreSQL   |      5434 |
| Redis        |      6381 |
| Adminer      |      8088 |
| RedisInsight |      5540 |
| Mailpit SMTP |      1025 |
| Mailpit UI   |      8025 |

## Local development

Databases run in Docker; the API runs on the host.

```bash
cp .env.example .env
npm ci
docker compose up -d postgres redis
npm run db:migrate
npm run dev
```

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

| Method   | Path                      | Description                                      |
| -------- | ------------------------- | ------------------------------------------------ |
| `POST`   | `/api/auth/register`      | Create a user and receive the initial token pair |
| `POST`   | `/api/auth/login`         | Authenticate and receive a token pair            |
| `POST`   | `/api/auth/token/refresh` | Rotate the refresh token and receive a new pair  |
| `POST`   | `/api/auth/token/grant`   | Exchange an OAuth grant code for a token pair    |
| `POST`   | `/api/auth/logout`        | Revoke the calling device's tokens               |
| `POST`   | `/api/auth/logout-all`    | Revoke every device for the account              |
| `GET`    | `/api/auth/me`            | Return the authenticated user                    |
| `GET`    | `/api/auth/sessions`      | List active refresh-token sessions               |
| `DELETE` | `/api/auth/sessions/:id`  | Revoke one session                               |

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
`Retry-After` header. Resending for an account that is already verified returns
`409 CONFLICT`.

Unverified users can still log in, review their sessions, change their password,
and manage MFA, but messaging and upload routes are gated by
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

| Method | Path                              | Description        |
| ------ | --------------------------------- | ------------------ |
| `GET`  | `/api/auth/oauth/github`          | Start GitHub OAuth |
| `GET`  | `/api/auth/oauth/github/callback` | GitHub callback    |
| `GET`  | `/api/auth/oauth/google`          | Start Google OAuth |
| `GET`  | `/api/auth/oauth/google/callback` | Google callback    |
| `GET`  | `/api/auth/sso`                   | Start OIDC SSO     |
| `GET`  | `/api/auth/sso/callback`          | OIDC callback      |

A provider is enabled only when its client ID, secret, and callback URL are all
set. OAuth accounts are linked to existing users by verified email; if no
matching user exists, one is created. Unverified provider emails are rejected.

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

## Database access: `pg` versus Drizzle

The current repositories use hand-written SQL over a shared `pg.Pool`, with
explicit row interfaces, row mappers, and `node-pg-migrate` migrations. This is
not a scalability bottleneck by itself: the pool controls connections, queries
are explicit, and repositories already isolate SQL from domain entities.

The tradeoff is maintenance:

- **Typing:** raw SQL rows are trusted manually. A renamed column or a bad join
  fails at runtime, not at type-check time.
- **Boilerplate:** each table needs a row type, a mapper, and a column list.
  Drizzle infers result types from a schema and removes most of that for CRUD,
  joins, filters, and partial selects.
- **Migrations:** `node-pg-migrate` is already explicit and working. Drizzle
  would need a schema-first migration strategy (`drizzle-kit`) and a baseline
  for the existing migrations. Keeping both tools would create two sources of
  truth.
- **Complex SQL:** transactions, `ON CONFLICT`, CTEs, and partial indexes still
  require careful SQL. Drizzle improves the typed surface around them but does
  not eliminate the SQL.
- **Domain boundaries:** Drizzle returns schema-shaped rows. Repositories would
  still map them to domain records if the architecture is to stay clean.

Recommendation: keep `pg` for the current three repositories. It is predictable
and the query surface is small. Adopt Drizzle when the number of entities,
joins, dynamic filters, and paginated read models grows enough that hand-written
row types and mappers become the main source of defects. If that happens, do a
full adoption with a schema baseline rather than mixing Drizzle and raw SQL
indefinitely. Drizzle does not make the database faster; it improves type
safety and reduces query boilerplate.

## Rate limiting

Authentication endpoints use `express-rate-limit` with a Redis-backed fixed
window (`rate-limit-redis`). Counters survive API restarts and are shared across
instances that use the same Redis database. The current policy is 20 requests
per 15 minutes per client IP across the auth routes. Redis store errors are
treated as server errors rather than silently allowing requests.

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
trust, the CORS allowlist, and readiness caching. See `.env.example` for the
full list of database pool, HTTP hardening, auth hardening, OTP, email
verification, captcha, MFA, SMTP, OAuth, SSO, and Docker Compose options.

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
