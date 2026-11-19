import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MediaObjectKeyFactory } from '@/modules/media/logic/media-object-key.factory.js';
import type { ObjectStore } from '@/modules/media/logic/ports/object-store.js';
import type { MediaModule } from '@/modules/media/media.module.js';
import { MEDIA_TYPES } from '@/modules/media/media.types.js';
import { TestApp } from '../../helpers/test-app.js';

describe('ObjectStore.putStream', () => {
  let app: TestApp;
  let store: ObjectStore;
  let keys: MediaObjectKeyFactory;
  const key = `media/test/${randomUUID()}.png`;
  const bytes = Buffer.from('streamed-media-bytes');

  beforeAll(async () => {
    app = await TestApp.create();
    const module = app.application.getModule<MediaModule>('media');
    if (module === undefined) {
      throw new Error('media module is not registered');
    }
    const container = module.mediaContainer;
    store = container.get<ObjectStore>(MEDIA_TYPES.ObjectStore);
    keys = container.get<MediaObjectKeyFactory>(MEDIA_TYPES.MediaObjectKeyFactory);
  });

  afterAll(async () => {
    await store.delete(key).catch(() => undefined);
    await app.close();
  });

  it('uploads a bounded stream and reads identical bytes', async () => {
    await store.putStream(key, 'image/png', bytes.length, Readable.from([bytes]));

    const head = await store.head(key);
    expect(head?.contentType).toBe('image/png');
    expect(head?.sizeBytes).toBe(bytes.length);

    const chunks: Buffer[] = [];
    for await (const chunk of await store.getStream(key, head?.versionId ?? null)) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
  });

  it.each([
    ['video/webm', 'webm'],
    ['audio/ogg', 'ogg'],
    ['audio/wav', 'wav'],
    ['audio/webm', 'webm'],
    ['audio/mp4', 'm4a'],
  ])('builds a key for %s', (contentType, extension) => {
    expect(keys.build('owner', 'media', contentType)).toBe(`media/owner/media.${extension}`);
  });
});
