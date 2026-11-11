import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { expectError, expectNoContent, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';

describe('Auth: Token Lifecycle & Sessions', () => {
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

  describe('POST /api/auth/token/refresh', () => {
    it('rotates single-use refresh token and returns a new token pair', async () => {
      const user = await auth.createUser({ email: 'rotate@example.com' });
      const initialTokens = await auth.mintTokens(user);

      const res = await app.request
        .post('/api/auth/token/refresh')
        .set(auth.bearerHeader(initialTokens.accessToken))
        .send({ refreshToken: initialTokens.refreshToken });

      const data = expectSuccess<{
        tokens: { accessToken: string; refreshToken: string };
      }>(res, 200);

      expect(data.tokens.refreshToken).not.toBe(initialTokens.refreshToken);
      expect(typeof data.tokens.accessToken).toBe('string');

      // Verify the new access token is valid
      const meRes = await app.request
        .get('/api/auth/me')
        .set(auth.bearerHeader(data.tokens.accessToken));
      expectSuccess(meRes, 200);
    });

    it('detects refresh token reuse, revoking the entire token family', async () => {
      const user = await auth.createUser({ email: 'reuse@example.com' });
      const initialTokens = await auth.mintTokens(user);

      // Legitimate rotation: exchange initial token for second pair
      const rotateRes = await app.request
        .post('/api/auth/token/refresh')
        .set(auth.bearerHeader(initialTokens.accessToken))
        .send({ refreshToken: initialTokens.refreshToken });

      const rotatedData = expectSuccess<{
        tokens: { accessToken: string; refreshToken: string };
      }>(rotateRes, 200);
      const successorRefreshToken = rotatedData.tokens.refreshToken;

      // Attacker replays initial (already rotated) refresh token
      const reuseRes = await app.request
        .post('/api/auth/token/refresh')
        .set(auth.bearerHeader(rotatedData.tokens.accessToken))
        .send({ refreshToken: initialTokens.refreshToken });

      const reuseError = expectError(reuseRes, 401, 'REFRESH_TOKEN_INVALID');
      expect(reuseError.message).toBe('Refresh token reuse detected');

      // Victim's legitimate successor token should NOW also fail because the family was revoked
      const successorRes = await app.request
        .post('/api/auth/token/refresh')
        .set(auth.bearerHeader(rotatedData.tokens.accessToken))
        .send({ refreshToken: successorRefreshToken });

      const successorError = expectError(successorRes, 401, 'REFRESH_TOKEN_INVALID');
      expect(successorError.message).toBe('Refresh token reuse detected');
    });
  });

  describe('POST /api/auth/logout', () => {
    it('revokes the calling device tokens immediately', async () => {
      const user = await auth.createUser({ email: 'logout@example.com' });
      const tokens = await auth.mintTokens(user);

      const logoutRes = await app.request
        .post('/api/auth/logout')
        .set(auth.bearerHeader(tokens.accessToken))
        .send({ refreshToken: tokens.refreshToken });

      expectNoContent(logoutRes);

      // Access token must be rejected via Redis denylist
      const meRes = await app.request
        .get('/api/auth/me')
        .set(auth.bearerHeader(tokens.accessToken));

      const error = expectError(meRes, 401, 'UNAUTHORIZED');
      expect(error.message).toContain('Token has been revoked');

      // Refresh token must be rejected
      const refreshRes = await app.request
        .post('/api/auth/token/refresh')
        .set(auth.bearerHeader(tokens.accessToken))
        .send({ refreshToken: tokens.refreshToken });

      expectError(refreshRes, 401, 'REFRESH_TOKEN_INVALID');
    });
  });

  describe('Sessions management (/api/auth/sessions)', () => {
    it('lists active sessions and allows revoking a remote session', async () => {
      const email = 'multidevice@example.com';
      const password = 'StrongPassword!123';
      await auth.createUser({ email, password });

      // Login from device 1
      const login1 = await app.request.post('/api/auth/login').send({ email, password });
      const data1 = expectSuccess<{
        tokens: { accessToken: string; refreshToken: string };
      }>(login1, 200);

      // Login from device 2
      const login2 = await app.request.post('/api/auth/login').send({ email, password });
      const data2 = expectSuccess<{
        tokens: { accessToken: string; refreshToken: string };
      }>(login2, 200);

      // List sessions from device 1
      const sessionsRes = await app.request
        .get('/api/auth/sessions')
        .set(auth.bearerHeader(data1.tokens.accessToken));

      const sessions = expectSuccess<Array<{ id: string; current: boolean }>>(sessionsRes, 200);

      expect(sessions.length).toBe(2);
      const currentSession = sessions.find((s) => s.current);
      const remoteSession = sessions.find((s) => !s.current);

      expect(currentSession).toBeDefined();
      expect(remoteSession).toBeDefined();

      // Revoke remote session from device 1
      const deleteRes = await app.request
        .delete(`/api/auth/sessions/${remoteSession?.id}`)
        .set(auth.bearerHeader(data1.tokens.accessToken));

      expectNoContent(deleteRes);

      // Device 2's refresh token must now fail
      const remoteRefreshRes = await app.request
        .post('/api/auth/token/refresh')
        .set(auth.bearerHeader(data2.tokens.accessToken))
        .send({ refreshToken: data2.tokens.refreshToken });

      expectError(remoteRefreshRes, 401, 'REFRESH_TOKEN_INVALID');

      // Device 1's refresh token should still be working
      const localRefreshRes = await app.request
        .post('/api/auth/token/refresh')
        .set(auth.bearerHeader(data1.tokens.accessToken))
        .send({ refreshToken: data1.tokens.refreshToken });

      expectSuccess(localRefreshRes, 200);
    });
  });
});
