import { describe, expect, it } from 'vitest';
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
