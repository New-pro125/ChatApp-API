# AGENTS.md

Instructions for AI coding agents working in this repository. Read this file
before making changes, then read `README.md` for the public API and setup guide.

## Project snapshot

- Node 24, TypeScript 7.0.2, ESM (`"type": "module"`)
- Express 5 with Inversify 8 child containers
- Passport local, GitHub, Google, and OIDC SSO strategies
- PostgreSQL 18 through `pg`, Redis-backed sessions
- Argon2id password hashing
- Zod request validation, Pino logging, Biome linting/formatting
- No test suite. Verify with typecheck, lint, build, and targeted manual smoke tests.

## Commands

```bash
npm ci
docker compose up -d postgres redis
npm run db:migrate
npm run dev

npm run typecheck   # tsc --noEmit
npm run lint        # biome check
npm run check       # biome check --write
npm run build       # tsc + tsc-alias
npm run start       # run dist/index.js
```

Host ports: API `4000`, PostgreSQL `5434`, Redis `6381`, Adminer `8088`,
RedisInsight `5540`, Mailpit SMTP `1025`, Mailpit UI `8025`.

## Architecture

```text
src/
  app/                 Application lifecycle and HTTP assembly
  core/                Config, container, database, cache, logging, HTTP, errors, session
  modules/
    auth/              Auth feature module and child container
      data/            Repositories, hashers, email senders, token generation
      logic/           Entities, ports, services
      web/             Controllers, DTOs, routers, Passport strategies
    health/            Health feature module and child container
  types/               Ambient Express, session, environment, Passport declarations
```

- `AppContainer` is the root container. Each module creates a child container
  whose parent is the root container.
- Each HTTP request gets a request-scoped child container from
  `RequestScopeMiddleware`; it is disposed when the response closes.
- `Application` wires global middleware, modules, the 404 handler, and the
  global error handler in that order.
- `ApplicationRunner` owns process startup, signal handling, and shutdown.

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
- A successful password reset increments `users.session_version`, invalidating
  existing sessions.
- Reused or expired reset tokens are rejected.
- OAuth/OIDC accounts require a verified provider email and are linked to an
  existing user by verified email when possible.
- Password authentication alone never creates a session when MFA is enabled; it
  returns a short-lived, single-use challenge instead.
- OAuth/OIDC logins for MFA-enabled users follow the same challenge flow before
  a session is established. Browser callbacks keep the challenge in the
  session and redirect to `OAUTH_MFA_REDIRECT`.
- TOTP secrets are encrypted with AES-256-GCM through `MfaSecretCipher`.
  Challenge tokens and recovery codes are stored only as hashes.
- A TOTP time step is single-use; reject replays through
  `users.mfa_last_totp_step`.
- Enrollment, disable, and recovery-code regeneration go through
  `MfaService`; do not duplicate TOTP or recovery-code validation in
  controllers.
- Session cookies are configured through `SessionCookieOptions`; do not
  hand-build cookie options in controllers.
- Passport serialization uses `SessionPrincipal` with `sessionVersion`.

## Database and migrations

- The current repositories use hand-written SQL over a shared `pg.Pool`.
- Migrations use `node-pg-migrate` under `migrations/`.
- Drizzle is not adopted. Keep the existing `pg` repositories unless the task
  explicitly asks for Drizzle. Do not mix Drizzle and raw SQL without a written
  decision and a migration baseline.
- Every new repository method must map rows to domain records; do not return
  raw database rows from services.
- Wrap unique violations in `UniqueConstraintException`.
- Use transactions for multi-step writes and always release pooled clients.
- When adding a migration, use a new timestamped file; never edit an applied
  migration.

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

1. Run `npm run typecheck`, `npm run lint`, and `npm run build`.
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
