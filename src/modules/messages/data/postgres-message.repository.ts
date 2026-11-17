import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { AppDatabase } from '@/core/database/database.provider.js';
import { messages } from '@/core/database/schema/index.js';
import { PersistenceException } from '@/core/errors/repository.error.js';
import { MessageMapper, messageSelection } from '@/modules/messages/data/message.mapper.js';
import type { MessageRecord } from '@/modules/messages/logic/entities/message-record.js';
import type {
  CreateMessageInput,
  ListMessagesQuery,
  MessageRepository,
} from '@/modules/messages/logic/ports/message.repository.js';

/**
 * PostgreSQL persistence for messages.
 *
 * Every query filters by `chat_id` because the table is hash partitioned by it:
 * the partition key is part of the primary key and leads every index, so a
 * lookup without it cannot prune partitions. History uses keyset pagination on
 * `(created_at, id)`, matching the `(chat_id, created_at desc, id desc)` index.
 */
@injectable()
export class PostgresMessageRepository implements MessageRepository {
  private readonly mapper = new MessageMapper();

  constructor(@inject(CORE_TYPES.Db) private readonly db: AppDatabase) {}

  async create(input: CreateMessageInput): Promise<MessageRecord> {
    try {
      const rows = await this.db
        .insert(messages)
        .values({
          chatId: input.chatId,
          senderId: input.senderId,
          type: input.type ?? 'text',
          body: input.body,
          replyToMessageId: input.replyToMessageId ?? null,
          forwardedFromChatId: input.forwardedFromChatId ?? null,
          forwardedFromMessageId: input.forwardedFromMessageId ?? null,
        })
        .returning(messageSelection);

      const row = rows[0];

      if (!row) {
        throw new PersistenceException('PostgreSQL did not return the created message');
      }

      return this.mapper.toRecord(row);
    } catch (error) {
      if (error instanceof PersistenceException) {
        throw error;
      }

      throw new PersistenceException('Failed to create message', { cause: error });
    }
  }

  async findById(chatId: string, id: string): Promise<MessageRecord | null> {
    try {
      const rows = await this.db
        .select(messageSelection)
        .from(messages)
        .where(and(eq(messages.chatId, chatId), eq(messages.id, id)))
        .limit(1);

      return rows[0] ? this.mapper.toRecord(rows[0]) : null;
    } catch (error) {
      throw new PersistenceException('Failed to load message', { cause: error });
    }
  }

  async listByChat(chatId: string, query: ListMessagesQuery): Promise<MessageRecord[]> {
    try {
      const conditions = [eq(messages.chatId, chatId)];

      if (query.before) {
        conditions.push(
          sql`(${messages.createdAt}, ${messages.id}) < (${query.before.createdAt}, ${query.before.id})`,
        );
      }

      const rows = await this.db
        .select(messageSelection)
        .from(messages)
        .where(and(...conditions))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(query.limit);

      return rows.map((row) => this.mapper.toRecord(row));
    } catch (error) {
      throw new PersistenceException('Failed to list messages', { cause: error });
    }
  }

  async editBody(
    chatId: string,
    id: string,
    body: string,
    editedAt: Date,
  ): Promise<MessageRecord | null> {
    try {
      const rows = await this.db
        .update(messages)
        .set({ body, editedAt })
        .where(and(eq(messages.chatId, chatId), eq(messages.id, id)))
        .returning(messageSelection);

      return rows[0] ? this.mapper.toRecord(rows[0]) : null;
    } catch (error) {
      throw new PersistenceException('Failed to edit message', { cause: error });
    }
  }

  async markDeleted(chatId: string, id: string, deletedAt: Date): Promise<boolean> {
    try {
      const rows = await this.db
        .update(messages)
        .set({ deletedAt })
        .where(and(eq(messages.chatId, chatId), eq(messages.id, id), isNull(messages.deletedAt)))
        .returning({ id: messages.id });

      return rows.length > 0;
    } catch (error) {
      throw new PersistenceException('Failed to delete message', { cause: error });
    }
  }
}
