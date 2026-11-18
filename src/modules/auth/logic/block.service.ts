import { inject, injectable } from 'inversify';
import { CannotBlockSelfException, UserNotFoundException } from '@/core/errors/domain.error.js';
import type { UserBlockReader } from '@/core/privacy/user-block.reader.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { BlockedUserRecord } from '@/modules/auth/logic/entities/block-record.js';
import type { UserRepository } from '@/modules/auth/logic/ports/user.repository.js';
import type { UserBlockRepository } from '@/modules/auth/logic/ports/user-block.repository.js';

/**
 * Owns the caller's block list.
 *
 * Blocking a missing account is a 404 and blocking yourself is a 400; both
 * writes are idempotent because the API returns 204 whether or not the edge
 * already existed. Blocking is directional: each side manages its own list.
 */
@injectable()
export class BlockService implements UserBlockReader {
  constructor(
    @inject(AUTH_TYPES.UserBlockRepository) private readonly blocks: UserBlockRepository,
    @inject(AUTH_TYPES.UserRepository) private readonly users: UserRepository,
  ) {}

  async block(blockerId: string, blockedId: string): Promise<void> {
    if (blockerId === blockedId) {
      throw new CannotBlockSelfException();
    }

    const target = await this.users.findById(blockedId);

    if (!target) {
      throw new UserNotFoundException();
    }

    await this.blocks.block(blockerId, blockedId);
  }

  async unblock(blockerId: string, blockedId: string): Promise<void> {
    await this.blocks.unblock(blockerId, blockedId);
  }

  list(blockerId: string): Promise<BlockedUserRecord[]> {
    return this.blocks.listByBlocker(blockerId);
  }

  isBlockedBetween(firstUserId: string, secondUserId: string): Promise<boolean> {
    return this.blocks.isBlockedEitherWay(firstUserId, secondUserId);
  }
}
