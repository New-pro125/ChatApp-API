export type ChatMemberRole = 'member' | 'admin' | 'owner';

/**
 * A user's membership in a chat.
 *
 * `leftAt` is reserved for a future leave model; 2.1 removes members by
 * deleting the row. The read watermark is a monotonic per-membership cursor:
 * `null` means nothing has been read yet.
 */
export class ChatMemberRecord {
  constructor(
    readonly chatId: string,
    readonly userId: string,
    readonly role: ChatMemberRole,
    readonly joinedAt: Date,
    readonly leftAt: Date | null,
    readonly lastReadMessageId: string | null = null,
    readonly lastReadAt: Date | null = null,
  ) {}
}
