import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { expectError, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';

describe('Auth: Bearer Authentication', () => {
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

  describe('GET /api/auth/me', () => {
    it('returns the authenticated user profile when a valid bearer token is provided', async () => {
      const user = await auth.createUser({
        email: 'me@example.com',
        displayName: 'Current User',
      });
      const tokens = await auth.mintTokens(user);

      const res = await app.request.get('/api/auth/me').set(auth.bearerHeader(tokens.accessToken));

      const data = expectSuccess<{
        id: string;
        email: string;
        displayName: string;
        sessionVersion: number;
      }>(res, 200);

      expect(data.id).toBe(user.id);
      expect(data.email).toBe('me@example.com');
      expect(data.displayName).toBe('Current User');
      expect(data.sessionVersion).toBe(user.sessionVersion);
    });

    it('returns 401 UNAUTHORIZED when no authorization header is sent', async () => {
      const res = await app.request.get('/api/auth/me');

      const error = expectError(res, 401, 'UNAUTHORIZED');
      expect(error.message).toContain('bearer access token is required');
    });

    it('returns 401 UNAUTHORIZED when a malformed bearer token is sent', async () => {
      const res = await app.request
        .get('/api/auth/me')
        .set({ Authorization: 'Bearer totally.invalid.jwt' });

      const error = expectError(res, 401, 'UNAUTHORIZED');
      expect(error.message).toContain('invalid or expired');
    });

    it('returns 401 UNAUTHORIZED when the user sessionVersion has been bumped', async () => {
      const user = await auth.createUser({ email: 'stale-session@example.com' });
      const tokens = await auth.mintTokens(user);

      // Simulate session version bump (e.g. password change / logout all)
      await app.pool.query('UPDATE users SET session_version = session_version + 1 WHERE id = $1', [
        user.id,
      ]);

      const res = await app.request.get('/api/auth/me').set(auth.bearerHeader(tokens.accessToken));

      const error = expectError(res, 401, 'UNAUTHORIZED');
      expect(error.message).toBe('Session is no longer valid');
    });
  });
});
