import type { StoryRecord } from '@/modules/stories/logic/entities/story-record.js';

/**
 * Input accepted when creating a story. The service computes `expiresAt` from
 * configuration, so callers never supply it.
 */
export interface CreateStoryInput {
  caption: string | null;
  mediaKey: string | null;
}

export interface StoryRepository {
  create(userId: string, input: CreateStoryInput, expiresAt: Date): Promise<StoryRecord>;

  /** Active stories (not yet expired) for one owner, newest first. */
  listActiveByUser(userId: string): Promise<StoryRecord[]>;

  /**
   * Deletes a story only when it belongs to `userId`.
   *
   * Returns whether a row was removed so the service can distinguish "not
   * mine" from "deleted" without leaking ownership.
   */
  deleteOwned(id: string, userId: string): Promise<boolean>;
}
