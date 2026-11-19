import { createHash, type Hash } from 'node:crypto';
import { Transform } from 'node:stream';
import { inject, injectable } from 'inversify';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import {
  InvalidMediaInputException,
  MediaInfectedException,
  MediaNotFoundException,
  MediaNotReadyException,
  MediaScanUnavailableException,
} from '@/core/errors/domain.error.js';
import { ObjectStoreException, VirusScannerException } from '@/core/errors/repository.error.js';
import type { MediaObjectRecord } from '@/modules/media/logic/entities/media-object-record.js';
import type { MediaObjectRepository } from '@/modules/media/logic/ports/media-object.repository.js';
import type {
  ObjectStore,
  PresignedDownload,
  PresignedUpload,
} from '@/modules/media/logic/ports/object-store.js';
import type { VirusScanner } from '@/modules/media/logic/ports/virus-scanner.js';
import { MEDIA_TYPES } from '@/modules/media/media.types.js';

export interface UploadTicket extends PresignedUpload {
  mediaId: string;
  objectKey: string;
}

export interface DownloadTicket extends PresignedDownload {
  mediaId: string;
  status: 'ready';
  contentType: string;
  sizeBytes: number;
  sha256: string | null;
}

export type FinalizeResult = DownloadTicket;

type ScanOutcome =
  | { verdict: 'infected'; signature: string }
  | { verdict: 'clean'; sha256: string };

/** Owns the complete upload lifecycle; adapters and persistence stay behind ports. */
@injectable()
export class MediaService {
  constructor(
    @inject(MEDIA_TYPES.MediaObjectRepository)
    private readonly objects: MediaObjectRepository,
    @inject(MEDIA_TYPES.ObjectStore) private readonly store: ObjectStore,
    @inject(MEDIA_TYPES.VirusScanner) private readonly scanner: VirusScanner,
    @inject(CORE_TYPES.Config) private readonly config: AppConfig,
  ) {}

  async initiate(userId: string, contentType: string, sizeBytes: number): Promise<UploadTicket> {
    const media = this.config.media;

    if (!media.allowedContentTypes.includes(contentType)) {
      throw new InvalidMediaInputException(`Unsupported media content type: ${contentType}`);
    }

    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > media.maxBytes) {
      throw new InvalidMediaInputException('Media size is outside the configured limit');
    }

    const record = await this.objects.create({ ownerUserId: userId, contentType, sizeBytes });
    const upload = await this.store.presignPut(record.objectKey, contentType, sizeBytes);

    return {
      mediaId: record.id,
      objectKey: record.objectKey,
      url: upload.url,
      headers: upload.headers,
      expiresAt: upload.expiresAt,
    };
  }

  async finalize(userId: string, mediaId: string): Promise<FinalizeResult> {
    const record = await this.requireOwned(userId, mediaId);

    if (record.status !== 'pending') {
      throw new MediaNotReadyException();
    }

    const head = await this.store.head(record.objectKey);

    if (head === null) {
      throw new MediaNotFoundException('Uploaded object was not found');
    }

    const versionId = head.versionId;

    if (head.contentType !== record.contentType || head.sizeBytes !== record.sizeBytes) {
      await this.objects.markFailed(
        mediaId,
        userId,
        'Uploaded object metadata does not match ticket',
        versionId,
      );
      throw new InvalidMediaInputException('Uploaded object metadata does not match the ticket');
    }

    let sha256: string | null = null;

    if (this.config.media.scanRequired) {
      let outcome: ScanOutcome;

      try {
        outcome = await this.scanWithHash(record.objectKey, versionId);
      } catch (error) {
        if (error instanceof ObjectStoreException) {
          await this.failStorageScan(mediaId, userId, versionId);
        }
        throw error;
      }

      if (outcome.verdict === 'infected') {
        await this.objects.transitionToQuarantined(
          mediaId,
          userId,
          outcome.signature,
          null,
          versionId,
        );
        throw new MediaInfectedException();
      }

      sha256 = outcome.sha256;
    }

    const ready = await this.objects.transitionToReady(mediaId, userId, sha256, versionId);

    if (ready === null) {
      throw new MediaNotReadyException();
    }

    return this.toDownloadTicket(ready);
  }

  async getDownload(userId: string, mediaId: string): Promise<DownloadTicket> {
    const record = await this.requireOwned(userId, mediaId);

    if (record.status !== 'ready') {
      throw new MediaNotReadyException();
    }

    return this.toDownloadTicket(record);
  }

  async remove(userId: string, mediaId: string): Promise<void> {
    const record = await this.requireOwned(userId, mediaId);
    await this.store.delete(record.objectKey);

    const deleted = await this.objects.deleteOwned(mediaId, userId);

    if (!deleted) {
      throw new MediaNotFoundException();
    }
  }

  private async scanWithHash(objectKey: string, versionId: string | null): Promise<ScanOutcome> {
    const hash: Hash = createHash('sha256');
    const hashing = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const source = await this.store.getStream(objectKey, versionId);
    let storageFailure = false;

    source.on('error', () => {
      storageFailure = true;
      hashing.destroy(this.storageReadFailure());
    });
    source.pipe(hashing);

    try {
      const result = await this.scanner.scan(hashing);

      if (storageFailure) {
        throw this.storageReadFailure();
      }

      if (result.verdict === 'infected') {
        return { verdict: 'infected', signature: result.signature };
      }

      return { verdict: 'clean', sha256: hash.digest('hex') };
    } catch (error) {
      if (storageFailure || error instanceof ObjectStoreException) {
        throw this.storageReadFailure();
      }

      if (error instanceof VirusScannerException) {
        throw new MediaScanUnavailableException(undefined, { cause: error });
      }

      throw error;
    } finally {
      source.destroy();
      hashing.destroy();
    }
  }

  private storageReadFailure(): ObjectStoreException {
    return new ObjectStoreException('Uploaded object could not be read for scanning');
  }

  private async failStorageScan(
    mediaId: string,
    userId: string,
    versionId: string | null,
  ): Promise<void> {
    try {
      await this.objects.markFailed(
        mediaId,
        userId,
        'Uploaded object could not be read for scanning',
        versionId,
      );
    } catch {
      // A persistence failure must not replace the storage failure classification.
    }
  }

  private async requireOwned(userId: string, mediaId: string): Promise<MediaObjectRecord> {
    const record = await this.objects.findOwned(mediaId, userId);

    if (record === null) {
      throw new MediaNotFoundException();
    }

    return record;
  }

  private async toDownloadTicket(record: MediaObjectRecord): Promise<DownloadTicket> {
    const download = await this.store.presignGet(record.objectKey, record.versionId);

    return {
      mediaId: record.id,
      status: 'ready',
      contentType: record.contentType,
      sizeBytes: record.sizeBytes,
      sha256: record.sha256,
      url: download.url,
      expiresAt: download.expiresAt,
    };
  }
}
