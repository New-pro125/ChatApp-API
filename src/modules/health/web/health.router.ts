import { Router } from 'express';
import { inject, injectable } from 'inversify';
import type { RequestScopeMiddleware } from '@/core/http/middleware/request-scope.js';
import { HEALTH_TYPES } from '@/modules/health/health.types.js';
import type { HealthController } from '@/modules/health/web/health.controller.js';

@injectable()
export class HealthRouter {
  readonly router = Router();

  constructor(@inject(HEALTH_TYPES.RequestScope) scope: RequestScopeMiddleware) {
    this.router.use(scope.handle);

    this.router.get('/', (req, res, next) => {
      return req.container
        .get<HealthController>(HEALTH_TYPES.HealthController)
        .check(req, res, next);
    });
  }
}
