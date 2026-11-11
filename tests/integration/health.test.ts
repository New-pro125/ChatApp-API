import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectSuccess } from '../helpers/assertions.js';
import { TestApp } from '../helpers/test-app.js';

describe('Health Module', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await TestApp.create();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live returns liveness status without touching dependencies', async () => {
    const res = await app.request.get('/health/live');

    const data = expectSuccess<{ status: string }>(res, 200);
    expect(data.status).toBe('ok');
  });

  it('GET /health/ready returns readiness of PostgreSQL and Redis', async () => {
    const res = await app.request.get('/health/ready');

    const data = expectSuccess<{
      status: string;
      checks: { postgres: string; redis: string };
    }>(res, 200);

    expect(data.status).toBe('ok');
    expect(data.checks.postgres).toBe('up');
    expect(data.checks.redis).toBe('up');
  });
});
