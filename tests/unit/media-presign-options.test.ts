import { describe, expect, it } from 'vitest';
import type { AppConfig } from '@/core/config/app.config.js';
import { S3ObjectStore } from '@/modules/media/data/s3-object.store.js';
import { MediaPresignOptions } from '@/modules/media/logic/media-presign.options.js';

const options = new MediaPresignOptions();

describe('MediaPresignOptions', () => {
  it('builds exact PUT headers and the configured TTL', () => {
    const before = Date.now();
    const put = options.put('bucket', 'media/o/i.png', 'image/png', 1234, 300);
    expect(put).toMatchObject({
      bucket: 'bucket',
      key: 'media/o/i.png',
      contentType: 'image/png',
      sizeBytes: 1234,
      expiresIn: 300,
      headers: { 'Content-Type': 'image/png', 'Content-Length': '1234' },
    });
    expect(put.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 300_000);
  });

  it('builds a GET option without upload headers', () => {
    const get = options.get('bucket', 'media/o/i.png', 60);
    expect(get).toMatchObject({ bucket: 'bucket', key: 'media/o/i.png', expiresIn: 60 });
    expect(get).not.toHaveProperty('headers');
  });
});

describe('S3ObjectStore presigning', () => {
  it('signs exact PUT headers and GET access with configured settings', async () => {
    const config = {
      media: {
        bucket: 'bucket',
        region: 'us-east-1',
        endpoint: 'http://localhost:9000',
        accessKeyId: 'key',
        secretAccessKey: 'secret',
        forcePathStyle: true,
        maxBytes: 100,
        allowedContentTypes: ['image/png'],
        presignTtlSeconds: 60,
        scanRequired: true,
      },
    } as unknown as AppConfig;
    const store = new S3ObjectStore(config, new MediaPresignOptions());

    const put = await store.presignPut('media/o/i.png', 'image/png', 12);
    expect(put.headers).toEqual({ 'Content-Type': 'image/png', 'Content-Length': '12' });
    expect(put.url).toContain('X-Amz-Expires=60');
    expect(put.url).toContain('localhost:9000');

    const signedHeaders = new Set(
      new URL(put.url).searchParams.get('X-Amz-SignedHeaders')?.split(';') ?? [],
    );
    expect(signedHeaders.has('content-type')).toBe(true);
    expect(signedHeaders.has('content-length')).toBe(true);

    const get = await store.presignGet('media/o/i.png');
    expect(get.url).toContain('X-Amz-Expires=60');
    expect(get.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
