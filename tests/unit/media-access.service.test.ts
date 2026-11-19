import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MediaInUseException } from '@/core/errors/domain.error.js';
import type { MediaAccess } from '@/core/media/media-access.port.js';
import type { MediaService } from '@/modules/media/logic/media.service.js';
import { MediaAccessService } from '@/modules/media/logic/media-access.service.js';

class FakeMediaService {
  calls: string[] = [];
  requireReadyForUse(): Promise<unknown> {
    this.calls.push('requireReadyForUse');
    return Promise.resolve({ id: 'm1', contentType: 'image/png', sizeBytes: 12, sha256: 'h' });
  }
  storeAndScan(): Promise<unknown> {
    this.calls.push('storeAndScan');
    return Promise.resolve({ id: 'm2', contentType: 'image/png', sizeBytes: 12, sha256: 'h' });
  }
  signForReader(): Promise<unknown> {
    this.calls.push('signForReader');
    return Promise.resolve({
      url: 'https://signed',
      expiresAt: new Date(),
      contentType: 'image/png',
      sizeBytes: 12,
    });
  }
  releaseIfUnreferenced(): Promise<void> {
    this.calls.push('releaseIfUnreferenced');
    return Promise.resolve();
  }
  assertDeletable(): Promise<void> {
    this.calls.push('assertDeletable');
    return Promise.reject(new MediaInUseException());
  }
}

function service(): { access: MediaAccess; media: FakeMediaService } {
  const media = new FakeMediaService();
  return { access: new MediaAccessService(media as unknown as MediaService), media };
}

describe('MediaAccessService', () => {
  it('delegates owner-checked attachment and chat-authorized signing', async () => {
    const { access, media } = service();
    await expect(access.requireReadyOwned('m1', 'u1')).resolves.toMatchObject({ id: 'm1' });
    await expect(access.signDownload('m1')).resolves.toMatchObject({ url: 'https://signed' });
    expect(media.calls).toEqual(['requireReadyForUse', 'signForReader']);
  });

  it('delegates release and delete guards', async () => {
    const { access, media } = service();
    await access.releaseIfUnreferenced('m1');
    await expect(access.assertDeletable('m1')).rejects.toThrow(MediaInUseException);
    expect(media.calls).toEqual(['releaseIfUnreferenced', 'assertDeletable']);
  });

  it('streams an incoming upload through storeAndScan', async () => {
    const { access, media } = service();
    const input = {
      contentType: 'image/png',
      sizeBytes: 12,
      body: Readable.from([Buffer.from('012345678901')]),
      assertComplete: async () => undefined,
    };
    await expect(access.storeAndScan('u1', input)).resolves.toMatchObject({ id: 'm2' });
    expect(media.calls).toEqual(['storeAndScan']);
  });
});
