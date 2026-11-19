import type { Readable } from 'node:stream';
import { DeleteObjectsCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';
import { VirusScannerException } from '@/core/errors/repository.error.js';
import type { MediaReferenceReader } from '@/core/media/media-reference.port.js';
import { MediaService } from '@/modules/media/logic/media.service.js';
import type { ObjectStore } from '@/modules/media/logic/ports/object-store.js';
import type { ScanResult, VirusScanner } from '@/modules/media/logic/ports/virus-scanner.js';
import type { MediaModule } from '@/modules/media/media.module.js';
import { MEDIA_TYPES } from '@/modules/media/media.types.js';
import type { TestApp } from '../helpers/test-app.js';

/** HTTP responses use `uploadUrl`/`downloadUrl` and ISO-8601 `expiresAt` strings. */
export interface UploadTicketResponse {
  mediaId: string;
  objectKey: string;
  uploadUrl: string;
  headers: { 'Content-Type': string; 'Content-Length': string };
  expiresAt: string;
}

export interface DownloadTicketResponse {
  mediaId: string;
  status: 'ready';
  contentType: string;
  sizeBytes: number;
  sha256: string | null;
  downloadUrl: string;
  expiresAt: string;
}

export class FakeVirusScanner implements VirusScanner {
  mode: 'clean' | 'infected' | 'unavailable' = 'clean';

  async scan(stream: Readable): Promise<ScanResult> {
    for await (const _chunk of stream) {
      /* drain the object so hash completion is deterministic */
    }

    if (this.mode === 'unavailable') {
      throw new VirusScannerException('fake scanner outage');
    }

    if (this.mode === 'infected') {
      return { verdict: 'infected', signature: 'Eicar-Test-Signature' };
    }

    return { verdict: 'clean' };
  }
}

class FakeReferences implements MediaReferenceReader {
  hasLiveReferences(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

export class MediaFixture {
  readonly scanner = new FakeVirusScanner();

  private readonly store: ObjectStore;
  private readonly cleanupClient: S3Client;
  private readonly bucket: string;
  private readonly keys: string[] = [];

  constructor(private readonly app: TestApp) {
    const module = app.application.getModule<MediaModule>('media');

    if (!module) {
      throw new Error('MediaModule is not registered in the application');
    }

    module.mediaContainer
      .rebind<VirusScanner>(MEDIA_TYPES.VirusScanner)
      .toConstantValue(this.scanner);
    this.store = module.mediaContainer.get<ObjectStore>(MEDIA_TYPES.ObjectStore);

    const media = this.app.container.config.media;
    this.bucket = media.bucket;
    this.cleanupClient = new S3Client({
      region: media.region,
      endpoint: media.endpoint,
      forcePathStyle: media.forcePathStyle,
      credentials: {
        accessKeyId: media.accessKeyId,
        secretAccessKey: media.secretAccessKey,
      },
    });
  }

  track(ticket: UploadTicketResponse): void {
    this.keys.push(ticket.objectKey);
  }

  async put(ticket: UploadTicketResponse, bytes: Buffer, contentType: string): Promise<void> {
    const response = await fetch(ticket.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: bytes,
    });

    if (!response.ok) {
      throw new Error(`Presigned PUT failed with ${response.status}: ${await response.text()}`);
    }
  }

  useBypass(): void {
    const module = this.app.application.getModule<MediaModule>('media');

    if (!module) {
      throw new Error('MediaModule is not registered in the application');
    }

    const config = this.app.container.config;
    const bypassConfig = {
      ...config,
      media: { ...config.media, scanRequired: false },
    } as typeof config;

    module.mediaContainer
      .rebind<MediaService>(MEDIA_TYPES.MediaService)
      .toConstantValue(
        new MediaService(
          module.mediaContainer.get(MEDIA_TYPES.MediaObjectRepository),
          module.mediaContainer.get(MEDIA_TYPES.ObjectStore),
          module.mediaContainer.get(MEDIA_TYPES.VirusScanner),
          bypassConfig,
          new FakeReferences(),
        ),
      );
  }

  async cleanup(): Promise<void> {
    await this.deleteVersions(await this.listVersions());
    this.keys.length = 0;
    this.cleanupClient.destroy();
  }

  private async listVersions(): Promise<Array<{ Key: string; VersionId: string }>> {
    const versions: Array<{ Key: string; VersionId: string }> = [];

    for (const key of this.keys) {
      versions.push(...(await this.versionsForKey(key)));
    }

    return versions;
  }

  private async versionsForKey(key: string): Promise<Array<{ Key: string; VersionId: string }>> {
    const listed = await this.cleanupClient.send(
      new ListObjectVersionsCommand({ Bucket: this.bucket, Prefix: key }),
    );
    const versions: Array<{ Key: string; VersionId: string }> = [];

    for (const version of listed.Versions ?? []) {
      if (version.Key === key && version.VersionId) {
        versions.push({ Key: key, VersionId: version.VersionId });
      }
    }
    for (const marker of listed.DeleteMarkers ?? []) {
      if (marker.Key === key && marker.VersionId) {
        versions.push({ Key: key, VersionId: marker.VersionId });
      }
    }

    // Versionless buckets do not expose a version id, so keep the simple delete.
    if (versions.length === 0) {
      await this.store.delete(key);
    }

    return versions;
  }

  private async deleteVersions(versions: Array<{ Key: string; VersionId: string }>): Promise<void> {
    if (versions.length === 0) {
      return;
    }

    const deleted = await this.cleanupClient.send(
      new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: versions } }),
    );

    if (deleted.Errors?.length) {
      throw new Error(`Failed to delete ${deleted.Errors.length} media object versions`);
    }
  }
}
