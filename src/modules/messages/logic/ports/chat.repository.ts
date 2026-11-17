import type { ChatRecord, ChatType } from '@/modules/messages/logic/entities/chat-record.js';

/** Input accepted when creating a chat. */
export interface CreateChatInput {
  type: ChatType;
  title: string | null;
  directKey: string | null;
  createdBy: string | null;
}

export interface ChatRepository {
  create(input: CreateChatInput): Promise<ChatRecord>;

  findById(id: string): Promise<ChatRecord | null>;

  /** Looks up the single direct chat for a deterministic pair key. */
  findDirectByKey(directKey: string): Promise<ChatRecord | null>;

  /** Chats the user is a member of, most recently updated first. */
  listByUser(userId: string): Promise<ChatRecord[]>;

  /** Deletes a chat and, by cascade, its members and messages. */
  delete(id: string): Promise<boolean>;
}
