import type {
  MessageMediaFields,
  MessageRecord,
  MessageType,
} from '@/modules/messages/logic/entities/message-record.js';

/** Input accepted when creating a message. */
export interface CreateMessageInput {
  chatId: string;
  senderId: string;
  body: string | null;
  type?: MessageType;
  media?: MessageMediaFields;
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

/** Ciphertext payload accepted when creating a secret message. */
export interface CreateSecretMessageInput {
  chatId: string;
  senderId: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  ciphertext: string;
  nonce: string;
  ephemeralPublicKey: string;
}

export interface MessageRepository {
  create(input: CreateMessageInput): Promise<MessageRecord>;

  createSecret(input: CreateSecretMessageInput): Promise<MessageRecord>;

  findById(chatId: string, id: string): Promise<MessageRecord | null>;

  /** Newest-first page of a chat's messages, optionally before a cursor. */
  listByChat(chatId: string, query: ListMessagesQuery): Promise<MessageRecord[]>;

  /** Edits a message body, stamping `editedAt`. Null when no row matched. */
  editBody(chatId: string, id: string, body: string, editedAt: Date): Promise<MessageRecord | null>;

  /** Soft-deletes a message once; false when it is missing or already deleted. */
  markDeleted(chatId: string, id: string, deletedAt: Date): Promise<boolean>;

  /** Whether any message still points at the media object and is not deleted. */
  hasLiveMediaReferences(mediaId: string): Promise<boolean>;

  /** Newest message id in a chat, or null when the chat has no messages. */
  maxIdByChat(chatId: string): Promise<string | null>;

  /** Live messages among the given ids, scoped by chat for partition pruning. */
  listByIds(chatId: string, ids: readonly string[]): Promise<MessageRecord[]>;

  /** Live messages from other participants newer than the reader watermark. */
  countUnread(chatId: string, readerId: string, watermarkId: string | null): Promise<number>;

  /** Batched variant for chat lists; chats with zero unread may be absent. */
  countUnreadByChats(readerId: string, chatIds: readonly string[]): Promise<Map<string, number>>;
}
