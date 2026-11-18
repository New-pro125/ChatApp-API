import { inject, injectable } from 'inversify';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@/core/errors/http.error.js';
import type { MessageRecord } from '@/modules/messages/logic/entities/message-record.js';
import type { MessagingPolicy } from '@/modules/messages/logic/messaging-policy.service.js';
import type {
  ListMessagesQuery,
  MessageRepository,
} from '@/modules/messages/logic/ports/message.repository.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';

/** Text payload accepted when sending a message. */
export interface SendMessageInput {
  body: string;
  replyToMessageId?: string | undefined;
}

/** Owns message writes, history reads, and sender-only mutations. */
@injectable()
export class MessageService {
  constructor(
    @inject(MESSAGES_TYPES.MessageRepository) private readonly messages: MessageRepository,
    @inject(MESSAGES_TYPES.MessagingPolicy) private readonly policy: MessagingPolicy,
  ) {}

  async send(userId: string, chatId: string, input: SendMessageInput): Promise<MessageRecord> {
    await this.policy.requireMember(chatId, userId);
    await this.policy.assertChatUnblocked(chatId, userId);

    if (input.replyToMessageId !== undefined) {
      const target = await this.messages.findById(chatId, input.replyToMessageId);

      if (!target) {
        throw new BadRequestException('Reply target must belong to this chat');
      }
    }

    return this.messages.create({
      chatId,
      senderId: userId,
      body: input.body,
      type: 'text',
      replyToMessageId: input.replyToMessageId ?? null,
    });
  }

  async list(userId: string, chatId: string, query: ListMessagesQuery): Promise<MessageRecord[]> {
    await this.policy.requireMember(chatId, userId);
    await this.policy.assertChatUnblocked(chatId, userId);

    return this.messages.listByChat(chatId, query);
  }

  async edit(
    userId: string,
    chatId: string,
    messageId: string,
    body: string,
  ): Promise<MessageRecord> {
    await this.policy.requireMember(chatId, userId);

    const message = await this.requireMessage(chatId, messageId);
    this.assertSender(message, userId);

    if (message.deletedAt !== null) {
      throw new BadRequestException('Deleted messages cannot be edited');
    }

    const edited = await this.messages.editBody(chatId, messageId, body, new Date());

    if (!edited) {
      throw new NotFoundException('Message not found');
    }

    return edited;
  }

  async remove(userId: string, chatId: string, messageId: string): Promise<void> {
    await this.policy.requireMember(chatId, userId);

    const message = await this.requireMessage(chatId, messageId);
    this.assertSender(message, userId);

    await this.messages.markDeleted(chatId, messageId, new Date());
  }

  async forward(
    userId: string,
    sourceChatId: string,
    messageId: string,
    targetChatId: string,
  ): Promise<MessageRecord> {
    await this.policy.requireMember(sourceChatId, userId);
    await this.policy.requireMember(targetChatId, userId);
    await this.policy.assertChatUnblocked(sourceChatId, userId);

    if (targetChatId !== sourceChatId) {
      await this.policy.assertChatUnblocked(targetChatId, userId);
    }

    const original = await this.requireMessage(sourceChatId, messageId);

    if (original.deletedAt !== null || original.body === null) {
      throw new BadRequestException('Deleted messages cannot be forwarded');
    }

    return this.messages.create({
      chatId: targetChatId,
      senderId: userId,
      body: original.body,
      type: 'text',
      forwardedFromChatId: sourceChatId,
      forwardedFromMessageId: messageId,
    });
  }

  private async requireMessage(chatId: string, messageId: string): Promise<MessageRecord> {
    const message = await this.messages.findById(chatId, messageId);

    if (!message) {
      throw new NotFoundException('Message not found');
    }

    return message;
  }

  private assertSender(message: MessageRecord, userId: string): void {
    if (message.senderId !== userId) {
      throw new ForbiddenException('Only the sender may change a message');
    }
  }
}
