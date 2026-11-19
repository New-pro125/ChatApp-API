export interface PinRecord {
  readonly messageId: string;
  readonly pinnedAt: Date;
  readonly expiresAt: Date;
}

/** Caller-specific indicator for one message in a page of history. */
export interface PinIndicators {
  readonly pinnedAt: Date;
  readonly expiresAt: Date;
}

/** Per-user, private message bookmarks. Every method is scoped by chat and user. */
export interface MessagePinRepository {
  /** Returns null when the caller already has ten active pins in this chat. */
  pin(
    chatId: string,
    userId: string,
    messageId: string,
    expiresAt: Date,
  ): Promise<PinRecord | null>;

  /** True when a pin was removed, false when none existed. */
  unpin(chatId: string, userId: string, messageId: string): Promise<boolean>;

  /** Caller's active pins in this chat, newest pin first. */
  list(chatId: string, userId: string): Promise<PinRecord[]>;

  /** Batched active-indicator lookup for one page of message ids. */
  listPinnedFor(
    chatId: string,
    userId: string,
    messageIds: readonly string[],
  ): Promise<Map<string, PinIndicators>>;

  /** Deletes at most `limit` elapsed rows; returns the deleted count. */
  deleteExpired(now: Date, limit: number): Promise<number>;

  /** Removes every user's pin of one message. */
  removeForMessage(chatId: string, messageId: string): Promise<void>;
}
