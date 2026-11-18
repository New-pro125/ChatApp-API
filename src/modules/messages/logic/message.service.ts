import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { E2eeCiphertextValidator } from '@/core/e2ee/e2ee-ciphertext.validator.js';
import type { E2eeDeviceReader } from '@/core/e2ee/e2ee-device.reader.js';
import {
  E2eeDeviceNotFoundException,
  E2eeNotAllowedException,
} from '@/core/errors/domain.error.js';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@/core/errors/http.error.js';
import type { MessageRecord } from '@/modules/messages/logic/entities/message-record.js';
import type { MessagingPolicy } from '@/modules/messages/logic/messaging-policy.service.js';
import type { ChatRepository } from '@/modules/messages/logic/ports/chat.repository.js';
import type { ChatMemberRepository } from '@/modules/messages/logic/ports/chat-member.repository.js';
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

/** Ciphertext payload accepted when sending a secret message. */
export interface SendSecretMessageInput {
  readonly recipientDeviceId: string;
  readonly ciphertext: string;
  readonly nonce: string;
  readonly ephemeralPublicKey: string;
}

/** Owns message writes, history reads, and sender-only mutations. */
@injectable()
export class MessageService {
  constructor(
    @inject(MESSAGES_TYPES.MessageRepository) private readonly messages: MessageRepository,
    @inject(MESSAGES_TYPES.MessagingPolicy) private readonly policy: MessagingPolicy,
    @inject(MESSAGES_TYPES.ChatRepository) private readonly chats: ChatRepository,
    @inject(MESSAGES_TYPES.ChatMemberRepository) private readonly members: ChatMemberRepository,
    @inject(CORE_TYPES.E2eeDeviceReader) private readonly e2eeDevices: E2eeDeviceReader,
    @inject(CORE_TYPES.E2eeCiphertextValidator)
    private readonly ciphertextValidator: E2eeCiphertextValidator,
  ) {}

  async send(userId: string, chatId: string, input: SendMessageInput): Promise<MessageRecord> {
    // Secret chats carry ciphertext only, so no ordinary text or reply is allowed.
    await this.rejectSecretChat(chatId);
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

  /** Stores ciphertext for the caller's device and a device of the other member. */
  async sendSecret(
    userId: string,
    senderDeviceId: string,
    chatId: string,
    input: SendSecretMessageInput,
  ): Promise<MessageRecord> {
    await this.requireSecretChat(chatId);
    await this.policy.requireMember(chatId, userId);
    await this.policy.assertChatUnblocked(chatId, userId);

    const sender = await this.e2eeDevices.findByUserAndDevice(userId, senderDeviceId);

    if (!sender) {
      throw new E2eeDeviceNotFoundException('Sender device is not registered');
    }

    const memberships = await this.members.listByChat(chatId);
    const peer = memberships.find((member) => member.userId !== userId);

    if (!peer) {
      throw new E2eeNotAllowedException('A secret chat requires two participants');
    }

    const recipient = await this.e2eeDevices.findByUserAndDevice(
      peer.userId,
      input.recipientDeviceId,
    );

    if (!recipient) {
      throw new E2eeDeviceNotFoundException();
    }

    this.ciphertextValidator.assertCiphertextInput(input);

    return this.messages.createSecret({
      chatId,
      senderId: userId,
      senderDeviceId,
      recipientDeviceId: input.recipientDeviceId,
      ciphertext: input.ciphertext,
      nonce: input.nonce,
      ephemeralPublicKey: input.ephemeralPublicKey,
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
    await this.rejectSecretChat(chatId);
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
    await this.rejectSecretChat(chatId);
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
    await this.rejectSecretChat(sourceChatId);
    await this.rejectSecretChat(targetChatId);
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

  /** Rejects ciphertext chats from plaintext mutation and send paths. */
  private async rejectSecretChat(chatId: string): Promise<void> {
    const chat = await this.chats.findById(chatId);

    if (chat?.type === 'secret') {
      throw new E2eeNotAllowedException();
    }
  }

  /** Ensures ciphertext sends only target a secret chat. */
  private async requireSecretChat(chatId: string): Promise<void> {
    const chat = await this.chats.findById(chatId);

    if (chat?.type !== 'secret') {
      throw new E2eeNotAllowedException('Ciphertext may only be sent to a secret chat');
    }
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
