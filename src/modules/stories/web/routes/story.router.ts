import type { Router } from 'express';
import { inject, injectable } from 'inversify';
import type { RequireBearerAuthMiddleware } from '@/core/auth/require-bearer-auth.middleware.js';
import type { RequireVerifiedEmailMiddleware } from '@/core/auth/require-verified-email.middleware.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { StoryRateLimiter } from '@/core/http/middleware/rate-limit.js';
import type { RequestScopeMiddleware } from '@/core/http/middleware/request-scope.js';
import { DocumentedRouter } from '@/core/http/openapi/documented-router.js';
import type { OpenApiRegistry } from '@/core/http/openapi/openapi.registry.js';
import { STORIES_TYPES } from '@/modules/stories/stories.types.js';
import { storyContracts } from '@/modules/stories/web/dto/story.openapi.js';
import type { StoryController } from '@/modules/stories/web/story.controller.js';

@injectable()
export class StoryRouter {
  readonly router: Router;

  constructor(
    @inject(STORIES_TYPES.RequestScope) scope: RequestScopeMiddleware,
    @inject(STORIES_TYPES.StoryRateLimiter) private readonly limiter: StoryRateLimiter,
    @inject(CORE_TYPES.OpenApiRegistry) registry: OpenApiRegistry,
    @inject(CORE_TYPES.RequireAuth) private readonly requireAuth: RequireBearerAuthMiddleware,
    @inject(CORE_TYPES.RequireVerifiedEmail)
    private readonly requireVerifiedEmail: RequireVerifiedEmailMiddleware,
  ) {
    const routes = new DocumentedRouter(registry, '/api/stories');
    this.router = routes.router;
    this.router.use(scope.handle);

    routes.post(
      '/',
      storyContracts.create,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) => {
        return req.container
          .get<StoryController>(STORIES_TYPES.StoryController)
          .create(req, res, next);
      },
    );

    routes.get('/', storyContracts.listMine, this.requireAuth.handle, (req, res, next) => {
      return req.container
        .get<StoryController>(STORIES_TYPES.StoryController)
        .listMine(req, res, next);
    });

    routes.get(
      '/users/:userId',
      storyContracts.listUser,
      this.requireAuth.handle,
      (req, res, next) => {
        return req.container
          .get<StoryController>(STORIES_TYPES.StoryController)
          .listUser(req, res, next);
      },
    );

    routes.delete('/:id', storyContracts.delete, this.requireAuth.handle, (req, res, next) => {
      return req.container
        .get<StoryController>(STORIES_TYPES.StoryController)
        .remove(req, res, next);
    });
  }
}
