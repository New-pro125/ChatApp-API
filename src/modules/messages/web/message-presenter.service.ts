import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { MediaAccess } from '@/core/media/media-access.port.js';
import type { MessageRecord } from '@/modules/messages/logic/entities/message-record.js';
import type { ReadReceiptContext } from '@/modules/messages/logic/entities/read-receipt-context.js';
import type { PinIndicators } from '@/modules/messages/logic/ports/message-pin.repository.js';

/** Public mention summary embedded in a message view. */
export interface MentionView {
  userId: string;
  username: string | null;
  displayName: string;
}

@injectable()
export class MessagePresenter {
  constructor(@inject(CORE_TYPES.MediaAccess) private readonly media: MediaAccess) {}

  async present(
    message: MessageRecord,
    receipts?: ReadReceiptContext,
    pinnedAtById: ReadonlyMap<string, PinIndicators> = new Map(),
    mentions: readonly MentionView[] = [],
  ): Promise<Record<string, unknown>> {
    const base = {
      id: message.id,
      chatId: message.chatId,
      senderId: message.senderId,
      type: message.type,
      body: message.deletedAt === null ? message.body : null,
      replyToMessageId: message.replyToMessageId,
      forwardedFromChatId: message.forwardedFromChatId,
      forwardedFromMessageId: message.forwardedFromMessageId,
      editedAt: message.editedAt?.toISOString() ?? null,
      deletedAt: message.deletedAt?.toISOString() ?? null,
      createdAt: message.createdAt.toISOString(),
      readAt: this.readAt(message, receipts),
      pinnedAt: pinnedAtById.get(message.id)?.pinnedAt.toISOString() ?? null,
      pinExpiresAt: pinnedAtById.get(message.id)?.expiresAt.toISOString() ?? null,
      ciphertext: message.ciphertext,
      nonce: message.nonce,
      ephemeralPublicKey: message.ephemeralPublicKey,
      senderDeviceId: message.senderDeviceId,
      recipientDeviceId: message.recipientDeviceId,
      media: null as Record<string, unknown> | null,
      mentions: [...mentions],
    };

    if (message.media === null || message.deletedAt !== null) {
      return base;
    }

    const download = await this.media.signDownload(message.media.mediaId);

    return {
      ...base,
      media: {
        mediaId: message.media.mediaId,
        kind: message.media.kind,
        contentType: download.contentType,
        sizeBytes: download.sizeBytes,
        caption: message.media.caption,
        durationMs: message.media.durationMs,
        width: message.media.width,
        height: message.media.height,
        downloadUrl: download.url,
        expiresAt: download.expiresAt.toISOString(),
      },
    };
  }

  private readAt(message: MessageRecord, receipts?: ReadReceiptContext): string | null {
    if (
      receipts === undefined ||
      !receipts.mutual ||
      message.senderId !== receipts.viewerId ||
      message.deletedAt !== null ||
      receipts.peerLastReadMessageId === null ||
      message.id > receipts.peerLastReadMessageId
    ) {
      return null;
    }

    return receipts.peerLastReadAt?.toISOString() ?? null;
  }
}
