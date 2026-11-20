import { messageMentions, messages } from '@/core/database/schema/index.js';
import { MessageMentionRecord } from '@/modules/messages/logic/entities/message-mention-record.js';

/** Explicit column selection; the sender id comes from the joined message row. */
export const mentionSelection = {
  id: messageMentions.id,
  chatId: messageMentions.chatId,
  messageId: messageMentions.messageId,
  mentionedByUserId: messages.senderId,
  mentionedUserId: messageMentions.mentionedUserId,
  createdAt: messageMentions.createdAt,
  readAt: messageMentions.readAt,
  deletedAt: messageMentions.deletedAt,
} as const;

export interface MentionRow {
  id: string;
  chatId: string;
  messageId: string;
  mentionedByUserId: string;
  mentionedUserId: string;
  createdAt: Date;
  readAt: Date | null;
  deletedAt: Date | null;
}

export class MessageMentionMapper {
  toRecord(row: MentionRow): MessageMentionRecord {
    return new MessageMentionRecord(
      row.id,
      row.chatId,
      row.messageId,
      row.mentionedByUserId,
      row.mentionedUserId,
      row.createdAt,
      row.readAt,
      row.deletedAt,
    );
  }
}
