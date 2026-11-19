# Phase 2.4 Generic Media Uploads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a generic, reusable media upload pipeline that issues server-generated private S3 object keys and presigned PUT URLs, rechecks metadata and fail-closed ClamAV scans on finalize, and issues authenticated presigned GET URLs for clean objects.

**Architecture:** Add a `media` feature module as an `AppContainer` child, a `media_objects` Drizzle table, two core config groups (`MediaConfig`, `ClamAvConfig`), ports for object storage and virus scanning with S3/ClamAV adapters, and four documented routes under `/api/media`. The module owns the whole lifecycle; avatar, story, and message integrations stay out of scope and keep their existing placeholder keys.

**Tech Stack:** Node 24, TypeScript 7.0.2, ESM with `@/*` aliases and explicit `.js` relative imports, Express 5, Inversify 8 child containers, Drizzle ORM 0.45 with PostgreSQL 18, `@aws-sdk/client-s3` 3.1164.0 and `@aws-sdk/s3-request-presigner` 3.1164.0 (already installed), `net` + clamd `zINSTREAM`, Zod 4.6.7, Vitest 5.1 + Supertest, Biome 2.6.6.

**Spec:** `docs/superpowers/specs/2026-11-18-media-uploads-design.md` (commit `2b125e6`). Read the spec alongside this plan; the plan argues from it.

## Global Constraints

- Node `>=24`, TypeScript `7.0.2`, ESM (`"type": "module"`), `@/*` path aliases, explicit `.js` extensions on every relative ESM import.
- Biome: single quotes, semicolons, trailing commas, 2-space indent, 100-character line width, organized imports. Run `npm run check` to apply fixes.
- Prefer `unknown` over `any`; narrow explicitly. No `process.env` outside `EnvironmentReader`; `AppConfig` is the only configuration source.
- Every route goes through `DocumentedRouter` with a unique `module.action` operationId; the same Zod schema documents and validates input.
- All JSON responses use `ApiResponse`; controllers never call `res.json` directly. Domain/data layers never import Express types or HTTP status codes.
- Controllers are request-scoped and resolved from `req.container`; services and routers are singleton-scoped in the module child container.
- Repositories inject `CORE_TYPES.Db`, import tables from the schema barrel, use explicit column selections and mapper classes, and wrap database failures in `PersistenceException`.
- Private bucket only. Object keys are server-generated `media/<ownerUserId>/<mediaId>.<ext>`; client filenames never influence keys.
- Fail closed: `MEDIA_SCAN_REQUIRED` defaults to `true`; the only bypass is an explicit `MEDIA_SCAN_REQUIRED=false` from configuration, never a `NODE_ENV` check.
- Default maximum upload size is `MEDIA_MAX_BYTES=52428800` (50 MiB). Presigned PUT signs exact `Content-Type` and `Content-Length`; finalize rechecks S3 metadata.
- Never log or return bucket credentials, signed URLs, object bytes, scan signatures, private keys, or raw AWS/socket errors.
- `docs/superpowers/**/*.md` is ignored by `.gitignore`; plan/spec files require `git add -f`.
- Every task ends with its own commit and a long descriptive commit message.

## Review Focus

These are the inputs and failure modes the spec implies but no single task's happy-path test fully covers. Each line names the behavior a reasonable person expects, then pins a test to the owning task.

1. **Metadata substitution after presigning** — a client that signs `image/png` and uploads different bytes/content type must never get a `ready` object or download URL; expected `400 VALIDATION_ERROR` and a `failed` row. Pinned by `rejects a finalized upload whose S3 metadata does not match the ticket` in Task 10.
2. **Concurrent or repeated finalize** — two finalize calls on one `pending` row must produce at most one `ready` transition and one download URL; the loser gets `409 MEDIA_NOT_READY`, never a second hash or URL. Pinned by `allows only one winner when finalize races` in Task 10.
3. **Cross-user access leaking object keys** — a non-owner must get `404 NOT_FOUND` with no `objectKey`, `downloadUrl`, or `sha256` in the error body on GET, finalize, and DELETE. Pinned by `hides object keys and download URLs from non-owners` in Task 10.
4. **Hostile scanner output** — malformed clamd replies and overlong/pathological signatures must become `503 MEDIA_SCAN_UNAVAILABLE` (or a sanitized, truncated stored signature), never raw protocol text in logs or responses. Pinned by `parses clamd stream replies and rejects malformed responses` in Task 6 and `maps scanner failures to MEDIA_SCAN_UNAVAILABLE` in Task 8.
5. **Verified-email gate on every media route** — an unverified user must receive `403 EMAIL_NOT_VERIFIED` on upload, finalize, download, and delete, not just on creation. Pinned by `gates every media route with verified email` in Task 10.

## File Structure

```text
src/
  core/
    config/app.config.ts                       (modify: MediaConfig, ClamAvConfig, AppConfig fields)
    errors/error-code.ts                       (modify: three media codes)
    errors/domain.error.ts                     (modify: four media domain exceptions)
    errors/repository.error.ts                 (modify: ObjectStoreException, VirusScannerException)
    errors/error-mapper.ts                     (modify: status mappings)
    database/schema/media.schema.ts            (create: media_objects table)
    database/schema/index.ts                   (modify: export media schema)
    http/middleware/rate-limit.ts              (modify: MediaRateLimiter)
  modules/media/
    media.types.ts                             (create: DI symbols)
    media.container.ts                         (create: child container bindings)
    media.module.ts                            (create: AppModule, exposes mediaContainer)
    data/
      media-object.mapper.ts                   (create: selection + mapper)
      postgres-media-object.repository.ts      (create: Drizzle repository)
      s3-object.store.ts                       (create: S3 adapter)
      clamav-virus.scanner.ts                  (create: clamd INSTREAM adapter)
    logic/
      entities/media-object-record.ts          (create: record + MediaStatus)
      ports/media-object.repository.ts         (create: persistence port)
      ports/object-store.ts                    (create: storage port + ticket types)
      ports/virus-scanner.ts                   (create: scanner port + ScanResult)
      media-object-key.factory.ts              (create: server-side key construction)
      media-presign.options.ts                 (create: pure presign option builder)
      clamav-protocol.ts                       (create: framing + response parsing)
      media.service.ts                         (create: lifecycle orchestration)
    web/
      dto/media.schemas.ts                     (create: Zod request/response schemas)
      dto/media.openapi.ts                     (create: route contracts)
      media.controller.ts                      (create: four handlers)
      routes/media.router.ts                   (create: documented routes)
  app/application.ts                           (modify: register MediaModule)
tests/
  setup.ts                                     (modify: media env defaults)
  helpers/test-app.ts                          (modify: truncate media_objects)
  fixtures/media.fixture.ts                    (create: fake scanner + S3 PUT helper)
  unit/media-config.test.ts                    (create)
  unit/media-errors.test.ts                    (create)
  unit/media-object-key.test.ts                (create)
  unit/media-presign-options.test.ts           (create)
  unit/clamav-protocol.test.ts                 (create)
  unit/clamav-scanner.test.ts                  (create)
  unit/media-service.test.ts                   (create)
  integration/media/media-schema.test.ts       (create)
  integration/media/media-repository.test.ts   (create)
  integration/media/media-api.test.ts          (create)
.env.example                                   (modify: media + ClamAV settings)
README.md                                      (modify: API, config, prerequisites, security)
drizzle/0010_<generated>.sql                   (generate: media_objects migration)
```

Task boundaries are drawn so each task produces a self-contained, testable deliverable: config, errors, schema, logic primitives, adapters, repository, service, HTTP wiring, integration tests, and docs/verification.

---

### Task 1: Media and ClamAV configuration

**Files:**
- Modify: `src/core/config/app.config.ts`
- Modify: `tests/setup.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `EnvironmentReader` (`readRequired`, `readString`, `readNumber`, `readBoolean`).
- Produces: `MediaConfig` and `ClamAvConfig` classes; `AppConfig.media: MediaConfig`, `AppConfig.clamAv: ClamAvConfig`.

- [ ] **Step 1: Write the failing config test**

Create `tests/unit/media-config.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '@/core/config/app.config.js';

const ENV_KEYS = [
  'MEDIA_BUCKET', 'MEDIA_ACCESS_KEY_ID', 'MEDIA_SECRET_ACCESS_KEY', 'MEDIA_ENDPOINT',
  'MEDIA_REGION', 'MEDIA_FORCE_PATH_STYLE', 'MEDIA_MAX_BYTES',
  'MEDIA_ALLOWED_CONTENT_TYPES', 'MEDIA_PRESIGN_TTL_SECONDS', 'MEDIA_SCAN_REQUIRED',
  'CLAMAV_HOST', 'CLAMAV_PORT', 'CLAMAV_TIMEOUT_MS',
] as const;

const snapshot = new Map<string, string | undefined>();

describe('MediaConfig', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) snapshot.set(key, process.env[key]);
  });

  afterEach(() => {
    for (const [key, value] of snapshot) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('fails fast when bucket or credentials are missing', async () => {
    delete process.env.MEDIA_BUCKET;
    const { AppConfig: Cfg } = await import('@/core/config/app.config.js');
    expect(() => new Cfg()).toThrow('Missing required environment variable: MEDIA_BUCKET');
  });

  it('uses the approved defaults', async () => {
    process.env.MEDIA_BUCKET = 'messenger-media';
    process.env.MEDIA_ACCESS_KEY_ID = 'minioadmin';
    process.env.MEDIA_SECRET_ACCESS_KEY = 'minioadmin';
    const { AppConfig: Cfg } = await import('@/core/config/app.config.js');
    const config = new Cfg() as AppConfig;
    expect(config.media.maxBytes).toBe(52_428_800);
    expect(config.media.scanRequired).toBe(true);
    expect(config.media.presignTtlSeconds).toBe(300);
    expect(config.media.forcePathStyle).toBe(true);
    expect(config.media.allowedContentTypes).toContain('image/png');
    expect(config.media.allowedContentTypes).toContain('application/octet-stream');
    expect(config.clamAv.host).toBe('127.0.0.1');
    expect(config.clamAv.port).toBe(3310);
    expect(config.clamAv.timeoutMs).toBe(10_000);
  });

  it('parses an explicit bypass and CSV allowlist', async () => {
    process.env.MEDIA_BUCKET = 'messenger-media';
    process.env.MEDIA_ACCESS_KEY_ID = 'minioadmin';
    process.env.MEDIA_SECRET_ACCESS_KEY = 'minioadmin';
    process.env.MEDIA_SCAN_REQUIRED = 'false';
    process.env.MEDIA_ALLOWED_CONTENT_TYPES = 'image/png, application/pdf';
    const { AppConfig: Cfg } = await import('@/core/config/app.config.js');
    const config = new Cfg() as AppConfig;
    expect(config.media.scanRequired).toBe(false);
    expect(config.media.allowedContentTypes).toEqual(['image/png', 'application/pdf']);
  });

  it('rejects a non-positive size cap and an empty allowlist', async () => {
    process.env.MEDIA_BUCKET = 'messenger-media';
    process.env.MEDIA_ACCESS_KEY_ID = 'minioadmin';
    process.env.MEDIA_SECRET_ACCESS_KEY = 'minioadmin';
    process.env.MEDIA_MAX_BYTES = '0';
    const { AppConfig: Cfg } = await import('@/core/config/app.config.js');
    expect(() => new Cfg()).toThrow('MEDIA_MAX_BYTES must be a positive integer');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/media-config.test.ts`
Expected: FAIL — `MediaConfig` and `AppConfig.media` do not exist; the missing-bucket case does not throw.

- [ ] **Step 3: Add the config classes and wire them into `AppConfig`**

In `src/core/config/app.config.ts`, add after `StoryConfig`:

```ts
const DEFAULT_MEDIA_CONTENT_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'audio/mpeg', 'application/pdf', 'application/zip',
  'application/octet-stream',
] as const;

export class MediaConfig {
  constructor(
    readonly bucket: string,
    readonly region: string,
    readonly endpoint: string,
    readonly accessKeyId: string,
    readonly secretAccessKey: string,
    readonly forcePathStyle: boolean,
    readonly maxBytes: number,
    readonly allowedContentTypes: readonly string[],
    readonly presignTtlSeconds: number,
    readonly scanRequired: boolean,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('MEDIA_MAX_BYTES must be a positive integer');
    }
    if (!Number.isInteger(presignTtlSeconds) || presignTtlSeconds <= 0) {
      throw new Error('MEDIA_PRESIGN_TTL_SECONDS must be a positive integer');
    }
    if (allowedContentTypes.length === 0) {
      throw new Error('MEDIA_ALLOWED_CONTENT_TYPES must contain at least one type');
    }
  }
}

export class ClamAvConfig {
  constructor(
    readonly host: string,
    readonly port: number,
    readonly timeoutMs: number,
  ) {
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error('CLAMAV_PORT must be a valid TCP port');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error('CLAMAV_TIMEOUT_MS must be a positive integer');
    }
  }
}
```

Add fields to `AppConfig` next to `stories`:

```ts
  readonly media: MediaConfig;
  readonly clamAv: ClamAvConfig;
```

Add construction next to `this.stories = ...`:

```ts
    this.media = new MediaConfig(
      env.readRequired('MEDIA_BUCKET'),
      env.readString('MEDIA_REGION', 'us-east-1'),
      env.readString('MEDIA_ENDPOINT', 'http://localhost:9000'),
      env.readRequired('MEDIA_ACCESS_KEY_ID'),
      env.readRequired('MEDIA_SECRET_ACCESS_KEY'),
      env.readBoolean('MEDIA_FORCE_PATH_STYLE', true),
      env.readNumber('MEDIA_MAX_BYTES', 52_428_800),
      this.parseCsv(env.readString('MEDIA_ALLOWED_CONTENT_TYPES', DEFAULT_MEDIA_CONTENT_TYPES.join(','))),
      env.readNumber('MEDIA_PRESIGN_TTL_SECONDS', 300),
      env.readBoolean('MEDIA_SCAN_REQUIRED', true),
    );

    this.clamAv = new ClamAvConfig(
      env.readString('CLAMAV_HOST', '127.0.0.1'),
      env.readNumber('CLAMAV_PORT', 3310),
      env.readNumber('CLAMAV_TIMEOUT_MS', 10_000),
    );
```

Add a private method beside `parseOrigins`:

```ts
  private parseCsv(raw: string): readonly string[] {
    const seen = new Set<string>();
    const values: string[] = [];

    for (const part of raw.split(',')) {
      const value = part.trim();

      if (value.length > 0 && !seen.has(value)) {
        seen.add(value);
        values.push(value);
      }
    }

    return values;
  }
```

- [ ] **Step 4: Set test defaults and document the variables**

Append to `tests/setup.ts`:

```ts
process.env.MEDIA_BUCKET = process.env.MEDIA_BUCKET || 'messenger-media';
process.env.MEDIA_ACCESS_KEY_ID = process.env.MEDIA_ACCESS_KEY_ID || 'minioadmin';
process.env.MEDIA_SECRET_ACCESS_KEY = process.env.MEDIA_SECRET_ACCESS_KEY || 'minioadmin';
process.env.MEDIA_ENDPOINT = process.env.MEDIA_ENDPOINT || 'http://localhost:9000';
```

Append to `.env.example` after the MinIO block:

```dotenv
# Generic media uploads (API configuration for the S3-compatible bucket above)
MEDIA_BUCKET=messenger-media
MEDIA_REGION=us-east-1
# Browser-reachable endpoint used to build presigned URLs (MinIO on the host)
MEDIA_ENDPOINT=http://localhost:9000
MEDIA_ACCESS_KEY_ID=minioadmin
MEDIA_SECRET_ACCESS_KEY=minioadmin
MEDIA_FORCE_PATH_STYLE=true
MEDIA_MAX_BYTES=52428800
MEDIA_ALLOWED_CONTENT_TYPES=image/jpeg,image/png,image/gif,image/webp,video/mp4,audio/mpeg,application/pdf,application/zip,application/octet-stream
MEDIA_PRESIGN_TTL_SECONDS=300
# Fail closed by default. Only set false for local development or tests.
MEDIA_SCAN_REQUIRED=true

# ClamAV daemon (start with `docker compose --profile scan up -d`)
CLAMAV_HOST=127.0.0.1
CLAMAV_PORT=3310
CLAMAV_TIMEOUT_MS=10000
```

Also add these values to the local gitignored `.env` so a live smoke test can boot; use the same values as above.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/unit/media-config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/core/config/app.config.ts tests/setup.ts .env.example tests/unit/media-config.test.ts
git commit -m "feat(config): add validated media and ClamAV settings" -m "Add MediaConfig and ClamAvConfig groups so the generic upload pipeline can reach private S3 storage and a ClamAV daemon without reading process.env outside EnvironmentReader. Fail fast on a missing bucket or credentials, cap uploads at 52428800 bytes by default, parse a configurable content-type allowlist, and default MEDIA_SCAN_REQUIRED to true so an unscanned object can never become downloadable by accident. Document every new variable in .env.example and seed test defaults so the existing suite keeps booting."
```

---

### Task 2: Media error codes and exceptions

**Files:**
- Modify: `src/core/errors/error-code.ts`
- Modify: `src/core/errors/domain.error.ts`
- Modify: `src/core/errors/repository.error.ts`
- Modify: `src/core/errors/error-mapper.ts`
- Test: `tests/unit/media-errors.test.ts`

**Interfaces:**
- Consumes: `AppError`, `DomainException`, `ErrorCode`, `ErrorMapper`.
- Produces: `InvalidMediaInputException`, `MediaNotFoundException`, `MediaNotReadyException`, `MediaInfectedException`, `MediaScanUnavailableException`, `ObjectStoreException`, `VirusScannerException`.

- [ ] **Step 1: Write the failing error-mapping test**

Create `tests/unit/media-errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '@/core/config/app.config.js';
import {
  InvalidMediaInputException,
  MediaInfectedException,
  MediaNotReadyException,
  MediaNotFoundException,
  MediaScanUnavailableException,
} from '@/core/errors/domain.error.js';
import { ErrorCode } from '@/core/errors/error-code.js';
import { ErrorMapper } from '@/core/errors/error-mapper.js';
import { ObjectStoreException, VirusScannerException } from '@/core/errors/repository.error.js';

const mapper = new ErrorMapper({ nodeEnv: 'test' } as AppConfig);

describe('Media error mapping', () => {
  it.each([
    [new InvalidMediaInputException(), 400, ErrorCode.VALIDATION_ERROR],
    [new MediaNotFoundException(), 404, ErrorCode.NOT_FOUND],
    [new MediaNotReadyException(), 409, ErrorCode.MEDIA_NOT_READY],
    [new MediaInfectedException(), 422, ErrorCode.MEDIA_INFECTED],
    [new MediaScanUnavailableException(), 503, ErrorCode.MEDIA_SCAN_UNAVAILABLE],
  ])('maps %s', (error, status, code) => {
    expect(mapper.map(error)).toMatchObject({ status, code });
  });

  it('sanitizes adapter failures as internal errors', () => {
    expect(mapper.map(new ObjectStoreException('secret bucket detail'))).toMatchObject({
      status: 500,
      code: ErrorCode.INTERNAL_ERROR,
    });
    expect(mapper.map(new VirusScannerException('socket detail'))).toMatchObject({
      status: 500,
      code: ErrorCode.INTERNAL_ERROR,
    });
  });

  it('never exposes cause details in the public message', () => {
    const mapped = mapper.map(new MediaScanUnavailableException(undefined, { cause: 'secret' }));
    expect(mapped.message).not.toContain('secret');
    expect(mapped.details).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/media-errors.test.ts`
Expected: FAIL — named exports do not exist.

- [ ] **Step 3: Add codes, exceptions, and mappings**

In `src/core/errors/error-code.ts`, insert before `INTERNAL_ERROR`:

```ts
  MEDIA_SCAN_UNAVAILABLE: 'MEDIA_SCAN_UNAVAILABLE',
  MEDIA_INFECTED: 'MEDIA_INFECTED',
  MEDIA_NOT_READY: 'MEDIA_NOT_READY',
```

Append to `src/core/errors/domain.error.ts`:

```ts
export class InvalidMediaInputException extends DomainException {
  readonly code = ErrorCode.VALIDATION_ERROR;

  constructor(message = 'Invalid media upload', options?: AppErrorOptions) {
    super(message, options);
  }
}

export class MediaNotFoundException extends DomainException {
  readonly code = ErrorCode.NOT_FOUND;

  constructor(message = 'Media object not found', options?: AppErrorOptions) {
    super(message, options);
  }
}

export class MediaNotReadyException extends DomainException {
  readonly code = ErrorCode.MEDIA_NOT_READY;

  constructor(message = 'Media object is not ready for download', options?: AppErrorOptions) {
    super(message, options);
  }
}

export class MediaInfectedException extends DomainException {
  readonly code = ErrorCode.MEDIA_INFECTED;

  constructor(message = 'The uploaded file is infected', options?: AppErrorOptions) {
    super(message, options);
  }
}

export class MediaScanUnavailableException extends DomainException {
  readonly code = ErrorCode.MEDIA_SCAN_UNAVAILABLE;

  constructor(
    message = 'Virus scanning is temporarily unavailable',
    options?: AppErrorOptions,
  ) {
    super(message, options);
  }
}
```

Append to `src/core/errors/repository.error.ts`:

```ts
/** Failure talking to S3-compatible object storage. */
export class ObjectStoreException extends RepositoryException {
  constructor(message = 'Object storage operation failed', options?: AppErrorOptions) {
    super(message, options);
  }
}

/** Failure talking to the ClamAV daemon or parsing its protocol. */
export class VirusScannerException extends RepositoryException {
  constructor(message = 'Virus scan failed', options?: AppErrorOptions) {
    super(message, options);
  }
}
```

In `src/core/errors/error-mapper.ts`, add to `STATUS_BY_DOMAIN_CODE` after the E2EE entries:

```ts
  [ErrorCode.MEDIA_SCAN_UNAVAILABLE]: 503,
  [ErrorCode.MEDIA_INFECTED]: 422,
  [ErrorCode.MEDIA_NOT_READY]: 409,
```

No `details` are attached to these exceptions, so signed URLs, scanner signatures, and adapter causes cannot leak into the response.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/media-errors.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/errors/error-code.ts src/core/errors/domain.error.ts src/core/errors/repository.error.ts src/core/errors/error-mapper.ts tests/unit/media-errors.test.ts
git commit -m "feat(errors): add layered media error contracts" -m "Introduce transport-neutral media domain exceptions for invalid uploads, missing objects, non-ready state, infected files, and scanner outages, and map them in ErrorMapper to 400/404/409/422/503. Add ObjectStoreException and VirusScannerException so S3 and clamd failures are wrapped at the adapter boundary instead of escaping as raw SDK or socket errors. Keep signatures, signed URLs, and causes out of error details so no sensitive scan or storage data reaches clients or logs."
```

---

### Task 3: `media_objects` schema, migration, and schema constraints

**Files:**
- Create: `src/core/database/schema/media.schema.ts`
- Modify: `src/core/database/schema/index.ts`
- Modify: `tests/helpers/test-app.ts`
- Create: `tests/integration/media/media-schema.test.ts`
- Generated: `drizzle/0010_<name>.sql` (exact name from `npm run db:generate`)

**Interfaces:**
- Consumes: `users` table from `auth.schema.js`, Drizzle `pgTable` helpers.
- Produces: `mediaObjects` table exported from the schema barrel; `media_objects` included in test truncation.

- [ ] **Step 1: Write the failing schema test**

Create `tests/integration/media/media-schema.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { TestApp } from '../../helpers/test-app.js';

describe('media_objects schema', () => {
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
  });

  const insert = (ownerId: string, overrides: Record<string, unknown> = {}) => {
    const values = {
      owner_user_id: ownerId,
      object_key: `media/${ownerId}/01920000-0000-7000-8000-000000000001.png`,
      content_type: 'image/png',
      size_bytes: 12,
      status: 'pending',
      ...overrides,
    };
    const columns = Object.keys(values);
    const placeholders = columns.map((_, index) => `$${index + 1}`);
    return app.pool.query(
      `INSERT INTO media_objects (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
      columns.map((column) => values[column as keyof typeof values]),
    );
  };

  it('rejects an unknown status and a non-positive size', async () => {
    const user = await auth.createUser({ email: 'media-schema-status@example.com' });

    await expect(insert(user.id, { status: 'done' })).rejects.toThrow(/media_objects_status_check/);
    await expect(insert(user.id, { size_bytes: 0 })).rejects.toThrow(/media_objects_size_bytes_check/);
  });

  it('rejects a malformed sha256 and an overlong object key', async () => {
    const user = await auth.createUser({ email: 'media-schema-hash@example.com' });

    await expect(insert(user.id, { sha256: 'not-a-hash' })).rejects.toThrow(/media_objects_sha256_check/);
    await expect(insert(user.id, { object_key: 'x'.repeat(513) })).rejects.toThrow(
      /media_objects_object_key_length_check/,
    );
  });

  it('enforces unique object keys and cascades owner deletion', async () => {
    const user = await auth.createUser({ email: 'media-schema-owner@example.com' });
    const key = `media/${user.id}/01920000-0000-7000-8000-000000000002.png`;

    await insert(user.id, { object_key: key });
    await expect(insert(user.id, { object_key: key })).rejects.toThrow(/unique/);

    await app.pool.query('DELETE FROM users WHERE id = $1', [user.id]);
    const remaining = await app.pool.query('SELECT id FROM media_objects WHERE owner_user_id = $1', [
      user.id,
    ]);
    expect(remaining.rowCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/media/media-schema.test.ts`
Expected: FAIL — `relation "media_objects" does not exist` (Postgres/redis services must be running).

- [ ] **Step 3: Create the schema and export it**

Create `src/core/database/schema/media.schema.ts`:

```ts
import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from '@/core/database/schema/auth.schema.js';

/**
 * Generic media objects owned by the media module.
 *
 * A row is created with `pending` status before the client uploads bytes. Only
 * finalize may move it to `ready` or `quarantined`; `failed` is reserved for
 * unrecoverable metadata/storage errors. Drizzle types never leave the data
 * layer — repositories map rows to `MediaObjectRecord`.
 */
export const mediaObjects = pgTable(
  'media_objects',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    objectKey: text('object_key').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256'),
    status: text('status').notNull().default('pending'),
    scanSignature: text('scan_signature'),
    scanError: text('scan_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('media_objects_object_key_unique').on(table.objectKey),
    index('media_objects_owner_status_index').on(table.ownerUserId, table.status),
    index('media_objects_owner_created_at_index').on(
      table.ownerUserId,
      table.createdAt.desc(),
      table.id,
    ),
    check(
      'media_objects_status_check',
      sql`${table.status} in ('pending', 'ready', 'quarantined', 'failed')`,
    ),
    check(
      'media_objects_object_key_length_check',
      sql`char_length(${table.objectKey}) between 1 and 512`,
    ),
    check(
      'media_objects_content_type_length_check',
      sql`char_length(${table.contentType}) between 1 and 128`,
    ),
    check('media_objects_size_bytes_check', sql`${table.sizeBytes} > 0`),
    check(
      'media_objects_sha256_check',
      sql`${table.sha256} is null or ${table.sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'media_objects_scan_signature_length_check',
      sql`${table.scanSignature} is null or char_length(${table.scanSignature}) between 1 and 512`,
    ),
    check(
      'media_objects_scan_error_length_check',
      sql`${table.scanError} is null or char_length(${table.scanError}) between 1 and 512`,
    ),
  ],
);
```

Add to `src/core/database/schema/index.ts`:

```ts
export * from '@/core/database/schema/media.schema.js';
```

- [ ] **Step 4: Include media rows in test cleanup**

In `tests/helpers/test-app.ts`, add `media_objects,` before `messages,` in the `TRUNCATE TABLE` list.

- [ ] **Step 5: Generate and review the migration**

Run: `npm run db:generate`
Expected: a new `drizzle/0010_*.sql` file. Open it and confirm it creates `media_objects` with the named constraints above and no destructive changes to other tables. Then apply it:

Run: `npm run db:migrate && npm run db:check`
Expected: migration applies; `db:check` reports `Everything's fine 🐶🔥`.

Never edit an applied migration; generate a new one if a correction is needed.

- [ ] **Step 6: Run the schema test to verify it passes**

Run: `npx vitest run tests/integration/media/media-schema.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/core/database/schema/media.schema.ts src/core/database/schema/index.ts tests/helpers/test-app.ts tests/integration/media/media-schema.test.ts drizzle/0010_*.sql
git commit -m "feat(db): add media_objects table and migration" -m "Create the media_objects table that backs the generic upload pipeline with a uuidv7 primary key, owner cascade, server-generated unique object key, content type, byte size, nullable hash and scan details, and status transitions pending/ready/quarantined/failed. Add explicitly named checks and indexes for status, key/hash/signature shapes, positive size, and owner lookups, export the table from the Drizzle barrel, and include it in test truncation. Generate and review the SQL migration rather than hand-editing schema history."
```

---

### Task 4: Media domain record, ports, and pure factories

**Files:**
- Create: `src/modules/media/logic/entities/media-object-record.ts`
- Create: `src/modules/media/logic/ports/media-object.repository.ts`
- Create: `src/modules/media/logic/ports/object-store.ts`
- Create: `src/modules/media/logic/ports/virus-scanner.ts`
- Create: `src/modules/media/logic/media-object-key.factory.ts`
- Create: `src/modules/media/logic/media-presign.options.ts`
- Create: `src/modules/media/logic/clamav-protocol.ts`
- Test: `tests/unit/media-object-key.test.ts`
- Test: `tests/unit/media-presign-options.test.ts`
- Test: `tests/unit/clamav-protocol.test.ts`

**Interfaces:**
- Consumes: `InvalidMediaInputException`, `VirusScannerException` from core errors.
- Produces: `MediaObjectRecord`, `MediaStatus`, `MediaObjectRepository`, `ObjectStore`, `VirusScanner`, `PresignedUpload`, `PresignedDownload`, `ObjectMetadata`, `ScanResult`, `MediaObjectKeyFactory`, `MediaPresignOptions`, `ClamAvProtocol`.

- [ ] **Step 1: Write failing unit tests for the pure factories**

Create `tests/unit/media-object-key.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { InvalidMediaInputException } from '@/core/errors/domain.error.js';
import { MediaObjectKeyFactory } from '@/modules/media/logic/media-object-key.factory.js';

const factory = new MediaObjectKeyFactory();

describe('MediaObjectKeyFactory', () => {
  it('builds an owner-scoped key from the generated id and allowed type', () => {
    expect(factory.build('01920000-0000-7000-8000-0000000000aa', '01920000-0000-7000-8000-0000000000bb', 'image/png'))
      .toBe('media/01920000-0000-7000-8000-0000000000aa/01920000-0000-7000-8000-0000000000bb.png');
    expect(factory.build('owner', 'id', 'application/pdf')).toBe('media/owner/id.pdf');
    expect(factory.build('owner', 'id', 'application/octet-stream')).toBe('media/owner/id.bin');
  });

  it('never accepts a type outside the extension map', () => {
    expect(() => factory.build('owner', 'id', 'image/svg+xml')).toThrow(InvalidMediaInputException);
    expect(() => factory.build('owner', 'id', 'image/png; charset=utf-8')).toThrow(
      InvalidMediaInputException,
    );
  });
});
```

Create `tests/unit/media-presign-options.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MediaPresignOptions } from '@/modules/media/logic/media-presign.options.js';

const options = new MediaPresignOptions();

describe('MediaPresignOptions', () => {
  it('builds exact PUT headers and the configured TTL', () => {
    const before = Date.now();
    const put = options.put('bucket', 'media/o/i.png', 'image/png', 1234, 300);
    expect(put).toMatchObject({
      bucket: 'bucket',
      key: 'media/o/i.png',
      contentType: 'image/png',
      sizeBytes: 1234,
      expiresIn: 300,
      headers: { 'Content-Type': 'image/png', 'Content-Length': '1234' },
    });
    expect(put.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 300_000);
  });

  it('builds a GET option without upload headers', () => {
    const get = options.get('bucket', 'media/o/i.png', 60);
    expect(get).toMatchObject({ bucket: 'bucket', key: 'media/o/i.png', expiresIn: 60 });
    expect(get).not.toHaveProperty('headers');
  });
});
```

Create `tests/unit/clamav-protocol.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { VirusScannerException } from '@/core/errors/repository.error.js';
import { ClamAvProtocol } from '@/modules/media/logic/clamav-protocol.js';

const protocol = new ClamAvProtocol();

describe('ClamAvProtocol', () => {
  it('frames chunks with a big-endian length and terminates with zero', () => {
    const frame = protocol.frame(Buffer.from('abc'));
    expect(frame.subarray(0, 4).readUInt32BE(0)).toBe(3);
    expect(frame.subarray(4).toString()).toBe('abc');
    expect(protocol.terminator()).toEqual(Buffer.alloc(4));
  });

  it('parses NUL-terminated clamd stream replies', () => {
    expect(protocol.parseResponse('stream: OK\0')).toEqual({ verdict: 'clean' });
    expect(protocol.parseResponse('stream: Eicar-Test-Signature FOUND\0')).toEqual({
      verdict: 'infected',
      signature: 'Eicar-Test-Signature',
    });
    expect(protocol.parseResponse('stream: Phishing.URL (Heuristic Variant) FOUND\0')).toEqual({
      verdict: 'infected',
      signature: 'Phishing.URL (Heuristic Variant)',
    });
  });

  it('truncates hostile signatures and rejects malformed responses', () => {
    const long = protocol.parseResponse(`stream: ${'x'.repeat(900)} FOUND\0`);
    expect(long).toMatchObject({ verdict: 'infected' });
    if (long.verdict === 'infected') expect(long.signature).toHaveLength(512);
    for (const malformed of ['OK\0', 'stream: OK', 'ERROR broken\0', 'stream: FOUND\0']) {
      expect(() => protocol.parseResponse(malformed)).toThrow(VirusScannerException);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/media-object-key.test.ts tests/unit/media-presign-options.test.ts tests/unit/clamav-protocol.test.ts`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Create the entity and ports**

Create `src/modules/media/logic/entities/media-object-record.ts`:

```ts
export const MEDIA_STATUSES = ['pending', 'ready', 'quarantined', 'failed'] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

/** A server-owned upload lifecycle record. Drizzle types never cross this boundary. */
export class MediaObjectRecord {
  constructor(
    readonly id: string,
    readonly ownerUserId: string,
    readonly objectKey: string,
    readonly contentType: string,
    readonly sizeBytes: number,
    readonly sha256: string | null,
    readonly status: MediaStatus,
    readonly scanSignature: string | null,
    readonly scanError: string | null,
    readonly createdAt: Date,
    readonly updatedAt: Date,
    readonly finalizedAt: Date | null,
  ) {}
}
```

Create `src/modules/media/logic/ports/media-object.repository.ts`:

```ts
import type { MediaObjectRecord } from '@/modules/media/logic/entities/media-object-record.js';

export interface CreateMediaObjectInput {
  ownerUserId: string;
  contentType: string;
  sizeBytes: number;
}

export interface MediaObjectRepository {
  create(input: CreateMediaObjectInput): Promise<MediaObjectRecord>;
  findOwned(id: string, ownerUserId: string): Promise<MediaObjectRecord | null>;
  transitionToReady(
    id: string,
    ownerUserId: string,
    sha256: string | null,
  ): Promise<MediaObjectRecord | null>;
  transitionToQuarantined(
    id: string,
    ownerUserId: string,
    signature: string,
    error: string | null,
  ): Promise<MediaObjectRecord | null>;
  markFailed(id: string, ownerUserId: string, error: string): Promise<MediaObjectRecord | null>;
  deleteOwned(id: string, ownerUserId: string): Promise<boolean>;
}
```

Create `src/modules/media/logic/ports/object-store.ts`:

```ts
import type { Readable } from 'node:stream';

export interface PresignedUpload {
  url: string;
  headers: { 'Content-Type': string; 'Content-Length': string };
  expiresAt: Date;
}

export interface PresignedDownload {
  url: string;
  expiresAt: Date;
}

export interface ObjectMetadata {
  contentType: string;
  sizeBytes: number;
}

export interface ObjectStore {
  presignPut(objectKey: string, contentType: string, sizeBytes: number): Promise<PresignedUpload>;
  presignGet(objectKey: string): Promise<PresignedDownload>;
  head(objectKey: string): Promise<ObjectMetadata | null>;
  getStream(objectKey: string): Promise<Readable>;
  delete(objectKey: string): Promise<void>;
}
```

Create `src/modules/media/logic/ports/virus-scanner.ts`:

```ts
import type { Readable } from 'node:stream';

export type ScanResult =
  | { verdict: 'clean' }
  | { verdict: 'infected'; signature: string };

export interface VirusScanner {
  scan(stream: Readable): Promise<ScanResult>;
}
```

- [ ] **Step 4: Create the pure factories**

Create `src/modules/media/logic/media-object-key.factory.ts`:

```ts
import { injectable } from 'inversify';
import { InvalidMediaInputException } from '@/core/errors/domain.error.js';

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/octet-stream': 'bin',
};

/** Derives private object keys only from server-owned identifiers and an allowed type. */
@injectable()
export class MediaObjectKeyFactory {
  build(ownerUserId: string, mediaId: string, contentType: string): string {
    const extension = EXTENSIONS[contentType];

    if (extension === undefined) {
      throw new InvalidMediaInputException(`Unsupported media content type: ${contentType}`);
    }

    return `media/${ownerUserId}/${mediaId}.${extension}`;
  }
}
```

Create `src/modules/media/logic/media-presign.options.ts`:

```ts
import { injectable } from 'inversify';

export interface PutPresignOptions {
  bucket: string;
  key: string;
  contentType: string;
  sizeBytes: number;
  expiresIn: number;
  headers: { 'Content-Type': string; 'Content-Length': string };
  expiresAt: Date;
}

export interface GetPresignOptions {
  bucket: string;
  key: string;
  expiresIn: number;
  expiresAt: Date;
}

/** Pure option construction so exact headers and TTLs can be unit tested offline. */
@injectable()
export class MediaPresignOptions {
  put(
    bucket: string,
    key: string,
    contentType: string,
    sizeBytes: number,
    expiresIn: number,
  ): PutPresignOptions {
    return {
      bucket,
      key,
      contentType,
      sizeBytes,
      expiresIn,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(sizeBytes),
      },
      expiresAt: new Date(Date.now() + expiresIn * 1_000),
    };
  }

  get(bucket: string, key: string, expiresIn: number): GetPresignOptions {
    return {
      bucket,
      key,
      expiresIn,
      expiresAt: new Date(Date.now() + expiresIn * 1_000),
    };
  }
}
```

Create `src/modules/media/logic/clamav-protocol.ts`:

```ts
import { injectable } from 'inversify';
import { VirusScannerException } from '@/core/errors/repository.error.js';
import type { ScanResult } from '@/modules/media/logic/ports/virus-scanner.js';

const MAX_SIGNATURE_LENGTH = 512;

/** Encodes and decodes clamd INSTREAM framing without needing a live daemon. */
@injectable()
export class ClamAvProtocol {
  frame(chunk: Buffer): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(chunk.length, 0);

    return Buffer.concat([length, chunk]);
  }

  terminator(): Buffer {
    return Buffer.alloc(4);
  }

  parseResponse(response: string): ScanResult {
    const prefix = 'stream: ';
    const foundSuffix = ' FOUND';

    if (!response.endsWith('\0')) {
      throw new VirusScannerException('Unexpected ClamAV response');
    }

    const text = response.slice(0, -1);
    if (!text.startsWith(prefix)) {
      throw new VirusScannerException('Unexpected ClamAV response');
    }

    const verdict = text.slice(prefix.length);
    if (verdict === 'OK') {
      return { verdict: 'clean' };
    }

    if (verdict.endsWith(foundSuffix)) {
      const signature = verdict.slice(0, -foundSuffix.length);

      if (signature.length > 0) {
        return { verdict: 'infected', signature: signature.slice(0, MAX_SIGNATURE_LENGTH) };
      }
    }

    throw new VirusScannerException('Unexpected ClamAV response');
  }
}
```

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `npx vitest run tests/unit/media-object-key.test.ts tests/unit/media-presign-options.test.ts tests/unit/clamav-protocol.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add src/modules/media/logic tests/unit/media-object-key.test.ts tests/unit/media-presign-options.test.ts tests/unit/clamav-protocol.test.ts
git commit -m "feat(media): define domain record, ports, and pure helpers" -m "Establish the media module's logic layer with a transport-neutral MediaObjectRecord, a repository port whose transitions are conditional on pending status, and object-store and virus-scanner ports. Add injectable pure helpers that build owner-scoped object keys from server-generated ids and an exact content-type map, construct presigned PUT headers and expiries, and frame/parse clamd INSTREAM protocol messages. Unit-test the helpers offline so key injection, header substitution, and hostile scanner output are pinned before any adapter or HTTP code exists."
```

---

### Task 5: S3 object-store adapter

**Files:**
- Create: `src/modules/media/data/s3-object.store.ts`
- Create: `src/modules/media/media.types.ts` (first symbols; extended in Task 9)
- Test: covered by Task 5 pure-option tests already added in Task 4; live behaviour is verified in Task 10.

**Interfaces:**
- Consumes: `AppConfig.media`, `MediaPresignOptions`, `ObjectStore`.
- Produces: `S3ObjectStore`, `MEDIA_TYPES.ObjectStore`, `MEDIA_TYPES.MediaPresignOptions`.

> The spec sketches `getStream` as synchronous. Because AWS SDK v3 sends commands asynchronously, this plan pins it as `Promise<Readable>`; that is the only interface adjustment from the spec.

- [ ] **Step 1: Create the DI symbols the adapter needs**

Create `src/modules/media/media.types.ts`:

```ts
export const MEDIA_TYPES = {
  MediaObjectRepository: Symbol.for('Media.MediaObjectRepository'),
  ObjectStore: Symbol.for('Media.ObjectStore'),
  VirusScanner: Symbol.for('Media.VirusScanner'),
  MediaObjectKeyFactory: Symbol.for('Media.MediaObjectKeyFactory'),
  MediaPresignOptions: Symbol.for('Media.MediaPresignOptions'),
  ClamAvProtocol: Symbol.for('Media.ClamAvProtocol'),
  MediaRateLimiter: Symbol.for('Media.MediaRateLimiter'),
  MediaService: Symbol.for('Media.MediaService'),
  MediaController: Symbol.for('Media.MediaController'),
  MediaRouter: Symbol.for('Media.MediaRouter'),
  RequestScope: Symbol.for('Media.RequestScope'),
} as const;
```

- [ ] **Step 2: Write the failing adapter-construction test**

Append to `tests/unit/media-presign-options.test.ts` an integration-free assertion that the adapter uses the configured bucket and TTL. Because presigning needs no live S3 connection, this is safe offline:

```ts
import { S3ObjectStore } from '@/modules/media/data/s3-object.store.js';
import type { AppConfig } from '@/core/config/app.config.js';

describe('S3ObjectStore presigning', () => {
  it('signs exact PUT headers and GET access with configured settings', async () => {
    const config = {
      media: {
        bucket: 'bucket', region: 'us-east-1', endpoint: 'http://localhost:9000',
        accessKeyId: 'key', secretAccessKey: 'secret', forcePathStyle: true,
        maxBytes: 100, allowedContentTypes: ['image/png'], presignTtlSeconds: 60,
        scanRequired: true,
      },
    } as AppConfig;
    const store = new S3ObjectStore(config, new MediaPresignOptions());

    const put = await store.presignPut('media/o/i.png', 'image/png', 12);
    expect(put.headers).toEqual({ 'Content-Type': 'image/png', 'Content-Length': '12' });
    expect(put.url).toContain('X-Amz-Expires=60');
    expect(put.url).toContain('localhost%3A9000');

    const get = await store.presignGet('media/o/i.png');
    expect(get.url).toContain('X-Amz-Expires=60');
    expect(get.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
```

Note: the imports must be added at the top of the file; Biome will organize them.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/unit/media-presign-options.test.ts`
Expected: FAIL — `S3ObjectStore` does not exist.

- [ ] **Step 4: Implement the adapter**

Create `src/modules/media/data/s3-object.store.ts`:

```ts
import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { inject, injectable } from 'inversify';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { ObjectStoreException } from '@/core/errors/repository.error.js';
import type { MediaPresignOptions } from '@/modules/media/logic/media-presign.options.js';
import { MEDIA_TYPES } from '@/modules/media/media.types.js';
import type {
  ObjectMetadata,
  ObjectStore,
  PresignedDownload,
  PresignedUpload,
} from '@/modules/media/logic/ports/object-store.js';

/** S3-compatible adapter; the bucket is private and all access is presigned. */
@injectable()
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly ttlSeconds: number;

  constructor(
    @inject(CORE_TYPES.Config) config: AppConfig,
    @inject(MEDIA_TYPES.MediaPresignOptions) private readonly options: MediaPresignOptions,
  ) {
    const media = config.media;
    this.bucket = media.bucket;
    this.ttlSeconds = media.presignTtlSeconds;
    this.client = new S3Client({
      region: media.region,
      endpoint: media.endpoint,
      forcePathStyle: media.forcePathStyle,
      credentials: {
        accessKeyId: media.accessKeyId,
        secretAccessKey: media.secretAccessKey,
      },
    });
  }

  async presignPut(
    objectKey: string,
    contentType: string,
    sizeBytes: number,
  ): Promise<PresignedUpload> {
    const options = this.options.put(
      this.bucket,
      objectKey,
      contentType,
      sizeBytes,
      this.ttlSeconds,
    );

    try {
      const command = new PutObjectCommand({
        Bucket: options.bucket,
        Key: options.key,
        ContentType: options.contentType,
        ContentLength: options.sizeBytes,
      });
      const url = await getSignedUrl(this.client, command, { expiresIn: options.expiresIn });

      return { url, headers: options.headers, expiresAt: options.expiresAt };
    } catch (error) {
      throw new ObjectStoreException('Failed to presign an upload', { cause: error });
    }
  }

  async presignGet(objectKey: string): Promise<PresignedDownload> {
    const options = this.options.get(this.bucket, objectKey, this.ttlSeconds);

    try {
      const command = new GetObjectCommand({ Bucket: options.bucket, Key: options.key });
      const url = await getSignedUrl(this.client, command, { expiresIn: options.expiresIn });

      return { url, expiresAt: options.expiresAt };
    } catch (error) {
      throw new ObjectStoreException('Failed to presign a download', { cause: error });
    }
  }

  async head(objectKey: string): Promise<ObjectMetadata | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      );

      return {
        contentType: result.ContentType ?? '',
        sizeBytes: result.ContentLength ?? 0,
      };
    } catch (error) {
      if (this.isMissingObject(error)) {
        return null;
      }

      throw new ObjectStoreException('Failed to inspect a media object', { cause: error });
    }
  }

  async getStream(objectKey: string): Promise<Readable> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      );

      if (!result.Body) {
        throw new ObjectStoreException('Media object has no body');
      }

      return result.Body as unknown as Readable;
    } catch (error) {
      if (error instanceof ObjectStoreException) {
        throw error;
      }

      throw new ObjectStoreException('Failed to open a media object', { cause: error });
    }
  }

  async delete(objectKey: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
    } catch (error) {
      throw new ObjectStoreException('Failed to delete a media object', { cause: error });
    }
  }

  private isMissingObject(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }

    const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };

    return (
      candidate.name === 'NotFound' ||
      candidate.name === 'NoSuchKey' ||
      candidate.$metadata?.httpStatusCode === 404
    );
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/unit/media-presign-options.test.ts`
Expected: PASS (3 tests). The presigned URL assertion uses the configured external endpoint, which is what a browser will call.

- [ ] **Step 6: Commit**

```bash
git add src/modules/media/media.types.ts src/modules/media/data/s3-object.store.ts tests/unit/media-presign-options.test.ts
git commit -m "feat(media): add private S3 presigning adapter" -m "Implement the ObjectStore port with AWS SDK v3 against a private S3-compatible bucket. Presign PUT with exact Content-Type and Content-Length headers and a configured TTL, presign GET only through the service, map missing objects to null on HEAD, expose object bodies as readable streams for scanning, and wrap all SDK failures in ObjectStoreException so credentials and raw errors never surface. Declare the media module DI symbols needed by this and later tasks."
```

---

### Task 6: ClamAV INSTREAM scanner adapter

**Files:**
- Create: `src/modules/media/data/clamav-virus.scanner.ts`
- Test: `tests/unit/clamav-scanner.test.ts`

**Interfaces:**
- Consumes: `AppConfig.clamAv`, `ClamAvProtocol`, `VirusScanner`, `VirusScannerException`.
- Produces: `ClamAvVirusScanner`.

- [ ] **Step 1: Write failing scanner tests with a local fake clamd server**

Create `tests/unit/clamav-scanner.test.ts`:

```ts
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '@/core/config/app.config.js';
import { VirusScannerException } from '@/core/errors/repository.error.js';
import { ClamAvVirusScanner } from '@/modules/media/data/clamav-virus.scanner.js';
import { ClamAvProtocol } from '@/modules/media/logic/clamav-protocol.js';

const COMMAND = Buffer.from('zINSTREAM\0');

let server: Server | undefined;

afterEach(async () => {
  if (server?.listening) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

/** Accepts only a NUL-terminated command and frames ending in a zero-length chunk. */
const collectFrames = (onComplete: () => void): ((chunk: Buffer) => void) => {
  let pending = Buffer.alloc(0);
  let commandSeen = false;
  let completed = false;

  return (chunk: Buffer) => {
    if (completed) return;
    pending = Buffer.concat([pending, chunk]);
    if (!commandSeen) {
      if (pending.length < COMMAND.length || !pending.subarray(0, COMMAND.length).equals(COMMAND)) {
        return;
      }
      pending = pending.subarray(COMMAND.length);
      commandSeen = true;
    }
    while (pending.length >= 4) {
      const length = pending.readUInt32BE(0);
      if (length === 0) {
        completed = true;
        onComplete();
        return;
      }
      if (pending.length < 4 + length) return;
      pending = pending.subarray(4 + length);
    }
  };
};

const startServer = async (reply: string | null): Promise<number> => {
  server = createServer((socket) => {
    socket.on(
      'data',
      collectFrames(() => {
        if (reply !== null) socket.write(reply);
      }),
    );
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return address.port;
};

const scannerFor = (port: number, timeoutMs = 1000): ClamAvVirusScanner =>
  new ClamAvVirusScanner(
    { clamAv: { host: '127.0.0.1', port, timeoutMs } } as AppConfig,
    new ClamAvProtocol(),
  );

describe('ClamAvVirusScanner', () => {
  it('streams a file through NUL-terminated zINSTREAM and reports clean', async () => {
    const port = await startServer('stream: OK\0');
    const result = await scannerFor(port).scan(Readable.from([Buffer.from('hello')]));
    expect(result).toEqual({ verdict: 'clean' });
  });

  it('reports an infection and preserves spaces in the clamd signature', async () => {
    const port = await startServer('stream: Eicar-Test-Signature (test variant) FOUND\0');
    const result = await scannerFor(port).scan(Readable.from([Buffer.from('eicar')]));
    expect(result).toEqual({
      verdict: 'infected',
      signature: 'Eicar-Test-Signature (test variant)',
    });
  });

  it('fails closed when the daemon does not answer', async () => {
    const port = await startServer(null);
    await expect(scannerFor(port, 50).scan(Readable.from([Buffer.from('x')]))).rejects.toThrow(
      VirusScannerException,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/clamav-scanner.test.ts`
Expected: FAIL — `ClamAvVirusScanner` does not exist.

- [ ] **Step 3: Implement the scanner**

Create `src/modules/media/data/clamav-virus.scanner.ts`:

```ts
import { connect, type Socket } from 'node:net';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { inject, injectable } from 'inversify';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { VirusScannerException } from '@/core/errors/repository.error.js';
import type { ClamAvProtocol } from '@/modules/media/logic/clamav-protocol.js';
import type { ScanResult, VirusScanner } from '@/modules/media/logic/ports/virus-scanner.js';
import { MEDIA_TYPES } from '@/modules/media/media.types.js';

const INSTREAM_COMMAND = 'zINSTREAM\0';

/** Streams objects to clamd using the INSTREAM protocol with a hard timeout. */
@injectable()
export class ClamAvVirusScanner implements VirusScanner {
  constructor(
    @inject(CORE_TYPES.Config) private readonly config: AppConfig,
    @inject(MEDIA_TYPES.ClamAvProtocol) private readonly protocol: ClamAvProtocol,
  ) {}

  scan(stream: Readable): Promise<ScanResult> {
    const { host, port, timeoutMs } = this.config.clamAv;

    return new Promise<ScanResult>((resolve, reject) => {
      const socket: Socket = connect({ host, port });
      const decoder = new StringDecoder('utf8');
      let response = '';
      let settled = false;
      let socketReady = false;
      let streamEnded = stream.readableEnded;
      let terminatorSent = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const onDrain = (): void => {
        if (!settled) {
          stream.resume();
        }
      };

      // Single terminal path: clear the wall-clock timer and detach backpressure state.
      const cleanup = (): boolean => {
        if (settled) {
          return false;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        socket.off('drain', onDrain);
        stream.destroy();
        socket.destroy();
        return true;
      };

      // Fail closed with a sanitized error; never propagate raw socket or protocol text.
      const fail = (): void => {
        if (cleanup()) {
          reject(new VirusScannerException('Virus scan failed'));
        }
      };

      const succeed = (result: ScanResult): void => {
        if (cleanup()) {
          resolve(result);
        }
      };

      const writeTerminator = (): void => {
        if (settled || !socketReady || terminatorSent) {
          return;
        }
        terminatorSent = true;
        socket.write(this.protocol.terminator(), (terminatorError) => {
          if (terminatorError) {
            fail();
          }
        });
      };

      // Inactivity timeouts can be reset by a daemon that keeps trickling bytes, so bound the
      // whole exchange with a wall-clock deadline as well.
      timer = setTimeout(() => fail(), timeoutMs);

      socket.setTimeout(timeoutMs, () => fail());
      socket.once('error', () => fail());
      socket.once('close', () => {
        if (!settled) {
          fail();
        }
      });
      socket.on('drain', onDrain);
      socket.on('data', (chunk: Buffer) => {
        if (settled) {
          return;
        }
        response += decoder.write(chunk);

        // clamd terminates replies with NUL, not a newline.
        const terminatorIndex = response.indexOf('\0');
        if (terminatorIndex === -1) {
          return;
        }

        try {
          // Normalize control characters in the body while keeping the NUL reply delimiter.
          const body = response.slice(0, terminatorIndex).replace(/\p{Cc}/gu, ' ');
          succeed(this.protocol.parseResponse(`${body}\0`));
        } catch {
          fail();
        }
      });

      // Listeners are attached before connect so an early source error cannot be uncaught, and the
      // stream stays paused until the protocol prefix has been written.
      stream.on('data', (chunk: Buffer) => {
        if (settled || !socketReady) {
          return;
        }
        if (!socket.write(this.protocol.frame(chunk))) {
          stream.pause();
        }
      });
      stream.once('error', () => fail());
      stream.once('end', () => {
        streamEnded = true;
        writeTerminator();
      });
      stream.pause();

      socket.once('connect', () => {
        // z-prefixed clamd commands must be NUL-terminated; '\n' makes clamd wait forever.
        socket.write(INSTREAM_COMMAND, (writeError) => {
          if (writeError) {
            fail();
            return;
          }

          socketReady = true;
          if (streamEnded) {
            writeTerminator();
            return;
          }
          stream.resume();
        });
      });
    });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/clamav-scanner.test.ts`
Expected: PASS (3 tests). The timeout case proves a hung daemon becomes a wrapped `VirusScannerException`, which Task 8 maps to `503 MEDIA_SCAN_UNAVAILABLE`.

- [ ] **Step 5: Commit**

```bash
git add src/modules/media/data/clamav-virus.scanner.ts tests/unit/clamav-scanner.test.ts
git commit -m "feat(media): add fail-closed ClamAV INSTREAM adapter" -m "Implement the VirusScanner port with clamd's NUL-terminated zINSTREAM command, prefixing stream chunks with big-endian lengths, writing a zero-length terminator, and parsing NUL-terminated stream: OK / stream: ... FOUND replies through the pure protocol helper. Enforce CLAMAV_TIMEOUT_MS, destroy the socket and source stream on completion, and wrap socket, timeout, and malformed-reply failures in VirusScannerException so MediaService can translate them to 503 without leaking protocol text. Cover clean, infected, and hung-daemon paths with a local fake clamd server."
```

---

### Task 7: PostgreSQL media object repository

**Files:**
- Create: `src/modules/media/data/media-object.mapper.ts`
- Create: `src/modules/media/data/postgres-media-object.repository.ts`
- Test: `tests/integration/media/media-repository.test.ts`

**Interfaces:**
- Consumes: `mediaObjects`, `AppDatabase`, `MediaObjectKeyFactory`, `MediaObjectRecord`, `MediaObjectRepository`.
- Produces: `PostgresMediaObjectRepository`, `mediaObjectSelection`, `MediaObjectMapper`.

- [ ] **Step 1: Write the failing repository test**

Create `tests/integration/media/media-repository.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { TestApp } from '../../helpers/test-app.js';
import { PostgresMediaObjectRepository } from '@/modules/media/data/postgres-media-object.repository.js';
import { MediaObjectKeyFactory } from '@/modules/media/logic/media-object-key.factory.js';

describe('PostgresMediaObjectRepository', () => {
  let app: TestApp;
  let auth: AuthFixture;
  let repository: PostgresMediaObjectRepository;

  beforeAll(async () => {
    app = await TestApp.create();
    auth = new AuthFixture(app);
    repository = new PostgresMediaObjectRepository(app.db, new MediaObjectKeyFactory());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
  });

  it('creates a pending record with a server-generated key', async () => {
    const user = await auth.createUser({ email: 'media-repo-create@example.com' });
    const record = await repository.create({
      ownerUserId: user.id,
      contentType: 'image/png',
      sizeBytes: 42,
    });

    expect(record.status).toBe('pending');
    expect(record.objectKey).toMatch(new RegExp(`^media/${user.id}/[0-9a-f-]+\\.png$`));
    expect(record.sizeBytes).toBe(42);
    expect(record.sha256).toBeNull();
  });

  it('scopes reads, transitions, and deletes to the owner', async () => {
    const owner = await auth.createUser({ email: 'media-repo-owner@example.com' });
    const other = await auth.createUser({ email: 'media-repo-other@example.com' });
    const created = await repository.create({
      ownerUserId: owner.id, contentType: 'image/png', sizeBytes: 10,
    });

    expect(await repository.findOwned(created.id, other.id)).toBeNull();
    expect(await repository.transitionToReady(created.id, other.id, 'a'.repeat(64))).toBeNull();

    const hash = 'b'.repeat(64);
    const ready = await repository.transitionToReady(created.id, owner.id, hash);
    expect(ready?.status).toBe('ready');
    expect(ready?.sha256).toBe(hash);
    expect(ready?.finalizedAt).toBeInstanceOf(Date);
    expect(await repository.transitionToReady(created.id, owner.id, hash)).toBeNull();
    expect(await repository.deleteOwned(created.id, other.id)).toBe(false);
    expect(await repository.deleteOwned(created.id, owner.id)).toBe(true);
  });

  it('records quarantine and failed states with bounded diagnostics', async () => {
    const user = await auth.createUser({ email: 'media-repo-scan@example.com' });
    const created = await repository.create({
      ownerUserId: user.id, contentType: 'application/pdf', sizeBytes: 20,
    });

    const quarantined = await repository.transitionToQuarantined(
      created.id, user.id, 'Eicar-Test-Signature', null,
    );
    expect(quarantined?.status).toBe('quarantined');
    expect(quarantined?.scanSignature).toBe('Eicar-Test-Signature');

    const second = await repository.create({
      ownerUserId: user.id, contentType: 'application/pdf', sizeBytes: 20,
    });
    const failed = await repository.markFailed(second.id, user.id, 'metadata mismatch');
    expect(failed?.status).toBe('failed');
    expect(failed?.scanError).toBe('metadata mismatch');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/media/media-repository.test.ts`
Expected: FAIL — repository modules do not exist.

- [ ] **Step 3: Create the explicit mapper**

Create `src/modules/media/data/media-object.mapper.ts`:

```ts
import type { InferSelectModel } from 'drizzle-orm';
import { mediaObjects } from '@/core/database/schema/index.js';
import { MediaObjectRecord } from '@/modules/media/logic/entities/media-object-record.js';

export const mediaObjectSelection = {
  id: mediaObjects.id,
  ownerUserId: mediaObjects.ownerUserId,
  objectKey: mediaObjects.objectKey,
  contentType: mediaObjects.contentType,
  sizeBytes: mediaObjects.sizeBytes,
  sha256: mediaObjects.sha256,
  status: mediaObjects.status,
  scanSignature: mediaObjects.scanSignature,
  scanError: mediaObjects.scanError,
  createdAt: mediaObjects.createdAt,
  updatedAt: mediaObjects.updatedAt,
  finalizedAt: mediaObjects.finalizedAt,
} as const;

export type MediaObjectRow = Pick<
  InferSelectModel<typeof mediaObjects>,
  keyof typeof mediaObjectSelection
>;

export class MediaObjectMapper {
  toRecord(row: MediaObjectRow): MediaObjectRecord {
    return new MediaObjectRecord(
      row.id,
      row.ownerUserId,
      row.objectKey,
      row.contentType,
      row.sizeBytes,
      row.sha256,
      row.status as MediaObjectRecord['status'],
      row.scanSignature,
      row.scanError,
      row.createdAt,
      row.updatedAt,
      row.finalizedAt,
    );
  }
}
```

- [ ] **Step 4: Create the repository**

Create `src/modules/media/data/postgres-media-object.repository.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { AppDatabase } from '@/core/database/database.provider.js';
import { mediaObjects } from '@/core/database/schema/index.js';
import { PersistenceException } from '@/core/errors/repository.error.js';
import {
  MediaObjectMapper,
  mediaObjectSelection,
} from '@/modules/media/data/media-object.mapper.js';
import type { MediaObjectRecord } from '@/modules/media/logic/entities/media-object-record.js';
import type { MediaObjectKeyFactory } from '@/modules/media/logic/media-object-key.factory.js';
import type {
  CreateMediaObjectInput,
  MediaObjectRepository,
} from '@/modules/media/logic/ports/media-object.repository.js';
import { MEDIA_TYPES } from '@/modules/media/media.types.js';

/** Drizzle persistence for media upload lifecycle records. */
@injectable()
export class PostgresMediaObjectRepository implements MediaObjectRepository {
  private readonly mapper = new MediaObjectMapper();

  constructor(
    @inject(CORE_TYPES.Db) private readonly db: AppDatabase,
    @inject(MEDIA_TYPES.MediaObjectKeyFactory)
    private readonly keys: MediaObjectKeyFactory,
  ) {}

  async create(input: CreateMediaObjectInput): Promise<MediaObjectRecord> {
    const temporaryKey = `media/pending/${randomUUID()}`;

    try {
      return await this.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(mediaObjects)
          .values({
            ownerUserId: input.ownerUserId,
            objectKey: temporaryKey,
            contentType: input.contentType,
            sizeBytes: input.sizeBytes,
            status: 'pending',
          })
          .returning(mediaObjectSelection);

        const row = inserted[0];

        if (!row) {
          throw new PersistenceException('PostgreSQL did not return the created media object');
        }

        const objectKey = this.keys.build(input.ownerUserId, row.id, input.contentType);
        const updated = await tx
          .update(mediaObjects)
          .set({ objectKey, updatedAt: new Date() })
          .where(eq(mediaObjects.id, row.id))
          .returning(mediaObjectSelection);

        const finalRow = updated[0];

        if (!finalRow) {
          throw new PersistenceException('Failed to assign the media object key');
        }

        return this.mapper.toRecord(finalRow);
      });
    } catch (error) {
      if (error instanceof PersistenceException) {
        throw error;
      }

      throw new PersistenceException('Failed to create media object', { cause: error });
    }
  }

  async findOwned(id: string, ownerUserId: string): Promise<MediaObjectRecord | null> {
    try {
      const rows = await this.db
        .select(mediaObjectSelection)
        .from(mediaObjects)
        .where(and(eq(mediaObjects.id, id), eq(mediaObjects.ownerUserId, ownerUserId)))
        .limit(1);

      const row = rows[0];

      return row ? this.mapper.toRecord(row) : null;
    } catch (error) {
      throw new PersistenceException('Failed to read media object', { cause: error });
    }
  }

  async transitionToReady(
    id: string,
    ownerUserId: string,
    sha256: string | null,
  ): Promise<MediaObjectRecord | null> {
    return this.transition(id, ownerUserId, {
      status: 'ready',
      sha256,
      finalizedAt: new Date(),
      scanError: null,
    });
  }

  async transitionToQuarantined(
    id: string,
    ownerUserId: string,
    signature: string,
    error: string | null,
  ): Promise<MediaObjectRecord | null> {
    return this.transition(id, ownerUserId, {
      status: 'quarantined',
      scanSignature: signature.slice(0, 512),
      scanError: error === null ? null : error.slice(0, 512),
      finalizedAt: new Date(),
    });
  }

  async markFailed(id: string, ownerUserId: string, error: string): Promise<MediaObjectRecord | null> {
    return this.transition(id, ownerUserId, {
      status: 'failed',
      scanError: error.slice(0, 512),
    });
  }

  async deleteOwned(id: string, ownerUserId: string): Promise<boolean> {
    try {
      const rows = await this.db
        .delete(mediaObjects)
        .where(and(eq(mediaObjects.id, id), eq(mediaObjects.ownerUserId, ownerUserId)))
        .returning({ id: mediaObjects.id });

      return rows.length > 0;
    } catch (error) {
      throw new PersistenceException('Failed to delete media object', { cause: error });
    }
  }

  private async transition(
    id: string,
    ownerUserId: string,
    values: Partial<{
      status: 'ready' | 'quarantined' | 'failed';
      sha256: string | null;
      scanSignature: string;
      scanError: string | null;
      finalizedAt: Date;
    }>,
  ): Promise<MediaObjectRecord | null> {
    try {
      const rows = await this.db
        .update(mediaObjects)
        .set({ ...values, updatedAt: new Date() })
        .where(
          and(
            eq(mediaObjects.id, id),
            eq(mediaObjects.ownerUserId, ownerUserId),
            eq(mediaObjects.status, 'pending'),
          ),
        )
        .returning(mediaObjectSelection);

      const row = rows[0];

      return row ? this.mapper.toRecord(row) : null;
    } catch (error) {
      throw new PersistenceException('Failed to transition media object', { cause: error });
    }
  }
}
```

Every transition is conditional on `status = 'pending'`, which is what makes concurrent finalize safe (Review Focus #2). The temporary key is unique per row and replaced inside the same transaction, so the final key still uses the database-generated uuidv7.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/integration/media/media-repository.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/modules/media/data/media-object.mapper.ts src/modules/media/data/postgres-media-object.repository.ts tests/integration/media/media-repository.test.ts
git commit -m "feat(media): add owner-scoped media repository" -m "Implement the MediaObjectRepository port with Drizzle and an explicit column mapper. Insert and finalize object keys inside one transaction so keys still use database-generated uuidv7 ids, and make every status transition conditional on pending plus owner so repeated or racing finalize calls cannot both succeed. Scope reads and deletes by owner, wrap SQL failures in PersistenceException, and bound stored scan diagnostics to 512 characters."
```

---

### Task 8: Media lifecycle service with fail-closed scanning

**Files:**
- Create: `src/modules/media/logic/media.service.ts`
- Test: `tests/unit/media-service.test.ts`

**Interfaces:**
- Consumes: `MediaObjectRepository`, `ObjectStore`, `VirusScanner`, `AppConfig.media`.
- Produces: `MediaService`, `UploadTicket`, `DownloadTicket`, `FinalizeResult`.

- [ ] **Step 1: Write failing service unit tests with in-memory fakes**

Create `tests/unit/media-service.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '@/core/config/app.config.js';
import {
  InvalidMediaInputException,
  MediaInfectedException,
  MediaNotReadyException,
  MediaNotFoundException,
  MediaScanUnavailableException,
} from '@/core/errors/domain.error.js';
import { VirusScannerException } from '@/core/errors/repository.error.js';
import { MediaObjectRecord } from '@/modules/media/logic/entities/media-object-record.js';
import { MediaService } from '@/modules/media/logic/media.service.js';
import type {
  MediaObjectRepository,
} from '@/modules/media/logic/ports/media-object.repository.js';
import type { ObjectStore } from '@/modules/media/logic/ports/object-store.js';
import type { ScanResult, VirusScanner } from '@/modules/media/logic/ports/virus-scanner.js';

const OWNER = '01920000-0000-7000-8000-0000000000aa';
const ID = '01920000-0000-7000-8000-0000000000bb';
const KEY = `media/${OWNER}/${ID}.png`;
const HASH = createHash('sha256').update('bytes').digest('hex');

class FakeRepository implements MediaObjectRepository {
  record: MediaObjectRecord | null = null;
  deleted: string[] = [];
  failed: string[] = [];

  seed(status: MediaObjectRecord['status'] = 'pending'): MediaObjectRecord {
    this.record = new MediaObjectRecord(
      ID, OWNER, KEY, 'image/png', 5, null, status, null, null,
      new Date(), new Date(), null,
    );
    return this.record;
  }

  async create(): Promise<MediaObjectRecord> { return this.seed(); }
  async findOwned(): Promise<MediaObjectRecord | null> { return this.record; }
  async transitionToReady(_id: string, _owner: string, sha: string | null) {
    if (!this.record || this.record.status !== 'pending') return null;
    this.record = new MediaObjectRecord(
      ID, OWNER, KEY, 'image/png', 5, sha, 'ready', null, null,
      this.record.createdAt, new Date(), new Date(),
    );
    return this.record;
  }
  async transitionToQuarantined(_id: string, _owner: string, signature: string) {
    if (!this.record || this.record.status !== 'pending') return null;
    this.record = new MediaObjectRecord(
      ID, OWNER, KEY, 'image/png', 5, null, 'quarantined', signature, null,
      this.record.createdAt, new Date(), new Date(),
    );
    return this.record;
  }
  async markFailed(_id: string, _owner: string, error: string) {
    this.failed.push(error);
    return this.record;
  }
  async deleteOwned(id: string): Promise<boolean> {
    this.deleted.push(id);
    return true;
  }
}

class FakeStore implements ObjectStore {
  metadata = { contentType: 'image/png', sizeBytes: 5 };
  exists = true;
  deletedKeys: string[] = [];

  async presignPut() {
    return {
      url: 'https://upload', headers: { 'Content-Type': 'image/png', 'Content-Length': '5' },
      expiresAt: new Date(),
    };
  }
  async presignGet() { return { url: 'https://download', expiresAt: new Date() }; }
  async head() { return this.exists ? this.metadata : null; }
  async getStream() { return Readable.from([Buffer.from('bytes')]); }
  async delete(key: string) { this.deletedKeys.push(key); }
}

class FakeScanner implements VirusScanner {
  mode: 'clean' | 'infected' | 'unavailable' = 'clean';
  async scan(stream: Readable): Promise<ScanResult> {
    for await (const _chunk of stream) { /* drain */ }
    if (this.mode === 'unavailable') throw new VirusScannerException('scanner down');
    if (this.mode === 'infected') return { verdict: 'infected', signature: 'Eicar' };
    return { verdict: 'clean' };
  }
}

const config = (scanRequired = true): AppConfig => ({
  media: {
    bucket: 'bucket', region: 'us-east-1', endpoint: 'http://localhost:9000',
    accessKeyId: 'key', secretAccessKey: 'secret', forcePathStyle: true,
    maxBytes: 100, allowedContentTypes: ['image/png', 'application/pdf'],
    presignTtlSeconds: 300, scanRequired,
  },
} as AppConfig);

describe('MediaService', () => {
  let objects: FakeRepository;
  let store: FakeStore;
  let scanner: FakeScanner;
  let service: MediaService;

  beforeEach(() => {
    objects = new FakeRepository();
    store = new FakeStore();
    scanner = new FakeScanner();
    service = new MediaService(objects, store, scanner, config());
  });

  it('rejects a type outside the allowlist or a size outside the cap', async () => {
    await expect(service.initiate(OWNER, 'image/svg+xml', 5)).rejects.toThrow(InvalidMediaInputException);
    await expect(service.initiate(OWNER, 'image/png', 0)).rejects.toThrow(InvalidMediaInputException);
    await expect(service.initiate(OWNER, 'image/png', 101)).rejects.toThrow(InvalidMediaInputException);
  });

  it('issues a presigned PUT for a new pending object', async () => {
    const ticket = await service.initiate(OWNER, 'image/png', 5);
    expect(ticket.mediaId).toBe(ID);
    expect(ticket.objectKey).toBe(KEY);
    expect(ticket.uploadUrl).toBe('https://upload');
    expect(ticket.headers['Content-Length']).toBe('5');
  });

  it('finalizes a clean scan with a sha256 and a download URL', async () => {
    objects.seed();
    const result = await service.finalize(OWNER, ID);
    expect(result.status).toBe('ready');
    expect(result.sha256).toBe(HASH);
    expect(result.downloadUrl).toBe('https://download');
  });

  it('quarantines an infected object and never returns a download URL', async () => {
    objects.seed();
    scanner.mode = 'infected';
    await expect(service.finalize(OWNER, ID)).rejects.toThrow(MediaInfectedException);
    expect(objects.record?.status).toBe('quarantined');
    expect(objects.record?.scanSignature).toBe('Eicar');
  });

  it('maps scanner failures to MEDIA_SCAN_UNAVAILABLE and leaves the row pending', async () => {
    objects.seed();
    scanner.mode = 'unavailable';
    await expect(service.finalize(OWNER, ID)).rejects.toThrow(MediaScanUnavailableException);
    expect(objects.record?.status).toBe('pending');
  });

  it('skips scanning only when configuration explicitly disables it', async () => {
    objects.seed();
    const bypass = new MediaService(objects, store, scanner, config(false));
    const result = await bypass.finalize(OWNER, ID);
    expect(result.status).toBe('ready');
    expect(result.sha256).toBeNull();
  });

  it('rejects missing, already-finalized, and metadata-mismatched objects', async () => {
    await expect(service.finalize(OWNER, ID)).rejects.toThrow(MediaNotFoundException);
    objects.seed('ready');
    await expect(service.finalize(OWNER, ID)).rejects.toThrow(MediaNotReadyException);

    objects.seed();
    store.metadata = { contentType: 'image/gif', sizeBytes: 5 };
    await expect(service.finalize(OWNER, ID)).rejects.toThrow(InvalidMediaInputException);
    expect(objects.failed).toHaveLength(1);
  });

  it('issues download URLs only for ready objects', async () => {
    objects.seed('quarantined');
    await expect(service.getDownload(OWNER, ID)).rejects.toThrow(MediaNotReadyException);
    objects.seed('ready');
    expect((await service.getDownload(OWNER, ID)).downloadUrl).toBe('https://download');
  });

  it('deletes the S3 object before the database row', async () => {
    objects.seed('ready');
    await service.remove(OWNER, ID);
    expect(store.deletedKeys).toEqual([KEY]);
    expect(objects.deleted).toEqual([ID]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/media-service.test.ts`
Expected: FAIL — `MediaService` does not exist.

- [ ] **Step 3: Implement the service**

Create `src/modules/media/logic/media.service.ts`:

```ts
import { createHash, type Hash } from 'node:crypto';
import { Transform } from 'node:stream';
import { inject, injectable } from 'inversify';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import {
  InvalidMediaInputException,
  MediaInfectedException,
  MediaNotReadyException,
  MediaNotFoundException,
  MediaScanUnavailableException,
} from '@/core/errors/domain.error.js';
import { VirusScannerException } from '@/core/errors/repository.error.js';
import type { MediaObjectRecord } from '@/modules/media/logic/entities/media-object-record.js';
import type { MediaObjectRepository } from '@/modules/media/logic/ports/media-object.repository.js';
import type {
  ObjectStore,
  PresignedDownload,
  PresignedUpload,
} from '@/modules/media/logic/ports/object-store.js';
import type { VirusScanner } from '@/modules/media/logic/ports/virus-scanner.js';
import { MEDIA_TYPES } from '@/modules/media/media.types.js';

export interface UploadTicket extends PresignedUpload {
  mediaId: string;
  objectKey: string;
}

export interface DownloadTicket extends PresignedDownload {
  mediaId: string;
  status: 'ready';
  contentType: string;
  sizeBytes: number;
  sha256: string | null;
}

export type FinalizeResult = DownloadTicket;

type ScanOutcome =
  | { verdict: 'infected'; signature: string }
  | { verdict: 'clean'; sha256: string };

/** Owns the complete upload lifecycle; adapters and persistence stay behind ports. */
@injectable()
export class MediaService {
  constructor(
    @inject(MEDIA_TYPES.MediaObjectRepository)
    private readonly objects: MediaObjectRepository,
    @inject(MEDIA_TYPES.ObjectStore) private readonly store: ObjectStore,
    @inject(MEDIA_TYPES.VirusScanner) private readonly scanner: VirusScanner,
    @inject(CORE_TYPES.Config) private readonly config: AppConfig,
  ) {}

  async initiate(userId: string, contentType: string, sizeBytes: number): Promise<UploadTicket> {
    const media = this.config.media;

    if (!media.allowedContentTypes.includes(contentType)) {
      throw new InvalidMediaInputException(`Unsupported media content type: ${contentType}`);
    }

    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > media.maxBytes) {
      throw new InvalidMediaInputException('Media size is outside the configured limit');
    }

    const record = await this.objects.create({ ownerUserId: userId, contentType, sizeBytes });
    const upload = await this.store.presignPut(record.objectKey, contentType, sizeBytes);

    return {
      mediaId: record.id,
      objectKey: record.objectKey,
      url: upload.url,
      headers: upload.headers,
      expiresAt: upload.expiresAt,
    };
  }

  async finalize(userId: string, mediaId: string): Promise<FinalizeResult> {
    const record = await this.requireOwned(userId, mediaId);

    if (record.status !== 'pending') {
      throw new MediaNotReadyException();
    }

    const head = await this.store.head(record.objectKey);

    if (head === null) {
      throw new MediaNotFoundException('Uploaded object was not found');
    }

    if (head.contentType !== record.contentType || head.sizeBytes !== record.sizeBytes) {
      await this.objects.markFailed(mediaId, userId, 'Uploaded object metadata does not match ticket');
      throw new InvalidMediaInputException('Uploaded object metadata does not match the ticket');
    }

    let sha256: string | null = null;

    if (this.config.media.scanRequired) {
      const outcome = await this.scanWithHash(record.objectKey);

      if (outcome.verdict === 'infected') {
        await this.objects.transitionToQuarantined(mediaId, userId, outcome.signature, null);
        throw new MediaInfectedException();
      }

      sha256 = outcome.sha256;
    }

    const ready = await this.objects.transitionToReady(mediaId, userId, sha256);

    if (ready === null) {
      throw new MediaNotReadyException();
    }

    return this.toDownloadTicket(ready);
  }

  async getDownload(userId: string, mediaId: string): Promise<DownloadTicket> {
    const record = await this.requireOwned(userId, mediaId);

    if (record.status !== 'ready') {
      throw new MediaNotReadyException();
    }

    return this.toDownloadTicket(record);
  }

  async remove(userId: string, mediaId: string): Promise<void> {
    const record = await this.requireOwned(userId, mediaId);
    await this.store.delete(record.objectKey);

    const deleted = await this.objects.deleteOwned(mediaId, userId);

    if (!deleted) {
      throw new MediaNotFoundException();
    }
  }

  private async scanWithHash(objectKey: string): Promise<ScanOutcome> {
    const hash: Hash = createHash('sha256');
    const hashing = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const source = await this.store.getStream(objectKey);
    source.on('error', (error) => hashing.destroy(error));
    source.pipe(hashing);

    try {
      const result = await this.scanner.scan(hashing);

      if (result.verdict === 'infected') {
        return { verdict: 'infected', signature: result.signature };
      }

      return { verdict: 'clean', sha256: hash.digest('hex') };
    } catch (error) {
      if (error instanceof VirusScannerException) {
        throw new MediaScanUnavailableException(undefined, { cause: error });
      }

      throw error;
    } finally {
      source.destroy();
      hashing.destroy();
    }
  }

  private async requireOwned(userId: string, mediaId: string): Promise<MediaObjectRecord> {
    const record = await this.objects.findOwned(mediaId, userId);

    if (record === null) {
      throw new MediaNotFoundException();
    }

    return record;
  }

  private async toDownloadTicket(record: MediaObjectRecord): Promise<DownloadTicket> {
    const download = await this.store.presignGet(record.objectKey);

    return {
      mediaId: record.id,
      status: 'ready',
      contentType: record.contentType,
      sizeBytes: record.sizeBytes,
      sha256: record.sha256,
      url: download.url,
      expiresAt: download.expiresAt,
    };
  }
}
```

The hash is returned through `ScanOutcome` rather than stored on the singleton service, so concurrent finalize calls cannot mix results.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/media-service.test.ts`
Expected: PASS (9 tests). In particular, the scanner-outage test leaves the row `pending` so a later finalize can retry, and the bypass test produces a `ready` row with `sha256: null`.

- [ ] **Step 5: Commit**

```bash
git add src/modules/media/logic/media.service.ts tests/unit/media-service.test.ts
git commit -m "feat(media): orchestrate fail-closed upload lifecycle" -m "Add MediaService to validate content type and size, create pending records, issue exact-header presigned PUT tickets, recheck S3 metadata at finalize, hash bytes while streaming through the virus scanner, and issue presigned GET tickets only for ready objects. Infected files move to quarantined with a bounded signature and return 422; scanner outages map to 503 and leave the row pending for retry; metadata mismatches mark the row failed. Deletion removes the storage object before the database row so a storage failure remains retryable. Unit tests pin every branch with in-memory ports."
```

---

### Task 9: Documented media HTTP surface and module wiring

**Files:**
- Create: `src/modules/media/web/dto/media.schemas.ts`
- Create: `src/modules/media/web/dto/media.openapi.ts`
- Create: `src/modules/media/web/media.controller.ts`
- Create: `src/modules/media/web/routes/media.router.ts`
- Create: `src/modules/media/media.container.ts`
- Create: `src/modules/media/media.module.ts`
- Modify: `src/core/http/middleware/rate-limit.ts`
- Modify: `src/app/application.ts`

**Interfaces:**
- Consumes: `MediaService`, `ApiResponse`, `CORE_TYPES.RequireAuth`, `CORE_TYPES.RequireVerifiedEmail`, `OpenApiRegistry`.
- Produces: `MediaRateLimiter`, `MediaModule` (with public `mediaContainer`), four routes under `/api/media`.

- [ ] **Step 1: Write failing web-layer tests**

Create `tests/integration/media/media-routes.test.ts` with a boot-time contract check:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestApp } from '../../helpers/test-app.js';

describe('media route registration', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await TestApp.create();
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers all four documented operations', async () => {
    const docs = await app.request.get('/api/openapi.json');
    expect(docs.status).toBe(200);
    const paths = docs.body.paths as Record<string, Record<string, { operationId: string }>>;
    expect(paths['/api/media/uploads']?.post?.operationId).toBe('media.createUpload');
    expect(paths['/api/media/{id}/finalize']?.post?.operationId).toBe('media.finalize');
    expect(paths['/api/media/{id}']?.get?.operationId).toBe('media.download');
    expect(paths['/api/media/{id}']?.delete?.operationId).toBe('media.delete');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/media/media-routes.test.ts`
Expected: FAIL — 404 from `/api/media/uploads` and missing OpenAPI paths.

- [ ] **Step 3: Add request and response schemas**

Create `src/modules/media/web/dto/media.schemas.ts`:

```ts
import { z } from 'zod';

/** Body for requesting a presigned upload. Size limits are enforced by config. */
export const createUploadSchema = z.object({
  contentType: z.string().min(1).max(128),
  sizeBytes: z.number().int().positive(),
});

export const mediaParamsSchema = z.object({ id: z.uuid() });

export const uploadTicketSchema = z
  .object({
    mediaId: z.uuid(),
    objectKey: z.string(),
    uploadUrl: z.url(),
    headers: z.object({
      'Content-Type': z.string(),
      'Content-Length': z.string(),
    }),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'UploadTicket' });

export const downloadTicketSchema = z
  .object({
    mediaId: z.uuid(),
    status: z.literal('ready'),
    contentType: z.string(),
    sizeBytes: z.number().int().positive(),
    sha256: z.string().nullable(),
    downloadUrl: z.url(),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'DownloadTicket' });

export type CreateUploadSchema = z.infer<typeof createUploadSchema>;
```

- [ ] **Step 4: Add OpenAPI contracts**

Create `src/modules/media/web/dto/media.openapi.ts`:

```ts
/// <reference types="zod-openapi" />
import { apiErrorResponseSchema, successEnvelope } from '@/core/http/openapi/openapi.schemas.js';
import type { OpenApiResponseContract, RouteContract } from '@/core/http/openapi/openapi.types.js';
import {
  createUploadSchema,
  downloadTicketSchema,
  mediaParamsSchema,
  uploadTicketSchema,
} from '@/modules/media/web/dto/media.schemas.js';

const bearerSecurity = [{ bearerAuth: [] }] as const;
const errorSchema = apiErrorResponseSchema;

const errorResponse = (description: string): OpenApiResponseContract => ({
  description,
  schema: errorSchema,
});

const mediaErrors = {
  400: errorResponse('Invalid content type or size'),
  401: errorResponse('Authentication is required'),
  403: errorResponse('A verified email is required'),
  404: errorResponse('Media object not found'),
  409: errorResponse('Media object is not ready'),
  422: errorResponse('The uploaded file is infected'),
  429: errorResponse('Too many media requests'),
  500: errorResponse('Unexpected server error'),
  503: errorResponse('Virus scanning is temporarily unavailable'),
};

const uploadResponse = successEnvelope(uploadTicketSchema, 'UploadTicketResponse');
const downloadResponse = successEnvelope(downloadTicketSchema, 'DownloadTicketResponse');

export const mediaContracts = {
  createUpload: {
    operationId: 'media.createUpload',
    tags: ['Media'],
    summary: 'Request a presigned media upload',
    description:
      'Creates a pending media object with a server-generated object key and returns a short-lived presigned PUT URL that signs the exact content type and byte length. The bucket is private.',
    security: bearerSecurity,
    request: { body: createUploadSchema },
    responses: { 201: { description: 'Upload ticket created', schema: uploadResponse }, ...mediaErrors },
  },
  finalize: {
    operationId: 'media.finalize',
    tags: ['Media'],
    summary: 'Recheck, scan, and finalize an upload',
    description:
      'Verifies S3 metadata, streams the object through ClamAV, hashes clean bytes, and returns a presigned GET URL. An outage leaves the row pending; an infection quarantines it.',
    security: bearerSecurity,
    request: { params: mediaParamsSchema },
    responses: { 200: { description: 'Object is ready', schema: downloadResponse }, ...mediaErrors },
  },
  download: {
    operationId: 'media.download',
    tags: ['Media'],
    summary: 'Get a fresh presigned download URL',
    description: 'Returns a short-lived presigned GET URL for a ready object owned by the caller.',
    security: bearerSecurity,
    request: { params: mediaParamsSchema },
    responses: { 200: { description: 'Download ticket', schema: downloadResponse }, ...mediaErrors },
  },
  delete: {
    operationId: 'media.delete',
    tags: ['Media'],
    summary: 'Delete a media object',
    description: 'Deletes the S3 object and its row. Cross-user access returns 404.',
    security: bearerSecurity,
    request: { params: mediaParamsSchema },
    responses: { 204: { description: 'No content' }, ...mediaErrors },
  },
} satisfies Record<string, RouteContract>;
```

- [ ] **Step 5: Add media limiter and register the module**

Append to `src/core/http/middleware/rate-limit.ts`:

```ts
/** Limits upload tickets, finalize attempts, and signed URL issuance. */
@injectable()
export class MediaRateLimiter extends RedisRateLimiter {
  constructor(@inject(CORE_TYPES.RedisClient) client: RedisClient) {
    super(client, {
      windowMs: FIFTEEN_MINUTES_MS,
      limit: 30,
      prefix: 'rl:media:',
      message: 'Too many media operations. Try again later.',
    });
  }
}
```

In `src/app/application.ts`, import `MediaModule` from `@/modules/media/media.module.js` and add `new MediaModule(container),` after `new StoriesModule(container),` in the modules array.

- [ ] **Step 6: Add the controller**

Create `src/modules/media/web/media.controller.ts`:

```ts
import type { Request, RequestHandler } from 'express';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { UnauthorizedException } from '@/core/errors/http.error.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';
import type { MediaService, UploadTicket, DownloadTicket } from '@/modules/media/logic/media.service.js';
import { MEDIA_TYPES } from '@/modules/media/media.types.js';
import {
  createUploadSchema,
  mediaParamsSchema,
} from '@/modules/media/web/dto/media.schemas.js';

@injectable()
export class MediaController {
  constructor(
    @inject(MEDIA_TYPES.MediaService) private readonly media: MediaService,
    @inject(CORE_TYPES.ApiResponse) private readonly response: ApiResponse,
  ) {}

  createUpload: RequestHandler = async (req, res) => {
    const input = createUploadSchema.parse(req.body);
    const ticket: UploadTicket = await this.media.initiate(
      this.requireUser(req).id,
      input.contentType,
      input.sizeBytes,
    );

    this.response.created(res, {
      mediaId: ticket.mediaId,
      objectKey: ticket.objectKey,
      uploadUrl: ticket.url,
      headers: ticket.headers,
      expiresAt: ticket.expiresAt,
    });
  };

  finalize: RequestHandler = async (req, res) => {
    const { id } = mediaParamsSchema.parse(req.params);
    const result: DownloadTicket = await this.media.finalize(this.requireUser(req).id, id);

    this.response.ok(res, this.toBody(result));
  };

  download: RequestHandler = async (req, res) => {
    const { id } = mediaParamsSchema.parse(req.params);
    const result = await this.media.getDownload(this.requireUser(req).id, id);

    this.response.ok(res, this.toBody(result));
  };

  remove: RequestHandler = async (req, res) => {
    const { id } = mediaParamsSchema.parse(req.params);

    await this.media.remove(this.requireUser(req).id, id);

    this.response.noContent(res);
  };

  private toBody(result: DownloadTicket) {
    return {
      mediaId: result.mediaId,
      status: result.status,
      contentType: result.contentType,
      sizeBytes: result.sizeBytes,
      sha256: result.sha256,
      downloadUrl: result.url,
      expiresAt: result.expiresAt,
    };
  }

  private requireUser(req: Request): Express.User {
    if (!req.isAuthenticated()) {
      throw new UnauthorizedException();
    }

    return req.user;
  }
}
```

- [ ] **Step 7: Add the documented router**

Create `src/modules/media/web/routes/media.router.ts`:

```ts
import type { Router } from 'express';
import { inject, injectable } from 'inversify';
import type { RequireBearerAuthMiddleware } from '@/core/auth/require-bearer-auth.middleware.js';
import type { RequireVerifiedEmailMiddleware } from '@/core/auth/require-verified-email.middleware.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { MediaRateLimiter } from '@/core/http/middleware/rate-limit.js';
import type { RequestScopeMiddleware } from '@/core/http/middleware/request-scope.js';
import { DocumentedRouter } from '@/core/http/openapi/documented-router.js';
import type { OpenApiRegistry } from '@/core/http/openapi/openapi.registry.js';
import { MEDIA_TYPES } from '@/modules/media/media.types.js';
import { mediaContracts } from '@/modules/media/web/dto/media.openapi.js';
import type { MediaController } from '@/modules/media/web/media.controller.js';

@injectable()
export class MediaRouter {
  readonly router: Router;

  constructor(
    @inject(MEDIA_TYPES.RequestScope) scope: RequestScopeMiddleware,
    @inject(MEDIA_TYPES.MediaRateLimiter) private readonly limiter: MediaRateLimiter,
    @inject(CORE_TYPES.OpenApiRegistry) registry: OpenApiRegistry,
    @inject(CORE_TYPES.RequireAuth) private readonly requireAuth: RequireBearerAuthMiddleware,
    @inject(CORE_TYPES.RequireVerifiedEmail)
    private readonly requireVerifiedEmail: RequireVerifiedEmailMiddleware,
  ) {
    const routes = new DocumentedRouter(registry, '/api/media');
    this.router = routes.router;
    this.router.use(scope.handle);

    const guarded = [
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
    ] as const;

    routes.post('/uploads', mediaContracts.createUpload, ...guarded, (req, res, next) =>
      req.container.get<MediaController>(MEDIA_TYPES.MediaController).createUpload(req, res, next),
    );

    routes.post('/:id/finalize', mediaContracts.finalize, ...guarded, (req, res, next) =>
      req.container.get<MediaController>(MEDIA_TYPES.MediaController).finalize(req, res, next),
    );

    routes.get('/:id', mediaContracts.download, ...guarded, (req, res, next) =>
      req.container.get<MediaController>(MEDIA_TYPES.MediaController).download(req, res, next),
    );

    routes.delete('/:id', mediaContracts.delete, ...guarded, (req, res, next) =>
      req.container.get<MediaController>(MEDIA_TYPES.MediaController).remove(req, res, next),
    );
  }
}
```

Using `guarded` for every route is what pins Review Focus #5.

- [ ] **Step 8: Add the child container and module**

Create `src/modules/media/media.container.ts`:

```ts
import { Container } from 'inversify';
import { MediaRateLimiter } from '@/core/http/middleware/rate-limit.js';
import { RequestScopeMiddleware } from '@/core/http/middleware/request-scope.js';
import { ClamAvVirusScanner } from '@/modules/media/data/clamav-virus.scanner.js';
import { PostgresMediaObjectRepository } from '@/modules/media/data/postgres-media-object.repository.js';
import { S3ObjectStore } from '@/modules/media/data/s3-object.store.js';
import { ClamAvProtocol } from '@/modules/media/logic/clamav-protocol.js';
import { MediaObjectKeyFactory } from '@/modules/media/logic/media-object-key.factory.js';
import { MediaPresignOptions } from '@/modules/media/logic/media-presign.options.js';
import { MediaService } from '@/modules/media/logic/media.service.js';
import type { MediaObjectRepository } from '@/modules/media/logic/ports/media-object.repository.js';
import type { ObjectStore } from '@/modules/media/logic/ports/object-store.js';
import type { VirusScanner } from '@/modules/media/logic/ports/virus-scanner.js';
import { MEDIA_TYPES } from '@/modules/media/media.types.js';
import { MediaRouter } from '@/modules/media/web/routes/media.router.js';
import { MediaController } from '@/modules/media/web/media.controller.js';

export class MediaContainer extends Container {
  constructor(parent: Container) {
    super({ parent });

    this.bind<RequestScopeMiddleware>(MEDIA_TYPES.RequestScope).toConstantValue(
      new RequestScopeMiddleware(this),
    );
    this.bind<MediaRateLimiter>(MEDIA_TYPES.MediaRateLimiter)
      .to(MediaRateLimiter)
      .inSingletonScope();
    this.bind(MediaObjectKeyFactory).toSelf().inSingletonScope();
    this.bind(MEDIA_TYPES.MediaObjectKeyFactory)
      .toConstantValue(this.get(MediaObjectKeyFactory));
    this.bind(MediaPresignOptions).toSelf().inSingletonScope();
    this.bind(MEDIA_TYPES.MediaPresignOptions).toConstantValue(this.get(MediaPresignOptions));
    this.bind(ClamAvProtocol).toSelf().inSingletonScope();
    this.bind(MEDIA_TYPES.ClamAvProtocol).toConstantValue(this.get(ClamAvProtocol));

    this.bind<MediaObjectRepository>(MEDIA_TYPES.MediaObjectRepository)
      .to(PostgresMediaObjectRepository)
      .inSingletonScope();
    this.bind<ObjectStore>(MEDIA_TYPES.ObjectStore).to(S3ObjectStore).inSingletonScope();
    this.bind<VirusScanner>(MEDIA_TYPES.VirusScanner).to(ClamAvVirusScanner).inSingletonScope();
    this.bind<MediaService>(MEDIA_TYPES.MediaService).to(MediaService).inSingletonScope();

    this.bind<MediaController>(MEDIA_TYPES.MediaController).to(MediaController);
    this.bind<MediaRouter>(MEDIA_TYPES.MediaRouter).to(MediaRouter).inSingletonScope();
  }
}
```

Create `src/modules/media/media.module.ts`:

```ts
import type { Router } from 'express';
import type { Container } from 'inversify';
import type { MediaRateLimiter } from '@/core/http/middleware/rate-limit.js';
import type { AppModule } from '@/core/modules/app.module.js';
import { MediaContainer } from '@/modules/media/media.container.js';
import { MEDIA_TYPES } from '@/modules/media/media.types.js';
import type { MediaRouter } from '@/modules/media/web/routes/media.router.js';

/** Registers the `/api/media` router and exposes the container for test doubles. */
export class MediaModule implements AppModule {
  readonly name = 'media';
  readonly mountPath = '/api/media';
  readonly router: Router;
  readonly mediaContainer: MediaContainer;

  constructor(root: Container) {
    this.mediaContainer = new MediaContainer(root);
    this.router = this.mediaContainer.get<MediaRouter>(MEDIA_TYPES.MediaRouter).router;
  }

  configure(): void {
    this.mediaContainer.get<MediaRateLimiter>(MEDIA_TYPES.MediaRateLimiter).initialize();
  }

  dispose(): Promise<void> {
    this.mediaContainer.unbindAll();

    return Promise.resolve();
  }
}
```

- [ ] **Step 9: Run the route test to verify it passes**

Run: `npx vitest run tests/integration/media/media-routes.test.ts`
Expected: PASS (1 test). If the registry reports duplicate operationIds, fix the contract names before continuing.

- [ ] **Step 10: Commit**

```bash
git add src/modules/media/web src/modules/media/media.container.ts src/modules/media/media.module.ts src/modules/media/media.types.ts src/core/http/middleware/rate-limit.ts src/app/application.ts tests/integration/media/media-routes.test.ts
git commit -m "feat(media): expose documented upload endpoints" -m "Add four DocumentedRouter routes for requesting an upload, finalizing with a scan, obtaining a signed download URL, and deleting an object. All four are bearer-authenticated, verified-email gated, and share the rl:media: Redis limiter, and controllers return the standard envelope through ApiResponse. Wire a MediaModule child container with repository, S3, ClamAV, service, and request-scoped controller bindings into Application, and publish OpenAPI contracts whose request schemas are the same Zod schemas used for validation."
```

---

### Task 10: End-to-end media API tests against MinIO

**Files:**
- Create: `tests/fixtures/media.fixture.ts`
- Create: `tests/integration/media/media-api.test.ts`

**Interfaces:**
- Consumes: `MediaModule.mediaContainer`, `MEDIA_TYPES.VirusScanner`, `MEDIA_TYPES.ObjectStore`, `MediaService`, `AppConfig`.
- Produces: deterministic fake scanner fixture and full HTTP coverage of success and error paths.

These tests require `postgres`, `redis`, `minio`, and `storage-init` running (`docker compose up -d postgres redis minio storage-init`). They do **not** require ClamAV because the scanner is rebound to a fake.

- [ ] **Step 1: Create the media fixture**

Create `tests/fixtures/media.fixture.ts`:

```ts
import type { Readable } from 'node:stream';
import { VirusScannerException } from '@/core/errors/repository.error.js';
import type { MediaModule } from '@/modules/media/media.module.js';
import { MEDIA_TYPES } from '@/modules/media/media.types.js';
import type { MediaService, UploadTicket } from '@/modules/media/logic/media.service.js';
import type { ObjectStore } from '@/modules/media/logic/ports/object-store.js';
import type { ScanResult, VirusScanner } from '@/modules/media/logic/ports/virus-scanner.js';
import type { TestApp } from '../helpers/test-app.js';

export class FakeVirusScanner implements VirusScanner {
  mode: 'clean' | 'infected' | 'unavailable' = 'clean';

  async scan(stream: Readable): Promise<ScanResult> {
    for await (const _chunk of stream) {
      /* drain the object so hash completion is deterministic */
    }

    if (this.mode === 'unavailable') {
      throw new VirusScannerException('fake scanner outage');
    }

    if (this.mode === 'infected') {
      return { verdict: 'infected', signature: 'Eicar-Test-Signature' };
    }

    return { verdict: 'clean' };
  }
}

export class MediaFixture {
  readonly scanner = new FakeVirusScanner();

  private readonly store: ObjectStore;
  private readonly keys: string[] = [];

  constructor(private readonly app: TestApp) {
    const module = app.application.getModule<MediaModule>('media');

    if (!module) {
      throw new Error('MediaModule is not registered in the application');
    }

    module.mediaContainer
      .rebind<VirusScanner>(MEDIA_TYPES.VirusScanner)
      .toConstantValue(this.scanner);
    this.store = module.mediaContainer.get<ObjectStore>(MEDIA_TYPES.ObjectStore);
  }

  track(ticket: UploadTicket): void {
    this.keys.push(ticket.objectKey);
  }

  async put(ticket: UploadTicket, bytes: Buffer, contentType: string): Promise<void> {
    const response = await fetch(ticket.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: bytes,
    });

    if (!response.ok) {
      throw new Error(`Presigned PUT failed with ${response.status}: ${await response.text()}`);
    }
  }

  useBypass(): void {
    const module = this.app.application.getModule<MediaModule>('media');

    if (!module) {
      throw new Error('MediaModule is not registered in the application');
    }

    const config = this.app.container.config;
    const bypassConfig = {
      ...config,
      media: { ...config.media, scanRequired: false },
    } as typeof config;

    module.mediaContainer
      .rebind<MediaService>(MEDIA_TYPES.MediaService)
      .toConstantValue(
        new MediaService(
          module.mediaContainer.get(MEDIA_TYPES.MediaObjectRepository),
          module.mediaContainer.get(MEDIA_TYPES.ObjectStore),
          module.mediaContainer.get(MEDIA_TYPES.VirusScanner),
          bypassConfig,
        ),
      );
  }

  async cleanup(): Promise<void> {
    for (const key of this.keys) {
      await this.store.delete(key);
    }
    this.keys.length = 0;
  }
}
```

- [ ] **Step 2: Write the failing integration test**

Create `tests/integration/media/media-api.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { MediaFixture } from '../../fixtures/media.fixture.js';
import { expectError, expectNoContent, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';
import type { DownloadTicket, UploadTicket } from '@/modules/media/logic/media.service.js';

const BYTES = Buffer.from('small png stand-in');

interface VerifiedContext {
  userId: string;
  header: { Authorization: string };
}

describe('Media API', () => {
  let app: TestApp;
  let auth: AuthFixture;
  let media: MediaFixture;

  beforeAll(async () => {
    app = await TestApp.create();
    auth = new AuthFixture(app);
    media = new MediaFixture(app);
  });

  afterAll(async () => {
    await media.cleanup();
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
    media.scanner.mode = 'clean';
  });

  const verified = async (email: string): Promise<VerifiedContext> => {
    const user = await auth.createUser({ email, emailVerifiedAt: new Date() });
    const tokens = await auth.mintTokens(user);
    return { userId: user.id, header: auth.bearerHeader(tokens.accessToken) };
  };

  const createUpload = async (header: { Authorization: string }) =>
    expectSuccess<UploadTicket>(
      await app.request
        .post('/api/media/uploads')
        .set(header)
        .send({ contentType: 'image/png', sizeBytes: BYTES.length }),
      201,
    );

  const staged = async (header: { Authorization: string }) => {
    const ticket = await createUpload(header);
    media.track(ticket);
    await media.put(ticket, BYTES, 'image/png');
    return ticket;
  };

  it('uploads, scans, downloads, and deletes a clean object', async () => {
    const { header } = await verified('media-api-clean@example.com');
    const ticket = await staged(header);

    const finalized = expectSuccess<DownloadTicket>(
      await app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(header),
      200,
    );
    expect(finalized.status).toBe('ready');
    expect(finalized.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(finalized.downloadUrl).toContain('X-Amz-Signature=');

    const download = expectSuccess<DownloadTicket>(
      await app.request.get(`/api/media/${ticket.mediaId}`).set(header),
      200,
    );
    expect(download.downloadUrl).toBeTruthy();

    expectNoContent(await app.request.delete(`/api/media/${ticket.mediaId}`).set(header));
    expectError(await app.request.get(`/api/media/${ticket.mediaId}`).set(header), 404, 'NOT_FOUND');
  });

  it('rejects invalid content types and oversized requests', async () => {
    const { header } = await verified('media-api-validation@example.com');

    expectError(
      await app.request
        .post('/api/media/uploads')
        .set(header)
        .send({ contentType: 'image/svg+xml', sizeBytes: 4 }),
      400,
      'VALIDATION_ERROR',
    );
    expectError(
      await app.request
        .post('/api/media/uploads')
        .set(header)
        .send({ contentType: 'image/png', sizeBytes: 52_428_801 }),
      400,
      'VALIDATION_ERROR',
    );
  });

  it('requires authentication and verified email on every media route', async () => {
    const { userId, header } = await verified('media-api-verified@example.com');
    const ticket = await staged(header);

    expectError(await app.request.post('/api/media/uploads').send({}), 401, 'UNAUTHORIZED');

    const unverified = await auth.createUser({ email: 'media-api-unverified@example.com' });
    const tokens = await auth.mintTokens(unverified);
    const unverifiedHeader = auth.bearerHeader(tokens.accessToken);

    expectError(
      await app.request.post('/api/media/uploads').set(unverifiedHeader).send({
        contentType: 'image/png', sizeBytes: 4,
      }),
      403, 'EMAIL_NOT_VERIFIED',
    );
    expectError(
      await app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(unverifiedHeader),
      403, 'EMAIL_NOT_VERIFIED',
    );
    expectError(
      await app.request.get(`/api/media/${ticket.mediaId}`).set(unverifiedHeader),
      403, 'EMAIL_NOT_VERIFIED',
    );
    expectError(
      await app.request.delete(`/api/media/${ticket.mediaId}`).set(unverifiedHeader),
      403, 'EMAIL_NOT_VERIFIED',
    );
    expect(userId).toBeTruthy();
  });

  it('hides object keys and download URLs from non-owners', async () => {
    const owner = await verified('media-api-owner@example.com');
    const other = await verified('media-api-other@example.com');
    const ticket = await staged(owner.header);

    for (const response of [
      await app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(other.header),
      await app.request.get(`/api/media/${ticket.mediaId}`).set(other.header),
      await app.request.delete(`/api/media/${ticket.mediaId}`).set(other.header),
    ]) {
      expectError(response, 404, 'NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain(ticket.objectKey);
      expect(JSON.stringify(response.body)).not.toContain('downloadUrl');
      expect(JSON.stringify(response.body)).not.toContain('sha256');
    }
  });

  it('rejects a finalize when the S3 object is missing', async () => {
    const { header } = await verified('media-api-missing@example.com');
    const ticket = await createUpload(header);
    media.track(ticket);

    expectError(
      await app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(header),
      404, 'NOT_FOUND',
    );
  });

  it('rejects a finalized upload whose S3 metadata does not match the ticket', async () => {
    const { header } = await verified('media-api-mismatch@example.com');
    const ticket = await staged(header);

    // S3 rejects a PUT with a different signed Content-Type, so simulate a
    // substitution by changing the server-side expectation after the upload.
    await app.pool.query('UPDATE media_objects SET content_type = $1 WHERE id = $2', [
      'image/gif',
      ticket.mediaId,
    ]);

    expectError(
      await app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(header),
      400, 'VALIDATION_ERROR',
    );

    const row = await app.pool.query('SELECT status FROM media_objects WHERE id = $1', [ticket.mediaId]);
    expect(row.rows[0]?.status).toBe('failed');
  });

  it('quarantines an infected object without issuing a download URL', async () => {
    const { header } = await verified('media-api-infected@example.com');
    const ticket = await staged(header);
    media.scanner.mode = 'infected';

    const result = expectError(
      await app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(header),
      422, 'MEDIA_INFECTED',
    );
    expect(JSON.stringify(result)).not.toContain(ticket.objectKey);

    expectError(
      await app.request.get(`/api/media/${ticket.mediaId}`).set(header),
      409, 'MEDIA_NOT_READY',
    );

    const row = await app.pool.query(
      'SELECT status, scan_signature FROM media_objects WHERE id = $1', [ticket.mediaId],
    );
    expect(row.rows[0]).toMatchObject({ status: 'quarantined', scan_signature: 'Eicar-Test-Signature' });
  });

  it('fails closed on a scanner outage and permits a later retry', async () => {
    const { header } = await verified('media-api-outage@example.com');
    const ticket = await staged(header);
    media.scanner.mode = 'unavailable';

    expectError(
      await app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(header),
      503, 'MEDIA_SCAN_UNAVAILABLE',
    );

    const pending = await app.pool.query('SELECT status FROM media_objects WHERE id = $1', [
      ticket.mediaId,
    ]);
    expect(pending.rows[0]?.status).toBe('pending');

    media.scanner.mode = 'clean';
    const retry = expectSuccess<DownloadTicket>(
      await app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(header),
      200,
    );
    expect(retry.status).toBe('ready');
  });

  it('allows only one winner when finalize races', async () => {
    const { header } = await verified('media-api-race@example.com');
    const ticket = await staged(header);

    const results = await Promise.allSettled([
      app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(header),
      app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(header),
    ]);

    const successes = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof staged>>> =>
        result.status === 'fulfilled' && result.value.status === 200,
    );
    const conflicts = results.filter(
      (result) => result.status === 'fulfilled' && result.value.status === 409,
    );
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
  });

  it('honors the explicit MEDIA_SCAN_REQUIRED=false bypass', async () => {
    const { header } = await verified('media-api-bypass@example.com');
    const ticket = await staged(header);
    media.useBypass();

    const result = expectSuccess<DownloadTicket>(
      await app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(header),
      200,
    );
    expect(result.status).toBe('ready');
    expect(result.sha256).toBeNull();
  });
});
```

- [ ] **Step 3: Run the integration tests to verify they fail, then pass**

First confirm the test compiles and the first run is red for the intended reason (no MinIO/minimal harness wiring). Then start dependencies and rerun:

Run: `docker compose up -d postgres redis minio storage-init && npm run db:migrate`
Run: `npx vitest run tests/integration/media/media-api.test.ts`
Expected: PASS (11 tests). Each test uses a unique email and the fixture deletes every object it uploaded.

If presigned PUT rejects the manual `Content-Length`, keep the fixture as written (only `Content-Type` is set explicitly; undici computes the length from the buffer, matching the signed value).

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/media.fixture.ts tests/integration/media/media-api.test.ts
git commit -m "test(media): cover the full upload lifecycle over HTTP" -m "Add a deterministic fake virus scanner fixture and end-to-end API tests against real PostgreSQL, Redis, and MinIO. Cover the happy path from presigned PUT through clean scan, signed GET, and delete, plus invalid type, oversized request, unauthenticated and unverified access on all four routes, non-owner isolation without object-key leakage, missing S3 object, metadata mismatch, quarantine, scanner outage with retry, an explicit scan bypass, and a concurrent finalize race. Clean up every uploaded object after the suite."
```

---

### Task 11: Documentation, full verification, and cleanup

**Files:**
- Modify: `README.md`
- Verify: all tasks above

**Interfaces:**
- Consumes: the completed implementation from Tasks 1–10.
- Produces: accurate operator docs and recorded verification evidence.

- [ ] **Step 1: Document the API and behaviour in README.md**

Add a `### Media uploads` section after `### Stories` in `README.md` with this content:

````markdown
### Media uploads

Phase 2.4 provides a generic upload pipeline. The bucket stays private: the API
generates every object key, issues short-lived presigned PUT/GET URLs, and gates
readiness on a virus scan. Avatar, story, and message integrations are not wired
to it yet and continue using their placeholder keys.

| Method | Path                        | Purpose                                             |
| ------ | --------------------------- | --------------------------------------------------- |
| `POST` | `/api/media/uploads`        | Create a pending object and presigned `PUT` ticket  |
| `POST` | `/api/media/:id/finalize`   | Recheck S3 metadata, scan, and mark ready/quarantined |
| `GET`  | `/api/media/:id`            | Get a fresh presigned `GET` URL for a ready object  |
| `DELETE` | `/api/media/:id`          | Delete the object and its row                       |

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
````

Add the new configuration variables (bucket, endpoint, credentials, region,
path style, max bytes, allowlist, presign TTL, scan requirement, ClamAV host/port/
timeout) to the `## Configuration` table using the defaults from `.env.example`.
State explicitly that `MEDIA_SCAN_REQUIRED` defaults to `true` and that no
`NODE_ENV` check changes it. In the local-development prerequisites, note that
`minio` and `storage-init` are now required for the test suite, and ClamAV is
optional and started with `docker compose --profile scan up -d`. In `## Ports`,
note that presigned URLs use the host-reachable `MEDIA_ENDPOINT` (`localhost:9000`
locally), while in-container storage uses the `minio:9000` service name.

- [ ] **Step 2: Run the full verification gate**

Run: `npm run verify && npm run db:check`
Expected: typecheck clean, Biome clean, build clean, all test files passing (the
previous baseline was 28 files / 193 tests; this plan adds 9 new test files),
and `db:check` reporting `Everything's fine 🐶🔥`.

If Biome reports formatting issues, run `npm run check` and re-run `npm run verify`.

- [ ] **Step 3: Live smoke with the real application**

Start the dependencies and app in the worktree:

```bash
docker compose up -d postgres redis minio storage-init
npm run db:migrate
npm run dev
```

Register and verify a temporary user through the existing auth endpoints (use
the captured verification code from Mailpit or the test fixture flow), then use
`curl` with the access token. Replace `<TOKEN>` and `<ID>` below:

```bash
TOKEN='<TOKEN>'
BODY='{"contentType":"image/png","sizeBytes":12}'
TICKET=$(curl -sS -X POST http://localhost:4000/api/media/uploads \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$BODY")
printf '%s\n' "$TICKET"

URL=$(node -e "const s=JSON.parse(process.argv[1]);process.stdout.write(s.data.uploadUrl)" "$TICKET")
ID=$(node -e "const s=JSON.parse(process.argv[1]);process.stdout.write(s.data.mediaId)" "$TICKET")
printf 'smoke bytes' > /tmp/opencode/media-smoke.bin
curl -sS -X PUT "$URL" -H 'Content-Type: image/png' --data-binary @/tmp/opencode/media-smoke.bin -o /dev/null -w 'PUT %{http_code}\n'

curl -sS -X POST "http://localhost:4000/api/media/$ID/finalize" \
  -H "Authorization: Bearer $TOKEN"
curl -sS "http://localhost:4000/api/media/$ID" -H "Authorization: Bearer $TOKEN"
```

With the default `MEDIA_SCAN_REQUIRED=true` and no ClamAV daemon running, the
finalize call must return `503 MEDIA_SCAN_UNAVAILABLE` — that is the fail-closed
success criterion for outage. For a clean-path smoke, either start
`docker compose --profile scan up -d` or restart the API with
`MEDIA_SCAN_REQUIRED=false` in the environment and repeat; the latter must
return `200` with a `downloadUrl`.

Error-path smoke checks:

```bash
curl -sS -X POST http://localhost:4000/api/media/uploads \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"contentType":"image/svg+xml","sizeBytes":12}'
curl -sS -X POST http://localhost:4000/api/media/uploads \
  -H 'Content-Type: application/json' \
  -d '{"contentType":"image/png","sizeBytes":12}'
curl -sS "http://localhost:4000/api/media/01920000-0000-7000-8000-000000000000" \
  -H "Authorization: Bearer $TOKEN"
```

Expected: `400 VALIDATION_ERROR`, `401 UNAUTHORIZED`, and `404 NOT_FOUND`
respectively. Download the returned `downloadUrl` once with `curl` to prove it
is signed. The known packaging issue remains: compiled output runs with
`node dist/src/index.js`, not `npm run start`.

- [ ] **Step 4: Clean up**

Delete the temporary smoke user and its derived rows, delete the smoke object
from MinIO (`aws --endpoint-url http://localhost:9000 s3 rm s3://messenger-media/<objectKey>`
or via the API as the owner), remove `/tmp/opencode/media-smoke.bin`, stop the
API process, and stop Docker services you started (`docker compose down`).
Confirm port 4000 is free.

- [ ] **Step 5: Commit the documentation**

```bash
git add -f README.md
git commit -m "docs(media): document upload pipeline and rollout" -m "Describe the four media endpoints, the presigned PUT/finalize/signed GET lifecycle, the verified-email and rate-limit gates, size and content-type limits, fail-closed scan behavior with its explicit bypass, owner isolation, and error codes. Record the new configuration variables and defaults, explain that MinIO and storage-init are now required for the test suite while ClamAV is optional, and note that presigned URLs use the host-reachable endpoint."
```

`README.md` is tracked, so `git add` alone is normally sufficient; use `-f` only if the repository's ignore rules require it.

---

## Self-Review

This section is the executor's final checklist, run after all tasks are implemented. It is not a subagent dispatch.

1. **Spec coverage:** §4 module layout and schema are covered by Tasks 3, 4, 7, 9; §4.3 object store by Tasks 5 and 10; §4.4 scanner by Tasks 6 and 10; §5 routes and payloads by Tasks 9 and 10; §6 errors by Task 2; §7 config by Task 1; §8 security invariants by Tasks 5, 7, 8, 9, 10; §9 tests by Tasks 3–10; §10 rollout by Task 11; §11 risks are reflected in the docs and scanner-outage tests; §12 acceptance by Tasks 9–11. No spec requirement is left without a task.
2. **Placeholder scan:** no TBD, TODO, "implement later", "add appropriate error handling", or "similar to Task N" remains. Every code step contains concrete code; every test step names files and expected outcomes.
3. **Type consistency:** `MediaObjectRecord.status` is `MediaStatus`; `MediaObjectRepository.transitionToReady` accepts `sha256: string | null`; `ObjectStore.getStream` returns `Promise<Readable>` (the one documented adjustment from the spec's synchronous sketch); `VirusScanner.scan` returns `ScanResult`; `UploadTicket.url` and `DownloadTicket.url` are mapped to `uploadUrl`/`downloadUrl` only in the HTTP layer; `MEDIA_TYPES` symbols match across container, service, and fixtures.
4. **Review Focus:** all five inputs are pinned — metadata substitution (Task 10), concurrent finalize (Task 10 and conditional SQL transitions in Task 7), non-owner leakage (Task 10), hostile scanner output (Tasks 4, 6, 8), and verified-email gating on every route (Task 9 router plus Task 10 test).

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-11-18-media-uploads.md`. Please review it.

For this plan I recommend **subagent-driven** execution: the tasks are numerous and each depends on exact interfaces from the previous one, so a fresh reviewer per task is worth the extra context cost because a shipped presigning or fail-closed mistake would be a security issue, not a cosmetic bug. Native execution is a cheaper alternative if you prefer one continuous implementation pass.





