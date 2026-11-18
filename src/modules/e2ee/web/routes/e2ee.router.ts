import type { Router } from 'express';
import { inject, injectable } from 'inversify';
import type { RequireBearerAuthMiddleware } from '@/core/auth/require-bearer-auth.middleware.js';
import type { RequireVerifiedEmailMiddleware } from '@/core/auth/require-verified-email.middleware.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { E2eeRateLimiter } from '@/core/http/middleware/rate-limit.js';
import type { RequestScopeMiddleware } from '@/core/http/middleware/request-scope.js';
import { DocumentedRouter } from '@/core/http/openapi/documented-router.js';
import type { OpenApiRegistry } from '@/core/http/openapi/openapi.registry.js';
import { E2EE_TYPES } from '@/modules/e2ee/e2ee.types.js';
import { e2eeContracts } from '@/modules/e2ee/web/dto/e2ee.openapi.js';
import type { E2eeController } from '@/modules/e2ee/web/e2ee.controller.js';

/** Documented HTTP routes for the E2EE registry. */
@injectable()
export class E2eeRouter {
  readonly router: Router;

  constructor(
    @inject(E2EE_TYPES.RequestScope) scope: RequestScopeMiddleware,
    @inject(E2EE_TYPES.E2eeRateLimiter) private readonly limiter: E2eeRateLimiter,
    @inject(CORE_TYPES.OpenApiRegistry) registry: OpenApiRegistry,
    @inject(CORE_TYPES.RequireAuth) private readonly requireAuth: RequireBearerAuthMiddleware,
    @inject(CORE_TYPES.RequireVerifiedEmail)
    private readonly requireVerifiedEmail: RequireVerifiedEmailMiddleware,
  ) {
    const routes = new DocumentedRouter(registry, '/api/e2ee');
    this.router = routes.router;
    this.router.use(scope.handle);

    routes.post(
      '/devices',
      e2eeContracts.registerDevice,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container.get<E2eeController>(E2EE_TYPES.E2eeController).register(req, res, next),
    );

    routes.get(
      '/devices',
      e2eeContracts.listDevices,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      (req, res, next) =>
        req.container.get<E2eeController>(E2EE_TYPES.E2eeController).listMine(req, res, next),
    );

    routes.get(
      '/users/:userId/devices',
      e2eeContracts.listUserDevices,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container
          .get<E2eeController>(E2EE_TYPES.E2eeController)
          .listUserDevices(req, res, next),
    );

    routes.post(
      '/devices/rotate',
      e2eeContracts.rotateDevice,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container.get<E2eeController>(E2EE_TYPES.E2eeController).rotate(req, res, next),
    );

    routes.post(
      '/devices/prekeys',
      e2eeContracts.replenishPrekeys,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container.get<E2eeController>(E2EE_TYPES.E2eeController).replenish(req, res, next),
    );

    routes.get(
      '/users/:userId/devices/:deviceId/bundle',
      e2eeContracts.bundle,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container.get<E2eeController>(E2EE_TYPES.E2eeController).bundle(req, res, next),
    );
  }
}
