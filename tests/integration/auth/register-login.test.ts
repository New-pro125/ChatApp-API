import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { expectError, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';

describe('Auth: Registration & Login', () => {
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

  describe('POST /api/auth/register', () => {
    it('creates a user and returns a token pair on valid input', async () => {
      const email = 'newuser@example.com';
      const displayName = 'Alice Wonderland';
      const password = 'StrongPassword!123';

      const res = await app.request.post('/api/auth/register').send({
        email,
        displayName,
        password,
      });

      const data = expectSuccess<{
        user: { id: string; email: string; displayName: string; sessionVersion: number };
        tokens: { accessToken: string; refreshToken: string; tokenType: string; expiresIn: number };
      }>(res, 201);

      expect(data.user.email).toBe(email);
      expect(data.user.displayName).toBe(displayName);
      expect(data.user.sessionVersion).toBe(1);
      expect(data.user).not.toHaveProperty('passwordHash');

      expect(data.tokens.tokenType).toBe('Bearer');
      expect(typeof data.tokens.accessToken).toBe('string');
      expect(typeof data.tokens.refreshToken).toBe('string');
      expect(data.tokens.expiresIn).toBe(900);
    });

    it('returns 400 VALIDATION_ERROR when fields are missing or invalid', async () => {
      const res = await app.request.post('/api/auth/register').send({
        email: 'not-an-email',
        password: 'short',
      });

      const error = expectError(res, 400, 'VALIDATION_ERROR');
      expect(error.message).toBe('Invalid request');
      expect(Array.isArray(error.details)).toBe(true);
    });

    it('returns 409 CONFLICT when email is already registered', async () => {
      const email = 'existing@example.com';
      await auth.createUser({ email });

      const res = await app.request.post('/api/auth/register').send({
        email,
        displayName: 'Another Name',
        password: 'StrongPassword!123',
      });

      const error = expectError(res, 409, 'CONFLICT');
      expect(error.message).toBe('Email is already registered');
    });
  });

  describe('POST /api/auth/login', () => {
    it('authenticates with correct credentials and returns token pair', async () => {
      const email = 'login@example.com';
      const password = 'CorrectPassword!123';
      await auth.createUser({ email, password });

      const res = await app.request.post('/api/auth/login').send({
        email,
        password,
      });

      const data = expectSuccess<{
        user: { email: string };
        tokens: { accessToken: string; refreshToken: string };
      }>(res, 200);

      expect(data.user.email).toBe(email);
      expect(typeof data.tokens.accessToken).toBe('string');
      expect(typeof data.tokens.refreshToken).toBe('string');
    });

    it('returns 401 UNAUTHORIZED for incorrect password', async () => {
      const email = 'login-fail@example.com';
      await auth.createUser({ email, password: 'CorrectPassword!123' });

      const res = await app.request.post('/api/auth/login').send({
        email,
        password: 'WrongPassword!123',
      });

      const error = expectError(res, 401, 'UNAUTHORIZED');
      expect(error.message).toBe('Invalid email or password');
    });

    it('returns 401 UNAUTHORIZED for nonexistent email', async () => {
      const res = await app.request.post('/api/auth/login').send({
        email: 'nonexistent@example.com',
        password: 'SomePassword!123',
      });

      const error = expectError(res, 401, 'UNAUTHORIZED');
      expect(error.message).toBe('Invalid email or password');
    });

    it('locks account and returns 423 ACCOUNT_LOCKED with Retry-After header on 5th failed attempt', async () => {
      const email = 'lockout@example.com';
      await auth.createUser({ email, password: 'RealPassword!123' });

      // Attempts 1 to 4 should fail with 401
      for (let attempt = 1; attempt <= 4; attempt++) {
        const failRes = await app.request.post('/api/auth/login').send({
          email,
          password: `WrongPassword${attempt}!`,
        });
        expect(failRes.status).toBe(401);
      }

      // 5th attempt reaches max attempts, triggers lockout and returns 423
      const lockedRes = await app.request.post('/api/auth/login').send({
        email,
        password: 'WrongPassword5!',
      });

      const error = expectError(lockedRes, 423, 'ACCOUNT_LOCKED');
      expect(error.message).toContain('Account temporarily locked');

      const retryAfter = lockedRes.headers['retry-after'];
      expect(retryAfter).toBeDefined();
      expect(Number(retryAfter)).toBeGreaterThan(0);

      // Subsequent attempt while locked also returns 423
      const lockedAgainRes = await app.request.post('/api/auth/login').send({
        email,
        password: 'RealPassword!123',
      });
      expectError(lockedAgainRes, 423, 'ACCOUNT_LOCKED');
    });
  });
});
