import { inject, injectable } from 'inversify';
import type { Logger } from 'pino';
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
import type { IncomingMediaUpload, MediaAccess } from '@/core/media/media-access.port.js';
import type { DraftService } from '@/modules/messages/logic/draft.service.js';
import type { MediaKind, MessageRecord } from '@/modules/messages/logic/entities/message-record.js';
import { SelfDestructTimer } from '@/modules/messages/logic/entities/self-destruct-timer.js';
import type { MediaKindPolicy } from '@/modules/messages/logic/media-kind.policy.js';
import type { MentionService } from '@/modules/messages/logic/mention.service.js';
import type { MessagingPolicy } from '@/modules/messages/logic/messaging-policy.service.js';
import type { ChatRepository } from '@/modules/messages/logic/ports/chat.repository.js';
import type { ChatMemberRepository } from '@/modules/messages/logic/ports/chat-member.repository.js';
import type {
  ListMessagesQuery,
  MessageRepository,
} from '@/modules/messages/logic/ports/message.repository.js';
import type { MessagePinRepository } from '@/modules/messages/logic/ports/message-pin.repository.js';
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

/** A ready, owner-checked media object attached to a cloud message. */
export interface SendMediaMessageInput {
  mediaId: string;
  kind: MediaKind;
  caption?: string | undefined;
  durationMs?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  replyToMessageId?: string | undefined;
}

/** A single-request upload; the stored id comes from `storeAndScan`. */
export interface SendMediaFromUploadInput {
  kind: MediaKind;
  caption?: string | undefined;
  durationMs?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  replyToMessageId?: string | undefined;
  contentType: string;
  sizeBytes: number;
  body: IncomingMediaUpload['body'];
  assertComplete: () => Promise<void>;
}

/** Owns message writes, history reads, and sender-only mutations. */
@injectable()
export class MessageService {
  constructor(
    @inject(MESSAGES_TYPES.MessageRepository) private readonly messages: MessageRepository,
    @inject(MESSAGES_TYPES.MessagingPolicy) private readonly policy: MessagingPolicy,
    @inject(MESSAGES_TYPES.ChatRepository) private readonly chats: ChatRepository,
    @inject(MESSAGES_TYPES.ChatMemberRepository) private readonly members: ChatMemberRepository,
    @inject(MESSAGES_TYPES.MessagePinRepository) private readonly pins: MessagePinRepository,
    @inject(CORE_TYPES.E2eeDeviceReader) private readonly e2eeDevices: E2eeDeviceReader,
    @inject(CORE_TYPES.E2eeCiphertextValidator)
    private readonly ciphertextValidator: E2eeCiphertextValidator,
    @inject(CORE_TYPES.MediaAccess) private readonly mediaAccess: MediaAccess,
    @inject(MESSAGES_TYPES.MediaKindPolicy) private readonly kinds: MediaKindPolicy,
    @inject(MESSAGES_TYPES.DraftService) private readonly drafts: DraftService,
    @inject(MESSAGES_TYPES.MentionService) private readonly mentions: MentionService,
    @inject(CORE_TYPES.Logger) private readonly logger: Logger,
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

    const expiresAt = await this.expiryFor(chatId, userId);

    const message = await this.messages.create({
      chatId,
      senderId: userId,
      body: input.body,
      type: 'text',
      replyToMessageId: input.replyToMessageId ?? null,
      expiresAt,
    });
    await this.syncMentions(chatId, message);
    await this.clearDraftAfterSend(chatId, userId);

    return message;
  }

  async sendMedia(
    userId: string,
    chatId: string,
    input: SendMediaMessageInput,
  ): Promise<MessageRecord> {
    await this.rejectSecretChat(chatId);
    await this.policy.requireMember(chatId, userId);
    await this.policy.assertChatUnblocked(chatId, userId);

    if (input.replyToMessageId !== undefined) {
      const target = await this.messages.findById(chatId, input.replyToMessageId);

      if (!target) {
        throw new BadRequestException('Reply target must belong to this chat');
      }
    }

    const asset = await this.mediaAccess.requireReadyOwned(input.mediaId, userId);
    this.kinds.assertMatches(input.kind, asset.contentType);
    const expiresAt = await this.expiryFor(chatId, userId);

    const message = await this.messages.create({
      chatId,
      senderId: userId,
      body: null,
      type: 'media',
      media: {
        mediaId: input.mediaId,
        kind: input.kind,
        caption: input.caption ?? null,
        durationMs: input.durationMs ?? null,
        width: input.width ?? null,
        height: input.height ?? null,
      },
      replyToMessageId: input.replyToMessageId ?? null,
      expiresAt,
    });
    await this.clearDraftAfterSend(chatId, userId);

    return message;
  }

  async sendMediaFromUpload(
    userId: string,
    chatId: string,
    input: SendMediaFromUploadInput,
  ): Promise<MessageRecord> {
    await this.rejectSecretChat(chatId);
    await this.policy.requireMember(chatId, userId);
    await this.policy.assertChatUnblocked(chatId, userId);

    if (input.replyToMessageId !== undefined) {
      const target = await this.messages.findById(chatId, input.replyToMessageId);

      if (!target) {
        throw new BadRequestException('Reply target must belong to this chat');
      }
    }

    // Validate before storing so a rejected kind cannot leave an unowned ready object.
    this.kinds.assertMatches(input.kind, input.contentType);

    const asset = await this.mediaAccess.storeAndScan(userId, {
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      body: input.body,
      assertComplete: input.assertComplete,
    });
    const expiresAt = await this.expiryFor(chatId, userId);

    const message = await this.messages.create({
      chatId,
      senderId: userId,
      body: null,
      type: 'media',
      media: {
        mediaId: asset.id,
        kind: input.kind,
        caption: input.caption ?? null,
        durationMs: input.durationMs ?? null,
        width: input.width ?? null,
        height: input.height ?? null,
      },
      replyToMessageId: input.replyToMessageId ?? null,
      expiresAt,
    });
    await this.clearDraftAfterSend(chatId, userId);

    return message;
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
    const expiresAt = await this.expiryFor(chatId, userId);

    return this.messages.createSecret({
      chatId,
      senderId: userId,
      senderDeviceId,
      recipientDeviceId: input.recipientDeviceId,
      ciphertext: input.ciphertext,
      nonce: input.nonce,
      ephemeralPublicKey: input.ephemeralPublicKey,
      expiresAt,
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

    if (message.media !== null) {
      throw new BadRequestException('Media messages cannot be edited');
    }

    const edited = await this.messages.editBody(chatId, messageId, body, new Date());

    if (!edited) {
      throw new NotFoundException('Message not found');
    }

    await this.syncMentions(chatId, edited);

    return edited;
  }

  async remove(userId: string, chatId: string, messageId: string): Promise<void> {
    await this.rejectSecretChat(chatId);
    await this.policy.requireMember(chatId, userId);

    const message = await this.requireMessage(chatId, messageId);
    this.assertSender(message, userId);

    const mediaId = message.media?.mediaId ?? null;

    await this.messages.markDeleted(chatId, messageId, new Date());
    await this.mentions.hideForMessage(chatId, messageId);
    await this.pins.removeForMessage(chatId, messageId);

    if (mediaId !== null) {
      await this.mediaAccess.releaseIfUnreferenced(mediaId);
    }
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

    if (original.deletedAt !== null || (original.body === null && original.media === null)) {
      throw new BadRequestException('Deleted messages cannot be forwarded');
    }

    const expiresAt = await this.expiryFor(targetChatId, userId);

    const message = await this.messages.create({
      chatId: targetChatId,
      senderId: userId,
      body: original.media === null ? original.body : null,
      type: original.media === null ? 'text' : 'media',
      ...(original.media === null ? {} : { media: original.media }),
      forwardedFromChatId: sourceChatId,
      forwardedFromMessageId: messageId,
      expiresAt,
    });
    await this.syncMentions(targetChatId, message);
    await this.clearDraftAfterSend(targetChatId, userId);

    return message;
  }

  /** Mention indexing is best effort: never fail a message that was stored. */
  private async syncMentions(chatId: string, message: MessageRecord): Promise<void> {
    if (message.type !== 'text' || message.body === null) {
      return;
    }

    try {
      await this.mentions.sync(chatId, message.id, message.body);
    } catch (error) {
      this.logger.warn({ err: error, chatId, messageId: message.id }, 'Failed to sync mentions');
    }
  }

  /** A stale draft is recoverable; a failed send is not. Never fail a send for this. */
  private async clearDraftAfterSend(chatId: string, userId: string): Promise<void> {
    try {
      await this.drafts.clearOnSend(chatId, userId);
    } catch (error) {
      this.logger.warn({ err: error, chatId, userId }, 'Failed to clear message draft after send');
    }
  }

  /** Resolves the sender's current preset in the target chat at send time. */
  private async expiryFor(chatId: string, userId: string): Promise<Date | null> {
    const membership = await this.members.find(chatId, userId);

    return SelfDestructTimer.expiryFor(membership?.selfDestructPreset ?? null);
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
