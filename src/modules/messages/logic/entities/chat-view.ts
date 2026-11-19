import type { UserSummary } from '@/core/users/user-summary.reader.js';
import type { ChatRecord, ChatType } from '@/modules/messages/logic/entities/chat-record.js';

/**
 * A chat hydrated with its participants' public display data.
 *
 * The full user record never leaves the auth module; only the summary fields
 * needed to render a conversation row are carried across the boundary.
 * `unreadCount` is caller-private and independent of receipt mutuality.
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
  ) {
    this.id = chat.id;
    this.type = chat.type;
    this.title = chat.title;
    this.createdAt = chat.createdAt;
    this.updatedAt = chat.updatedAt;
  }
}
