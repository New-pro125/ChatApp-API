import { injectable } from 'inversify';
import { InvalidMediaInputException } from '@/core/errors/domain.error.js';

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/octet-stream': 'bin',
};

/** Derives private object keys only from server-owned identifiers and an allowed type. */
@injectable()
export class MediaObjectKeyFactory {
  build(ownerUserId: string, mediaId: string, contentType: string): string {
    const extension = EXTENSIONS[contentType];

    if (extension === undefined) {
      throw new InvalidMediaInputException(`Unsupported media content type: ${contentType}`);
    }

    return `media/${ownerUserId}/${mediaId}.${extension}`;
  }
}
