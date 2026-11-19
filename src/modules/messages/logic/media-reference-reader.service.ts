import { inject, injectable } from 'inversify';
import type { MediaReferenceReader } from '@/core/media/media-reference.port.js';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';

@injectable()
export class MediaReferenceReaderService implements MediaReferenceReader {
  constructor(
    @inject(MESSAGES_TYPES.MessageRepository) private readonly messages: MessageRepository,
  ) {}

  hasLiveReferences(mediaId: string): Promise<boolean> {
    return this.messages.hasLiveMediaReferences(mediaId);
  }
}
