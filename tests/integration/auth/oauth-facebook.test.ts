import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectError } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';

const FACEBOOK_ENV = {
  FACEBOOK_CLIENT_ID: 'test-facebook-client-id',
  FACEBOOK_CLIENT_SECRET: 'test-facebook-client-secret',
  FACEBOOK_CALLBACK_URL: 'http://localhost:4000/api/auth/oauth/facebook/callback',
} as const;

const originalEnv: Record<string, string | undefined> = {};

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('Auth: Facebook OAuth', () => {
  let disabledApp: TestApp;
  let enabledApp: TestApp;

  beforeAll(async () => {
    for (const key of Object.keys(FACEBOOK_ENV)) {
      originalEnv[key] = process.env[key];
    }

    setEnv({
      FACEBOOK_CLIENT_ID: undefined,
      FACEBOOK_CLIENT_SECRET: undefined,
      FACEBOOK_CALLBACK_URL: undefined,
    });
    disabledApp = await TestApp.create();

    setEnv(FACEBOOK_ENV);
    enabledApp = await TestApp.create();
  });

  afterAll(async () => {
    await Promise.allSettled([disabledApp?.close(), enabledApp?.close()]);
    setEnv(originalEnv);
  });

  it('does not register the routes when the provider is not configured', async () => {
    expectError(await disabledApp.request.get('/api/auth/oauth/facebook'), 404, 'NOT_FOUND');
    expectError(
      await disabledApp.request.get('/api/auth/oauth/facebook/callback'),
      404,
      'NOT_FOUND',
    );
  });

  it('redirects to Facebook with the configured client, callback, and email scope', async () => {
    const res = await enabledApp.request.get('/api/auth/oauth/facebook');

    expect(res.status).toBe(302);

    const { location } = res.headers;
    expect(location).toBeDefined();

    const url = new URL(location as string);
    expect(url.origin).toBe('https://www.facebook.com');
    expect(url.pathname).toBe('/v27.0/dialog/oauth');
    expect(url.searchParams.get('client_id')).toBe(FACEBOOK_ENV.FACEBOOK_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(FACEBOOK_ENV.FACEBOOK_CALLBACK_URL);
    expect(url.searchParams.get('scope')).toBe('email');
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{24,}$/);
    expect(url.searchParams.get('state')).not.toBe('true');
  });

  it('registers the callback route when the provider is configured', async () => {
    // Without a code Facebook sends the browser back with an error; passport
    // redirects to the configured failure redirect instead of returning 404.
    const res = await enabledApp.request.get(
      '/api/auth/oauth/facebook/callback?error=access_denied',
    );

    const { location } = res.headers;

    expect(res.status).toBe(302);
    expect(location).not.toContain('/api/auth/oauth/facebook');
  });
});
