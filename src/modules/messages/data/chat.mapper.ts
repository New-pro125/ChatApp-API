import type { InferSelectModel } from 'drizzle-orm';
import { chats } from '@/core/database/schema/index.js';
import { ChatRecord, type ChatType } from '@/modules/messages/logic/entities/chat-record.js';

/** Explicit column selection for the `chats` table. */
export const chatSelection = {
  id: chats.id,
  type: chats.type,
  title: chats.title,
  directKey: chats.directKey,
  createdBy: chats.createdBy,
  createdAt: chats.createdAt,
  updatedAt: chats.updatedAt,
} as const;

export type ChatRow = Pick<InferSelectModel<typeof chats>, keyof typeof chatSelection>;

export class ChatMapper {
  toRecord(row: ChatRow): ChatRecord {
    return new ChatRecord(
      row.id,
      row.type as ChatType,
      row.title,
      row.directKey,
      row.createdBy,
      row.createdAt,
      row.updatedAt,
    );
  }
}
