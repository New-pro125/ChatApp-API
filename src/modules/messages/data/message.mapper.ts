import type { InferSelectModel } from 'drizzle-orm';
import { messages } from '@/core/database/schema/index.js';
import {
  MessageRecord,
  type MessageType,
} from '@/modules/messages/logic/entities/message-record.js';

/** Explicit column selection for the `messages` table. */
export const messageSelection = {
  id: messages.id,
  chatId: messages.chatId,
  senderId: messages.senderId,
  type: messages.type,
  body: messages.body,
  replyToMessageId: messages.replyToMessageId,
  forwardedFromChatId: messages.forwardedFromChatId,
  forwardedFromMessageId: messages.forwardedFromMessageId,
  editedAt: messages.editedAt,
  deletedAt: messages.deletedAt,
  createdAt: messages.createdAt,
  ciphertext: messages.ciphertext,
  nonce: messages.nonce,
  ephemeralPublicKey: messages.ephemeralPublicKey,
  senderDeviceId: messages.senderDeviceId,
  recipientDeviceId: messages.recipientDeviceId,
} as const;

export type MessageRow = Pick<InferSelectModel<typeof messages>, keyof typeof messageSelection>;

export class MessageMapper {
  toRecord(row: MessageRow): MessageRecord {
    return new MessageRecord(
      row.id,
      row.chatId,
      row.senderId,
      row.type as MessageType,
      row.body,
      row.replyToMessageId,
      row.forwardedFromChatId,
      row.forwardedFromMessageId,
      row.editedAt,
      row.deletedAt,
      row.createdAt,
      row.ciphertext ?? null,
      row.nonce ?? null,
      row.ephemeralPublicKey ?? null,
      row.senderDeviceId ?? null,
      row.recipientDeviceId ?? null,
    );
  }
}
