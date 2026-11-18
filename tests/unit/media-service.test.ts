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
import { ObjectStoreException, VirusScannerException } from '@/core/errors/repository.error.js';
import { MediaObjectRecord } from '@/modules/media/logic/entities/media-object-record.js';
import { MediaService } from '@/modules/media/logic/media.service.js';
import type { MediaObjectRepository } from '@/modules/media/logic/ports/media-object.repository.js';
import type { ObjectStore } from '@/modules/media/logic/ports/object-store.js';
import type { ScanResult, VirusScanner } from '@/modules/media/logic/ports/virus-scanner.js';

const OWNER = '01920000-0000-7000-8000-0000000000aa';
const ID = '01920000-0000-7000-8000-0000000000bb';
const KEY = `media/${OWNER}/${ID}.png`;
const VERSION = 'minio-version-1';
const HASH = createHash('sha256').update('bytes').digest('hex');

class FakeRepository implements MediaObjectRepository {
  record: MediaObjectRecord | null = null;
  deleted: string[] = [];
  failed: string[] = [];
  markFailedCalls = 0;

  seed(status: MediaObjectRecord['status'] = 'pending', versionId: string | null = null) {
    this.record = new MediaObjectRecord(
      ID,
      OWNER,
      KEY,
      versionId,
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

  transitionToReady(
    _id: string,
    _owner: string,
    sha: string | null,
    versionId: string | null,
  ): Promise<MediaObjectRecord | null> {
    if (this.record?.status !== 'pending') {
      return Promise.resolve(null);
    }
    this.record = new MediaObjectRecord(
      ID,
      OWNER,
      KEY,
      versionId,
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

  transitionToQuarantined(
    _id: string,
    _owner: string,
    signature: string,
    _error: string | null,
    versionId: string | null,
  ): Promise<MediaObjectRecord | null> {
    if (this.record?.status !== 'pending') {
      return Promise.resolve(null);
    }
    this.record = new MediaObjectRecord(
      ID,
      OWNER,
      KEY,
      versionId,
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

  markFailed(
    _id: string,
    _owner: string,
    error: string,
    versionId: string | null,
  ): Promise<MediaObjectRecord | null> {
    this.markFailedCalls += 1;
    this.failed.push(error);
    if (this.record === null) {
      return Promise.resolve(null);
    }
    this.record = new MediaObjectRecord(
      ID,
      OWNER,
      KEY,
      versionId,
      'image/png',
      5,
      null,
      'failed',
      null,
      error,
      this.record.createdAt,
      new Date(),
      null,
    );
    return Promise.resolve(this.record);
  }

  deleteOwned(id: string): Promise<boolean> {
    this.deleted.push(id);
    return Promise.resolve(true);
  }
}

class FakeStore implements ObjectStore {
  metadata = { contentType: 'image/png', sizeBytes: 5, versionId: VERSION as string | null };
  exists: boolean = true;
  failStream: boolean = false;
  deletedKeys: string[] = [];
  getStreamCalls: Array<string | null> = [];
  presignGetCalls: Array<string | null> = [];

  presignPut() {
    return Promise.resolve({
      url: 'https://upload',
      headers: { 'Content-Type': 'image/png', 'Content-Length': '5' },
      expiresAt: new Date(),
    });
  }

  presignGet(_objectKey: string, versionId: string | null) {
    this.presignGetCalls.push(versionId);
    const suffix = versionId === null ? '' : `?versionId=${encodeURIComponent(versionId)}`;
    return Promise.resolve({ url: `https://download${suffix}`, expiresAt: new Date() });
  }

  head() {
    return Promise.resolve(this.exists ? this.metadata : null);
  }

  getStream(_objectKey: string, versionId: string | null) {
    this.getStreamCalls.push(versionId);
    return Promise.resolve(
      this.failStream ? Readable.from(this.failingBytes()) : Readable.from([Buffer.from('bytes')]),
    );
  }

  delete(key: string): Promise<void> {
    this.deletedKeys.push(key);
    return Promise.resolve();
  }

  private *failingBytes(): Generator<Buffer> {
    yield Buffer.from('by');
    throw new Error('raw storage read failure must not leak');
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

  it('captures the object version and pins the scan and download URL to it', async () => {
    objects.seed();
    const result = await service.finalize(OWNER, ID);
    expect(store.getStreamCalls).toEqual([VERSION]);
    expect(store.presignGetCalls).toEqual([VERSION]);
    expect(objects.record?.versionId).toBe(VERSION);
    expect(result.url).toContain(`versionId=${VERSION}`);
    expect(result.status).toBe('ready');
    expect(result.sha256).toBe(HASH);
  });

  it('persists the version id when quarantining an infected object', async () => {
    objects.seed();
    scanner.mode = 'infected';
    await expect(service.finalize(OWNER, ID)).rejects.toThrow(MediaInfectedException);
    expect(objects.record?.status).toBe('quarantined');
    expect(objects.record?.scanSignature).toBe('Eicar');
    expect(objects.record?.versionId).toBe(VERSION);
    expect(store.getStreamCalls).toEqual([VERSION]);
  });

  it('marks the row failed and reports a storage-stream error without a scanner-outage code', async () => {
    objects.seed();
    store.failStream = true;
    await expect(service.finalize(OWNER, ID)).rejects.toThrow(ObjectStoreException);
    expect(objects.record?.status).toBe('failed');
    expect(objects.record?.versionId).toBe(VERSION);
    expect(objects.markFailedCalls).toBe(1);
    expect(store.getStreamCalls).toEqual([VERSION]);
    expect(store.presignGetCalls).toEqual([]);
  });

  it('leaves the row pending when the scanner is unavailable', async () => {
    objects.seed();
    scanner.mode = 'unavailable';
    await expect(service.finalize(OWNER, ID)).rejects.toThrow(MediaScanUnavailableException);
    expect(objects.record?.status).toBe('pending');
    expect(objects.markFailedCalls).toBe(0);
  });

  it('finalizes and downloads without a bucket version id', async () => {
    objects.seed();
    store.metadata.versionId = null;
    const result = await service.finalize(OWNER, ID);
    expect(store.getStreamCalls).toEqual([null]);
    expect(store.presignGetCalls).toEqual([null]);
    expect(objects.record?.versionId).toBeNull();
    expect(result.url).toBe('https://download');
  });

  it('skips scanning only when configuration explicitly disables it', async () => {
    objects.seed();
    const bypass = new MediaService(objects, store, scanner, config(false));
    const result = await bypass.finalize(OWNER, ID);
    expect(result.status).toBe('ready');
    expect(result.sha256).toBeNull();
    expect(objects.record?.versionId).toBe(VERSION);
    expect(store.getStreamCalls).toEqual([]);
  });

  it('rejects missing, already-finalized, and metadata-mismatched objects', async () => {
    await expect(service.finalize(OWNER, ID)).rejects.toThrow(MediaNotFoundException);
    objects.seed('ready');
    await expect(service.finalize(OWNER, ID)).rejects.toThrow(MediaNotReadyException);

    objects.seed();
    store.metadata = { contentType: 'image/gif', sizeBytes: 5, versionId: VERSION };
    await expect(service.finalize(OWNER, ID)).rejects.toThrow(InvalidMediaInputException);
    expect(objects.failed).toHaveLength(1);
    expect(objects.markFailedCalls).toBe(1);
    expect(objects.record?.versionId).toBe(VERSION);
  });

  it('issues download URLs pinned to the stored version for ready objects', async () => {
    objects.seed('quarantined', VERSION);
    await expect(service.getDownload(OWNER, ID)).rejects.toThrow(MediaNotReadyException);
    objects.seed('ready', VERSION);
    expect((await service.getDownload(OWNER, ID)).url).toBe(
      `https://download?versionId=${VERSION}`,
    );
    expect(store.presignGetCalls).toEqual([VERSION]);
  });

  it('deletes the S3 object before the database row', async () => {
    objects.seed('ready');
    await service.remove(OWNER, ID);
    expect(store.deletedKeys).toEqual([KEY]);
    expect(objects.deleted).toEqual([ID]);
  });
});
