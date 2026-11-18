import type { Readable } from 'node:stream';
import { VirusScannerException } from '@/core/errors/repository.error.js';
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

export class MediaFixture {
  readonly scanner = new FakeVirusScanner();

  private readonly store: ObjectStore;
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
        ),
      );
  }

  async cleanup(): Promise<void> {
    for (const key of this.keys) {
      await this.store.delete(key);
    }
    this.keys.length = 0;
  }
}
