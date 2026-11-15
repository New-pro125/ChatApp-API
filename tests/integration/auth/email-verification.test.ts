import type { NextFunction, Request, Response } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequireVerifiedEmailMiddleware } from '@/core/auth/require-verified-email.middleware.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { EmailNotVerifiedException } from '@/core/errors/domain.error.js';
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
  });

  describe('POST /api/auth/email/resend', () => {
    it('issues a new code when the cooldown has elapsed', async () => {
      const user = await auth.createUser({ email: 'resend@example.com' });
      const tokens = await auth.mintTokens(user);

      const res = await app.request
        .post('/api/auth/email/resend')
        .set(auth.bearerHeader(tokens.accessToken));

      expectSuccess(res, 202);
      expect(auth.emails.verificationCodeFor(user.email)).toMatch(/^\d{6}$/);
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
      user: { emailVerifiedAt: Date | null } | undefined,
    ): unknown => {
      const req = { user } as unknown as Request;
      const res = {} as Response;
      const next = vi.fn() as unknown as NextFunction;

      middleware.handle(req, res, next);

      return (next as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0];
    };

    it('blocks unverified users with EMAIL_NOT_VERIFIED', () => {
      const middleware = app.container.get<RequireVerifiedEmailMiddleware>(
        CORE_TYPES.RequireVerifiedEmail,
      );

      const result = callMiddleware(middleware, { emailVerifiedAt: null });

      expect(result).toBeInstanceOf(EmailNotVerifiedException);
    });

    it('allows verified users through', () => {
      const middleware = app.container.get<RequireVerifiedEmailMiddleware>(
        CORE_TYPES.RequireVerifiedEmail,
      );

      const result = callMiddleware(middleware, { emailVerifiedAt: new Date() });

      expect(result).toBeUndefined();
    });
  });
});
