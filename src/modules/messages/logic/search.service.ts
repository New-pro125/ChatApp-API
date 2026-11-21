import { inject, injectable } from 'inversify';
import { E2eeNotAllowedException } from '@/core/errors/domain.error.js';
import type { MessageRecord } from '@/modules/messages/logic/entities/message-record.js';
import type { MessagingPolicy } from '@/modules/messages/logic/messaging-policy.service.js';
import type { ChatRepository } from '@/modules/messages/logic/ports/chat.repository.js';
import type {
  MessageRepository,
  SearchMessagesQuery,
} from '@/modules/messages/logic/ports/message.repository.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';

/** Authorizes and scopes keyword search over one chat's message text. */
@injectable()
export class SearchService {
  constructor(
    @inject(MESSAGES_TYPES.MessagingPolicy) private readonly policy: MessagingPolicy,
    @inject(MESSAGES_TYPES.ChatRepository) private readonly chats: ChatRepository,
    @inject(MESSAGES_TYPES.MessageRepository) private readonly messages: MessageRepository,
  ) {}

  async search(
    userId: string,
    chatId: string,
    query: SearchMessagesQuery,
  ): Promise<MessageRecord[]> {
    await this.policy.requireMember(chatId, userId);

    const chat = await this.chats.findById(chatId);

    if (chat?.type === 'secret') {
      throw new E2eeNotAllowedException();
    }

    return this.messages.search(chatId, query);
  }
}
