export interface PinRecord {
  readonly messageId: string;
  readonly pinnedAt: Date;
}

/** Per-user, private message bookmarks. Every method is scoped by chat and user. */
export interface MessagePinRepository {
  /** Returns null when the caller already has ten pins in this chat. */
  pin(chatId: string, userId: string, messageId: string): Promise<PinRecord | null>;

  /** True when a pin was removed, false when none existed. */
  unpin(chatId: string, userId: string, messageId: string): Promise<boolean>;

  /** Caller's pins in this chat, newest pin first. */
  list(chatId: string, userId: string): Promise<PinRecord[]>;

  /** Batched indicator lookup for one page of message ids. */
  listPinnedFor(
    chatId: string,
    userId: string,
    messageIds: readonly string[],
  ): Promise<Map<string, Date>>;

  /** Removes every user's pin of one message. */
  removeForMessage(chatId: string, messageId: string): Promise<void>;
}
