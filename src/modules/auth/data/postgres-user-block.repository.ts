import { and, desc, eq, or } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { AppDatabase } from '@/core/database/database.provider.js';
import { userBlocks, users } from '@/core/database/schema/index.js';
import { PersistenceException } from '@/core/errors/repository.error.js';
import { BlockedUserMapper } from '@/modules/auth/data/block.mapper.js';
import type { BlockedUserRecord } from '@/modules/auth/logic/entities/block-record.js';
import type { UserBlockRepository } from '@/modules/auth/logic/ports/user-block.repository.js';

/**
 * Stores directional block edges in `user_blocks`.
 *
 * `block` ignores duplicates so repeating it is a no-op, and `unblock` deletes
 * by edge so repeating it is likewise harmless. The list join is keyset-free:
 * blocks are a small, per-user set that the API returns in full.
 */
@injectable()
export class PostgresUserBlockRepository implements UserBlockRepository {
  private readonly mapper = new BlockedUserMapper();

  constructor(@inject(CORE_TYPES.Db) private readonly db: AppDatabase) {}

  async block(blockerId: string, blockedId: string): Promise<void> {
    try {
      await this.db
        .insert(userBlocks)
        .values({ blockerId, blockedId })
        .onConflictDoNothing({
          target: [userBlocks.blockerId, userBlocks.blockedId],
        });
    } catch (error) {
      throw new PersistenceException('Failed to block user', { cause: error });
    }
  }

  async unblock(blockerId: string, blockedId: string): Promise<void> {
    try {
      await this.db
        .delete(userBlocks)
        .where(and(eq(userBlocks.blockerId, blockerId), eq(userBlocks.blockedId, blockedId)));
    } catch (error) {
      throw new PersistenceException('Failed to unblock user', { cause: error });
    }
  }

  async isBlockedEitherWay(firstUserId: string, secondUserId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: userBlocks.id })
      .from(userBlocks)
      .where(
        or(
          and(eq(userBlocks.blockerId, firstUserId), eq(userBlocks.blockedId, secondUserId)),
          and(eq(userBlocks.blockerId, secondUserId), eq(userBlocks.blockedId, firstUserId)),
        ),
      )
      .limit(1);

    return rows.length > 0;
  }

  async listByBlocker(blockerId: string): Promise<BlockedUserRecord[]> {
    try {
      const rows = await this.db
        .select({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          avatarKey: users.avatarKey,
          blockedAt: userBlocks.createdAt,
        })
        .from(userBlocks)
        .innerJoin(users, eq(users.id, userBlocks.blockedId))
        .where(eq(userBlocks.blockerId, blockerId))
        .orderBy(desc(userBlocks.createdAt), desc(userBlocks.id));

      return rows.map((row) => this.mapper.toRecord(row));
    } catch (error) {
      throw new PersistenceException('Failed to list blocked users', { cause: error });
    }
  }
}
