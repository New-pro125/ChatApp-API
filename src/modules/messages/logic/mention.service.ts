import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { NotFoundException } from '@/core/errors/http.error.js';
import type { UsernameReader } from '@/core/users/username.reader.js';
import type { MessageMentionRecord } from '@/modules/messages/logic/entities/message-mention-record.js';
import { MentionParser } from '@/modules/messages/logic/mention-parser.js';
import type { ChatMemberRepository } from '@/modules/messages/logic/ports/chat-member.repository.js';
import type {
  ListMentionsQuery,
  MessageMentionRepository,
} from '@/modules/messages/logic/ports/message-mention.repository.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';

/** Owns mention resolution, lifecycle, and inbox reads for the messages module. */
@injectable()
export class MentionService {
  private readonly parser = new MentionParser();

  constructor(
    @inject(MESSAGES_TYPES.MessageMentionRepository)
    private readonly repository: MessageMentionRepository,
    @inject(CORE_TYPES.UsernameReader) private readonly usernames: UsernameReader,
    @inject(MESSAGES_TYPES.ChatMemberRepository) private readonly members: ChatMemberRepository,
  ) {}

  async sync(chatId: string, messageId: string, body: string): Promise<void> {
    const names = this.parser.parse(body);

    const [memberships, resolved] = await Promise.all([
      this.members.listByChat(chatId),
      Promise.all(names.map((name) => this.usernames.findByUsername(name))),
    ]);

    const memberIds = new Set(
      memberships.filter((member) => member.leftAt === null).map((member) => member.userId),
    );
    const targets = resolved.filter((id): id is string => id !== null && memberIds.has(id));

    await this.repository.sync(chatId, messageId, [...new Set(targets)], new Date());
  }

  hideForMessage(chatId: string, messageId: string): Promise<void> {
    return this.repository.hideForMessage(chatId, messageId, new Date());
  }

  listForMessages(
    chatId: string,
    messageIds: readonly string[],
  ): Promise<Map<string, MessageMentionRecord[]>> {
    return this.repository.listForMessages(chatId, messageIds);
  }

  list(userId: string, query: ListMentionsQuery): Promise<MessageMentionRecord[]> {
    return this.repository.list(userId, query);
  }

  countUnread(userId: string): Promise<number> {
    return this.repository.countUnread(userId);
  }

  async markOne(userId: string, id: string): Promise<MessageMentionRecord> {
    const existing = await this.repository.findById(userId, id);

    if (!existing) {
      throw new NotFoundException('Mention not found');
    }

    await this.repository.markRead(userId, [id], new Date());

    return (await this.repository.findById(userId, id)) ?? existing;
  }

  markMany(userId: string, ids: readonly string[]): Promise<number> {
    const unique = [...new Set(ids)].slice(0, 100);
    return this.repository.markRead(userId, unique, new Date());
  }
}
