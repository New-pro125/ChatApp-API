# inversify-passport

Express 5 + TypeScript API with a module-based, object-oriented architecture built on Inversify 8, Passport, PostgreSQL, and Redis.

See `AGENTS.md` for the conventions AI agents and contributors should follow.

## Stack

- Node 24, TypeScript 7.0.2, ESM
- Express 5, Inversify 8 child containers
- Passport local, GitHub, Google, OIDC SSO, and TOTP strategies
- Redis-backed `express-session`
- PostgreSQL 18
- Argon2id password hashing
- Zod request validation, Pino logging, unified response envelopes, layered error handling
- Account lockout, OTP password reset, TOTP two-factor authentication

## Architecture

```
src/
  app/                 Application bootstrap and HTTP assembly
  core/                Config, container, database, cache, logging, session, HTTP middleware
  modules/
    auth/              Auth module (child container)
      data/            Repositories, hashers, email senders
      logic/           Entities, ports, services
      web/             Controllers, DTOs, routers, Passport strategies
    health/            Health module (child container)
  types/               Ambient Express, session, environment, and Passport declarations
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

### Session authentication

| Method | Path                 | Description                              |
| ------ | -------------------- | ---------------------------------------- |
| `POST` | `/api/auth/register` | Create a user and start a session        |
| `POST` | `/api/auth/login`    | Authenticate and start a session         |
| `POST` | `/api/auth/logout`   | Destroy the session and clear the cookie |
| `GET`  | `/api/auth/me`       | Return the authenticated user            |

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
creating a session. Submit the authenticator or recovery code to
`POST /api/auth/mfa/verify` to establish the session. Challenge tokens are
hashed in the database, short-lived, single-use, attempt-limited, and rejected
after expiry. A TOTP step can only be used once.

OAuth and OIDC callbacks behave the same way: JSON clients receive `202` with a
challenge, while browser callbacks store the challenge in the session and
redirect to `OAUTH_MFA_REDIRECT`.

Protected enrollment, status, disable, and recovery-code routes require an
authenticated session. Disabling MFA or regenerating recovery codes requires a
current authenticator code.

### Password reset

| Method | Path                            | Description                                   |
| ------ | ------------------------------- | --------------------------------------------- |
| `POST` | `/api/auth/password/forgot`     | Request a 6-digit OTP by email                |
| `POST` | `/api/auth/password/verify-otp` | Verify the OTP and receive a single-use token |
| `POST` | `/api/auth/password/reset`      | Set a new password with the reset token       |

The forgot endpoint always returns `202` so it does not reveal whether an email
is registered. Verifying an OTP returns a short-lived reset token. A successful
reset increments the user's session version, invalidating every existing
session for that account.

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

### Health

| Method | Path      | Description                    |
| ------ | --------- | ------------------------------ |
| `GET`  | `/health` | PostgreSQL and Redis readiness |

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

## Configuration

Loaded with `dotenv/config`; values are typed through `src/types/env.d.ts`.
Zod is used only for HTTP request bodies, not environment validation.

Required:

- `DATABASE_URL`
- `REDIS_URL`
- `SESSION_SECRET`
- `MFA_ENCRYPTION_KEY` when `MFA_ENABLED=true` (the default)

Generate an MFA key with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

`DOCS_ENABLED` controls the OpenAPI document and Scalar UI. See `.env.example`
for the full list of database pool, auth hardening, OTP, MFA, SMTP, OAuth, SSO,
and Docker Compose options.

## Scripts

```bash
npm run dev        # tsx watch
npm run clean      # remove dist
npm run typecheck  # tsc --noEmit
npm run build      # clean + tsc + tsc-alias (no source maps)
npm run start      # node dist/index.js
npm run lint       # biome check
npm run check      # biome check --write
npm run verify     # typecheck + lint + build
npm run db:generate  # generate SQL from the Drizzle schema
npm run db:migrate   # apply pending Drizzle migrations
npm run db:check     # detect schema drift
npm run db:studio    # open Drizzle Studio (development only)
npm run db:reset     # drop local schemas and rebuild from migrations
```

## Docker

`Dockerfile` is retained for production images. Compose runs databases and
optional tools only; the API is expected to run locally with `npm run dev`.

```bash
docker build -t inversify-passport .
docker run --env-file .env -p 4000:4000 inversify-passport
```

## Path aliases

Source imports use `@/...`:

```ts
import { AuthService } from '@/modules/auth/logic/auth.service.js';
```

- `tsx` resolves aliases during development.
- `tsc-alias` rewrites `@/...` to relative imports in `dist` after `tsc`.
- `paths` is declared without `baseUrl`, as required by TypeScript 7.
