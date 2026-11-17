import { and, desc, eq, gt } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { AppDatabase } from '@/core/database/database.provider.js';
import { stories } from '@/core/database/schema/index.js';
import { PersistenceException } from '@/core/errors/repository.error.js';
import { StoryMapper, storySelection } from '@/modules/stories/data/story.mapper.js';
import type { StoryRecord } from '@/modules/stories/logic/entities/story-record.js';
import type {
  CreateStoryInput,
  StoryRepository,
} from '@/modules/stories/logic/ports/story.repository.js';

/**
 * PostgreSQL persistence for stories.
 *
 * Reads filter on `expires_at > now()` so expired rows are invisible without a
 * background cleanup job; deletes are scoped to the owner so a caller can never
 * remove someone else's story.
 */
@injectable()
export class PostgresStoryRepository implements StoryRepository {
  private readonly mapper = new StoryMapper();

  constructor(@inject(CORE_TYPES.Db) private readonly db: AppDatabase) {}

  async create(userId: string, input: CreateStoryInput, expiresAt: Date): Promise<StoryRecord> {
    try {
      const rows = await this.db
        .insert(stories)
        .values({
          userId,
          caption: input.caption,
          mediaKey: input.mediaKey,
          expiresAt,
        })
        .returning(storySelection);

      const row = rows[0];

      if (!row) {
        throw new PersistenceException('PostgreSQL did not return the created story');
      }

      return this.mapper.toRecord(row);
    } catch (error) {
      if (error instanceof PersistenceException) {
        throw error;
      }

      throw new PersistenceException('Failed to create story', { cause: error });
    }
  }

  async listActiveByUser(userId: string): Promise<StoryRecord[]> {
    try {
      const rows = await this.db
        .select(storySelection)
        .from(stories)
        .where(and(eq(stories.userId, userId), gt(stories.expiresAt, new Date())))
        .orderBy(desc(stories.createdAt), desc(stories.id));

      return rows.map((row) => this.mapper.toRecord(row));
    } catch (error) {
      throw new PersistenceException('Failed to list stories', { cause: error });
    }
  }

  async deleteOwned(id: string, userId: string): Promise<boolean> {
    try {
      const rows = await this.db
        .delete(stories)
        .where(and(eq(stories.id, id), eq(stories.userId, userId)))
        .returning({ id: stories.id });

      return rows.length > 0;
    } catch (error) {
      throw new PersistenceException('Failed to delete story', { cause: error });
    }
  }
}
