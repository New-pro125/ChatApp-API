import { inject, injectable } from 'inversify';
import { E2eeNotAllowedException, NotChatMemberException } from '@/core/errors/domain.error.js';
import type { MessageDraftRecord } from '@/modules/messages/logic/entities/message-draft-record.js';
import type { MessagingPolicy } from '@/modules/messages/logic/messaging-policy.service.js';
import type { ChatRepository } from '@/modules/messages/logic/ports/chat.repository.js';
import type { MessageDraftRepository } from '@/modules/messages/logic/ports/message-draft.repository.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';

/** Owns draft authorization and last-write-wins persistence. */
@injectable()
export class DraftService {
  constructor(
    @inject(MESSAGES_TYPES.ChatRepository) private readonly chats: ChatRepository,
    @inject(MESSAGES_TYPES.MessagingPolicy) private readonly policy: MessagingPolicy,
    @inject(MESSAGES_TYPES.MessageDraftRepository)
    private readonly drafts: MessageDraftRepository,
  ) {}

  async get(chatId: string, userId: string): Promise<MessageDraftRecord | null> {
    await this.assertDraftable(chatId, userId);

    return this.drafts.find(chatId, userId);
  }

  async save(chatId: string, userId: string, body: string): Promise<MessageDraftRecord> {
    await this.assertDraftable(chatId, userId);

    return this.drafts.upsert(chatId, userId, body, new Date());
  }

  async delete(chatId: string, userId: string): Promise<boolean> {
    await this.assertDraftable(chatId, userId);

    return this.drafts.delete(chatId, userId);
  }

  /** Best-effort cleanup after a send; the send path already authorized the caller. */
  async clearOnSend(chatId: string, userId: string): Promise<void> {
    await this.drafts.delete(chatId, userId);
  }

  private async assertDraftable(chatId: string, userId: string): Promise<void> {
    const chat = await this.chats.findById(chatId);

    if (!chat) {
      throw new NotChatMemberException();
    }

    await this.policy.requireMember(chatId, userId);

    if (chat.type !== 'direct') {
      throw new E2eeNotAllowedException();
    }
  }
}
