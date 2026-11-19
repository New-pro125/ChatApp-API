import { inject, injectable } from 'inversify';
import type {
  IncomingMediaUpload,
  MediaAccess,
  MediaAsset,
  MediaDownload,
} from '@/core/media/media-access.port.js';
import type { MediaService } from '@/modules/media/logic/media.service.js';
import { MEDIA_TYPES } from '@/modules/media/media.types.js';

@injectable()
export class MediaAccessService implements MediaAccess {
  constructor(@inject(MEDIA_TYPES.MediaService) private readonly media: MediaService) {}

  requireReadyOwned(mediaId: string, userId: string): Promise<MediaAsset> {
    return this.media.requireReadyForUse(mediaId, userId);
  }

  storeAndScan(userId: string, input: IncomingMediaUpload): Promise<MediaAsset> {
    return this.media.storeAndScan(userId, input);
  }

  signDownload(mediaId: string): Promise<MediaDownload> {
    return this.media.signForReader(mediaId);
  }

  releaseIfUnreferenced(mediaId: string): Promise<void> {
    return this.media.releaseIfUnreferenced(mediaId);
  }

  assertDeletable(mediaId: string): Promise<void> {
    return this.media.assertDeletable(mediaId);
  }
}
