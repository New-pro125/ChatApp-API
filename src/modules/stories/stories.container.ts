import { Container } from 'inversify';
import { StoryRateLimiter } from '@/core/http/middleware/rate-limit.js';
import { RequestScopeMiddleware } from '@/core/http/middleware/request-scope.js';
import { PostgresStoryRepository } from '@/modules/stories/data/postgres-story.repository.js';
import type { StoryRepository } from '@/modules/stories/logic/ports/story.repository.js';
import { StoryService } from '@/modules/stories/logic/story.service.js';
import { STORIES_TYPES } from '@/modules/stories/stories.types.js';
import { StoryRouter } from '@/modules/stories/web/routes/story.router.js';
import { StoryController } from '@/modules/stories/web/story.controller.js';

export class StoriesContainer extends Container {
  constructor(parent: Container) {
    super({ parent });

    this.bind<RequestScopeMiddleware>(STORIES_TYPES.RequestScope).toConstantValue(
      new RequestScopeMiddleware(this),
    );
    this.bind<StoryRateLimiter>(STORIES_TYPES.StoryRateLimiter)
      .to(StoryRateLimiter)
      .inSingletonScope();

    this.bind<StoryRepository>(STORIES_TYPES.StoryRepository)
      .to(PostgresStoryRepository)
      .inSingletonScope();
    this.bind<StoryService>(STORIES_TYPES.StoryService).to(StoryService).inSingletonScope();

    this.bind<StoryController>(STORIES_TYPES.StoryController).to(StoryController);
    this.bind<StoryRouter>(STORIES_TYPES.StoryRouter).to(StoryRouter).inSingletonScope();
  }
}
