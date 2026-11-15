import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { StubCaptchaVerifier } from '../../fixtures/stub-captcha.verifier.js';
import { expectError, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';

describe('Auth: Captcha', () => {
  let app: TestApp;
  let auth: AuthFixture;
  let captcha: StubCaptchaVerifier;

  beforeAll(async () => {
    app = await TestApp.create();
    auth = new AuthFixture(app);
    captcha = new StubCaptchaVerifier();
    auth.useCaptchaVerifier(captcha);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
    auth.emails.clear();
    captcha.reset();
  });

  describe('POST /api/auth/register', () => {
    it('requires a captcha token when captcha is enabled', async () => {
      const res = await app.request.post('/api/auth/register').send({
        email: 'no-captcha@example.com',
        displayName: 'No Captcha',
        password: 'StrongPassword!123',
      });

      expectError(res, 400, 'CAPTCHA_REQUIRED');
      expect(captcha.calls).toHaveLength(0);

      const users = await app.pool.query('SELECT count(*)::int AS count FROM users');
      expect(users.rows[0]?.count).toBe(0);
    });

    it('rejects registration when the captcha token is invalid', async () => {
      captcha.result = false;

      const res = await app.request.post('/api/auth/register').send({
        email: 'bad-captcha@example.com',
        displayName: 'Bad Captcha',
        password: 'StrongPassword!123',
        captchaToken: 'invalid-turnstile-token',
      });

      expectError(res, 400, 'CAPTCHA_INVALID');
      expect(captcha.calls[0]?.token).toBe('invalid-turnstile-token');
      expect(typeof captcha.calls[0]?.remoteIp).toBe('string');

      const users = await app.pool.query('SELECT count(*)::int AS count FROM users');
      expect(users.rows[0]?.count).toBe(0);
    });

    it('creates the account when the captcha token is valid', async () => {
      const res = await app.request.post('/api/auth/register').send({
        email: 'good-captcha@example.com',
        displayName: 'Good Captcha',
        password: 'StrongPassword!123',
        captchaToken: 'valid-turnstile-token',
      });

      const data = expectSuccess<{ user: { email: string } }>(res, 201);
      expect(data.user.email).toBe('good-captcha@example.com');
      expect(captcha.calls).toHaveLength(1);
    });
  });

  describe('POST /api/auth/login', () => {
    it('requires a captcha token before evaluating credentials', async () => {
      const email = 'login-captcha@example.com';
      await auth.createUser({ email, password: 'StrongPassword!123' });

      const res = await app.request
        .post('/api/auth/login')
        .send({ email, password: 'StrongPassword!123' });

      expectError(res, 400, 'CAPTCHA_REQUIRED');
      expect(captcha.calls).toHaveLength(0);
    });

    it('does not increment failed login attempts when captcha fails', async () => {
      const email = 'captcha-lockout@example.com';
      const user = await auth.createUser({ email, password: 'StrongPassword!123' });
      captcha.result = false;

      const res = await app.request.post('/api/auth/login').send({
        email,
        password: 'WrongPassword!123',
        captchaToken: 'invalid-turnstile-token',
      });

      expectError(res, 400, 'CAPTCHA_INVALID');

      const rows = await app.pool.query<{
        failed_login_attempts: number;
        locked_until: Date | null;
      }>('SELECT failed_login_attempts, locked_until FROM users WHERE id = $1', [user.id]);

      expect(rows.rows[0]?.failed_login_attempts).toBe(0);
      expect(rows.rows[0]?.locked_until).toBeNull();
    });

    it('does not reveal whether an email exists when captcha fails', async () => {
      captcha.result = false;

      const res = await app.request.post('/api/auth/login').send({
        email: 'missing@example.com',
        password: 'StrongPassword!123',
        captchaToken: 'invalid-turnstile-token',
      });

      expectError(res, 400, 'CAPTCHA_INVALID');
    });

    it('authenticates when the captcha token is valid', async () => {
      const email = 'login-good-captcha@example.com';
      await auth.createUser({ email, password: 'StrongPassword!123' });

      const res = await app.request.post('/api/auth/login').send({
        email,
        password: 'StrongPassword!123',
        captchaToken: 'valid-turnstile-token',
      });

      const data = expectSuccess<{ tokens: { accessToken: string } }>(res, 200);
      expect(typeof data.tokens.accessToken).toBe('string');
      expect(captcha.calls).toHaveLength(1);
    });
  });
});
