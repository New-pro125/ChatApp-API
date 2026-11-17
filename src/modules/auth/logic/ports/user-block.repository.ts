import type { BlockedUserRecord } from '@/modules/auth/logic/entities/block-record.js';

/**
 * Stores directional block edges.
 *
 * A row means `blockerId` has blocked `blockedId`; the reverse direction is a
 * separate row so each side can block independently. Both writes are
 * idempotent because the API treats repeating them as a no-op.
 */
export interface UserBlockRepository {
  block(blockerId: string, blockedId: string): Promise<void>;
  unblock(blockerId: string, blockedId: string): Promise<void>;
  listByBlocker(blockerId: string): Promise<BlockedUserRecord[]>;
}
