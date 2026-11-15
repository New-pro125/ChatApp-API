import type { NextFunction, Request, Response } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequireVerifiedEmailMiddleware } from '@/core/auth/require-verified-email.middleware.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { EmailNotVerifiedException } from '@/core/errors/domain.error.js';
import { AuthenticatedUser } from '@/modules/auth/logic/entities/authenticated-user.js';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { expectError, expectNoContent, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';

interface AuthenticatedUserBody {
  id: string;
  email: string;
  emailVerifiedAt: string | null;
}

interface AuthenticationBody {
  user: AuthenticatedUserBody;
  tokens: { accessToken: string; refreshToken: string };
}

describe('Auth: Email Verification', () => {
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
    auth.emails.clear();
  });

  describe('POST /api/auth/register', () => {
    it('sends a verification code and leaves the new account unverified', async () => {
      const { response, email } = await auth.register();

      const data = expectSuccess<AuthenticationBody>(response, 201);

      expect(data.user.emailVerifiedAt).toBeNull();
      expect(auth.emails.verificationCodeFor(email)).toMatch(/^\d{6}$/);

      const meRes = await app.request
        .get('/api/auth/me')
        .set(auth.bearerHeader(data.tokens.accessToken));

      const me = expectSuccess<AuthenticatedUserBody>(meRes, 200);
      expect(me.emailVerifiedAt).toBeNull();
    });
    it('stores the code only as an Argon2 hash', async () => {
      const { email } = await auth.register();
      const code = await auth.waitForVerificationCode(email);

      const rows = await app.pool.query<{ code_hash: string }>(
        'SELECT code_hash FROM email_verification_codes WHERE user_id = (SELECT id FROM users WHERE email = $1)',
        [email],
      );

      const codeHash = rows.rows[0]?.code_hash;
      expect(codeHash).toBeDefined();
      expect(codeHash).not.toBe(code);
      expect(codeHash).toMatch(/^\$argon2/);
    });

    it('succeeds when the verification email cannot be delivered', async () => {
      auth.emails.failVerificationSends = true;

      const res = await app.request.post('/api/auth/register').send({
        email: 'smtp-down@example.com',
        displayName: 'SMTP Down',
        password: 'StrongPassword!123',
      });

      expectSuccess<AuthenticationBody>(res, 201);
      expect(auth.emails.verificationCodeFor('smtp-down@example.com')).toBeUndefined();

      const deadline = Date.now() + 5000;

      while (auth.emails.verificationSendAttempts === 0) {
        if (Date.now() >= deadline) {
          throw new Error('Timed out waiting for the verification send attempt');
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const rows = await app.pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM email_verification_codes WHERE user_id = (SELECT id FROM users WHERE email = $1)',
        ['smtp-down@example.com'],
      );
      expect(rows.rows[0]?.count).toBe(1);
    });
  });

  describe('POST /api/auth/email/resend', () => {
    it('issues a new code once the cooldown has elapsed and invalidates the old one', async () => {
      const { response, email } = await auth.register();
      const data = expectSuccess<AuthenticationBody>(response, 201);
      const firstCode = await auth.waitForVerificationCode(email);

      await app.pool.query(
        "UPDATE email_verification_codes SET created_at = now() - interval '2 minutes' WHERE user_id = $1",
        [data.user.id],
      );

      const res = await app.request
        .post('/api/auth/email/resend')
        .set(auth.bearerHeader(data.tokens.accessToken));

      expectSuccess(res, 202);

      const secondCode = auth.emails.verificationCodeFor(email);
      expect(secondCode).toMatch(/^\d{6}$/);
      expect(secondCode).not.toBe(firstCode);

      const oldCodeRes = await app.request
        .post('/api/auth/email/verify')
        .set(auth.bearerHeader(data.tokens.accessToken))
        .send({ code: firstCode });

      expectError(oldCodeRes, 400, 'OTP_INVALID');

      const newCodeRes = await app.request
        .post('/api/auth/email/verify')
        .set(auth.bearerHeader(data.tokens.accessToken))
        .send({ code: secondCode });

      expectNoContent(newCodeRes);
    });

    it('allows only one of two concurrent resends', async () => {
      const user = await auth.createUser({ email: 'concurrent-resend@example.com' });
      const tokens = await auth.mintTokens(user);
      const bearer = auth.bearerHeader(tokens.accessToken);

      const first = app.request.post('/api/auth/email/resend').set(bearer);
      const second = app.request.post('/api/auth/email/resend').set(bearer);

      const responses = await Promise.all([first, second]);
      const statuses = responses.map((response) => response.status).sort();

      expect(statuses).toEqual([202, 429]);
    });

    it('returns 429 RATE_LIMITED with Retry-After inside the cooldown window', async () => {
      const { response, email } = await auth.register();
      const data = expectSuccess<AuthenticationBody>(response, 201);

      const res = await app.request
        .post('/api/auth/email/resend')
        .set(auth.bearerHeader(data.tokens.accessToken));

      const error = expectError(res, 429, 'RATE_LIMITED');
      expect(error.message).toContain('wait');

      const retryAfter = res.headers['retry-after'];
      expect(retryAfter).toBeDefined();
      expect(Number(retryAfter)).toBeGreaterThan(0);
      expect(auth.emails.verificationCodeFor(email)).toMatch(/^\d{6}$/);
    });

    it('reports a delivery failure without failing the request', async () => {
      const user = await auth.createUser({ email: 'resend-smtp-down@example.com' });
      const tokens = await auth.mintTokens(user);
      auth.emails.failVerificationSends = true;

      const res = await app.request
        .post('/api/auth/email/resend')
        .set(auth.bearerHeader(tokens.accessToken));

      expectSuccess(res, 202);
      expect(res.body.message).toContain('could not be delivered');
    });

    it('returns 409 CONFLICT when the email is already verified', async () => {
      const user = await auth.createUser({
        email: 'already-verified@example.com',
        emailVerifiedAt: new Date(),
      });
      const tokens = await auth.mintTokens(user);

      const res = await app.request
        .post('/api/auth/email/resend')
        .set(auth.bearerHeader(tokens.accessToken));

      expectError(res, 409, 'CONFLICT');
    });

    it('returns 401 UNAUTHORIZED without a bearer token', async () => {
      const res = await app.request.post('/api/auth/email/resend');

      expectError(res, 401, 'UNAUTHORIZED');
    });
  });

  describe('POST /api/auth/email/verify', () => {
    it('verifies the email with the correct single-use code', async () => {
      const user = await auth.createUser({ email: 'verify@example.com' });
      const tokens = await auth.mintTokens(user);

      await app.request.post('/api/auth/email/resend').set(auth.bearerHeader(tokens.accessToken));

      const code = auth.emails.verificationCodeFor(user.email);
      expect(code).toBeDefined();

      const res = await app.request
        .post('/api/auth/email/verify')
        .set(auth.bearerHeader(tokens.accessToken))
        .send({ code });

      expectNoContent(res);

      const meRes = await app.request
        .get('/api/auth/me')
        .set(auth.bearerHeader(tokens.accessToken));

      const me = expectSuccess<AuthenticatedUserBody>(meRes, 200);
      expect(me.emailVerifiedAt).not.toBeNull();

      // The same code cannot be replayed once consumed.
      const replayRes = await app.request
        .post('/api/auth/email/verify')
        .set(auth.bearerHeader(tokens.accessToken))
        .send({ code });

      expectError(replayRes, 400, 'OTP_EXPIRED');
    });

    it('rejects an expired code', async () => {
      const user = await auth.createUser({ email: 'expired@example.com' });
      const tokens = await auth.mintTokens(user);

      await app.request.post('/api/auth/email/resend').set(auth.bearerHeader(tokens.accessToken));

      const code = auth.emails.verificationCodeFor(user.email);
      expect(code).toBeDefined();

      await app.pool.query(
        "UPDATE email_verification_codes SET expires_at = now() - interval '1 second' WHERE user_id = $1",
        [user.id],
      );

      const res = await app.request
        .post('/api/auth/email/verify')
        .set(auth.bearerHeader(tokens.accessToken))
        .send({ code });

      expectError(res, 400, 'OTP_EXPIRED');
    });

    it('returns 401 UNAUTHORIZED without a bearer token', async () => {
      const res = await app.request.post('/api/auth/email/verify').send({ code: '123456' });

      expectError(res, 401, 'UNAUTHORIZED');
    });

    it('rejects an incorrect code and increments the attempt counter', async () => {
      const user = await auth.createUser({ email: 'wrong-code@example.com' });
      const tokens = await auth.mintTokens(user);

      await app.request.post('/api/auth/email/resend').set(auth.bearerHeader(tokens.accessToken));

      const code = auth.emails.verificationCodeFor(user.email) ?? '000000';
      const wrongCode = code === '000000' ? '111111' : '000000';

      const res = await app.request
        .post('/api/auth/email/verify')
        .set(auth.bearerHeader(tokens.accessToken))
        .send({ code: wrongCode });

      expectError(res, 400, 'OTP_INVALID');

      const rows = await app.pool.query<{ attempts: number }>(
        'SELECT attempts FROM email_verification_codes WHERE user_id = $1',
        [user.id],
      );
      expect(rows.rows[0]?.attempts).toBe(1);
    });

    it('stops accepting guesses after the attempt limit is reached', async () => {
      const user = await auth.createUser({ email: 'attempts@example.com' });
      const tokens = await auth.mintTokens(user);

      await app.request.post('/api/auth/email/resend').set(auth.bearerHeader(tokens.accessToken));

      const code = auth.emails.verificationCodeFor(user.email) ?? '000000';
      const wrongCode = code === '000000' ? '111111' : '000000';

      for (let attempt = 0; attempt < 5; attempt++) {
        const res = await app.request
          .post('/api/auth/email/verify')
          .set(auth.bearerHeader(tokens.accessToken))
          .send({ code: wrongCode });

        expectError(res, 400, 'OTP_INVALID');
      }

      const res = await app.request
        .post('/api/auth/email/verify')
        .set(auth.bearerHeader(tokens.accessToken))
        .send({ code: wrongCode });

      const error = expectError(res, 400, 'OTP_INVALID');
      expect(error.message).toContain('Too many');
    });

    it('returns 400 VALIDATION_ERROR when the code is malformed', async () => {
      const user = await auth.createUser({ email: 'malformed@example.com' });
      const tokens = await auth.mintTokens(user);

      const res = await app.request
        .post('/api/auth/email/verify')
        .set(auth.bearerHeader(tokens.accessToken))
        .send({ code: 'not-a-code' });

      expectError(res, 400, 'VALIDATION_ERROR');
    });
  });

  describe('RequireVerifiedEmailMiddleware', () => {
    const callMiddleware = (
      middleware: RequireVerifiedEmailMiddleware,
      user: AuthenticatedUser | undefined,
    ): unknown => {
      const req = { user } as unknown as Request;
      const res = {} as Response;
      const next = vi.fn() as unknown as NextFunction;

      middleware.handle(req, res, next);

      return (next as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0];
    };

    const userWithEmail = (verified: boolean): AuthenticatedUser =>
      new AuthenticatedUser(
        'user-id',
        'user@example.com',
        'Test User',
        new Date(),
        1,
        false,
        null,
        verified ? new Date() : null,
      );

    it('blocks unverified users with EMAIL_NOT_VERIFIED', () => {
      const middleware = app.container.get<RequireVerifiedEmailMiddleware>(
        CORE_TYPES.RequireVerifiedEmail,
      );

      const result = callMiddleware(middleware, userWithEmail(false));

      expect(result).toBeInstanceOf(EmailNotVerifiedException);
    });

    it('allows verified users through', () => {
      const middleware = app.container.get<RequireVerifiedEmailMiddleware>(
        CORE_TYPES.RequireVerifiedEmail,
      );

      const result = callMiddleware(middleware, userWithEmail(true));

      expect(result).toBeUndefined();
    });
  });
});
