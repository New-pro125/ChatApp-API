import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { NotChatMemberException, UserBlockedException } from '@/core/errors/domain.error.js';
import type { UserBlockReader } from '@/core/privacy/user-block.reader.js';
import type { ChatMemberRepository } from '@/modules/messages/logic/ports/chat-member.repository.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';

/**
 * Shared authorization rules for messaging.
 *
 * Membership and block checks are needed by both chat and message flows, so
 * they live in one service rather than being duplicated in each caller. A
 * conversation is unavailable when either participant has blocked the other.
 */
@injectable()
export class MessagingPolicy {
  constructor(
    @inject(MESSAGES_TYPES.ChatMemberRepository)
    private readonly members: ChatMemberRepository,
    @inject(CORE_TYPES.UserBlockReader) private readonly blocks: UserBlockReader,
  ) {}

  async requireMember(chatId: string, userId: string): Promise<void> {
    const membership = await this.members.find(chatId, userId);

    if (!membership) {
      throw new NotChatMemberException();
    }
  }

  async assertChatUnblocked(chatId: string, userId: string): Promise<void> {
    const memberships = await this.members.listByChat(chatId);

    for (const member of memberships) {
      if (member.userId !== userId) {
        await this.assertPairUnblocked(userId, member.userId);
      }
    }
  }

  async assertPairUnblocked(firstUserId: string, secondUserId: string): Promise<void> {
    if (await this.blocks.isBlockedBetween(firstUserId, secondUserId)) {
      throw new UserBlockedException();
    }
  }
}
