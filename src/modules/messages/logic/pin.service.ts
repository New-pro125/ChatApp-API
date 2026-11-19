import { inject, injectable } from 'inversify';
import { ConflictException, NotFoundException } from '@/core/errors/http.error.js';
import type { MessageRecord } from '@/modules/messages/logic/entities/message-record.js';
import type { MessagingPolicy } from '@/modules/messages/logic/messaging-policy.service.js';
import type {
  MessagePinRepository,
  PinRecord,
} from '@/modules/messages/logic/ports/message-pin.repository.js';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';

export interface PinnedMessage {
  readonly message: MessageRecord;
  readonly pinnedAt: Date;
}

/** Owns pin authorization, validation, and ordered listing. */
@injectable()
export class PinService {
  constructor(
    @inject(MESSAGES_TYPES.MessagingPolicy) private readonly policy: MessagingPolicy,
    @inject(MESSAGES_TYPES.MessageRepository) private readonly messages: MessageRepository,
    @inject(MESSAGES_TYPES.MessagePinRepository) private readonly pins: MessagePinRepository,
  ) {}

  async pin(userId: string, chatId: string, messageId: string): Promise<PinRecord> {
    await this.policy.requireMember(chatId, userId);
    await this.requireLiveMessage(chatId, messageId);

    const pin = await this.pins.pin(chatId, userId, messageId);

    if (pin === null) {
      throw new ConflictException('Pin limit reached for this chat');
    }

    return pin;
  }

  async unpin(userId: string, chatId: string, messageId: string): Promise<void> {
    await this.policy.requireMember(chatId, userId);
    await this.pins.unpin(chatId, userId, messageId);
  }

  async list(userId: string, chatId: string): Promise<PinnedMessage[]> {
    await this.policy.requireMember(chatId, userId);
    const records = await this.pins.list(chatId, userId);
    const byId = new Map(
      (await this.messages.listByIds(chatId, records.map((record) => record.messageId))).map(
        (message) => [message.id, message],
      ),
    );

    return records.flatMap((record) => {
      const message = byId.get(record.messageId);

      return message === undefined ? [] : [{ message, pinnedAt: record.pinnedAt }];
    });
  }

  /** Batched pin indicators for a page; called after history validates membership. */
  async listPinnedFor(
    chatId: string,
    viewerId: string,
    messageIds: readonly string[],
  ): Promise<Map<string, Date>> {
    return this.pins.listPinnedFor(chatId, viewerId, messageIds);
  }

  private async requireLiveMessage(chatId: string, messageId: string): Promise<void> {
    const message = await this.messages.findById(chatId, messageId);

    if (message === null || message.deletedAt !== null) {
      throw new NotFoundException('Message not found in this chat');
    }
  }
}
