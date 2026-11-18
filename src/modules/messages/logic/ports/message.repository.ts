import type {
  MessageRecord,
  MessageType,
} from '@/modules/messages/logic/entities/message-record.js';

/** Input accepted when creating a message. */
export interface CreateMessageInput {
  chatId: string;
  senderId: string;
  body: string;
  type?: MessageType;
  replyToMessageId?: string | null;
  forwardedFromChatId?: string | null;
  forwardedFromMessageId?: string | null;
}

/**
 * A page request for a chat's history.
 *
 * Pagination keysets on the message id alone. Ids are uuidv7 (time-ordered), so
 * `id` ordering is newest-first, and the `(chat_id, id)` primary key serves the
 * query without a timestamp cursor. A `Date` cursor cannot be used here: the
 * database stores `created_at` at microsecond precision while JavaScript `Date`
 * only holds milliseconds, so a timestamp cursor silently skips rows that share
 * a millisecond.
 */
export interface ListMessagesQuery {
  limit: number;
  /** Return messages strictly older than this message id. */
  beforeId?: string | undefined;
}

export interface MessageRepository {
  create(input: CreateMessageInput): Promise<MessageRecord>;

  findById(chatId: string, id: string): Promise<MessageRecord | null>;

  /** Newest-first page of a chat's messages, optionally before a cursor. */
  listByChat(chatId: string, query: ListMessagesQuery): Promise<MessageRecord[]>;

  /** Edits a message body, stamping `editedAt`. Null when no row matched. */
  editBody(chatId: string, id: string, body: string, editedAt: Date): Promise<MessageRecord | null>;

  /** Soft-deletes a message once; false when it is missing or already deleted. */
  markDeleted(chatId: string, id: string, deletedAt: Date): Promise<boolean>;
}
