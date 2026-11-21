import type { UserSummary } from '@/core/users/user-summary.reader.js';
import type { ChatRecord, ChatType } from '@/modules/messages/logic/entities/chat-record.js';
import type { SelfDestructPreset } from '@/modules/messages/logic/entities/self-destruct-preset.js';

/**
 * A chat hydrated with its participants' public display data.
 *
 * The full user record never leaves the auth module; only the summary fields
 * needed to render a conversation row are carried across the boundary.
 * `unreadCount` is caller-private and independent of receipt mutuality.
 * `selfDestructPreset` is the viewer's own setting, never the peer's. `muted`
 * and `muteExpiresAt` are likewise the viewer's own mute setting, never the
 * peer's.
 */
export class ChatView {
  readonly id: string;
  readonly type: ChatType;
  readonly title: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;

  constructor(
    chat: ChatRecord,
    readonly participants: readonly UserSummary[],
    readonly unreadCount: number,
    readonly selfDestructPreset: SelfDestructPreset | null = null,
    readonly muted = false,
    readonly muteExpiresAt: Date | null = null,
  ) {
    this.id = chat.id;
    this.type = chat.type;
    this.title = chat.title;
    this.createdAt = chat.createdAt;
    this.updatedAt = chat.updatedAt;
  }
}
