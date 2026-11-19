import type { InferSelectModel } from 'drizzle-orm';
import { chatMembers } from '@/core/database/schema/index.js';
import {
  ChatMemberRecord,
  type ChatMemberRole,
} from '@/modules/messages/logic/entities/chat-member-record.js';

/** Explicit column selection for the `chat_members` table. */
export const chatMemberSelection = {
  chatId: chatMembers.chatId,
  userId: chatMembers.userId,
  role: chatMembers.role,
  joinedAt: chatMembers.joinedAt,
  leftAt: chatMembers.leftAt,
  lastReadMessageId: chatMembers.lastReadMessageId,
  lastReadAt: chatMembers.lastReadAt,
} as const;

export type ChatMemberRow = Pick<
  InferSelectModel<typeof chatMembers>,
  keyof typeof chatMemberSelection
>;

export class ChatMemberMapper {
  toRecord(row: ChatMemberRow): ChatMemberRecord {
    return new ChatMemberRecord(
      row.chatId,
      row.userId,
      row.role as ChatMemberRole,
      row.joinedAt,
      row.leftAt,
      row.lastReadMessageId,
      row.lastReadAt,
    );
  }
}
