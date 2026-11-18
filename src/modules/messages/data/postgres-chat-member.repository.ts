import { and, asc, eq, inArray } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { PostgresErrorInspector } from '@/core/database/database.error-inspector.js';
import type { AppDatabase } from '@/core/database/database.provider.js';
import { chatMembers } from '@/core/database/schema/index.js';
import { PersistenceException, UniqueConstraintException } from '@/core/errors/repository.error.js';
import {
  ChatMemberMapper,
  chatMemberSelection,
} from '@/modules/messages/data/chat-member.mapper.js';
import type {
  ChatMemberRecord,
  ChatMemberRole,
} from '@/modules/messages/logic/entities/chat-member-record.js';
import type { ChatMemberRepository } from '@/modules/messages/logic/ports/chat-member.repository.js';

/** PostgreSQL persistence for chat membership. */
@injectable()
export class PostgresChatMemberRepository implements ChatMemberRepository {
  private readonly mapper = new ChatMemberMapper();
  private readonly inspector = new PostgresErrorInspector();

  constructor(@inject(CORE_TYPES.Db) private readonly db: AppDatabase) {}

  async add(
    chatId: string,
    userId: string,
    role: ChatMemberRole = 'member',
  ): Promise<ChatMemberRecord> {
    try {
      const rows = await this.db
        .insert(chatMembers)
        .values({ chatId, userId, role })
        .returning(chatMemberSelection);

      const row = rows[0];

      if (!row) {
        throw new PersistenceException('PostgreSQL did not return the created membership');
      }

      return this.mapper.toRecord(row);
    } catch (error) {
      if (error instanceof PersistenceException) {
        throw error;
      }

      if (this.inspector.isUniqueViolation(error)) {
        throw new UniqueConstraintException(
          this.inspector.constraintName(error) ?? 'chat_members_pkey',
          { cause: error },
        );
      }

      throw new PersistenceException('Failed to add chat member', { cause: error });
    }
  }

  async find(chatId: string, userId: string): Promise<ChatMemberRecord | null> {
    try {
      const rows = await this.db
        .select(chatMemberSelection)
        .from(chatMembers)
        .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)))
        .limit(1);

      return rows[0] ? this.mapper.toRecord(rows[0]) : null;
    } catch (error) {
      throw new PersistenceException('Failed to load chat member', { cause: error });
    }
  }

  async listByChat(chatId: string): Promise<ChatMemberRecord[]> {
    try {
      const rows = await this.db
        .select(chatMemberSelection)
        .from(chatMembers)
        .where(eq(chatMembers.chatId, chatId))
        .orderBy(asc(chatMembers.joinedAt), asc(chatMembers.userId));

      return rows.map((row) => this.mapper.toRecord(row));
    } catch (error) {
      throw new PersistenceException('Failed to list chat members', { cause: error });
    }
  }

  async listByChats(chatIds: readonly string[]): Promise<ChatMemberRecord[]> {
    if (chatIds.length === 0) {
      return [];
    }

    try {
      const rows = await this.db
        .select(chatMemberSelection)
        .from(chatMembers)
        .where(inArray(chatMembers.chatId, [...chatIds]));

      return rows.map((row) => this.mapper.toRecord(row));
    } catch (error) {
      throw new PersistenceException('Failed to list chat members', { cause: error });
    }
  }

  async remove(chatId: string, userId: string): Promise<boolean> {
    try {
      const rows = await this.db
        .delete(chatMembers)
        .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)))
        .returning({ userId: chatMembers.userId });

      return rows.length > 0;
    } catch (error) {
      throw new PersistenceException('Failed to remove chat member', { cause: error });
    }
  }
}
