# AGENTS.md

Instructions for AI coding agents working in this repository. Read this file
before making changes, then read `README.md` for the public API and setup guide.

## Project snapshot

- Node 24, TypeScript 7.0.2, ESM (`"type": "module"`)
- Express 5 with Inversify 8 child containers
- Passport local, GitHub, Google, Facebook, and OIDC SSO strategies
- PostgreSQL 18 through Drizzle ORM (`pg` driver; PgBouncer in production),
  Redis-backed rate limiting, token denylist, and OAuth state
- EdDSA (Ed25519) access tokens with rotating single-use refresh tokens
- Argon2id password hashing
- Zod request validation with generated OpenAPI 3.1 and the Scalar UI
- Pino and pino-http logging, prom-client metrics, Biome linting/formatting
- BullMQ, S3-compatible media storage, coturn for WebRTC calls
- Integration test suite with Vitest and Supertest; verify with `npm test` or `npm run verify`.

## Commands

```bash
npm ci
docker compose up -d postgres redis minio storage-init
npm run db:migrate
npm run dev

npm test            # run Vitest integration tests
npm run test:watch  # run Vitest in watch mode
npm run typecheck   # tsc --noEmit (app + tests)
npm run lint        # biome check
npm run check       # biome check --write
npm run build       # tsc + tsc-alias
npm run verify      # typecheck + lint + build + test
npm run start       # run dist/index.js

npm run db:generate # generate SQL from the Drizzle schema
npm run db:migrate  # apply pending Drizzle migrations
npm run db:check    # detect schema drift
npm run db:studio   # Drizzle Studio (development only)
npm run db:reset    # drop local schemas and rebuild from migrations
```

Host ports: API `4000`, PostgreSQL `5434`, PgBouncer `6434`, Redis `6381`,
MinIO `9000` and console `9001`, coturn `3478` plus UDP `49160-49200`,
Adminer `8088`, RedisInsight `5540`, Mailpit SMTP `1025` and UI `8025`,
ClamAV `3310` under the `scan` profile.

## Architecture

```text
src/
  app/                 Application lifecycle and HTTP assembly
  core/                Config, container, database, cache, logging, HTTP,
                       metrics, errors, auth tokens
    database/schema/   Drizzle table definitions and the Drizzle Kit barrel
    http/openapi/      DocumentedRouter, registry, document builder, docs router
    http/server/       Raw HTTP server, timeouts, graceful shutdown
    http/logging/      pino-http request logging
    metrics/           Prometheus registry, HTTP instrumentation, scrape router
  modules/
    auth/              Auth feature module and child container
      data/            Repositories, hashers, email senders, token stores
      logic/           Entities, ports, services
      web/             Controllers, DTOs, routers, Passport strategies
    health/            Health feature module and child container
  types/               Ambient Express, environment, Passport declarations
```

- `AppContainer` is the root container. Each module creates a child container
  whose parent is the root container.
- Each HTTP request gets a request-scoped child container from
  `RequestScopeMiddleware`; it is disposed when the response closes.
- `Application` wires global middleware, modules, the 404 handler, and the
  global error handler in that order.
- `ApplicationRunner` owns process startup, signal handling, and shutdown.
- Modules depend on `core`, never on each other. Put shared cross-module
  behavior in `core` behind a service or port instead of importing another
  module's data layer.

## OOP and dependency-injection rules

- Put behavior in classes. Do not add module-level helper functions unless the
  function is a framework callback that cannot reasonably be a method (for
  example Express handlers, Passport verify callbacks, `process.once`
  listeners) or a declarative value such as a Zod schema, symbol table, or
  type-only export.
- Prefer `@injectable()` services plus constructor injection with
  `@inject(TYPE_SYMBOL)`. Bind implementations in the appropriate container.
- Keep shared HTTP behavior in the `ApiResponse` service and error translation
  in the `ErrorMapper` service. Both are bound in the root container.
- Controllers are request-scoped classes resolved from `req.container`.
  `OAuthController` and `OAuthRouter` are constructed once, so do not assume a
  request-scoped dependency there.
- Repositories implement ports from `logic/ports`; services depend on those
  ports, not concrete PostgreSQL classes.
- Keep domain and data layers free of Express types and HTTP status codes.

## Import and style conventions

- Use `@/...` path aliases and explicit `.js` extensions in relative ESM imports.
- Biome: single quotes, semicolons, trailing commas, 2-space indentation,
  100-character line width, organized imports.
- Prefer `unknown` over `any`; narrow explicitly.
- Use typed request bodies and consistent DTO schemas in `web/dto`.
- Validate HTTP input with Zod in controllers or web-layer code.
- Never commit `.env`, secrets, tokens, or real credentials.

## Response contract

All JSON responses use one envelope. Controllers must use the injected
`ApiResponse` service instead of calling `res.json` directly.

Success:

```json
{
  "success": true,
  "data": {},
  "message": "optional",
  "meta": { "requestId": "...", "pagination": { "...": "optional" } }
}
```

Error:

```json
{
  "success": false,
  "error": { "code": "VALIDATION_ERROR", "message": "Invalid request", "details": [] },
  "meta": { "requestId": "..." }
}
```

- `data` is the resource itself: an object, an array, or `null` for
  message-only responses.
- Pagination belongs under `meta.pagination`.
- `204 No Content` responses have no body.
- Success and error envelopes use the same `requestId` source.

`ApiResponse` methods: `send`, `ok`, `created`, `accepted`, `list`,
`paginated`, `noContent`, `fail`.

## Error model

Use the layered hierarchy instead of throwing ad hoc `Error` objects with HTTP
statuses:

| Layer      | Location                          | Use for                                    |
| ---------- | --------------------------------- | ------------------------------------------ |
| Base       | `core/errors/app.error.ts`        | Shared `code`, `details`, `cause`          |
| HTTP       | `core/errors/http.error.ts`       | Transport-level failures with known status |
| Domain     | `core/errors/domain.error.ts`     | Business rules and auth-flow failures      |
| Repository | `core/errors/repository.error.ts` | Data-layer failures and unique constraints |
| Mapper     | `core/errors/error-mapper.ts`     | The only place status codes are chosen     |

Rules:

- Domain errors carry no HTTP status. Add the code-to-status mapping in
  `ErrorMapper` if a new public code is introduced.
- Wrap database failures in repository exceptions. Never expose raw `pg` errors.
- Unknown errors are logged and sanitized in production.
- Preserve `423 ACCOUNT_LOCKED` and the `Retry-After` header.
- Preserve Zod validation details and body-parser error normalization.

## Authentication invariants

Do not regress these behaviors:

- Failed logins lock the account after `AUTH_MAX_FAILED_ATTEMPTS` inside the
  configured window. Locked logins return `423` with `ACCOUNT_LOCKED` and
  `Retry-After`.
- `POST /api/auth/password/forgot` always returns `202`, whether or not the
  email exists.
- OTP verification returns a short-lived, single-use reset token.
- A successful password reset increments `users.session_version` and revokes
  every refresh token for the account, invalidating all existing sessions.
- Reused or expired reset tokens are rejected.
- Registration sends an initial email-verification code, but registration
  never fails when the email cannot be delivered.
- Email-verification codes are Argon2-hashed, expire after
  `EMAIL_VERIFICATION_TTL_SECONDS`, are limited to
  `EMAIL_VERIFICATION_MAX_ATTEMPTS`, and are single-use. Issuance is serialized
  per user (row lock plus a partial unique index on active codes), so
  concurrent resends cannot both pass the cooldown. Requesting a new code
  invalidates older active codes and is rejected with `429 RATE_LIMITED` (and
  `Retry-After`) inside the resend cooldown. Resending for an already verified
  address returns `409 CONFLICT`.
- Unverified users may log in and manage their account, but messaging and
  uploads are gated by `RequireVerifiedEmailMiddleware` (`403
  EMAIL_NOT_VERIFIED`). Resolve it as `CORE_TYPES.RequireVerifiedEmail`; do not
  inspect `emailVerifiedAt` ad hoc in feature modules.
- Registration and login run `CaptchaService.assertValid()` before credentials,
  lockout accounting, or account creation. A missing token returns
  `400 CAPTCHA_REQUIRED`, a rejected token `400 CAPTCHA_INVALID`, and a provider
  outage `503 CAPTCHA_UNAVAILABLE`. Failed captchas must never increment
  `failed_login_attempts` or reveal whether an email exists.
- OAuth/OIDC accounts require a verified provider email and are linked to an
  existing user by verified email when possible.
- Password authentication alone never issues tokens when MFA is enabled; it
  returns a short-lived, single-use challenge instead.
- OAuth/OIDC logins for MFA-enabled users follow the same challenge flow before
  tokens are issued. JSON callbacks return the challenge, browser callbacks
  redirect to `OAUTH_MFA_REDIRECT` with the challenge in the query.
- TOTP secrets are encrypted with AES-256-GCM through `MfaSecretCipher`.
  Challenge tokens and recovery codes are stored only as hashes.
- A TOTP time step is single-use; reject replays through
  `users.mfa_last_totp_step`.
- Enrollment, disable, and recovery-code regeneration go through
  `MfaService`; do not duplicate TOTP or recovery-code validation in
  controllers.
- Access tokens are short-lived EdDSA JWTs signed by `AccessTokenService` and
  verified by `RequireBearerAuthMiddleware`, which resolves the user through
  the root-scoped `PrincipalStore` and rejects stale `sessionVersion` claims.
- Refresh tokens are single-use and hashed at rest. Rotation issues a
  successor in the same family; presenting a rotated or revoked token revokes
  the entire family (reuse detection) and both sides must re-authenticate.
- `TokenService` is the only issuer and rotator of token pairs; controllers
  never construct or verify tokens themselves.
- OAuth state lives in Redis behind the opaque `OAUTH_STATE_COOKIE_NAME`
  cookie through `OAuthStateStore`; passport-oauth2 state and OIDC PKCE
  verifiers never reach the browser.
- Browser OAuth callbacks redirect with a single-use grant code exchanged at
  `POST /api/auth/token/grant`; JSON callbacks receive the token pair directly.
- The Redis denylist in `AuthDenylist` fails open when Redis errors, so a
  Redis outage degrades to TTL-only expiry rather than locking everyone out.

## Database and migrations

Drizzle ORM is the only application data-access layer.

- Table definitions live in `src/core/database/schema/*.schema.ts` and are
  exported once from `schema/index.ts`; that barrel is the Drizzle Kit entry
  point. Each schema file documents the module that owns its tables.
- Repositories live in module `data/` layers, inject `CORE_TYPES.Db`, import
  tables from the schema barrel, and map rows to domain records through a
  mapper class. Drizzle types never leave the data layer, and services depend
  on `logic/ports` interfaces, never on repositories directly.
- Raw `pg.Pool` access (`CORE_TYPES.PgPool`) is reserved for health checks and
  migration tooling; do not add repositories on the raw pool.
- Conventions: plural snake_case table names with explicit column names,
  `uuidv7()` primary keys, `timestamptz` timestamps, `created_at`/`updated_at`
  on mutable rows, and explicit names for every index, check, and unique
  constraint.
- Foreign keys: `CASCADE` for rows owned by their parent, `RESTRICT` for
  cross-aggregate references. Enforce row invariants with `check` constraints.
- Use transactions for multi-step writes, keyset pagination for lists, and
  select only the columns a handler needs. Review the generated SQL and check
  the query plan for every new index or hot predicate.
- Wrap unique violations with `UniqueConstraintException` through
  `PostgresErrorInspector`; never expose raw `pg` errors to services.
- Migrations are generated with `npm run db:generate`, reviewed as SQL, and
  applied with `npm run db:migrate`. Never edit an applied migration; generate
  a new one instead. `npm run db:check` detects drift and `npm run db:reset`
  rebuilds a local database from scratch.
- Drizzle Kit connects with `DATABASE_URL`; in production point it directly at
  PostgreSQL, never at PgBouncer. PgBouncer runs in transaction pooling mode,
  so avoid session-level PostgreSQL features (advisory locks, LISTEN/NOTIFY,
  session `SET`s) in request paths.

## API documentation

- Every route is registered through `DocumentedRouter` with a
  `RouteContract` that carries `operationId` (`module.action`), tags, summary,
  request schemas, and response schemas. The registry rejects duplicate
  operations at boot, so a route cannot exist undocumented.
- The same Zod schemas document requests and validate them in controllers;
  never maintain a second schema for documentation.
- Response schemas wrap resources with `successEnvelope`/`errorEnvelope` so
  the generated document matches the runtime envelope.
- `GET /api/openapi.json` serves the document and `GET /api/docs` serves the
  Scalar UI; both are gated by `DOCS_ENABLED` (off by default in production).
- New public error codes or auth schemes must be reflected in the shared
  document components (`openapi.schemas.ts` and the security schemes in the
  document builder).

## HTTP and production hardening

- Never call `app.listen`. `HttpServer` owns listening, socket timeouts,
  connection limits, and graceful shutdown, tuned through `HttpConfig`
  environment values.
- `trust proxy`, CORS origins, the compression threshold, and body limits come
  from configuration; never derive them from `NODE_ENV` checks.
- `Application` wires global middleware in a fixed order: request id, request
  logging, security headers, CORS, compression, cache control, metrics, body
  parsing, authentication, module routers, 404, then the global error handler.
- `/health/live` is dependency-free. `/health/ready` checks PostgreSQL and
  Redis and caches its result for `HEALTH_CACHE_TTL_MS` so probes do not
  hammer dependencies.
- Shut down through `Application.stop()`: stop accepting connections, drain
  keep-alive sockets, wait for the shutdown timeout, then close remaining
  connections before disposing modules and the container.
- pino-http request logs carry request ids; cookies, authorization headers,
  and credentials are redacted. prom-client metrics are exposed on `/metrics`
  when enabled.

## Configuration and runtime

- `AppConfig` reads environment variables through `EnvironmentReader`; required
  values fail fast and no other file should read `process.env` directly.
- `MFA_ENABLED` defaults to `true`, so `MFA_ENCRYPTION_KEY` is required unless
  MFA is explicitly disabled. The key must be a base64url-encoded 32-byte value.
- Update both `.env.example` and the README when adding configuration.
- `npm run dev` uses `tsx`; `npm run start` runs compiled `dist`.
- The database and Redis containers are not started automatically.
- Stop any API process you start and clean up temporary test users when done.

## Definition of done

Before reporting completion:

1. Run `npm run verify` (typecheck, lint, build, test).
2. For HTTP, auth, error, or database changes, run the app and smoke-test the
   affected endpoints, including at least one success and one error path.
3. Verify lockout headers and reset-token behavior if auth was touched.
4. Update `README.md`, `.env.example`, or migrations when behavior or setup
   changes.
5. Remove temporary users and stop processes/containers you started.
6. Report exactly what changed, how it was verified, and any remaining risk.

## Common change recipes

- New endpoint: add a controller method, bind/inject dependencies, add the route
  in the module router, validate with Zod, return through `ApiResponse`.
- New error: add a code, add a class in the correct error layer, map it in
  `ErrorMapper`, and document externally visible behavior.
- New repository: define a port in `logic/ports`, implement it in `data`, map
  rows to records, wrap persistence errors, bind it in the module container.
- New module: add a child container, module class, router, service, controller,
  and register the module in `Application`.
