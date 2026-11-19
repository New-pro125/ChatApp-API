import { and, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { AppDatabase } from '@/core/database/database.provider.js';
import { chatMembers, chats, messages } from '@/core/database/schema/index.js';
import { PersistenceException } from '@/core/errors/repository.error.js';
import { MessageMapper, messageSelection } from '@/modules/messages/data/message.mapper.js';
import type { MessageRecord } from '@/modules/messages/logic/entities/message-record.js';
import type {
  CreateMessageInput,
  CreateSecretMessageInput,
  ListMessagesQuery,
  MessageRepository,
} from '@/modules/messages/logic/ports/message.repository.js';

/**
 * PostgreSQL persistence for messages.
 *
 * Every query filters by `chat_id` because the table is hash partitioned by it:
 * the partition key is part of the primary key, so a lookup without it cannot
 * prune partitions. History keysets on `id` (uuidv7, newest-first), which the
 * `(chat_id, id)` primary key serves directly.
 *
 * `create` also bumps `chats.updated_at` in the same transaction, so a chat that
 * receives a message always sorts ahead of quieter chats in the chat list.
 */
@injectable()
export class PostgresMessageRepository implements MessageRepository {
  private readonly mapper = new MessageMapper();

  constructor(@inject(CORE_TYPES.Db) private readonly db: AppDatabase) {}

  async create(input: CreateMessageInput): Promise<MessageRecord> {
    try {
      return await this.db.transaction(async (tx) => {
        const rows = await tx
          .insert(messages)
          .values({
            chatId: input.chatId,
            senderId: input.senderId,
            type: input.type ?? 'text',
            body: input.body,
            mediaId: input.media?.mediaId ?? null,
            mediaKind: input.media?.kind ?? null,
            caption: input.media?.caption ?? null,
            durationMs: input.media?.durationMs ?? null,
            width: input.media?.width ?? null,
            height: input.media?.height ?? null,
            replyToMessageId: input.replyToMessageId ?? null,
            forwardedFromChatId: input.forwardedFromChatId ?? null,
            forwardedFromMessageId: input.forwardedFromMessageId ?? null,
          })
          .returning(messageSelection);

        const row = rows[0];

        if (!row) {
          throw new PersistenceException('PostgreSQL did not return the created message');
        }

        await tx.update(chats).set({ updatedAt: new Date() }).where(eq(chats.id, input.chatId));

        return this.mapper.toRecord(row);
      });
    } catch (error) {
      if (error instanceof PersistenceException) {
        throw error;
      }

      throw new PersistenceException('Failed to create message', { cause: error });
    }
  }

  async createSecret(input: CreateSecretMessageInput): Promise<MessageRecord> {
    try {
      return await this.db.transaction(async (tx) => {
        const rows = await tx
          .insert(messages)
          .values({
            chatId: input.chatId,
            senderId: input.senderId,
            type: 'secret',
            body: null,
            ciphertext: input.ciphertext,
            nonce: input.nonce,
            ephemeralPublicKey: input.ephemeralPublicKey,
            senderDeviceId: input.senderDeviceId,
            recipientDeviceId: input.recipientDeviceId,
          })
          .returning(messageSelection);

        const row = rows[0];

        if (!row) {
          throw new PersistenceException('PostgreSQL did not return the created secret message');
        }

        await tx.update(chats).set({ updatedAt: new Date() }).where(eq(chats.id, input.chatId));

        return this.mapper.toRecord(row);
      });
    } catch (error) {
      if (error instanceof PersistenceException) {
        throw error;
      }

      throw new PersistenceException('Failed to create secret message', { cause: error });
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

      if (query.beforeId) {
        conditions.push(lt(messages.id, query.beforeId));
      }

      const rows = await this.db
        .select(messageSelection)
        .from(messages)
        .where(and(...conditions))
        .orderBy(desc(messages.id))
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
        .set({
          deletedAt,
          mediaId: null,
          mediaKind: null,
          caption: null,
          durationMs: null,
          width: null,
          height: null,
        })
        .where(and(eq(messages.chatId, chatId), eq(messages.id, id), isNull(messages.deletedAt)))
        .returning({ id: messages.id });

      return rows.length > 0;
    } catch (error) {
      throw new PersistenceException('Failed to delete message', { cause: error });
    }
  }

  async maxIdByChat(chatId: string): Promise<string | null> {
    try {
      const rows = await this.db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.chatId, chatId))
        .orderBy(desc(messages.id))
        .limit(1);

      return rows[0]?.id ?? null;
    } catch (error) {
      throw new PersistenceException('Failed to find the latest message', { cause: error });
    }
  }

  async countUnread(chatId: string, readerId: string, watermarkId: string | null): Promise<number> {
    try {
      const conditions = [
        eq(messages.chatId, chatId),
        ne(messages.senderId, readerId),
        isNull(messages.deletedAt),
      ];

      if (watermarkId !== null) {
        conditions.push(gt(messages.id, watermarkId));
      }

      const rows = await this.db
        .select({ value: sql<number>`count(*)::int` })
        .from(messages)
        .where(and(...conditions));

      return rows[0]?.value ?? 0;
    } catch (error) {
      throw new PersistenceException('Failed to count unread messages', { cause: error });
    }
  }

  async countUnreadByChats(
    readerId: string,
    chatIds: readonly string[],
  ): Promise<Map<string, number>> {
    if (chatIds.length === 0) {
      return new Map();
    }

    try {
      const rows = await this.db
        .select({ chatId: messages.chatId, value: sql<number>`count(*)::int` })
        .from(messages)
        .innerJoin(
          chatMembers,
          and(eq(chatMembers.chatId, messages.chatId), eq(chatMembers.userId, readerId)),
        )
        .where(
          and(
            inArray(messages.chatId, [...chatIds]),
            ne(messages.senderId, readerId),
            isNull(messages.deletedAt),
            or(
              isNull(chatMembers.lastReadMessageId),
              gt(messages.id, chatMembers.lastReadMessageId),
            ),
          ),
        )
        .groupBy(messages.chatId);

      return new Map(rows.map((row) => [row.chatId, row.value]));
    } catch (error) {
      throw new PersistenceException('Failed to count unread chats', { cause: error });
    }
  }

  async hasLiveMediaReferences(mediaId: string): Promise<boolean> {
    try {
      const rows = await this.db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.mediaId, mediaId), isNull(messages.deletedAt)))
        .limit(1);

      return rows.length > 0;
    } catch (error) {
      throw new PersistenceException('Failed to check media references', { cause: error });
    }
  }
}
