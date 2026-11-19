import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '@/core/config/app.config.js';

const ENV_KEYS = [
  'MEDIA_BUCKET',
  'MEDIA_ACCESS_KEY_ID',
  'MEDIA_SECRET_ACCESS_KEY',
  'MEDIA_ENDPOINT',
  'MEDIA_REGION',
  'MEDIA_FORCE_PATH_STYLE',
  'MEDIA_MAX_BYTES',
  'MEDIA_ALLOWED_CONTENT_TYPES',
  'MEDIA_PRESIGN_TTL_SECONDS',
  'MEDIA_SCAN_REQUIRED',
  'CLAMAV_HOST',
  'CLAMAV_PORT',
  'CLAMAV_TIMEOUT_MS',
] as const;

const snapshot = new Map<string, string | undefined>();

describe('MediaConfig', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      snapshot.set(key, process.env[key]);
    }
  });

  afterEach(() => {
    for (const [key, value] of snapshot) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
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
