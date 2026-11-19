import type { Router } from 'express';
import { inject, injectable } from 'inversify';
import type { RequireBearerAuthMiddleware } from '@/core/auth/require-bearer-auth.middleware.js';
import type { RequireVerifiedEmailMiddleware } from '@/core/auth/require-verified-email.middleware.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { MediaRateLimiter } from '@/core/http/middleware/rate-limit.js';
import type { RequestScopeMiddleware } from '@/core/http/middleware/request-scope.js';
import { DocumentedRouter } from '@/core/http/openapi/documented-router.js';
import type { OpenApiRegistry } from '@/core/http/openapi/openapi.registry.js';
import { MEDIA_TYPES } from '@/modules/media/media.types.js';
import { mediaContracts } from '@/modules/media/web/dto/media.openapi.js';
import type { MediaController } from '@/modules/media/web/media.controller.js';

@injectable()
export class MediaRouter {
  readonly router: Router;

  constructor(
    @inject(MEDIA_TYPES.RequestScope) scope: RequestScopeMiddleware,
    @inject(MEDIA_TYPES.MediaRateLimiter) private readonly limiter: MediaRateLimiter,
    @inject(CORE_TYPES.OpenApiRegistry) registry: OpenApiRegistry,
    @inject(CORE_TYPES.RequireAuth) private readonly requireAuth: RequireBearerAuthMiddleware,
    @inject(CORE_TYPES.RequireVerifiedEmail)
    private readonly requireVerifiedEmail: RequireVerifiedEmailMiddleware,
  ) {
    const routes = new DocumentedRouter(registry, '/api/media');
    this.router = routes.router;
    this.router.use(scope.handle);

    const guarded = [
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
    ] as const;

    routes.post('/uploads', mediaContracts.createUpload, ...guarded, (req, res, next) =>
      req.container.get<MediaController>(MEDIA_TYPES.MediaController).createUpload(req, res, next),
    );

    routes.post('/:id/finalize', mediaContracts.finalize, ...guarded, (req, res, next) =>
      req.container.get<MediaController>(MEDIA_TYPES.MediaController).finalize(req, res, next),
    );

    routes.get('/:id', mediaContracts.download, ...guarded, (req, res, next) =>
      req.container.get<MediaController>(MEDIA_TYPES.MediaController).download(req, res, next),
    );

    routes.delete('/:id', mediaContracts.delete, ...guarded, (req, res, next) =>
      req.container.get<MediaController>(MEDIA_TYPES.MediaController).remove(req, res, next),
    );
  }
}
