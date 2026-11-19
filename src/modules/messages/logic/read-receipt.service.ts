import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { NotFoundException } from '@/core/errors/http.error.js';
import type { ReadReceiptPreferenceReader } from '@/core/privacy/read-receipt-preference.reader.js';
import type { ReadReceiptContext } from '@/modules/messages/logic/entities/read-receipt-context.js';
import type { MessagingPolicy } from '@/modules/messages/logic/messaging-policy.service.js';
import type { ChatMemberRepository } from '@/modules/messages/logic/ports/chat-member.repository.js';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';

export interface ReadMarkResult {
  readonly chatId: string;
  readonly lastReadMessageId: string | null;
  readonly lastReadAt: Date | null;
}

/** Owns read-watermark writes and the receipt context used by presenters. */
@injectable()
export class ReadReceiptService {
  constructor(
    @inject(MESSAGES_TYPES.MessagingPolicy) private readonly policy: MessagingPolicy,
    @inject(MESSAGES_TYPES.MessageRepository) private readonly messages: MessageRepository,
    @inject(MESSAGES_TYPES.ChatMemberRepository) private readonly members: ChatMemberRepository,
    @inject(CORE_TYPES.ReadReceiptPreferenceReader)
    private readonly preferences: ReadReceiptPreferenceReader,
  ) {}

  async markRead(
    userId: string,
    chatId: string,
    messageId?: string | undefined,
  ): Promise<ReadMarkResult> {
    await this.policy.requireMember(chatId, userId);

    let target = messageId ?? null;

    if (target !== null) {
      const message = await this.messages.findById(chatId, target);

      if (!message) {
        throw new NotFoundException('Message not found in this chat');
      }
    } else {
      target = await this.messages.maxIdByChat(chatId);
    }

    if (target === null) {
      const current = await this.members.find(chatId, userId);

      return {
        chatId,
        lastReadMessageId: current?.lastReadMessageId ?? null,
        lastReadAt: current?.lastReadAt ?? null,
      };
    }

    const updated = await this.members.markRead(chatId, userId, target);

    return {
      chatId,
      lastReadMessageId: updated.lastReadMessageId,
      lastReadAt: updated.lastReadAt,
    };
  }

  async contextFor(chatId: string, viewerId: string): Promise<ReadReceiptContext> {
    const memberships = await this.members.listByChat(chatId);
    const peer = memberships.find((member) => member.userId !== viewerId);

    if (!peer) {
      return {
        viewerId,
        mutual: false,
        peerLastReadMessageId: null,
        peerLastReadAt: null,
      };
    }

    const mutual = await this.preferences.areEnabledForPair(viewerId, peer.userId);

    return {
      viewerId,
      mutual,
      peerLastReadMessageId: peer.lastReadMessageId,
      peerLastReadAt: peer.lastReadAt,
    };
  }
}
