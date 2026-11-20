import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { AppDatabase } from '@/core/database/database.provider.js';
import { messageMentions, messages } from '@/core/database/schema/index.js';
import { PersistenceException } from '@/core/errors/repository.error.js';
import {
  MessageMentionMapper,
  mentionSelection,
} from '@/modules/messages/data/message-mention.mapper.js';
import type { MessageMentionRecord } from '@/modules/messages/logic/entities/message-mention-record.js';
import type {
  ListMentionsQuery,
  MessageMentionRepository,
} from '@/modules/messages/logic/ports/message-mention.repository.js';

@injectable()
export class PostgresMessageMentionRepository implements MessageMentionRepository {
  private readonly mapper = new MessageMentionMapper();

  constructor(@inject(CORE_TYPES.Db) private readonly db: AppDatabase) {}

  async sync(
    chatId: string,
    messageId: string,
    userIds: readonly string[],
    now: Date,
  ): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        // Serialize rewrites of one message's mention set. Transaction-scoped row
        // locks are safe with PgBouncer's transaction pooling.
        await tx
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.chatId, chatId), eq(messages.id, messageId)))
          .for('update');

        const existing = await tx
          .select({ id: messageMentions.id, userId: messageMentions.mentionedUserId })
          .from(messageMentions)
          .where(and(eq(messageMentions.chatId, chatId), eq(messageMentions.messageId, messageId)));

        const desired = new Set(userIds);
        const stale = existing.filter((row) => !desired.has(row.userId)).map((row) => row.id);

        if (stale.length > 0) {
          await tx.delete(messageMentions).where(inArray(messageMentions.id, stale));
        }

        const present = new Set(
          existing.filter((row) => desired.has(row.userId)).map((row) => row.userId),
        );
        const missing = [...desired].filter((userId) => !present.has(userId));

        if (missing.length > 0) {
          await tx
            .insert(messageMentions)
            .values(
              missing.map((userId) => ({
                chatId,
                messageId,
                mentionedUserId: userId,
                createdAt: now,
              })),
            )
            .onConflictDoNothing({
              target: [
                messageMentions.chatId,
                messageMentions.messageId,
                messageMentions.mentionedUserId,
              ],
            });
        }
      });
    } catch (error) {
      throw new PersistenceException('Failed to sync message mentions', { cause: error });
    }
  }

  async hideForMessage(chatId: string, messageId: string, now: Date): Promise<void> {
    try {
      await this.db
        .update(messageMentions)
        .set({ deletedAt: now })
        .where(
          and(
            eq(messageMentions.chatId, chatId),
            eq(messageMentions.messageId, messageId),
            isNull(messageMentions.deletedAt),
          ),
        );
    } catch (error) {
      throw new PersistenceException('Failed to hide message mentions', { cause: error });
    }
  }

  async listForMessages(
    chatId: string,
    messageIds: readonly string[],
  ): Promise<Map<string, MessageMentionRecord[]>> {
    const result = new Map<string, MessageMentionRecord[]>();

    if (messageIds.length === 0) {
      return result;
    }

    try {
      const rows = await this.db
        .select(mentionSelection)
        .from(messageMentions)
        .innerJoin(
          messages,
          and(
            eq(messages.chatId, messageMentions.chatId),
            eq(messages.id, messageMentions.messageId),
          ),
        )
        .where(
          and(
            eq(messageMentions.chatId, chatId),
            inArray(messageMentions.messageId, [...messageIds]),
            isNull(messageMentions.deletedAt),
          ),
        )
        .orderBy(messageMentions.createdAt);

      for (const row of rows) {
        const group = result.get(row.messageId) ?? [];
        group.push(this.mapper.toRecord(row));
        result.set(row.messageId, group);
      }

      return result;
    } catch (error) {
      throw new PersistenceException('Failed to list message mentions', { cause: error });
    }
  }

  async list(userId: string, query: ListMentionsQuery): Promise<MessageMentionRecord[]> {
    try {
      const rows = await this.db
        .select(mentionSelection)
        .from(messageMentions)
        .innerJoin(
          messages,
          and(
            eq(messages.chatId, messageMentions.chatId),
            eq(messages.id, messageMentions.messageId),
          ),
        )
        .where(
          and(
            eq(messageMentions.mentionedUserId, userId),
            isNull(messageMentions.deletedAt),
            query.beforeId === undefined ? undefined : lt(messageMentions.id, query.beforeId),
          ),
        )
        .orderBy(desc(messageMentions.id))
        .limit(query.limit);

      return rows.map((row) => this.mapper.toRecord(row));
    } catch (error) {
      throw new PersistenceException('Failed to list mentions', { cause: error });
    }
  }

  async countUnread(userId: string): Promise<number> {
    try {
      const rows = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(messageMentions)
        .where(
          and(
            eq(messageMentions.mentionedUserId, userId),
            isNull(messageMentions.deletedAt),
            isNull(messageMentions.readAt),
          ),
        );

      return rows[0]?.count ?? 0;
    } catch (error) {
      throw new PersistenceException('Failed to count unread mentions', { cause: error });
    }
  }

  async findById(userId: string, id: string): Promise<MessageMentionRecord | null> {
    try {
      const rows = await this.db
        .select(mentionSelection)
        .from(messageMentions)
        .innerJoin(
          messages,
          and(
            eq(messages.chatId, messageMentions.chatId),
            eq(messages.id, messageMentions.messageId),
          ),
        )
        .where(
          and(
            eq(messageMentions.mentionedUserId, userId),
            eq(messageMentions.id, id),
            isNull(messageMentions.deletedAt),
          ),
        )
        .limit(1);

      return rows[0] ? this.mapper.toRecord(rows[0]) : null;
    } catch (error) {
      throw new PersistenceException('Failed to load mention', { cause: error });
    }
  }

  async markRead(userId: string, ids: readonly string[], now: Date): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }

    try {
      const rows = await this.db
        .update(messageMentions)
        .set({ readAt: now })
        .where(
          and(
            inArray(messageMentions.id, [...ids]),
            eq(messageMentions.mentionedUserId, userId),
            isNull(messageMentions.deletedAt),
            isNull(messageMentions.readAt),
          ),
        )
        .returning({ id: messageMentions.id });

      return rows.length;
    } catch (error) {
      throw new PersistenceException('Failed to mark mentions read', { cause: error });
    }
  }
}
