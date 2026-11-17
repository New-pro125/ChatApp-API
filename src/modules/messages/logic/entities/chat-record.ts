export type ChatType = 'direct' | 'group' | 'channel';

/**
 * A chat: a direct conversation, a group, or a channel.
 *
 * `directKey` is the deterministic, order-independent key for a direct pair and
 * is only set for `direct` chats; the database enforces the relationship
 * between `type`, `title`, and `directKey`.
 */
export class ChatRecord {
  constructor(
    readonly id: string,
    readonly type: ChatType,
    readonly title: string | null,
    readonly directKey: string | null,
    readonly createdBy: string | null,
    readonly createdAt: Date,
    readonly updatedAt: Date,
  ) {}
}
