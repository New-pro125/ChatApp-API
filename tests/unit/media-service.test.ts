import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '@/core/config/app.config.js';
import {
  InvalidMediaInputException,
  MediaInfectedException,
  MediaNotFoundException,
  MediaNotReadyException,
  MediaScanUnavailableException,
} from '@/core/errors/domain.error.js';
import { VirusScannerException } from '@/core/errors/repository.error.js';
import { MediaObjectRecord } from '@/modules/media/logic/entities/media-object-record.js';
import { MediaService } from '@/modules/media/logic/media.service.js';
import type { MediaObjectRepository } from '@/modules/media/logic/ports/media-object.repository.js';
import type { ObjectStore } from '@/modules/media/logic/ports/object-store.js';
import type { ScanResult, VirusScanner } from '@/modules/media/logic/ports/virus-scanner.js';

const OWNER = '01920000-0000-7000-8000-0000000000aa';
const ID = '01920000-0000-7000-8000-0000000000bb';
const KEY = `media/${OWNER}/${ID}.png`;
const HASH = createHash('sha256').update('bytes').digest('hex');

class FakeRepository implements MediaObjectRepository {
  record: MediaObjectRecord | null = null;
  deleted: string[] = [];
  failed: string[] = [];

  seed(status: MediaObjectRecord['status'] = 'pending'): MediaObjectRecord {
    this.record = new MediaObjectRecord(
      ID,
      OWNER,
      KEY,
      'image/png',
      5,
      null,
      status,
      null,
      null,
      new Date(),
      new Date(),
      null,
    );
    return this.record;
  }

  create(): Promise<MediaObjectRecord> {
    return Promise.resolve(this.seed());
  }

  findOwned(): Promise<MediaObjectRecord | null> {
    return Promise.resolve(this.record);
  }

  transitionToReady(_id: string, _owner: string, sha: string | null) {
    if (this.record?.status !== 'pending') {
      return Promise.resolve(null);
    }
    this.record = new MediaObjectRecord(
      ID,
      OWNER,
      KEY,
      'image/png',
      5,
      sha,
      'ready',
      null,
      null,
      this.record.createdAt,
      new Date(),
      new Date(),
    );
    return Promise.resolve(this.record);
  }

  transitionToQuarantined(_id: string, _owner: string, signature: string) {
    if (this.record?.status !== 'pending') {
      return Promise.resolve(null);
    }
    this.record = new MediaObjectRecord(
      ID,
      OWNER,
      KEY,
      'image/png',
      5,
      null,
      'quarantined',
      signature,
      null,
      this.record.createdAt,
      new Date(),
      new Date(),
    );
    return Promise.resolve(this.record);
  }

  markFailed(_id: string, _owner: string, error: string) {
    this.failed.push(error);
    return Promise.resolve(this.record);
  }

  deleteOwned(id: string): Promise<boolean> {
    this.deleted.push(id);
    return Promise.resolve(true);
  }
}

class FakeStore implements ObjectStore {
  metadata = { contentType: 'image/png', sizeBytes: 5 };
  exists: boolean = true;
  deletedKeys: string[] = [];

  presignPut() {
    return Promise.resolve({
      url: 'https://upload',
      headers: { 'Content-Type': 'image/png', 'Content-Length': '5' },
      expiresAt: new Date(),
    });
  }

  presignGet() {
    return Promise.resolve({ url: 'https://download', expiresAt: new Date() });
  }

  head() {
    return Promise.resolve(this.exists ? this.metadata : null);
  }

  getStream() {
    return Promise.resolve(Readable.from([Buffer.from('bytes')]));
  }

  delete(key: string): Promise<void> {
    this.deletedKeys.push(key);
    return Promise.resolve();
  }
}

class FakeScanner implements VirusScanner {
  mode: 'clean' | 'infected' | 'unavailable' = 'clean';

  async scan(stream: Readable): Promise<ScanResult> {
    for await (const _chunk of stream) {
      /* drain */
    }
    if (this.mode === 'unavailable') {
      throw new VirusScannerException('scanner down');
    }
    if (this.mode === 'infected') {
      return { verdict: 'infected', signature: 'Eicar' };
    }
    return { verdict: 'clean' };
  }
}

const config = (scanRequired = true): AppConfig =>
  ({
    media: {
      bucket: 'bucket',
      region: 'us-east-1',
      endpoint: 'http://localhost:9000',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      forcePathStyle: true,
      maxBytes: 100,
      allowedContentTypes: ['image/png', 'application/pdf'],
      presignTtlSeconds: 300,
      scanRequired,
    },
  }) as unknown as AppConfig;

describe('MediaService', () => {
  let objects: FakeRepository;
  let store: FakeStore;
  let scanner: FakeScanner;
  let service: MediaService;

  beforeEach(() => {
    objects = new FakeRepository();
    store = new FakeStore();
    scanner = new FakeScanner();
    service = new MediaService(objects, store, scanner, config());
  });

  it('rejects a type outside the allowlist or a size outside the cap', async () => {
    await expect(service.initiate(OWNER, 'image/svg+xml', 5)).rejects.toThrow(
      InvalidMediaInputException,
    );
    await expect(service.initiate(OWNER, 'image/png', 0)).rejects.toThrow(
      InvalidMediaInputException,
    );
    await expect(service.initiate(OWNER, 'image/png', 101)).rejects.toThrow(
      InvalidMediaInputException,
    );
  });

  it('issues a presigned PUT for a new pending object', async () => {
    const ticket = await service.initiate(OWNER, 'image/png', 5);
    expect(ticket.mediaId).toBe(ID);
    expect(ticket.objectKey).toBe(KEY);
    expect(ticket.url).toBe('https://upload');
    expect(ticket.headers['Content-Length']).toBe('5');
  });

  it('finalizes a clean scan with a sha256 and a download URL', async () => {
    objects.seed();
    const result = await service.finalize(OWNER, ID);
    expect(result.status).toBe('ready');
    expect(result.sha256).toBe(HASH);
    expect(result.url).toBe('https://download');
  });

  it('quarantines an infected object and never returns a download URL', async () => {
    objects.seed();
    scanner.mode = 'infected';
    await expect(service.finalize(OWNER, ID)).rejects.toThrow(MediaInfectedException);
    expect(objects.record?.status).toBe('quarantined');
    expect(objects.record?.scanSignature).toBe('Eicar');
  });

  it('maps scanner failures to MEDIA_SCAN_UNAVAILABLE and leaves the row pending', async () => {
    objects.seed();
    scanner.mode = 'unavailable';
    await expect(service.finalize(OWNER, ID)).rejects.toThrow(MediaScanUnavailableException);
    expect(objects.record?.status).toBe('pending');
  });

  it('skips scanning only when configuration explicitly disables it', async () => {
    objects.seed();
    const bypass = new MediaService(objects, store, scanner, config(false));
    const result = await bypass.finalize(OWNER, ID);
    expect(result.status).toBe('ready');
    expect(result.sha256).toBeNull();
  });

  it('rejects missing, already-finalized, and metadata-mismatched objects', async () => {
    await expect(service.finalize(OWNER, ID)).rejects.toThrow(MediaNotFoundException);
    objects.seed('ready');
    await expect(service.finalize(OWNER, ID)).rejects.toThrow(MediaNotReadyException);

    objects.seed();
    store.metadata = { contentType: 'image/gif', sizeBytes: 5 };
    await expect(service.finalize(OWNER, ID)).rejects.toThrow(InvalidMediaInputException);
    expect(objects.failed).toHaveLength(1);
  });

  it('issues download URLs only for ready objects', async () => {
    objects.seed('quarantined');
    await expect(service.getDownload(OWNER, ID)).rejects.toThrow(MediaNotReadyException);
    objects.seed('ready');
    expect((await service.getDownload(OWNER, ID)).url).toBe('https://download');
  });

  it('deletes the S3 object before the database row', async () => {
    objects.seed('ready');
    await service.remove(OWNER, ID);
    expect(store.deletedKeys).toEqual([KEY]);
    expect(objects.deleted).toEqual([ID]);
  });
});
