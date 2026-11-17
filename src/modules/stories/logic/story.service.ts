import { inject, injectable } from 'inversify';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { NotFoundException } from '@/core/errors/http.error.js';
import type { UserPrivacyReader } from '@/core/privacy/user-privacy.reader.js';
import type { StoryRecord } from '@/modules/stories/logic/entities/story-record.js';
import type {
  CreateStoryInput,
  StoryRepository,
} from '@/modules/stories/logic/ports/story.repository.js';
import { STORIES_TYPES } from '@/modules/stories/stories.types.js';

/**
 * Business rules for ephemeral stories.
 *
 * Creation stamps `expiresAt` from configuration rather than trusting the
 * client, and the viewer path asks the auth-owned `UserPrivacyReader` whether
 * the owner's `storiesVisibility` allows the read. When it does not, the caller
 * receives an empty list instead of a 403 so the setting is never leaked.
 */
@injectable()
export class StoryService {
  constructor(
    @inject(STORIES_TYPES.StoryRepository) private readonly stories: StoryRepository,
    @inject(CORE_TYPES.UserPrivacyReader) private readonly privacy: UserPrivacyReader,
    @inject(CORE_TYPES.Config) private readonly config: AppConfig,
  ) {}

  create(userId: string, input: CreateStoryInput): Promise<StoryRecord> {
    const expiresAt = new Date(Date.now() + this.config.stories.ttlSeconds * 1_000);

    return this.stories.create(userId, input, expiresAt);
  }

  listMine(userId: string): Promise<StoryRecord[]> {
    return this.stories.listActiveByUser(userId);
  }

  async listForViewer(ownerId: string, viewerId: string): Promise<StoryRecord[]> {
    const allowed = await this.privacy.canViewStories(ownerId, viewerId);

    if (!allowed) {
      return [];
    }

    return this.stories.listActiveByUser(ownerId);
  }

  async remove(userId: string, storyId: string): Promise<void> {
    const deleted = await this.stories.deleteOwned(storyId, userId);

    if (!deleted) {
      throw new NotFoundException('Story not found');
    }
  }
}
