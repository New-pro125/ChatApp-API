/// <reference types="zod-openapi" />
import type { Router } from 'express';
import { inject, injectable } from 'inversify';
import { z } from 'zod';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { RequestScopeMiddleware } from '@/core/http/middleware/request-scope.js';
import { DocumentedRouter } from '@/core/http/openapi/documented-router.js';
import type { OpenApiRegistry } from '@/core/http/openapi/openapi.registry.js';
import { successEnvelope } from '@/core/http/openapi/openapi.schemas.js';
import type { RouteContract } from '@/core/http/openapi/openapi.types.js';
import { HEALTH_TYPES } from '@/modules/health/health.types.js';
import type { HealthController } from '@/modules/health/web/health.controller.js';

const liveReportSchema = z
  .object({
    status: z.literal('ok'),
  })
  .meta({ id: 'HealthLiveReport' });

const healthReportSchema = z
  .object({
    status: z.enum(['ok', 'degraded']),
    checks: z.record(z.string(), z.enum(['up', 'down'])),
  })
  .meta({ id: 'HealthReport' });

const liveResponse = successEnvelope(liveReportSchema, 'HealthLiveResponse');
const healthResponse = successEnvelope(healthReportSchema, 'HealthReportResponse');

const liveContract: RouteContract = {
  operationId: 'health.live',
  tags: ['Health'],
  summary: 'Report liveness without touching dependencies',
  responses: {
    200: { description: 'The process is running', schema: liveResponse },
  },
};

const readyContract: RouteContract = {
  operationId: 'health.ready',
  tags: ['Health'],
  summary: 'Report readiness of the database and Redis',
  responses: {
    200: { description: 'All dependencies are reachable', schema: healthResponse },
    503: { description: 'One or more dependencies are unavailable', schema: healthResponse },
  },
};

const aliasContract: RouteContract = {
  operationId: 'health.check',
  tags: ['Health'],
  summary: 'Deprecated alias for readiness',
  deprecated: true,
  responses: {
    200: { description: 'All dependencies are reachable', schema: healthResponse },
    503: { description: 'One or more dependencies are unavailable', schema: healthResponse },
  },
};

@injectable()
export class HealthRouter {
  readonly router: Router;

  constructor(
    @inject(HEALTH_TYPES.RequestScope) scope: RequestScopeMiddleware,
    @inject(CORE_TYPES.OpenApiRegistry) registry: OpenApiRegistry,
  ) {
    const routes = new DocumentedRouter(registry, '/health');
    this.router = routes.router;
    this.router.use(scope.handle);

    routes.get('/live', liveContract, (req, res, next) => {
      return req.container
        .get<HealthController>(HEALTH_TYPES.HealthController)
        .live(req, res, next);
    });

    routes.get('/ready', readyContract, (req, res, next) => {
      return req.container
        .get<HealthController>(HEALTH_TYPES.HealthController)
        .ready(req, res, next);
    });

    routes.get('/', aliasContract, (req, res, next) => {
      return req.container
        .get<HealthController>(HEALTH_TYPES.HealthController)
        .ready(req, res, next);
    });
  }
}
