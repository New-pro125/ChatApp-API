import type {
  ChatMemberRecord,
  ChatMemberRole,
} from '@/modules/messages/logic/entities/chat-member-record.js';

export interface ChatMemberRepository {
  add(chatId: string, userId: string, role?: ChatMemberRole): Promise<ChatMemberRecord>;

  find(chatId: string, userId: string): Promise<ChatMemberRecord | null>;

  /** Members of a chat, oldest membership first. */
  listByChat(chatId: string): Promise<ChatMemberRecord[]>;

  /** Memberships for several chats, used to hydrate chat lists without N+1 queries. */
  listByChats(chatIds: readonly string[]): Promise<ChatMemberRecord[]>;

  /** Returns whether a membership row was removed. */
  remove(chatId: string, userId: string): Promise<boolean>;

  /**
   * Advances the read watermark only when `messageId` is newer than the stored
   * id. Returns the current membership row, including on a stale no-op.
   */
  markRead(chatId: string, userId: string, messageId: string): Promise<ChatMemberRecord>;
}
