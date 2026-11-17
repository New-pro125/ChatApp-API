/**
 * A user the caller has blocked, projected with the profile fields the block
 * list needs. `blockedAt` is when the caller created the block edge.
 */
export class BlockedUserRecord {
  constructor(
    readonly id: string,
    readonly username: string | null,
    readonly displayName: string,
    readonly avatarKey: string | null,
    readonly blockedAt: Date,
  ) {}
}
