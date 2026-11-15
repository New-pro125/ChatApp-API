import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@/core/config/app.config.js';
import { CaptchaUnavailableException } from '@/core/errors/domain.error.js';
import { TurnstileCaptchaVerifier } from '@/modules/auth/data/turnstile-captcha.verifier.js';

const config = (overrides: Partial<AppConfig['captcha']> = {}) =>
  ({
    captcha: {
      enabled: true,
      secret: 'turnstile-secret',
      verifyUrl: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      timeoutMs: 5000,
      expectedHostname: null,
      expectedAction: null,
      ...overrides,
    },
  }) as AppConfig;

const logger = (): Logger =>
  ({
    error: vi.fn(),
    warn: vi.fn(),
  }) as unknown as Logger;

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const verify = (
  payload: unknown,
  options: Partial<AppConfig['captcha']> = {},
): Promise<boolean> => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload)));

  return new TurnstileCaptchaVerifier(config(options), logger()).verify({
    token: 'client-token',
    remoteIp: '203.0.113.7',
  });
};

describe('TurnstileCaptchaVerifier', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts a successful verification', async () => {
    await expect(verify({ success: true })).resolves.toBe(true);
  });

  it('sends the secret, response token, and client IP to Cloudflare', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);

    const verifier = new TurnstileCaptchaVerifier(config(), logger());
    await verifier.verify({ token: 'client-token', remoteIp: '203.0.113.7' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(init.method).toBe('POST');

    const body = init.body as URLSearchParams;
    expect(body.get('secret')).toBe('turnstile-secret');
    expect(body.get('response')).toBe('client-token');
    expect(body.get('remoteip')).toBe('203.0.113.7');
  });

  it('rejects an unsuccessful verification', async () => {
    await expect(
      verify({ success: false, 'error-codes': ['invalid-input-response'] }),
    ).resolves.toBe(false);
  });

  it('rejects a mismatched hostname when one is expected', async () => {
    await expect(
      verify({ success: true, hostname: 'evil.example' }, { expectedHostname: 'app.example' }),
    ).resolves.toBe(false);
  });

  it('rejects a mismatched action when one is expected', async () => {
    await expect(
      verify({ success: true, action: 'register' }, { expectedAction: 'login' }),
    ).resolves.toBe(false);
  });

  it('accepts matching hostname and action', async () => {
    await expect(
      verify(
        { success: true, hostname: 'app.example', action: 'login' },
        { expectedHostname: 'app.example', expectedAction: 'login' },
      ),
    ).resolves.toBe(true);
  });

  it('treats a non-success HTTP status as unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('upstream error', { status: 502 })),
    );

    const verifier = new TurnstileCaptchaVerifier(config(), logger());

    await expect(verifier.verify({ token: 'token', remoteIp: null })).rejects.toBeInstanceOf(
      CaptchaUnavailableException,
    );
  });

  it('treats a network failure as unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const verifier = new TurnstileCaptchaVerifier(config(), logger());

    await expect(verifier.verify({ token: 'token', remoteIp: null })).rejects.toBeInstanceOf(
      CaptchaUnavailableException,
    );
  });

  it('treats malformed JSON as unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json', { status: 200 })));

    const verifier = new TurnstileCaptchaVerifier(config(), logger());

    await expect(verifier.verify({ token: 'token', remoteIp: null })).rejects.toBeInstanceOf(
      CaptchaUnavailableException,
    );
  });
});
