import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { AppDatabase } from '@/core/database/database.provider.js';
import { chatMembers, messagePins } from '@/core/database/schema/index.js';
import { PersistenceException } from '@/core/errors/repository.error.js';
import { MessagePinMapper, pinSelection } from '@/modules/messages/data/message-pin.mapper.js';
import type {
  MessagePinRepository,
  PinIndicators,
  PinRecord,
} from '@/modules/messages/logic/ports/message-pin.repository.js';

/** Ten active bookmarks per chat and user; the 11th pin is rejected. */
const PIN_LIMIT = 10;

@injectable()
export class PostgresMessagePinRepository implements MessagePinRepository {
  private readonly mapper = new MessagePinMapper();

  constructor(@inject(CORE_TYPES.Db) private readonly db: AppDatabase) {}

  async pin(
    chatId: string,
    userId: string,
    messageId: string,
    expiresAt: Date,
  ): Promise<PinRecord | null> {
    try {
      return await this.db.transaction(async (tx) => {
        // Serializes concurrent pin attempts by this user in this chat.
        await tx
          .select({ userId: chatMembers.userId })
          .from(chatMembers)
          .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)))
          .limit(1)
          .for('update');

        const existing = await tx
          .select(pinSelection)
          .from(messagePins)
          .where(
            and(
              eq(messagePins.chatId, chatId),
              eq(messagePins.userId, userId),
              eq(messagePins.messageId, messageId),
            ),
          )
          .limit(1);
        const current = existing[0];

        if (current && current.expiresAt > new Date()) {
          return this.mapper.toRecord(current);
        }

        if (current) {
          await tx
            .delete(messagePins)
            .where(
              and(
                eq(messagePins.chatId, chatId),
                eq(messagePins.userId, userId),
                eq(messagePins.messageId, messageId),
              ),
            );
        }

        const counted = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(messagePins)
          .where(
            and(
              eq(messagePins.chatId, chatId),
              eq(messagePins.userId, userId),
              gt(messagePins.expiresAt, new Date()),
            ),
          );

        if ((counted[0]?.count ?? 0) >= PIN_LIMIT) {
          return null;
        }

        const inserted = await tx
          .insert(messagePins)
          .values({ chatId, userId, messageId, expiresAt })
          .returning(pinSelection);

        const row = inserted[0];

        if (!row) {
          throw new PersistenceException('PostgreSQL did not return the created pin');
        }

        return this.mapper.toRecord(row);
      });
    } catch (error) {
      if (error instanceof PersistenceException) {
        throw error;
      }

      throw new PersistenceException('Failed to pin message', { cause: error });
    }
  }

  async unpin(chatId: string, userId: string, messageId: string): Promise<boolean> {
    try {
      const rows = await this.db
        .delete(messagePins)
        .where(
          and(
            eq(messagePins.chatId, chatId),
            eq(messagePins.userId, userId),
            eq(messagePins.messageId, messageId),
          ),
        )
        .returning({ messageId: messagePins.messageId });

      return rows.length > 0;
    } catch (error) {
      throw new PersistenceException('Failed to unpin message', { cause: error });
    }
  }

  async list(chatId: string, userId: string): Promise<PinRecord[]> {
    try {
      const rows = await this.db
        .select(pinSelection)
        .from(messagePins)
        .where(
          and(
            eq(messagePins.chatId, chatId),
            eq(messagePins.userId, userId),
            gt(messagePins.expiresAt, new Date()),
          ),
        )
        .orderBy(desc(messagePins.pinnedAt));

      return rows.map((row) => this.mapper.toRecord(row));
    } catch (error) {
      throw new PersistenceException('Failed to list pinned messages', { cause: error });
    }
  }

  async listPinnedFor(
    chatId: string,
    userId: string,
    messageIds: readonly string[],
  ): Promise<Map<string, PinIndicators>> {
    if (messageIds.length === 0) {
      return new Map();
    }

    try {
      const rows = await this.db
        .select(pinSelection)
        .from(messagePins)
        .where(
          and(
            eq(messagePins.chatId, chatId),
            eq(messagePins.userId, userId),
            gt(messagePins.expiresAt, new Date()),
            inArray(messagePins.messageId, [...messageIds]),
          ),
        );

      return new Map(
        rows.map((row) => [
          row.messageId,
          { pinnedAt: row.pinnedAt, expiresAt: row.expiresAt } satisfies PinIndicators,
        ]),
      );
    } catch (error) {
      throw new PersistenceException('Failed to look up pinned messages', { cause: error });
    }
  }

  async deleteExpired(now: Date, limit: number): Promise<number> {
    try {
      const result = await this.db.execute<{ message_id: string }>(sql`
        WITH candidates AS (
          SELECT chat_id, user_id, message_id
          FROM message_pins
          WHERE expires_at <= ${now}
          ORDER BY expires_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM message_pins p
        USING candidates c
        WHERE p.chat_id = c.chat_id
          AND p.user_id = c.user_id
          AND p.message_id = c.message_id
        RETURNING p.message_id
      `);

      return result.rowCount ?? 0;
    } catch (error) {
      throw new PersistenceException('Failed to delete expired message pins', { cause: error });
    }
  }

  async removeForMessage(chatId: string, messageId: string): Promise<void> {
    try {
      await this.db
        .delete(messagePins)
        .where(and(eq(messagePins.chatId, chatId), eq(messagePins.messageId, messageId)));
    } catch (error) {
      throw new PersistenceException('Failed to remove message pins', { cause: error });
    }
  }
}
