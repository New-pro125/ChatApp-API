import { Readable } from 'node:stream';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@/core/config/app.config.js';
import { S3ObjectStore } from '@/modules/media/data/s3-object.store.js';
import { MediaPresignOptions } from '@/modules/media/logic/media-presign.options.js';

const options = new MediaPresignOptions();

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

describe('S3ObjectStore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('signs exact PUT headers and GET access with configured settings', async () => {
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

    const get = await store.presignGet('media/o/i.png', null);
    expect(get.url).toContain('X-Amz-Expires=60');
    expect(new URL(get.url).searchParams.has('versionId')).toBe(false);
    expect(get.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('pins a presigned GET to the supplied version id', async () => {
    const store = new S3ObjectStore(config, new MediaPresignOptions());
    const get = await store.presignGet('media/o/i.png', 'version-1');
    expect(new URL(get.url).searchParams.get('versionId')).toBe('version-1');
  });

  it('captures HEAD version ids and sends version-pinned GET commands', async () => {
    const clientPrototype = Object.getPrototypeOf(S3Client.prototype) as {
      send(command: unknown): Promise<unknown>;
    };
    const sent: unknown[] = [];
    vi.spyOn(clientPrototype, 'send').mockImplementation((command: unknown) => {
      sent.push(command);
      if (command instanceof HeadObjectCommand) {
        return Promise.resolve({
          ContentType: 'image/png',
          ContentLength: 5,
          VersionId: 'version-1',
        });
      }
      if (command instanceof GetObjectCommand) {
        return Promise.resolve({ Body: Readable.from([Buffer.from('bytes')]) });
      }
      return Promise.resolve({});
    });

    const store = new S3ObjectStore(config, new MediaPresignOptions());
    await expect(store.head('media/o/i.png')).resolves.toEqual({
      contentType: 'image/png',
      sizeBytes: 5,
      versionId: 'version-1',
    });
    await store.getStream('media/o/i.png', 'version-1');
    await store.getStream('media/o/i.png', null);

    const head = sent.find((command) => command instanceof HeadObjectCommand);
    expect(head).toBeInstanceOf(HeadObjectCommand);
    expect((head as HeadObjectCommand).input).toMatchObject({
      Bucket: 'bucket',
      Key: 'media/o/i.png',
    });

    const gets = sent.filter((command) => command instanceof GetObjectCommand);
    expect(gets).toHaveLength(2);
    expect((gets[0] as GetObjectCommand).input).toMatchObject({
      Bucket: 'bucket',
      Key: 'media/o/i.png',
      VersionId: 'version-1',
    });
    expect((gets[1] as GetObjectCommand).input).toMatchObject({
      Bucket: 'bucket',
      Key: 'media/o/i.png',
    });
    expect((gets[1] as GetObjectCommand).input.VersionId).toBeUndefined();
  });
});
