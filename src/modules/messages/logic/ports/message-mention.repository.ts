import type { MessageMentionRecord } from '@/modules/messages/logic/entities/message-mention-record.js';

export interface ListMentionsQuery {
  limit: number;
  /** Return rows strictly older than this mention id. */
  beforeId?: string | undefined;
}

export interface MessageMentionRepository {
  /** Inserts missing rows, hard-deletes removed targets, keeps retained rows. */
  sync(chatId: string, messageId: string, userIds: readonly string[], now: Date): Promise<void>;

  /** Idempotently stamps deleted_at on visible rows for a message. */
  hideForMessage(chatId: string, messageId: string, now: Date): Promise<void>;

  /** Visible rows for several messages in one chat, batched for history pages. */
  listForMessages(
    chatId: string,
    messageIds: readonly string[],
  ): Promise<Map<string, MessageMentionRecord[]>>;

  list(userId: string, query: ListMentionsQuery): Promise<MessageMentionRecord[]>;

  countUnread(userId: string): Promise<number>;

  findById(userId: string, id: string): Promise<MessageMentionRecord | null>;

  /** Number of owned, visible, still-unread rows stamped as read. */
  markRead(userId: string, ids: readonly string[], now: Date): Promise<number>;
}
