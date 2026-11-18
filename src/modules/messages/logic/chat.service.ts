import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { UserNotFoundException } from '@/core/errors/domain.error.js';
import { BadRequestException } from '@/core/errors/http.error.js';
import { UniqueConstraintException } from '@/core/errors/repository.error.js';
import type { UserSummary, UserSummaryReader } from '@/core/users/user-summary.reader.js';
import type { ChatRecord } from '@/modules/messages/logic/entities/chat-record.js';
import { ChatView } from '@/modules/messages/logic/entities/chat-view.js';
import type { MessagingPolicy } from '@/modules/messages/logic/messaging-policy.service.js';
import type { ChatRepository } from '@/modules/messages/logic/ports/chat.repository.js';
import type { ChatMemberRepository } from '@/modules/messages/logic/ports/chat-member.repository.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';

export interface OpenDirectResult {
  readonly view: ChatView;
  readonly created: boolean;
}

/** Owns chat creation and the participant summaries shown in chat lists. */
@injectable()
export class ChatService {
  constructor(
    @inject(MESSAGES_TYPES.ChatRepository) private readonly chats: ChatRepository,
    @inject(MESSAGES_TYPES.ChatMemberRepository) private readonly members: ChatMemberRepository,
    @inject(MESSAGES_TYPES.MessagingPolicy) private readonly policy: MessagingPolicy,
    @inject(CORE_TYPES.UserSummaryReader) private readonly users: UserSummaryReader,
  ) {}

  async openDirect(creatorId: string, participantId: string): Promise<OpenDirectResult> {
    if (creatorId === participantId) {
      throw new BadRequestException('A direct chat requires two different users');
    }

    const participant = await this.users.findSummaries([participantId]);

    if (participant.length === 0) {
      throw new UserNotFoundException();
    }

    await this.policy.assertPairUnblocked(creatorId, participantId);

    const directKey = this.directKey(creatorId, participantId);
    const existing = await this.chats.findDirectByKey(directKey);

    if (existing) {
      return { view: await this.toView(existing), created: false };
    }

    const created = await this.createDirect(creatorId, participantId, directKey);

    return { view: await this.toView(created.chat), created: created.created };
  }

  async listForUser(userId: string): Promise<ChatView[]> {
    const chats = await this.chats.listByUser(userId);

    if (chats.length === 0) {
      return [];
    }

    const memberships = await this.members.listByChats(chats.map((chat) => chat.id));
    const userIds = [...new Set(memberships.map((membership) => membership.userId))];
    const summaries = await this.users.findSummaries(userIds);
    const summariesById = new Map(summaries.map((summary) => [summary.id, summary]));
    const byChat = new Map<string, UserSummary[]>();

    for (const membership of memberships) {
      const summary = summariesById.get(membership.userId);

      if (summary) {
        const group = byChat.get(membership.chatId) ?? [];
        group.push(summary);
        byChat.set(membership.chatId, group);
      }
    }

    return chats.map((chat) => new ChatView(chat, byChat.get(chat.id) ?? []));
  }

  /**
   * Creates the chat and both memberships. A concurrent request for the same
   * pair can lose the unique-key race; in that case the winning row is returned
   * as an existing chat rather than surfacing a 500 to the caller.
   */
  private async createDirect(
    creatorId: string,
    participantId: string,
    directKey: string,
  ): Promise<{ chat: ChatRecord; created: boolean }> {
    try {
      const chat = await this.chats.create({
        type: 'direct',
        title: null,
        directKey,
        createdBy: creatorId,
      });

      await this.members.add(chat.id, creatorId);
      await this.members.add(chat.id, participantId);

      return { chat, created: true };
    } catch (error) {
      if (!(error instanceof UniqueConstraintException)) {
        throw error;
      }

      const winner = await this.chats.findDirectByKey(directKey);

      if (!winner) {
        throw error;
      }

      return { chat: winner, created: false };
    }
  }

  private async toView(chat: ChatRecord): Promise<ChatView> {
    const memberships = await this.members.listByChat(chat.id);
    const summaries = await this.users.findSummaries(memberships.map((member) => member.userId));
    const summariesById = new Map(summaries.map((summary) => [summary.id, summary]));
    const participants = memberships.flatMap((member) => {
      const summary = summariesById.get(member.userId);
      return summary ? [summary] : [];
    });

    return new ChatView(chat, participants);
  }

  /** Order-independent key so either side can open the same direct chat. */
  private directKey(first: string, second: string): string {
    return [first, second].sort().join(':');
  }
}
