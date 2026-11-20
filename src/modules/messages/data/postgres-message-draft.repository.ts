import { and, eq } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { AppDatabase } from '@/core/database/database.provider.js';
import { messageDrafts } from '@/core/database/schema/index.js';
import { PersistenceException } from '@/core/errors/repository.error.js';
import {
  draftSelection,
  MessageDraftMapper,
} from '@/modules/messages/data/message-draft.mapper.js';
import type { MessageDraftRecord } from '@/modules/messages/logic/entities/message-draft-record.js';
import type { MessageDraftRepository } from '@/modules/messages/logic/ports/message-draft.repository.js';

@injectable()
export class PostgresMessageDraftRepository implements MessageDraftRepository {
  private readonly mapper = new MessageDraftMapper();

  constructor(@inject(CORE_TYPES.Db) private readonly db: AppDatabase) {}

  async find(chatId: string, userId: string): Promise<MessageDraftRecord | null> {
    try {
      const rows = await this.db
        .select(draftSelection)
        .from(messageDrafts)
        .where(and(eq(messageDrafts.chatId, chatId), eq(messageDrafts.userId, userId)))
        .limit(1);
      const row = rows[0];

      return row === undefined ? null : this.mapper.toRecord(row);
    } catch (error) {
      throw new PersistenceException('Failed to read message draft', { cause: error });
    }
  }

  async upsert(
    chatId: string,
    userId: string,
    body: string,
    now: Date,
  ): Promise<MessageDraftRecord> {
    try {
      const rows = await this.db
        .insert(messageDrafts)
        .values({ chatId, userId, body, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: [messageDrafts.chatId, messageDrafts.userId],
          set: { body, updatedAt: now },
        })
        .returning(draftSelection);
      const row = rows[0];

      if (!row) {
        throw new PersistenceException('PostgreSQL did not return the saved draft');
      }

      return this.mapper.toRecord(row);
    } catch (error) {
      if (error instanceof PersistenceException) {
        throw error;
      }

      throw new PersistenceException('Failed to save message draft', { cause: error });
    }
  }

  async delete(chatId: string, userId: string): Promise<boolean> {
    try {
      const rows = await this.db
        .delete(messageDrafts)
        .where(and(eq(messageDrafts.chatId, chatId), eq(messageDrafts.userId, userId)))
        .returning({ chatId: messageDrafts.chatId });

      return rows.length > 0;
    } catch (error) {
      throw new PersistenceException('Failed to delete message draft', { cause: error });
    }
  }
}
