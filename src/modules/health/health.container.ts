import { Container } from 'inversify';
import { RequestScopeMiddleware } from '@/core/http/middleware/request-scope.js';
import { PostgresHealthCheck } from '@/modules/health/data/postgres.health-check.js';
import { RedisHealthCheck } from '@/modules/health/data/redis.health-check.js';
import { HEALTH_TYPES } from '@/modules/health/health.types.js';
import { HealthService } from '@/modules/health/logic/health.service.js';
import type { HealthCheck } from '@/modules/health/logic/health-check.js';
import { HealthController } from '@/modules/health/web/health.controller.js';
import { HealthRouter } from '@/modules/health/web/health.router.js';

export class HealthContainer extends Container {
  constructor(parent: Container) {
    super({ parent });

    this.bind<RequestScopeMiddleware>(HEALTH_TYPES.RequestScope).toConstantValue(
      new RequestScopeMiddleware(this),
    );

    this.bind<HealthCheck>(HEALTH_TYPES.HealthCheck).to(PostgresHealthCheck);
    this.bind<HealthCheck>(HEALTH_TYPES.HealthCheck).to(RedisHealthCheck);

    this.bind<HealthService>(HEALTH_TYPES.HealthService).to(HealthService).inSingletonScope();

    this.bind<HealthController>(HEALTH_TYPES.HealthController).to(HealthController);
    this.bind<HealthRouter>(HEALTH_TYPES.HealthRouter).to(HealthRouter).inSingletonScope();
  }
}
