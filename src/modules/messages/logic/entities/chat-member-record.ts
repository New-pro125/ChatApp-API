export type ChatMemberRole = 'member' | 'admin' | 'owner';

/**
 * A user's membership in a chat.
 *
 * `leftAt` is reserved for a future leave/read model; 2.1 removes members by
 * deleting the row.
 */
export class ChatMemberRecord {
  constructor(
    readonly chatId: string,
    readonly userId: string,
    readonly role: ChatMemberRole,
    readonly joinedAt: Date,
    readonly leftAt: Date | null,
  ) {}
}
