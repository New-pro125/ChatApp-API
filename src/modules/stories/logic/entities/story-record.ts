/**
 * A single ephemeral story owned by a user.
 *
 * A story always carries a caption, a media object key, or both; the database
 * enforces that invariant. `mediaKey` is an opaque reference for now — the
 * media pipeline (Phase 2.4) will replace client-supplied keys with
 * server-generated ones.
 */
export class StoryRecord {
  constructor(
    readonly id: string,
    readonly userId: string,
    readonly caption: string | null,
    readonly mediaKey: string | null,
    readonly expiresAt: Date,
    readonly createdAt: Date,
  ) {}
}
