import type { MessageDraftRecord } from '@/modules/messages/logic/entities/message-draft-record.js';

/** Private, one-per-(chat, caller) unsent text drafts. */
export interface MessageDraftRepository {
  /** Returns null when no draft exists. */
  find(chatId: string, userId: string): Promise<MessageDraftRecord | null>;

  /** Inserts or overwrites in place; `createdAt` survives a conflict. */
  upsert(chatId: string, userId: string, body: string, now: Date): Promise<MessageDraftRecord>;

  /** True when a row was removed, false when none existed. */
  delete(chatId: string, userId: string): Promise<boolean>;
}
