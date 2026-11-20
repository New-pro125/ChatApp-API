import type { InferSelectModel } from 'drizzle-orm';
import { messageDrafts } from '@/core/database/schema/index.js';
import { MessageDraftRecord } from '@/modules/messages/logic/entities/message-draft-record.js';

/** Explicit column selection for the `message_drafts` table. */
export const draftSelection = {
  chatId: messageDrafts.chatId,
  userId: messageDrafts.userId,
  body: messageDrafts.body,
  createdAt: messageDrafts.createdAt,
  updatedAt: messageDrafts.updatedAt,
} as const;

export type DraftRow = Pick<InferSelectModel<typeof messageDrafts>, keyof typeof draftSelection>;

export class MessageDraftMapper {
  toRecord(row: DraftRow): MessageDraftRecord {
    return new MessageDraftRecord(row.chatId, row.userId, row.body, row.createdAt, row.updatedAt);
  }
}
