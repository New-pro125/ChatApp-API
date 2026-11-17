import type { Router } from 'express';
import type { Container } from 'inversify';
import type { StoryRateLimiter } from '@/core/http/middleware/rate-limit.js';
import type { AppModule } from '@/core/modules/app.module.js';
import { StoriesContainer } from '@/modules/stories/stories.container.js';
import { STORIES_TYPES } from '@/modules/stories/stories.types.js';
import type { StoryRouter } from '@/modules/stories/web/routes/story.router.js';

export class StoriesModule implements AppModule {
  readonly name = 'stories';
  readonly mountPath = '/api/stories';
  readonly router: Router;

  private readonly container: StoriesContainer;

  constructor(root: Container) {
    this.container = new StoriesContainer(root);
    this.router = this.container.get<StoryRouter>(STORIES_TYPES.StoryRouter).router;
  }

  configure(): void {
    this.container.get<StoryRateLimiter>(STORIES_TYPES.StoryRateLimiter).initialize();
  }

  dispose(): Promise<void> {
    this.container.unbindAll();

    return Promise.resolve();
  }
}
