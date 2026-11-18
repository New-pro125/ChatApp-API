import { desc, eq } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { PostgresErrorInspector } from '@/core/database/database.error-inspector.js';
import type { AppDatabase } from '@/core/database/database.provider.js';
import { chatMembers, chats } from '@/core/database/schema/index.js';
import { PersistenceException, UniqueConstraintException } from '@/core/errors/repository.error.js';
import { ChatMapper, chatSelection } from '@/modules/messages/data/chat.mapper.js';
import type { ChatRecord } from '@/modules/messages/logic/entities/chat-record.js';
import type {
  ChatRepository,
  CreateChatInput,
} from '@/modules/messages/logic/ports/chat.repository.js';

/**
 * PostgreSQL persistence for chats.
 *
 * The unique violation on `chats_direct_key_unique` is translated so the
 * messaging service can treat "direct chat already exists" as a domain
 * condition rather than a raw driver error.
 */
@injectable()
export class PostgresChatRepository implements ChatRepository {
  private readonly mapper = new ChatMapper();
  private readonly inspector = new PostgresErrorInspector();

  constructor(@inject(CORE_TYPES.Db) private readonly db: AppDatabase) {}

  async create(input: CreateChatInput): Promise<ChatRecord> {
    try {
      const rows = await this.db
        .insert(chats)
        .values({
          type: input.type,
          title: input.title,
          directKey: input.directKey,
          createdBy: input.createdBy,
        })
        .returning(chatSelection);

      const row = rows[0];

      if (!row) {
        throw new PersistenceException('PostgreSQL did not return the created chat');
      }

      return this.mapper.toRecord(row);
    } catch (error) {
      if (error instanceof PersistenceException) {
        throw error;
      }

      if (this.inspector.isUniqueViolation(error)) {
        throw new UniqueConstraintException(
          this.inspector.constraintName(error) ?? 'chats_direct_key_unique',
          { cause: error },
        );
      }

      throw new PersistenceException('Failed to create chat', { cause: error });
    }
  }

  async createWithMembers(
    input: CreateChatInput,
    memberIds: readonly string[],
  ): Promise<ChatRecord> {
    try {
      return await this.db.transaction(async (tx) => {
        const rows = await tx
          .insert(chats)
          .values({
            type: input.type,
            title: input.title,
            directKey: input.directKey,
            createdBy: input.createdBy,
          })
          .returning(chatSelection);

        const row = rows[0];

        if (!row) {
          throw new PersistenceException('PostgreSQL did not return the created chat');
        }

        const uniqueMemberIds = [...new Set(memberIds)];

        if (uniqueMemberIds.length > 0) {
          await tx
            .insert(chatMembers)
            .values(uniqueMemberIds.map((userId) => ({ chatId: row.id, userId })));
        }

        return this.mapper.toRecord(row);
      });
    } catch (error) {
      if (error instanceof PersistenceException) {
        throw error;
      }

      if (this.inspector.isUniqueViolation(error)) {
        throw new UniqueConstraintException(
          this.inspector.constraintName(error) ?? 'chats_direct_key_unique',
          { cause: error },
        );
      }

      throw new PersistenceException('Failed to create chat with members', { cause: error });
    }
  }

  async findById(id: string): Promise<ChatRecord | null> {
    try {
      const rows = await this.db.select(chatSelection).from(chats).where(eq(chats.id, id)).limit(1);

      return rows[0] ? this.mapper.toRecord(rows[0]) : null;
    } catch (error) {
      throw new PersistenceException('Failed to load chat', { cause: error });
    }
  }

  async findDirectByKey(directKey: string): Promise<ChatRecord | null> {
    try {
      const rows = await this.db
        .select(chatSelection)
        .from(chats)
        .where(eq(chats.directKey, directKey))
        .limit(1);

      return rows[0] ? this.mapper.toRecord(rows[0]) : null;
    } catch (error) {
      throw new PersistenceException('Failed to load direct chat', { cause: error });
    }
  }

  async listByUser(userId: string): Promise<ChatRecord[]> {
    try {
      const rows = await this.db
        .select(chatSelection)
        .from(chats)
        .innerJoin(chatMembers, eq(chatMembers.chatId, chats.id))
        .where(eq(chatMembers.userId, userId))
        .orderBy(desc(chats.updatedAt), desc(chats.id));

      return rows.map((row) => this.mapper.toRecord(row));
    } catch (error) {
      throw new PersistenceException('Failed to list chats', { cause: error });
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      const rows = await this.db.delete(chats).where(eq(chats.id, id)).returning({ id: chats.id });

      return rows.length > 0;
    } catch (error) {
      throw new PersistenceException('Failed to delete chat', { cause: error });
    }
  }
}
