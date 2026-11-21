import type { SelfDestructPreset } from '@/modules/messages/logic/entities/self-destruct-preset.js';

export type ChatMemberRole = 'member' | 'admin' | 'owner';

/**
 * A user's membership in a chat.
 *
 * `leftAt` is reserved for a future leave model; 2.1 removes members by
 * deleting the row. The read watermark is a monotonic per-membership cursor:
 * `null` means nothing has been read yet. `selfDestructPreset` is the caller's
 * own timer; `mutedAt`/`mutedUntil` are the caller's own notification
 * preference. `mutedUntil = null` with `mutedAt` set means forever.
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
    readonly selfDestructPreset: SelfDestructPreset | null = null,
    readonly mutedAt: Date | null = null,
    readonly mutedUntil: Date | null = null,
  ) {}
}
