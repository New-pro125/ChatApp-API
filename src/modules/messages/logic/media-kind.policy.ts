import { BadRequestException } from '@/core/errors/http.error.js';
import type { MediaKind } from '@/modules/messages/logic/entities/message-record.js';

const FAMILIES: Readonly<Record<MediaKind, readonly string[]>> = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  video: ['video/mp4', 'video/webm'],
  document: [],
  voice_note: ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/mp4'],
  sticker: ['image/webp', 'image/png'],
  gif: ['image/gif'],
};

/** Validates the client-supplied discriminator against the scanned object type. */
export class MediaKindPolicy {
  assertMatches(kind: MediaKind, contentType: string): void {
    if (kind === 'document') {
      return;
    }

    if (!FAMILIES[kind].includes(contentType)) {
      throw new BadRequestException(`Content type ${contentType} is not valid for kind ${kind}`);
    }
  }
}
