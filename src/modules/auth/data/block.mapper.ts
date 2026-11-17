import { BlockedUserRecord } from '@/modules/auth/logic/entities/block-record.js';

/**
 * The joined shape returned by the block list query: the blocked user's
 * profile fields plus when the block edge was created.
 */
export interface BlockedUserRow {
  id: string;
  username: string | null;
  displayName: string;
  avatarKey: string | null;
  blockedAt: Date;
}

export class BlockedUserMapper {
  toRecord(row: BlockedUserRow): BlockedUserRecord {
    return new BlockedUserRecord(
      row.id,
      row.username,
      row.displayName,
      row.avatarKey,
      row.blockedAt,
    );
  }
}
