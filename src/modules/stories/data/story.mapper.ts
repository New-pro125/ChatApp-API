import type { InferSelectModel } from 'drizzle-orm';
import { stories } from '@/core/database/schema/index.js';
import { StoryRecord } from '@/modules/stories/logic/entities/story-record.js';

/**
 * Explicit column selection for the `stories` table.
 */
export const storySelection = {
  id: stories.id,
  userId: stories.userId,
  caption: stories.caption,
  mediaKey: stories.mediaKey,
  expiresAt: stories.expiresAt,
  createdAt: stories.createdAt,
} as const;

export type StoryRow = Pick<InferSelectModel<typeof stories>, keyof typeof storySelection>;

export class StoryMapper {
  toRecord(row: StoryRow): StoryRecord {
    return new StoryRecord(
      row.id,
      row.userId,
      row.caption,
      row.mediaKey,
      row.expiresAt,
      row.createdAt,
    );
  }
}
